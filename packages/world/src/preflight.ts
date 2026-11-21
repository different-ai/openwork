import type { WorldProvider } from "./target.ts";

/** What a check knows about the invocation it guards. */
export interface PreflightContext {
  place: WorldProvider;
  command?: string;
}

export interface PreflightCheck {
  id: string;
  label: string;
  places?: readonly WorldProvider[];
  blocking?: true;
  needs?: string;
  fix?: string;
  timeoutMs?: number;
  run(context: PreflightContext): Promise<{ ok: boolean; detail?: string; hint?: string; warning?: true }>;
}

export type PreflightResult = {
  id: string;
  label: string;
  ok: boolean;
  detail?: string;
  hint?: string;
  warning?: true;
  blocking?: true;
  timedOut?: true;
};

/** ✔ passed, ⚠ passed with a warning (or timed out), ✖ failed. */
export function preflightSymbol(result: PreflightResult): "✔" | "⚠" | "✖" {
  if (result.ok) return result.warning ? "⚠" : "✔";
  return result.timedOut ? "⚠" : "✖";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runOne(check: PreflightCheck, timeoutMs: number, context: PreflightContext): Promise<PreflightResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ ok: false; detail: string; timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, detail: "timed out", timedOut: true }), check.timeoutMs ?? timeoutMs);
    timer.unref();
  });
  try {
    const result = await Promise.race([
      check.run(context).catch((error: unknown) => ({ ok: false, detail: errorText(error) })),
      timeout,
    ]);
    return { id: check.id, label: check.label, ...result, ...(check.blocking ? { blocking: true } : {}) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function runPreflight(
  checks: readonly PreflightCheck[],
  timeoutMs = 5_000,
  context: PreflightContext = { place: "local" },
): Promise<PreflightResult[]> {
  return Promise.all(checks.map((check) => runOne(check, timeoutMs, context)));
}

/** The checks that apply to a placement. */
export function checksForPlace(checks: readonly PreflightCheck[], place: WorldProvider): PreflightCheck[] {
  return checks.filter((check) => check.places === undefined || check.places.includes(place));
}

/** Definite failures of blocking checks. A timed-out requirement warns instead of blocking. */
export function unmetRequirements(results: readonly PreflightResult[]): PreflightResult[] {
  return results.filter((result) => result.blocking === true && !result.ok && result.timedOut !== true);
}

export function nodeCheck(): PreflightCheck {
  return {
    id: "node",
    label: "node",
    async run() {
      const major = Number(process.versions.node.split(".", 1)[0]);
      return major >= 24
        ? { ok: true, detail: process.versions.node }
        : { ok: false, detail: `Node ${process.versions.node}`, hint: "install Node 24 or newer" };
    },
  };
}
