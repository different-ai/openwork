export type EnvironmentOidcIdentity = { sub: string; email: string }

type LocalUser = { id: string; emailVerified: boolean }
type LinkedUser = { userId: string; email: string }

export type EnvironmentOidcIdentityPolicy = {
  available(): Promise<boolean>
  enterpriseRequired(email: string): Promise<boolean>
  localUser(email: string): Promise<LocalUser | null>
  linkedUser(sub: string): Promise<LinkedUser | null>
  installationAllows(input: { email: string; userId: string | null }): Promise<boolean>
}

/** Run all admission policy before Better Auth can create/link an account.
 * Policy failures must never leave an attacker-controlled linked identity. */
export async function resolveEnvironmentOidcIdentityAuthorization(identity: EnvironmentOidcIdentity, policy: EnvironmentOidcIdentityPolicy) {
  if (!await policy.available() || await policy.enterpriseRequired(identity.email)) return false
  const localUser = await policy.localUser(identity.email)
  if (localUser && !localUser.emailVerified) return false
  const linked = await policy.linkedUser(identity.sub)
  // A stable subject cannot move into another local email/domain policy.
  if (linked && linked.email.toLowerCase() !== identity.email) return false
  if (linked && localUser && linked.userId !== localUser.id) return false
  return policy.installationAllows({ email: identity.email, userId: linked?.userId ?? localUser?.id ?? null })
}
