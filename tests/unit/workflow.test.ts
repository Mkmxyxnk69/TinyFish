import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { app } from "../../apps/worker/server.js";
import { ProfileSchema } from "../../packages/core/schemas.js";
import {
  validateEvidence,
  deterministicMatch,
  answerFields,
} from "../../packages/core/intelligence.js";
import { demoListings } from "../../apps/demo-target/target.js";
import { verifyReadback, packageHash } from "../../packages/core/browser.js";
import {
  put,
  get,
  enqueue,
  claimJob,
  finishJob,
  db,
  id,
  once,
} from "../../packages/core/db.js";
import { quietHours, notify } from "../../packages/core/integrations.js";
import {
  validateSchedule,
  nextScheduledRun,
} from "../../packages/core/schedule.js";
import { saveDocument, readDocument } from "../../packages/core/documents.js";
import { readFileSync } from "node:fs";
import { config } from "../../packages/core/config.js";
import path from "node:path";
import {
  processMonitor,
  assertPublicUrl,
  canonicalUrl,
  handleJob,
} from "../../packages/core/workflow.js";
const p = ProfileSchema.parse({
  name: "Test Candidate",
  email: "test@example.com",
  skills: ["Python", "SQL", "FastAPI"],
});
describe("evidence, eligibility, verification and durable state", () => {
  it("does not claim a queued live action while running demo mode", () => {
    for (let i = 0; i < 500; i++) {
      const queued = claimJob();
      if (!queued) break;
      finishJob(queued.id);
    }
    const previous = config.mode;
    let liveJob: string;
    try {
      config.mode = "live";
      liveJob = enqueue("mode-test", "submit", { applicationId: "unexecuted" });
    } finally {
      config.mode = previous;
    }
    expect(claimJob()).toBeNull();
    expect(
      (db.prepare("SELECT status FROM jobs WHERE id=?").get(liveJob!) as any)
        .status,
    ).toBe("pending");
  });
  it("refuses direct execution of a task from a different mode", async () => {
    await expect(
      handleJob({
        user_id: "mode-test",
        kind: "submit",
        payload: { __mode: "live", applicationId: "unexecuted" },
      }),
    ).rejects.toThrow("another execution mode");
  });
  it("never sends external email notifications in demo mode even after opt-in", async () => {
    const userId = id();
    put("profile", userId, userId, {
      ...p,
      alerts: { ...p.alerts, email: true },
    });
    const transport = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Network forbidden in unit test"));
    try {
      const result = await notify(
        userId,
        "test",
        "Simulated reply",
        "demo",
        id(),
      );
      expect(result?.channels).toContainEqual({
        channel: "email",
        status: "suppressed_demo",
      });
      expect(transport).not.toHaveBeenCalled();
    } finally {
      transport.mockRestore();
    }
  });
  it("encrypts stored documents and enforces owner access when reading", () => {
    const doc = saveDocument(
      "owner-a",
      "resume.txt",
      "text/plain",
      Buffer.from("Private candidate resume"),
    );
    const stored = readFileSync(
      path.join(config.dataDir, "files", doc.id),
      "utf8",
    );
    expect(stored).not.toContain("Private candidate resume");
    expect(readDocument(doc.id, "owner-a").buffer.toString()).toBe(
      "Private candidate resume",
    );
    expect(() => readDocument(doc.id, "owner-b")).toThrow("not found");
  });
  it("validates cron and rejects topic schedules faster than thirty minutes", () => {
    expect(() => validateSchedule("not a cron")).toThrow();
    expect(() => validateSchedule("*/5 * * * *", true)).toThrow();
    expect(
      nextScheduledRun(
        "CRON_TZ=Asia/Kolkata 0 9 * * *",
        new Date("2026-10-14T00:00:00Z"),
      ).toISOString(),
    ).toBe("2026-10-14T03:30:00.000Z");
  });
  it("processes topic baseline results and uses explicit result positions", async () => {
    const sourceId = id();
    put("source", sourceId, "topic-user", { type: "search", seenUrls: [] });
    expect(
      await processMonitor("topic-user", sourceId, {
        is_baseline: true,
        new_result_positions: [],
        results: [{ position: 1, url: "https://example.com/jobs/intern-one" }],
      }),
    ).toBe(1);
    expect(
      await processMonitor("topic-user", sourceId, {
        new_result_positions: [3],
        results: [{ position: 3, url: "https://example.com/jobs/intern-two" }],
      }),
    ).toBe(1);
  });
  it("rejects invented company evidence and nulls unsupported numeric facts", () => {
    const l = demoListings()[0];
    expect(() =>
      validateEvidence(
        { ...l, evidence: { ...l.evidence, company: "Invented employer" } },
        l.rawText,
      ),
    ).toThrow("Ungrounded company");
    const result = validateEvidence(
      { ...l, evidence: { ...l.evidence, stipendAmount: "Invented 999999" } },
      l.rawText,
    );
    expect(result.stipendAmount).toBeNull();
    expect(
      validateEvidence({ ...l, stipendAmount: 999999 }, l.rawText)
        .stipendAmount,
    ).toBeNull();
    expect(() =>
      validateEvidence({ ...l, title: "Invented role" }, l.rawText),
    ).toThrow("Ungrounded title value");
  });
  it("filters expired roles and remote-only mismatches before ranking", () => {
    const l = demoListings()[0];
    expect(
      deterministicMatch(p, { ...l, deadline: "2020-01-01" }).eligible,
    ).toBe(false);
    expect(
      deterministicMatch(
        { ...p, preferences: { ...p.preferences, remoteOnly: true } },
        { ...l, workMode: "onsite" },
      ).eligible,
    ).toBe(false);
  });
  it("leaves factual screening answers to the user", () => {
    const r = answerFields(p, [
      { label: "Email", type: "email", required: true, options: [] },
      {
        label: "Are you authorized to work?",
        type: "select",
        required: true,
        options: ["Yes", "No"],
      },
    ]);
    expect(r.answers.Email.value).toBe(p.email);
    expect(r.gaps).toHaveLength(1);
  });
  it("verifies actual browser values and attached files rather than filler claims", () => {
    const a: any = {
      formMap: {
        fields: [
          { label: "Email", type: "email", required: true },
          { label: "Resume", type: "file", required: true },
        ],
      },
      answers: {
        Email: { value: p.email, source: "profile.email" },
        Resume: { value: "doc", source: "profile.resumeId" },
      },
    };
    const result = verifyReadback(a, p, [
      { label: "Email", value: "wrong@example.com" },
      { label: "Resume", filesCount: 0, fileNames: [] },
    ]);
    expect(result.errors).toContain(
      "Read-back differs from approved answer: Email",
    );
    expect(result.errors).toContain("Resume upload missing: Resume");
  });
  it("invalidates approval when the package changes", () => {
    const a: any = {
      listingId: "x",
      route: "web",
      answers: { Email: { value: p.email } },
      package: { resumeId: "one", coverLetter: "truth" },
    };
    expect(packageHash(a)).not.toBe(
      packageHash({ ...a, package: { ...a.package, resumeId: "two" } }),
    );
  });
  it("atomically claims jobs once and deduplicates repeated events", () => {
    const jobId = enqueue("test-user", "test", {});
    let job;
    for (let i = 0; i < 100; i++) {
      const next = claimJob();
      if (!next) break;
      finishJob(next.id);
      if (next.id === jobId) {
        job = next;
        break;
      }
    }
    expect(job.id).toBe(jobId);
    expect(db.prepare("SELECT status FROM jobs WHERE id=?").get(jobId)).toEqual(
      { status: "completed" },
    );
    const key = id();
    expect(once(key)).toBe(true);
    expect(once(key)).toBe(false);
  });
  it("diffs monitor URLs to avoid extracting the same posting twice", async () => {
    const sourceId = id();
    put("source", sourceId, "monitor-user", { type: "fetch", seenUrls: [] });
    const run = {
      results: [{ links: ["https://example.com/jobs/intern-one"] }],
      errors: [],
    };
    expect(await processMonitor("monitor-user", sourceId, run)).toBe(1);
    expect(await processMonitor("monitor-user", sourceId, run)).toBe(0);
  });
  it("honors quiet hours crossing midnight in the user timezone", () => {
    expect(quietHours(p, new Date("2026-10-14T18:00:00Z"))).toBe(true);
    expect(quietHours(p, new Date("2026-10-14T08:00:00Z"))).toBe(false);
  });
  it("rejects private web URLs and removes tracking parameters", () => {
    for (const url of [
      "http://localhost/x",
      "http://127.0.0.1/x",
      "http://10.0.0.1/x",
      "http://172.20.0.1/x",
    ])
      expect(() => assertPublicUrl(url)).toThrow();
    expect(
      canonicalUrl("https://example.com/job?utm_source=x&id=1#fragment"),
    ).toBe("https://example.com/job?id=1");
  });
});
describe("API ownership and approval boundaries", () => {
  it("requires authentication for data and rejects cross-origin writes", async () => {
    expect((await request(app).get("/api/dashboard")).status).toBe(401);
    expect(
      (
        await request(app)
          .post("/api/auth/demo")
          .set("Origin", "https://evil.example")
      ).status,
    ).toBe(403);
  });
  it("isolates applications and documents between user sessions", async () => {
    const first = request.agent(app),
      second = request.agent(app);
    const u = (await first.post("/api/auth/demo")).body.user;
    await second.post("/api/auth/demo");
    const applicationId = id();
    put("application", applicationId, u.id, {
      id: applicationId,
      userId: u.id,
      listingId: "demo-backend",
      status: "awaiting_approval",
      provenance: "demo",
      route: "web",
      updatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });
    expect(
      (await second.get(`/api/applications/${applicationId}`)).status,
    ).toBe(404);
    expect(
      (
        await second
          .post(`/api/applications/${applicationId}/approve`)
          .send({ packageHash: "x" })
      ).status,
    ).toBe(404);
  });
  it("blocks premature approval and untrusted webhook payloads", async () => {
    const client = request.agent(app);
    const u = (await client.post("/api/auth/demo")).body.user;
    const applicationId = id();
    put("application", applicationId, u.id, {
      id: applicationId,
      userId: u.id,
      status: "mapping",
      provenance: "demo",
      route: "web",
    });
    expect(
      (
        await client
          .post(`/api/applications/${applicationId}/approve`)
          .send({ packageHash: "x" })
      ).status,
    ).toBe(409);
    expect(
      (await request(app).post("/api/webhooks/run").send({ run_id: "fake" }))
        .status,
    ).toBe(403);
  });
});
