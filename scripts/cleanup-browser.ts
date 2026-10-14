import { config } from "../packages/core/config.js";
import { get } from "../packages/core/db.js";
import { cleanupRemoteLease } from "../packages/core/browser-lifecycle.js";

const sessionId = process.argv[2];
if (!sessionId) {
  console.error("Usage: npm run cleanup:browser -- <session-id>");
  process.exitCode = 1;
} else if (config.mode !== "live" || !config.tinyfishKey) {
  console.error(
    "Browser cleanup requires APP_MODE=live and TINYFISH_API_KEY. No provider request was made.",
  );
  process.exitCode = 1;
} else {
  const lease = get("browser_lease", sessionId);
  if (!lease) {
    console.error(
      "Unknown local browser lease. Refusing to delete an untracked provider session.",
    );
    process.exitCode = 1;
  } else {
    const closed = await cleanupRemoteLease(lease.userId, sessionId);
    console.log(
      JSON.stringify({
        sessionId,
        status: get("browser_lease", sessionId).status,
        closed,
      }),
    );
    if (!closed) process.exitCode = 1;
  }
}
