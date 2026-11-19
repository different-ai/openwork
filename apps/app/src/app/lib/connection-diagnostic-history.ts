export const CONNECTION_HISTORY_LIMIT = 500;
export const CONNECTION_HISTORY_TTL_MS = 60 * 60 * 1_000;
const COALESCE_MS = 5_000;

const reasons = {
  den_request_http_failure: true,
  den_request_transport_failure: true,
  den_request_timeout: true,
  den_auth_checking: true,
  den_auth_signed_in: true,
  den_auth_unavailable: true,
  den_auth_signed_out: true,
  den_session_retry: true,
  den_session_recovered: true,
  den_org_retry: true,
  den_org_unresolved: true,
  den_org_recovered: true,
  engine_connecting: true,
  engine_live: true,
  engine_reconnecting: true,
  engine_auth_blocked: true,
  engine_stale: true,
  engine_retry: true,
  send_archive_unknown: true,
  send_archive_held: true,
  send_model_transition: true,
  send_model_unavailable: true,
  send_admission_unknown: true,
  send_parent_disabled: true,
  send_stopping: true,
  send_empty: true,
  send_preparing_tools: true,
  send_submitting: true,
  send_auto_sending: true,
  send_creating_session: true,
  send_restore_unsent: true,
  send_preparing: true,
  send_busy_stop_control: true,
};

export type ConnectionDiagnosticReason = keyof typeof reasons;
export type SendDiagnosticReason = Extract<ConnectionDiagnosticReason, `send_${string}`>;
type EventKind = "state" | "failure" | "retry" | "recovered" | "blocked" | "cleared" | "ended";
export type ConnectionDiagnosticMetadata = {
  durationMs?: number;
  retryCount?: number;
  httpStatus?: number;
};
export type ConnectionDiagnosticEvent = ConnectionDiagnosticMetadata & {
  at: number;
  lastAt: number;
  count: number;
  source: number;
  reason: ConnectionDiagnosticReason;
  kind: EventKind;
};

type SourceState = {
  touchedAt: number;
  active: Map<ConnectionDiagnosticReason, number>;
  failureAt?: number;
  retryCount?: number;
};

function safeNumber(value: number | undefined, max: number, min = 0) {
  return typeof value === "number" && Number.isFinite(value) && value >= min
    ? Math.min(max, Math.floor(value))
    : undefined;
}

function allowedReason(reason: ConnectionDiagnosticReason) {
  return typeof reason === "string" && Object.hasOwn(reasons, reason);
}

export function createConnectionDiagnosticHistory(now: () => number = () => Date.now()) {
  let events: ConnectionDiagnosticEvent[] = [];
  const states = new Map<number, SourceState>();
  let nextSource = 0;

  const prune = () => {
    const cutoff = now() - CONNECTION_HISTORY_TTL_MS;
    events = events.filter((event) => event.at > cutoff);
    for (const [source, state] of states) {
      if (state.touchedAt <= cutoff) {
        states.delete(source);
        continue;
      }
      for (const [reason, at] of state.active) {
        if (at <= cutoff) state.active.delete(reason);
      }
      if (state.failureAt !== undefined && state.failureAt <= cutoff) {
        state.failureAt = undefined;
        state.retryCount = undefined;
      }
    }
  };

  const record = (
    reason: ConnectionDiagnosticReason,
    kind: EventKind,
    metadata: ConnectionDiagnosticMetadata = {},
    source = 0,
  ) => {
    if (!allowedReason(reason)) return;
    if (!["state", "failure", "retry", "recovered", "blocked", "cleared", "ended"].includes(kind)) return;
    prune();
    const at = now();
    const event: ConnectionDiagnosticEvent = {
      at,
      lastAt: at,
      count: 1,
      source: safeNumber(source, Number.MAX_SAFE_INTEGER) ?? 0,
      reason,
      kind,
      durationMs: safeNumber(metadata.durationMs, CONNECTION_HISTORY_TTL_MS),
      retryCount: safeNumber(metadata.retryCount, 1_000_000),
      httpStatus: typeof metadata.httpStatus === "number" && metadata.httpStatus <= 599
        ? safeNumber(metadata.httpStatus, 599, 100)
        : undefined,
    };
    const previous = events.findLast((entry) => entry.source === event.source);
    if (previous && previous.reason === reason && previous.kind === kind
      && previous.httpStatus === event.httpStatus && at >= previous.lastAt
      && at - previous.at < COALESCE_MS) {
      previous.lastAt = at;
      previous.count = Math.min(previous.count + 1, 1_000_000);
      previous.durationMs = event.durationMs;
      previous.retryCount = event.retryCount;
      return;
    }
    events.push(event);
    if (events.length > CONNECTION_HISTORY_LIMIT) events.shift();
  };

  const createSource = () => {
    const source = ++nextSource;
    let disposed = false;
    const state = () => {
      prune();
      let current = states.get(source);
      if (!current) {
        if (states.size >= CONNECTION_HISTORY_LIMIT) {
          const oldest = states.keys().next().value;
          if (oldest !== undefined) states.delete(oldest);
        }
        current = { touchedAt: now(), active: new Map() };
        states.set(source, current);
      }
      current.touchedAt = now();
      return current;
    };
    return {
      record(reason: ConnectionDiagnosticReason, kind: EventKind, metadata?: ConnectionDiagnosticMetadata) {
        if (!disposed) record(reason, kind, metadata, source);
      },
      failed() {
        if (disposed) return;
        const current = state();
        current.failureAt ??= now();
      },
      attempt(reason: ConnectionDiagnosticReason) {
        if (disposed || !allowedReason(reason)) return;
        const current = state();
        if (current.failureAt === undefined) return;
        current.retryCount = Math.min((current.retryCount ?? 0) + 1, 1_000_000);
        record(reason, "retry", { retryCount: current.retryCount }, source);
      },
      recovered(reason: ConnectionDiagnosticReason) {
        if (disposed || !allowedReason(reason)) return;
        const current = state();
        if (current.failureAt === undefined) return;
        record(reason, "recovered", {
          durationMs: now() - current.failureAt,
          retryCount: current.retryCount ?? 0,
        }, source);
        current.failureAt = undefined;
        current.retryCount = undefined;
      },
      transition(reason: ConnectionDiagnosticReason) {
        if (disposed || !allowedReason(reason)) return;
        const current = state();
        if (current.active.has(reason)) return;
        const startedAt = current.active.values().next().value;
        record(reason, "state", { durationMs: startedAt === undefined ? undefined : now() - startedAt }, source);
        current.active.clear();
        current.active.set(reason, now());
      },
      blockers(input: readonly SendDiagnosticReason[]) {
        if (disposed) return;
        const current = state();
        const next = new Set<ConnectionDiagnosticReason>(input.filter((reason) => allowedReason(reason) && reason.startsWith("send_")));
        for (const [reason, at] of current.active) {
          if (next.has(reason)) continue;
          record(reason, "cleared", { durationMs: now() - at }, source);
          current.active.delete(reason);
        }
        for (const reason of next) {
          if (current.active.has(reason)) continue;
          record(reason, "blocked", {}, source);
          current.active.set(reason, now());
        }
      },
      dispose() {
        if (disposed) return;
        prune();
        for (const [reason, at] of states.get(source)?.active ?? []) {
          record(reason, "ended", { durationMs: now() - at }, source);
        }
        states.delete(source);
        disposed = true;
      },
    };
  };

  return {
    record,
    createSource,
    read() {
      prune();
      return {
        maxEvents: CONNECTION_HISTORY_LIMIT,
        maxAgeMs: CONNECTION_HISTORY_TTL_MS,
        retainedEntries: events.length,
        trackedSources: states.size,
        recent: events.map((event) => ({ ...event })),
      };
    },
  };
}

export const connectionDiagnosticHistory = createConnectionDiagnosticHistory();
export type ConnectionDiagnosticSource = ReturnType<typeof connectionDiagnosticHistory.createSource>;
