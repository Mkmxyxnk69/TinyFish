import express from "express";
import multer from "multer";
import { z } from "zod";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { PDFParse } from "pdf-parse";
import { createClient } from "@supabase/supabase-js";
import { config, capabilities } from "../../packages/core/config.js";
import {
  db,
  get,
  list,
  put,
  id,
  now,
  enqueue,
  event,
  audit,
  once,
} from "../../packages/core/db.js";
import {
  auth,
  currentUser,
  newUser,
  session,
  verifyPassword,
  checkOrigin,
  storeTokens,
  loadTokens,
  encrypt,
  decrypt,
} from "../../packages/core/auth.js";
import { ProfileSchema, type AppRecord } from "../../packages/core/schemas.js";
import { saveDocument, readDocument } from "../../packages/core/documents.js";
import { parseProfile } from "../../packages/core/intelligence.js";
import {
  applicationView,
  startApplication,
  requestApproval,
  answerApplication,
  ownedApplication,
  saveApp,
  assertPublicUrl,
  processMonitor,
} from "../../packages/core/workflow.js";
import { closeSession, packageHash } from "../../packages/core/browser.js";
import { googleClient, ingestEmail } from "../../packages/core/integrations.js";
import { tinyfish } from "../../packages/core/tinyfish.js";
import { validateSchedule } from "../../packages/core/schedule.js";
import { registerDemo } from "../demo-target/target.js";
export const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));
app.use(checkOrigin);
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  next();
});
const userId = (req: any) => req.user.id;
const param = (req: any, name = "id") => String(req.params[name]);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});
const attempts = new Map<string, { count: number; until: number }>();
app.use("/api/auth", (req, res, next) => {
  const key = req.ip || "unknown";
  let value = attempts.get(key);
  if (!value || value.until < Date.now()) {
    value = { count: 0, until: Date.now() + 60000 };
    attempts.set(key, value);
  }
  if (++value.count > 30)
    return res.status(429).json({
      error: "Too many authentication requests. Try again in one minute.",
    });
  next();
});
app.get("/api/health", (_req, res) =>
  res.json({ ok: true, mode: config.mode, worker: "running" }),
);
app.post("/api/auth/register", (req, res) => {
  const value = z
    .object({
      name: z.string().min(1).max(120),
      email: z.string().email(),
      password: z.string().min(10).max(200),
    })
    .parse(req.body);
  if (
    db
      .prepare("SELECT id FROM users WHERE email=?")
      .get(value.email.toLowerCase())
  )
    return res.status(409).json({ error: "Email already registered" });
  const user = newUser(value.email, value.name, value.password);
  session(res, user.id);
  res.status(201).json({ user });
});
app.post("/api/auth/login", (req, res) => {
  const value = z
    .object({ email: z.string().email(), password: z.string().max(200) })
    .parse(req.body);
  const user = db
    .prepare("SELECT * FROM users WHERE email=?")
    .get(value.email.toLowerCase()) as any;
  if (
    !user?.password_hash ||
    !verifyPassword(value.password, user.password_hash)
  )
    return res.status(401).json({ error: "Invalid email or password" });
  session(res, user.id);
  res.json({ user: { id: user.id, email: user.email, name: user.name } });
});
app.post("/api/auth/demo", (_req, res) => {
  if (config.mode !== "demo")
    return res
      .status(403)
      .json({ error: "Demo login is disabled in live mode" });
  const user = newUser(`demo-${id()}@example.test`, "Alex Morgan");
  put(
    "profile",
    user.id,
    user.id,
    ProfileSchema.parse({
      name: "Alex Morgan",
      email: user.email,
      headline: "Computer science student building useful backend tools",
      education: "B.Tech Computer Science — demonstration profile",
      skills: ["Python", "FastAPI", "SQL", "React", "TypeScript"],
      projects: [
        {
          name: "Campus API",
          description:
            "Built a student project API with Python, FastAPI, and SQL.",
          skills: ["Python", "FastAPI", "SQL"],
          url: "https://github.com/example/campus-api",
        },
      ],
      links: { github: "https://github.com/example" },
      preferences: {
        keywords: "Python backend internship",
        location: "India",
        availableMonths: 3,
      },
    }),
  );
  session(res, user.id);
  res.json({ user });
});
app.post("/api/auth/logout", auth, (req, res) => {
  const token = req.headers.cookie
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith("autopilot_session="))
    ?.split("=")[1];
  if (token)
    db.prepare("DELETE FROM sessions WHERE token_hash=?").run(
      createHash("sha256").update(token).digest("hex"),
    );
  res.clearCookie("autopilot_session", { path: "/" });
  res.json({ ok: true });
});
app.get("/api/auth/me", (req, res) =>
  res.json({ user: currentUser(req), capabilities: capabilities() }),
);
app.get("/api/auth/google", (req, res) => {
  if (!capabilities().google)
    return res
      .status(503)
      .json({ error: "Configure Google OAuth credentials first" });
  const user = currentUser(req),
    connect = req.query.connect === "gmail";
  if (connect && !user)
    return res.status(401).json({ error: "Sign in before connecting Gmail" });
  const state = randomBytes(24).toString("hex");
  put("oauth_state", state, user?.id || "", {
    userId: user?.id,
    connect,
    expiresAt: new Date(Date.now() + 600000).toISOString(),
  });
  res.cookie("autopilot_oauth", state, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.appUrl.startsWith("https:"),
    maxAge: 600000,
    path: "/",
  });
  res.redirect(
    googleClient().generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      state,
      scope: connect
        ? [
            "openid",
            "email",
            "profile",
            "https://www.googleapis.com/auth/gmail.readonly",
            "https://www.googleapis.com/auth/gmail.send",
          ]
        : ["openid", "email", "profile"],
    }),
  );
});
app.get("/api/auth/google/callback", async (req, res) => {
  const state = String(req.query.state || ""),
    record = get("oauth_state", state),
    cookie = req.headers.cookie
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("autopilot_oauth="))
      ?.split("=")[1];
  if (
    !record ||
    record.expiresAt < now() ||
    cookie !== state ||
    !once(`oauth:${state}`)
  )
    return res.status(400).send("Invalid or expired OAuth state");
  const client = googleClient(),
    { tokens } = await client.getToken(String(req.query.code || ""));
  client.setCredentials(tokens);
  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token!,
    audience: process.env.GOOGLE_CLIENT_ID,
  });
  const identity = ticket.getPayload();
  if (!identity?.email_verified || !identity.email)
    throw new Error("Verified Google email required");
  let user: any;
  if (record.connect) {
    user = currentUser(req);
    if (!user || user.id !== record.userId)
      return res.status(403).send("OAuth session changed");
    storeTokens(user.id, tokens);
    audit(user.id, "user", "gmail_connected", user.id);
  } else {
    user =
      db
        .prepare("SELECT id,email,name FROM users WHERE email=?")
        .get(identity.email.toLowerCase()) ||
      newUser(identity.email, identity.name || identity.email);
    session(res, user.id);
  }
  res.clearCookie("autopilot_oauth", { path: "/" });
  res.redirect(`${config.appUrl}/?tab=settings`);
});
app.post("/api/auth/supabase", async (req, res) => {
  if (!capabilities().supabase)
    return res.status(503).json({ error: "Supabase is not configured" });
  const token = z.string().min(1).parse(req.body.accessToken);
  const client = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_ANON_KEY!,
  );
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user?.email || !data.user.email_confirmed_at)
    return res
      .status(401)
      .json({ error: "Verified Supabase session required" });
  const user: any =
    db
      .prepare("SELECT id,email,name FROM users WHERE email=?")
      .get(data.user.email.toLowerCase()) ||
    newUser(
      data.user.email,
      data.user.user_metadata.full_name || data.user.email,
    );
  session(res, user.id);
  res.json({ user });
});
app.use("/api", (req, res, next) => {
  if (req.path.startsWith("/webhooks/")) return next();
  auth(req, res, next);
});
app.get("/api/dashboard", (req, res) => {
  const u = userId(req),
    matches = list<any>("match", u),
    applications = list<AppRecord>("application", u).filter(
      (a) => a.provenance === config.mode,
    );
  const applicationIds = new Set(applications.map((a) => a.id));
  const responses = list<any>("email_event", u).filter((r) =>
    applicationIds.has(r.applicationId),
  );
  const listings = matches
    .map((m) => ({
      ...get("listing", m.listingId),
      match: m,
      application: applications.find((a) => a.listingId === m.listingId)
        ? applicationView(
            applications.find((a) => a.listingId === m.listingId)!,
          )
        : null,
    }))
    .filter((l) => l.provenance === config.mode);
  res.json({
    user: (req as any).user,
    profile: get("profile", u, u),
    capabilities: {
      ...capabilities(),
      gmailConnected: !!loadTokens(u),
      browserProfiles: list<any>("browser_profile", u).map(
        ({ setup, ...safe }) => safe,
      ),
    },
    listings,
    applications: applications.map(applicationView),
    notifications: list("notification", u),
    events: list("event", u).slice(0, 100),
    sources: list("source", u),
    jobs: db
      .prepare(
        "SELECT id,kind,status,attempts,last_error,created_at FROM jobs WHERE user_id=? ORDER BY created_at DESC LIMIT 60",
      )
      .all(u),
    briefs: list("brief", u),
    documents: list("document", u),
    audit: list("audit", u).slice(0, 100),
    analytics: {
      total: listings.length,
      shortlisted: matches.filter((m) => m.shortlisted).length,
      submitted: applications.filter(
        (a) => a.submittedAt && a.route !== "outreach",
      ).length,
      responses: responses.length,
      skillGaps: [
        ...new Set(
          matches.flatMap((m) =>
            (m.requirements || [])
              .filter((r: any) => r.status === "missing")
              .map((r: any) => r.text),
          ),
        ),
      ],
    },
    responses,
    contacts: list("contacts", u),
  });
});
app.put("/api/profile", (req, res) => {
  const u = userId(req),
    profile = ProfileSchema.parse(req.body);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: profile.alerts.timezone });
  } catch {
    return res.status(400).json({ error: "Invalid notification timezone" });
  }
  put("profile", u, u, profile);
  for (const m of list<any>("match", u))
    enqueue(u, "match", { listingId: m.listingId });
  audit(u, "user", "profile_updated", u);
  res.json({ profile });
});
app.post("/api/profile/resume", upload.single("resume"), async (req, res) => {
  if (!req.file)
    return res.status(400).json({ error: "Attach a PDF or text resume" });
  if (!["application/pdf", "text/plain"].includes(req.file.mimetype))
    return res
      .status(400)
      .json({ error: "Only PDF and text resumes are supported" });
  const u = userId(req),
    doc = saveDocument(
      u,
      req.file.originalname,
      req.file.mimetype,
      req.file.buffer,
    ),
    profile = get("profile", u, u);
  profile.resumeId = doc.id;
  put("profile", u, u, profile);
  let text = "";
  if (req.file.mimetype === "text/plain")
    text = req.file.buffer.toString("utf8");
  else {
    const parser = new PDFParse({ data: req.file.buffer });
    try {
      text = (await parser.getText()).text;
    } finally {
      await parser.destroy();
    }
  }
  const parsed = await parseProfile(text, profile);
  res.json({ document: doc, ...parsed });
});
app.get("/api/documents/:id", (req, res) => {
  const doc = readDocument(param(req), userId(req));
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${doc.name.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
  );
  res.type(doc.mime).send(doc.buffer);
});
app.post("/api/discover", (req, res) => {
  const payload = z
    .object({ query: z.string().max(500).optional() })
    .parse(req.body);
  res.status(202).json({ jobId: enqueue(userId(req), "discover", payload) });
});
app.post("/api/listings/import", (req, res) => {
  if (config.mode !== "live")
    return res
      .status(400)
      .json({ error: "URL import is available in live mode only" });
  const url = assertPublicUrl(z.string().url().parse(req.body.url));
  res.status(202).json({ jobId: enqueue(userId(req), "extract", { url }) });
});
app.post("/api/listings/:id/feedback", (req, res) => {
  const u = userId(req),
    key = `${u}:${param(req)}`,
    match = get("match", key, u);
  if (!match) return res.status(404).json({ error: "Listing not found" });
  const value = z
    .object({
      feedback: z.enum(["relevant", "not_relevant"]).optional(),
      shortlisted: z.boolean().optional(),
    })
    .parse(req.body);
  put("match", key, u, { ...match, ...value });
  res.json({ ok: true });
});
app.post("/api/listings/:id/prepare", (req, res) => {
  const u = userId(req);
  if (!get("match", `${u}:${param(req)}`, u))
    return res.status(404).json({ error: "Listing not found" });
  const value = z
    .object({
      route: z.enum(["web", "email", "outreach"]).default("web"),
      recipient: z.string().email().optional(),
    })
    .parse(req.body);
  res.status(202).json({
    application: applicationView(
      startApplication(u, param(req), value.route, value.recipient),
    ),
  });
});
app.get("/api/applications/:id", (req, res) =>
  res.json({
    application: applicationView(ownedApplication(param(req), userId(req))),
  }),
);
app.put("/api/applications/:id/answers", async (req, res) => {
  const value = z
    .object({
      answers: z.record(z.string().max(10000)).default({}),
      coverLetter: z.string().max(20000).optional(),
      recipient: z.string().email().optional(),
    })
    .parse(req.body);
  res.json({
    application: applicationView(
      await answerApplication(
        userId(req),
        param(req),
        value.answers,
        value.coverLetter,
        value.recipient,
      ),
    ),
  });
});
app.post("/api/applications/:id/approve", (req, res) =>
  res.json({
    application: applicationView(
      requestApproval(
        userId(req),
        param(req),
        z.string().parse(req.body.packageHash),
      ),
    ),
  }),
);
app.post("/api/applications/:id/release-session", async (req, res) => {
  const a = ownedApplication(param(req), userId(req));
  if (!["awaiting_approval", "needs_user_input"].includes(a.status))
    return res
      .status(409)
      .json({ error: "Only a pending review session can be released" });
  await closeSession(a);
  a.session = undefined;
  saveApp(a);
  audit(a.userId, "user", "review_session_released", a.id);
  res.json({ ok: true });
});
app.post("/api/applications/:id/discard", async (req, res) => {
  const a = ownedApplication(param(req), userId(req));
  if (
    ["submitting", "submitted", "email_sent", "outreach_sent"].includes(
      a.status,
    )
  )
    return res.status(409).json({
      error: "Cannot discard an application during or after submission",
    });
  a.status = "discarded";
  a.approvalHash = undefined;
  saveApp(a);
  await closeSession(a);
  audit(a.userId, "user", "application_discarded", a.id);
  res.json({ ok: true });
});
app.post("/api/applications/:id/retry", (req, res) => {
  const a = ownedApplication(param(req), userId(req));
  if (!["failed", "blocked"].includes(a.status))
    return res.status(409).json({
      error:
        "Only failed or blocked preparation can be retried. Uncertain submissions must be reconciled.",
    });
  a.status = "mapping";
  a.error = undefined;
  saveApp(a);
  res
    .status(202)
    .json({ jobId: enqueue(a.userId, "map", { applicationId: a.id }) });
});
app.post("/api/applications/:id/reconcile", (req, res) => {
  const a = ownedApplication(param(req), userId(req));
  if (a.status !== "submission_uncertain")
    return res
      .status(409)
      .json({ error: "Only uncertain submissions can be reconciled" });
  const value = z
    .object({
      outcome: z.enum(["submitted", "not_submitted"]),
      evidence: z.string().min(10).max(3000),
    })
    .parse(req.body);
  a.receipt = { text: value.evidence, manual: true, at: now() };
  a.status = value.outcome === "submitted" ? "submitted" : "failed";
  if (value.outcome === "submitted") a.submittedAt = now();
  a.error = undefined;
  saveApp(a);
  audit(a.userId, "user", "submission_manually_reconciled", a.id, value);
  res.json({ application: applicationView(a) });
});
app.put("/api/applications/:id/portal", (req, res) => {
  const a = ownedApplication(param(req), userId(req));
  const value = z
    .object({
      url: z.string().url(),
      profileId: z.string().max(100).optional(),
    })
    .parse(req.body);
  assertPublicUrl(value.url);
  if (value.profileId && !get("browser_profile", value.profileId, a.userId))
    return res.status(403).json({
      error:
        "Browser profile does not belong to this user. Create it in Settings.",
    });
  put("portal", a.id, a.userId, {
    ...value,
    nextCheckAt: new Date(Date.now() + 6 * 3600000).toISOString(),
  });
  res.json({ ok: true });
});
app.post("/api/applications/:id/check", (req, res) => {
  const a = ownedApplication(param(req), userId(req));
  if (config.mode !== "live")
    return res
      .status(400)
      .json({ error: "Authenticated portal checks require live mode" });
  res
    .status(202)
    .json({ jobId: enqueue(a.userId, "portal", { applicationId: a.id }) });
});
app.post("/api/applications/:id/simulate-reply", async (req, res) => {
  const a = ownedApplication(param(req), userId(req));
  if (a.provenance !== "demo" || !a.submittedAt)
    return res.status(403).json({
      error: "Only submitted demo applications support simulated replies",
    });
  await ingestEmail(a.userId, a, {
    id: `manual-demo-${id()}`,
    subject: "Demo employer reply",
    text: "We would like to invite you to an interview. This is a simulated response.",
    from: "demo@acme.example",
    provenance: "demo",
  });
  res.json({ ok: true });
});
app.post("/api/inbox/poll", (req, res) =>
  res.status(202).json({ jobId: enqueue(userId(req), "inbox", {}) }),
);
app.post("/api/inbox/disconnect", (req, res) => {
  db.prepare("DELETE FROM records WHERE kind='credential' AND user_id=?").run(
    userId(req),
  );
  res.json({ ok: true });
});
app.post("/api/notifications/:id/read", (req, res) => {
  const u = userId(req),
    n = get("notification", param(req), u);
  if (!n) return res.status(404).json({ error: "Notification not found" });
  put("notification", n.id, u, { ...n, read: true });
  res.json({ ok: true });
});
app.post("/api/listings/:id/research", (req, res) => {
  if (!get("match", `${userId(req)}:${param(req)}`, userId(req)))
    return res.status(404).json({ error: "Listing not found" });
  res.status(202).json({
    jobId: enqueue(userId(req), "research", { listingId: param(req) }),
  });
});
app.post("/api/listings/:id/contacts", (req, res) => {
  if (!get("match", `${userId(req)}:${param(req)}`, userId(req)))
    return res.status(404).json({ error: "Listing not found" });
  res.status(202).json({
    jobId: enqueue(userId(req), "contacts", { listingId: param(req) }),
  });
});
app.post("/api/sources", (req, res) => {
  const value = z
    .object({
      name: z.string().min(1).max(100),
      type: z.enum(["fetch", "search"]),
      target: z.string().min(1).max(2000),
      policy: z
        .enum(["monitor_only", "prepare_forms", "blocked"])
        .default("monitor_only"),
      schedule: z.string().default("0 */6 * * *"),
      createMonitor: z.boolean().default(false),
    })
    .parse(req.body);
  if (value.type === "fetch") assertPublicUrl(value.target);
  const nextRunAt = validateSchedule(value.schedule, value.type === "search");
  if (value.createMonitor && config.mode !== "live")
    return res
      .status(400)
      .json({ error: "TinyFish Monitors require live mode" });
  const source = put("source", id(), userId(req), {
    ...value,
    status:
      config.mode === "demo"
        ? "paused"
        : value.createMonitor
          ? "registering"
          : "active",
    nextRunAt,
    health: "not_checked",
    seenUrls: [],
  });
  if (value.createMonitor)
    enqueue(userId(req), "create_monitor", { sourceId: source.id });
  res.status(201).json({ source });
});
app.patch("/api/sources/:id", async (req, res) => {
  const u = userId(req),
    s = get("source", param(req), u);
  if (!s) return res.status(404).json({ error: "Source not found" });
  const value = z
    .object({
      policy: z.enum(["monitor_only", "prepare_forms", "blocked"]).optional(),
      status: z.enum(["active", "paused"]).optional(),
    })
    .parse(req.body);
  if (s.tfMonitorId && value.status && !s.localPolling) {
    const others = list<any>("source").some(
      (x) =>
        x.id !== s.id &&
        x.tfMonitorId === s.tfMonitorId &&
        x.status === "active" &&
        x.policy !== "blocked",
    );
    await tinyfish.patchMonitor(s.tfMonitorId, {
      status: value.status === "active" || others ? "active" : "paused",
    });
  }
  put("source", s.id, u, { ...s, ...value });
  res.json({ ok: true });
});
app.post("/api/sources/:id/refresh", (req, res) => {
  if (config.mode !== "live")
    return res.status(400).json({
      error:
        "Source refresh requires live mode. Demo discovery uses controlled listings.",
    });
  const u = userId(req),
    s = get("source", param(req), u);
  if (!s) return res.status(404).json({ error: "Source not found" });
  if (s.policy === "blocked")
    return res.status(409).json({ error: "This source is blocked" });
  res.status(202).json({
    jobId: enqueue(u, s.tfMonitorId ? "run_monitor" : "scan_source", {
      sourceId: s.id,
    }),
  });
});
app.post("/api/integrations/tinyfish/probe", async (req, res) => {
  if (!config.tinyfishKey)
    return res
      .status(503)
      .json({ error: "TINYFISH_API_KEY is not configured" });
  const search = await tinyfish.search("TinyFish official documentation", {
    include_domains: "docs.tinyfish.ai",
  });
  const fetched = await tinyfish.fetchUrls(["https://docs.tinyfish.ai/"]);
  const report = {
    search: search.results.length > 0,
    fetch: fetched.results.length > 0,
    checkedAt: now(),
    mode: "live",
    note: "Read-only Search and Fetch verified. Browser and Agent require separate execution verification.",
  };
  put("integration_check", "tinyfish", userId(req), report);
  res.json(report);
});
app.post("/api/browser-profiles", async (req, res) => {
  if (config.mode !== "live")
    return res
      .status(400)
      .json({ error: "Authenticated browser profiles require live mode" });
  const name = z.string().min(1).max(100).parse(req.body.name),
    remote = await tinyfish.createProfile(name);
  const profileId = remote.id || remote.profile?.id || remote.profile_id;
  if (!profileId) throw new Error("TinyFish profile creation returned no ID");
  const profile = put("browser_profile", profileId, userId(req), {
    name,
    configured: false,
  });
  res.status(201).json({ profile });
});
app.post("/api/browser-profiles/:id/setup", async (req, res) => {
  const p = get("browser_profile", param(req), userId(req));
  if (!p) return res.status(404).json({ error: "Browser profile not found" });
  const url = assertPublicUrl(z.string().url().parse(req.body.url)),
    setup = await tinyfish.setupProfile(p.id, url);
  put("browser_profile", p.id, userId(req), { ...p, setup: encrypt(setup) });
  let inspectorUrl: string | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    const pages = await fetch(`${setup.base_url}/pages`, {
      signal: AbortSignal.timeout(15000),
    }).then((r) => r.json());
    const found = pages.find(
      (page: any) => page.devtoolsFrontendUrl && page.url !== "about:blank",
    );
    if (found) {
      inspectorUrl = new URL(
        found.devtoolsFrontendUrl,
        setup.base_url,
      ).toString();
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!inspectorUrl)
    throw new Error(
      "Setup session started, but its inspector is not ready. Start setup again after it expires.",
    );
  res.json({ inspectorUrl, expiresAt: setup.expires_at });
});
app.post("/api/browser-profiles/:id/save", async (req, res) => {
  const p = get("browser_profile", param(req), userId(req));
  if (!p?.setup)
    return res.status(404).json({ error: "Profile setup session not found" });
  const setup = decrypt(p.setup);
  await tinyfish.saveProfile(p.id, setup.session_id);
  put("browser_profile", p.id, userId(req), { name: p.name, configured: true });
  audit(userId(req), "user", "browser_profile_saved", p.id);
  res.json({ ok: true });
});
function webhookAllowed(req: any) {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) return false;
  const token = String(req.query.token || req.headers["x-webhook-token"] || "");
  return (
    token.length === secret.length &&
    timingSafeEqual(Buffer.from(token), Buffer.from(secret))
  );
}
app.post("/api/webhooks/run", async (req, res) => {
  if (!webhookAllowed(req))
    return res
      .status(403)
      .json({ error: "Webhook token invalid or not configured" });
  const runId = z.string().parse(req.body.run_id);
  const a = list<AppRecord>("application").find((a) => a.tfRunId === runId);
  if (!a) return res.status(404).json({ error: "Unknown run" });
  const run = await tinyfish.getRun(runId);
  if (once(`run-webhook:${runId}:${run.status}`))
    event(a.userId, "webhook", "Authoritative run update", {
      runId,
      status: run.status,
    });
  res.json({ ok: true });
});
app.post("/api/webhooks/monitor", async (req, res) => {
  if (!webhookAllowed(req))
    return res
      .status(403)
      .json({ error: "Webhook token invalid or not configured" });
  const monitorId = req.body.fetch_monitor_id || req.body.search_monitor_id;
  const subscribers = list<any>("source").filter(
    (s) =>
      s.tfMonitorId === monitorId &&
      s.status === "active" &&
      s.policy !== "blocked",
  );
  if (!subscribers.length)
    return res.status(404).json({ error: "Unknown or inactive monitor" });
  const eventId = z
    .string()
    .min(1)
    .parse(req.body.id || req.body.request_id);
  for (const s of subscribers) {
    const owner = (
      db
        .prepare("SELECT user_id FROM records WHERE kind='source' AND id=?")
        .get(s.id) as any
    ).user_id;
    if (once(`monitor-webhook:${monitorId}:${eventId}:${owner}`))
      await processMonitor(owner, s.id, req.body);
  }
  res.json({ ok: true });
});
registerDemo(app);
app.use(
  (
    error: any,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    const status =
      error instanceof z.ZodError
        ? 400
        : error.status ||
          (/not found/i.test(error.message)
            ? 404
            : /changed|ready|approved|current state|out of date/i.test(
                  error.message,
                )
              ? 409
              : 400);
    res.status(status >= 400 && status < 600 ? status : 500).json({
      error:
        error instanceof z.ZodError
          ? error.errors
              .map((e: any) => `${e.path.join(".")}: ${e.message}`)
              .join("; ")
          : error.message || "Unexpected server error",
    });
  },
);
