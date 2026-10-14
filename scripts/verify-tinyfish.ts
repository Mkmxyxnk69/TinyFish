import { config } from "../packages/core/config.js";
import { TinyFishClient } from "../packages/core/tinyfish.js";
import { writeFileSync, mkdirSync } from "node:fs";
if (!config.tinyfishKey) {
  console.error(
    "Live verification unavailable: set TINYFISH_API_KEY in .env. No demo result was substituted.",
  );
  process.exitCode = 1;
} else {
  const tf = new TinyFishClient(),
    report: any = { at: new Date().toISOString(), checks: [] };
  for (const [name, fn] of [
    [
      "search",
      () =>
        tf.search("TinyFish documentation", {
          include_domains: "docs.tinyfish.ai",
        }),
    ],
    ["fetch", () => tf.fetchUrls(["https://docs.tinyfish.ai/"], true)],
  ] as const) {
    try {
      const r = await fn();
      report.checks.push({ name, passed: r.results?.length > 0 });
    } catch (e) {
      report.checks.push({ name, passed: false, error: (e as Error).message });
    }
  }
  if (process.argv.includes("--agent")) {
    try {
      const r = await tf.agent(
        "https://docs.tinyfish.ai/",
        "Read the page title only. Do not submit any form or change anything.",
        {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
        },
        () => {},
      );
      report.checks.push({
        name: "agent",
        passed: !!r.result.title,
        runId: r.runId,
      });
    } catch (e) {
      report.checks.push({
        name: "agent",
        passed: false,
        error: (e as Error).message,
      });
    }
  }
  if (process.argv.includes("--browser")) {
    let session;
    try {
      session = await tf.createBrowser("https://docs.tinyfish.ai/");
      const { chromium } = await import("playwright");
      const browser = await chromium.connectOverCDP(session.cdp_url);
      const page = browser.contexts()[0].pages()[0];
      await page.goto("https://docs.tinyfish.ai/");
      report.checks.push({
        name: "browser",
        passed: !!(await page.title()),
        sessionId: session.session_id,
      });
      const { PDFDocument } = await import("pdf-lib");
      const pdf = await PDFDocument.create();
      pdf.addPage().drawText("Synthetic TinyFish upload verification document");
      const buffer = Buffer.from(await pdf.save());
      await page.setContent(
        '<main><h1>Controlled remote upload check</h1><label>Test document<input type="file" accept="application/pdf"></label></main>',
      );
      await page
        .locator('input[type="file"]')
        .setInputFiles({
          name: "verification.pdf",
          mimeType: "application/pdf",
          buffer,
        });
      const readback = await page
        .locator('input[type="file"]')
        .evaluate(async (element) => {
          const file = (element as HTMLInputElement).files?.[0];
          if (!file) return null;
          const digest = await crypto.subtle.digest(
            "SHA-256",
            await file.arrayBuffer(),
          );
          return {
            name: file.name,
            size: file.size,
            type: file.type,
            sha256: Array.from(new Uint8Array(digest))
              .map((byte) => byte.toString(16).padStart(2, "0"))
              .join(""),
          };
        });
      const { createHash } = await import("node:crypto");
      report.checks.push({
        name: "browser_buffer_upload",
        controlledDOM: true,
        passed:
          readback?.name === "verification.pdf" &&
          readback?.type === "application/pdf" &&
          readback?.size === buffer.length &&
          readback?.sha256 ===
            createHash("sha256").update(buffer).digest("hex"),
        readback,
      });
      await browser.close();
    } catch (e) {
      report.checks.push({
        name: "browser",
        passed: false,
        error: (e as Error).message,
      });
    } finally {
      if (session) await tf.deleteBrowser(session.session_id);
    }
  }
  mkdirSync("./data", { recursive: true });
  writeFileSync(
    "./data/tinyfish-verification.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  if (report.checks.some((c: any) => !c.passed)) process.exitCode = 1;
}
