export function isOrganizationSsoReady(input: {
  connection: { status: string } | null
  provider: { domainVerified: boolean } | null
}) {
  return input.connection?.status === "enabled" && input.provider?.domainVerified === true
}
