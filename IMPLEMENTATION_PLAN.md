# Internship Autopilot — Implementation Plan (TinyFish Hackathon)

Source: `Internship Autopilot System Design.pdf` + TinyFish docs (docs.tinyfish.ai, llms-full.txt, checked 2026-10-13).

Goal for the hackathon: one end-to-end live demo of **discover → extract → match → prepare application → verify → human submit → reply detected → phone alert**, with TinyFish doing all web work.

---

## 1. Reality check: design doc vs. actual TinyFish capabilities

These change the design. Resolve them before writing code.

| Design doc assumes | TinyFish reality | Plan change |
|---|---|---|
| Research backs every match reason | Research API is beta: **5 runs/day, 5 concurrent per account**, standard mode takes 2–10 min | Research only on demand ("Company brief" button on shortlisted cards), cached per company. Match reasons come from Fetch text + Claude. |
| Agent fills the form, stops before Submit, user submits later | An Agent run's browser ends when the run ends. Filled state is lost. | Agent **maps** the form (read-only). **Browser API + Playwright** fills it in a long-lived session (`timeout_seconds` up to 86400) that waits for the user's Submit click. |
| Agent uploads the resume | No file-upload mechanism documented for Agent runs | Resume upload via Playwright `setInputFiles` (buffer) in the Browser session. **Spike this first.** |
| Monitor gives us new listings | Page Monitor webhook returns the **full page content** of each scheduled run, not a diff. Topic Monitor returns `new_result_positions`. Max **50 Monitors per account**. "Run now" does **not** fire the webhook. | We diff link sets ourselves. Monitors are shared per source/topic, never per user. Demo "Refresh" button uses the run-now response body directly. |
| Fetch returns structured JSON fields | Fetch `format: "json"` is a document tree, not fields | Fetch markdown → Claude structured output → Listing record. Agent with `output_schema` only as fallback. |
| Orchestrator gives LLM TinyFish tools over MCP | Hosted MCP (`https://agent.tinyfish.ai/mcp`) uses OAuth 2.1 tied to an interactive login; no Monitor/Research tools listed | Backend pipeline calls the **SDK directly**. Agentic pieces use Claude tool use with our own wrappers around the SDK. MCP is for our dev loop (Claude Code) and an optional chat panel. |
| Vault per user (1Password/Bitwarden) | Vault connections and Browser Context Profiles belong to **the TinyFish account (API key)**, not to our end users | MVP: target public application forms that need no login. Multi-user vault is post-hackathon. |
| Agents handle CAPTCHAs by handing off | TinyFish **cannot solve CAPTCHAs**; `COMPLETED` status can still mean "blocked" | Every result checked for failure signals (`captcha`, `blocked`, `access denied`, `unable to`); maps to `needs_user_input` with deep link. |
| Mako model | Marketed on tinyfish.ai, not in API docs | Ignore for MVP. |

---

## 2. Architecture

```
                        ┌──────────────────────────── Next.js app (Vercel or local) ────────────────────────────┐
 User ──── browser ───▶ │ Onboarding · Dashboard tabs · Review screen · Settings    API routes   Webhook receivers │
                        └───────────────┬───────────────────────────────────────────────────────────┬────────────┘
                                        │ Postgres (Supabase): profiles, listings, applications,  │ /api/webhooks/monitor
                                        │ jobs, events, audit_log   Storage: resumes, screenshots    │ /api/webhooks/run
                        ┌───────────────▼───────────────────────────────────────────────────────────▼────────────┐
                        │ Worker (Node, long-running: Railway/Fly/laptop+cloudflared)                            │
                        │  Orchestrator loop: jobs table, state machine, retries, rate limits, dedupe            │
                        │  discovery · extract · match · map_form · fill_form · verify · submit · inbox · notify │
                        └──┬──────────┬──────────┬───────────┬──────────┬─────────────┬───────────┬──────────────┘
                           │          │          │           │          │             │           │
                     TF Monitor  TF Search  TF Fetch    TF Agent   TF Browser    Claude API   Gmail API · Twilio · Resend
```

**Stack (one language end to end):**

- **TypeScript** monorepo: `apps/web` (Next.js 15, Tailwind, shadcn/ui), `apps/worker` (Node 22), `packages/core` (schemas, TinyFish wrappers, prompts).
- **Supabase**: Postgres + Auth (Google OAuth) + Storage (resumes, screenshots, encrypted at rest).
- **TinyFish**: `@tiny-fish/sdk` (reads `TINYFISH_API_KEY`), plus raw REST for Monitor.
- **Playwright** (`playwright-core`, `chromium.connectOverCDP(cdp_url)`) for Browser API sessions.
- **Claude API**: `claude-sonnet-5-5` for extraction, matching, form answering, verification; `claude-haiku-5-5` for email classification. Structured JSON outputs via tool schemas.
- **Zod** schemas shared between Claude output validation, DB writes, and TinyFish `output_schema` generation.
- Job queue: a `jobs` table polled by the worker (`SELECT … FOR UPDATE SKIP LOCKED`). No Redis needed at hackathon scale.
- Public URL for webhooks during dev: `cloudflared tunnel` → worker or Next.js.

Why a separate worker: Browser sessions stay open while the user reviews, SSE streams last 15–60 s, and Research runs last minutes. Serverless functions can't hold those.

---

## 3. TinyFish usage per agent

### 3.1 Monitoring agent — discovery

**Sources (shared across users):**

- **Page Monitors** (`type: "fetch"`) on 5–10 listing pages: Internshala category pages, company career pages, Greenhouse/Lever/Ashby boards (`boards.greenhouse.io/<co>`, `jobs.lever.co/<co>`, `jobs.ashbyhq.com/<co>`).
  ```json
  POST https://agent.tinyfish.ai/v1/monitors
  { "type": "fetch", "name": "acme-careers",
    "config": { "url": "https://jobs.lever.co/acme", "format": "markdown", "links": true },
    "schedule_cron": "CRON_TZ=Asia/Kolkata 0 */3 * * *",
    "purpose": "A new internship or intern posting appears",
    "webhook_url": "https://<public>/api/webhooks/monitor" }
  ```
  Webhook handler: take `results[0].links`, filter to posting-like URLs (per-site regex + Claude classifier for unknown sites), diff against `source_links` table, emit `listing_discovered` events for new ones.
- **Topic Monitors** (`type: "search"`) per interest bucket (deduped across users, e.g. `"software engineering internship 2027 Bengaluru"`), `recency_minutes: 1440`, `result_limit: 10`, every 6 h. Use `new_result_positions` to pick new URLs.
- **Search API** at onboarding and on "Find more" to build a backlog immediately (Monitors only capture a baseline at creation):
  `GET https://api.search.tinyfish.ai?query=…&location=IN&include_domains=internshala.com,greenhouse.io,lever.co,ashbyhq.com&recency_minutes=10080&purpose=Find open internship postings`
- Per-site policy table: `monitor_only | prepare_forms | blocked`. LinkedIn and anything prohibiting automation = `blocked` or `monitor_only`.

**Dedupe:** canonical key = `slug(company) + slug(normalized title) + slug(location) + term`. Unique index on it. URL also unique.

Limits: Search 30 req/min, 12k/day free. Monitor $0.005/run, 50 per account, topic schedules ≥ 30 min apart.

### 3.2 Extraction agent

1. Batch new URLs, 10 per Fetch call:
   ```json
   POST https://api.fetch.tinyfish.ai
   { "urls": [...], "format": "markdown", "links": true, "iframe_links": true,
     "ttl": 3600, "per_url_timeout_ms": 45000,
     "purpose": "Extract internship posting details: role, stipend, deadline, eligibility, skills, apply link" }
   ```
   Client timeout 150 s. Per-URL failures arrive in `errors[]`.
2. If the text is thin (< 500 chars) or the content lives in an iframe, re-fetch the `iframe_links` URL. If still thin, fall back to **Agent** `run` with `output_schema` = Listing schema (costs steps, so last resort).
3. Claude (Sonnet) extracts the Listing JSON from the markdown. Every field is `nullable`, and each non-null field carries `evidence` (a verbatim quote). The worker checks each quote is a substring of the raw text and nulls the field if not.
4. Store the record plus `raw_markdown`, `final_url`, `fetched_at`, and `content_hash`.

Limits: 150 URLs/min, 1,000 URLs/day free.

### 3.3 Summarizer and match agent

1. **Deterministic filters first:** deadline passed → `expired`; location not in preferences and not remote → down-rank; stipend below minimum → flag; graduation year outside eligibility → flag.
2. **Claude match** (per user × listing, only for listings passing a cheap keyword/embedding pre-filter):
   ```ts
   { score: 0-100, summary: string /* 2-3 lines */,
     requirements: [{ text, kind: "must"|"nice", status: "met"|"missing"|"unclear",
                      listing_quote: string, profile_field: string | null }],
     eligibility_flags: string[] }
   ```
   Verify `listing_quote` substring-matches the raw text, and `profile_field` resolves to a real path in the profile JSON. Drop any claim that fails.
3. **Research (on demand only):** "Company brief" button → `POST /v1/automation/run-research-async` `{ query: "<company> internship program, team, culture, interview process", mode: "standard" }`, poll `GET /v1/research-run/{id}`, cache by company for 30 days. Respect 5/day.
4. Analysis tab aggregates in SQL: counts by status, deadlines this week, top missing skills, best matches, funnel.

### 3.4 Form-filling agent (three phases)

**Phase A — Map (TinyFish Agent, read-only, live preview).** Triggered by "Prepare application".
`POST /v1/automation/run-sse`, `browser_profile: "stealth"`, `proxy_config: { enabled: true, country_code: <nearest supported> }`.

Goal:
```
Open this internship posting. If there is an "Apply" button, click it to reach the application form.
Do NOT type into any field, do NOT upload anything, and do NOT click Submit.
Scroll through the entire form, including every step of a multi-step form, using only "Next" buttons
that do not submit. For every input, return its visible label, input type, whether it is required,
the available options for selects/radios/checkboxes, and the section it is in.
Return the final URL of the form page.
If you see a CAPTCHA, a login wall, or "access denied", stop and set blocker accordingly.
```
`output_schema`:
```json
{ "type": "object",
  "properties": {
    "form_url": { "type": "string" },
    "blocker": { "type": "string", "enum": ["none", "captcha", "login_required", "blocked", "closed"] },
    "steps": { "type": "integer" },
    "fields": { "type": "array", "items": { "type": "object",
      "properties": {
        "label": { "type": "string" },
        "type": { "type": "string", "enum": ["text","email","tel","url","textarea","select","radio","checkbox","file","date","number","other"] },
        "required": { "type": "boolean" },
        "options": { "type": "array", "items": { "type": "string" } },
        "section": { "type": "string", "nullable": true } },
      "required": ["label", "type", "required"] } } },
  "required": ["form_url", "blocker", "fields"] }
```
Forward the `STREAMING_URL` event to the UI and show it in an iframe. This is the demo moment.

**Phase B — Answer (Claude, no browser).** For each field: `{ value, source: "profile.<path>" | "resume" | "user", confidence }`. Essays, unknown questions, and anything not derivable from the profile get `needs_user_input`. Never invent. The UI shows a short questionnaire for the gaps, and the answers are saved back to the profile for reuse.

**Phase C — Fill (Browser API + Playwright).**
```ts
const s = await tf.browser.sessions.create({ url: formUrl, timeout_seconds: 3600 });
const browser = await chromium.connectOverCDP(s.cdp_url);
const page = browser.contexts()[0].pages()[0];
// per field: page.getByLabel(label, { exact: false }).fill(value) / selectOption / check
// resume:   page.locator('input[type=file]').setInputFiles({ name, mimeType: 'application/pdf', buffer })
// screenshot: page.screenshot({ fullPage: true }) → Supabase Storage
// read-back: evaluate all inputs → { label, value, filesCount } (ground truth for the verifier)
```
- Keep the session open. Store `session_id`, `cdp_url`, and `base_url` on the application row. Status becomes `awaiting_approval`.
- If label locators fail for a field, try an LLM-chosen selector from a DOM snapshot. If that fails, mark the field `manual` and show it on the review screen.
- Session expiry fallback: on approval, if the session is dead, re-create it and replay the approved values (deterministic, from the stored field list), re-verify, then submit.

### 3.5 Verifier agent (independent)

Inputs: the **DOM read-back** (not the filler's claims), the profile, the Phase A field list, and the listing requirements.

- **Deterministic checks:** every required field is non-empty; email, phone, name, and links equal the profile values exactly; the resume input has `filesCount >= 1`; dates parse; GPA matches the profile.
- **Claude checks:** eligibility answers are truthful against the profile, essay answers came from the user, and no skills appear that the profile lacks.
- Output: `{ errors[], warnings[], filled[], skipped[] }`. Errors send the form back to Phase C once (max 2 loops), then to the user.
- **Liveness:** re-Fetch the posting with `ttl: 0` before Phase A and again right before submit. If it is closed, mark `expired`.

### 3.6 Submit (human click)

The Review screen shows the screenshot, field table, verifier report, and three buttons: **Submit / Edit / Discard**.
Submit → worker reconnects over CDP → clicks the submit button → waits for navigation or a confirmation message → takes a confirmation screenshot → `submitted` → closes the session (`DELETE https://api.browser.tinyfish.ai/{session_id}`). Each step is written to `audit_log`.

### 3.7 Inbox tracker (not TinyFish)

Gmail API with `gmail.readonly` (consent screen in Testing mode, with team emails as test users). Poll every 10 min per user with a narrow query per application: `from:(@acme.com OR @greenhouse.io OR @lever.co) after:<submitted_at> {subject terms}`. Haiku classifies each match as `confirmation | assessment | interview | rejection | offer | info_request`. The result updates the application and triggers a notification.

### 3.8 Notifications

- In-app (Supabase Realtime), email (Resend), and **Twilio Voice** (`calls.create` with TwiML `<Say>`).
- Escalation scheduler job every 5 min: deadline ≤ 3 days and not submitted → email/push; deadline today, T−1h, and no action → call. Quiet hours, a cap of 3 calls per day, and auto-cancel when the application is submitted.
- A Twilio trial account can only call verified numbers. Verify team phones before the demo.

---

## 4. Data model (Postgres)

```
profiles(user_id PK, name, email, phone, education jsonb, skills text[], links jsonb,
         interests text[], preferences jsonb, alerts jsonb, answers_bank jsonb, resume_path)
sources(id, kind: page_monitor|topic_monitor|search, url_or_query, tf_monitor_id, policy, last_run_at, health)
source_links(source_id, url, first_seen_at)               -- for Page Monitor diffing
listings(id, canonical_key UNIQUE, url UNIQUE, source_id, title, company, location, mode,
         stipend_inr, duration, start_date, deadline, eligibility, skills_must text[],
         skills_nice text[], apply_url, description, evidence jsonb, raw_markdown,
         content_hash, status, fetched_at)
matches(user_id, listing_id, score, summary, requirements jsonb, flags text[],
        feedback: relevant|not_relevant|null, PK(user_id, listing_id))
applications(id, user_id, listing_id, status, form_map jsonb, answers jsonb, readback jsonb,
             verification jsonb, screenshot_path, confirm_screenshot_path, tf_run_id,
             browser_session_id, cdp_url, submitted_at, UNIQUE(user_id, listing_id))
email_events(id, application_id, gmail_msg_id UNIQUE, kind, subject, received_at, snippet)
company_briefs(company PK, research_run_id, report, citations jsonb, created_at)
jobs(id, kind, payload jsonb, status, attempts, run_after, locked_at, last_error)
notifications(id, user_id, kind, channel, sent_at, acknowledged_at)
audit_log(id, user_id, actor, action, target, data jsonb, at)
```

Application states: `shortlisted → mapping → needs_user_input → filling → verifying → awaiting_approval → submitting → submitted → response_received`. Side states: `expired`, `discarded`, `failed`, `blocked`.

---

## 5. Build plan (hackathon timeline)

Ordered so there is something demo-able at the end of each block. Assumes ~2 days with 3–4 people; scale it to the real event length.

**Block 0 — Spikes (first 3 h, do in parallel). These decide whether the design holds.**
1. Browser API + `connectOverCDP` + `setInputFiles` with a buffer on a Greenhouse-style form. Confirm the file actually attaches.
2. Agent `run-sse` form-mapping goal + `output_schema` on 3 real forms (Greenhouse, Lever, Internshala). Measure steps and cost.
3. A Page Monitor with a webhook to a cloudflared URL. Confirm the payload has `links`.
4. Fetch + Claude extraction on 10 real postings. Check how often fields come back null.

**Block 1 — Foundation + discovery (Day 1 AM)**
- Repo scaffold, Supabase schema, Google login, onboarding form, resume upload (parse resume → profile prefill with Claude).
- Worker: jobs loop and TinyFish client wrappers with retry, 429 backoff, and failure-signal check.
- Search backlog + 5 Page Monitors + 3 Topic Monitors. Webhook → link diff → `listing_discovered` jobs.
- Extraction pipeline → `listings`. Dashboard **New** + **All** tabs with cards (title, company, deadline countdown, link).

**Block 2 — Intelligence (Day 1 PM)**
- Deterministic filters + Claude match with quote validation → score and reasons on cards.
- **Deadlines**, **Shortlisted**, and **Analysis** tabs (funnel, skill gaps, deadlines this week).
- "Company brief" via Research (async, cached).
- Email notification for new high matches.

**Block 3 — Applications (Day 2 AM)**
- **Build a controlled demo target**: a small "Acme Careers" page (deployed with the app) with a realistic multi-step form including file upload, select, eligibility radio, and one essay question. This keeps the live demo independent of third-party CAPTCHAs.
- Phase A map (with live-preview iframe) → Phase B answers + gap questionnaire → Phase C fill → Verifier → Review screen → Submit → **Applied** tab.
- Then run it against one real automation-friendly form in prepare-only mode (stop at the review screen).

**Block 4 — Tracking + alerts (Day 2 PM)**
- Gmail OAuth + poller + classifier → **Responses** tab.
- Twilio call for `deadline_today` and `response_received`. Escalation job.
- Demo seed: Acme's form handler sends an "interview invite" email to the demo Gmail account a minute after submission.

**Block 5 — Polish (last 3 h)**
- Audit log view, relevant/not-relevant buttons, empty and error states, the demo script, and a recorded backup video.

**Cut list if time runs short (cut in this order):** Research briefs → Topic Monitors → Analysis charts → Gmail (fake with a manual "simulate reply" button) → Twilio. Never cut the Map → Fill → Verify → Approve flow; it is the core TinyFish showcase.

---

## 6. Demo script (≈4 min)

1. Log in, upload resume → profile auto-filled → set preferences.
2. Click "Refresh sources" (Monitor run-now + Search) → new cards stream in with match scores and cited reasons.
3. Open the top match → "Company brief" (a pre-warmed Research result).
4. "Prepare application" → **live TinyFish browser iframe** maps the form → one essay question is asked of the user → Playwright fills the form → verifier report shows 1 warning.
5. Review the screenshot + field table → **Submit** → confirmation screenshot → Applied tab.
6. Interview-invite email arrives → Responses tab updates → **the presenter's phone rings** (Twilio).

---

## 7. Cost budget (new account has $8 free; check `GET /v1/wallet` for exact contract rates)

| Item | Unit price | Hackathon usage | Est. |
|---|---|---|---|
| Search, Fetch | free (12k req / 1k URLs per day) | hundreds | $0 |
| Page/Topic Monitors | $0.005 per run | 8 monitors × every 3 h × 2 days | ~$0.65 |
| Agent (form mapping, fallbacks) | $0.016 per step | ~40 runs × ~25 steps | ~$16 |
| Browser sessions | $0.002 per minute | ~40 sessions × 20 min | ~$1.60 |
| Research | wallet-billed, beta | ≤ 5 per day | check wallet |

The Agent budget is the risk. Cap `agent_config.max_duration_seconds` at 180, cache form maps per `form_url` (re-mapping is unnecessary for the same form), and top up the wallet or ask the organizers for hackathon credits.

---

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| `setInputFiles` over CDP fails on the remote browser | Spike in Block 0. Fallback: Playwright `page.evaluate` to build a `File` from base64 and dispatch a `change` event, or mark the resume as a manual step. |
| Real sites serve CAPTCHAs | Stealth + proxy; detect and route to `blocked` with a deep link. The demo uses the controlled Acme form. |
| Browser session expires during review | `timeout_seconds: 3600`, and a deterministic replay of approved values on submit. |
| Monitor webhook unreachable (local dev) | cloudflared tunnel; also poll `GET /v1/monitors/{id}` + run-now as backup. |
| LLM hallucinated match claims | Substring-validated quotes and profile-path validation; unverifiable claims are dropped. |
| Agent `COMPLETED` but actually failed | `blocker` field in the schema, plus a failure-signal scan of the result. |
| Rate limits (Search 30/min, Fetch 150 URLs/min, Agent concurrency) | Token-bucket per API in the worker; SDK retries 429s. |
| Gmail restricted scope | Testing-mode OAuth with test users only; production needs Google verification. |
| ToS / ethics | Per-site policy table, no CAPTCHA bypass, truthful-only answers, audit log, manual submit always. |

---

## 9. Repo layout

```
apps/
  web/                 Next.js: app/(dashboard)/[tab], app/review/[id], app/api/webhooks/{monitor,run}
  worker/              index.ts (job loop), jobs/{discover,extract,match,map,fill,verify,submit,inbox,notify,escalate}.ts
  demo-target/         "Acme Careers" static site + form handler (sends the seed reply email)
packages/
  core/
    tinyfish/          search.ts, fetch.ts, monitor.ts, agent.ts, browser.ts, research.ts, failure-signals.ts
    llm/               claude.ts, prompts/{extract,match,answer,verify,classify}.ts
    schemas/           listing.ts, match.ts, formMap.ts (Zod → JSON Schema → TinyFish output_schema subset)
    db/                supabase client, queries, migrations/
```

Note for `schemas/`: TinyFish `output_schema` rejects `additionalProperties`, `oneOf`, `const`, and type arrays. Use `nullable: true` and `anyOf`. Write a converter that strips these from Zod-generated JSON Schema.

---

## 10. Open decisions for the team

1. Event length and team size, to set the block timings.
2. Target region: the INR/Bengaluru examples suggest India (Internshala, Indian company career pages). TinyFish Agent proxy countries are limited to US, GB, CA, DE, FR, JP, and AU; Browser API accepts any ISO country.
3. Whether to request higher Research limits or Agent credits from the TinyFish organizers.
