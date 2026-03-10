export type DebugEventKind = "ui" | "call" | "system" | "lifecycle";

export type DebugEventBase = {
  kind: DebugEventKind;
  id: string;
  at: string;
  ts: number;
  debugSessionId: string;
  correlationId?: string;
  surface: string;
  action: string;
  entity?: {
    workspaceId?: string;
    sessionId?: string;
    commandId?: string;
    toolCallId?: string;
    messageId?: string;
  };
  payload?: Record<string, unknown>;
};

export type DebugUiEvent = DebugEventBase & {
  kind: "ui";
  interaction: string;
};

export type DebugCallEvent = DebugEventBase & {
  kind: "call";
  operation: string;
  status: "ok" | "error" | "cancelled";
  durationMs?: number;
  error?: {
    code?: string;
    message?: string;
    kind?: string;
  };
};

export type DebugSystemEvent = DebugEventBase & {
  kind: "system";
  command: string;
  status: "ok" | "error";
  exitCode?: number | null;
  durationMs?: number;
  stdoutExcerpt?: string;
  stderrExcerpt?: string;
};

export type DebugLifecycleEvent = DebugEventBase & {
  kind: "lifecycle";
  phase: "start" | "stop" | "submit" | "reset";
};

export type DebugEvent = DebugUiEvent | DebugCallEvent | DebugSystemEvent | DebugLifecycleEvent;

export type DebugSessionManifest = {
  id: string;
  startedAt: string;
  startedTs: number;
  appVersion?: string;
  environment?: string;
  fileLayout: DebugSessionFileLayout;
  retention: DebugSessionRetention;
};

export type DebugSessionFileLayout = {
  rootDir: string;
  manifestFile: string;
  summaryFile: string;
  timelineFile: string;
  systemFile: string;
};

export type DebugSessionRetention = {
  maxTimelineBytes: number;
  maxSystemBytes: number;
};

export const DEBUG_SESSION_FILES = {
  manifest: "debug-session.json",
  summary: "summary.json",
  timeline: "timeline.jsonl",
  system: "system.jsonl",
} as const;

export const DEBUG_DEFAULT_RETENTION: DebugSessionRetention = {
  maxTimelineBytes: 2_000_000,
  maxSystemBytes: 2_000_000,
};

export type DebugRedactionReason =
  | "secret"
  | "credential"
  | "token"
  | "cookie"
  | "key"
  | "payload"
  | "privacy";

export type DebugRedactedValue = {
  redacted: true;
  reason: DebugRedactionReason;
  preview?: string;
};

export const DEBUG_REDACTED = "[redacted]";

export function redactValue(reason: DebugRedactionReason, preview?: string): DebugRedactedValue {
  const safePreview = preview && preview.length > 60 ? `${preview.slice(0, 57)}...` : preview;
  return { redacted: true, reason, preview: safePreview };
}

const SECRET_KEY_PATTERN =
  /(token|secret|api[_-]?key|password|cookie|authorization|auth|bearer|session|private|client[_-]?secret|access[_-]?key|refresh|mcp|credential)/i;

const MAX_STRING_LENGTH = 1600;
const MAX_OBJECT_DEPTH = 5;
const MAX_OBJECT_KEYS = 60;

const asString = (value: unknown) => (typeof value === "string" ? value : "");

const truncate = (value: string, max = MAX_STRING_LENGTH) =>
  value.length > max ? `${value.slice(0, Math.max(0, max - 3))}...` : value;

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

export function redactString(value: string, reason: DebugRedactionReason): DebugRedactedValue {
  return redactValue(reason, truncate(value));
}

export function redactHeaders(headers?: Record<string, string>): Record<string, string | DebugRedactedValue> | undefined {
  if (!headers) return undefined;
  const entries = Object.entries(headers);
  if (!entries.length) return undefined;
  const next: Record<string, string | DebugRedactedValue> = {};
  for (const [key, value] of entries) {
    if (SECRET_KEY_PATTERN.test(key)) {
      next[key] = redactValue("token");
    } else if (typeof value === "string" && /bearer\s+/i.test(value)) {
      next[key] = redactValue("token");
    } else {
      next[key] = truncate(String(value));
    }
  }
  return next;
}

export function redactRecord(
  input: Record<string, unknown>,
  options: { depth?: number } = {},
): Record<string, unknown> {
  const depth = options.depth ?? 0;
  if (depth > MAX_OBJECT_DEPTH) return { truncated: true };

  const entries = Object.entries(input);
  const next: Record<string, unknown> = {};
  const limited = entries.slice(0, MAX_OBJECT_KEYS);
  for (const [key, value] of limited) {
    if (SECRET_KEY_PATTERN.test(key)) {
      next[key] = redactValue("secret");
      continue;
    }
    next[key] = redactUnknown(value, { depth: depth + 1 });
  }

  if (entries.length > MAX_OBJECT_KEYS) {
    next.__truncated = entries.length - MAX_OBJECT_KEYS;
  }

  return next;
}

export function redactUnknown(
  value: unknown,
  options: { depth?: number } = {},
): unknown {
  const depth = options.depth ?? 0;
  if (depth > MAX_OBJECT_DEPTH) return { truncated: true };

  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (/bearer\s+/i.test(value)) return redactValue("token");
    if (value.length > MAX_STRING_LENGTH) return truncate(value);
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_OBJECT_KEYS).map((item) => redactUnknown(item, { depth: depth + 1 }));
  }
  if (isPlainObject(value)) {
    return redactRecord(value, { depth });
  }
  try {
    return truncate(String(value));
  } catch {
    return redactValue("payload");
  }
}

export function sanitizePayload(payload?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!payload) return undefined;
  return redactRecord(payload);
}

type DebugGate = {
  enabled: () => boolean;
};

let debugGate: DebugGate | null = null;
let debugSessionProvider: { get: () => DebugSessionManifest | null } | null = null;
let activeCorrelationId: string | null = null;

export function setDebugGate(gate: DebugGate | null) {
  debugGate = gate;
}

export function setDebugSessionProvider(provider: { get: () => DebugSessionManifest | null } | null) {
  debugSessionProvider = provider;
}

export function isDebugLoggingEnabled(): boolean {
  return debugGate?.enabled() ?? false;
}

export function getActiveDebugSession(): DebugSessionManifest | null {
  return debugSessionProvider?.get() ?? null;
}

export function setActiveCorrelationId(value: string | null) {
  activeCorrelationId = value;
}

export function getActiveCorrelationId(): string | null {
  return activeCorrelationId;
}

function resolveCryptoId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const random = Math.random().toString(16).slice(2);
  return `${Date.now().toString(16)}-${random}`;
}

export function createDebugSessionId() {
  return `dbg_${resolveCryptoId()}`;
}

export function createDebugCorrelationId() {
  return `corr_${resolveCryptoId()}`;
}

export function createDebugEventId() {
  return `evt_${resolveCryptoId()}`;
}

export function buildDebugEventBase(input: {
  kind: DebugEventKind;
  debugSessionId: string;
  correlationId?: string;
  surface: string;
  action: string;
  entity?: DebugEventBase["entity"];
  payload?: Record<string, unknown>;
}) {
  const now = new Date();
  return {
    kind: input.kind,
    id: createDebugEventId(),
    at: now.toISOString(),
    ts: now.getTime(),
    debugSessionId: input.debugSessionId,
    correlationId: input.correlationId,
    surface: input.surface,
    action: input.action,
    entity: input.entity,
    payload: sanitizePayload(input.payload),
  } satisfies DebugEventBase;
}
