import { organizationRoleValueSatisfies } from "../organization-role-hierarchy.js"
import type { AuthorityElevation } from "./hook-seams.js"

export type OrganizationAdminTeam = { id: string; name: string }

// Today's only elevation is "admin": append it when the direct role does not
// already satisfy admin. The stored role is never changed.
export function computeEffectiveRole(directRole: string, elevations: readonly AuthorityElevation[]) {
  return elevations.some((elevation) => elevation.role === "admin") && !organizationRoleValueSatisfies({ roleValue: directRole, requiredRole: "admin" })
    ? `${directRole},admin`
    : directRole
}

// Keeps the existing `adminTeams` payload shape ({ id, name }[]).
export function adminTeamsFromElevations(elevations: readonly AuthorityElevation[]): OrganizationAdminTeam[] {
  return elevations.filter((elevation) => elevation.role === "admin").map(({ source }) => ({ id: source.id, name: source.name }))
}
