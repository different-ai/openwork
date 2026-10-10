import { nativeDiscoveryCode } from "./openwork-codemode-discovery-v2.js";

type Registration = { dispose(): Promise<void> };
type CallEvent = { readonly tool: string; readonly messageID: string; readonly id: string };
type ToolResult = { output?: unknown; content?: unknown; metadata?: Record<string, unknown> };
type ToolCall = { readonly messageID: string; readonly id: string; progress(metadata: Record<string, unknown>): Promise<void> };
type EditableTool = { execute(input: unknown, call: ToolCall): Promise<ToolResult> };
type ExecuteAfter = CallEvent & { readonly input: unknown } & (
  | { readonly status: "completed"; result: { output?: unknown; metadata?: Record<string, unknown> } }
  | { readonly status: "error"; readonly error: unknown }
);
type Context = {
  tool: {
    transform(callback: (editor: {
      get(id: string): unknown;
      list(): readonly { id: string }[];
      update(id: string, update: (tool: EditableTool) => void): void;
    }) => void): Promise<Registration>;
    hook(name: "execute.before", callback: (event: CallEvent & { input: unknown }) => void): Promise<Registration>;
    hook(name: "execute.after", callback: (event: ExecuteAfter) => void): Promise<Registration>;
  };
};

/** One OpenWork Cloud call made inside a Code Mode `execute`, kept because it reports a connection or an App build. */
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
    return value === undefined ? {} : JSON.parse(JSON.stringify(value));
  } catch {
    return {};
  }
}

/** Object keys in a stable order, so a decoded copy of an input compares equal. */
function stableJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value, (_key, entry: unknown) => isRecord(entry)
      ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
  } catch {
    return undefined;
  }
}

/** Code Mode reports inner calls as `openwork-cloud.create_app`; older engines used `_`. */
function normalizedTool(tool: string): string {
  return tool.replace(/^(openwork(?:-cloud)?)\./, "$1_");
}

export function preservedEntry(rawEvent: ExecuteAfter): PreservedMcpResult | null {
  const event = { ...rawEvent, tool: normalizedTool(rawEvent.tool) };
  if (!OPENWORK_CLOUD_TOOL.test(event.tool)) return null;
  const appBuilder = /_(?:search_capabilities|prepare_app|create_app|update_app)$/.test(event.tool);
  const appLaunch = event.status === "completed" && isRecord(event.result.output) && isRecord(event.result.output.launch);
  const input = jsonCopy(event.input);
  const entry: PreservedMcpResult | null = event.status === "completed"
    ? (appBuilder || appLaunch || reportsConnection(event.result.output)) ? { tool: event.tool, input, status: "completed", output: jsonCopy(event.result.output) } : null
    : (appBuilder || reportsConnection(parseRecord(errorText(event.error)))) ? { tool: event.tool, input, status: "error", error: errorText(event.error) } : null;
  if (!entry) return null;
  return new TextEncoder().encode(JSON.stringify(entry)).byteLength <= MAX_ENTRY_BYTES ? entry : null;
}

/** One inner Code Mode call with its own result, kept so a person can inspect it after reload. */
export type ToolDetail = {
  invocationId: string; ordinal: number; tool: string; input?: unknown;
  status: "running" | "completed" | "error"; startedAt: number; endedAt?: number;
  output?: unknown; error?: string; truncated?: boolean;
};

const MAX_EXECUTION_BYTES = 1_024 * 1_024;
const MAX_DETAIL_CALLS = 256;
const TRUNCATED = "[Result truncated by OpenWork]";
const encoder = new TextEncoder();
const byteLength = (value: unknown) => encoder.encode(JSON.stringify(value) ?? "").byteLength;

/** A JSON copy that fits the budget, or a marked text preview of it. */
function bounded(value: unknown, budget: number): { value: unknown; bytes: number; truncated: boolean } {
  if (value === undefined) return { value: undefined, bytes: 0, truncated: false };
  if (budget < 128) return { value: undefined, bytes: 0, truncated: true };
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = undefined;
  }
  if (serialized === undefined) return { value: undefined, bytes: 0, truncated: true };
  const bytes = encoder.encode(serialized).byteLength;
  if (bytes <= budget) return { value: JSON.parse(serialized) as unknown, bytes, truncated: false };
  // Six bytes per code unit bounds UTF-8 plus JSON escaping of the preview.
  const preview = `${serialized.slice(0, Math.max(0, Math.floor((budget - 128) / 6)))}\n${TRUNCATED}`;
  return { value: preview, bytes: byteLength(preview), truncated: true };
}

type Execution = {
  connections: PreservedMcpResult[];
  calls: ToolDetail[];
  remaining: number;
  nextOrdinal: number;
  truncated: boolean;
  allowance: WeakMap<ToolDetail, number>;
  rawInputs: WeakMap<ToolDetail, unknown>;
  inputKeys: WeakMap<ToolDetail, string>;
  claimed: Set<string>;
};

/**
 * The v2 counterpart of the v1 `preserveMcpResult` hook. Code Mode runs MCP
 * calls inside one `execute` and keeps only `{ tool, status, input }` per call.
 * Inner calls fire `execute.before`/`execute.after` with the outer call's
 * `messageID` and `id`; keep each call's own bounded result
 * (`openworkToolDetails`) and the ones that report a connection or an App build
 * (`openworkMcpResults`) on the outer call's metadata, which the engine saves.
 */
export function createMcpResultsCollector() {
  const open = new Map<string, Execution>();
  const key = (event: Pick<CallEvent, "messageID" | "id">) => `${event.messageID}\u0000${event.id}`;

  function settle(execution: Execution, detail: ToolDetail, outcome: { status: "completed"; output: unknown } | { status: "error"; error: string }): void {
    if (detail.status !== "running") return;
    const result = bounded(outcome.status === "completed" ? outcome.output : outcome.error,
      Math.min(MAX_ENTRY_BYTES / 2, execution.allowance.get(detail) ?? 0, execution.remaining));
    execution.remaining -= result.bytes;
    detail.status = outcome.status;
    detail.endedAt = Date.now();
    if (result.truncated) detail.truncated = true;
    if (result.value !== undefined) {
      if (outcome.status === "completed") detail.output = result.value;
      else detail.error = String(result.value);
    }
  }

  return {
    before(event: CallEvent & { input?: unknown }): void {
      if (event.tool === "execute") {
        if (open.size >= MAX_OPEN_CALLS) {
          const oldest = open.keys().next().value;
          if (oldest !== undefined) open.delete(oldest);
        }
        // Reserve room for the surrounding metadata keys and arrays.
        open.set(key(event), { connections: [], calls: [], remaining: MAX_EXECUTION_BYTES - 256, nextOrdinal: 0, truncated: false,
          allowance: new WeakMap(), rawInputs: new WeakMap(), inputKeys: new WeakMap(), claimed: new Set() });
        return;
      }
      const execution = open.get(key(event));
      if (!execution) return;
      const ordinal = execution.nextOrdinal++;
      if (execution.calls.length >= MAX_DETAIL_CALLS) { execution.truncated = true; return; }
      const detail: ToolDetail = { invocationId: `${event.id}:${ordinal}`, ordinal, tool: normalizedTool(event.tool), status: "running", startedAt: Date.now() };
      // Count each entry's envelope as well: many small calls must not exceed the cap.
      const envelope = byteLength(detail) + 128;
      if (envelope > execution.remaining) { execution.truncated = true; return; }
      execution.remaining -= envelope;
      const input = bounded(event.input, Math.min(MAX_ENTRY_BYTES / 2, execution.remaining));
      execution.remaining -= input.bytes;
      if (input.value !== undefined) detail.input = input.value;
      if (input.truncated) detail.truncated = true;
      execution.allowance.set(detail, MAX_ENTRY_BYTES - envelope - input.bytes);
      execution.rawInputs.set(detail, event.input);
      const inputKey = input.truncated ? undefined : stableJson(event.input);
      if (inputKey !== undefined) execution.inputKeys.set(detail, inputKey);
      execution.calls.push(detail);
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
      // The hook sees the same input object as `execute.before`. Matching by
      // tool name alone would cross-wire parallel repeated calls.
      const tool = normalizedTool(event.tool);
      const matching = execution.calls.filter(call => call.status === "running" && call.tool === tool && execution.rawInputs.get(call) === event.input);
      if (matching.length === 1) settle(execution, matching[0]!, event.status === "completed"
        ? { status: "completed", output: event.result.output } : { status: "error", error: errorText(event.error) });
      if (execution.connections.length >= MAX_ENTRIES) return;
      const entry = preservedEntry(event);
      if (!entry) return;
      const bytes = byteLength(entry) + 1;
      if (bytes <= execution.remaining) {
        execution.connections.push(entry);
        execution.remaining -= bytes;
      }
    },
    /**
     * Identify the call a tool's own `execute` is running. The engine decodes
     * the input first, so fall back from identity to the only running call of
     * that tool, then to an equal input; anything ambiguous stays unclaimed.
     */
    claim(event: CallEvent & { input?: unknown }): string | undefined {
      const execution = open.get(key(event));
      if (!execution) return undefined;
      const tool = normalizedTool(event.tool);
      const running = execution.calls.filter(call => call.tool === tool && call.status === "running" && !execution.claimed.has(call.invocationId));
      const inputKey = stableJson(event.input);
      const candidates = [
        running.filter(call => execution.rawInputs.get(call) === event.input),
        running,
        running.filter(call => inputKey !== undefined && execution.inputKeys.get(call) === inputKey),
      ].find(list => list.length === 1);
      const claimed = candidates?.[0];
      if (!claimed) return undefined;
      execution.claimed.add(claimed.invocationId);
      return claimed.invocationId;
    },
    /** Settle a claimed call from its tool's own `execute`, before `execute.after`. */
    settle(event: Pick<CallEvent, "messageID" | "id">, invocationId: string, outcome: { status: "completed"; output: unknown } | { status: "error"; error: string }): void {
      const execution = open.get(key(event));
      const detail = execution?.calls.find(call => call.invocationId === invocationId);
      if (execution && detail) settle(execution, detail, outcome);
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
    let rootSearch = false;
    const catalog = await context.tool.transform(editor => {
      rootSearch = editor.get("search") !== undefined;
      // Wrap each tool so a Code Mode call publishes its start and its own
      // result while the script is still running, not only at completion.
      for (const info of editor.list()) {
        if (info.id === "execute") continue;
        editor.update(info.id, tool => {
          const execute = tool.execute;
          tool.execute = async (input, call) => {
            const event = { tool: info.id, messageID: call.messageID, id: call.id, input };
            const invocationId = collector.claim(event);
            if (invocationId === undefined) return execute(input, call);
            const publish = async () => {
              await call.progress({ openworkToolDetails: collector.details(event) }).catch(() => {});
            };
            await publish();
            try {
              const result = await execute(input, call);
              collector.settle(event, invocationId, { status: "completed", output: result.output ?? result.content });
              await publish();
              return result;
            } catch (error) {
              collector.settle(event, invocationId, { status: "error", error: errorText(error) });
              await publish();
              throw error;
            }
          };
        });
      }
    });
    const before = await context.tool.hook("execute.before", event => {
      if (!rootSearch && event.tool === "execute" && isRecord(event.input) && typeof event.input.code === "string") {
        event.input = { ...event.input, code: nativeDiscoveryCode(event.input.code) };
      }
      collector.before(event);
    });
    const after = await context.tool.hook("execute.after", event => collector.after(event));
    return async () => {
      await before.dispose();
      await after.dispose();
      await catalog.dispose();
    };
  },
};
