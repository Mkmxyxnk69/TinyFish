import { config } from "../packages/core/config.js";
import {
  structuredTask,
  classifyEmployerMessage,
} from "../packages/core/intelligence.js";
import { mkdirSync, writeFileSync } from "node:fs";
const report: any = {
  at: new Date().toISOString(),
  model: config.model,
  classificationModel: config.classificationModel,
  configuredKeys: config.geminiKeys.length,
  checks: [],
};
for (const [name, check] of [
  [
    "structured_generation",
    async () => {
      const result = await structuredTask(
        "connection_check",
        "Return ok=true only.",
        { request: "connection check" },
        {
          type: "object",
          properties: { ok: { type: "boolean", enum: [true] } },
          required: ["ok"],
        },
        { maxTokens: 256 },
      );
      return result.ok === true;
    },
  ],
  [
    "reply_classification",
    async () =>
      (await classifyEmployerMessage({
        subject: "Interview invitation",
        text: "We invite you to an interview for the internship on Friday at 10 AM.",
      })) === "interview",
  ],
] as const) {
  try {
    report.checks.push({ name, passed: await check() });
  } catch (error) {
    report.checks.push({
      name,
      passed: false,
      error: (error as Error).message,
    });
  }
}
mkdirSync("data", { recursive: true });
writeFileSync(
  "data/gemini-verification.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
if (report.checks.some((check: any) => !check.passed)) process.exitCode = 1;
