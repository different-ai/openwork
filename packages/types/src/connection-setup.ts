import { z } from "zod"

export const mcpRequirementsSchema = z.object({
  status: z.enum(["ready", "manual_action_required", "unsupported", "unreachable"]),
  server: z.object({
    url: z.string(),
    protocolVersion: z.string().optional(),
    initialize: z.enum(["succeeded", "authentication_required", "failed"]),
  }),
  authentication: z.object({
    kind: z.enum(["none", "oauth", "manual_bearer", "unknown"]),
    resource: z.string().optional(),
    protectedResourceMetadataUrl: z.string().optional(),
    authorizationServers: z.array(z.object({
      issuer: z.string(),
      authorizationEndpoint: z.string().optional(),
      tokenEndpoint: z.string().optional(),
      registrationEndpoint: z.string().optional(),
      clientIdMetadataDocumentSupported: z.boolean(),
      scopesSupported: z.array(z.string()).optional(),
      grantTypesSupported: z.array(z.string()).optional(),
      codeChallengeMethodsSupported: z.array(z.string()).optional(),
      tokenEndpointAuthMethodsSupported: z.array(z.string()).optional(),
    })),
    requiredScopes: z.array(z.string()),
    recommendedScopes: z.array(z.string()),
    refreshSupport: z.enum(["supported", "not_advertised", "unknown"]),
    availableRegistrationMethods: z.array(z.enum(["pre_registered", "client_metadata", "dynamic"])),
    recommendedRegistrationMethod: z.enum(["client_metadata", "dynamic", "pre_registered"]),
  }),
  tools: z.object({
    visibility: z.enum(["available_without_auth", "requires_auth", "unavailable"]),
    count: z.number().int().nonnegative().optional(),
    items: z.array(z.object({
      name: z.string(),
      readOnlyHint: z.boolean().optional(),
      destructiveHint: z.boolean().optional(),
      openWorldHint: z.boolean().optional(),
    })).optional(),
  }),
  manualRequirements: z.array(z.object({
    code: z.string(),
    label: z.string(),
    reason: z.string(),
    required: z.boolean(),
  })),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })),
}).meta({ ref: "ExternalMcpRequirementsDiscovery" })

export const connectionSetupInputSchema = z.object({
  query: z.string().trim().min(1).max(2048),
  connectionId: z.string().optional(),
  externalKey: z.string().max(160).optional(),
  resumeOnly: z.boolean().optional(),
})

export const setupAccessSchema = z.object({
  orgWide: z.boolean(),
  memberIds: z.array(z.string()),
  teamIds: z.array(z.string()),
})


export const setupConnectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  authType: z.enum(["oauth", "apikey", "none"]),
  credentialMode: z.enum(["shared", "per_member"]),
  connectedForMe: z.boolean(),
  needsReconnect: z.boolean(),
  canUse: z.boolean(),
  updatedAt: z.string(),
  access: setupAccessSchema.nullable(),
  externalAccountId: z.string().nullable(),
})

/** Human-session setup response. No credentials or authorization URLs. */
export const connectionSetupSchema = z.object({
  version: z.literal(1),
  organizationId: z.string(),
  memberId: z.string(),
  canManage: z.boolean(),
  members: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
  teams: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
  target: z.object({
    name: z.string(),
    url: z.string(),
    kind: z.enum(["external_mcp", "native_provider"]),
    nativeProviderKey: z.string().optional(),
    authType: z.enum(["oauth", "apikey", "none"]),
    requiresOAuthClient: z.boolean(),
    callbackUrl: z.string(),
    requiresTenant: z.boolean(),
    features: z.array(z.object({ id: z.string(), label: z.string(), selected: z.boolean() })),
  }).nullable(),
  connections: z.array(setupConnectionSchema),
  requirements: mcpRequirementsSchema.nullable(),
  message: z.string().nullable(),
})

export const connectionReadinessSchema = z.object({
  connectionId: z.string(),
  state: z.enum(["ready", "needs_auth", "blocked", "unavailable"]),
  message: z.string(),
  toolCount: z.number().int().nonnegative(),
})


export const createSetupConnectionSchema = z.object({
  kind: z.enum(["external_mcp", "native_provider"]),
  externalKey: z.string().min(1).max(160),
  name: z.string().trim().min(1).max(255),
  url: z.string(),
  nativeProviderKey: z.string().optional(),
  authType: z.enum(["oauth", "apikey", "none"]),
  credentialMode: z.enum(["shared", "per_member"]),
  apiKey: z.string().optional(),
  oauthClient: z.object({
    clientId: z.string(),
    clientSecret: z.string().optional(),
    tokenEndpointAuthMethod: z.enum(["client_secret_basic", "client_secret_post"]).optional(),
    features: z.array(z.string()).optional(),
    tenantId: z.string().optional(),
  }).optional(),
  authorizationServerIssuer: z.string().optional(),
  requestedScopes: z.array(z.string()),
  access: setupAccessSchema,
})

export type ConnectionSetup = z.infer<typeof connectionSetupSchema>
export type ConnectionSetupInput = z.infer<typeof connectionSetupInputSchema>
export type SetupConnection = z.infer<typeof setupConnectionSchema>
export type ConnectionReadiness = z.infer<typeof connectionReadinessSchema>
export type CreateSetupConnection = z.infer<typeof createSetupConnectionSchema>
