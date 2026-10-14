import { config } from "./config.js";
import { sanitizeOutputSchema } from "./schemas.js";
export class IntegrationError extends Error {
  constructor(
    message: string,
    public status = 502,
    public retryable = false,
  ) {
    super(message);
  }
}
export const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
export function failureSignal(result: any) {
  const blocker = result?.blocker;
  if (blocker && blocker !== "none") return String(blocker);
  const text = typeof result === "string" ? result : JSON.stringify(result);
  return /(?:unable to (?:access|complete)|access denied|blocked by|captcha required|login required)/i.test(
    text,
  )
    ? "blocked"
    : null;
}
export class TinyFishClient {
  private nextSlot = new Map<string, number>();
  constructor(
    private key = config.tinyfishKey,
    private transport: typeof fetch = fetch,
  ) {}
  private async gate(product: string) {
    const gap = product === "search" ? 2100 : product === "fetch" ? 450 : 100;
    const wait = Math.max(0, (this.nextSlot.get(product) || 0) - Date.now());
    this.nextSlot.set(product, Date.now() + wait + gap);
    if (wait) await delay(wait);
  }
  async request(
    url: string,
    method = "GET",
    body?: any,
    retrySafe = method === "GET",
  ): Promise<any> {
    if (!this.key)
      throw new IntegrationError(
        "TINYFISH_API_KEY is not configured. Live web tasks cannot run.",
        503,
      );
    for (let attempt = 0; attempt < 3; attempt++) {
      let response: Response;
      try {
        response = await this.transport(url, {
          method,
          headers: {
            "X-API-Key": this.key,
            "Content-Type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(150000),
        });
      } catch (e) {
        if (retrySafe && attempt < 2) {
          await delay(500 * 2 ** attempt);
          continue;
        }
        throw new IntegrationError(
          "TinyFish request failed or timed out. An action-creating request was not automatically repeated.",
          502,
          retrySafe,
        );
      }
      if (response.status === 204) return null;
      const json = await response.json().catch(() => ({
        error: { message: `Invalid response (HTTP ${response.status})` },
      }));
      if (!response.ok) {
        const message =
          json.error?.message || json.message || `HTTP ${response.status}`;
        if (
          retrySafe &&
          [429, 502, 503, 504].includes(response.status) &&
          attempt < 2
        ) {
          const h = response.headers.get("Retry-After");
          const seconds = h
            ? Number(h) || Math.max(0, (Date.parse(h) - Date.now()) / 1000)
            : 2 ** attempt;
          await delay(Math.min(30000, Math.max(500, seconds * 1000)));
          continue;
        }
        throw new IntegrationError(
          `TinyFish: ${message}`,
          response.status,
          [429, 502, 503, 504].includes(response.status),
        );
      }
      return json;
    }
    throw new IntegrationError("TinyFish retries exhausted");
  }
  async search(query: string, options: Record<string, string> = {}) {
    await this.gate("search");
    const params = new URLSearchParams({ query, language: "en", ...options });
    const data = await this.request(`https://api.search.tinyfish.ai?${params}`);
    if (!Array.isArray(data.results))
      throw new IntegrationError("TinyFish Search response is missing results");
    return data;
  }
  async fetchUrls(urls: string[], fresh = false) {
    if (!urls.length || urls.length > 10)
      throw new Error("Fetch batches must contain 1–10 URLs");
    await this.gate("fetch");
    const data = await this.request(
      "https://api.fetch.tinyfish.ai",
      "POST",
      {
        urls,
        format: "markdown",
        links: true,
        iframe_links: true,
        ttl: fresh ? 0 : 3600,
        per_url_timeout_ms: 45000,
      },
      true,
    );
    if (!Array.isArray(data.results) || !Array.isArray(data.errors))
      throw new IntegrationError(
        "TinyFish Fetch response has an invalid shape",
      );
    return data;
  }
  getRun(runId: string) {
    return this.request(
      `https://agent.tinyfish.ai/v1/runs/${encodeURIComponent(runId)}`,
    );
  }
  async agent(
    url: string,
    goal: string,
    schema: any,
    onEvent: (event: any) => void,
    profileId?: string,
  ) {
    if (!this.key)
      throw new IntegrationError("TINYFISH_API_KEY is not configured", 503);
    const body: any = {
      url,
      goal,
      output_schema: sanitizeOutputSchema(schema),
      agent_config: { max_duration_seconds: 180 },
    };
    if (profileId) {
      body.use_profile = true;
      body.profile_id = profileId;
    }
    const response = await this.transport(
      "https://agent.tinyfish.ai/v1/automation/run-sse",
      {
        method: "POST",
        headers: { "X-API-Key": this.key, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(240000),
      },
    );
    if (!response.ok)
      throw new IntegrationError(
        `TinyFish Agent rejected the task (HTTP ${response.status}): ${(await response.text()).slice(0, 500)}`,
        response.status,
      );
    let runId: string | undefined, terminal: any;
    try {
      for await (const evt of parseSSE(response)) {
        if (evt.run_id) runId = evt.run_id;
        onEvent(evt);
        if (evt.type === "COMPLETE") {
          terminal = evt;
          break;
        }
      }
    } catch (e) {
      if (!runId) throw e;
    }
    if (!terminal && runId) {
      const until = Date.now() + 240000;
      while (Date.now() < until) {
        const run = await this.getRun(runId);
        if (["COMPLETED", "FAILED", "CANCELLED"].includes(run.status)) {
          terminal = { ...run, type: "COMPLETE" };
          onEvent(terminal);
          break;
        }
        await delay(2000);
      }
    }
    if (!terminal || terminal.status !== "COMPLETED")
      throw new IntegrationError(
        terminal?.error?.message ||
          "TinyFish Agent did not complete; inspect the recorded run before retrying.",
      );
    return { runId, result: terminal.result };
  }
  async createBrowser(url: string) {
    return this.request("https://api.browser.tinyfish.ai", "POST", {
      url,
      timeout_seconds: 3600,
    });
  }
  createProfile(name: string) {
    return this.request("https://agent.tinyfish.ai/v1/profiles", "POST", {
      name,
    });
  }
  setupProfile(profileId: string, url: string) {
    return this.request(
      `https://agent.tinyfish.ai/v1/profiles/${encodeURIComponent(profileId)}/setup-session`,
      "POST",
      { url },
    );
  }
  saveProfile(profileId: string, sessionId: string) {
    return this.request(
      `https://agent.tinyfish.ai/v1/profiles/${encodeURIComponent(profileId)}/save`,
      "POST",
      { session_id: sessionId },
    );
  }
  async deleteBrowser(sessionId: string) {
    return this.request(
      `https://api.browser.tinyfish.ai/${encodeURIComponent(sessionId)}`,
      "DELETE",
      undefined,
      true,
    );
  }
  createMonitor(body: any) {
    return this.request("https://agent.tinyfish.ai/v1/monitors", "POST", body);
  }
  getMonitor(monitorId: string) {
    return this.request(
      `https://agent.tinyfish.ai/v1/monitors/${encodeURIComponent(monitorId)}`,
    );
  }
  runMonitor(monitorId: string) {
    return this.request(
      `https://agent.tinyfish.ai/v1/monitors/${encodeURIComponent(monitorId)}/runs`,
      "POST",
    );
  }
  patchMonitor(monitorId: string, body: any) {
    return this.request(
      `https://agent.tinyfish.ai/v1/monitors/${encodeURIComponent(monitorId)}`,
      "PATCH",
      body,
    );
  }
  async createResearch(query: string) {
    const result = await this.request(
      "https://agent.tinyfish.ai/v1/automation/run-research-async",
      "POST",
      { query, mode: "standard" },
    );
    if (result.error || !result.research_run_id)
      throw new IntegrationError(
        result.error?.message || "TinyFish Research returned no run ID",
      );
    return result;
  }
  getResearch(runId: string) {
    return this.request(
      `https://agent.tinyfish.ai/v1/research-run/${encodeURIComponent(runId)}`,
    );
  }
}
export async function* parseSSE(response: Response) {
  if (!response.body) throw new IntegrationError("Missing SSE body");
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "";
  const parse = (frame: string) => {
    const data = frame
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return undefined;
    return JSON.parse(data);
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      // Normalize the combined buffer: a CRLF pair may straddle two network chunks.
      // Keep a trailing CR until the next read so it cannot become a false blank line.
      buffer = buffer
        .replace(/\r\n/g, "\n")
        .replace(done ? /\r/g : /\r(?!$)/g, "\n");
      let split: number;
      while ((split = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const evt = parse(frame);
        if (evt) yield evt;
      }
      if (done) {
        if (buffer.trim()) {
          const evt = parse(buffer);
          if (evt) yield evt;
        }
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export const tinyfish = new TinyFishClient();
