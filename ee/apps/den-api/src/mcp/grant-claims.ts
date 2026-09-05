export type McpConsentLookup = (input: {
  clientId: string
  userId: string
  referenceId: string
}) => Promise<{ id: string } | null>

export async function contributeMcpGrantClaim(input: {
  claimName: string
  clientId: string
  userId?: string | null
  referenceId?: string
  findConsent: McpConsentLookup
}): Promise<Record<string, string>> {
  if (!input.userId || !input.referenceId) {
    return {}
  }

  const consent = await input.findConsent({
    clientId: input.clientId,
    userId: input.userId,
    referenceId: input.referenceId,
  })
  return consent ? { [input.claimName]: consent.id } : {}
}
