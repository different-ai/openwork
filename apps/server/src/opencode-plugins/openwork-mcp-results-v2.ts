import { type HostConnectionDecision } from "@openwork/types/connection-action-app";
import { waitForConnectionDecision, type ConnectionGateEndpoint } from "./openwork-connection-gate-v2.js";

type Registration = { dispose(): Promise<void> };
type CallEvent = { readonly tool: string; readonly sessionID?: string; readonly messageID: string; readonly id: string };
type ExecuteAfter = CallEvent & { readonly input: unknown } & (
  | { readonly status: "completed"; result: { output?: unknown; metadata?: Record<string, unknown> } }
  | { readonly status: "error"; readonly error: unknown }
);
type Context = {
  options?: { connectionGate?: ConnectionGateEndpoint };
  tool: {
    hook(name: "execute.before", callback: (event: CallEvent) => void): Promise<Registration>;
    hook(name: "execute.after", callback: (event: ExecuteAfter) => void | Promise<void>): Promise<Registration>;
  };
};

/** One OpenWork Cloud call made inside a Code Mode `execute`, kept because it reports a connection. */
export type PreservedMcpResult = (
  | { tool: string; input: unknown; status: "completed"; output: unknown }
  | { tool: string; input: unknown; status: "error"; error: string }
) & { decision?: HostConnectionDecision };

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

export function preservedEntry(event: ExecuteAfter, decision?: HostConnectionDecision | null): PreservedMcpResult | null {
  // Informational discovery stays quiet; an explicit host decision is retained
  // even when a later connection in this script becomes the outer call's card.
  if (!OPENWORK_CLOUD_TOOL.test(event.tool) || (event.tool.endsWith("_search_capabilities") && !decision)) return null;
  const input = jsonCopy(event.input);
  const entry: PreservedMcpResult | null = event.status === "completed"
    ? reportsConnection(event.result.output) ? { tool: event.tool, input, status: "completed", output: jsonCopy(event.result.output) } : null
    : reportsConnection(parseRecord(errorText(event.error))) ? { tool: event.tool, input, status: "error", error: errorText(event.error) } : null;
  if (!entry) return null;
  if (decision) entry.decision = decision;
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
  const open = new Map<string, { entries: PreservedMcpResult[]; decision?: HostConnectionDecision }>();
  const key = (event: CallEvent) => `${event.messageID}\u0000${event.id}`;
  return {
    before(event: CallEvent): void {
      if (event.tool !== "execute") return;
      if (open.size >= MAX_OPEN_CALLS) {
        const oldest = open.keys().next().value;
        if (oldest !== undefined) open.delete(oldest);
      }
      open.set(key(event), { entries: [] });
    },
    after(event: ExecuteAfter, decision?: HostConnectionDecision | null): void {
      const pending = open.get(key(event));
      if (event.tool === "execute") {
        open.delete(key(event));
        if (event.status === "completed" && pending && (pending.entries.length > 0 || pending.decision)) {
          event.result.metadata = {
            ...(event.result.metadata ?? {}),
            ...(pending.entries.length ? { openworkMcpResults: pending.entries } : {}),
            ...(pending.decision ? { openworkConnectionDecision: pending.decision } : {}),
          };
        }
        return;
      }
      if (!pending) return;
      if (decision) pending.decision = decision;
      if (pending.entries.length >= MAX_ENTRIES) return;
      const entry = preservedEntry(event, decision);
      if (entry) pending.entries.push(entry);
    },
  };
}

export default {
  id: "openwork.mcp-results",
  async setup(context: Context) {
    const collector = createMcpResultsCollector();
    const lifetime = new AbortController();
    const before = await context.tool.hook("execute.before", event => collector.before(event));
    const after = await context.tool.hook("execute.after", async event => {
      const decision = await waitForConnectionDecision(event, context.options?.connectionGate, lifetime.signal);
      collector.after(event, decision);
    });
    return async () => {
      lifetime.abort();
      await before.dispose();
      await after.dispose();
    };
  },
};
