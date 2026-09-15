/**
 * When a reply fails, whether the coworker should simply try again by itself.
 *
 * A transient failure is one the next attempt can reasonably clear: the
 * network dropped, the provider was busy or rate-limited, a server answered
 * 5xx, or the AI service was restarting. A hard failure needs the person:
 * the model cannot use tools, the saved model is not available, the provider
 * refused the account, a tool or permission was denied, or the person
 * stopped it. Hard failures are never retried automatically beyond the
 * one-time model fallback the conversation already knows.
 */
export type FailureClass = "transient" | "hard";

/** Waits between automatic attempts; the length is the attempt budget. */
export const RETRY_DELAYS_MS: readonly number[] = [2_000, 6_000, 15_000];

const HARD = [
  /does not support tool/i,
  /no endpoints found that support tool use/i,
  /no connected ai model can use tools/i,
  /^The saved model "/,
  /model not found/i,
  /not available/i,
  /not connected/i,
  /\b(401|403)\b/,
  /unauthorized|forbidden|invalid (api )?key|authentication|permission denied|not permitted|access denied/i,
  /insufficient (credits|quota|funds|balance)|billing|payment/i,
  /usage exceeded|free usage|subscribe/i,
  // The free model's shared limit: the engine names it, and a few seconds' patience does not clear it.
  /FreeUsageLimitError|free_tier_limit/i,
  /context (length|window)|too many tokens|prompt is too long|maximum context/i,
  /aborted|cancelled|canceled|stopped before/i,
  /invalid request|bad request|\b400\b|unsupported/i,
];

const TRANSIENT = [
  /\b(429|500|502|503|504|524)\b/,
  /rate ?limit|rate-limit|rate_limit|too many requests|resource exhausted|resource_exhausted/i,
  /overloaded|service unavailable|internal (server )?error|server error|bad gateway|gateway timeout|provider returned error/i,
  /fetch failed|failed to fetch|network|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|connection (error|refused|reset|lost|closed)|terminated/i,
  /\btime(d)? ?out\b/i,
  /try (your request )?again|retry your request/i,
  /not answering|restarting|is starting|warming up|engine (is )?(unavailable|starting)/i,
  /OpenWork returned 5\d\d/,
];

/**
 * Classify a failure from its raw text and, when the engine said so, its own
 * verdict. A hard sign always wins over a transient one: "429 … subscribe to
 * Go" is the free tier being used up, not a moment to wait out.
 */
export function classifyFailure(raw: string, retryable: boolean | null = null): FailureClass {
  const message = raw.trim();
  if (HARD.some((pattern) => pattern.test(message))) return "hard";
  if (retryable === true) return "transient";
  if (retryable === false) return "hard";
  return TRANSIENT.some((pattern) => pattern.test(message)) ? "transient" : "hard";
}

/** How long to wait before automatic attempt number `attempt` (1-based), or null when the budget is spent. */
export function retryDelayMs(attempt: number): number | null {
  if (!Number.isInteger(attempt) || attempt < 1) return null;
  return RETRY_DELAYS_MS[attempt - 1] ?? null;
}

/** "6 s", "15 s", "1 min", "9 hr" — the wait as a person would say it. */
export function describeWait(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1_000));
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3_600) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3_600)} hr`;
}
