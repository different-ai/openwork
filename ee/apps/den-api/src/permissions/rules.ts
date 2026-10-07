import { readPermissionSetRules } from "@openwork-ee/den-db/permission-rules"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { SourcedPolicyRule } from "@openwork/types/den/policy-rules"
import { db } from "../db.js"
import { permissionSetsForMember } from "./resolve.js"

/**
 * A member's permission rules: the rules of every set that applies to them,
 * Member first, then Admin, then each team's, each labelled with its set. As in
 * OpenCode config, later rules win.
 */
export async function permissionRulesForMember(input: Parameters<typeof permissionSetsForMember>[0]): Promise<SourcedPolicyRule[]> {
  const sets = (await permissionSetsForMember(input)).map((set) => ({ ...set, setId: normalizeDenTypeId("permissionSet", set.setId) }))
  if (sets.length === 0) return []
  const rules = await readPermissionSetRules(db, sets.map((set) => set.setId))
  return sets.flatMap(({ setId, setName }) => (rules.get(setId) ?? []).map((rule) => ({ ...rule, source: setName })))
}
