import { z } from "zod"
import type { ModuleId } from "./module-ids"
import { MODULE_DEFINITIONS, type ModuleDefinition } from "./modules"
import { MODULE_OFF_REASONS, type ModuleOffReason, type ModuleOffState } from "./resolver"

export const MODULE_DISABLED_ERROR = "module_disabled" as const
export const LICENSE_UNAVAILABLE_ERROR = "license_unavailable" as const
export const MODULE_HEADER = "X-OpenWork-Module"
export const MODULE_REASON_HEADER = "X-OpenWork-Module-Reason"

export const moduleOffReasonSchema = z.enum(MODULE_OFF_REASONS)
export const MODULE_DISABLED_ACTIONS = ["contact_support", "ask_admin", "none"] as const
export const moduleDisabledActionSchema = z.enum(MODULE_DISABLED_ACTIONS)
export type ModuleDisabledAction = z.infer<typeof moduleDisabledActionSchema>

/** Server side, strict: used to build bodies and for OpenAPI (§8.2a, D39). */
export const moduleDisabledErrorSchema = z.object({
  error: z.literal(MODULE_DISABLED_ERROR),
  /** A string, not an enum: older clients must parse newer ids. */
  module: z.string(),
  reason: moduleOffReasonSchema,
  requires: z.string().nullable(),
  message: z.string(),
  action: moduleDisabledActionSchema,
}).meta({ ref: "ModuleDisabledError" })
export type ModuleDisabledError = z.infer<typeof moduleDisabledErrorSchema>

/** Client side: tolerates reasons and actions added later. */
export const moduleDisabledErrorClientSchema = z.object({
  error: z.literal(MODULE_DISABLED_ERROR),
  module: z.string(),
  reason: z.string(),
  requires: z.string().nullable().optional(),
  message: z.string(),
  action: z.string(),
})
export type ModuleDisabledErrorClient = z.infer<typeof moduleDisabledErrorClientSchema>

export const licenseUnavailableErrorSchema = z.object({
  error: z.literal(LICENSE_UNAVAILABLE_ERROR),
  message: z.string(),
}).meta({ ref: "LicenseUnavailableError" })
export type LicenseUnavailableError = z.infer<typeof licenseUnavailableErrorSchema>

/** A restricted module whose transition policy denied the operation. */
export type ModuleRestrictedDenial = { readonly state: "restricted"; readonly denied: true }

const ACTIONS: Readonly<Record<ModuleOffReason, ModuleDisabledAction>> = {
  not_entitled: "contact_support",
  license_expired: "contact_support",
  disabled_by_org: "ask_admin",
  requires: "none",
  not_available: "none",
  not_on_deployment: "none",
}

function messageFor(reason: ModuleOffReason, name: string, requiresName: string | null): string {
  switch (reason) {
    case "not_entitled":
      return `${name} isn't included in your organization's plan. Contact support to upgrade.`
    case "license_expired":
      return `${name} is limited because your license has expired. Contact support to renew.`
    case "disabled_by_org":
      return `An administrator turned off ${name} for your organization.`
    case "requires":
      return `${name} needs ${requiresName ?? "another module"}, which is turned off.`
    case "not_available":
      return `${name} isn't set up on this deployment.`
    case "not_on_deployment":
      return `${name} isn't part of this deployment.`
  }
}

/** The one "module off" body (§8.2a). Restricted denials use `license_expired`. */
export function buildModuleDisabledBody(input: {
  moduleId: ModuleId
  state: ModuleOffState | ModuleRestrictedDenial
  definitions?: Readonly<Record<ModuleId, ModuleDefinition>>
}): ModuleDisabledError {
  const definitions = input.definitions ?? MODULE_DEFINITIONS
  const reason: ModuleOffReason = input.state.state === "restricted" ? "license_expired" : input.state.reason
  const requires = input.state.state === "off" && input.state.reason === "requires" ? input.state.requires : null
  const requiresName = requires === null ? null : definitions[requires].name
  return {
    error: MODULE_DISABLED_ERROR,
    module: input.moduleId,
    reason,
    requires,
    message: messageFor(reason, definitions[input.moduleId].name, requiresName),
    action: ACTIONS[reason],
  }
}

export function moduleDisabledHeaders(body: Pick<ModuleDisabledError, "module" | "reason">): Record<string, string> {
  return { [MODULE_HEADER]: body.module, [MODULE_REASON_HEADER]: body.reason }
}

/** 404 on desktop-facing routes (current desktops treat it as "absent"), 403 elsewhere (D35, D39). */
export function moduleDisabledStatus(route: { desktopFacing: boolean }): 403 | 404 {
  return route.desktopFacing ? 404 : 403
}
