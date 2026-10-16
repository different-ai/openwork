import { buildOpenworkProviderContributions, type EngineMcpDescriptor } from "./opencode-plugins/openwork-provider-adapters.js";

type Read = (path: string) => Promise<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const workspaceEngine = (workspaceId: string) => `/workspace/${encodeURIComponent(workspaceId)}/opencode2`;

/** MCP status from the v2 engine of the workspace that owns the session; v2 serves MCP tools through Code Mode. */
export async function readV2McpDescriptors(read: Read, sessionId: string): Promise<EngineMcpDescriptor[]> {
  const listed = await read("/workspaces");
  const workspaces = isRecord(listed) && Array.isArray(listed.items) ? listed.items.filter(isRecord) : [];
  for (const workspace of workspaces) {
    if (typeof workspace.id !== "string") continue;
    const engine = workspaceEngine(workspace.id);
    const owns = await read(`${engine}/api/session/${encodeURIComponent(sessionId)}`).then(() => true, () => false);
    if (!owns) continue;
    const payload = await read(`${engine}/api/mcp`);
    const entries = isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];
    return entries.flatMap((entry): EngineMcpDescriptor[] => {
      if (!isRecord(entry) || typeof entry.name !== "string" || !isRecord(entry.status)) return [];
      return typeof entry.status.status === "string"
        ? [{ name: entry.name, status: entry.status.status, toolAccess: "codemode" }]
        : [];
    });
  }
  return [];
}

/** Replace the snapshot's `mcp:*` contributions, in either shape the plugin returns. */
export function withEngineMcpContributions(context: unknown, mcps: EngineMcpDescriptor[]): unknown {
  if (!isRecord(context)) return context;
  const target = isRecord(context.context) ? context.context : context;
  const existing = Array.isArray(target.contributions) ? target.contributions : [];
  const kept = existing.filter((item) => !(isRecord(item) && typeof item.featureId === "string" && item.featureId.startsWith("mcp:")));
  const connectors = buildOpenworkProviderContributions([], mcps).filter((item) => item.featureId.startsWith("mcp:"));
  target.contributions = [...kept, ...connectors];
  return context;
}
