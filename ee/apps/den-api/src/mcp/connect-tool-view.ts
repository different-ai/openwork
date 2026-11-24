import { CLIENT_INFO_META_KEY } from "@modelcontextprotocol/server"

export type ConnectToolView = "search" | "full"

export type ConnectClientInfo = { name: string; version?: string }

export const CONNECT_TOOL_VIEW_PARAMETER = "tools"

export const CONNECT_FULL_TOOL_CLIENTS: ReadonlySet<string> = new Set(["claude-code", "opencode"])

const OPENWORK_ENGINE_CLIENT = "opencode"

export function isOpenWorkEngineClient(clientInfo: ConnectClientInfo | null, firstPartyToken: boolean): boolean {
  return firstPartyToken && clientInfo?.name.trim().toLowerCase() === OPENWORK_ENGINE_CLIENT
}

export function connectToolViewOverride(url: string): ConnectToolView | null {
  const value = new URL(url).searchParams.get(CONNECT_TOOL_VIEW_PARAMETER)
  return value === "full" || value === "search" ? value : null
}

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
  flags: { enabled: boolean; override?: ConnectToolView | null; firstPartyToken?: boolean; engineTools?: boolean },
): ConnectToolView {
  const openworkEngine = isOpenWorkEngineClient(clientInfo, flags.firstPartyToken === true)
  if (openworkEngine && flags.engineTools) return flags.override ?? "full"
  if (!flags.enabled) return "search"
  if (flags.override) return flags.override
  if (openworkEngine) return "search"
  const clientName = clientInfo?.name.trim().toLowerCase()
  return clientName && CONNECT_FULL_TOOL_CLIENTS.has(clientName) ? "full" : "search"
}
