import { CLIENT_INFO_META_KEY } from "@modelcontextprotocol/server"

/**
 * Which tools/list a Connect request gets.
 *
 * `search` is today's surface: search_capabilities, execute_capability and the
 * direct tools. `full` lists every capability the member may use as its own
 * standard MCP tool, for clients that search large tool lists themselves and
 * load definitions on demand.
 *
 * The choice depends only on the request: its `?tools=` override and the
 * `io.modelcontextprotocol/clientInfo` it carries in `_meta`, never on
 * connection state, so every request from the same client gets the same view.
 * Requests without per-request clientInfo (2025-era clients) keep `search`
 * unless the override asks for `full`.
 *
 * clientInfo is self-reported and the spec says not to change behaviour on it,
 * so it is only a hint for presentation: both views list and run exactly the
 * capabilities the member is granted, and anything unrecognized gets `search`.
 */
export type ConnectToolView = "search" | "full"

export type ConnectClientInfo = { name: string; version?: string }

export const CONNECT_TOOL_VIEW_PARAMETER = "tools"

/**
 * Clients known to search a large tool list themselves and load definitions
 * on demand. Add a client only with a source showing it does.
 *
 * - claude-code: Claude Code defers MCP tool definitions by default and loads
 *   them through its ToolSearch tool
 *   (https://code.claude.com/docs/en/mcp#scale-with-mcp-tool-search).
 * - opencode: OpenCode v2 (including OpenWork Desktop) searches MCP definitions
 *   on demand through Code Mode:
 *   https://github.com/anomalyco/opencode/blob/v2.0.26/packages/core/src/tool/mcp.ts
 *   Its identity is shared by Desktop and standalone OpenCode, not an
 *   authorization boundary.
 */
export const CONNECT_FULL_TOOL_CLIENTS: ReadonlySet<string> = new Set(["claude-code", "opencode"])

/** The `?tools=full|search` override; anything else is no override. */
export function connectToolViewOverride(url: string): ConnectToolView | null {
  const value = new URL(url).searchParams.get(CONNECT_TOOL_VIEW_PARAMETER)
  return value === "full" || value === "search" ? value : null
}

/** The clientInfo a request carries in its `_meta`, or null without a usable name. */
export function requestClientInfo(params: unknown): ConnectClientInfo | null {
  if (typeof params !== "object" || params === null || !("_meta" in params)) return null
  const meta = params._meta
  if (typeof meta !== "object" || meta === null || !(CLIENT_INFO_META_KEY in meta)) return null
  const info: unknown = meta[CLIENT_INFO_META_KEY]
  if (typeof info !== "object" || info === null || !("name" in info) || typeof info.name !== "string") return null
  return { name: info.name, ...("version" in info && typeof info.version === "string" ? { version: info.version } : {}) }
}

export function connectToolView(
  clientInfo: ConnectClientInfo | null,
  flags: { enabled: boolean; override?: ConnectToolView | null },
): ConnectToolView {
  if (!flags.enabled) return "search"
  if (flags.override) return flags.override
  const clientName = clientInfo?.name.trim().toLowerCase()
  return clientName && CONNECT_FULL_TOOL_CLIENTS.has(clientName) ? "full" : "search"
}
