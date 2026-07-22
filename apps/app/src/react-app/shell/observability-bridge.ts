import {
  applyObservabilityContentPolicy,
  redactObservabilityValue,
  type ObservabilityContent,
  type ObservabilityContentMode,
  type ObservabilityEventInput,
  type ObservabilityLevel,
  type ObservabilityScope,
} from "@openwork/observability";

export type RendererObservationTransport = (
  events: ObservabilityEventInput[],
) => void | Promise<void>;

export type RendererObservationBridge = {
  configure: (input: {
    enabled: boolean;
    transport?: RendererObservationTransport;
    onDropped?: (count: number) => void;
    content?: ObservabilityContentMode;
    level?: ObservabilityLevel;
    scopes?: ObservabilityScope[];
  }) => void;
  record: (event: ObservabilityEventInput | (() => ObservabilityEventInput)) => void;
  flush: () => Promise<void>;
  pendingCount: () => number;
  droppedCount: () => number;
  resetDropped: () => void;
};

const DEFAULT_MAX_PENDING = 250;
const DEFAULT_FLUSH_DELAY_MS = 100;
// The server rejects observability requests above 4 MiB. Leave a full MiB of
// headroom for the JSON wrapper and any transport-layer evolution.
export const RENDERER_OBSERVABILITY_TRANSPORT_MAX_BYTES = 3 * 1024 * 1024;

const JSON_ENCODER = new TextEncoder();
const EVENT_BATCH_PREFIX_BYTES = JSON_ENCODER.encode('{"events":[').byteLength;
const EVENT_BATCH_SUFFIX_BYTES = JSON_ENCODER.encode("]}").byteLength;

function serializedEventBytes(event: ObservabilityEventInput): number | null {
  try {
    const serialized = JSON.stringify(event);
    return typeof serialized === "string"
      ? JSON_ENCODER.encode(serialized).byteLength
      : null;
  } catch {
    return null;
  }
}

function partitionTransportBatches(
  events: ObservabilityEventInput[],
  maxBytes: number,
): { batches: ObservabilityEventInput[][]; dropped: number } {
  const batches: ObservabilityEventInput[][] = [];
  let current: ObservabilityEventInput[] = [];
  let currentBytes = EVENT_BATCH_PREFIX_BYTES + EVENT_BATCH_SUFFIX_BYTES;
  let dropped = 0;

  for (const event of events) {
    const eventBytes = serializedEventBytes(event);
    if (eventBytes === null || EVENT_BATCH_PREFIX_BYTES + eventBytes + EVENT_BATCH_SUFFIX_BYTES > maxBytes) {
      dropped += 1;
      continue;
    }
    const separatorBytes = current.length === 0 ? 0 : 1;
    if (current.length > 0 && currentBytes + separatorBytes + eventBytes > maxBytes) {
      batches.push(current);
      current = [];
      currentBytes = EVENT_BATCH_PREFIX_BYTES + EVENT_BATCH_SUFFIX_BYTES;
    }
    current.push(event);
    currentBytes += (current.length === 1 ? 0 : 1) + eventBytes;
  }

  if (current.length > 0) batches.push(current);
  return { batches, dropped };
}

function contentForMode(
  content: ObservabilityContent,
  mode: ObservabilityContentMode,
): ObservabilityContent {
  if (mode === "metadata") return applyObservabilityContentPolicy(content, mode);
  if (mode === "hash" && typeof content.hash === "string") {
    return applyObservabilityContentPolicy(content, mode);
  }
  let serialized = "";
  try {
    serialized = JSON.stringify(content.value) ?? "";
  } catch {
    serialized = "[unserializable]";
  }
  return applyObservabilityContentPolicy({
    ...content,
    hash: content.hash ?? hashString(serialized),
    length: content.length ?? serialized.length,
    complete: content.complete ?? true,
    truncated: content.truncated ?? false,
  }, mode);
}

/** A bounded, failure-isolated batching bridge for non-React runtime code. */
export function createRendererObservationBridge(input: {
  maxPending?: number;
  flushDelayMs?: number;
  maxTransportBytes?: number;
} = {}): RendererObservationBridge {
  const maxPending = Math.max(1, Math.trunc(input.maxPending ?? DEFAULT_MAX_PENDING));
  const flushDelayMs = Math.max(0, Math.trunc(input.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS));
  const maxTransportBytes = Math.max(
    128,
    Math.trunc(input.maxTransportBytes ?? RENDERER_OBSERVABILITY_TRANSPORT_MAX_BYTES),
  );
  let enabled = false;
  let transport: RendererObservationTransport | undefined;
  let onDropped: ((count: number) => void) | undefined;
  let contentMode: ObservabilityContentMode = "metadata";
  let minimumLevel: ObservabilityLevel = "info";
  let scopeFilter: Set<ObservabilityScope> | null = null;
  let pending: ObservabilityEventInput[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let flushing = false;
  let dropped = 0;

  const recordDropped = (count: number) => {
    if (count <= 0) return;
    dropped += count;
    onDropped?.(dropped);
  };

  const schedule = () => {
    if (timer || flushing || !enabled || !transport || pending.length === 0) return;
    timer = setTimeout(() => {
      timer = null;
      void bridge.flush();
    }, flushDelayMs);
  };

  const bridge: RendererObservationBridge = {
    configure(next) {
      enabled = next.enabled;
      transport = next.transport;
      onDropped = next.onDropped;
      contentMode = next.content ?? "metadata";
      minimumLevel = next.level ?? "info";
      scopeFilter = next.scopes === undefined ? null : new Set(next.scopes);
      if (!enabled) {
        if (timer) clearTimeout(timer);
        timer = null;
        pending = [];
        return;
      }
      schedule();
    },
    record(input) {
      if (!enabled || !transport) return;
      if (scopeFilter?.size === 0) return;
      let event: ObservabilityEventInput;
      try {
        event = typeof input === "function" ? input() : input;
      } catch {
        recordDropped(1);
        return;
      }
      const levelPriority = { debug: 10, info: 20, warn: 30, error: 40 } as const;
      if (scopeFilter && !scopeFilter.has(event.scope)) return;
      if (levelPriority[event.level] < levelPriority[minimumLevel]) return;
      const content = event.content === undefined
        ? undefined
        : contentForMode(event.content, contentMode);

      pending.push({
        ...event,
        source: redactObservabilityValue(event.source) as ObservabilityEventInput["source"],
        ...(event.context === undefined
          ? {}
          : { context: redactObservabilityValue(event.context) }),
        ...(event.cause === undefined ? {} : { cause: redactObservabilityValue(event.cause) }),
        ...(event.data === undefined ? {} : { data: redactObservabilityValue(event.data) }),
        ...(content === undefined ? {} : { content }),
      });
      if (pending.length > maxPending) {
        const overflow = pending.length - maxPending;
        pending.splice(0, overflow);
        recordDropped(overflow);
      }
      schedule();
    },
    async flush() {
      if (flushing || !enabled || !transport || pending.length === 0) return;
      flushing = true;
      const batch = pending;
      pending = [];
      try {
        const partitioned = partitionTransportBatches(batch, maxTransportBytes);
        recordDropped(partitioned.dropped);
        const activeTransport = transport;
        for (let index = 0; index < partitioned.batches.length; index += 1) {
          const transportBatch = partitioned.batches[index]!;
          if (!enabled || transport !== activeTransport) {
            recordDropped(
              partitioned.batches
                .slice(index)
                .reduce((total, remaining) => total + remaining.length, 0),
            );
            break;
          }
          try {
            await activeTransport(transportBatch);
          } catch {
            // Observability must never break or stall the runtime being observed.
            recordDropped(transportBatch.length);
          }
        }
      } finally {
        flushing = false;
        schedule();
      }
    },
    pendingCount: () => pending.length,
    droppedCount: () => dropped,
    resetDropped() {
      dropped = 0;
      onDropped?.(0);
    },
  };

  return bridge;
}

const rendererObservationBridge = createRendererObservationBridge();

export function configureRendererObservationBridge(input: {
  enabled: boolean;
  transport?: RendererObservationTransport;
  onDropped?: (count: number) => void;
  content?: ObservabilityContentMode;
  level?: ObservabilityLevel;
  scopes?: ObservabilityScope[];
}) {
  rendererObservationBridge.configure(input);
}

export function recordRendererObservation(event: ObservabilityEventInput | (() => ObservabilityEventInput)) {
  rendererObservationBridge.record(event);
}

export function resetRendererObservationBridgeDroppedCount() {
  rendererObservationBridge.resetDropped();
}

function rawEventPayload(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (record.payload && typeof record.payload === "object") {
    return record.payload as Record<string, unknown>;
  }
  return record;
}

function rawEventType(raw: unknown) {
  const record = rawEventPayload(raw);
  return typeof record?.type === "string" ? record.type : "unknown";
}

function rawEventDirectory(raw: unknown) {
  if (!raw || typeof raw !== "object") return undefined;
  const directory = (raw as Record<string, unknown>).directory;
  return typeof directory === "string" ? directory : undefined;
}

function containsError(raw: unknown) {
  const payload = rawEventPayload(raw);
  const properties = payload?.properties;
  return Boolean(
    properties &&
      typeof properties === "object" &&
      "error" in (properties as Record<string, unknown>),
  );
}

function rawToolMetadata(raw: unknown): {
  toolName?: string;
  callId?: string;
  status?: string;
} | null {
  const payload = rawEventPayload(raw);
  const properties = payload?.properties;
  if (!properties || typeof properties !== "object") return null;
  const part = (properties as Record<string, unknown>).part;
  if (!part || typeof part !== "object") return null;
  const record = part as Record<string, unknown>;
  if (record.type !== "tool") return null;
  const state = record.state && typeof record.state === "object"
    ? record.state as Record<string, unknown>
    : null;
  return {
    ...(typeof record.tool === "string" ? { toolName: record.tool } : {}),
    ...(typeof record.callID === "string" ? { callId: record.callID } : {}),
    ...(typeof state?.status === "string" ? { status: state.status } : {}),
  };
}

function hashString(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function contentEnvelope(raw: unknown) {
  return {
    kind: "opencode-sse-event",
    // The server-side journal applies metadata/hash/full policy before an
    // event is retained or returned. Keeping the payload solely in content
    // prevents it from leaking into always-visible metadata.
    value: raw,
  };
}

export function formatSessionSyncObservation(input: {
  phase: "start" | "connected" | "event" | "error" | "closed";
  workspaceId: string;
  raw?: unknown;
  error?: unknown;
  reason?: string;
}): ObservabilityEventInput {
  const eventType = input.phase === "event" ? rawEventType(input.raw) : undefined;
  const tool = input.phase === "event" ? rawToolMetadata(input.raw) : null;
  const scope: ObservabilityScope = eventType?.startsWith("mcp.")
    ? "mcp"
    : tool
      ? "tool"
      : "event";
  const level: ObservabilityLevel = input.phase === "error"
    || eventType?.includes("error")
    || tool?.status === "error"
    ? "error"
    : containsError(input.raw)
      ? "warn"
      : "info";
  const directory = rawEventDirectory(input.raw);

  return {
    level,
    scope,
    action: input.phase === "event"
      ? tool
        ? "tool.state.changed"
        : eventType?.startsWith("mcp.")
          ? "mcp.event"
          : "sse.event"
      : `sse.subscribe.${input.phase}`,
    source: {
      runtime: "renderer",
      component: "session-sync",
      instanceId: input.workspaceId,
    },
    data: {
      operation: "opencode-event-stream",
      workspaceId: input.workspaceId,
      ...(directory ? { directory } : {}),
      ...(eventType ? { type: eventType } : {}),
      ...(tool?.toolName ? { toolName: tool.toolName } : {}),
      ...(tool?.callId ? { callId: tool.callId } : {}),
      ...(tool?.status ? { status: tool.status } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    },
    ...(input.error === undefined ? {} : { cause: input.error }),
    ...(input.phase === "event" ? { content: contentEnvelope(input.raw) } : {}),
  };
}
