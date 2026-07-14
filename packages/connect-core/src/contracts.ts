export const CONNECT_SEARCH_TYPES = ["all", "api", "admin", "mcp", "marketplace", "skills"] as const

export type ConnectSearchType = typeof CONNECT_SEARCH_TYPES[number]
export type ConnectSourceType = Exclude<ConnectSearchType, "all">

export type ConnectCapabilityMatch = {
  name: string
  method: string
  path: string
  score: number
  summary: string
  pathParams: string[]
  queryParams: string[]
  hasBody: boolean
  kind?: string
  status?: string
  hint?: string
  connectionStatus?: unknown
  [key: string]: unknown
}

export type ConnectTextContent = {
  type: "text"
  text: string
}

export type ConnectToolResult = {
  isError?: boolean
  content: ConnectTextContent[]
  structuredContent?: Record<string, unknown>
}

export type ConnectSearchInput = {
  query: string
  limit: number
  type: ConnectSearchType
}

export type ConnectSearchResult = {
  matches: ConnectCapabilityMatch[]
  hint?: string
}

export type ConnectExecuteInput = {
  name: string
  path?: Record<string, unknown> | string
  query?: Record<string, unknown> | string
  body?: unknown
}

export type ConnectSourceSearchResult = {
  matches: ConnectCapabilityMatch[]
  hint?: string
}

export interface ConnectCapabilitySource {
  readonly id: string
  readonly types: readonly ConnectSourceType[]
  search(input: ConnectSearchInput): Promise<ConnectSourceSearchResult> | ConnectSourceSearchResult
  canExecute(name: string): Promise<boolean> | boolean
  execute(input: ConnectExecuteInput): Promise<ConnectToolResult>
}

export interface ConnectRuntime {
  search(input: { query: string; limit?: number; type?: ConnectSearchType }): Promise<ConnectSearchResult>
  execute(input: ConnectExecuteInput): Promise<ConnectToolResult>
}
