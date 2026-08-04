/**
 * Where the time goes.
 *
 * Vitest reports per-test and per-file duration, but our specs are single long
 * journeys, so "this test took 47s" says nothing about which beat was slow.
 * The composable functions every spec funnels through record themselves here,
 * so specs never mention timing and the results still show a breakdown.
 */

export interface Span {
  label: string;
  ms: number;
  at: string;
  detail: string | null;
}

const spans: Span[] = [];

/** Start timing; call the returned function when the work finishes. */
export function startSpan(label: string, detail?: string): (extraDetail?: string) => number {
  const startedAt = Date.now();
  let settled = false;
  return (extraDetail?: string) => {
    if (settled) return 0;
    settled = true;
    const ms = Date.now() - startedAt;
    spans.push({ label, ms, at: new Date(startedAt).toISOString(), detail: extraDetail ?? detail ?? null });
    return ms;
  };
}

/** Time an async operation, recording it even when it throws. */
export async function timed<T>(label: string, fn: () => Promise<T>, detail?: string): Promise<T> {
  const stop = startSpan(label, detail);
  try {
    return await fn();
  } finally {
    stop();
  }
}

export function timeline(): Span[] {
  return [...spans];
}

export function resetTimeline(): void {
  spans.length = 0;
}

export interface SpanTotal {
  label: string;
  calls: number;
  totalMs: number;
  maxMs: number;
}

/** Aggregate by label, slowest total first — the table worth looking at. */
export function timelineTotals(entries: Span[] = spans): SpanTotal[] {
  const totals = new Map<string, SpanTotal>();
  for (const span of entries) {
    const current = totals.get(span.label) ?? { label: span.label, calls: 0, totalMs: 0, maxMs: 0 };
    current.calls += 1;
    current.totalMs += span.ms;
    current.maxMs = Math.max(current.maxMs, span.ms);
    totals.set(span.label, current);
  }
  return [...totals.values()].sort((a, b) => b.totalMs - a.totalMs);
}

export function formatTimeline(entries: Span[] = spans, limit = 8): string {
  const totals = timelineTotals(entries).slice(0, limit);
  if (totals.length === 0) return "no spans recorded";
  const width = Math.max(...totals.map((total) => total.label.length));
  return totals
    .map((total) => `${total.label.padEnd(width)}  ${String(total.totalMs).padStart(7)}ms  x${total.calls}${total.calls > 1 ? ` (max ${total.maxMs}ms)` : ""}`)
    .join("\n");
}
