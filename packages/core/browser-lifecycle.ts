import { tinyfish, type TinyFishClient } from "./tinyfish.js";
import {
  get,
  put,
  now,
  enqueue,
  once,
  transaction,
  event,
  list,
  id,
} from "./db.js";
import type { AppRecord } from "./schemas.js";

type Session = { session_id: string; cdp_url: string; base_url: string };
type Lease = {
  id: string;
  userId: string;
  applicationId: string;
  status: "open" | "closed" | "cleanup_pending" | "cleanup_failed";
  cleanupAttempts: number;
  cleanupCycle?: string;
  error?: string;
  createdAt: string;
  closedAt?: string;
};
type CleanupProvider = Pick<TinyFishClient, "deleteBrowser">;

export function trackRemoteSession(application: AppRecord, session: Session) {
  if (!session?.session_id)
    throw new Error("TinyFish Browser returned no session ID");
  const previous = get<Lease>("browser_lease", session.session_id);
  if (previous && previous.userId !== application.userId)
    throw new Error("Browser session ownership mismatch");
  const lease = put("browser_lease", session.session_id, application.userId, {
    userId: application.userId,
    applicationId: application.id,
    status: "open",
    cleanupAttempts: 0,
    cleanupCycle: id(),
    createdAt: now(),
  });
  application.session = {
    ...session,
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  };
  // Persist the lease before CDP connection or navigation can fail.
  put("application", application.id, application.userId, application);
  return lease;
}

function enqueueCleanup(lease: Lease, attempt: number) {
  transaction(() => {
    if (
      once(
        `browser_cleanup:${lease.id}:${lease.cleanupCycle || lease.createdAt}:${attempt}`,
      )
    )
      enqueue(
        lease.userId,
        "cleanup_browser",
        { sessionId: lease.id, attempt },
        15000 * 2 ** Math.max(0, attempt - 1),
        "live",
      );
  });
}

export async function cleanupRemoteLease(
  userId: string,
  sessionId: string,
  attempt = 0,
  provider: CleanupProvider = tinyfish,
) {
  let lease = get<Lease>("browser_lease", sessionId, userId);
  if (!lease) throw new Error("Browser lease not found for this user");
  if (lease.status === "closed") return true;
  if (attempt === 0 && lease.status === "cleanup_failed") {
    lease = { ...lease, cleanupCycle: id(), cleanupAttempts: 0 };
    put("browser_lease", sessionId, userId, lease);
  }
  try {
    await provider.deleteBrowser(sessionId);
    put("browser_lease", sessionId, userId, {
      ...lease,
      status: "closed",
      cleanupAttempts: attempt + 1,
      closedAt: now(),
      error: undefined,
    });
    const application = get<AppRecord>(
      "application",
      lease.applicationId,
      userId,
    );
    if (application?.session?.session_id === sessionId) {
      application.session = undefined;
      put("application", application.id, userId, application);
    }
    return true;
  } catch (error) {
    const attempts = attempt + 1;
    put("browser_lease", sessionId, userId, {
      ...lease,
      status: attempts < 3 ? "cleanup_pending" : "cleanup_failed",
      cleanupAttempts: attempts,
      error: (error as Error).message,
    });
    if (attempts < 3) {
      enqueueCleanup({ ...lease, id: sessionId }, attempts);
      event(userId, "browser", "Remote browser cleanup retry queued", {
        sessionId,
        attempt: attempts,
      });
    } else
      event(
        userId,
        "browser",
        "Remote browser cleanup exhausted retries; manual retry is required",
        { sessionId, error: (error as Error).message },
      );
    return false;
  }
}

export function recoverRemoteCleanup() {
  for (const lease of list<Lease>("browser_lease")) {
    if (lease.status === "cleanup_pending" && lease.cleanupAttempts < 3)
      enqueueCleanup(lease, lease.cleanupAttempts);
    else if (lease.status === "open") {
      const application = get<AppRecord>(
        "application",
        lease.applicationId,
        lease.userId,
      );
      if (
        !application ||
        [
          "submitted",
          "email_sent",
          "outreach_sent",
          "discarded",
          "failed",
          "expired",
        ].includes(application.status) ||
        application.session?.session_id !== lease.id
      )
        enqueueCleanup(lease, 0);
    }
  }
}
