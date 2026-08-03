import { evaluate } from "./cdp.ts";
import type { Surface } from "./surface.ts";

const SCREEN_DUMP_TIMEOUT_MS = 8_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string {
  return typeof value[key] === "string" ? value[key] : "";
}

function stringArrayField(value: Record<string, unknown>, key: string): string[] {
  const entries = value[key];
  return Array.isArray(entries) ? entries.filter((entry): entry is string => typeof entry === "string").slice(0, 30) : [];
}

const SCREEN_DUMP_EXPRESSION = `(() => {
  const hash = window.location.hash;
  return {
    hash,
    route: hash.replace(/^#/, "") || window.location.pathname,
    title: document.title,
    buttons: [...document.querySelectorAll("button")]
      .map((button) => (button.textContent ?? "").replace(/\\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 30),
    body: (document.body?.innerText ?? "").slice(0, 500),
  };
})()`;

/** A short, best-effort snapshot suitable for appending to timeout errors. */
export async function dumpScreenState(surface: Surface): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("screen dump timed out")), SCREEN_DUMP_TIMEOUT_MS);
    });
    const value = await Promise.race([
      evaluate(surface.client, SCREEN_DUMP_EXPRESSION, { timeoutMs: SCREEN_DUMP_TIMEOUT_MS }),
      timedOut,
    ]);
    if (!isRecord(value)) return "unavailable";
    return JSON.stringify({
      hash: stringField(value, "hash"),
      route: stringField(value, "route"),
      title: stringField(value, "title"),
      buttons: stringArrayField(value, "buttons"),
      body: stringField(value, "body").slice(0, 500),
    });
  } catch {
    return "unavailable";
  } finally {
    if (timer) clearTimeout(timer);
  }
}
