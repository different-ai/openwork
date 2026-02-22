export type PerfLogRecord = {
  id: number;
  at: string;
  ts: number;
  scope: string;
  event: string;
  payload?: Record<string, unknown>;
};

type PerfRoot = typeof globalThis & {
  __openworkPerfSeq?: number;
  __openworkPerfLogs?: PerfLogRecord[];
  __openworkPerfConsoleAt?: Record<string, number>;
  __openworkPerfConsoleSuppressed?: Record<string, number>;
};

const PERF_LOG_LIMIT = 500;
const HOT_EVENT_MIN_INTERVAL_MS = 750;
const HOT_EVENT_KEYS = new Set([
  "session.sse:flush",
  "session.sse:arrival-gap",
  "session.event:message.part.updated",
  "session.input:draft-flush",
  "session.render:message-blocks",
  "session.render:tool-summary",
  "session.render:batch-commit",
  "session.main-thread:lag",
  "session.window:state",
]);

export const perfNow = () => {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
};

const round = (value: number) => Math.round(value * 100) / 100;

export const recordPerfLog = (
  enabled: boolean,
  scope: string,
  event: string,
  payload?: Record<string, unknown>,
) => {
  if (!enabled) return;

  const root = globalThis as PerfRoot;
  const id = (root.__openworkPerfSeq ?? 0) + 1;
  root.__openworkPerfSeq = id;

  const entry: PerfLogRecord = {
    id,
    at: new Date().toISOString(),
    ts: Date.now(),
    scope,
    event,
    payload,
  };

  const logs = root.__openworkPerfLogs ?? [];
  logs.push(entry);
  if (logs.length > PERF_LOG_LIMIT) {
    logs.splice(0, logs.length - PERF_LOG_LIMIT);
  }
  root.__openworkPerfLogs = logs;

  try {
    const key = `${scope}:${event}`;
    const now = Date.now();
    const lastByKey = root.__openworkPerfConsoleAt ?? (root.__openworkPerfConsoleAt = {});
    const suppressedByKey =
      root.__openworkPerfConsoleSuppressed ?? (root.__openworkPerfConsoleSuppressed = {});
    if (HOT_EVENT_KEYS.has(key)) {
      const last = lastByKey[key] ?? 0;
      if (now - last < HOT_EVENT_MIN_INTERVAL_MS) {
        suppressedByKey[key] = (suppressedByKey[key] ?? 0) + 1;
        return;
      }
    }

    lastByKey[key] = now;
    const suppressed = suppressedByKey[key] ?? 0;
    if (suppressed > 0) {
      suppressedByKey[key] = 0;
    }

    if (payload === undefined) {
      if (suppressed > 0) {
        console.log(`[OWPERF] ${scope}:${event}`, { suppressed });
        return;
      }
      console.log(`[OWPERF] ${scope}:${event}`);
      return;
    }

    if (suppressed > 0) {
      console.log(`[OWPERF] ${scope}:${event}`, { ...payload, suppressed });
      return;
    }

    console.log(`[OWPERF] ${scope}:${event}`, payload);
  } catch {
    // ignore
  }
};

export const readPerfLogs = (limit = 120) => {
  const root = globalThis as PerfRoot;
  const logs = root.__openworkPerfLogs ?? [];
  if (limit <= 0) return [];
  if (logs.length <= limit) return logs.slice();
  return logs.slice(logs.length - limit);
};

export const clearPerfLogs = () => {
  const root = globalThis as PerfRoot;
  root.__openworkPerfLogs = [];
  root.__openworkPerfSeq = 0;
};

export const finishPerf = (
  enabled: boolean,
  scope: string,
  event: string,
  startedAt: number,
  payload?: Record<string, unknown>,
) => {
  if (!enabled) return;
  recordPerfLog(enabled, scope, event, {
    ...(payload ?? {}),
    ms: round(perfNow() - startedAt),
  });
};
