import { z } from "zod"
import { handshakePhaseSchema, operatorActionSchema } from "./phases.js"
import { providerProfileIdSchema } from "./profile.js"
import { deepFreeze, type DeepReadonly } from "../immutability.js"

export const faultTriggerSchema = z.discriminatedUnion("occurrence", [
  z.object({ occurrence: z.literal("always") }),
  z.object({ occurrence: z.literal("once") }),
  z.object({ occurrence: z.literal("nth"), requestNumber: z.number().int().positive() }),
])

export const activeFaultSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  trigger: faultTriggerSchema,
})

const rawFaultDefinitionSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  displayName: z.string().min(1),
  description: z.string().min(1),
  phase: handshakePhaseSchema,
  category: z.string().regex(/^[a-z][a-z0-9_]*$/),
  retryable: z.boolean(),
  operatorAction: operatorActionSchema,
  applicableProfiles: z.array(providerProfileIdSchema).min(1),
  effect: z.enum([
    "omit-auth-challenge",
    "malformed-resource-metadata",
    "issuer-mismatch",
    "omit-pkce-s256",
    "reject-registration",
    "reject-client",
    "reject-grant",
    "reject-audience",
    "reject-scope",
    "reject-version",
    "malform-initialize",
    "expire-session",
    "reject-initialized",
    "wrong-content-type",
    "broken-sse",
    "empty-catalog",
    "repeat-cursor",
    "duplicate-tool",
    "invalid-tool-schema",
    "provider-authorization-denial",
    "provider-policy-denial",
    "provider-throttle",
    "provider-unavailable",
    "commit-then-disconnect",
  ]),
})

export const faultDiagnosticLevelSchema = z.enum(["connection", "readiness", "operation"])
export type FaultDiagnosticLevel = z.infer<typeof faultDiagnosticLevelSchema>

type FaultDefinitionValue = z.infer<typeof rawFaultDefinitionSchema> & { readonly diagnosticLevel: FaultDiagnosticLevel }
export type FaultDefinition = DeepReadonly<FaultDefinitionValue>

export const faultDefinitionSchema = rawFaultDefinitionSchema.transform((fault): FaultDefinition => deepFreeze({
    ...fault,
    diagnosticLevel: fault.effect === "empty-catalog" || fault.effect === "repeat-cursor" || fault.effect === "duplicate-tool" || fault.effect === "invalid-tool-schema"
      ? "readiness" as const
      : fault.phase === "PROVIDER_AUTHORIZATION" || fault.phase === "PROVIDER_EXECUTION"
        ? "operation" as const
        : "connection" as const,
  }) as FaultDefinition)

export type FaultTrigger = z.infer<typeof faultTriggerSchema>
export type ActiveFault = z.infer<typeof activeFaultSchema>
