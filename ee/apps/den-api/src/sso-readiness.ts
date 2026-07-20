export function isOrganizationSsoReady(input: {
  connection: { status: string } | null
  providerExists: boolean
}) {
  return input.connection?.status === "enabled" && input.providerExists
}
