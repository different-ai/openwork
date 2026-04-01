import { createAccessControl } from "better-auth/plugins/access"
import { defaultRoles, defaultStatements } from "better-auth/plugins/organization/access"

export const denOrganizationAccess = createAccessControl(defaultStatements)

export const denOrganizationStaticRoles = {
  owner: defaultRoles.owner,
  admin: defaultRoles.admin,
  member: defaultRoles.member,
} as const

export const denDefaultDynamicOrganizationRoles = {
  admin: defaultRoles.admin.statements,
  member: defaultRoles.member.statements,
} as const
