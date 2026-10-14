import { describe, it, expect, vi } from "vitest";
import {
  TinyFishClient,
  parseSSE,
  failureSignal,
} from "../../packages/core/tinyfish.js";
import { sanitizeOutputSchema } from "../../packages/core/schemas.js";
describe("TinyFish wire contracts", () => {
  it("parses CRLF frames and UTF-8 characters split across individual network bytes", async () => {
    const text =
      ': heartbeat\r\n\r\ndata: {"type":"STARTED","run_id":"split"}\r\n\r\ndata: {"type":\r\ndata: "COMPLETE","result":{"text":"café 🌱"}}\r\n\r\n';
    const bytes = new TextEncoder().encode(text),
      stream = new ReadableStream({
        start(controller) {
          for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
          controller.close();
        },
      });
    const events = [];
    for await (const item of parseSSE(new Response(stream))) events.push(item);
    expect(events.map((e) => e.type)).toEqual(["STARTED", "COMPLETE"]);
    expect(events[1].result.text).toBe("café 🌱");
  });
  it("returns on COMPLETE and releases an HTTP stream that remains open", async () => {
    const cancelled = vi.fn(),
      stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"type":"STARTED","run_id":"r-final"}\n\ndata: {"type":"COMPLETE","status":"COMPLETED","result":{"title":"Ready"}}\n\n',
            ),
          );
        },
        cancel: cancelled,
      });
    const transport = vi.fn().mockResolvedValue(new Response(stream));
    const result = await new TinyFishClient("fake-key", transport).agent(
      "https://example.com",
      "Read title",
      { type: "object" },
      () => {},
    );
    expect(result.result.title).toBe("Ready");
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("sends Search query and server-side authentication", async () => {
    const transport = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ results: [{ url: "https://example.com/job" }] }),
        ),
      );
    const client = new TinyFishClient("test-secret", transport);
    const r = await client.search("Python intern", {
      include_domains: "example.com",
    });
    expect(r.results).toHaveLength(1);
    expect(transport.mock.calls[0][0]).toContain("query=Python+intern");
    expect(transport.mock.calls[0][1].headers["X-API-Key"]).toBe("test-secret");
  });
  it("handles per-URL Fetch errors without dropping successful URLs", async () => {
    const transport = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [{ url: "https://a.example", text: "posting" }],
          errors: [{ url: "https://b.example", code: "timeout" }],
        }),
      ),
    );
    const r = await new TinyFishClient("key", transport).fetchUrls(
      ["https://a.example", "https://b.example"],
      true,
    );
    expect(r.results).toHaveLength(1);
    expect(r.errors).toHaveLength(1);
    expect(JSON.parse(transport.mock.calls[0][1].body).ttl).toBe(0);
  });
  it("refuses live requests without credentials", async () => {
    const transport = vi.fn();
    await expect(
      new TinyFishClient("", transport).search("intern"),
    ).rejects.toThrow("not configured");
    expect(transport).not.toHaveBeenCalled();
  });
  it("parses fragmented SSE including a trailing final frame", async () => {
    const chunks = [
      'data: {"type":"STAR',
      'TED","run_id":"r1"}\n\n:heartbeat\n\n',
      'data: {"type":"COMPLETE","status":"COMPLETED","result":{"text":"café"}}',
    ];
    const stream = new ReadableStream({
      start(c) {
        for (const text of chunks) c.enqueue(new TextEncoder().encode(text));
        c.close();
      },
    });
    const events = [];
    for await (const e of parseSSE(new Response(stream))) events.push(e);
    expect(events.map((e) => e.type)).toEqual(["STARTED", "COMPLETE"]);
    expect(events[1].result.text).toBe("café");
  });
  it("recovers a disconnected Agent stream through the same run ID", async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('data: {"type":"STARTED","run_id":"r1"}\n\n', {
          headers: { "Content-Type": "text/event-stream" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            run_id: "r1",
            status: "COMPLETED",
            result: { text: "verified" },
          }),
        ),
      );
    const events: any[] = [];
    const result = await new TinyFishClient("key", transport).agent(
      "https://example.com",
      "Read page",
      { type: "object" },
      (e) => events.push(e),
    );
    expect(result.result.text).toBe("verified");
    expect(transport.mock.calls[1][0]).toBe(
      "https://agent.tinyfish.ai/v1/runs/r1",
    );
    expect(
      transport.mock.calls.filter((call) => call[1].method === "POST"),
    ).toHaveLength(1);
  });
  it("does not repeat an action-creating request on a network timeout", async () => {
    const transport = vi.fn().mockRejectedValue(new Error("timeout"));
    await expect(
      new TinyFishClient("key", transport).createBrowser("https://example.com"),
    ).rejects.toThrow("not automatically repeated");
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("sends the documented Browser creation and termination payloads", async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            session_id: "s1",
            cdp_url: "wss://example.com",
            base_url: "https://example.com",
          }),
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const tf = new TinyFishClient("key", transport);
    await tf.createBrowser("https://example.com");
    await tf.deleteBrowser("s1");
    expect(JSON.parse(transport.mock.calls[0][1].body)).toEqual({
      url: "https://example.com",
      timeout_seconds: 3600,
    });
    expect(transport.mock.calls[1][0]).toBe(
      "https://api.browser.tinyfish.ai/s1",
    );
  });
  it("removes unsupported schema keywords and converts nullable type arrays", () => {
    expect(
      sanitizeOutputSchema({
        type: "object",
        additionalProperties: false,
        properties: { name: { type: ["string", "null"], const: "x" } },
      }),
    ).toEqual({
      type: "object",
      properties: { name: { type: "string", nullable: true } },
    });
  });
  it("detects explicit blockers without treating normal field labels as failures", () => {
    expect(failureSignal({ blocker: "captcha" })).toBe("captcha");
    expect(
      failureSignal({
        blocker: "none",
        fields: [{ label: "Have you worked with CAPTCHA systems?" }],
      }),
    ).toBeNull();
  });
});
