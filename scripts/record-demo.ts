import { spawn } from "node:child_process";
import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// Record the existing asserted journey, rather than a second scripted happy path.
const root = process.cwd();
const captureDir = path.join(root, "artifacts/demo-capture");
const output = path.join(root, "artifacts/controlled-demo.webm");
const manifest = path.join(root, "artifacts/controlled-demo.json");
await mkdir(path.dirname(output), { recursive: true });
// Never leave a stale success artifact after a failed re-recording.
await Promise.all([rm(output, { force: true }), rm(manifest, { force: true })]);

const child = spawn(
  process.execPath,
  [
    path.join(root, "node_modules/@playwright/test/cli.js"),
    "test",
    "tests/e2e/journey.spec.ts",
    "--grep",
    "complete discovery → answer",
  ],
  {
    cwd: root,
    env: { ...process.env, APP_MODE: "demo", RECORD_DEMO: "1" },
    stdio: "inherit",
  },
);
const result = await new Promise<number>((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code) => resolve(code ?? 1));
});
if (result !== 0)
  throw new Error(
    "Demo journey failed; no successful backup video was published. Ensure the local server is in demo mode.",
  );

const files = await readdir(captureDir, { recursive: true });
const videos = files.filter((file) => file.endsWith(".webm"));
if (videos.length !== 1)
  throw new Error(`Expected one journey video, found ${videos.length}.`);
await copyFile(path.join(captureDir, videos[0]), output);
await writeFile(
  manifest,
  JSON.stringify(
    {
      title: "Controlled demo — not live-provider acceptance evidence",
      recordedAt: new Date().toISOString(),
      file: path.basename(output),
      mode: "demo",
      verifiedJourney:
        "discover → match → answer → browser fill and PDF upload → verify → approve → controlled receipt → simulated reply → audit",
      assertions: "tests/e2e/journey.spec.ts: complete discovery",
      liveTinyfishVerified: false,
      realEmailSent: false,
      realPhoneCallMade: false,
    },
    null,
    2,
  ) + "\n",
);
console.log(`Controlled demo recording: ${output}`);
console.log(
  "This records local Chromium and simulated providers, not live TinyFish.",
);
