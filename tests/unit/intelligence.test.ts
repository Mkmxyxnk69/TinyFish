import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { config } from "../../packages/core/config.js";
import {
  structuredTask,
  classifyEmployerMessage,
} from "../../packages/core/intelligence.js";
import { GeminiKeyPool } from "../../packages/core/gemini.js";
const original = { ...config };
const schema = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
};
beforeEach(() => {
  config.geminiKeys = ["local-key-one", "local-key-two"];
  config.model = "configured-planner";
  config.classificationModel = "configured-classifier";
  vi.spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("Unexpected network request"),
  );
});
afterEach(() => {
  Object.assign(config, original);
  vi.restoreAllMocks();
});
const output = (value: any, finishReason = "STOP") =>
  Response.json({
    candidates: [
      { finishReason, content: { parts: [{ text: JSON.stringify(value) }] } },
    ],
  });
it("uses configured Gemini model, header credentials, and a JSON response schema", async () => {
  vi.mocked(fetch).mockResolvedValue(output({ ok: true }));
  await expect(
    structuredTask(
      "plan",
      "Plan bounded searches",
      { text: "untrusted" },
      schema,
    ),
  ).resolves.toEqual({ ok: true });
  const [url, options] = vi.mocked(fetch).mock.calls[0];
  expect(url).toBe(
    "https://generativelanguage.googleapis.com/v1beta/models/configured-planner:generateContent",
  );
  expect(String(url)).not.toContain("local-key");
  expect(options?.headers).toMatchObject({ "x-goog-api-key": "local-key-one" });
  expect(JSON.parse(String(options?.body))).toMatchObject({
    generationConfig: {
      responseMimeType: "application/json",
      responseJsonSchema: schema,
    },
    contents: [
      {
        role: "user",
        parts: [{ text: JSON.stringify({ text: "untrusted" }) }],
      },
    ],
  });
});
it("round-robins successive tasks across the configured keys", async () => {
  vi.mocked(fetch).mockImplementation(async () => output({ ok: true }));
  for (let i = 0; i < 3; i++) await structuredTask("plan", "Plan", {}, schema);
  expect(
    vi
      .mocked(fetch)
      .mock.calls.map((call) => (call[1]?.headers as any)["x-goog-api-key"]),
  ).toEqual(["local-key-one", "local-key-two", "local-key-one"]);
});
it("deduplicates keys and skips credentials rejected earlier", () => {
  const pool = new GeminiKeyPool(["a", "a", "b"]);
  expect(pool.next("model")).toBe("a");
  pool.reject("a");
  expect(pool.next("model")).toBe("b");
  expect(pool.next("model")).toBe("b");
});
it("disables an unauthorized key and retries a second key", async () => {
  vi.mocked(fetch)
    .mockResolvedValueOnce(Response.json({}, { status: 403 }))
    .mockResolvedValueOnce(output({ ok: true }));
  await expect(structuredTask("plan", "Plan", {}, schema)).resolves.toEqual({
    ok: true,
  });
  expect(
    (vi.mocked(fetch).mock.calls[1][1]?.headers as any)["x-goog-api-key"],
  ).toBe("local-key-two");
});
it("recognizes Google's invalid-key HTTP 400 without treating schema errors as credential failures", async () => {
  vi.mocked(fetch)
    .mockResolvedValueOnce(
      Response.json(
        { error: { details: [{ reason: "API_KEY_INVALID" }] } },
        { status: 400 },
      ),
    )
    .mockResolvedValueOnce(output({ ok: true }));
  await expect(structuredTask("plan", "Plan", {}, schema)).resolves.toEqual({
    ok: true,
  });
  expect(fetch).toHaveBeenCalledTimes(2);
});
it("does not cycle through keys to evade a project rate limit", async () => {
  vi.mocked(fetch).mockResolvedValue(
    Response.json({}, { status: 429, headers: { "retry-after": "60" } }),
  );
  await expect(structuredTask("plan", "Plan", {}, schema)).rejects.toThrow(
    "429",
  );
  await expect(structuredTask("plan", "Plan", {}, schema)).rejects.toThrow(
    "cooldown",
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("routes reply classification to its separately configured Gemini model", async () => {
  vi.mocked(fetch).mockResolvedValue(output({ kind: "interview" }));
  await expect(
    classifyEmployerMessage({
      subject: "Next steps",
      text: "Can we meet on Tuesday?",
    }),
  ).resolves.toBe("interview");
  expect(vi.mocked(fetch).mock.calls[0][0]).toContain(
    "configured-classifier:generateContent",
  );
  expect(
    JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)).generationConfig
      .maxOutputTokens,
  ).toBe(512);
});
it("fails before any request when the live key pool is empty", async () => {
  config.geminiKeys = [];
  await expect(
    classifyEmployerMessage({ subject: "Interview", text: "Interview" }),
  ).rejects.toThrow("GEMINI_API_KEYS");
  expect(fetch).not.toHaveBeenCalled();
});
it("rejects truncated or blocked output", async () => {
  vi.mocked(fetch).mockResolvedValue(output({ ok: true }, "MAX_TOKENS"));
  await expect(structuredTask("plan", "Plan", {}, schema)).rejects.toThrow(
    "MAX_TOKENS",
  );
});
it("rejects malformed JSON", async () => {
  vi.mocked(fetch).mockResolvedValue(
    Response.json({
      candidates: [
        { finishReason: "STOP", content: { parts: [{ text: "not JSON" }] } },
      ],
    }),
  );
  await expect(structuredTask("plan", "Plan", {}, schema)).rejects.toThrow(
    "valid structured JSON",
  );
});
it("rejects missing required properties even on a successful provider response", async () => {
  vi.mocked(fetch).mockResolvedValue(output({}));
  await expect(structuredTask("plan", "Plan", {}, schema)).rejects.toThrow(
    "missing result.ok",
  );
});
it("rejects an unsupported employer classification", async () => {
  vi.mocked(fetch).mockResolvedValue(output({ kind: "submitted" }));
  await expect(
    classifyEmployerMessage({ subject: "Hello", text: "Hello" }),
  ).rejects.toThrow("invalid category");
});
it("preserves provider failure without leaking its raw error body or substituting demo output", async () => {
  vi.mocked(fetch).mockResolvedValue(
    Response.json(
      { error: { message: "private credential local-key-one" } },
      { status: 503 },
    ),
  );
  await expect(
    classifyEmployerMessage({ subject: "Interview", text: "Interview" }),
  ).rejects.toThrow("HTTP 503");
  expect(fetch).toHaveBeenCalledTimes(1);
});
