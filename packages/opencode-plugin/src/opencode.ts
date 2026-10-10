/**
 * The subset of the OpenCode V2 plugin host (`@opencode/plugin` 2.0.26) this
 * plugin uses, typed structurally. OpenCode provides the host at runtime, so
 * the plugin ships with no dependency on it (the same approach as the V2
 * plugins in apps/server/src/opencode-plugins).
 *
 * Source of truth: anomalyco/opencode `v2` branch,
 * packages/plugin/src/promise/{plugin,integration,provider,mcp,storage}.ts and
 * packages/schema/src/{credential,connection,provider,model,mcp}.ts.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export interface Registration {
  readonly dispose: () => Promise<void>
}

export type Transform<Editor> = (callback: (editor: Editor) => void) => Promise<Registration>

// ---- Credentials and integrations ----

export interface OAuthCredential {
  readonly type: "oauth"
  readonly methodID: string
  readonly refresh: string
  readonly access: string
  /** Milliseconds since the epoch. */
  readonly expires: number
  readonly metadata?: Record<string, unknown>
}

export type CredentialValue =
  | OAuthCredential
  | { readonly type: "key"; readonly key: string; readonly metadata?: Record<string, unknown> }
  | { readonly type: "external"; readonly methodID: string; readonly metadata?: Record<string, unknown> }

export interface ConnectionStatus {
  readonly status: "needs_auth"
  readonly message: string
  readonly url?: string
}

export type ConnectionInfo =
  | {
      readonly type: "credential"
      readonly id: string
      readonly label: string
      readonly method: "key" | "oauth" | "external"
      readonly status?: ConnectionStatus
    }
  | { readonly type: "env"; readonly name: string; readonly status?: ConnectionStatus }

export interface OAuthMethod {
  readonly id: string
  readonly type: "oauth"
  readonly label: string
}

export type OAuthAuthorization = {
  readonly url: string
  readonly instructions: string
  readonly expiresAt?: number
} & (
  | { readonly mode: "auto"; readonly callback: Promise<OAuthCredential> }
  | { readonly mode: "code"; readonly callback: (code: string) => Promise<OAuthCredential> }
)

export interface OAuthMethodRegistration {
  readonly integrationID: string
  readonly method: OAuthMethod
  readonly authorize: (answer: Record<string, unknown>) => Promise<OAuthAuthorization>
  readonly refresh?: (credential: OAuthCredential) => Promise<OAuthCredential>
  readonly label?: (credential: OAuthCredential) => string | undefined
}

export interface IntegrationEditor {
  update(id: string, update: (integration: { id: string; name: string }) => void): void
  readonly method: {
    update(input: OAuthMethodRegistration): void
  }
}

export interface IntegrationInfo {
  readonly id: string
  readonly name: string
  readonly connections: readonly ConnectionInfo[]
}

export interface IntegrationDomain {
  readonly transform: Transform<IntegrationEditor>
  readonly get: (input: { integrationID: string }) => Promise<unknown>
  readonly connection: {
    readonly active: (integrationID: string) => Promise<ConnectionInfo | undefined>
    readonly resolve: (connection: ConnectionInfo) => Promise<CredentialValue | undefined>
    readonly status: (input: {
      readonly integrationID: string
      readonly connection: ConnectionInfo
      readonly status: ConnectionStatus | undefined
    }) => Promise<void>
  }
}

// ---- Providers and models ----

export interface ProviderInfo {
  readonly id: string
  readonly name: string
  readonly activation: "auto" | "enabled" | "disabled"
  readonly package: string
  readonly integrationID?: string
  readonly settings?: Record<string, unknown>
  readonly headers?: Record<string, string>
  readonly body?: Record<string, unknown>
}

export interface ModelCost {
  readonly tier?: { readonly type: "context"; readonly size: number }
  readonly input: number
  readonly output: number
  readonly cache: { readonly read: number; readonly write: number }
}

export interface ModelVariant {
  readonly id: string
  readonly settings?: Record<string, unknown>
  readonly headers?: Record<string, string>
  readonly body?: Record<string, unknown>
}

export interface ModelInfo {
  readonly id: string
  readonly modelID: string
  readonly providerID: string
  readonly family?: string
  readonly name: string
  readonly package?: string
  readonly settings?: Record<string, unknown>
  readonly headers?: Record<string, string>
  readonly body?: Record<string, unknown>
  readonly capabilities: { readonly tools: boolean; readonly input: readonly string[]; readonly output: readonly string[] }
  readonly variants: readonly ModelVariant[]
  readonly time: { readonly released: number }
  readonly cost: readonly ModelCost[]
  readonly status: "alpha" | "beta" | "deprecated" | "active"
  readonly enabled: boolean
  readonly limit: { readonly context: number; readonly input?: number; readonly output: number }
}

export interface ProviderEditor {
  get(providerID: string): unknown
  add(input: { info: ProviderInfo; models: readonly ModelInfo[]; sourceConnection?: ConnectionInfo }): void
  remove(providerID: string): void
}

export interface ProviderDomain {
  readonly transform: Transform<ProviderEditor>
  readonly reload: () => Promise<void>
}

// ---- MCP ----

export interface RemoteMcpConfig {
  readonly type: "remote"
  readonly url: string
  readonly headers?: Record<string, string>
  readonly oauth?: false
  readonly disabled?: boolean
}

export interface McpEditor {
  set(name: string, config: RemoteMcpConfig): void
  remove(name: string): void
}

export interface McpDomain {
  readonly transform: Transform<McpEditor>
  readonly reload: () => Promise<void>
}

// ---- Storage and events ----

export interface StorageDomain {
  readonly get: (key: string) => Promise<Json | undefined>
  readonly set: (key: string, value: Json) => Promise<void>
  readonly remove: (key: string) => Promise<void>
}

export interface EventDomain {
  readonly subscribe: (options?: { signal?: AbortSignal }) => AsyncIterable<unknown>
}

// ---- Plugin ----

export interface PluginContext {
  readonly app: { readonly version: string }
  readonly location: { readonly directory: string }
  readonly options: Readonly<Record<string, unknown>>
  readonly integration: IntegrationDomain
  readonly provider: ProviderDomain
  readonly mcp: McpDomain
  readonly storage: StorageDomain
  readonly event: EventDomain
}

export type Cleanup = () => Promise<void> | void

export interface PluginDefinition {
  readonly id: string
  readonly setup: (context: PluginContext) => Promise<Cleanup | void>
}
