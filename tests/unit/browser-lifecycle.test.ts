import { describe, it, expect, vi, afterEach } from "vitest";
import { chromium } from "playwright";
import { tinyfish } from "../../packages/core/tinyfish.js";
import { get, put, id, now, db } from "../../packages/core/db.js";
import { config } from "../../packages/core/config.js";
import { fillApplication } from "../../packages/core/browser.js";
import {
  trackRemoteSession,
  cleanupRemoteLease,
  recoverRemoteCleanup,
} from "../../packages/core/browser-lifecycle.js";
import { ProfileSchema, type AppRecord } from "../../packages/core/schemas.js";
const profile = ProfileSchema.parse({
  name: "Browser candidate",
  email: "candidate@example.test",
});
function fixture() {
  const application: AppRecord = {
    id: id(),
    userId: id(),
    listingId: id(),
    status: "filling",
    route: "web",
    provenance: "live",
    formMap: {
      form_url: "https://employer.example/apply",
      blocker: "none",
      steps: 1,
      fields: [],
    },
    createdAt: now(),
    updatedAt: now(),
  };
  put("application", application.id, application.userId, application);
  return {
    application,
    session: {
      session_id: `test-${id()}`,
      cdp_url: "wss://session.example/cdp",
      base_url: "https://session.example",
    },
  };
}
afterEach(() => vi.restoreAllMocks());
describe("remote browser ownership and resource cleanup", () => {
  it("persists the remote lease before CDP connection and deletes it after connection failure", async () => {
    const { application, session } = fixture();
    vi.spyOn(tinyfish, "createBrowser").mockResolvedValue(session);
    vi.spyOn(chromium, "connectOverCDP").mockImplementation(async () => {
      expect(
        get("browser_lease", session.session_id, application.userId).status,
      ).toBe("open");
      throw new Error("CDP connection failed");
    });
    const cleanup = vi.spyOn(tinyfish, "deleteBrowser").mockResolvedValue(null);
    await expect(fillApplication(application, profile)).rejects.toThrow(
      "CDP connection failed",
    );
    expect(cleanup).toHaveBeenCalledWith(session.session_id);
    expect(
      get("browser_lease", session.session_id, application.userId).status,
    ).toBe("closed");
    expect(
      get("application", application.id, application.userId).session,
    ).toBeUndefined();
  });
  it("closes both the CDP client and remote session if navigation fails", async () => {
    const { application, session } = fixture(),
      close = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(tinyfish, "createBrowser").mockResolvedValue(session);
    vi.spyOn(chromium, "connectOverCDP").mockResolvedValue({
      contexts: () => [
        {
          pages: () => [
            { goto: vi.fn().mockRejectedValue(new Error("Navigation failed")) },
          ],
        },
      ],
      close,
    } as any);
    const cleanup = vi.spyOn(tinyfish, "deleteBrowser").mockResolvedValue(null);
    await expect(fillApplication(application, profile)).rejects.toThrow(
      "Navigation failed",
    );
    expect(close).toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledWith(session.session_id);
  });
  it("persists bounded cleanup retries and recovers their scheduling without duplication", async () => {
    const { application, session } = fixture();
    trackRemoteSession(application, session);
    const provider = {
      deleteBrowser: vi
        .fn()
        .mockRejectedValue(new Error("Provider unavailable")),
    };
    expect(
      await cleanupRemoteLease(
        application.userId,
        session.session_id,
        0,
        provider,
      ),
    ).toBe(false);
    recoverRemoteCleanup();
    recoverRemoteCleanup();
    const jobs = () =>
      db
        .prepare(
          "SELECT payload FROM jobs WHERE user_id=? AND kind='cleanup_browser'",
        )
        .all(application.userId);
    expect(jobs()).toHaveLength(1);
    expect(JSON.parse((jobs()[0] as any).payload).__mode).toBe("live");
    await cleanupRemoteLease(
      application.userId,
      session.session_id,
      1,
      provider,
    );
    await cleanupRemoteLease(
      application.userId,
      session.session_id,
      2,
      provider,
    );
    expect(
      get("browser_lease", session.session_id, application.userId).status,
    ).toBe("cleanup_failed");
    expect(jobs()).toHaveLength(2);
    await cleanupRemoteLease(
      application.userId,
      session.session_id,
      0,
      provider,
    );
    expect(jobs()).toHaveLength(3);
  });
  it("does not call the provider for another user or for an already closed lease", async () => {
    const { application, session } = fixture();
    trackRemoteSession(application, session);
    const provider = { deleteBrowser: vi.fn().mockResolvedValue(null) };
    await expect(
      cleanupRemoteLease("different-user", session.session_id, 0, provider),
    ).rejects.toThrow("not found");
    expect(provider.deleteBrowser).not.toHaveBeenCalled();
    expect(
      await cleanupRemoteLease(
        application.userId,
        session.session_id,
        0,
        provider,
      ),
    ).toBe(true);
    expect(
      await cleanupRemoteLease(
        application.userId,
        session.session_id,
        0,
        provider,
      ),
    ).toBe(true);
    expect(provider.deleteBrowser).toHaveBeenCalledTimes(1);
  });
});
