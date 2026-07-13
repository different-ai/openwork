import { z } from "zod"
import { mockToolSchema } from "./tool.js"
import { deepFreeze, type DeepReadonly } from "../immutability.js"

export const providerProfileIdSchema = z.enum([
  "synthetic-enterprise-oauth-mcp",
  "servicenow-inbound-quickstart",
  "microsoft-work-iq",
  "microsoft-enterprise",
  "agent-365-mail-v1-2026-07",
])

export type ProviderProfileId = z.infer<typeof providerProfileIdSchema>

export const profileAspectFidelitySchema = z.enum([
  "provider-documented",
  "provider-observed",
  "mcp-specification",
  "spec-conformant",
  "synthetic",
])

const rawProviderProfileSchema = z.object({
    id: providerProfileIdSchema,
    displayName: z.string().min(1),
    provider: z.enum(["servicenow", "microsoft", "synthetic"]),
    productSurface: z.string().min(1),
    fixtureVersion: z.string().regex(/^\d{4}-\d{2}-\d{2}\.\d+$/),
    direction: z.literal("client-to-provider"),
    endpointPath: z.string().startsWith("/"),
    canonicalEndpoint: z.url(),
    provenance: z.object({
      fidelity: z.enum(["spec-conformant", "provider-documented", "provider-observed", "synthetic"]),
      verifiedAt: z.iso.date(),
      providerRelease: z.string().min(1),
      preview: z.boolean(),
      documentationUrls: z.array(z.url()).min(1),
      limitations: z.array(z.string().min(1)).min(1),
      aspectFidelity: z.object({
        endpoint: profileAspectFidelitySchema,
        authorization: profileAspectFidelitySchema,
        catalog: profileAspectFidelitySchema,
        toolSchemas: profileAspectFidelitySchema,
        providerResults: profileAspectFidelitySchema,
        transport: profileAspectFidelitySchema,
      }),
    }),
    oauth: z.object({
      defaultRegistration: z.enum(["manual", "dynamic"]),
      registrationModes: z.array(z.enum(["manual", "dynamic"])).min(1),
      pkceRequired: z.literal(true),
      issuer: z.string().min(1),
      resource: z.string().min(1),
      audience: z.string().min(1),
      authorizationPath: z.string().startsWith("/"),
      tokenPath: z.string().startsWith("/"),
      revocationPath: z.string().startsWith("/"),
      registrationPath: z.string().startsWith("/").nullable(),
      authorizationScopes: z.array(z.string().min(1)).min(1),
      requiredResourceScopes: z.array(z.string().min(1)).min(1),
      defaultClientAuthenticationMethod: z.enum(["none", "client_secret_post"]),
      clientAuthenticationMethods: z.array(z.enum(["none", "client_secret_post"])).min(1),
    }),
    protocol: z.object({
      versions: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(1),
      responseModes: z.array(z.enum(["json", "sse"])).min(1),
      sessionMode: z.literal("required"),
      pageSize: z.number().int().positive().max(100),
      fidelity: z.enum(["mcp-specification", "provider-observed"]),
    }),
    tools: z.array(mockToolSchema).min(1),
  })

export type ProviderProfile = DeepReadonly<z.infer<typeof rawProviderProfileSchema>>

export const providerProfileSchema = rawProviderProfileSchema
  .superRefine((profile, context) => {
    const toolNames = new Set<string>()
    for (const [index, tool] of profile.tools.entries()) {
      if (toolNames.has(tool.name)) {
        context.addIssue({ code: "custom", message: `Duplicate tool '${tool.name}'`, path: ["tools", index, "name"] })
      }
      toolNames.add(tool.name)
    }
    if (!profile.oauth.registrationModes.includes(profile.oauth.defaultRegistration)) {
      context.addIssue({
        code: "custom",
        message: "Default registration mode must be supported",
        path: ["oauth", "defaultRegistration"],
      })
    }
    for (const scope of profile.oauth.requiredResourceScopes) {
      if (!profile.oauth.authorizationScopes.includes(scope)) {
        context.addIssue({
          code: "custom",
          message: `Required resource scope '${scope}' must be requested during authorization`,
          path: ["oauth", "requiredResourceScopes"],
        })
      }
    }
    if (!profile.oauth.clientAuthenticationMethods.includes(profile.oauth.defaultClientAuthenticationMethod)) {
      context.addIssue({
        code: "custom",
        message: "Default client authentication method must be supported",
        path: ["oauth", "defaultClientAuthenticationMethod"],
      })
    }
  })
  .transform((profile): ProviderProfile => deepFreeze(profile) as ProviderProfile)
export type ProfileAspectFidelity = z.infer<typeof profileAspectFidelitySchema>
