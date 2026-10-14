import { google } from "googleapis";
import twilio from "twilio";
import { config } from "./config.js";
import { tokenConnection, rotateTokens, encrypt, decrypt } from "./auth.js";
import {
  get,
  list,
  put,
  id,
  now,
  audit,
  once,
  db,
  transaction,
  remove,
} from "./db.js";
import {
  normalizeMessage,
  matchMessage,
  mailboxQuery,
  type MailApplication,
  type MailMessage,
  type NormalizedMessage,
} from "./mailbox.js";
import { readDocument } from "./documents.js";
import { classifyEmail, classifyEmployerMessage } from "./intelligence.js";
import type { AppRecord, Profile } from "./schemas.js";
export function googleClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI ||
      `${config.appUrl}/api/auth/google/callback`,
  );
}
export function connectedGmail(userId: string) {
  const connection = tokenConnection(userId),
    tokens = connection?.tokens;
  if (!tokens?.access_token && !tokens?.refresh_token)
    throw new Error("Connect Gmail in Settings first");
  const client = googleClient();
  client.setCredentials(tokens);
  client.on("tokens", (next) =>
    rotateTokens(userId, next, connection!.generation),
  );
  return google.gmail({ version: "v1", auth: client });
}
function safeHeader(s: string) {
  return s.replace(/[\r\n]/g, " ").trim();
}
export async function sendApplicationEmail(a: AppRecord, profile: Profile) {
  const recipient = a.package?.recipient;
  if (!recipient || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient))
    throw new Error("A valid reviewed email recipient is required");
  const gmail = connectedGmail(a.userId),
    doc = readDocument(a.package!.resumeId, a.userId),
    boundary = `autopilot-${a.id}`;
  const subject = safeHeader(
    a.package!.emailSubject || "Internship application",
  );
  const raw = [
    `To: ${safeHeader(recipient)}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(a.package!.coverLetter).toString("base64"),
    `--${boundary}`,
    `Content-Type: application/pdf; name="resume.pdf"`,
    'Content-Disposition: attachment; filename="resume.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    doc.buffer.toString("base64"),
    `--${boundary}--`,
  ].join("\r\n");
  const response = await gmail.users.messages.send(
    {
      userId: "me",
      requestBody: { raw: Buffer.from(raw).toString("base64url") },
    },
    { retry: false, timeout: 30000 },
  );
  if (!response.data.id)
    throw new Error("Gmail did not return a message receipt");
  return {
    messageId: response.data.id,
    threadId: response.data.threadId,
    recipient,
    at: now(),
  };
}
export function quietHours(profile: Profile, date = new Date()) {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hourCycle: "h23",
      timeZone: profile.alerts.timezone,
    }).format(date),
  );
  const { quietStart: s, quietEnd: e } = profile.alerts;
  return s === e
    ? false
    : s < e
      ? hour >= s && hour < e
      : hour >= s || hour < e;
}
export async function notify(
  userId: string,
  kind: string,
  message: string,
  target: string,
  key: string,
  urgent = false,
) {
  if (!once(`notify:${userId}:${key}`)) return;
  const p = get<Profile>("profile", userId, userId)!;
  const notification = put("notification", id(), userId, {
    kind,
    message,
    target,
    createdAt: now(),
    read: false,
    channels: [{ channel: "in_app", status: "delivered" }] as any[],
  });
  if (p.alerts.email) {
    if (config.mode === "demo")
      notification.channels.push({
        channel: "email",
        status: "suppressed_demo",
      });
    else if (process.env.RESEND_API_KEY && process.env.MAIL_FROM) {
      try {
        const r = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
            "Content-Type": "application/json",
            "Idempotency-Key": `notification-${notification.id}`,
          },
          body: JSON.stringify({
            from: process.env.MAIL_FROM,
            to: p.email,
            subject: "Internship Autopilot update",
            text: message,
          }),
          signal: AbortSignal.timeout(20000),
        });
        if (!r.ok) throw new Error(`Email provider HTTP ${r.status}`);
        notification.channels.push({ channel: "email", status: "sent" });
      } catch (e) {
        notification.channels.push({
          channel: "email",
          status: "failed",
          error: (e as Error).message,
        });
      }
    } else
      notification.channels.push({
        channel: "email",
        status: "not_configured",
      });
  }
  if (urgent && p.alerts.voice && p.phone) {
    if (config.mode === "demo")
      notification.channels.push({
        channel: "voice",
        status: "suppressed_demo",
      });
    else {
      const localDay = (date: Date) =>
        new Intl.DateTimeFormat("en-CA", {
          timeZone: p.alerts.timezone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(date);
      const daily = list<any>("notification", userId).filter(
        (n) =>
          localDay(new Date(n.createdAt)) === localDay(new Date()) &&
          n.channels.some(
            (c: any) => c.channel === "voice" && c.status === "sent",
          ),
      ).length;
      if (quietHours(p) || daily >= 3)
        notification.channels.push({
          channel: "voice",
          status: "suppressed",
          reason: "Quiet hours or daily cap",
        });
      else if (
        process.env.TWILIO_ACCOUNT_SID &&
        process.env.TWILIO_AUTH_TOKEN &&
        process.env.TWILIO_FROM_NUMBER
      ) {
        const slot = [1, 2, 3].find((n) =>
          once(`voice_quota:${userId}:${localDay(new Date())}:${n}`),
        );
        if (!slot) {
          notification.channels.push({
            channel: "voice",
            status: "suppressed",
            reason: "Daily call-attempt quota",
          });
          put("notification", notification.id, userId, notification);
          return notification;
        }
        try {
          const client = twilio(
            process.env.TWILIO_ACCOUNT_SID,
            process.env.TWILIO_AUTH_TOKEN,
            { autoRetry: false },
          );
          const text = message.replace(/[<>&]/g, " ");
          const call = await client.calls.create({
            to: p.phone,
            from: process.env.TWILIO_FROM_NUMBER,
            twiml: `<Response><Say>${text}</Say></Response>`,
          });
          notification.channels.push({
            channel: "voice",
            status: "sent",
            reference: call.sid,
          });
        } catch (e) {
          notification.channels.push({
            channel: "voice",
            status: "failed",
            error: (e as Error).message,
          });
        }
      } else
        notification.channels.push({
          channel: "voice",
          status: "not_configured",
        });
    }
  }
  put("notification", notification.id, userId, notification);
  return notification;
}
export async function ingestEmail(
  userId: string,
  a: AppRecord,
  message: {
    id: string;
    subject: string;
    text: string;
    from: string;
    provenance: string;
    receivedAt?: string;
    threadId?: string;
    mailboxAddress?: string;
  },
) {
  if (message.provenance !== config.mode || a.provenance !== config.mode)
    throw new Error(
      "Employer message must match the application's execution mode",
    );
  if (
    db
      .prepare("SELECT key FROM seen_events WHERE key=?")
      .get(emailKey(userId, message.id, message.mailboxAddress))
  )
    return;
  const kind =
    message.provenance === "live"
      ? await classifyEmployerMessage({
          subject: message.subject,
          text: message.text,
        })
      : classifyEmail(`${message.subject}\n${message.text}`);
  const receivedAt = message.receivedAt || now();
  if (!Number.isFinite(Date.parse(receivedAt)))
    throw new Error("Invalid employer message timestamp");
  const record = transaction(() => {
    const current = get<AppRecord>("application", a.id, userId);
    if (!current || current.provenance !== config.mode)
      throw new Error("Application not found in this execution mode");
    if (!once(emailKey(userId, message.id, message.mailboxAddress))) return;
    const stored = put("email_event", id(), userId, {
      applicationId: a.id,
      ...message,
      providerMessageId: message.id,
      kind,
      receivedAt,
      suggestedAction:
        kind === "interview"
          ? "Review the invitation and confirm an available time."
          : kind === "assessment"
            ? "Check the assessment instructions and deadline."
            : kind === "offer"
              ? "Review the offer details before making a decision."
              : kind === "rejection"
                ? "Review feedback and continue with other opportunities."
                : "Review the message and provide any requested information.",
    });
    if (
      !current.employerStatusAt ||
      Date.parse(receivedAt) >= Date.parse(current.employerStatusAt)
    ) {
      current.employerStatus = kind;
      current.employerStatusAt = receivedAt;
    }
    current.updatedAt = now();
    current.lastCheckedAt = now();
    put("application", current.id, userId, current);
    audit(userId, "inbox", "employer_reply_detected", a.id, {
      messageId: message.id,
      kind,
      provenance: message.provenance,
    });
    return stored;
  });
  if (!record) return;
  await notify(
    userId,
    "response_received",
    `${kind === "interview" ? "Interview invitation" : kind.replace("_", " ")} received for your application.`,
    a.id,
    `email:${message.id}`,
    true,
  );
  return record;
}
function emailKey(userId: string, messageId: string, mailbox?: string) {
  return mailbox
    ? `email:${userId}:${mailbox.toLowerCase()}:${messageId}`
    : `email:${userId}:${messageId}`;
}
export async function pollGmail(
  userId: string,
  provided?: ReturnType<typeof connectedGmail>,
) {
  if (config.mode !== "live")
    throw new Error("Gmail synchronization requires live mode");
  const connection = provided ? undefined : tokenConnection(userId);
  const gmail = provided || connectedGmail(userId);
  const assertConnected = () => {
    if (!provided) {
      const latest = tokenConnection(userId);
      if (!latest || latest.generation !== connection?.generation)
        throw new Error(
          "Gmail was disconnected or replaced while synchronization was running",
        );
    }
  };
  const applications: MailApplication[] = list<AppRecord>("application", userId)
    .filter(
      (a) =>
        a.provenance === "live" && a.submittedAt && a.status !== "discarded",
    )
    .map((a) => ({ ...a, listing: get("listing", a.listingId) }))
    .filter((a) => a.listing);
  if (!applications.length)
    return { matched: 0, ambiguous: 0, read: 0, errors: [] };
  assertConnected();
  const profile = await gmail.users.getProfile(
    { userId: "me" },
    { timeout: 30000 },
  );
  if (!profile.data.emailAddress)
    throw new Error("Gmail profile returned no mailbox address");
  const mailboxAddress = profile.data.emailAddress.toLowerCase();
  const pendingKey = (messageId: string) =>
    `${userId}:${mailboxAddress}:${messageId}`;
  const collected = new Map<string, NormalizedMessage>(),
    errors: string[] = [];
  for (const pending of list<any>("mail_pending", userId)) {
    if (pending.mailboxAddress !== mailboxAddress) continue;
    try {
      const message = decrypt(pending.encrypted) as NormalizedMessage;
      collected.set(message.id, message);
    } catch (error) {
      errors.push(`Pending message ${pending.id}: ${(error as Error).message}`);
    }
  }
  const remember = (raw: MailMessage) => {
    const message = normalizeMessage(raw);
    if (!message) return;
    if (
      db
        .prepare("SELECT key FROM seen_events WHERE key=?")
        .get(emailKey(userId, message.id, mailboxAddress))
    )
      return;
    collected.set(message.id, message);
    if (matchMessage(message, applications, profile.data.emailAddress!))
      put("mail_pending", pendingKey(message.id), userId, {
        encrypted: encrypt(message),
        mailboxAddress,
      });
  };
  // Gmail search is message-scoped: fetch known threads directly even when a reply
  // omits both the company name and the original application subject.
  for (const threadId of new Set(
    applications.map((a) => a.receipt?.threadId).filter(Boolean),
  )) {
    try {
      assertConnected();
      const response = await gmail.users.threads.get(
        { userId: "me", id: threadId, format: "full" },
        { timeout: 30000 },
      );
      for (const message of response.data.messages || []) remember(message);
    } catch (error) {
      errors.push(`Thread ${threadId}: ${(error as Error).message}`);
    }
  }
  for (const application of applications) {
    const cursorId = application.id,
      baseQuery = mailboxQuery(application);
    const saved = get("mail_cursor", cursorId, userId);
    const continuing =
      saved?.baseQuery === baseQuery &&
      saved.mailboxAddress === mailboxAddress &&
      saved.nextPageToken;
    const query = continuing
      ? saved.query
      : `${baseQuery} before:${Math.ceil(Date.now() / 1000)}`;
    let pageToken: string | undefined = continuing
      ? saved.nextPageToken
      : undefined;
    try {
      for (let page = 0; page < 3; page++) {
        assertConnected();
        const response = await gmail.users.messages.list(
          { userId: "me", q: query, maxResults: 50, pageToken },
          { timeout: 30000 },
        );
        for (const item of response.data.messages || []) {
          if (!item.id || collected.has(item.id)) continue;
          assertConnected();
          const message = await gmail.users.messages.get(
            { userId: "me", id: item.id, format: "full" },
            { timeout: 30000 },
          );
          remember(message.data);
        }
        pageToken = response.data.nextPageToken || undefined;
        put("mail_cursor", cursorId, userId, {
          baseQuery,
          query,
          nextPageToken: pageToken || null,
          checkedAt: now(),
          mailboxAddress,
        });
        if (!pageToken) break;
      }
    } catch (error) {
      if ((error as any).code === 400)
        put("mail_cursor", cursorId, userId, {
          baseQuery,
          nextPageToken: null,
        });
      errors.push(`Application ${application.id}: ${(error as Error).message}`);
    }
  }
  const messages = [...collected.values()].sort(
    (a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id),
  );
  let matched = 0,
    ambiguous = 0;
  for (const message of messages) {
    const application = matchMessage(
      message,
      applications,
      profile.data.emailAddress,
    );
    if (!application) {
      ambiguous++;
      remove("mail_pending", pendingKey(message.id), userId);
      continue;
    }
    try {
      assertConnected();
      const record = await ingestEmail(userId, application, {
        ...message,
        provenance: "live",
        mailboxAddress,
      });
      if (record) matched++;
      remove("mail_pending", pendingKey(message.id), userId);
    } catch (error) {
      errors.push(`Message ${message.id}: ${(error as Error).message}`);
    }
  }
  const report = {
    matched,
    ambiguous,
    read: messages.length,
    errors,
    checkedAt: now(),
  };
  put("mail_sync", userId, userId, report);
  if (errors.length)
    throw new Error(
      `Mailbox sync partially completed: ${errors.join("; ").slice(0, 1500)}`,
    );
  return report;
}
