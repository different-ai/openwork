import type { EnterpriseMcpScenario } from "../contracts/scenario.js"
import type {
  MutationOperationSummary,
  RuntimeSnapshot,
  SafeTraceDetail,
  SafeTraceEvent,
  EnterpriseMcpMockEnvironment,
} from "../contracts/runtime.js"
import type { HandshakePhase } from "../contracts/phases.js"
import type { ProviderProfile } from "../contracts/profile.js"
import type { FaultDefinition } from "../contracts/fault.js"
import { sanitizeTraceDetails, sha256 } from "../observability/redaction.js"
import { deepFreeze } from "../immutability.js"

export interface OAuthClientRecord {
  readonly clientId: string
  readonly clientSecret: string
  readonly redirectUris: readonly string[]
  readonly tokenEndpointAuthMethod: "none" | "client_secret_post"
  readonly createdAt: number
  readonly expiresAt: number | null
}

export interface AuthorizationCodeRecord {
  readonly code: string
  readonly clientId: string
  readonly redirectUri: string
  readonly codeChallenge: string
  readonly resource: string
  readonly scopes: readonly string[]
  readonly expiresAt: number
}

export interface AccessTokenRecord {
  readonly accessToken: string
  readonly familyId: string
  readonly clientId: string
  readonly resource: string
  readonly scopes: readonly string[]
  readonly subject: string
  readonly expiresAt: number
}

export interface RefreshTokenRecord {
  readonly refreshToken: string
  readonly familyId: string
  readonly clientId: string
  readonly resource: string
  readonly scopes: readonly string[]
  readonly subject: string
  readonly expiresAt: number
}

export interface SessionRecord {
  readonly sessionId: string
  readonly tokenFamilyId: string
  readonly operationNamespace: string
  readonly profileId: string
  readonly protocolVersion: string
  readonly scenarioRevision: number
  readonly expiresAt: number
  initialized: boolean
}

interface MutableOperation {
  readonly operationId: string
  readonly idempotencyKeyHash: string
  readonly namespaceHash: string
  readonly tool: string
  readonly argumentsHash: string
  state: "prepared" | "committed" | "responded" | "indeterminate"
  resultReference: string | null
  readonly createdAt: number
}

export type PrepareOperationResult =
  | { readonly kind: "prepared"; readonly operation: MutationOperationSummary }
  | { readonly kind: "duplicate"; readonly operation: MutationOperationSummary }
  | { readonly kind: "conflict"; readonly operation: MutationOperationSummary }
  | { readonly kind: "reconcile"; readonly operation: MutationOperationSummary }
  | { readonly kind: "capacity" }

interface EmitEventInput {
  readonly correlationId: string
  readonly scenario: EnterpriseMcpScenario
  readonly phase: HandshakePhase
  readonly direction: SafeTraceEvent["direction"]
  readonly kind: SafeTraceEvent["kind"]
  readonly outcome: SafeTraceEvent["outcome"]
  readonly summary: string
  readonly details?: Readonly<Record<string, SafeTraceDetail>>
}

const maximumEventCount = 500
const maximumClientCount = 100
const maximumAuthorizationCodeCount = 100
const maximumTokenCount = 100
const maximumSessionCount = 100
const maximumOperationCount = 1000
const maximumFaultCounterCount = 100
const operationTtlMs = 86_400_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(String(value))
}

export class InstanceState {
  readonly instanceId: string
  readonly clients = new Map<string, OAuthClientRecord>()
  readonly authorizationCodes = new Map<string, AuthorizationCodeRecord>()
  readonly tokens = new Map<string, AccessTokenRecord>()
  readonly refreshTokens = new Map<string, RefreshTokenRecord>()
  readonly sessions = new Map<string, SessionRecord>()
  readonly operations = new Map<string, MutableOperation>()
  readonly faultCounters = new Map<string, number>()
  private readonly traceEvents: SafeTraceEvent[] = []
  private runtimeStatus: RuntimeSnapshot["status"] = "idle"
  private runtimeBaseUrl: string | null = null

  constructor(
    private currentScenario: EnterpriseMcpScenario,
    private currentProfile: ProviderProfile,
    private readonly knownSecrets: readonly string[],
    private readonly environment: EnterpriseMcpMockEnvironment,
    instanceId?: string,
  ) {
    this.instanceId = instanceId ?? environment.randomId()
    this.currentScenario = deepFreeze(currentScenario)
    this.currentProfile = deepFreeze(currentProfile)
  }

  get scenario(): EnterpriseMcpScenario {
    return this.currentScenario
  }

  get profile(): ProviderProfile {
    return this.currentProfile
  }

  get status(): RuntimeSnapshot["status"] {
    return this.runtimeStatus
  }

  get baseUrl(): string | null {
    return this.runtimeBaseUrl
  }

  setRuntime(status: RuntimeSnapshot["status"], baseUrl: string | null): void {
    this.runtimeStatus = status
    this.runtimeBaseUrl = baseUrl
  }

  replaceScenario(scenario: EnterpriseMcpScenario, profile: ProviderProfile): void {
    this.currentScenario = deepFreeze(scenario)
    this.currentProfile = deepFreeze(profile)
    this.clearEphemeralState()
  }

  clearEphemeralState(): void {
    this.clearConnectionState()
    this.operations.clear()
    this.faultCounters.clear()
  }

  clearConnectionState(): void {
    this.clients.clear()
    this.authorizationCodes.clear()
    this.tokens.clear()
    this.refreshTokens.clear()
    this.sessions.clear()
  }

  inheritEstablishedOAuthAuthority(source: InstanceState): void {
    this.clearEphemeralState()
    this.clearEvents()
    source.maintainBounds(this.environment.now())
    for (const [clientId, client] of source.clients) this.clients.set(clientId, client)
    for (const [accessToken, token] of source.tokens) {
      if (this.clients.has(token.clientId)) this.tokens.set(accessToken, token)
    }
    for (const [refreshToken, token] of source.refreshTokens) {
      if (this.clients.has(token.clientId)) this.refreshTokens.set(refreshToken, token)
    }
    this.maintainBounds(this.environment.now())
  }

  maintainBounds(now = this.environment.now()): void {
    for (const [key, client] of this.clients) {
      if (client.expiresAt !== null && client.expiresAt < now) this.clients.delete(key)
    }
    for (const [key, code] of this.authorizationCodes) if (code.expiresAt < now) this.authorizationCodes.delete(key)
    for (const [key, token] of this.tokens) if (token.expiresAt < now) this.tokens.delete(key)
    for (const [key, token] of this.refreshTokens) if (token.expiresAt < now) this.refreshTokens.delete(key)
    for (const [key, session] of this.sessions) if (session.expiresAt < now) this.sessions.delete(key)
    for (const [key, operation] of this.operations) {
      if (operation.state === "responded" && operation.createdAt + operationTtlMs < now) this.operations.delete(key)
    }
    this.trimOldest(this.clients, maximumClientCount)
    this.trimOldest(this.authorizationCodes, maximumAuthorizationCodeCount)
    this.trimOldest(this.tokens, maximumTokenCount)
    this.trimOldest(this.refreshTokens, maximumTokenCount)
    this.trimOldest(this.sessions, maximumSessionCount)
    this.trimRespondedOperations(maximumOperationCount)
    this.trimOldest(this.faultCounters, maximumFaultCounterCount)
  }

  putClient(client: OAuthClientRecord): void {
    this.clients.set(client.clientId, client)
    this.maintainBounds()
  }

  putAuthorizationCode(code: AuthorizationCodeRecord): void {
    this.authorizationCodes.set(code.code, code)
    this.maintainBounds()
  }

  putToken(token: AccessTokenRecord): void {
    this.tokens.set(token.accessToken, token)
    this.maintainBounds()
  }

  putRefreshToken(token: RefreshTokenRecord): void {
    this.refreshTokens.set(token.refreshToken, token)
    this.maintainBounds()
  }

  putSession(session: SessionRecord): void {
    this.sessions.set(session.sessionId, session)
    this.maintainBounds()
  }

  clearEvents(): void {
    this.traceEvents.splice(0, this.traceEvents.length)
  }

  issueOpaque(prefix: string): string {
    return this.environment.opaqueValue(prefix)
  }

  now(): number {
    return this.environment.now()
  }

  emit(input: EmitEventInput): SafeTraceEvent {
    const event: SafeTraceEvent = deepFreeze({
      id: this.environment.randomId(),
      occurredAt: new Date(this.environment.now()).toISOString(),
      correlationId: input.correlationId,
      revision: input.scenario.revision,
      phase: input.phase,
      direction: input.direction,
      kind: input.kind,
      outcome: input.outcome,
      summary: input.summary,
      details: sanitizeTraceDetails(input.details ?? {}, this.knownSecrets),
    })
    this.traceEvents.push(event)
    if (this.traceEvents.length > maximumEventCount) this.traceEvents.splice(0, this.traceEvents.length - maximumEventCount)
    return event
  }

  events(): readonly SafeTraceEvent[] {
    return deepFreeze([...this.traceEvents])
  }

  shouldApplyFault(definition: FaultDefinition, scenario: EnterpriseMcpScenario): boolean {
    const active = scenario.activeFault
    if (!active || active.id !== definition.id) return false
    const counterKey = `${scenario.revision}:${definition.id}`
    const nextCount = (this.faultCounters.get(counterKey) ?? 0) + 1
    this.faultCounters.set(counterKey, nextCount)
    if (active.trigger.occurrence === "always") return true
    if (active.trigger.occurrence === "once") return nextCount === 1
    return nextCount === active.trigger.requestNumber
  }

  prepareOperation(namespace: string, tool: string, idempotencyKey: string, argumentsValue: unknown): PrepareOperationResult {
    const namespaceHash = sha256(namespace)
    const idempotencyKeyHash = sha256(idempotencyKey)
    const argumentsHash = sha256(canonicalJson(argumentsValue))
    const existing = [...this.operations.values()].find(
      (operation) => operation.namespaceHash === namespaceHash && operation.idempotencyKeyHash === idempotencyKeyHash,
    )
    if (existing) {
      const operation = this.operationSummary(existing)
      if (existing.tool !== tool || existing.argumentsHash !== argumentsHash) return { kind: "conflict", operation }
      if (existing.state !== "responded") return { kind: "reconcile", operation }
      return { kind: "duplicate", operation }
    }

    this.maintainBounds()
    if (this.operations.size >= maximumOperationCount) {
      this.trimRespondedOperations(maximumOperationCount - 1)
      if (this.operations.size >= maximumOperationCount) return { kind: "capacity" }
    }

    const operation: MutableOperation = {
      operationId: this.issueOpaque("operation"),
      idempotencyKeyHash,
      namespaceHash,
      tool,
      argumentsHash,
      state: "prepared",
      resultReference: null,
      createdAt: this.environment.now(),
    }
    this.operations.set(operation.operationId, operation)
    this.maintainBounds()
    return { kind: "prepared", operation: this.operationSummary(operation) }
  }

  transitionOperation(
    operationId: string,
    state: MutableOperation["state"],
    resultReference: string | null,
  ): MutationOperationSummary {
    const operation = this.operations.get(operationId)
    if (!operation) throw new Error(`Unknown operation '${operationId}'`)
    operation.state = state
    operation.resultReference = resultReference
    return this.operationSummary(operation)
  }

  snapshot(clientSecretConfigured: boolean): RuntimeSnapshot {
    this.maintainBounds()
    const baseUrl = this.runtimeBaseUrl
    return deepFreeze({
      status: this.runtimeStatus,
      instanceId: this.instanceId,
      scenario: this.currentScenario,
      profile: this.currentProfile,
      baseUrl,
      mcpUrl: baseUrl ? new URL(this.currentProfile.endpointPath, baseUrl).href : null,
      oauth: {
        authorizationServerUrl: baseUrl,
        protectedResourceMetadataUrl: baseUrl ? new URL(`/.well-known/oauth-protected-resource${this.currentProfile.endpointPath}`, baseUrl).href : null,
        registration: this.currentScenario.oauth.registration,
        clientId: this.currentScenario.oauth.clientId,
        clientSecretConfigured,
      },
      counts: {
        events: this.traceEvents.length,
        sessions: this.sessions.size,
        clients: this.clients.size,
        tokens: this.tokens.size + this.refreshTokens.size,
        operations: this.operations.size,
      },
      operations: [...this.operations.values()].map((operation) => this.operationSummary(operation)),
    })
  }

  private operationSummary(operation: MutableOperation): MutationOperationSummary {
    return {
      operationId: operation.operationId,
      idempotencyKeyHash: operation.idempotencyKeyHash,
      tool: operation.tool,
      argumentsHash: operation.argumentsHash,
      state: operation.state,
      resultReference: operation.resultReference,
    }
  }

  private trimOldest<Key, Value>(map: Map<Key, Value>, maximum: number): void {
    while (map.size > maximum) {
      const oldestKey = map.keys().next().value
      if (oldestKey === undefined) return
      map.delete(oldestKey)
    }
  }

  private trimRespondedOperations(maximum: number): void {
    if (this.operations.size <= maximum) return
    for (const [operationId, operation] of this.operations) {
      if (operation.state === "responded") this.operations.delete(operationId)
      if (this.operations.size <= maximum) return
    }
  }
}
