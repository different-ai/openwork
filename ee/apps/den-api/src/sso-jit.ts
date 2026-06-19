export const ORGANIZATION_SSO_JIT_ROLE: "member" = "member"

export const SSO_IDENTITY_EXTRA_FIELDS = {
  department: "department",
} satisfies Record<string, string>

type OrganizationSsoJitRoleInput = {
  userInfo: Record<string, unknown>
}

export async function getOrganizationSsoJitRole(_input: OrganizationSsoJitRoleInput): Promise<typeof ORGANIZATION_SSO_JIT_ROLE> {
  return ORGANIZATION_SSO_JIT_ROLE
}
