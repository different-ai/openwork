import type { VerificationEvaluator } from "./verification.ts";

export interface JevVerificationMetrics {
  durationMs: number;
  status: "completed" | "provider_error" | "cancelled";
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

const responseByteLimit = 256 * 1024;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new Error("Missing body");
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    if (Number(response.headers.get("content-length")) > responseByteLimit) throw new Error("Oversized body");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > responseByteLimit) throw new Error("Oversized body");
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

/** Wire contract verified against @ai-sdk/gateway@4.0.85 dist/index.js:
 * 2280–2363 (evaluation POST/body/answers), 3624–3645 (origin/protocol/auth),
 * 658 and 3952 (auth header and api-key method). No SDK runtime dependency.
 */
export function createJevVerificationEvaluator(options: {
  apiKey?: string;
  /** Trusted test transport only; the destination cannot be configured. */
  fetch?: typeof globalThis.fetch;
  onMetrics?: (metrics: JevVerificationMetrics) => void;
} = {}): VerificationEvaluator {
  const apiKey = options.apiKey ?? process.env.JEV_AI_GATEWAY_API_KEY;
  if (!apiKey?.trim()) throw new Error("JEV_AI_GATEWAY_API_KEY is required");
  return async ({ state, questions, signal }) => {
    const started = performance.now();
    let metrics: JevVerificationMetrics;
    let answers: unknown;
    try {
      signal.throwIfAborted();
      const response = await (options.fetch ?? globalThis.fetch)("https://ai-gateway.vercel.sh/v4/ai/evaluation-model", {
        method: "POST", redirect: "error", signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "ai-gateway-protocol-version": "0.0.1",
          "ai-gateway-auth-method": "api-key",
          "ai-evaluation-model-specification-version": "4",
          "ai-model-id": "typesafe-ai/jev",
        },
        body: JSON.stringify({ state, questions }),
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new Error("Gateway unavailable");
      }
      const result = await boundedJson(response, signal);
      if (!record(result)) throw new Error("Invalid response");
      answers = result.answers; // Unknown until validated by compileVerification.
      metrics = { durationMs: performance.now() - started, status: "completed" };
      if (record(result.usage)) {
        const names: ("inputTokens" | "outputTokens" | "totalTokens")[] = ["inputTokens", "outputTokens", "totalTokens"];
        for (const name of names) {
          const value = result.usage[name];
          if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) metrics[name] = value;
        }
      }
    } catch {
      metrics = { durationMs: performance.now() - started, status: signal.aborted ? "cancelled" : "provider_error" };
    }
    options.onMetrics?.(metrics);
    if (metrics.status !== "completed") throw new Error("Jev verification evaluation unavailable");
    return { answers };
  };
}
