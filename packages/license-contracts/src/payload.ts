import { z } from "zod"
import type { EffectiveModules } from "./resolver"

const transitionOperationPolicySchema = z.enum(["allow", "owner_only", "deny"])

/**
 * Client wire shape of one module's state. Ids and reasons are plain strings
 * so an older den-web or desktop ignores values it doesn't know instead of failing.
 */
export const moduleStateSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("on") }),
  z.object({
    state: z.literal("restricted"),
    until: z.string(),
    operations: z.record(z.string(), z.union([transitionOperationPolicySchema, z.string()])),
  }),
  z.object({
    state: z.literal("off"),
    reason: z.string(),
    requires: z.string().optional(),
    detail: z.string().optional(),
  }),
]).meta({ ref: "ModuleState" })
export type ModuleStatePayload = z.infer<typeof moduleStateSchema>

/** `modules` and `featureFlags` as served on `/v1/org`, `/v1/me` and desktop config. */
export const orgModulesPayloadSchema = z.object({
  modules: z.record(z.string(), moduleStateSchema),
  featureFlags: z.record(z.string(), z.boolean()),
}).meta({ ref: "OrgModulesPayload" })
export type OrgModulesPayload = z.infer<typeof orgModulesPayloadSchema>

export function toOrgModulesPayload(effective: EffectiveModules): OrgModulesPayload {
  const modules: Record<string, ModuleStatePayload> = {}
  for (const [id, state] of Object.entries(effective.modules)) {
    if (state.state === "restricted") {
      modules[id] = { state: "restricted", until: state.until, operations: { ...state.operations } }
    } else if (state.state === "off") {
      modules[id] =
        state.reason === "requires"
          ? { state: "off", reason: state.reason, requires: state.requires }
          : state.reason === "not_available"
            ? { state: "off", reason: state.reason, detail: state.detail }
            : { state: "off", reason: state.reason }
    } else {
      modules[id] = { state: "on" }
    }
  }
  return { modules, featureFlags: { ...effective.featureFlags } }
}
