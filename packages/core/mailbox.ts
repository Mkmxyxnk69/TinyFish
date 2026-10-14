import type { AppRecord, Listing } from "./schemas.js";

export type MailMessage = {
  id?: string | null;
  threadId?: string | null;
  internalDate?: string | null;
  labelIds?: string[] | null;
  snippet?: string | null;
  payload?: any;
};

function decode(value: string | undefined) {
  return value ? Buffer.from(value, "base64url").toString("utf8") : "";
}

function unquote(text: string) {
  return text
    .split(
      /\n(?:On [^\n]{0,300}wrote:|[-_]{2,}\s*(?:Original Message|Forwarded message)\s*[-_]{2,})/i,
    )[0]
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n")
    .trim();
}

function htmlText(html: string) {
  return html
    .replace(/<(script|style|blockquote)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]*class=["'][^"']*gmail_quote[^"']*["'][^>]*>[\s\S]*$/i, "")
    .replace(/<\s*(?:br\b[^>]*|\/(?:p|div|li|h[1-6]))\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_match, code: string) => {
      const value =
        code[0].toLowerCase() === "x"
          ? parseInt(code.slice(1), 16)
          : Number(code);
      return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : "";
    })
    .replace(
      /&(amp|lt|gt|quot|apos|nbsp);/gi,
      (_match, name: string) =>
        ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " })[
          name.toLowerCase()
        ] || " ",
    );
}

export function messageText(part: any): string {
  if (!part || part.filename) return ""; // Never classify attachment contents.
  if (part.mimeType === "text/plain") return decode(part.body?.data);
  if (part.mimeType === "text/html") return htmlText(decode(part.body?.data));
  const parts: any[] = part.parts || [];
  if (part.mimeType === "multipart/alternative") {
    const plain = parts.find(
      (child) => child.mimeType === "text/plain" && !child.filename,
    );
    if (plain) return messageText(plain);
  }
  return parts.map(messageText).filter(Boolean).join("\n");
}

export function normalizeMessage(message: MailMessage) {
  const headers: Array<{ name?: string; value?: string }> =
    message.payload?.headers || [];
  const header = (name: string) =>
    headers.find((h) => h.name?.toLowerCase() === name)?.value || "";
  const timestamp = Number(message.internalDate);
  if (!message.id || !Number.isFinite(timestamp) || timestamp <= 0) return null;
  if (!Number.isFinite(new Date(timestamp).getTime())) return null;
  return {
    id: message.id,
    threadId: message.threadId || "",
    subject: header("subject"),
    from: header("from"),
    text: unquote(messageText(message.payload) || message.snippet || "").slice(
      0,
      50000,
    ),
    receivedAt: new Date(timestamp).toISOString(),
    timestamp,
    labels: message.labelIds || [],
  };
}
export type NormalizedMessage = NonNullable<
  ReturnType<typeof normalizeMessage>
>;
export type MailApplication = AppRecord & { listing: Listing };
const applicationStart = (a: AppRecord) =>
  Date.parse(a.submissionStartedAt || a.submittedAt || "");

function senderDomain(from: string) {
  return from
    .match(/(?:<|\s|^)[^\s<>@]+@([a-z0-9.-]+)(?:>|\s|$)/i)?.[1]
    ?.toLowerCase();
}

export function matchMessage(
  message: NormalizedMessage,
  applications: MailApplication[],
  mailboxAddress: string,
) {
  if (
    message.labels.some((label) =>
      ["SENT", "DRAFT", "SPAM", "TRASH"].includes(label),
    )
  )
    return null;
  const address = message.from.match(/[^\s<>]+@[^\s<>]+/)?.[0]?.toLowerCase();
  if (address === mailboxAddress.toLowerCase()) return null;
  const candidates = applications.filter(
    (a) => a.submittedAt && message.timestamp >= applicationStart(a),
  );
  const threads = candidates.filter(
    (a) => a.receipt?.threadId && a.receipt.threadId === message.threadId,
  );
  if (threads.length) return threads.length === 1 ? threads[0] : null;
  const domain = senderDomain(message.from);
  if (!domain || !domain.includes(".")) return null;
  const content = `${message.subject}\n${message.text}`.toLowerCase();
  const matches = candidates.filter((a) => {
    const domains = [
      a.listing.url,
      a.listing.applyUrl,
      a.package?.recipient
        ? `https://${a.package.recipient.split("@")[1]}`
        : undefined,
    ]
      .filter((s): s is string => !!s)
      .map((url) => new URL(url).hostname.replace(/^www\./, "").toLowerCase());
    const senderMatches = domains.some(
      (host) =>
        domain === host ||
        domain.endsWith(`.${host}`) ||
        host.endsWith(`.${domain}`),
    );
    return (
      senderMatches &&
      content.includes(a.listing.title.toLowerCase()) &&
      content.includes(a.listing.company.toLowerCase())
    );
  });
  return matches.length === 1 ? matches[0] : null;
}

export function mailboxQuery(application: MailApplication) {
  const quote = (text: string) => `"${text.replace(/["\\\r\n]/g, " ").trim()}"`;
  // Epoch seconds avoid Gmail's calendar-date/PST search interpretation.
  return `after:${Math.floor(applicationStart(application) / 1000)} {${quote(application.listing.company)} ${quote(application.listing.title)}} -in:spam -in:trash`;
}
