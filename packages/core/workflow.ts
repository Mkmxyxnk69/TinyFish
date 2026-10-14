import { randomBytes } from "node:crypto";
import { z } from "zod";
import { config } from "./config.js";
import {
  get,
  list,
  put,
  id,
  now,
  enqueue,
  event,
  audit,
  finishJob,
  claimJob,
  once,
  db,
} from "./db.js";
import { tinyfish, failureSignal } from "./tinyfish.js";
import {
  extractListing,
  matchListing,
  answerFields,
  coverLetter,
  structuredTask,
} from "./intelligence.js";
import { resumePdf, coverLetterPdf } from "./documents.js";
import {
  mapDemo,
  fillApplication,
  submitApplication,
  closeSession,
  packageHash,
  hash,
} from "./browser.js";
import {
  demoListings,
  createDemoNonce,
} from "../../apps/demo-target/target.js";
import {
  notify,
  ingestEmail,
  sendApplicationEmail,
  pollGmail,
} from "./integrations.js";
import {
  ProfileSchema,
  FormMapOutput,
  type Listing,
  type Profile,
  type AppRecord,
  type FormMap,
} from "./schemas.js";
import { loadTokens } from "./auth.js";
import { nextScheduledRun } from "./schedule.js";
import { cleanupRemoteLease } from "./browser-lifecycle.js";
export function saveApp(a: AppRecord) {
  const current = get<AppRecord>("application", a.id, a.userId);
  if (current?.status === "discarded" && a.status !== "discarded")
    return current;
  a.updatedAt = now();
  return put("application", a.id, a.userId, a);
}
export function ownedApplication(applicationId: string, userId: string) {
  const a = get<AppRecord>("application", applicationId, userId);
  if (!a || a.provenance !== config.mode)
    throw new Error("Application not found in this mode");
  return a;
}
export function applicationView(a: AppRecord) {
  const { session, ...safe } = a;
  return {
    ...safe,
    session: session
      ? { session_id: session.session_id, expiresAt: session.expiresAt }
      : undefined,
    packageHash: packageHash(a),
    listing: get("listing", a.listingId),
  };
}
export function canonicalUrl(url: string) {
  const u = new URL(url);
  u.hash = "";
  for (const key of [...u.searchParams.keys()])
    if (/^utm_|^(ref|source|trackingId)$/i.test(key))
      u.searchParams.delete(key);
  return u.toString().replace(/\/$/, "");
}
export function assertPublicUrl(url: string) {
  const u = new URL(url);
  if (
    !["http:", "https:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|\[|::)/i.test(
      u.hostname,
    ) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(u.hostname)
  )
    throw new Error("A public HTTP(S) URL is required");
  return u.toString();
}
export function canPrepare(url: string, userId: string) {
  if (config.mode === "demo")
    return url.startsWith(config.workerUrl + "/demo/");
  const host = new URL(assertPublicUrl(url)).hostname;
  if (
    config.publicDemoUrl &&
    new URL(url).origin === new URL(config.publicDemoUrl).origin &&
    new URL(url).pathname.startsWith("/demo/")
  )
    return true;
  if (/(^|\.)linkedin\.com$/.test(host)) return false;
  const policies = list<any>("source", userId).filter(
    (s) => s.type === "fetch" && new URL(s.target).hostname === host,
  );
  if (
    policies.some((s) => s.policy === "blocked" || s.policy === "monitor_only")
  )
    return false;
  return (
    policies.some((s) => s.policy === "prepare_forms") ||
    /^(boards\.greenhouse\.io|job-boards\.greenhouse\.io|jobs\.lever\.co|jobs\.ashbyhq\.com)$/.test(
      host,
    )
  );
}
export function startApplication(
  userId: string,
  listingId: string,
  route: "web" | "email" | "outreach" = "web",
  recipient?: string,
) {
  const listing = get<Listing>("listing", listingId);
  if (!listing || listing.provenance !== config.mode)
    throw new Error("Listing not available in this mode");
  if (listing.deadline && Date.parse(listing.deadline) < Date.now())
    throw new Error("This listing has expired");
  const previous = list<AppRecord>("application", userId).find(
    (a) =>
      a.listingId === listingId &&
      a.route === route &&
      a.status !== "discarded",
  );
  if (previous) return previous;
  if (route === "web" && !canPrepare(listing.applyUrl, userId))
    throw new Error(
      "This source is discovery-only. Enable prepare_forms for this source or apply manually.",
    );
  const a: AppRecord = {
    id: id(),
    userId,
    listingId,
    status: "mapping",
    provenance: listing.provenance,
    controlledTarget:
      !!config.publicDemoUrl &&
      new URL(listing.url).origin === new URL(config.publicDemoUrl).origin &&
      new URL(listing.url).pathname.startsWith("/demo/"),
    route,
    createdAt: now(),
    updatedAt: now(),
  };
  if (route !== "web")
    a.package = {
      resumeId: "",
      coverLetter: "",
      recipient,
      emailSubject: `${listing.title} — application`,
    };
  saveApp(a);
  if (a.provenance === "demo" || a.controlledTarget)
    createDemoNonce(a.id, userId);
  enqueue(userId, "map", { applicationId: a.id });
  return a;
}
export function requestApproval(
  userId: string,
  applicationId: string,
  expectedHash: string,
) {
  const a = ownedApplication(applicationId, userId);
  if (a.status !== "awaiting_approval")
    throw new Error("Application is not ready for approval");
  if (a.verification?.errors.length)
    throw new Error("Resolve verification errors first");
  if (expectedHash !== packageHash(a))
    throw new Error("Review is out of date. Reload the application.");
  a.approvalHash = expectedHash;
  a.actionAttempted = false;
  a.submissionStartedAt = undefined;
  a.status = "submitting";
  saveApp(a);
  audit(userId, "user", "application_approved", a.id, {
    packageHash: expectedHash,
  });
  enqueue(userId, a.route === "web" ? "submit" : "send_email", {
    applicationId: a.id,
  });
  return a;
}
export async function discovery(userId: string, payload: any) {
  const profile = get<Profile>("profile", userId, userId)!;
  event(
    userId,
    "supervisor",
    "Planning discovery: search → extract → verify → match.",
  );
  if (config.mode === "demo") {
    const fixtures = demoListings();
    for (const l of fixtures) {
      put("listing", l.id, "", l);
      enqueue(userId, "match", { listingId: l.id });
    }
    event(
      userId,
      "discovery",
      `Loaded ${fixtures.length} controlled demo listings. No TinyFish call was made.`,
      { provenance: "demo" },
    );
    return;
  }
  if (!config.tinyfishKey || !config.geminiKeys.length)
    throw new Error(
      "Configure TINYFISH_API_KEY and GEMINI_API_KEYS to run live discovery.",
    );
  const requested = (payload.query || profile.preferences.keywords).trim();
  const plan = await structuredTask(
    "plan_search",
    "Create at most three internship search queries from this user goal. Keep mandatory constraints, and include one exact original query. Return only search tasks; never external actions.",
    { goal: requested, preferences: profile.preferences },
    {
      type: "object",
      properties: {
        queries: { type: "array", maxItems: 3, items: { type: "string" } },
      },
      required: ["queries"],
    },
  );
  const queries = [requested, ...plan.queries]
    .filter((x: any) => typeof x === "string" && x.trim())
    .slice(0, 3);
  put("plan", id(), userId, {
    goal: requested,
    queries,
    createdAt: now(),
    steps: ["search", "extract", "match"],
  });
  const settled = await Promise.allSettled(
    [...new Set<string>(queries)].map((query) => tinyfish.search(query)),
  );
  const urls = new Set<string>();
  for (const r of settled) {
    if (r.status === "fulfilled")
      for (const result of r.value.results.slice(0, 10)) {
        try {
          urls.add(canonicalUrl(assertPublicUrl(result.url)));
        } catch {}
      }
    else
      event(userId, "discovery", "Search branch failed", {
        error: r.reason.message,
      });
  }
  if (!urls.size)
    throw new Error(
      "No posting URLs found. Try another query or inspect integration errors.",
    );
  for (const url of [...urls].slice(0, 20)) enqueue(userId, "extract", { url });
  event(
    userId,
    "discovery",
    `Found ${urls.size} candidate URLs; extraction jobs queued.`,
    { queries },
  );
}
async function extract(userId: string, url: string) {
  assertPublicUrl(url);
  event(userId, "extractor", "Fetching listing evidence", { url });
  const response = await tinyfish.fetchUrls([url]);
  let result = response.results[0];
  if (!result)
    throw new Error(`Fetch failed: ${JSON.stringify(response.errors)}`);
  if ((result.text?.length || 0) < 500 && result.iframe_links?.[0]) {
    const inner = await tinyfish.fetchUrls([
      assertPublicUrl(result.iframe_links[0]),
    ]);
    if (inner.results[0]) result = inner.results[0];
  }
  let listing: Listing;
  if ((result.text?.length || 0) < 200) {
    const goal =
      "Read this internship posting, without applying. Return the full visible posting text and a blocker value (none, login_required, captcha, blocked, or closed).";
    const run = await tinyfish.agent(
      url,
      goal,
      {
        type: "object",
        properties: { text: { type: "string" }, blocker: { type: "string" } },
        required: ["text", "blocker"],
      },
      (evt) =>
        event(userId, "web-agent", evt.purpose || evt.type, {
          runId: evt.run_id,
        }),
    );
    if (failureSignal(run.result))
      throw new Error("Listing requires user intervention");
    listing = await extractListing(url, run.result.text);
  } else listing = await extractListing(url, result.text);
  assertPublicUrl(listing.applyUrl);
  const key = hash({
    company: listing.company.toLowerCase(),
    title: listing.title.toLowerCase(),
    location: listing.location,
    applyUrl: canonicalUrl(listing.applyUrl),
  }).slice(0, 32);
  put("listing", key, "", {
    ...listing,
    fetchedAt: now(),
    contentHash: hash(listing.rawText),
  });
  enqueue(userId, "match", { listingId: key });
  event(userId, "extractor", `Verified listing: ${listing.title}`, {
    listingId: key,
  });
}
async function mapApplication(userId: string, applicationId: string) {
  const a = ownedApplication(applicationId, userId),
    listing = get<Listing>("listing", a.listingId)!,
    profile = get<Profile>("profile", userId, userId)!;
  a.status = "mapping";
  saveApp(a);
  event(
    userId,
    "supervisor",
    "Preparing application: map → answer → fill → verify → human review.",
    { applicationId },
  );
  const doc = await resumePdf(userId, profile, listing);
  a.package = {
    ...a.package,
    resumeId: doc.id,
    coverLetter: coverLetter(profile, listing),
  };
  if (a.route === "outreach")
    a.package.coverLetter = a.package.coverLetter.replace(
      `I am applying for the ${listing.title} opportunity.`,
      `I am reaching out to ask about internship opportunities related to ${listing.title}.`,
    );
  a.package.coverLetterId = (
    await coverLetterPdf(userId, a.package.coverLetter)
  ).id;
  if (a.route !== "web") {
    a.status = "awaiting_approval";
    a.verification = {
      errors: a.package.recipient ? [] : ["Email recipient missing"],
      warnings: ["Review the recipient and complete message before sending."],
      filled: [],
      skipped: [],
    };
    put("application_profile", a.id, userId, { profileHash: hash(profile) });
    saveApp(a);
    return;
  }
  if (a.provenance === "demo") {
    a.formMap = await mapDemo(a);
    event(
      userId,
      "mapper",
      "Mapped the controlled demo form using local Chromium.",
      { provenance: "demo", applicationId },
    );
  } else {
    const fresh = await tinyfish.fetchUrls([listing.url], true);
    if (!fresh.results.length)
      throw new Error("Cannot revalidate listing before preparing");
    if (
      /(?:this (?:job|position) is no longer available|no longer accepting applications|applications are closed)/i.test(
        fresh.results[0].text || "",
      )
    ) {
      a.status = "expired";
      saveApp(a);
      return;
    }
    const mapped = await tinyfish.agent(
      listing.applyUrl,
      "Inspect this internship application form READ ONLY. Never type, upload, submit, withdraw, or send messages. Return form_url, blocker, steps, and fields (visible label, type, required, options, section). Only advance through steps if navigation does not save or submit data. If a step requires answers, report the fields you can inspect; do not invent later fields. Stop at CAPTCHA or login walls.",
      FormMapOutput,
      (evt) => {
        if (evt.run_id) a.tfRunId = evt.run_id;
        if (evt.streaming_url) a.streamingUrl = evt.streaming_url;
        saveApp(a);
        event(userId, "mapper", evt.purpose || evt.type, {
          applicationId,
          runId: evt.run_id,
        });
      },
    );
    const r = mapped.result;
    const parsed = z
      .object({
        form_url: z.string().url(),
        blocker: z.enum([
          "none",
          "captcha",
          "login_required",
          "blocked",
          "closed",
        ]),
        steps: z.number().int().min(1),
        fields: z.array(
          z.object({
            label: z.string().min(1),
            type: z.string(),
            required: z.boolean(),
            options: z.array(z.string()),
            section: z.string().nullable().optional(),
          }),
        ),
      })
      .parse(r);
    a.formMap = parsed;
    if (a.controlledTarget) {
      const target = new URL(parsed.form_url);
      target.searchParams.set("application", a.id);
      target.searchParams.set("token", get("demo_nonce", a.id, userId).token);
      a.formMap.form_url = target.toString();
    }
    a.tfRunId = mapped.runId;
    if (parsed.blocker !== "none" || failureSignal(r)) {
      a.status = "blocked";
      a.error = `Form access needs user intervention: ${parsed.blocker}`;
      saveApp(a);
      return;
    }
    if (!canPrepare(parsed.form_url, userId)) {
      a.status = "blocked";
      a.error = "Mapped form destination is not permitted by source policy";
      saveApp(a);
      return;
    }
  }
  const derived = answerFields(
    { ...profile, resumeId: doc.id },
    a.formMap!.fields,
    a.package,
  );
  a.answers = derived.answers;
  a.gaps = derived.gaps;
  if (derived.gaps.length) {
    a.status = "needs_user_input";
    saveApp(a);
    await notify(
      userId,
      "input_needed",
      `${derived.gaps.length} application questions need your answers.`,
      a.id,
      `gaps:${a.id}`,
    );
  } else {
    a.status = "filling";
    saveApp(a);
    enqueue(userId, "fill", { applicationId });
  }
}
export async function answerApplication(
  userId: string,
  applicationId: string,
  answers: Record<string, string>,
  letter?: string,
  recipient?: string,
) {
  const a = ownedApplication(applicationId, userId);
  if (!["needs_user_input", "awaiting_approval", "failed"].includes(a.status))
    throw new Error("This application cannot be edited in its current state");
  const profile = get<Profile>("profile", userId, userId)!;
  for (const [label, value] of Object.entries(answers)) {
    const f = a.formMap?.fields.find((f) => f.label === label);
    if (!f || f.type === "file")
      throw new Error(`Invalid editable field: ${label}`);
    if (f.options.length && !f.options.includes(value))
      throw new Error(`Invalid option for ${label}`);
    if (!value.trim() && f.required)
      throw new Error(`Required answer: ${label}`);
    a.answers = {
      ...a.answers,
      [label]: { value, source: `user.answersBank.${label}`, confidence: 1 },
    };
    profile.answersBank[label] = value;
  }
  if (letter !== undefined && letter !== a.package!.coverLetter) {
    a.package!.coverLetter = letter;
    a.package!.coverLetterId = (await coverLetterPdf(userId, letter)).id;
    for (const field of a.formMap?.fields || [])
      if (/cover.*letter/i.test(field.label))
        a.answers = {
          ...a.answers,
          [field.label]: {
            value: field.type === "file" ? a.package!.coverLetterId! : letter,
            source:
              field.type === "file"
                ? "package.coverLetterId"
                : "package.coverLetter",
            confidence: 1,
          },
        };
  }
  if (recipient !== undefined) a.package!.recipient = recipient;
  put("profile", userId, userId, ProfileSchema.parse(profile));
  a.approvalHash = undefined;
  a.error = undefined;
  if (a.route === "web") {
    a.gaps = a.formMap!.fields.filter(
      (f) => f.required && !a.answers?.[f.label]?.value,
    );
    a.status = a.gaps.length ? "needs_user_input" : "filling";
    saveApp(a);
    if (!a.gaps.length) enqueue(userId, "fill", { applicationId });
  } else {
    a.verification = {
      errors: a.package?.recipient ? [] : ["Email recipient missing"],
      warnings: ["Review the recipient and message."],
      filled: [],
      skipped: [],
    };
    a.status = "awaiting_approval";
    put("application_profile", a.id, userId, { profileHash: hash(profile) });
    saveApp(a);
  }
  audit(userId, "user", "application_answers_updated", a.id);
  return a;
}
export async function processMonitor(
  userId: string,
  sourceId: string,
  run: any,
) {
  const source = get("source", sourceId, userId);
  if (!source) throw new Error("Unknown source");
  const prior = new Set<string>(source.seenUrls || []),
    urls: string[] = [];
  if (source.type === "search") {
    const results = run.results || [];
    const positions =
      !run.is_baseline && Array.isArray(run.new_result_positions)
        ? new Set<number>(run.new_result_positions)
        : null;
    for (const result of results)
      if (result.url && (!positions || positions.has(result.position)))
        urls.push(result.url);
  } else {
    for (const result of run.results || [])
      for (const link of result.links || [])
        urls.push(typeof link === "string" ? link : link.url || link.href);
  }
  const fresh: string[] = [];
  for (const url of urls) {
    try {
      const clean = canonicalUrl(assertPublicUrl(url));
      if (
        !prior.has(clean) &&
        /intern|jobs?\/|careers?|positions?|posting/i.test(clean)
      ) {
        fresh.push(clean);
        prior.add(clean);
      }
    } catch {}
  }
  put("source", sourceId, userId, {
    ...source,
    seenUrls: [...prior].slice(-5000),
    lastRunAt: now(),
    health: run.errors?.length ? "partial" : "healthy",
    backlogUrls: [...(source.backlogUrls || []), ...fresh].slice(20),
  });
  for (const url of [...(source.backlogUrls || []), ...fresh].slice(0, 20))
    enqueue(userId, "extract", { url });
  return fresh.length;
}
async function checkPortal(userId: string, applicationId: string) {
  const a = ownedApplication(applicationId, userId);
  const connection = get("portal", a.id, userId);
  if (!connection?.url)
    throw new Error("Configure an application-status URL in the review screen");
  assertPublicUrl(connection.url);
  const result = await tinyfish.agent(
    connection.url,
    `Read the status for application reference ${a.receipt?.reference || a.receipt?.text || a.id}. Do not change anything. Return status, exact evidence text, and blocker. If this application cannot be identified, status must be unknown.`,
    {
      type: "object",
      properties: {
        status: { type: "string" },
        evidence: { type: "string" },
        blocker: { type: "string" },
      },
      required: ["status", "evidence", "blocker"],
    },
    (e) => event(userId, "tracker", e.purpose || e.type, { applicationId }),
    connection.profileId,
  );
  if (
    failureSignal(result.result) ||
    result.result.status === "unknown" ||
    !result.result.evidence?.trim()
  ) {
    a.lastCheckedAt = now();
    a.error = "Portal check could not verify the application status";
    saveApp(a);
    return;
  }
  const changed = a.employerStatus !== result.result.status;
  a.employerStatus = result.result.status;
  a.employerStatusAt = now();
  a.lastCheckedAt = now();
  a.error = undefined;
  saveApp(a);
  audit(userId, "tracker", "portal_status_observed", a.id, {
    ...result.result,
    runId: result.runId,
  });
  if (changed)
    await notify(
      userId,
      "portal_update",
      `Employer status updated: ${a.employerStatus}`,
      a.id,
      `portal:${a.id}:${a.employerStatus}`,
    );
}
export async function handleJob(job: any) {
  const u = job.user_id,
    p = job.payload;
  if (p.__mode && p.__mode !== config.mode)
    throw new Error(
      "Task belongs to another execution mode; it was not executed.",
    );
  if (
    config.mode === "demo" &&
    [
      "extract",
      "scan_source",
      "portal",
      "create_monitor",
      "run_monitor",
      "inbox",
      "cleanup_browser",
    ].includes(job.kind)
  )
    throw new Error("This task requires live mode. No provider call was made.");
  if (
    p.applicationId &&
    get<AppRecord>("application", p.applicationId, u)?.status === "discarded"
  )
    return;
  switch (job.kind) {
    case "discover":
      return discovery(u, p);
    case "extract":
      return extract(u, p.url);
    case "match": {
      const profile = get<Profile>("profile", u, u)!,
        listing = get<Listing>("listing", p.listingId)!;
      if (listing.provenance !== config.mode) return;
      const match = await matchListing(profile, listing);
      put("match", `${u}:${p.listingId}`, u, {
        ...match,
        listingId: p.listingId,
        updatedAt: now(),
        feedback: get("match", `${u}:${p.listingId}`, u)?.feedback || null,
        shortlisted:
          get("match", `${u}:${p.listingId}`, u)?.shortlisted || false,
      });
      event(u, "matcher", `Assessed ${listing.title}: ${match.score}% fit`, {
        listingId: p.listingId,
      });
      if (match.score >= 80)
        await notify(
          u,
          "high_match",
          `Strong match: ${listing.title} at ${listing.company}`,
          p.listingId,
          `match:${p.listingId}`,
        );
      return;
    }
    case "map":
      return mapApplication(u, p.applicationId);
    case "fill": {
      const a = ownedApplication(p.applicationId, u);
      a.status = "verifying";
      saveApp(a);
      const result = await fillApplication(a, get<Profile>("profile", u, u)!);
      event(
        u,
        "verifier",
        !result.verification || result.verification.errors.length
          ? "Form needs attention"
          : "Form verified. Waiting for your approval.",
        { applicationId: a.id },
      );
      return;
    }
    case "submit": {
      const a = ownedApplication(p.applicationId, u);
      if (a.submittedAt && a.receipt) return;
      if (a.status !== "submitting")
        throw new Error("Submission is not approved");
      if (a.provenance === "live") {
        const listing = get<Listing>("listing", a.listingId)!;
        const fresh = await tinyfish.fetchUrls([listing.url], true);
        if (!fresh.results.length)
          throw new Error("Cannot revalidate listing before submission");
        if (
          /no longer accepting applications|applications are closed|this job is no longer available/i.test(
            fresh.results[0].text || "",
          )
        ) {
          a.status = "expired";
          saveApp(a);
          return;
        }
      }
      await submitApplication(a, get<Profile>("profile", u, u)!);
      await notify(
        u,
        "submitted",
        "Application submitted with confirmation evidence.",
        a.id,
        `submitted:${a.id}`,
      );
      return;
    }
    case "send_email": {
      const a = ownedApplication(p.applicationId, u),
        profile = get<Profile>("profile", u, u)!;
      if (a.submittedAt && a.receipt) return;
      if (
        a.status !== "submitting" ||
        a.approvalHash !== packageHash(a) ||
        get("application_profile", a.id, u)?.profileHash !== hash(profile)
      )
        throw new Error("Email package or profile changed after approval");
      if (a.provenance === "demo") {
        a.receipt = {
          messageId: `demo-${a.id}`,
          threadId: `demo-${a.id}`,
          at: now(),
          simulated: true,
        };
        enqueue(u, "demo_reply", { applicationId: a.id }, 2000);
      } else {
        a.actionAttempted = true;
        a.submissionStartedAt = now();
        saveApp(a);
        a.receipt = await sendApplicationEmail(a, profile);
      }
      a.status = a.route === "outreach" ? "outreach_sent" : "email_sent";
      a.submittedAt = now();
      saveApp(a);
      audit(u, "mailer", "email_sent", a.id, {
        provenance: a.provenance,
        receipt: a.receipt,
      });
      return;
    }
    case "demo_reply": {
      const a = ownedApplication(p.applicationId, u);
      if ((a.provenance !== "demo" && !a.controlledTarget) || !a.submittedAt)
        return;
      return ingestEmail(u, a, {
        id: `demo-interview-${a.id}`,
        subject: "Interview invitation — controlled demo",
        text: "Thank you for applying. We would like to invite you to an interview. This is a simulated employer response, not a real email.",
        from: "demo-employer@acme.example",
        provenance: "demo",
      });
    }
    case "portal":
      return checkPortal(u, p.applicationId);
    case "inbox":
      return pollGmail(u);
    case "cleanup_browser": {
      const closed = await cleanupRemoteLease(u, p.sessionId, p.attempt || 0);
      if (
        !closed &&
        get("browser_lease", p.sessionId, u)?.status === "cleanup_failed"
      )
        throw new Error("Remote browser cleanup failed after three attempts.");
      return;
    }
    case "scan_source": {
      const source = get("source", p.sourceId, u);
      if (!source || source.policy === "blocked") return;
      const run =
        source.type === "search"
          ? await tinyfish.search(source.target)
          : await tinyfish.fetchUrls([source.target], true);
      return processMonitor(u, source.id, run);
    }
    case "create_monitor": {
      const s = get("source", p.sourceId, u);
      const sharedKey = hash({
        type: s.type,
        target: s.target,
        schedule: s.schedule,
      });
      const shared = get("shared_monitor", sharedKey);
      if (shared) {
        put("source", s.id, u, {
          ...s,
          tfMonitorId: shared.tfMonitorId,
          sharedKey,
          localPolling: shared.localPolling,
          nextRunAt: nextScheduledRun(s.schedule).toISOString(),
          health: "healthy",
          status: "active",
        });
        return processMonitor(u, s.id, shared.baseline);
      }
      const body: any = {
        type: s.type,
        name: s.name,
        config:
          s.type === "fetch"
            ? { url: s.target, format: "markdown", links: true }
            : { query: s.target, result_limit: 10 },
        schedule_cron: s.schedule,
        purpose: "Detect new internship postings",
      };
      if (config.appUrl.startsWith("https:") && process.env.WEBHOOK_SECRET)
        body.webhook_url = `${config.appUrl}/api/webhooks/monitor?token=${encodeURIComponent(process.env.WEBHOOK_SECRET)}`;
      const r = await tinyfish.createMonitor(body);
      const localPolling = !body.webhook_url;
      if (localPolling)
        await tinyfish.patchMonitor(r.monitor.id, { status: "paused" });
      put("shared_monitor", sharedKey, "", {
        tfMonitorId: r.monitor.id,
        localPolling,
        baseline: r.run,
        schedule: s.schedule,
        nextRunAt: nextScheduledRun(s.schedule).toISOString(),
      });
      put("source", s.id, u, {
        ...s,
        tfMonitorId: r.monitor.id,
        sharedKey,
        localPolling,
        nextRunAt: nextScheduledRun(s.schedule).toISOString(),
        health: "healthy",
        status: "active",
      });
      return processMonitor(u, s.id, r.run);
    }
    case "run_monitor": {
      const s = get("source", p.sourceId, u);
      if (!s.tfMonitorId) throw new Error("Monitor is not registered");
      const r = await tinyfish.runMonitor(s.tfMonitorId);
      for (const subscriber of list<any>("source").filter(
        (x) =>
          x.tfMonitorId === s.tfMonitorId &&
          x.status === "active" &&
          x.policy !== "blocked",
      )) {
        const owner = (
          db
            .prepare("SELECT user_id FROM records WHERE kind='source' AND id=?")
            .get(subscriber.id) as any
        ).user_id;
        await processMonitor(owner, subscriber.id, r.run);
      }
      return;
    }
    case "research": {
      const listing = get<Listing>("listing", p.listingId)!;
      const cached = get("brief", listing.company, u);
      if (
        cached &&
        cached.provenance === config.mode &&
        ["completed", "running"].includes(cached.status) &&
        Date.now() - Date.parse(cached.createdAt) < 30 * 86400000
      )
        return;
      if (config.mode === "demo") {
        put("brief", listing.company, u, {
          company: listing.company,
          report:
            "Controlled demo company. This brief is illustrative, not TinyFish research.",
          citations: [listing.url],
          provenance: "demo",
          status: "completed",
          createdAt: now(),
        });
        return;
      }
      const r = await tinyfish.createResearch(
        `${listing.company}: internship program, engineering team, interview process. Cite reliable sources.`,
      );
      put("brief", listing.company, u, {
        company: listing.company,
        runId: r.research_run_id,
        status: "running",
        createdAt: now(),
        provenance: "live",
      });
      enqueue(
        u,
        "research_poll",
        { company: listing.company, runId: r.research_run_id },
        5000,
      );
      return;
    }
    case "contacts": {
      const listing = get<Listing>("listing", p.listingId)!;
      if (config.mode === "demo") {
        put("contacts", p.listingId, u, {
          listingId: p.listingId,
          contacts: [
            {
              email: "recruiting@acme.example",
              source: listing.url,
              evidence: "Controlled demo recruiting address",
            },
          ],
          provenance: "demo",
          createdAt: now(),
        });
        return;
      }
      const results = await tinyfish.search(
        `${listing.company} careers recruiting contact email`,
      );
      const urls = results.results
        .slice(0, 3)
        .map((r: any) => assertPublicUrl(r.url));
      if (!urls.length) throw new Error("No company contact pages found");
      const pages = await tinyfish.fetchUrls(urls, true),
        contacts: any[] = [],
        seen = new Set<string>();
      for (const page of pages.results) {
        const text = String(page.text || "");
        for (const match of text.matchAll(
          /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
        )) {
          const email = match[0].toLowerCase();
          const index = match.index || 0,
            evidence = text.slice(
              Math.max(0, index - 200),
              index + email.length + 200,
            );
          if (
            seen.has(email) ||
            /^(support|privacy|abuse|noreply|no-reply|unsubscribe)@/.test(
              email,
            ) ||
            !/recruit|hiring|career|talent|internship/i.test(evidence)
          )
            continue;
          seen.add(email);
          contacts.push({
            email,
            source: page.final_url || page.url,
            evidence,
          });
        }
      }
      put("contacts", p.listingId, u, {
        listingId: p.listingId,
        contacts: contacts.slice(0, 10),
        provenance: "live",
        createdAt: now(),
      });
      event(
        u,
        "outreach",
        `Found ${contacts.length} published recruiting contacts. User review is required.`,
        { listingId: p.listingId },
      );
      return;
    }
    case "research_poll": {
      const r = await tinyfish.getResearch(p.runId),
        brief = get("brief", p.company, u);
      if (r.status === "COMPLETED") {
        put("brief", p.company, u, {
          ...brief,
          status: "completed",
          report: r.report || r.result || r.output || r,
          citations: r.citations || [],
        });
      } else if (["FAILED", "CANCELLED", "TIMED_OUT"].includes(r.status))
        put("brief", p.company, u, {
          ...brief,
          status: "failed",
          error: r.error || r.status,
        });
      else enqueue(u, "research_poll", p, 10000);
      return;
    }
    default:
      throw new Error(`Unknown job type ${job.kind}`);
  }
}
export async function runOneJob() {
  const job = claimJob();
  if (!job) return false;
  event(job.user_id, "worker", `Started ${job.kind}`, { jobId: job.id });
  try {
    await handleJob(job);
    finishJob(job.id);
  } catch (e) {
    const error = (e as Error).message;
    finishJob(job.id, error, false);
    event(job.user_id, "worker", `${job.kind} failed`, {
      jobId: job.id,
      error,
    });
    if (job.payload.applicationId) {
      const a = get<AppRecord>(
        "application",
        job.payload.applicationId,
        job.user_id,
      );
      if (a && a.status !== "discarded" && a.provenance === config.mode) {
        if (["submit", "send_email"].includes(job.kind))
          a.status = a.actionAttempted
            ? "submission_uncertain"
            : ["needs_user_input", "awaiting_approval"].includes(a.status)
              ? a.status
              : "failed";
        else if (["map", "fill"].includes(job.kind))
          a.status = a.status === "blocked" ? "blocked" : "failed";
        a.error = error;
        saveApp(a);
      }
    }
    if (job.payload.sourceId) {
      const s = get("source", job.payload.sourceId, job.user_id);
      if (s) put("source", s.id, job.user_id, { ...s, health: "error", error });
    }
  }
  return true;
}
export async function schedulerTick() {
  if (config.mode === "live") {
    for (const shared of list<any>("shared_monitor")) {
      if (!shared.localPolling || shared.nextRunAt > now()) continue;
      const subscriber = list<any>("source").find(
        (s) =>
          s.sharedKey === shared.id &&
          s.status === "active" &&
          s.policy !== "blocked",
      );
      put("shared_monitor", shared.id, "", {
        ...shared,
        nextRunAt: nextScheduledRun(shared.schedule).toISOString(),
      });
      if (subscriber) {
        const owner = (
          db
            .prepare("SELECT user_id FROM records WHERE kind='source' AND id=?")
            .get(subscriber.id) as any
        ).user_id;
        enqueue(owner, "run_monitor", { sourceId: subscriber.id });
      }
    }
  }
  for (const profile of list<Profile & { id: string }>("profile")) {
    if (config.mode === "live") {
      for (const source of list<any>("source", profile.id)) {
        if (
          source.status === "active" &&
          source.policy !== "blocked" &&
          source.backlogUrls?.length
        ) {
          for (const url of source.backlogUrls.slice(0, 20))
            enqueue(profile.id, "extract", { url });
          put("source", source.id, profile.id, {
            ...source,
            backlogUrls: source.backlogUrls.slice(20),
          });
        }
        if (
          source.tfMonitorId ||
          source.status !== "active" ||
          source.policy === "blocked" ||
          source.nextRunAt > now()
        )
          continue;
        put("source", source.id, profile.id, {
          ...source,
          nextRunAt: nextScheduledRun(source.schedule).toISOString(),
        });
        enqueue(profile.id, "scan_source", { sourceId: source.id });
      }
      for (const portal of list<any>("portal", profile.id)) {
        const a = get<AppRecord>("application", portal.id, profile.id);
        if (
          !a?.submittedAt ||
          ["offer", "rejection"].includes(a.employerStatus || "") ||
          portal.nextCheckAt > now()
        )
          continue;
        put("portal", portal.id, profile.id, {
          ...portal,
          nextCheckAt: new Date(Date.now() + 6 * 3600000).toISOString(),
        });
        enqueue(profile.id, "portal", { applicationId: portal.id });
      }
    }
    for (const match of list<any>("match", profile.id)) {
      const listing = get<Listing>("listing", match.listingId);
      if (!listing?.deadline || listing.provenance !== config.mode) continue;
      const a = list<AppRecord>("application", profile.id).find(
        (a) => a.listingId === match.listingId,
      );
      if (a?.submittedAt || a?.status === "discarded") continue;
      const hours = (Date.parse(listing.deadline) - Date.now()) / 3600000;
      if (hours <= 0) continue;
      const stage =
        hours <= 1
          ? "one_hour"
          : hours <= 24
            ? "today"
            : hours <= 72
              ? "three_days"
              : null;
      if (stage)
        await notify(
          profile.id,
          "deadline",
          `${listing.title} deadline is in ${Math.ceil(hours)} hours.`,
          a?.id || match.listingId,
          `deadline:${match.listingId}:${listing.deadline}:${stage}`,
          stage === "one_hour",
        );
    }
    if (
      config.mode === "live" &&
      loadTokens(profile.id) &&
      once(
        `gmail_poll:${profile.id}:${Math.floor(Date.now() / (Number(process.env.GMAIL_POLL_INTERVAL_SECONDS || 600) * 1000))}`,
      )
    )
      enqueue(profile.id, "inbox", {});
  }
}
