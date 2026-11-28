import { agentPermissionEngineMcpDenial, agentPermissionRulesOf, type AgentPermissionRule } from "./agent-permission-engine.js";
import type { McpFetch } from "./connect-mcp-transport.js";
import { isOrganizationMcpName } from "./organization-mcp-names.js";
import { listRuntimeOpencodeConfigRows, readGlobalRuntimeOpencodeConfig, runtimeMcpMap } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";

export type MemberMcpServer = { name: string; config: Record<string, unknown> };

export type MemberMcpServerOptions = { fetcher?: McpFetch; hostAllowed?: () => Promise<boolean> };

export function memberMcpServerSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

function ownGateway(config: ServerConfig, url: string): boolean {
  try {
    const endpoint = new URL(url);
    return ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) && endpoint.port === String(config.port);
  } catch {
    return true;
  }
}

export async function memberMcpServers(
  config: ServerConfig,
  options: MemberMcpServerOptions,
): Promise<{ servers: MemberMcpServer[]; rules: AgentPermissionRule[] }> {
  const rules = agentPermissionRulesOf((await readGlobalRuntimeOpencodeConfig(config)).managedPolicy);
  if (options.hostAllowed && !(await options.hostAllowed())) return { servers: [], rules };
  const servers = new Map<string, MemberMcpServer>();
  for (const row of await listRuntimeOpencodeConfigRows(config)) {
    for (const [name, server] of Object.entries(runtimeMcpMap(row.value))) {
      if (servers.has(name) || isOrganizationMcpName(name) || !memberMcpServerSlug(name)) continue;
      if (server.type !== "remote" || typeof server.url !== "string" || server.enabled === false || server.disabled === true) continue;
      if (ownGateway(config, server.url) || agentPermissionEngineMcpDenial(rules, name, server, {})) continue;
      servers.set(name, { name, config: server });
    }
  }
  return { servers: [...servers.values()].sort((a, b) => a.name.localeCompare(b.name)), rules };
}
