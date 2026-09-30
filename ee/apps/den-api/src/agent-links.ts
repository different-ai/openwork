import { env } from "./env.js"

// Pure link builders shared by the org routes. Kept free of auth/db imports so
// unit tests can exercise them without booting Better Auth (which seeds the
// oauthResource registry against MySQL on import).

/**
 * The classical member handoff: after an admin (or their agent) publishes a
 * connection, members connect their own account in the den-web dashboard.
 * betterAuthUrl is the den-web public origin in every deployment layout.
 */
export function memberSignInLink(connection: { id: string; organizationId: string; name: string }) {
  const signIn = new URL("/connect/mcp", env.betterAuthUrl)
  signIn.searchParams.set("connectionId", connection.id)
  signIn.searchParams.set("org", connection.organizationId)
  signIn.searchParams.set("name", connection.name)
  return signIn.toString()
}

/** Where an owner starts seat billing. den-web resolves the active organization. */
export function invitationBillingUrl() {
  return new URL("/dashboard/billing", env.betterAuthUrl).toString()
}
