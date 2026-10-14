import { chromium, type Browser, type Page } from "playwright";
import { createHash } from "node:crypto";
import { tinyfish } from "./tinyfish.js";
import { config } from "./config.js";
import { get, put, now, audit, event } from "./db.js";
import { readDocument, saveDocument } from "./documents.js";
import type { AppRecord, Field, FormMap, Profile } from "./schemas.js";
import { answerFields, structuredTask } from "./intelligence.js";
import { trackRemoteSession, cleanupRemoteLease } from "./browser-lifecycle.js";
const active = new Map<
  string,
  { browser: Browser; page: Page; remote: boolean }
>();
export const hash = (value: any) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function packageHash(a: AppRecord) {
  return hash({
    formMap: a.formMap,
    answers: a.answers,
    package: a.package,
    route: a.route,
    listingId: a.listingId,
  });
}
export async function closeSession(application: AppRecord) {
  const existing = active.get(application.id);
  if (existing) {
    await existing.browser.close().catch(() => {});
    active.delete(application.id);
  }
  if (
    application.session?.session_id &&
    !application.session.session_id.startsWith("local-")
  ) {
    const sessionId = application.session.session_id;
    if (!get("browser_lease", sessionId, application.userId))
      trackRemoteSession(application, application.session as any);
    const closed = await cleanupRemoteLease(application.userId, sessionId);
    if (closed) application.session = undefined;
    return closed;
  }
  return true;
}
export function demoFormUrl(a: AppRecord) {
  const token = get("demo_nonce", a.id, a.userId)?.token;
  if (!token) throw new Error("Demo session token missing");
  return `${config.workerUrl}/demo/apply/${a.listingId}?application=${a.id}&token=${token}`;
}
async function getBrowser(application: AppRecord, allowCreate = true) {
  const existing = active.get(application.id);
  if (existing && existing.browser.isConnected() && !existing.page.isClosed())
    return existing;
  if (application.provenance === "live" && application.session?.cdp_url) {
    try {
      const browser = await chromium.connectOverCDP(
        application.session.cdp_url,
        { timeout: 15000 },
      );
      const page = browser.contexts()[0]?.pages()[0];
      if (page) {
        const s = { browser, page, remote: true };
        active.set(application.id, s);
        return s;
      }
      await browser.close().catch(() => {});
    } catch {}
    // End the old remote session explicitly before replaying into a replacement.
    // A CDP observation failure alone does not prove the original session ended.
    if (!(await closeSession(application)))
      throw new Error(
        "Cannot confirm the old browser session ended. Cleanup is queued; try again after it succeeds.",
      );
  }
  if (!allowCreate) throw new Error("Browser session expired");
  let browser: Browser,
    remote = false;
  if (application.provenance === "demo") {
    browser = await chromium.launch({ headless: true });
    application.session = {
      session_id: `local-${application.id}`,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    };
  } else {
    const session = await tinyfish.createBrowser(application.formMap!.form_url);
    trackRemoteSession(application, session);
    try {
      browser = await chromium.connectOverCDP(session.cdp_url, {
        timeout: 60000,
      });
    } catch (error) {
      await cleanupRemoteLease(application.userId, session.session_id);
      throw error;
    }
    remote = true;
  }
  try {
    const context = browser.contexts()[0] || (await browser.newContext());
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(
      application.provenance === "demo"
        ? demoFormUrl(application)
        : application.formMap!.form_url,
      { waitUntil: "domcontentloaded", timeout: 60000 },
    );
    const s = { browser, page, remote };
    active.set(application.id, s);
    if (
      get<AppRecord>("application", application.id, application.userId)
        ?.status === "discarded"
    ) {
      await closeSession(application);
      throw new Error("Application was discarded");
    }
    put("application", application.id, application.userId, application);
    return s;
  } catch (error) {
    await browser.close().catch(() => {});
    active.delete(application.id);
    if (remote && application.session)
      await cleanupRemoteLease(
        application.userId,
        application.session.session_id,
      );
    throw error;
  }
}
export async function inspectDOM(page: Page) {
  return page
    .locator("input:not([type=hidden]),textarea,select")
    .evaluateAll((elements: any[]) => {
      const mapped = elements.map((el) => ({
        label:
          el.type === "radio"
            ? el
                .closest("fieldset")
                ?.querySelector("legend")
                ?.textContent?.trim() || el.name
            : el.labels?.[0]?.textContent?.trim() ||
              el.getAttribute("aria-label") ||
              el.name ||
              el.id,
        type:
          el.tagName === "SELECT"
            ? "select"
            : el.tagName === "TEXTAREA"
              ? "textarea"
              : el.type,
        required: el.required,
        options:
          el.type === "radio"
            ? elements
                .filter((x) => x.type === "radio" && x.name === el.name)
                .map((x) => x.value)
            : el.tagName === "SELECT"
              ? Array.from(el.options).map((o: any) => o.value)
              : [],
        selector: el.id ? `[id=${JSON.stringify(el.id)}]` : undefined,
      }));
      return mapped.filter(
        (item, i) =>
          mapped.findIndex(
            (x) => x.label === item.label && x.type === item.type,
          ) === i,
      );
    });
}
export async function mapDemo(a: AppRecord): Promise<FormMap> {
  const { page } = await getBrowser(a);
  const fields = await inspectDOM(page);
  return { form_url: demoFormUrl(a), blocker: "none", steps: 2, fields };
}
export async function readback(page: Page) {
  return page
    .locator("input:not([type=hidden]),textarea,select")
    .evaluateAll((elements: any[]) =>
      elements.map((el) => ({
        label:
          el.type === "radio"
            ? el
                .closest("fieldset")
                ?.querySelector("legend")
                ?.textContent?.trim() || el.name
            : el.labels?.[0]?.textContent?.trim() ||
              el.getAttribute("aria-label") ||
              el.name ||
              el.id,
        type:
          el.tagName === "SELECT"
            ? "select"
            : el.tagName === "TEXTAREA"
              ? "textarea"
              : el.type,
        required: el.required,
        value:
          el.type === "checkbox"
            ? el.checked
              ? "true"
              : "false"
            : el.type === "radio"
              ? el.checked
                ? el.value
                : ""
              : el.value,
        filesCount: el.files?.length || 0,
        fileSizes: el.files ? Array.from(el.files).map((f: any) => f.size) : [],
        fileNames: el.files ? Array.from(el.files).map((f: any) => f.name) : [],
      })),
    );
}
export function verifyReadback(a: AppRecord, profile: Profile, rows: any[]) {
  const listing = a.listingId ? get("listing", a.listingId) : undefined;
  const errors: string[] = [],
    warnings: string[] = [],
    filled: any[] = [],
    skipped: string[] = [];
  for (const f of a.formMap!.fields) {
    const answer = a.answers?.[f.label],
      matches = rows.filter((r) => r.label === f.label),
      row =
        f.type === "radio"
          ? matches.find((r) => r.value === answer?.value)
          : matches[0];
    if (!answer) {
      if (f.required) errors.push(`Required answer missing: ${f.label}`);
      else skipped.push(f.label);
      continue;
    }
    if (!row) {
      errors.push(`Field could not be read back: ${f.label}`);
      continue;
    }
    if (f.type === "file") {
      if (row.filesCount < 1) errors.push(`Resume upload missing: ${f.label}`);
      const document = get("document", answer.value, a.userId);
      if (
        document &&
        (!row.fileNames?.includes(document.name) ||
          !row.fileSizes?.includes(document.size))
      )
        errors.push(
          `Uploaded resume differs from the approved document: ${f.label}`,
        );
    } else if (row.value !== answer.value)
      errors.push(`Read-back differs from approved answer: ${f.label}`);
    if (/email/i.test(f.label) && answer.value !== profile.email)
      errors.push("Email differs from candidate profile");
    if (/^(full )?name$/i.test(f.label) && answer.value !== profile.name)
      errors.push("Name differs from candidate profile");
    if (/phone|mobile/i.test(f.label) && answer.value !== profile.phone)
      errors.push("Phone differs from candidate profile");
    if (
      /currently.*student/i.test(f.label) &&
      answer.value === "No" &&
      /current.*(?:university|college).*student/i.test(
        listing?.eligibility || "",
      )
    )
      errors.push("Student eligibility requirement is not met");
    if (answer.source.startsWith("user.") && !profile.answersBank[f.label])
      warnings.push(`User-provided answer requires review: ${f.label}`);
    if (
      !answer.source.startsWith("profile.") &&
      !answer.source.startsWith("user.") &&
      !answer.source.startsWith("package.")
    )
      errors.push(`Answer has no verified source: ${f.label}`);
    filled.push({
      label: f.label,
      value: f.type === "file" ? row.fileNames.join(", ") : row.value,
      source: answer.source,
    });
  }
  return { errors, warnings, filled, skipped };
}
export async function fillApplication(a: AppRecord, profile: Profile) {
  const { page } = await getBrowser(a);
  const accumulated = new Map<string, any>();
  const completed = new Set<string>();
  for (let step = 0; step < 8; step++) {
    const observed = await inspectDOM(page);
    const added = observed.filter(
      (f) => !a.formMap!.fields.some((x) => x.label === f.label),
    );
    if (added.length) {
      a.formMap!.fields.push(...added);
      const derived = answerFields(
        { ...profile, resumeId: a.package!.resumeId },
        added,
        a.package,
      );
      a.answers = { ...a.answers, ...derived.answers };
      if (derived.gaps.length) {
        a.gaps = derived.gaps;
        a.status = "needs_user_input";
        a.approvalHash = undefined;
        put("application", a.id, a.userId, a);
        event(
          a.userId,
          "filler",
          "New form step requires additional candidate facts",
          { fields: derived.gaps.map((f) => f.label) },
        );
        return a;
      }
    }
    for (const f of a.formMap!.fields) {
      if (completed.has(f.label)) continue;
      const answer = a.answers?.[f.label];
      if (!answer) continue;
      let locator =
        f.type === "radio"
          ? page
              .getByRole("group", { name: f.label, exact: true })
              .getByRole("radio", { name: answer.value, exact: true })
          : page.getByLabel(f.label, { exact: true });
      if ((await locator.count()) !== 1 && f.selector && f.type !== "radio")
        locator = page.locator(f.selector);
      if ((await locator.count()) !== 1 || !(await locator.isVisible()))
        continue;
      try {
        if (f.type === "file") {
          const doc = readDocument(answer.value, a.userId);
          await locator.setInputFiles({
            name: doc.name,
            mimeType: doc.mime,
            buffer: doc.buffer,
          });
        } else if (f.type === "select")
          await locator.selectOption(answer.value);
        else if (f.type === "checkbox") {
          if (answer.value === "true" || answer.value === "yes")
            await locator.check();
          else await locator.uncheck();
        } else if (f.type === "radio") {
          await locator.check();
        } else await locator.fill(answer.value);
        completed.add(f.label);
      } catch (e) {
        event(a.userId, "filler", `Could not fill ${f.label}`, {
          error: (e as Error).message,
        });
      }
    }
    for (const row of await readback(page))
      if (row.value || row.filesCount)
        accumulated.set(
          `${row.label}:${row.type === "radio" ? row.value : ""}`,
          row,
        );
    const next = page.getByRole("button", { name: /^(next|continue)$/i });
    if ((await next.count()) === 1 && (await next.isVisible())) {
      await next.click();
      await page.waitForTimeout(150);
      continue;
    }
    break;
  }
  const rows = [...accumulated.values()];
  for (const row of await readback(page)) {
    const key = `${row.label}:${row.type === "radio" ? row.value : ""}`;
    if (row.value || row.filesCount || !accumulated.has(key))
      accumulated.set(key, row);
  }
  if (get<AppRecord>("application", a.id, a.userId)?.status === "discarded") {
    await closeSession(a);
    throw new Error("Application was discarded");
  }
  a.readback = [...accumulated.values()];
  a.verification = verifyReadback(a, profile, a.readback);
  if (a.provenance === "live" && !a.verification.errors.length) {
    const semantic = await structuredTask(
      "verify_answers",
      "Independently verify the browser read-back against candidate facts and answer sources. Flag contradictions and system-invented experience as errors. Treat user-supplied essays as user claims; do not invent contradictions. Return errors and warnings only.",
      {
        profile,
        fields: a.formMap!.fields,
        answers: a.answers,
        documents: a.package,
        listing: get("listing", a.listingId),
        readback: a.readback,
      },
      {
        type: "object",
        properties: {
          errors: { type: "array", items: { type: "string" } },
          warnings: { type: "array", items: { type: "string" } },
        },
        required: ["errors", "warnings"],
      },
    );
    a.verification.errors.push(...semantic.errors);
    a.verification.warnings.push(...semantic.warnings);
  }
  const screenshot = saveDocument(
    a.userId,
    "application-review.png",
    "image/png",
    await page.screenshot({ fullPage: true }),
    "screenshot",
  );
  a.screenshotId = screenshot.id;
  a.status = a.verification.errors.length
    ? "needs_user_input"
    : "awaiting_approval";
  a.approvalHash = undefined;
  a.updatedAt = now();
  put("application", a.id, a.userId, a);
  put("application_profile", a.id, a.userId, { profileHash: hash(profile) });
  audit(a.userId, "verifier", "form_verified", a.id, {
    errors: a.verification.errors,
    warnings: a.verification.warnings,
  });
  return a;
}
export async function submitApplication(a: AppRecord, profile: Profile) {
  if (a.approvalHash !== packageHash(a))
    throw new Error("Application changed after approval. Review it again.");
  if (get("application_profile", a.id, a.userId)?.profileHash !== hash(profile))
    throw new Error(
      "Candidate profile changed. Refill and review before submitting.",
    );
  if (a.verification?.errors.length)
    throw new Error("Verification errors prevent submission");
  let session;
  try {
    session = await getBrowser(a, false);
  } catch {
    const approvedHash = a.approvalHash;
    a.status = "filling";
    await fillApplication(a, profile);
    if (a.verification?.errors.length || a.status !== "awaiting_approval")
      throw new Error("Replayed form failed verification. Review it again.");
    if (packageHash(a) !== approvedHash)
      throw new Error(
        "Application package changed during session replay. Review it again.",
      );
    a.approvalHash = approvedHash;
    session = await getBrowser(a, false);
    audit(a.userId, "browser", "approved_answers_replayed", a.id);
  }
  const fresh = verifyReadback(a, profile, await readback(session.page));
  if (fresh.errors.length) {
    a.verification = fresh;
    put("application", a.id, a.userId, {
      ...a,
      status: "needs_user_input",
      approvalHash: undefined,
    });
    throw new Error(
      "Form changed before submission: " + fresh.errors.join("; "),
    );
  }
  const expectedUrl =
    a.provenance === "demo" ? demoFormUrl(a) : a.formMap!.form_url;
  if (new URL(session.page.url()).origin !== new URL(expectedUrl).origin)
    throw new Error("Browser destination changed after review");
  a.status = "submitting";
  put("application", a.id, a.userId, a);
  audit(a.userId, "browser", "submit_click", a.id);
  const page = session.page,
    before = await page.locator("body").innerText();
  const button = page.getByRole("button", {
    name: /^(submit application|submit|apply|send application)$/i,
  });
  if ((await button.count()) !== 1)
    throw new Error("Cannot identify a unique final Submit button");
  a.actionAttempted = true;
  a.submissionStartedAt = now();
  put("application", a.id, a.userId, a);
  await button.click();
  await page.waitForFunction(
    (before) => {
      const t = document.body.innerText;
      return (
        t !== before &&
        /application received|application submitted|thank you for applying|application reference/i.test(
          t,
        )
      );
    },
    before,
    { timeout: 20000 },
  );
  const text = await page.locator("body").innerText();
  const doc = saveDocument(
    a.userId,
    "submission-confirmation.png",
    "image/png",
    await page.screenshot({ fullPage: true }),
    "confirmation",
  );
  a.confirmationId = doc.id;
  a.receipt = { text: text.slice(0, 3000), url: page.url(), at: now() };
  a.status = "submitted";
  a.submittedAt = now();
  a.updatedAt = now();
  put("application", a.id, a.userId, a);
  audit(a.userId, "browser", "submission_verified", a.id, a.receipt);
  await closeSession(a);
  return a;
}
