import { z } from "zod"
import { oauthRedirectUriSchema, scenarioCredentialContinuitySchema } from "@openwork/enterprise-mcp-mock-server"

const redirectUrisInputSchema = z.preprocess(
  (value) => typeof value === "string"
    ? value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
    : value,
  z.array(oauthRedirectUriSchema)
    .min(1, "Provide at least one exact OAuth redirect URI.")
    .max(10, "Provide no more than 10 OAuth redirect URIs.")
    .superRefine((redirectUris, context) => {
      if (new Set(redirectUris).size !== redirectUris.length) {
        context.addIssue({ code: "custom", message: "OAuth redirect URIs must be unique exact values." })
      }
    }),
).optional()

export const createInstanceInputSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  profileId: z.string().trim().min(1).max(100),
  port: z.coerce.number().int().min(1_024).max(65_535),
  faultId: z.string().trim().max(120).optional().transform((value) => value || undefined),
  clientId: z.string().trim().max(256).optional().transform((value) => value || undefined),
  clientSecret: z.string().max(4_096).optional().transform((value) => value ?? ""),
  redirectUris: redirectUrisInputSchema,
})

export const updateScenarioInputSchema = z.object({
  credentialContinuity: scenarioCredentialContinuitySchema.optional(),
  faultId: z.string().trim().max(120).nullable().optional(),
  expectedRevision: z.coerce.number().int().nonnegative(),
})

export type CreateInstanceInput = z.infer<typeof createInstanceInputSchema>
export type UpdateScenarioInput = z.infer<typeof updateScenarioInputSchema>

export type InstanceLifecycleState = "stopped" | "starting" | "running" | "stopping" | "failed"

export interface LabProvenance {
  aspectFidelity: Readonly<Record<string, string>>
  documentationUrls: readonly string[]
  fidelity: string
  knownLimitations: readonly string[]
  productSurface: string
  verifiedAt: string
}

export interface LabProfile {
  description: string
  fixtureVersion: string
  id: string
  name: string
  provenance: LabProvenance
}

export interface LabFault {
  category: string
  description: string
  diagnosticLevel: "connection" | "readiness" | "operation"
  expectedCategory: string
  expectedFirstFailedPhase: string
  id: string
  name: string
  phase: string
  profileIds: readonly string[]
}

export interface SafeLabEvent {
  at: string
  category: string
  correlationId?: string
  faultId?: string
  message: string
  phase?: string
  requestMethod?: string
}

export interface ProbeComparison {
  mode: string
  expected: {
    category: string | null
    firstFailedPhase: string | null
    outcome: string
  }
  matchesExpectation: boolean
  observed: {
    category: string | null
    firstFailedPhase: string | null
    outcome: string
  }
  summary: string
}

export interface LabInstanceView {
  activeFault: LabFault | null
  createdAt: string
  displayName: string
  endpoint: {
    baseUrl: string
    mcpUrl: string
  } | null
  events: readonly SafeLabEvent[]
  id: string
  lastError: string | null
  lastProbe: ProbeComparison | null
  oauth: {
    authorizationServerUrl: string | null
    clientId: string
    protectedResourceMetadataUrl: string | null
    redirectUris: readonly string[]
    registration: "dynamic" | "manual"
  }
  port: number
  profile: LabProfile
  scenarioRevision: number
  secretsConfigured: {
    clientId: boolean
    clientSecret: boolean
  }
  state: InstanceLifecycleState
}

export interface EnterpriseMockLabControlPlane {
  catalog(): { faults: readonly LabFault[]; profiles: readonly LabProfile[] }
  create(input: CreateInstanceInput): Promise<LabInstanceView>
  get(id: string): LabInstanceView | undefined
  list(): readonly LabInstanceView[]
  probe(id: string): Promise<LabInstanceView>
  remove(id: string): Promise<void>
  reset(id: string): Promise<LabInstanceView>
  start(id: string): Promise<LabInstanceView>
  stop(id: string): Promise<LabInstanceView>
  updateScenario(id: string, input: UpdateScenarioInput): Promise<LabInstanceView>
}

export class ControlPlaneError extends Error {
  constructor(
    readonly code: "conflict" | "not_found" | "invalid_state" | "invalid_request" | "payload_too_large",
    message: string,
  ) {
    super(message)
    this.name = "ControlPlaneError"
  }
}
