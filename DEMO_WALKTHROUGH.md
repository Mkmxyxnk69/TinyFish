# Controlled demo walkthrough

This backup shows the local application workflow. Discovery uses fixtures, browser automation uses local Chromium, and the employer reply is simulated. It does not prove live TinyFish, Gmail, or Twilio operation.

## Watch or recreate the backup

Run `npm run record:demo` from the project root. It runs the asserted end-to-end journey and publishes `artifacts/controlled-demo.webm` only after the journey passes. `artifacts/controlled-demo.json` records its scope and timestamp. A failed rerun removes the previous published recording rather than leaving a stale success artifact.

Install Chromium first with `npm run browser:install`. Keep any existing local server in demo mode; otherwise stop it before recording. Playwright starts the local worker and frontend when they are absent. The recording creates an isolated demo account and a controlled employer receipt; it does not send email or place calls.

## Present the workflow

1. Open `http://localhost:3000` and select **Explore the demo**. Explain the demo label before presenting results.
2. Select **Find internships**. Show match reasons, stipend, deadline, and the source link on an opportunity card.
3. Shortlist **Backend Engineering Intern** and select **Prepare application**.
4. Answer the interest question and select the truthful student-status answer. Save and verify.
5. Review the actual form screenshot, values, uploaded PDF, and independent verification before approving.
6. Approve submission. Show the controlled employer's `ACME-` reference and receipt evidence.
7. Open **Responses** and point out the **SIMULATED REPLY** label on the interview invitation.
8. Open **Agent activity** to show the recorded workflow and submission verification.

The automated backup also checks stale-approval rejection, duplicate-approval rejection, and session replay before submission.

## Live acceptance remains separate

Follow the remaining acceptance steps in [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) after configuring credentials. A remote TinyFish browser needs a publicly reachable controlled employer URL. Real employer submissions and external messages require review of the exact destination and application package. The local recording must not be presented as a recording of those live checks.
