import { z } from "zod"
import type { EnterpriseMcpScenario } from "./scenario.js"
import type { ProviderProfile } from "./profile.js"
import type { HandshakePhase } from "./phases.js"

export const enterpriseMcpMockSecretsSchema = z.object({
  oauthClientSecret: z.string().max(4_096).default(""),
})

export type EnterpriseMcpMockSecrets = z.infer<typeof enterpriseMcpMockSecretsSchema>

export interface EnterpriseMcpMockEnvironment {
  now(): number
  randomId(): string
  opaqueValue(prefix: string): string
  beforeListen?(attempt: number): void | Promise<void>
}

export type SafeTraceDetail = string | number | boolean | null | readonly string[]

export interface SafeTraceEvent {
  readonly id: string
  readonly occurredAt: string
  readonly correlationId: string
  readonly revision: number
  readonly phase: HandshakePhase
  readonly direction: "inbound" | "outbound" | "internal"
  readonly kind: "request" | "response" | "fault" | "lifecycle" | "security" | "mutation"
  readonly outcome: "started" | "passed" | "failed" | "applied" | "completed"
  readonly summary: string
  readonly details: Readonly<Record<string, SafeTraceDetail>>
}

export interface MutationOperationSummary {
  readonly operationId: string
  readonly idempotencyKeyHash: string
  readonly tool: string
  readonly argumentsHash: string
  readonly state: "prepared" | "committed" | "responded" | "indeterminate"
  readonly resultReference: string | null
}

export interface RuntimeSnapshot {
  readonly status: "idle" | "running" | "stopped"
  readonly instanceId: string
  readonly scenario: EnterpriseMcpScenario
  readonly profile: ProviderProfile
  readonly baseUrl: string | null
  readonly mcpUrl: string | null
  readonly oauth: {
    readonly authorizationServerUrl: string | null
    readonly protectedResourceMetadataUrl: string | null
    readonly registration: "manual" | "dynamic"
    readonly clientId: string
    readonly clientSecretConfigured: boolean
  }
  readonly counts: {
    readonly events: number
    readonly sessions: number
    readonly clients: number
    readonly tokens: number
    readonly operations: number
  }
  readonly operations: readonly MutationOperationSummary[]
}

export interface CreateEnterpriseMcpMockServerOptions {
  readonly scenario: EnterpriseMcpScenario
  readonly secrets: EnterpriseMcpMockSecrets
  readonly host?: string
  readonly port?: number
  readonly environment?: EnterpriseMcpMockEnvironment
}

export const scenarioCredentialContinuitySchema = z.enum(["reset", "preserve-compatible-oauth"])
export type ScenarioCredentialContinuity = z.infer<typeof scenarioCredentialContinuitySchema>

export interface UpdateScenarioOptions {
  readonly credentialContinuity?: ScenarioCredentialContinuity
}

export interface EnterpriseMcpMockServer {
  readonly baseUrl: string
  readonly mcpUrl: string
  start(): Promise<RuntimeSnapshot>
  stop(): Promise<RuntimeSnapshot>
  reset(): Promise<RuntimeSnapshot>
  updateScenario(
    next: EnterpriseMcpScenario,
    expectedRevision: number,
    options?: UpdateScenarioOptions,
  ): Promise<RuntimeSnapshot>
  snapshot(): RuntimeSnapshot
  events(): readonly SafeTraceEvent[]
}

export class ScenarioCredentialContinuityError extends Error {
  constructor(
    readonly code: "fixed_port_required" | "incompatible_oauth_authority" | "unsupported_mode",
    message: string,
  ) {
    super(message)
    this.name = "ScenarioCredentialContinuityError"
  }
}

export class ScenarioRevisionConflictError extends Error {
  readonly expectedRevision: number
  readonly actualRevision: number

  constructor(expectedRevision: number, actualRevision: number) {
    super(`Scenario revision conflict: expected ${expectedRevision}, current revision is ${actualRevision}`)
    this.name = "ScenarioRevisionConflictError"
    this.expectedRevision = expectedRevision
    this.actualRevision = actualRevision
  }
}
