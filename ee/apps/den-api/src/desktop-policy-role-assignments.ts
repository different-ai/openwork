import {
  ORGANIZATION_ADMIN_ROLE,
  ORGANIZATION_MEMBER_ROLE,
  ORGANIZATION_OWNER_ROLE,
  organizationRoleValueSatisfies,
} from "./organization-role-hierarchy.js"

const desktopPolicyAssignmentRoles = [
  ORGANIZATION_OWNER_ROLE,
  ORGANIZATION_ADMIN_ROLE,
  ORGANIZATION_MEMBER_ROLE,
]

export function matchingDesktopPolicyAssignmentRoles(memberRole: string) {
  return desktopPolicyAssignmentRoles.filter((assignedRole) => (
    organizationRoleValueSatisfies({ roleValue: memberRole, requiredRole: assignedRole })
  ))
}
