export const CONNECT_MODES = ["hosted", "local", "disabled"] as const
export const CONNECT_RUNTIME_VERSION = "0.1.0"
export const CONNECT_CONTRACT_VERSION = "1.0"
export const CONNECT_MCP_ALIAS = "openwork-cloud"
export const CONNECT_AGENT_PATH = "/mcp/agent"

export type ConnectMode = typeof CONNECT_MODES[number]
export type ConnectDeployment = "desktop-local" | "self-hosted"
export type ConnectAuthType = "none" | "api-key" | "oauth"
export type ConnectConnectionStatus = "disconnected" | "connected" | "needs_auth" | "error"

export type ConnectProfileFeatures = {
  organizations: boolean
  teams: boolean
  sharedCredentials: boolean
  perActorCredentials: boolean
  externalMcp: boolean
  localSkills: boolean
  installedPlugins: boolean
  nativeProviders: string[]
  privateNetworkSources: boolean
  externalClients: boolean
  audit: boolean
}

export type ConnectProfile = {
  mode: ConnectMode
  deployment: ConnectDeployment
  runtimeVersion: string
  contractVersion: string
  localAvailable: boolean
  vault:
    | { status: "ready" }
    | { status: "missing" | "invalid"; message: string }
  agentEndpoint: string
  connectionCount: number
  connectedCount: number
  features: ConnectProfileFeatures
}

export type ConnectConnection = {
  id: string
  name: string
  serverUrl: string
  authType: ConnectAuthType
  networkPolicy: "public" | "private"
  status: ConnectConnectionStatus
  lastError?: string
  createdAt: number
  updatedAt: number
}

export type ConnectConnectionInput = {
  name: string
  serverUrl: string
  authType: ConnectAuthType
  allowPrivateNetwork?: boolean
  apiKey?: string
  oauthClient?: {
    clientId: string
    clientSecret?: string
  }
}

export type ConnectDelivery = {
  workspaceId: string
  status: "updated" | "failed"
  result?: unknown
  error?: string
}

export type ConnectProfileUpdate = {
  profile: ConnectProfile
  deliveries: ConnectDelivery[]
}
