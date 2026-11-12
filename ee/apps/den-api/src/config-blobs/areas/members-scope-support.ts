/**
 * Shared by the per-scope areas on a team's tabs (`members.agent-permissions`,
 * `members.default-models`, `members.prompts`): settings kept once for
 * Everyone and once per team.
 *
 * - The scope is `team: null` (Everyone) or `team: { $ref: "members.teams/<id>" }`.
 * - Matching across organizations goes by scope: "everyone", or the team's
 *   name (the ref's name hint, else the item name), since team ids differ.
 * - Uniqueness on the target goes by the localized team ref.
 */
import { and, eq } from "@openwork-ee/den-db/drizzle"
import { TeamTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { ConfigApplyFailure, ConfigApplyStep } from "@openwork/types/den/config-blobs"
import type { PermissionKey } from "@openwork/types/den/permissions"
import { permissionDeniedMessage } from "../../permissions/effective.js"
import { resolvePermissionsForMember } from "../../permissions/resolve.js"
import { ConfigApplyItemError, type ConfigAreaContext, type ConfigItem, type ResolvedConfigItem } from "../area.js"
import { configItemError, isJsonObject } from "./route-support.js"

export const EVERYONE_SCOPE = "everyone"

export type TeamScope = { kind: "everyone" } | { kind: "team"; teamId: string; teamName: string }

/** Throws a ConfigApplyItemError with where it failed and what was already written. */
export function applyFailure(failure: ConfigApplyFailure, stepsDone: ConfigApplyStep[] = []): never {
  throw new ConfigApplyItemError(failure, stepsDone)
}

/** Any error from an apply as a ConfigApplyItemError carrying the steps already written. */
export function asItemError(error: unknown, stepsDone: ConfigApplyStep[]): ConfigApplyItemError {
  return configItemError(error, stepsDone)
}

/** The route's own permission marker (orgPermissionRoute), which applying outside a request does not run. */
export async function requireActorPermission(ctx: ConfigAreaContext, key: PermissionKey) {
  const held = await resolvePermissionsForMember({
    organizationId: normalizeDenTypeId("organization", ctx.organizationId),
    memberId: normalizeDenTypeId("member", ctx.actor.memberId),
  })
  if (!held.has(key)) applyFailure({ code: "forbidden", message: permissionDeniedMessage(key), status: 403 })
}

function refOf(value: unknown): { $ref: string; name?: string; id?: string } | null {
  if (!isJsonObject(value) || typeof value.$ref !== "string") return null
  return {
    $ref: value.$ref,
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.id === "string" ? { id: value.id } : {}),
  }
}

/** Natural key: "everyone", or `team:<lowercased team name>`. */
export function scopeNaturalKey(item: ConfigItem): string | null {
  const ref = refOf(item.spec.team)
  if (!ref) return item.spec.team === null || item.spec.team === undefined ? EVERYONE_SCOPE : null
  const name = (ref.name ?? item.name).trim().toLowerCase()
  return name ? `team:${name}` : null
}

/** Unique per organization: "everyone", or the team (local id once refs are localized/resolved). */
export function scopeUniqueKey(item: ConfigItem | ResolvedConfigItem): string | null {
  const ref = refOf(item.spec.team)
  if (!ref) return item.spec.team === null || item.spec.team === undefined ? EVERYONE_SCOPE : null
  if (ref.id) return `members.teams/${ref.id}`
  return ref.$ref
}

/** The scope an item writes to on the target: Everyone, or a team of this organization (resolved ref). */
export async function resolveItemScope(ctx: ConfigAreaContext, spec: { [key: string]: unknown }): Promise<TeamScope> {
  if (spec.team === null || spec.team === undefined) return { kind: "everyone" }
  const ref = refOf(spec.team)
  if (!ref?.id) applyFailure({ code: "ref_unresolved", message: `The team reference ${ref?.$ref ?? "?"} was not resolved.`, field: "team" })
  let teamId: string
  try {
    teamId = normalizeDenTypeId("team", ref.id)
  } catch {
    applyFailure({ code: "invalid_spec", message: `${ref.id} is not a team id.`, field: "team" })
  }
  const [team] = await ctx.db
    .select({ id: TeamTable.id, name: TeamTable.name })
    .from(TeamTable)
    .where(and(eq(TeamTable.organizationId, normalizeDenTypeId("organization", ctx.organizationId)), eq(TeamTable.id, normalizeDenTypeId("team", teamId))))
    .limit(1)
  if (!team) applyFailure({ code: "team_not_found", message: `The team ${ref.name ? `"${ref.name}" ` : ""}was not found in this organization.`, field: "team", status: 404 })
  return { kind: "team", teamId: team.id, teamName: team.name }
}

export function scopeLabel(scope: TeamScope): string {
  return scope.kind === "everyone" ? "Everyone" : scope.teamName
}

/** Whether an update's changes touch the scope (`team`), which an update never moves. */
export function changesScope(changes: readonly { path: string }[]): boolean {
  return changes.some((change) => change.path === "team" || change.path.startsWith("team.") || change.path === "(spec)")
}

export function sameScope(scope: TeamScope, previousSpec: { [key: string]: unknown }): boolean {
  const ref = refOf(previousSpec.team)
  if (scope.kind === "everyone") return !ref
  if (!ref) return false
  return (ref.id ?? ref.$ref.slice(ref.$ref.indexOf("/") + 1)) === scope.teamId
}

/** The scope of a target item (its exported spec), with the team ref's local id filled in as `id`. */
export function previousScopeSpec(item: ConfigItem): { [key: string]: unknown } {
  const ref = refOf(item.spec.team)
  if (!ref) return { team: null }
  return { team: { ...ref, id: ref.id ?? ref.$ref.slice(ref.$ref.indexOf("/") + 1) } }
}
