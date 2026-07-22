export function isSingleOrgOwnerEmailEligible(input: {
  email: string | null | undefined
  ownerEmails: readonly string[]
}) {
  if (input.ownerEmails.length === 0) {
    return true
  }
  const normalizedEmail = input.email?.trim().toLowerCase()
  return !!normalizedEmail && input.ownerEmails.includes(normalizedEmail)
}

export function resolveSingleOrgMembershipRole(input: {
  activeOwnerCount: number
  email: string | null | undefined
  ownerEmails: readonly string[]
}) {
  if (input.activeOwnerCount > 0) {
    return "member"
  }

  if (!isSingleOrgOwnerEmailEligible({
    email: input.email,
    ownerEmails: input.ownerEmails,
  })) {
    return null
  }

  return "owner"
}
