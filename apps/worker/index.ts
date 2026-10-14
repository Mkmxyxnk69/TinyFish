import { app } from "./server.js";
import { config } from "../../packages/core/config.js";
import { recoverJobs, event } from "../../packages/core/db.js";
import { runOneJob, schedulerTick } from "../../packages/core/workflow.js";
import { recoverRemoteCleanup } from "../../packages/core/browser-lifecycle.js";
recoverJobs();
recoverRemoteCleanup();
const server = app.listen(config.port, "127.0.0.1", () =>
  console.log(
    `Internship Autopilot worker: http://127.0.0.1:${config.port} (${config.mode} mode)`,
  ),
);
let stopping = false;
let scheduling = false;
const timer = setInterval(async () => {
  if (scheduling) return;
  scheduling = true;
  try {
    await schedulerTick();
  } catch (e) {
    console.error("Scheduler:", (e as Error).message);
  } finally {
    scheduling = false;
  }
}, 60000);
async function loop() {
  while (!stopping) {
    try {
      const work = await runOneJob();
      if (!work) await new Promise((r) => setTimeout(r, 400));
    } catch (e) {
      console.error("Worker:", (e as Error).message);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
void loop();
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    stopping = true;
    clearInterval(timer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
