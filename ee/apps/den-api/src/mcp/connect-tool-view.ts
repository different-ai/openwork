import { CLIENT_INFO_META_KEY } from "@modelcontextprotocol/server"

/**
 * Which tools/list a Connect request gets.
 *
 * `search` is today's surface: search_capabilities, execute_capability and the
 * direct tools. `full` lists every capability the member may use as its own
 * standard MCP tool, for clients that search large tool lists themselves and
 * load definitions on demand.
 *
 * The choice depends only on the request: its `?tools=` override, the
 * `io.modelcontextprotocol/clientInfo` it carries in `_meta`, and whether its
 * token is one Den minted for OpenWork, never on connection state, so every
 * request from the same client gets the same view. Requests without
 * per-request clientInfo (2025-era clients) keep `search` unless the override
 * asks for `full`.
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
 * - opencode: standalone OpenCode v2 searches MCP definitions on demand
 *   through Code Mode:
 *   https://github.com/anomalyco/opencode/blob/v2.0.26/packages/core/src/tool/mcp.ts
 *   OpenWork's own engine reports the same name; see OPENWORK_ENGINE_CLIENT.
 */
export const CONNECT_FULL_TOOL_CLIENTS: ReadonlySet<string> = new Set(["claude-code", "opencode"])

/**
 * OpenWork Desktop, Web and headless runs drive the same engine as standalone
 * OpenCode and report its name, so a request is OpenWork's own when it also
 * holds a token Den minted for OpenWork. OpenWork keeps the search view: its
 * instructions pin search_capabilities and execute_capability, and Den's
 * search ranks capabilities better than the engine's own. A first-party token
 * copied into another client, as test harnesses do, follows that client.
 */
const OPENWORK_ENGINE_CLIENT = "opencode"

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
  flags: { enabled: boolean; override?: ConnectToolView | null; firstPartyToken?: boolean },
): ConnectToolView {
  if (!flags.enabled) return "search"
  if (flags.override) return flags.override
  const clientName = clientInfo?.name.trim().toLowerCase()
  if (flags.firstPartyToken && clientName === OPENWORK_ENGINE_CLIENT) return "search"
  return clientName && CONNECT_FULL_TOOL_CLIENTS.has(clientName) ? "full" : "search"
}
