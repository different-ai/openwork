import { z } from "zod"

/**
 * OpenWork's production MCP baseline. Keep this value shared by every
 * producer, consumer, and health probe so the delivery path cannot drift from
 * the protocol that the runtime actually qualifies.
 */
export const OPENWORK_MCP_STABLE_PROTOCOL_VERSION = "2025-11-25" as const

/**
 * Locked release-candidate identifier used only by the disabled-by-default
 * current-protocol boundary. It must be revalidated against the final
 * specification and stable SDK before it can become a production default.
 */
export const OPENWORK_MCP_CURRENT_PROTOCOL_VERSION = "2026-07-28" as const

export const openworkMcpProtocolPolicySchema = z.enum(["stable", "current", "auto"])
export type OpenWorkMcpProtocolPolicy = z.infer<typeof openworkMcpProtocolPolicySchema>

export const openworkMcpNegotiatedEraSchema = z.enum(["stable", "current"])
export type OpenWorkMcpNegotiatedEra = z.infer<typeof openworkMcpNegotiatedEraSchema>

export const openworkMcpProtocolStatusSchema = z.object({
  policy: openworkMcpProtocolPolicySchema,
  era: openworkMcpNegotiatedEraSchema.nullable(),
  negotiatedVersion: z.string().min(1).nullable(),
  supportedVersions: z.array(z.string().min(1)),
  capabilityHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  authorizationResource: z.string().url().nullable(),
  authorizationServerIssuer: z.string().url().nullable(),
  sdkIdentity: z.string().min(1),
  schemaIdentity: z.string().min(1),
  conformanceProfile: z.string().min(1).nullable(),
  warnings: z.array(z.object({
    code: z.string().min(1),
    message: z.string().min(1),
  })),
})
export type OpenWorkMcpProtocolStatus = z.infer<typeof openworkMcpProtocolStatusSchema>
