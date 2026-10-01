type Registration = { dispose(): Promise<void> };
type CallEvent = { readonly tool: string; readonly messageID: string; readonly id: string; readonly input?: unknown; readonly invocationId?: string };
type ExecuteAfter = CallEvent & { readonly input: unknown } & (
  | { readonly status: "completed"; result: { output?: unknown; metadata?: Record<string, unknown> } }
  | { readonly status: "error"; readonly error: unknown }
);
type Context = {
  tool: {
    transform?(callback: (editor: {
      list(): readonly { id: string; name: string }[];
      update(id: string, update: (tool: { execute(input: unknown, call: CallEvent & { progress(metadata: Record<string, unknown>): Promise<void> }): Promise<{ output?: unknown; content?: unknown; metadata?: Record<string, unknown> }> }) => void): void;
    }) => void): Promise<Registration>;
    hook(name: "execute.before", callback: (event: CallEvent) => void): Promise<Registration>;
    hook(name: "execute.after", callback: (event: ExecuteAfter) => void): Promise<Registration>;
  };
};

/** One OpenWork Cloud call made inside a Code Mode `execute`, kept because it reports a connection. */
export type PreservedMcpResult =
  | { tool: string; input: unknown; status: "completed"; output: unknown }
  | { tool: string; input: unknown; status: "error"; error: string };

const OPENWORK_CLOUD_TOOL = /^(?:openwork|openwork-cloud)_/;
const MAX_ENTRY_BYTES = 64 * 1_024;
const MAX_ENTRIES = 20;
const MAX_OPEN_CALLS = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRecord(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start || end - start > MAX_ENTRY_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The same shapes the chat's connection card reads (`connectionResultFromChatToolPart`). */
export function reportsConnection(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if ("connectionStatus" in value || "connectionAction" in value) return true;
  if (typeof value.connectionId === "string" && typeof value.state === "string") return true;
  return Array.isArray(value.matches) && value.matches.some(match => isRecord(match) && typeof match.connectionId === "string");
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  return String(error);
}

function jsonCopy(value: unknown): unknown {
  try {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

export function preservedEntry(event: ExecuteAfter): PreservedMcpResult | null {
  // Discovery results only become a card when a connection decision is bound to
  // that exact call (v1), which Code Mode calls cannot have; keeping them would
  // only duplicate the inner row.
  if (!OPENWORK_CLOUD_TOOL.test(event.tool) || event.tool.endsWith("_search_capabilities")) return null;
  const input = jsonCopy(event.input);
  const entry: PreservedMcpResult | null = event.status === "completed"
    ? reportsConnection(event.result.output) ? { tool: event.tool, input, status: "completed", output: jsonCopy(event.result.output) } : null
    : reportsConnection(parseRecord(errorText(event.error))) ? { tool: event.tool, input, status: "error", error: errorText(event.error) } : null;
  if (!entry) return null;
  return new TextEncoder().encode(JSON.stringify(entry)).byteLength <= MAX_ENTRY_BYTES ? entry : null;
}

/**
 * The v2 counterpart of the v1 `preserveMcpResult` hook. Code Mode runs MCP
 * calls inside one `execute` and keeps only `{ tool, status, input }` per call,
 * so a connection that needs sign-in never reaches the chat. Inner calls fire
 * `execute.after` with the outer call's `messageID` and `id`; collect the ones
 * that report a connection and attach them to the outer call's metadata, which
 * the engine persists with the tool part.
 */
export type ToolDetail = {
  invocationId: string; ordinal: number; tool: string; input: unknown;
  status: "running" | "completed" | "error"; startedAt: number; endedAt?: number;
  output?: unknown; error?: string; truncated?: boolean;
};
const MAX_EXECUTION_BYTES = 1_024 * 1_024;
const MAX_DETAIL_CALLS = 256;
const encoder = new TextEncoder();

/** Bounds payloads, preserving identities and explicit unavailable/truncated detail. */
function bounded(value: unknown, budget: number): { value: unknown; bytes: number; truncated: boolean } {
  if (value === undefined) return { value: undefined, bytes: 0, truncated: false };
  if (budget < 128) return { value: undefined, bytes: 0, truncated: true };
  const copy = jsonCopy(value);
  if (copy === undefined) return { value: undefined, bytes: 0, truncated: true };
  const serialized = JSON.stringify(copy);
  const bytes = encoder.encode(serialized).byteLength;
  if (bytes <= budget) return { value: copy, bytes, truncated: false };
  const marker = "[Result truncated by OpenWork]";
  // Three UTF-8 bytes per code unit is a conservative bound, including JSON escaping.
  const preview = serialized.slice(0, Math.max(0, Math.floor((budget - 128) / 6)));
  const valuePreview = `${preview}\n${marker}`;
  return { value: valuePreview, bytes: encoder.encode(JSON.stringify(valuePreview)).byteLength, truncated: true };
}

export function createMcpResultsCollector() {
  const open = new Map<string, { connections: PreservedMcpResult[]; calls: ToolDetail[]; remaining: number; nextOrdinal: number; truncated: boolean; allowance: WeakMap<ToolDetail, number>; inputs: WeakMap<object, ToolDetail[]>; claimed: Set<string>; connectionsSeen: WeakSet<object> }>();
  const key = (event: Pick<CallEvent, "messageID" | "id">) => `${event.messageID}\u0000${event.id}`;
  return {
    before(event: CallEvent): void {
      if (event.tool === "execute") {
        if (open.size >= MAX_OPEN_CALLS) {
          const oldest = open.keys().next().value;
          if (oldest !== undefined) open.delete(oldest);
        }
        // Reserve the surrounding metadata keys and arrays as well as values.
        open.set(key(event), { connections: [], calls: [], remaining: MAX_EXECUTION_BYTES - 256, nextOrdinal: 0, truncated: false, allowance: new WeakMap(), inputs: new WeakMap(), claimed: new Set(), connectionsSeen: new WeakSet() });
        return;
      }
      const execution = open.get(key(event));
      if (!execution) return;
      const ordinal = execution.nextOrdinal++;
      // Keep the native list as the source of every call's identity. Detailed
      // payload collection is bounded independently, including empty calls.
      if (execution.calls.length >= MAX_DETAIL_CALLS) { execution.truncated = true; return; }
      const detail: ToolDetail = { invocationId: `${event.id}:${ordinal}`, ordinal, tool: event.tool,
        input: undefined, status: "running", startedAt: Date.now() };
      // Count each entry's envelope, separators and terminal fields. Bounding
      // only input/output permits arbitrarily many small calls to exceed 1 MiB.
      const envelopeBytes = encoder.encode(JSON.stringify(detail)).byteLength + 128;
      if (envelopeBytes > execution.remaining || envelopeBytes > MAX_ENTRY_BYTES) { execution.truncated = true; return; }
      execution.remaining -= envelopeBytes;
      const input = bounded(event.input, Math.min(MAX_ENTRY_BYTES / 2, MAX_ENTRY_BYTES - envelopeBytes, execution.remaining));
      execution.remaining -= input.bytes;
      detail.input = input.value;
      if (input.truncated) detail.truncated = true;
      execution.allowance.set(detail, MAX_ENTRY_BYTES - envelopeBytes - input.bytes);
      execution.calls.push(detail);
      if (event.input && typeof event.input === "object") execution.inputs.set(event.input, [...(execution.inputs.get(event.input) ?? []), detail]);
    },
    after(event: ExecuteAfter): void {
      const execution = open.get(key(event));
      if (event.tool === "execute") {
        open.delete(key(event));
        if (event.status === "completed" && execution && (execution.connections.length || execution.calls.length || execution.truncated)) {
          event.result.metadata = { ...(event.result.metadata ?? {}),
            ...(execution.connections.length ? { openworkMcpResults: execution.connections } : {}),
            ...(execution.calls.length ? { openworkToolDetails: execution.calls } : {}),
            ...(execution.truncated ? { openworkToolDetailsTruncated: true } : {}) };
        }
        return;
      }
      if (!execution) return;
      // Matching by tool name alone would cross-wire parallel repeated calls.
      const candidates = event.input && typeof event.input === "object" ? execution.inputs.get(event.input) ?? [] : [];
      const detail = event.invocationId
        ? execution.calls.find(call => call.invocationId === event.invocationId)
        : candidates.length === 1 ? candidates[0] : undefined;
      if (detail && detail.status === "running" && detail.tool === event.tool) {
        const result = bounded(event.status === "completed" ? event.result.output : errorText(event.error),
          Math.min(MAX_ENTRY_BYTES / 2, execution.allowance.get(detail) ?? 0, execution.remaining));
        execution.remaining -= result.bytes;
        Object.assign(detail, { status: event.status, endedAt: Date.now(), truncated: detail.truncated || result.truncated,
          ...(result.value === undefined ? {} : event.status === "completed" ? { output: result.value } : { error: String(result.value) }) });
      }
      if (execution.connections.length < MAX_ENTRIES && !(event.input && typeof event.input === "object" && execution.connectionsSeen.has(event.input))) {
        if (event.input && typeof event.input === "object") execution.connectionsSeen.add(event.input);
        const entry = preservedEntry(event);
        if (entry) {
          const bytes = encoder.encode(JSON.stringify(entry)).byteLength + 1;
          if (bytes <= execution.remaining) { execution.connections.push(entry); execution.remaining -= bytes; }
        }
      }
    },
    claim(event: CallEvent): string | undefined {
      const execution = open.get(key(event));
      if (!execution || !event.input || typeof event.input !== "object") return undefined;
      const candidates = (execution.inputs.get(event.input) ?? []).filter(call =>
        call.tool === event.tool && call.status === "running" && !execution.claimed.has(call.invocationId));
      if (candidates.length !== 1) return undefined;
      execution.claimed.add(candidates[0]!.invocationId);
      return candidates[0]!.invocationId;
    },
    details(event: Pick<CallEvent, "messageID" | "id">): ToolDetail[] {
      return open.get(key(event))?.calls.map(call => ({ ...call })) ?? [];
    },
  };
}

export default {
  id: "openwork.mcp-results",
  async setup(context: Context) {
    const collector = createMcpResultsCollector();
    const before = await context.tool.hook("execute.before", event => collector.before(event));
    const after = await context.tool.hook("execute.after", event => collector.after(event));
    const transform = await context.tool.transform?.(editor => {
      for (const info of editor.list()) {
        if (info.name === "execute") continue;
        editor.update(info.id, tool => {
          const execute = tool.execute;
          tool.execute = async (input, call) => {
            const start = { ...call, tool: info.id, input };
            const event = { ...start, invocationId: collector.claim(start) };
            // Publish the native start while the connected call is still held.
            // Waiting until completion loses its live clock on history reload.
            const started = collector.details(event);
            if (started.length) await call.progress({ openworkToolDetails: started }).catch(() => {});
            try {
              const result = await execute(input, call);
              collector.after({ ...event, status: "completed", result: { output: result.output ?? result.content } });
              const details = collector.details(event);
              if (details.length) await call.progress({ openworkToolDetails: details }).catch(() => {});
              return result;
            } catch (error) {
              collector.after({ ...event, status: "error", error });
              const details = collector.details(event);
              if (details.length) await call.progress({ openworkToolDetails: details }).catch(() => {});
              throw error;
            }
          };
        });
      }
    });
    return async () => {
      await before.dispose();
      await after.dispose();
      await transform?.dispose();
    };
  },
};
