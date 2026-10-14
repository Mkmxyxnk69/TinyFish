# Implementation Status

Status date: **14 October 2026**.

The local software and controlled end-to-end workflow work. **The full live-provider objective is not yet proven complete.** The supplied TinyFish key passed live Search and Fetch checks. The supplied Gemini CSV contained no usable key. A subsequently supplied key passed live structured generation and reply classification; a bounded real discovery → extraction → matching run also passed. Remaining provider acceptance checks are pending.

## Requirements Audit

| Requirement | Implemented | Verification / outstanding work |
|---|---|---|
| Candidate profile and onboarding | Registration/login, skills, projects, preferences, resume upload, reviewable extraction | Local persistence and ownership tested; Gemini resume inference requires credentials. |
| Cross-site internship discovery | Supervisor query planning, TinyFish Search, source scan, URL import | A bounded live planning/Search/Fetch/extraction/matching run passed with a synthetic profile and one real posting. |
| Posting extraction | Fetch batches, partial errors, iframe handling, Agent fallback, Gemini fields with quote checks | One real posting passed grounded extraction; two candidate pages were rejected for missing or ungrounded evidence. |
| Deduplication and matching | Canonical records, hard constraints, requirement evidence, per-user matches | Local matching and eligibility tests pass; one real extracted posting passed the live Gemini matching handler with a synthetic profile. |
| Dashboard | Opportunities, shortlists, deadlines, applications, responses, analysis, sources, settings, activity | Browser tests exercise the journey and mobile width. Pay comparison is restricted to comparable INR periods; FX conversion is absent. |
| Tailored application documents | Candidate-grounded resume PDF, role-specific letter, cover-letter PDF | Actual generated resume bytes are uploaded and verified locally. Standard templates are used. |
| Map → Answer → Fill → Verify → Approve | Specialist phases, gap questions, adaptive field observation, browser read-back, independent live verifier | Full controlled two-step form passes, including select/radio controls and file upload. |
| TinyFish Agent and Browser | Read-only mapping, schema contract, SSE recovery, remote CDP sessions, file buffers | Read-only Agent, remote CDP navigation, PDF buffer upload, and normal cleanup passed live probes. Full form mapping, three real-form spikes, and the complete remote application workflow remain unverified. |
| Approval and submission | Package/profile hashes, single action attempt, receipt evidence, uncertain-outcome reconciliation | Stale approval rejection, released-session replay, and duplicate-approval rejection pass in the browser test. |
| Email applications and cold outreach | Separate routes, published-contact research, reviewed recipients/packages, Gmail send | Demo delivery is simulated; actual mail is unverified. |
| Reply and portal tracking | Gmail OAuth/poller, conservative association, classification, next-action suggestions, user-owned browser profiles, six-hour portal checks | Demo reply and in-app alert pass; actual OAuth, mailbox, and authenticated portal behavior are unverified. |
| Ongoing Page/Topic monitoring | Shared monitors, cron validation, link diffing, topic result positions, backlogs, authenticated callbacks, local run-now fallback | Schedule/diff logic tested; native Monitor operations and callbacks are unverified. |
| Reminders and phone alerts | In-app, Resend, Twilio adapters; opt-in, quiet hours, daily cap | In-app flow and quiet-hours logic tested; no real email or call was sent. |
| Company research | Async TinyFish Research and company cache | Code implemented; native Research access is unverified. Demo briefs are illustrative. |
| Durable execution and audit | Transactional job claim, restart recovery, event deduplication, task/audit views | Local claims and deduplication tested; real external-action crash timing remains unverified. |
| User access and storage | Local sessions, Google OAuth, optional Supabase token exchange; SQLite and encrypted files/credentials | Auth, origin, ownership, encryption, and approval API tests pass. Cloud storage/database deployment is absent. |
| Build and operation | TypeScript worker build, optimized Next.js build, persistent local services | Builds and type checks pass. No external production deployment was performed. |

## Verified Evidence

- **65 unit/API tests passed**, covering TinyFish contracts, byte-fragmented CRLF/UTF-8 SSE and stream completion, remote browser lease ownership/cleanup/retry scheduling, no-credential behavior, grounding, eligibility, browser read-back, encrypted documents, cron schedules, monitor deduplication, approval/webhook boundaries, and execution-mode isolation. Mailbox fixtures exercise direct thread retrieval, pagination/cursor continuation, HTML-only messages, ambiguous association, chronological status projection, duplicate suppression, atomic processing, encrypted retries after classification failure, mailbox isolation, and token-refresh races after disconnection or account replacement. Gemini contract tests cover configured model routing, round-robin rotation, rejected-key failover, rate-limit cooldown, and structured JSON output, rejection of incomplete or invalid output, and explicit failure without keyword fallback in live mode.
- **3 browser tests passed**: the full controlled journey with actual Chromium and a PDF upload, persistent login/mobile layout, and a dashboard fixture that keeps discovery available while background research is pending. The main journey releases the browser before approval to exercise replay.
- `npm run build` passed for both the worker and Next.js frontend.
- `npm run record:demo` passed the asserted controlled journey and produced `artifacts/controlled-demo.webm`, with a manifest that explicitly identifies fixtures, local Chromium, and simulated replies. The video decodes as VP9 at 1440 × 1100. See [DEMO_WALKTHROUGH.md](DEMO_WALKTHROUGH.md) for reproduction and presentation instructions.
- The patched dependency installation reported **zero known vulnerabilities**. This is a dependency check, not a complete security assessment.
- `npm run verify:gemini` passed structured generation and synthetic employer-message classification using the new key.
- `npm run verify:live-discovery` passed real Gemini planning → TinyFish Search/Fetch → source-grounded extraction → matching for one real ShopBack posting. Two other candidate URLs were rejected by evidence checks. The candidate profile and database were isolated test data; no application was created or submitted. Reports are in `data/gemini-verification.json` and `data/live-discovery-verification.json`.
- `npm run verify:tinyfish` passed real Search and Fetch calls with the supplied key. Read-only Agent and remote Browser navigation also passed. A second Browser probe uploaded a 900-byte generated PDF to controlled DOM, then independently read filename, MIME type, size, and matching SHA-256 bytes. Monitor and Research remain unverified.
- All 40 distinct Gemini key candidates were tested with actual generation requests: 25 were reported leaked, 14 invalid or restricted, and one linked to a suspended project. No rejected key was installed. A later separately supplied key now populates the pool. A secret-free report is stored at `data/gemini-key-verification.json`.

The proven journey is: **discover → match → user answers → actual form fill and PDF upload → independent verification → approval → controlled receipt → simulated employer reply → in-app notification and audit history**.

## Stand-Ins and Architecture Changes

1. **SQLite and encrypted local files replace Supabase Postgres/Storage.** Local operation is durable, but managed cloud migrations, RLS, storage, and horizontal scaling are not implemented.
2. **Demo discovery and reasoning use controlled fixtures and a sample candidate.** Live mode makes separate TinyFish/Gemini calls and never silently substitutes demo output.
3. **Demo browser work uses local Chromium.** Forms, uploaded files, verification, and the controlled receipt are real; remote TinyFish Browser behavior is not thereby proven.
4. **Demo messages and employer replies are simulated.** No real email delivery or phone call is claimed.
5. **A custom persistent job/state orchestrator replaces LangGraph**, following the implementation plan's worker approach.
6. **TinyFish uses documented REST adapters**, rather than SDK-specific event shapes.
7. **Next.js was updated to a patched version.** The UI uses custom CSS rather than Tailwind/shadcn.
8. **Documents use a standard PDF template.** They do not preserve an uploaded resume's original layout, and arbitrary non-Latin text is not supported by the current standard-font generator.

## Additional Features Beyond the Documents

- Local password-based accounts and isolated demo accounts alongside the planned Google login.
- An explicit browser-session release button, extending the planned automatic expiry/replay behavior.
- An interactive uncertain-submission reconciliation screen, with evidence required before retrying.
- A self-service TinyFish connection probe and optional Agent/Browser verification CLI.
- An automatic local cron fallback that pauses the remote schedule when a public callback is unavailable.
- Demo-mode suppression of external notifications, even when delivery credentials and opt-in exist.
- Durable remote-browser cleanup retries and an operator CLI for retrying tracked failed leases.

## Continuation Audit

Gemini replaces Anthropic in every live reasoning task, including discovery planning, extraction, matching, resume parsing, semantic verification, and reply classification. The dashboard and environment template use Gemini settings. A process-local round-robin key pool supports bounded authentication failover, disables rejected keys, and respects model-wide rate-limit cooldowns. Native structured JSON is validated before use.

The supplied TinyFish key passed Search and Fetch. All initial CSV Gemini keys were rejected by actual generation calls. A later key supplied through `.env` passed live structured generation and synthetic-message classification with `gemini-3.5-flash-lite`. The bounded live discovery verifier passed one real posting after rejecting two pages for missing or ungrounded evidence. Read-only TinyFish Agent, Browser/CDP navigation, controlled PDF buffer upload, and normal session deletion subsequently passed. Monitor/Research, employer-form workflows, and external messaging remain unverified.

## Not Implemented or Not Yet Verified

- Live TinyFish Monitor, Research, portal traffic, and full employer-form preparation remain **unverified**. Search, Fetch, read-only Agent, Browser navigation, controlled remote upload, and normal teardown passed narrower live checks.
- Remote buffer upload passed on a controlled in-memory form. Three real employer forms and a complete real prepare-only workflow have not run.
- Actual Google/Gmail OAuth, email applications/replies, Resend notifications, and Twilio calls remain unverified.
- Production hosting, Supabase Postgres/Storage/RLS, and a full Supabase sign-in UI are not implemented.
- Arbitrary ATS widgets, CAPTCHA, MFA, and login-based application flows need human action or site-specific adapters. Public labeled forms are the initial supported application path.
- FX conversion, advanced resume layout preservation, automatic interview scheduling, automatic reply sending, and offer negotiation are not implemented.

## Remaining Acceptance Steps

1. TinyFish and one working Gemini key are installed. The verified reasoning/classification model is `gemini-3.5-flash-lite`; the local worker is now running in live mode for dashboard use.
2. Search/Fetch, Gemini generation/classification, bounded live discovery, read-only Agent/Browser, and controlled remote upload checks have passed. Broaden coverage with supported real postings and forms.
3. Expose the controlled employer publicly, set `PUBLIC_DEMO_URL`, import its public listing, and verify the remote workflow.
4. Test supported real forms in prepare-only mode; obtain explicit approval before a real submission.
5. Configure Google test users, connect Gmail, and verify a controlled thread.
6. Configure notification providers and opt in with a verified test destination.
7. Verify native Monitor callbacks or local run-now scheduling and an authenticated portal profile.
8. Implement and verify the chosen production data/hosting setup.

See [README.md](README.md) for setup, configuration, commands, and supported behavior. These remaining checks are not claims of completion.
