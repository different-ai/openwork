import { z } from "zod"
import { activeFaultSchema } from "./fault.js"
import { handshakePhaseSchema } from "./phases.js"
import { providerProfileIdSchema, type ProviderProfileId } from "./profile.js"
import { getFaultDefinition } from "../faults/catalog.js"
import { getProviderProfile } from "../profiles/profiles.js"
import { oauthRedirectUriSchema } from "./oauth.js"
import { deepFreeze, type DeepReadonly } from "../immutability.js"

const rawScenarioSchema = z.object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    revision: z.number().int().positive(),
    profileId: providerProfileIdSchema,
    profileFixtureVersion: z.string().regex(/^\d{4}-\d{2}-\d{2}\.\d+$/),
    protocol: z.object({
      version: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      responseMode: z.enum(["json", "sse"]),
      requireSession: z.literal(true),
      pageSize: z.number().int().positive().max(100),
    }),
    oauth: z.object({
      registration: z.enum(["manual", "dynamic"]),
      clientId: z.string().min(3).max(200),
      redirectUris: z.array(oauthRedirectUriSchema).min(1).max(10),
      authorizationScopes: z.array(z.string().min(1)).min(1),
      requiredResourceScopes: z.array(z.string().min(1)).min(1),
    }),
    activeFault: activeFaultSchema.nullable(),
    expected: z.object({
      outcome: z.enum(["success", "failure"]),
      firstFailedPhase: handshakePhaseSchema.nullable(),
      category: z.string().regex(/^[a-z][a-z0-9_]*$/).nullable(),
    }),
  })

export type EnterpriseMcpScenario = DeepReadonly<z.infer<typeof rawScenarioSchema>>

export const scenarioSchema = rawScenarioSchema
  .superRefine((scenario, context) => {
    const profile = getProviderProfile(scenario.profileId)
    if (scenario.profileFixtureVersion !== profile.fixtureVersion) {
      context.addIssue({
        code: "custom",
        message: `Scenario pins profile fixture '${scenario.profileFixtureVersion}', but '${profile.id}' is '${profile.fixtureVersion}'`,
        path: ["profileFixtureVersion"],
      })
    }
    if (!profile.protocol.versions.includes(scenario.protocol.version)) {
      context.addIssue({ code: "custom", message: "Protocol version is not supported by the selected profile", path: ["protocol", "version"] })
    }
    if (!profile.protocol.responseModes.includes(scenario.protocol.responseMode)) {
      context.addIssue({ code: "custom", message: "Response mode is not supported by the selected profile", path: ["protocol", "responseMode"] })
    }
    if (!profile.oauth.registrationModes.includes(scenario.oauth.registration)) {
      context.addIssue({ code: "custom", message: "OAuth registration mode is not supported by the selected profile", path: ["oauth", "registration"] })
    }
    if (scenario.oauth.authorizationScopes.some((scope) => !profile.oauth.authorizationScopes.includes(scope))) {
      context.addIssue({ code: "custom", message: "Authorization scopes must belong to the selected profile", path: ["oauth", "authorizationScopes"] })
    }
    if (profile.oauth.requiredResourceScopes.some((scope) => !scenario.oauth.authorizationScopes.includes(scope))) {
      context.addIssue({ code: "custom", message: "Authorization scopes must include every profile-required MCP resource scope", path: ["oauth", "authorizationScopes"] })
    }
    if (scenario.oauth.requiredResourceScopes.some((scope) => !scenario.oauth.authorizationScopes.includes(scope))) {
      context.addIssue({ code: "custom", message: "Resource scopes must be included in authorization scopes", path: ["oauth", "requiredResourceScopes"] })
    }
    if (
      scenario.oauth.requiredResourceScopes.length !== profile.oauth.requiredResourceScopes.length ||
      profile.oauth.requiredResourceScopes.some((scope) => !scenario.oauth.requiredResourceScopes.includes(scope))
    ) {
      context.addIssue({ code: "custom", message: "Resource scopes must exactly match the pinned profile fixture", path: ["oauth", "requiredResourceScopes"] })
    }

    if (!scenario.activeFault) {
      if (scenario.expected.outcome !== "success" || scenario.expected.firstFailedPhase !== null || scenario.expected.category !== null) {
        context.addIssue({ code: "custom", message: "A healthy scenario must expect success without a failed phase or category", path: ["expected"] })
      }
      return
    }

    const definition = getFaultDefinition(scenario.activeFault.id)
    if (!definition) {
      context.addIssue({ code: "custom", message: `Unknown fault '${scenario.activeFault.id}'`, path: ["activeFault", "id"] })
      return
    }
    if (!definition.applicableProfiles.includes(scenario.profileId)) {
      context.addIssue({ code: "custom", message: "Fault does not apply to the selected provider profile", path: ["activeFault", "id"] })
    }
    if (definition.effect === "broken-sse" && scenario.protocol.responseMode !== "sse") {
      context.addIssue({ code: "custom", message: "Broken SSE fault requires the SSE response mode", path: ["protocol", "responseMode"] })
    }
    if (
      scenario.expected.outcome !== "failure" ||
      scenario.expected.firstFailedPhase !== definition.phase ||
      scenario.expected.category !== definition.category
    ) {
      context.addIssue({
        code: "custom",
        message: "Expected result must match the selected fault definition",
        path: ["expected"],
      })
    }
  })
  .transform((scenario): EnterpriseMcpScenario => deepFreeze(scenario) as EnterpriseMcpScenario)

export function createDefaultScenario(profileId: ProviderProfileId = "servicenow-inbound-quickstart"): EnterpriseMcpScenario {
  const profile = getProviderProfile(profileId)
  return scenarioSchema.parse({
    schemaVersion: 1,
    id: `${profileId}-healthy`,
    revision: 1,
    profileId,
    profileFixtureVersion: profile.fixtureVersion,
    protocol: {
      version: profile.protocol.versions[0],
      responseMode: profile.protocol.responseModes[0],
      requireSession: profile.protocol.sessionMode === "required",
      pageSize: profile.protocol.pageSize,
    },
    oauth: {
      registration: profile.oauth.defaultRegistration,
      clientId: "enterprise-mcp-test-client",
      redirectUris: ["http://127.0.0.1:19876/mcp/oauth/callback"],
      authorizationScopes: profile.oauth.authorizationScopes,
      requiredResourceScopes: profile.oauth.requiredResourceScopes,
    },
    activeFault: null,
    expected: { outcome: "success", firstFailedPhase: null, category: null },
  })
}

export function createFaultScenario(
  profileId: ProviderProfileId,
  faultId: string,
  revision = 1,
): EnterpriseMcpScenario {
  const base = createDefaultScenario(profileId)
  const fault = getFaultDefinition(faultId)
  if (!fault || !fault.applicableProfiles.includes(profileId)) {
    throw new Error(`Fault '${faultId}' does not apply to profile '${profileId}'`)
  }
  return scenarioSchema.parse({
    ...base,
    id: `${profileId}-${faultId}`,
    revision,
    protocol:
      fault.effect === "broken-sse"
        ? { ...base.protocol, responseMode: "sse" }
        : fault.effect === "duplicate-tool" || fault.effect === "repeat-cursor"
          ? { ...base.protocol, pageSize: 1 }
          : base.protocol,
    activeFault: { id: fault.id, trigger: { occurrence: "always" } },
    expected: { outcome: "failure", firstFailedPhase: fault.phase, category: fault.category },
  })
}
