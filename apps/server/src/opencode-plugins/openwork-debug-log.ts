import { randomUUID } from "node:crypto";

/**
 * Internal debug logging for the Connect-skill / agent-prompt injection chain.
 *
 * Writes single-line, prefixed records to stderr so the output survives both
 * runtimes that host this code:
 * - the OpenWork server process (routes, catalog reads), and
 * - the OpenCode engine process (bundled opencode-plugins).
 *
 * Raw prompt logging is disabled by default. OPENWORK_PROMPT_LOG is the
 * explicit override; when it is blank or absent, desktop dev mode is the
 * fallback. Unknown values fail closed because these logs can contain user
 * context.
 */
export type PromptDebugSetting = {
  enabled: boolean;
  exact: boolean;
  level: "off" | "metadata" | "exact";
  source:
    | "OPENWORK_OBSERVABILITY"
    | "OPENWORK_OBSERVABILITY_INVALID"
    | "OPENWORK_PROMPT_LOG"
    | "OPENWORK_PROMPT_LOG_INVALID"
    | "OPENWORK_DESKTOP_PROMPT_LOG"
    | "OPENWORK_DESKTOP_DEV_MODE"
    | "OPENWORK_DEV_MODE"
    | "OPENWORK_DEV_MODE_INVALID"
    | "default";
};

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);
const PROMPT_TRACE_ID = /^pt_[a-z0-9]{6,32}$/;
const SHARED_PROMPT_STATE_KEY = Symbol.for("openwork.prompt-observability.state.v1");
const MAX_PROVENANCE_TRACES = 128;
const MAX_PROVENANCE_ENTRIES_PER_TRACE = 128;

export type PromptContributorProvenance = {
  contributorId: string;
  text: string;
  chars: number;
  hash: string;
};

type SharedPromptState = {
  version: 1;
  promptTraceIds: WeakMap<object, string>;
  promptTraceProcessNonce: string;
  promptTraceSequence: number;
  provenanceByTrace: Map<string, PromptContributorProvenance[]>;
};

function sharedPromptState(): SharedPromptState {
  // The context and observer entrypoints are shipped as separate bundles.
  // Symbol.for makes their content-free trace IDs and bounded provenance map
  // genuinely process-shared instead of silently creating one copy per bundle.
  const root = globalThis as unknown as Record<PropertyKey, unknown>;
  const existing = root[SHARED_PROMPT_STATE_KEY] as SharedPromptState | undefined;
  if (existing?.version === 1) return existing;
  const created: SharedPromptState = {
    version: 1,
    promptTraceIds: new WeakMap<object, string>(),
    promptTraceProcessNonce: randomUUID().replaceAll("-", "").slice(0, 6),
    promptTraceSequence: 0,
    provenanceByTrace: new Map(),
  };
  root[SHARED_PROMPT_STATE_KEY] = created;
  return created;
}

function normalizeEnvValue(value: string | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

export function resolvePromptDebugSetting(
  env: NodeJS.ProcessEnv = process.env,
): PromptDebugSetting {
  const observability = normalizeEnvValue(env.OPENWORK_OBSERVABILITY);
  if (observability) {
    if (observability === "exact") {
      return { enabled: true, exact: true, level: "exact", source: "OPENWORK_OBSERVABILITY" };
    }
    if (observability === "metadata") {
      return { enabled: true, exact: false, level: "metadata", source: "OPENWORK_OBSERVABILITY" };
    }
    if (observability === "off") {
      return { enabled: false, exact: false, level: "off", source: "OPENWORK_OBSERVABILITY" };
    }
    return { enabled: false, exact: false, level: "off", source: "OPENWORK_OBSERVABILITY_INVALID" };
  }

  const explicit = normalizeEnvValue(env.OPENWORK_PROMPT_LOG);
  if (explicit) {
    if (TRUE_VALUES.has(explicit)) {
      return { enabled: true, exact: true, level: "exact", source: "OPENWORK_PROMPT_LOG" };
    }
    if (FALSE_VALUES.has(explicit)) {
      return { enabled: false, exact: false, level: "off", source: "OPENWORK_PROMPT_LOG" };
    }
    return { enabled: false, exact: false, level: "off", source: "OPENWORK_PROMPT_LOG_INVALID" };
  }

  const desktopPromptLog = normalizeEnvValue(env.OPENWORK_DESKTOP_PROMPT_LOG);
  if (TRUE_VALUES.has(desktopPromptLog)) {
    return { enabled: true, exact: true, level: "exact", source: "OPENWORK_DESKTOP_PROMPT_LOG" };
  }

  const desktopDevMode = normalizeEnvValue(env.OPENWORK_DESKTOP_DEV_MODE);
  if (TRUE_VALUES.has(desktopDevMode)) {
    return { enabled: true, exact: false, level: "metadata", source: "OPENWORK_DESKTOP_DEV_MODE" };
  }
  if (FALSE_VALUES.has(desktopDevMode)) {
    return { enabled: false, exact: false, level: "off", source: "OPENWORK_DESKTOP_DEV_MODE" };
  }
  if (desktopDevMode) {
    // The desktop bridge only emits canonical values. Treat a malformed value
    // as an explicit safe opt-out instead of falling through to process dev.
    return { enabled: false, exact: false, level: "off", source: "OPENWORK_DESKTOP_DEV_MODE" };
  }

  const devMode = normalizeEnvValue(env.OPENWORK_DEV_MODE);
  if (TRUE_VALUES.has(devMode)) {
    return { enabled: true, exact: false, level: "metadata", source: "OPENWORK_DEV_MODE" };
  }
  if (FALSE_VALUES.has(devMode)) {
    return { enabled: false, exact: false, level: "off", source: "OPENWORK_DEV_MODE" };
  }
  if (devMode) {
    return { enabled: false, exact: false, level: "off", source: "OPENWORK_DEV_MODE_INVALID" };
  }
  return { enabled: false, exact: false, level: "off", source: "default" };
}

export function promptDebugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolvePromptDebugSetting(env).enabled;
}

export function promptDebugExact(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolvePromptDebugSetting(env).exact;
}

/**
 * Return one process-local, content-free identifier for a prompt transform.
 * OpenCode passes the same input object through every system-transform hook,
 * so the registry and terminal observer can correlate records without logging
 * a raw session, message, workspace, or prompt value.
 */
export function promptTraceId(input: unknown): string {
  if ((typeof input !== "object" && typeof input !== "function") || input === null) {
    return "pt_unscoped";
  }
  const state = sharedPromptState();
  const existing = state.promptTraceIds.get(input);
  if (existing) return existing;
  state.promptTraceSequence = (state.promptTraceSequence + 1) % 2_176_782_336;
  const created = `pt_${state.promptTraceProcessNonce}${state.promptTraceSequence.toString(36).padStart(6, "0")}`;
  state.promptTraceIds.set(input, created);
  return created;
}

/** Record exact contributor text only while prompt tracing is enabled. */
export function recordPromptContributorProvenance(
  trace: string,
  provenance: PromptContributorProvenance,
): void {
  if (!promptDebugExact()) return;
  const state = sharedPromptState();
  const entries = state.provenanceByTrace.get(trace) ?? [];
  entries.push(provenance);
  while (entries.length > MAX_PROVENANCE_ENTRIES_PER_TRACE) entries.shift();
  state.provenanceByTrace.delete(trace);
  state.provenanceByTrace.set(trace, entries);
  while (state.provenanceByTrace.size > MAX_PROVENANCE_TRACES) {
    const oldest = state.provenanceByTrace.keys().next().value;
    if (oldest === undefined) break;
    state.provenanceByTrace.delete(oldest);
  }
}

/** Consume provenance once the observer reaches the prepared-system boundary. */
export function takePromptContributorProvenance(
  trace: string,
): PromptContributorProvenance[] {
  const state = sharedPromptState();
  const entries = state.provenanceByTrace.get(trace) ?? [];
  state.provenanceByTrace.delete(trace);
  return entries.map((entry) => ({ ...entry }));
}

/** Syntax-check an authenticated request's trace header before echoing it. */
export function normalizePromptTraceId(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return PROMPT_TRACE_ID.test(normalized) ? normalized : null;
}

export function logPromptDebug(
  scope: string,
  message: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!promptDebugEnabled(env)) return;
  console.error(`[openwork][${scope}] ${message}`);
}
