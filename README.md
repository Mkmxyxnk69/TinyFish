# Internship Autopilot

A working local internship workspace with a durable agent workflow and TinyFish web integrations. It follows the supplied architecture and implementation plan, with explicitly separate **demo** and **live** modes.

## Start the application

Requires **Node.js 24+** and npm. The local database uses Node's built-in SQLite API.

```bash
npm ci
cp .env.example .env
npm run browser:install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The worker runs on `127.0.0.1:8000`. Both services must remain running for background jobs, source schedules, mailbox polling, and reminders.

For a production build on a persistent Node host:

```bash
npm run build
npm start
```

The Next.js frontend can be hosted separately, but the worker needs a persistent process, access to the durable `DATA_DIR`, and an appropriate `WORKER_URL`. This repository has not been deployed to an external host.

## Demo walkthrough

1. Click **Explore the demo**. Each demo session gets its own sample candidate and application history.
2. Click **Find internships**. Six controlled listings are matched against that profile.
3. Shortlist a role and click **Prepare application**.
4. Answer the motivation question and student eligibility question. Facts the agent cannot establish are left for the user.
5. Click **Save changes and verify**. A real local Chromium browser fills the two-step employer form, attaches the generated PDF, and selects the radio answer.
6. Review the answers, documents, actual browser screenshot, and verification result.
7. Click **Approve & submit**. The controlled employer records a receipt; the worker captures confirmation evidence and closes the session.
8. A clearly labeled simulated interview reply appears in **Responses**, with an in-app notification.
9. Inspect **Agent activity** to see the task history and audit trail.

Demo listings, model reasoning, company briefs, email delivery, and employer replies are stand-ins. Browser interaction, uploaded PDF bytes, verification, approval checks, persistent storage, jobs, and controlled form submission are real. Demo mode does not send external applications, messages, or phone calls by default.

## Live TinyFish configuration

Edit `.env`, then restart the services:

```dotenv
APP_MODE=live
TINYFISH_API_KEY=your_key
GEMINI_API_KEYS=first_verified_key,second_verified_key
GEMINI_MODEL=gemini-3.5-flash-lite
GEMINI_CLASSIFICATION_MODEL=gemini-3.5-flash-lite
```

Do not place credentials in frontend code or commit `.env`.

Live mode requires TinyFish for web work and Gemini for structured extraction and reasoning. Missing credentials and provider failures become visible errors; they never cause a silent switch to demo results.

`GEMINI_MODEL` selects the model for planning, extraction, matching, form answers, and verification. `GEMINI_CLASSIFICATION_MODEL` independently selects the reply classifier. Keys in `GEMINI_API_KEYS` rotate per task; duplicates are removed. Rejected credentials are disabled for the worker lifetime, with at most three authentication attempts per task. HTTP 429 triggers a model-wide cooldown and does not retry the same task using another key. Google applies [rate limits per project](https://ai.google.dev/gemini-api/docs/rate-limits), so multiple keys in one project share quota.

Tasks use Gemini's [structured JSON output](https://ai.google.dev/gemini-api/docs/generate-content/structured-output), with independent checks for completion, JSON syntax, required properties, types, and enums. Existing evidence, profile, and employer-message checks remain in place. Live classification retains messages for retry when the provider is unavailable; keyword classification applies only to simulated demo replies.

To validate a supplied key CSV and populate only working keys, run:

```bash
python3 scripts/configure-gemini-keys.py /absolute/path/to/keys.csv gemini-3.5-flash-lite
```

The script makes a small structured generation for each distinct key, writes a secret-free report to `data/gemini-key-verification.json`, and updates `.env` with file permissions `0600` when at least one succeeds. Failed keys are excluded. If none succeeds, existing configuration is preserved and the script exits with an error. Never paste the CSV contents or `.env` into logs or chat.

### Verify the integration

```bash
# Read-only Search and Fetch checks
npm run verify:tinyfish

# Also verify read-only Agent and Browser tasks; these can use wallet funds
npm run verify:tinyfish -- --agent --browser

# Verify the currently configured Gemini key and model
npm run verify:gemini

# Bounded discovery → extraction → matching, with isolated synthetic profile data
npm run verify:live-discovery
```

The command writes `data/tinyfish-verification.json` after live requests. Search and Fetch can also be probed from **Profile & settings → Test TinyFish connection**. These probes do not submit an application.

TinyFish Search and Fetch passed live verification with the supplied key. Read-only Agent execution, remote CDP navigation, and PDF buffer upload with byte-hash read-back also passed live checks. Monitor and Research remain unverified. All 40 Gemini key candidates in the supplied CSV failed generation (25 reported leaked, 14 invalid or restricted, one suspended project); no failed key was added to the pool. A subsequently supplied Gemini key passed structured generation and reply classification with `gemini-3.5-flash-lite`. A bounded live discovery test passed Gemini planning, TinyFish Search/Fetch, grounded extraction, and matching for one real listing; two other pages failed evidence checks. Full employer-form and messaging acceptance remains separate. The local worker is now running in live mode; sign in and complete your own candidate profile before preparing applications.

### Supported live workflow

- A supervisor plans bounded queries. TinyFish Search fans them out; Fetch reads candidate postings.
- Gemini extracts structured facts. Exact source quotes are checked; ungrounded fields are rejected or nulled.
- Matching applies deterministic constraints first, then validates Gemini's requirement evidence and profile references.
- TinyFish Agent maps public application forms in read-only mode and reports login, CAPTCHA, access, or closure blockers.
- TinyFish Browser creates an isolated remote session. Playwright fills known values, uploads document buffers, and reads values back independently.
- Newly observed required fields cause another user-input step rather than invented answers.
- Review is bound to a package hash. Submission is revalidated, then a single final action is attempted. Missing confirmation produces an uncertain outcome that must be reconciled.
- Remote Agent streams handle fragmented CRLF/UTF-8 data and release the HTTP stream on completion. A disconnected stream recovers by polling the same `run_id`.

Generic form support is bounded: labeled inputs, selects, radio groups, checkboxes, files, and recognizable Next/Submit buttons. Site-specific widgets, CAPTCHA, MFA, and unsupported navigation need manual intervention or a dedicated adapter. Remote PDF buffer upload passed against a controlled in-memory form in a TinyFish session. Three real employer forms and the full remote application workflow remain unverified.

## Browser session cleanup

Remote browser leases are saved before CDP connection or navigation. If either fails, the worker attempts to end the provider session. Failed cleanup creates bounded, durable retry jobs instead of leaving only a log message; startup restores their scheduling. Confirmed application receipts remain confirmed even if teardown needs a retry. These paths have mocked-provider regression coverage; normal remote-session deletion passed during the live probes; failed-cleanup recovery paths remain covered by mocks.

After cleanup retries are exhausted, the server operator can retry a tracked lease in live mode:

```bash
npm run cleanup:browser -- <session-id>
```

This command requires the TinyFish key and refuses untracked sessions. It terminates a browser session; it does not submit or resend an application.

## Sources and ongoing monitoring

Add a public careers page or search topic under **Sources**. Policies separate discovery-only, form preparation, and blocked sources. LinkedIn form preparation is disabled.

- Identical monitor subscriptions share a TinyFish Monitor.
- A public HTTPS `APP_URL` and `WEBHOOK_SECRET` enable authenticated callbacks.
- For local operation without a public callback, remote schedules are paused and the worker runs the Monitor on its cron schedule, processing the run-now response directly.
- Page links are diffed; topic results use explicit result positions. Backlogs are retained when a run discovers more than one extraction batch.
- Topic schedules are validated to avoid intervals below thirty minutes.
- Pausing a subscription does not pause another user's active subscription.

For callbacks:

```dotenv
APP_URL=https://your-public-app.example
WEBHOOK_SECRET=a_long_random_value
```

Routes: `/api/webhooks/monitor` and `/api/webhooks/run`. Run callbacks are checked against an authoritative TinyFish run. Monitor callbacks require the secret and a known active subscription.

The controlled employer lives under `/demo`; it is local by default. A remote TinyFish browser cannot reach localhost. Expose a controlled employer on a public URL before conducting a live TinyFish spike; local Chromium is not proof of remote Browser behavior.

## Gmail, Google login, and portal tracking

Configure `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI`. Register the callback URL with Google. Use a testing-mode OAuth consent screen and approved test users while developing.

Google sign-in requests identity scopes. **Connect Gmail** separately requests readonly and send scopes for mailbox tracking and reviewed email applications. OAuth state is bound to the browser session. Provider tokens are encrypted at rest.

The worker polls connected mailboxes on the configured interval. It fetches known application threads directly, so replies do not need to repeat a company name. Other messages require a unique sender-domain, company, and role match. Ambiguous messages, sent mail, drafts, spam, and trash are not assigned to an application.

Search results are paginated in bounded batches with a saved cursor. Inbound messages awaiting classification are encrypted and retained before the cursor advances; failed classification can therefore retry without losing a reply. HTML-only messages are supported, quoted older messages and attachment contents are excluded from classification, and older confirmations cannot overwrite a newer employer outcome. Synchronization uses the provider's received timestamp and records partial failures rather than hiding them. These behaviors have provider-shaped local regression tests; an actual Gmail account remains unverified.

Pending messages, pagination cursors, and duplicate detection are scoped to the connected mailbox. Reconnecting a different account cannot process the previous account's pending replies. Token refresh preserves the stored refresh token and cannot restore a disconnected account or overwrite a replacement connection.

The implementation follows the documented [Gmail search semantics](https://developers.google.com/workspace/gmail/api/guides/filtering) and [thread retrieval API](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.threads/get).

Website applications, invited email applications, and cold outreach have distinct states. Outreach sent does not count as a submitted application. Every email destination and package requires review before sending.

For private portal checks, create an employer browser profile in Settings, open the sign-in browser, and save the state. Profiles are mapped to the authenticated application user. Configure the application's status URL and select your saved profile. Submitted applications with portal configuration are checked every six hours until a terminal employer outcome.

An optional `/api/auth/supabase` endpoint exchanges a verified Supabase user token for a local application session. This is an authentication integration; it does not make Supabase the data store. The default UI uses local or Google sign-in.

## Notifications

In-app notifications always work. Email and voice delivery require provider credentials and explicit opt-in in Profile settings.

```dotenv
RESEND_API_KEY=your_key
MAIL_FROM=your_verified_sender
TWILIO_ACCOUNT_SID=your_sid
TWILIO_AUTH_TOKEN=your_token
TWILIO_FROM_NUMBER=your_number
```

Deadline reminders run at three days, one day, and one hour. Submitted or discarded applications cancel reminders. Voice calls respect the user's timezone and quiet hours and are capped at three call attempts per local day. Provider failures and missing configuration remain visible in notification delivery records. Twilio trial restrictions still apply.

External email and phone notifications are suppressed in demo mode, even after opt-in. No real email, phone call, or OAuth connection has been verified in this build because credentials were deferred.

## Persistence and security boundaries

- SQLite records persist users, profiles, opportunities, matches, applications, jobs, events, source backlogs, notifications, and audit entries.
- Jobs are claimed transactionally. Interrupted read/preparation work can resume; interrupted external actions are marked uncertain rather than repeated automatically.
- Candidate documents and OAuth/browser setup credentials use AES-256-GCM encryption. Protect and back up `data/.encryption-key` with the data directory.
- User sessions use HTTP-only cookies; passwords are salted scrypt hashes. Ownership checks apply to application and document access.
- Source text and employer messages are treated as untrusted data.
- Screenshots and CDP connection information remain server-side or accessible only to the owning user.

The deployment currently uses **local SQLite and encrypted local files**, rather than the plan's Supabase Postgres/Storage. This provides durable local operation, but is not a horizontally scaled cloud deployment or managed key service.

## Verification commands

```bash
npm run typecheck
npm test
npm run test:e2e
npm run build
npm audit
```

Unit/API tests cover TinyFish wire shapes, partial Fetch failures, SSE fragmentation and recovery, schema conversion, missing credentials, grounding, eligibility, upload read-back, document ownership/encryption, cron schedules, monitor deduplication, OAuth/webhook access boundaries, and approval state.

The browser tests cover the entire controlled workflow, stale approval rejection, release/replay of a browser session, prevention of repeated approval, reply detection, persistent login, and a mobile-width check. A separate dashboard fixture verifies that scheduled background research does not disable new discovery. Test results are evidence for the controlled target and supplied UI states; they do not verify arbitrary employer sites.

## Backup walkthrough

Run `npm run record:demo` to record the asserted controlled journey to `artifacts/controlled-demo.webm`. The accompanying JSON manifest identifies its demo scope. This recording uses fixtures and local Chromium; it does not verify live providers. See [DEMO_WALKTHROUGH.md](DEMO_WALKTHROUGH.md) for reproduction and presentation instructions.

## Repository layout

```text
apps/web/              Next.js dashboard and review UI
apps/worker/           Authenticated HTTP API and persistent worker
apps/demo-target/      Controlled careers page and employer form
packages/core/         TinyFish adapters, intelligence, storage, browser,
                       documents, notifications, scheduling, and orchestration
scripts/               Live TinyFish verification, cleanup, demo recording
tests/unit/            Contract, logic, and API boundary tests
tests/e2e/             Full browser journey
data/                  Ignored runtime state and encrypted documents
```

See [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) for scope, evidence, limitations, and additions relative to the supplied documents.
