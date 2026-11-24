import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { ConfigApplyStep } from "@openwork/types/den/config-blobs"
import type { PermissionKey } from "@openwork/types/den/permissions"
import { permissionDeniedMessage } from "../../permissions/effective.js"
import { resolvePermissionsForMember } from "../../permissions/resolve.js"
import { ConfigApplyItemError, type ConfigApplyOp, type ConfigAreaContext, type ConfigItem, type ConfigNaturalKey } from "../area.js"
import { ConfigApplyError } from "./route-support.js"

export const ORG_SINGLETON_NATURAL_KEY: ConfigNaturalKey = { label: "organization", get: () => "organization" }

export async function requireActorPermission(ctx: ConfigAreaContext, key: PermissionKey): Promise<void> {
  const held = await resolvePermissionsForMember({
    organizationId: normalizeDenTypeId("organization", ctx.organizationId),
    memberId: normalizeDenTypeId("member", ctx.actor.memberId),
  })
  if (!held.has(key)) throw new ConfigApplyError("forbidden", permissionDeniedMessage(key), 403)
}

export async function readSingleton(ctx: ConfigAreaContext, ids: string[], exportItems: (ctx: ConfigAreaContext) => Promise<ConfigItem[]>): Promise<ConfigItem[]> {
  if (!ids.includes(ctx.organizationId)) return []
  return exportItems(ctx)
}

export function touches(op: ConfigApplyOp, path: string): boolean {
  if (op.kind !== "update") return true
  const paths = [...op.changes.map((change) => change.path), ...op.secretPaths]
  return paths.some((changed) => related(changed, path))
}

function related(a: string, b: string): boolean {
  if (a === b) return true
  const [shorter, longer] = a.length < b.length ? [a, b] : [b, a]
  if (!longer.startsWith(shorter)) return false
  const next = longer.charAt(shorter.length)
  return next === "." || next === "["
}

export class ConfigFieldError extends ConfigApplyError {
  constructor(code: string, message: string, readonly field: string, status?: number) {
    super(code, message, status)
    this.name = "ConfigFieldError"
  }
}

export class ApplySteps {
  readonly done: ConfigApplyStep[] = []

  async run(step: ConfigApplyStep, field: string | undefined, write: () => Promise<void>): Promise<void> {
    try {
      await write()
    } catch (error) {
      throw itemError(error, this.done, step, field)
    }
    this.done.push(step)
  }

  fail(code: string, message: string, field?: string, status?: number): ConfigApplyItemError {
    return new ConfigApplyItemError({ code, message, ...(field ? { field } : {}), ...(status ? { status } : {}) }, [...this.done])
  }
}

function itemError(error: unknown, done: ConfigApplyStep[], step: ConfigApplyStep, field: string | undefined): ConfigApplyItemError {
  if (error instanceof ConfigApplyItemError) return error
  const where = { step, ...(field ? { field } : {}) }
  if (error instanceof ConfigApplyError) {
    const at = error instanceof ConfigFieldError ? { ...where, field: error.field } : where
    return new ConfigApplyItemError({ code: error.code, message: error.message, ...at, ...(error.status ? { status: error.status } : {}) }, [...done])
  }
  const message = error instanceof Error ? error.message : String(error)
  return new ConfigApplyItemError({ code: "apply_failed", message, ...where }, [...done])
}
