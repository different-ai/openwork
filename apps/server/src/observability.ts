import {
  OBSERVABILITY_LEVELS,
  OBSERVABILITY_SCOPES,
  createObservabilityJournal,
  type ObservabilityConfig,
  type ObservabilityEvent,
  type ObservabilityEventInput,
  type ObservabilityJournal,
  type ObservabilityLevel,
  type ObservabilityContentMode,
  type ObservabilityScope,
  type ObservabilitySnapshot,
  type ObservabilityStats,
  type ObservabilitySource,
} from "@openwork/observability";
import { randomBytes, timingSafeEqual } from "node:crypto";

const SOURCE_RUNTIMES = ["openwork-server", "opencode", "renderer"] as const;

export const DEFAULT_OBSERVABILITY_LEASE_MS = 30 * 60 * 1_000;

export interface ServerObservabilityController {
  configure(input: unknown): ObservabilityConfig;
  getConfig(): ObservabilityConfig;
  record(input: ObservabilityEventInput): ObservabilityEvent | undefined;
  recordUnknown(input: unknown): ObservabilityEvent | undefined;
  list(options?: { after?: number; limit?: number }): ObservabilityEvent[];
  clear(): void;
  heartbeat(): void;
  getCollectionEpoch(): number;
  stats(): ObservabilityStats;
  snapshot(): ObservabilitySnapshot;
  getInternalToken(): string;
  acceptsInternalToken(value: string | null): boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<const Values extends readonly string[]>(values: Values, value: unknown): value is Values[number] {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function normalizeSource(value: unknown): ObservabilitySource | null {
  if (!isRecord(value)) return null;
  const runtime = value.runtime;
  const component = boundedString(value.component, 256) ?? "";
  const instanceId = boundedString(value.instanceId, 256) ?? "";
  const operation = boundedString(value.operation, 512) ?? "";
  if (!isOneOf(SOURCE_RUNTIMES, runtime) || !component) return null;
  return {
    runtime,
    component,
    ...(instanceId ? { instanceId } : {}),
    ...(operation ? { operation } : {}),
  };
}

function boundedString(value: unknown, maxLength = 1_024): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

function knownContext(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, unknown> = {};
  for (const key of ["sessionId", "messageId", "agent", "directory", "workspaceId"] as const) {
    const item = boundedString(value[key]);
    if (item) result[key] = item;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function promptMetadata(value: unknown, includeHashes: boolean): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, unknown> = {};
  const status = boundedString(value.status, 32);
  const blockCount = nonNegativeInteger(value.blockCount);
  const totalLength = nonNegativeInteger(value.totalLength);
  const providerBoundary = boundedString(value.providerBoundary, 1_024);
  const factoryId = boundedString(value.factoryId, 256);
  const collectionEpoch = nonNegativeInteger(value.collectionEpoch);
  if (status) result.status = status;
  if (blockCount !== undefined) result.blockCount = blockCount;
  if (totalLength !== undefined) result.totalLength = totalLength;
  if (providerBoundary) result.providerBoundary = providerBoundary;
  if (factoryId) result.factoryId = factoryId;
  if (collectionEpoch !== undefined) result.collectionEpoch = collectionEpoch;
  for (const key of ["capturedBlockCount"] as const) {
    const item = nonNegativeInteger(value[key]);
    if (item !== undefined) result[key] = item;
  }
  for (const key of ["metadataTruncated", "changedIndicesComplete"] as const) {
    if (typeof value[key] === "boolean") result[key] = value[key];
  }
  if (includeHashes) {
    const promptHash = boundedString(value.promptHash, 256);
    const previousPromptHash = boundedString(value.previousPromptHash, 256);
    if (promptHash) result.promptHash = promptHash;
    if (previousPromptHash) result.previousPromptHash = previousPromptHash;
  }
  if (Array.isArray(value.changedIndices)) {
    result.changedIndices = value.changedIndices
      .map(nonNegativeInteger)
      .filter((item): item is number => item !== undefined)
      .slice(0, 10_000);
  }
  if (Array.isArray(value.blocks)) {
    result.blocks = value.blocks.slice(0, 10_000).flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const index = nonNegativeInteger(entry.index);
      const length = nonNegativeInteger(entry.length);
      const source = boundedString(entry.source, 256);
      if (index === undefined || length === undefined || !source) return [];
      const block: Record<string, unknown> = { index, length, source };
      if (includeHashes) {
        const hash = boundedString(entry.hash, 256);
        if (hash) block.hash = hash;
      }
      if (Array.isArray(entry.parts)) {
        block.parts = entry.parts.slice(0, 100).flatMap((part) => {
          if (!isRecord(part)) return [];
          const partSource = boundedString(part.source, 256);
          const partLength = nonNegativeInteger(part.length);
          if (!partSource || partLength === undefined) return [];
          const normalized: Record<string, unknown> = { source: partSource, length: partLength };
          if (includeHashes) {
            const hash = boundedString(part.hash, 256);
            if (hash) normalized.hash = hash;
          }
          return [normalized];
        });
      }
      return [block];
    });
  }
  return result;
}

function factoryMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, unknown> = {};
  for (const key of ["plugin", "factoryId", "position", "providerBoundary"] as const) {
    const item = boundedString(value[key], key === "providerBoundary" ? 1_024 : 256);
    if (item) result[key] = item;
  }
  const collectionEpoch = nonNegativeInteger(value.collectionEpoch);
  if (collectionEpoch !== undefined) result.collectionEpoch = collectionEpoch;
  return Object.keys(result).length > 0 ? result : undefined;
}

function rendererMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, unknown> = {};
  for (const key of [
    "operation",
    "workspaceId",
    "directory",
    "type",
    "reason",
    "toolName",
    "callId",
    "status",
  ] as const) {
    const item = boundedString(value[key]);
    if (item) result[key] = item;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function rendererCause(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const name = boundedString(value.name, 256);
  const message = boundedString(value.message, 2_048);
  return name || message ? { ...(name ? { name } : {}), ...(message ? { message } : {}) } : undefined;
}

/**
 * Whitelist the event envelope accepted from the renderer and managed engine.
 * The journal performs the recursive secret redaction and content-mode policy.
 */
export function normalizeObservabilityEventInput(
  input: unknown,
  contentMode: ObservabilityContentMode = "metadata",
): ObservabilityEventInput | null {
  if (!isRecord(input)) return null;
  const level = input.level;
  const scope = input.scope;
  const action = typeof input.action === "string" ? input.action.trim() : "";
  const source = normalizeSource(input.source);
  if (
    !isOneOf(OBSERVABILITY_LEVELS, level)
    || !isOneOf(OBSERVABILITY_SCOPES, scope)
    || !action
    || !source
  ) return null;

  const includeHashes = contentMode !== "metadata";
  let context: Record<string, unknown> | undefined;
  let cause: Record<string, unknown> | undefined;
  let data: Record<string, unknown> | undefined;
  if (source.runtime === "opencode") {
    if (source.component !== "openwork-observability") return null;
    context = knownContext(input.context);
    if (action === "plugin.factory.instantiated") {
      data = factoryMetadata(input.data);
    } else if (action === "system-prompt.snapshot" || action === "system-prompt.changed") {
      data = promptMetadata(input.data, includeHashes);
      if (includeHashes && isRecord(input.cause)) {
        const previousPromptHash = boundedString(input.cause.previousPromptHash, 256);
        if (previousPromptHash) cause = { previousPromptHash };
      }
    } else {
      return null;
    }
  } else if (source.runtime === "renderer") {
    if (
      source.component !== "session-sync"
      || (!action.startsWith("sse.") && action !== "tool.state.changed" && action !== "mcp.event")
    ) return null;
    data = rendererMetadata(input.data);
    cause = rendererCause(input.cause);
  } else {
    // Server-runtime observations are constructed in-process and use record(),
    // never the producer ingestion route.
    return null;
  }

  return {
    level: level as ObservabilityLevel,
    scope: scope as ObservabilityScope,
    action,
    source,
    ...(typeof input.observedAt === "string" ? { observedAt: input.observedAt } : {}),
    ...(context ? { context } : {}),
    ...(cause ? { cause } : {}),
    ...(data ? { data } : {}),
    ...(isRecord(input.content) ? { content: input.content } : {}),
  };
}

function changedConfigKeys(previous: ObservabilityConfig, next: ObservabilityConfig): string[] {
  const keys: Array<keyof ObservabilityConfig> = [
    "enabled",
    "level",
    "scopes",
    "console",
    "content",
    "maxEvents",
  ];
  return keys.filter((key) => JSON.stringify(previous[key]) !== JSON.stringify(next[key]));
}

function lifecycleInput(
  action: string,
  config: ObservabilityConfig,
  data: Record<string, unknown>,
): ObservabilityEventInput {
  return {
    level: config.level,
    scope: "lifecycle",
    action,
    source: { runtime: "openwork-server", component: "observability-controller" },
    data,
  };
}

export function createServerObservabilityController(
  initialConfig?: unknown,
  options: { leaseMs?: number } = {},
): ServerObservabilityController {
  const journal: ObservabilityJournal = createObservabilityJournal(initialConfig);
  const internalToken = randomBytes(32).toString("hex");
  let collectionEpoch = journal.getConfig().enabled ? 1 : 0;
  // This lease is a crash failsafe, not a renderer-liveness signal. Keep the
  // default long enough to survive background throttling, suspend/resume, and
  // debugger pauses while still eventually disabling an abandoned collector.
  const leaseMs = Math.max(50, Math.trunc(options.leaseMs ?? DEFAULT_OBSERVABILITY_LEASE_MS));
  let leaseExpiresAt = 0;
  let leaseTimer: ReturnType<typeof setTimeout> | null = null;

  const expireLease = () => {
    if (!journal.getConfig().enabled || Date.now() < leaseExpiresAt) return;
    journal.configure({ enabled: false });
    leaseExpiresAt = 0;
    leaseTimer = null;
  };
  const renewLease = () => {
    if (!journal.getConfig().enabled) return;
    leaseExpiresAt = Date.now() + leaseMs;
    if (leaseTimer) clearTimeout(leaseTimer);
    leaseTimer = setTimeout(expireLease, leaseMs + 10);
    leaseTimer.unref?.();
  };

  if (journal.getConfig().enabled) renewLease();

  return {
    configure(input) {
      const previous = journal.getConfig();
      // A disable transition must be recorded while the journal is still on.
      // Content is never attached to lifecycle events.
      const requestedEnabled = isRecord(input) ? input.enabled : undefined;
      if (previous.enabled && requestedEnabled === false) {
        journal.record(lifecycleInput("observability.disabled", previous, { enabled: false }));
      }

      const next = journal.configure(input);
      if (next.enabled) renewLease();
      else if (leaseTimer) {
        clearTimeout(leaseTimer);
        leaseTimer = null;
        leaseExpiresAt = 0;
      }
      const changed = changedConfigKeys(previous, next);
      if (!previous.enabled && next.enabled) {
        collectionEpoch += 1;
        journal.record(lifecycleInput("observability.enabled", next, {
          enabled: true,
          collectionEpoch,
          changed,
          content: next.content,
        }));
      } else if (previous.enabled && next.enabled && changed.length > 0) {
        journal.record(lifecycleInput("observability.config.changed", next, {
          changed,
          content: next.content,
        }));
      }
      return next;
    },

    getConfig() {
      expireLease();
      return journal.getConfig();
    },

    record(input) {
      expireLease();
      return journal.record(input);
    },

    recordUnknown(input) {
      expireLease();
      const normalized = normalizeObservabilityEventInput(input, journal.getConfig().content);
      if (normalized?.source.runtime === "opencode") {
        const epoch = isRecord(normalized.data)
          ? nonNegativeInteger(normalized.data.collectionEpoch)
          : undefined;
        // A plugin request can race an off/on transition. Never let a delayed
        // observation from an earlier collection window enter the new journal.
        if (epoch !== collectionEpoch) return undefined;
      }
      return normalized ? journal.record(normalized) : undefined;
    },

    list(options) {
      expireLease();
      return journal.list(options);
    },

    clear() {
      journal.clear();
    },

    heartbeat() {
      expireLease();
      renewLease();
    },

    getCollectionEpoch() {
      return collectionEpoch;
    },

    stats() {
      expireLease();
      return journal.stats();
    },

    snapshot() {
      expireLease();
      return journal.snapshot();
    },

    getInternalToken() {
      return internalToken;
    },

    acceptsInternalToken(value) {
      if (!value) return false;
      const expected = Buffer.from(internalToken);
      const candidate = Buffer.from(value);
      return candidate.length === expected.length && timingSafeEqual(candidate, expected);
    },
  };
}
