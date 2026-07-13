import type { DenTypeId } from "@openwork-ee/utils/typeid"

export function oauthClientIdentityChanged(input: {
  hadExistingClient: boolean
  previousClientId: string | null
  nextClientId: string
  previousTenantId: string | null
  nextTenantId: string | null
}): boolean {
  if (!input.hadExistingClient) return false
  return input.previousClientId !== input.nextClientId || input.previousTenantId !== input.nextTenantId
}

export async function revokeAccountsBeforeOAuthClientIdentityChange(input: {
  hadExistingClient: boolean
  previousClientId: string | null
  nextClientId: string
  previousTenantId: string | null
  nextTenantId: string | null
  organizationId: DenTypeId<"organization">
  providerId: string
  revoke: (target: { organizationId: DenTypeId<"organization">; providerId: string }) => Promise<void>
}): Promise<boolean> {
  if (!oauthClientIdentityChanged(input)) return false
  await input.revoke({ organizationId: input.organizationId, providerId: input.providerId })
  return true
}
