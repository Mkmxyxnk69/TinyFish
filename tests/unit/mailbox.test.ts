import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { pollGmail, ingestEmail } from "../../packages/core/integrations.js";
import {
  normalizeMessage,
  matchMessage,
  messageText,
  mailboxQuery,
  type MailApplication,
} from "../../packages/core/mailbox.js";
import { classifyEmail } from "../../packages/core/intelligence.js";
import {
  db,
  get,
  list,
  put,
  id,
  transaction,
  once,
} from "../../packages/core/db.js";
import { config } from "../../packages/core/config.js";
import {
  storeTokens,
  tokenConnection,
  rotateTokens,
  loadTokens,
} from "../../packages/core/auth.js";
import { remove } from "../../packages/core/db.js";
import { ProfileSchema, type AppRecord } from "../../packages/core/schemas.js";

const base = Date.parse("2026-10-14T10:00:00.000Z");
const at = (seconds: number) => new Date(base + seconds * 1000).toISOString();
const encoded = (text: string) => Buffer.from(text).toString("base64url");
function message(
  messageId: string,
  seconds: number,
  text = "We would like to invite you to an interview.",
  options: any = {},
) {
  return {
    id: messageId,
    internalDate: String(base + seconds * 1000),
    threadId: options.threadId || "unknown-thread",
    labelIds: options.labels || ["INBOX"],
    payload: {
      mimeType: options.html ? "text/html" : "text/plain",
      headers: [
        {
          name: "Subject",
          value: options.subject || "Acme Labs Backend Engineering Intern",
        },
        {
          name: "From",
          value: options.from || "Recruiter <recruiting@acme.example>",
        },
      ],
      body: { data: encoded(text) },
    },
    ...options.extra,
  };
}
function fixture(withThread = false): {
  userId: string;
  application: MailApplication;
} {
  const userId = id(),
    listingId = id(),
    applicationId = id();
  put(
    "profile",
    userId,
    userId,
    ProfileSchema.parse({
      name: "Mailbox candidate",
      email: "candidate@example.test",
    }),
  );
  const listing = put("listing", listingId, "", {
    title: "Backend Engineering Intern",
    company: "Acme Labs",
    url: "https://acme.example/careers/backend",
    applyUrl: "https://jobs.lever.co/acme/backend",
    provenance: "live",
  });
  const a: AppRecord = {
    id: applicationId,
    userId,
    listingId,
    route: "web",
    provenance: "live",
    status: "submitted",
    submittedAt: at(10),
    createdAt: at(0),
    updatedAt: at(10),
    receipt: withThread ? { threadId: "known-thread" } : {},
  };
  put("application", applicationId, userId, a);
  return { userId, application: { ...a, listing: listing as any } };
}
function mailbox() {
  return {
    users: {
      getProfile: vi.fn().mockResolvedValue({
        data: { emailAddress: "candidate@example.test" },
      }),
      threads: { get: vi.fn().mockResolvedValue({ data: { messages: [] } }) },
      messages: {
        list: vi.fn().mockResolvedValue({ data: { messages: [] } }),
        get: vi.fn(),
      },
    },
  };
}

let previousMode: string, previousKeys: string[];
beforeEach(() => {
  previousMode = config.mode;
  previousKeys = config.geminiKeys;
  config.mode = "live";
  config.geminiKeys = ["mailbox-test-key"];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    if (
      !String(url).startsWith(
        "https://generativelanguage.googleapis.com/v1beta/models/",
      )
    )
      throw new Error("Unexpected provider request in mailbox tests");
    const request = JSON.parse(String(options?.body));
    const input = JSON.parse(request.contents[0].parts[0].text);
    return Response.json({
      candidates: [
        {
          finishReason: "STOP",
          content: {
            parts: [
              {
                text: JSON.stringify({
                  kind: classifyEmail(`${input.subject}\n${input.text}`),
                }),
              },
            ],
          },
        },
      ],
    });
  });
});
afterEach(() => {
  config.mode = previousMode;
  config.geminiKeys = previousKeys;
  vi.restoreAllMocks();
});

describe("mailbox parsing and application association", () => {
  it("preserves refresh credentials when rotating an access token", () => {
    const userId = id();
    storeTokens(userId, { access_token: "old", refresh_token: "keep" });
    const connection = tokenConnection(userId)!;
    expect(
      rotateTokens(userId, { access_token: "new" }, connection.generation),
    ).toBe(true);
    expect(loadTokens(userId)).toEqual({
      access_token: "new",
      refresh_token: "keep",
    });
  });
  it("does not resurrect a disconnected mailbox when an old refresh completes", () => {
    const userId = id();
    storeTokens(userId, { access_token: "old" });
    const generation = tokenConnection(userId)!.generation;
    remove("credential", userId, userId);
    expect(rotateTokens(userId, { access_token: "late" }, generation)).toBe(
      false,
    );
    expect(loadTokens(userId)).toBeUndefined();
  });
  it("does not overwrite a replacement mailbox connection with stale tokens", () => {
    const userId = id();
    storeTokens(userId, { access_token: "first-account" });
    const generation = tokenConnection(userId)!.generation;
    storeTokens(userId, { access_token: "replacement-account" });
    expect(rotateTokens(userId, { access_token: "stale" }, generation)).toBe(
      false,
    );
    expect(loadTokens(userId).access_token).toBe("replacement-account");
  });
  it("reads HTML-only messages and excludes quoted older offers", () => {
    const html =
      "<p>Unfortunately, we will not proceed with your application.</p><blockquote><p>We are pleased to offer you a role.</p></blockquote>";
    const normalized = normalizeMessage(
      message("html", 20, html, { html: true }),
    )!;
    expect(normalized.text).toContain("Unfortunately");
    expect(normalized.text).not.toContain("pleased");
    expect(classifyEmail(normalized.text)).toBe("rejection");
  });
  it("prefers plain text alternatives and does not classify attachment text", () => {
    const text = messageText({
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            {
              mimeType: "text/plain",
              body: { data: encoded("New interview invitation") },
            },
            {
              mimeType: "text/html",
              body: { data: encoded("<p>Duplicate HTML</p>") },
            },
          ],
        },
        {
          filename: "old-letter.txt",
          mimeType: "text/plain",
          body: { data: encoded("Employment offer") },
        },
      ],
    });
    expect(text).toBe("New interview invitation");
  });
  it("does not mistake a declined offer for an offer", () => {
    expect(classifyEmail("Unfortunately, we cannot make an offer.")).toBe(
      "rejection",
    );
  });
  it("does not arbitrarily assign one message to two identical role applications", () => {
    const { application } = fixture();
    const duplicate = { ...application, id: id() };
    expect(
      matchMessage(
        normalizeMessage(message("ambiguous", 20))!,
        [application, duplicate],
        "candidate@example.test",
      ),
    ).toBeNull();
  });
  it("ignores outgoing mail even if its thread matches", () => {
    const { application } = fixture(true);
    expect(
      matchMessage(
        normalizeMessage(
          message("sent", 20, "Employment offer", {
            threadId: "known-thread",
            labels: ["SENT"],
          }),
        )!,
        [application],
        "candidate@example.test",
      ),
    ).toBeNull();
  });
  it("accepts immediate auto-replies received before the send HTTP response returned", () => {
    const { application } = fixture(true);
    application.submissionStartedAt = at(5);
    application.submittedAt = at(10);
    expect(
      matchMessage(
        normalizeMessage(
          message("fast", 7, "Application received", {
            threadId: "known-thread",
          }),
        )!,
        [application],
        "candidate@example.test",
      )?.id,
    ).toBe(application.id);
    expect(mailboxQuery(application)).toContain(
      `after:${Math.floor((base + 5000) / 1000)}`,
    );
  });
});

describe("complete mailbox synchronization using a provider-shaped test client", () => {
  it("rejects simulated messages for live applications before classification or persistence", async () => {
    const { userId, application } = fixture();
    await expect(
      ingestEmail(userId, application, {
        id: "wrong-mode",
        subject: "Interview",
        text: "Interview",
        from: "recruiter@acme.example",
        provenance: "demo",
      }),
    ).rejects.toThrow("execution mode");
    expect(fetch).not.toHaveBeenCalled();
    expect(list("email_event", userId)).toHaveLength(0);
  });
  it("retains live mail for retry when the LLM key is missing", async () => {
    const { userId } = fixture(),
      client = mailbox();
    config.geminiKeys = [];
    client.users.messages.list.mockResolvedValueOnce({
      data: { messages: [{ id: "missing-key" }] },
    });
    client.users.messages.get.mockResolvedValue({
      data: message("missing-key", 20),
    });
    await expect(pollGmail(userId, client as any)).rejects.toThrow(
      "partially completed",
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(list("email_event", userId)).toHaveLength(0);
    expect(list("mail_pending", userId)).toHaveLength(1);
    config.geminiKeys = ["mailbox-test-key"];
    expect((await pollGmail(userId, client as any)).matched).toBe(1);
    expect(list("mail_pending", userId)).toHaveLength(0);
  });
  it("keeps pending messages isolated when the connected mailbox changes", async () => {
    const { userId } = fixture(),
      client = mailbox();
    client.users.messages.list.mockResolvedValueOnce({
      data: { messages: [{ id: "account-pending" }] },
    });
    client.users.messages.get.mockResolvedValue({
      data: message("account-pending", 20),
    });
    vi.mocked(fetch).mockRejectedValueOnce(new Error("Provider unavailable"));
    await expect(pollGmail(userId, client as any)).rejects.toThrow(
      "partially completed",
    );
    client.users.getProfile.mockResolvedValue({
      data: { emailAddress: "other@example.test" },
    });
    expect((await pollGmail(userId, client as any)).matched).toBe(0);
    expect(list("mail_pending", userId)).toHaveLength(1);
    client.users.getProfile.mockResolvedValue({
      data: { emailAddress: "candidate@example.test" },
    });
    expect((await pollGmail(userId, client as any)).matched).toBe(1);
    expect(list("mail_pending", userId)).toHaveLength(0);
  });
  it("scopes message deduplication to the mailbox as well as the application user", async () => {
    const { userId, application } = fixture();
    const common = {
      id: "shared-provider-id",
      subject: "Interview invitation",
      text: "We invite you to an interview.",
      from: "recruiter@acme.example",
      provenance: "live",
      receivedAt: at(20),
    };
    await ingestEmail(userId, application, {
      ...common,
      mailboxAddress: "first@example.test",
    });
    await ingestEmail(userId, application, {
      ...common,
      mailboxAddress: "second@example.test",
    });
    expect(list("email_event", userId)).toHaveLength(2);
  });
  it("retrieves known threads directly when replies omit the company name", async () => {
    const { userId } = fixture(true),
      client = mailbox();
    client.users.threads.get.mockResolvedValue({
      data: {
        messages: [
          message("thread-reply", 20, "Can you join us for an interview?", {
            threadId: "known-thread",
            subject: "Next steps",
            from: "Team <person@different-domain.example>",
          }),
        ],
      },
    });
    expect((await pollGmail(userId, client as any)).matched).toBe(1);
    expect(client.users.threads.get).toHaveBeenCalledWith(
      { userId: "me", id: "known-thread", format: "full" },
      expect.anything(),
    );
    expect(list<any>("email_event", userId)[0].kind).toBe("interview");
  });
  it("paginates and prevents older confirmations from overwriting a newer interview", async () => {
    const { userId, application } = fixture(),
      client = mailbox();
    client.users.messages.list
      .mockResolvedValueOnce({
        data: { messages: [{ id: "new" }], nextPageToken: "page2" },
      })
      .mockResolvedValueOnce({ data: { messages: [{ id: "old" }] } });
    client.users.messages.get.mockImplementation(
      async ({ id: messageId }: any) => ({
        data:
          messageId === "new"
            ? message("new", 30)
            : message("old", 20, "We have received your application."),
      }),
    );
    expect((await pollGmail(userId, client as any)).matched).toBe(2);
    expect(client.users.messages.list.mock.calls[1][0].pageToken).toBe("page2");
    expect(
      get<AppRecord>("application", application.id, userId)?.employerStatus,
    ).toBe("interview");
    await ingestEmail(userId, application, {
      id: "late-old",
      subject: "Application received",
      text: "We have received your application.",
      from: "recruiting@acme.example",
      provenance: "live",
      receivedAt: at(15),
    });
    expect(
      get<AppRecord>("application", application.id, userId)?.employerStatus,
    ).toBe("interview");
  });
  it("retains a page cursor when the bounded batch has more pages", async () => {
    const { userId, application } = fixture(),
      client = mailbox();
    let count = 0;
    client.users.messages.list.mockImplementation(async () => {
      count++;
      return {
        data: {
          messages: [{ id: `page-${count}` }],
          ...(count < 4 ? { nextPageToken: `p${count}` } : {}),
        },
      };
    });
    client.users.messages.get.mockImplementation(
      async ({ id: messageId }: any) => ({
        data: message(messageId, 20 + Number(messageId.slice(5))),
      }),
    );
    await pollGmail(userId, client as any);
    expect(client.users.messages.list).toHaveBeenCalledTimes(3);
    expect(get("mail_cursor", application.id, userId).nextPageToken).toBe("p3");
    await pollGmail(userId, client as any);
    expect(client.users.messages.list.mock.calls[3][0].pageToken).toBe("p3");
    expect(list("email_event", userId)).toHaveLength(4);
    expect(get("mail_cursor", application.id, userId).nextPageToken).toBeNull();
  });
  it("retries failed classification from encrypted pending mail after the cursor advances", async () => {
    const { userId } = fixture(),
      client = mailbox();
    client.users.messages.list.mockResolvedValueOnce({
      data: { messages: [{ id: "retry" }] },
    });
    client.users.messages.get.mockResolvedValue({ data: message("retry", 20) });
    vi.mocked(fetch).mockRejectedValueOnce(new Error("Provider unavailable"));
    await expect(pollGmail(userId, client as any)).rejects.toThrow(
      "partially completed",
    );
    expect(list("email_event", userId)).toHaveLength(0);
    const pending = list<any>("mail_pending", userId);
    expect(pending).toHaveLength(1);
    expect(JSON.stringify(pending)).not.toContain("invite you");
    expect(
      db
        .prepare("SELECT key FROM seen_events WHERE key=?")
        .get(`email:${userId}:candidate@example.test:retry`),
    ).toBeUndefined();
    expect((await pollGmail(userId, client as any)).matched).toBe(1);
    expect(list("email_event", userId)).toHaveLength(1);
    expect(list("mail_pending", userId)).toHaveLength(0);
  });
  it("deduplicates processed replies and notifications across polls", async () => {
    const { userId } = fixture(true),
      client = mailbox();
    client.users.threads.get.mockResolvedValue({
      data: {
        messages: [
          message("same", 20, "Interview invitation", {
            threadId: "known-thread",
          }),
        ],
      },
    });
    await pollGmail(userId, client as any);
    expect((await pollGmail(userId, client as any)).matched).toBe(0);
    expect(list("email_event", userId)).toHaveLength(1);
    expect(list("notification", userId)).toHaveLength(1);
  });
  it("rolls back deduplication markers when a database transaction fails", () => {
    const key = `rollback:${id()}`;
    expect(() =>
      transaction(() => {
        once(key);
        throw new Error("write failed");
      }),
    ).toThrow("write failed");
    expect(once(key)).toBe(true);
  });
});
