import { nativeDiscoveryCode } from "./openwork-codemode-discovery-v2.js";

type Registration = { dispose(): Promise<void> };
type CallEvent = { readonly tool: string; readonly messageID: string; readonly id: string };
type ExecuteAfter = CallEvent & { readonly input: unknown } & (
  | { readonly status: "completed"; result: { output?: unknown; metadata?: Record<string, unknown> } }
  | { readonly status: "error"; readonly error: unknown }
);
type Context = {
  tool: {
    transform(callback: (editor: { get(id: string): unknown }) => void): Promise<Registration>;
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

/**
 * The v2 counterpart of the v1 `preserveMcpResult` hook. Code Mode runs MCP
 * calls inside one `execute` and keeps only `{ tool, status, input }` per call,
 * so a connection that needs sign-in never reaches the chat. Inner calls fire
 * `execute.after` with the outer call's `messageID` and `id`; collect the ones
 * that report a connection and attach them to the outer call's metadata, which
 * the engine persists with the tool part.
 */
export function createMcpResultsCollector() {
  const open = new Map<string, PreservedMcpResult[]>();
  const key = (event: CallEvent) => `${event.messageID}\u0000${event.id}`;
  return {
    before(event: CallEvent): void {
      if (event.tool !== "execute") return;
      if (open.size >= MAX_OPEN_CALLS) {
        const oldest = open.keys().next().value;
        if (oldest !== undefined) open.delete(oldest);
      }
      open.set(key(event), []);
    },
    after(event: ExecuteAfter): void {
      const list = open.get(key(event));
      if (event.tool === "execute") {
        open.delete(key(event));
        if (event.status === "completed" && list && list.length > 0) {
          event.result.metadata = { ...(event.result.metadata ?? {}), openworkMcpResults: list };
        }
        return;
      }
      if (!list || list.length >= MAX_ENTRIES) return;
      const entry = preservedEntry(event);
      if (entry) list.push(entry);
    },
  };
}

export default {
  id: "openwork.mcp-results",
  async setup(context: Context) {
    const collector = createMcpResultsCollector();
    let rootSearch = false;
    const catalog = await context.tool.transform(editor => { rootSearch = editor.get("search") !== undefined; });
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
