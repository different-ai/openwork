import type { ConnectedAccountTable } from "@openwork-ee/den-db/schema"

type ConnectedAccount = typeof ConnectedAccountTable.$inferSelect

/** A token value, never a header, scheme, URL, or expression. */
export function validMemberApiKey(value: string): boolean {
  return value.length > 0 && value.length <= 8192 && /^[\x21-\x7e]+$/.test(value)
}

export function memberApiKeyAuthorization(value: string, scheme: "bearer" | "token" = "bearer"): string {
  if (!validMemberApiKey(value)) throw new Error("A valid personal API key is required.")
  return `${scheme === "token" ? "Token" : "Bearer"} ${value}`
}

/** The connection takes one personal API key per member instead of a shared key. */
export function usesMemberApiKey(connection: { authType: string; credentialMode: string }): boolean {
  return connection.authType === "apikey" && connection.credentialMode === "per_member"
}

/** A stored personal key the member can use now: enrolled as a key and not rejected upstream. */
export function memberApiKeyUsable(
  account: Pick<ConnectedAccount, "tokenType" | "accessToken" | "credentialHealth"> | null | undefined,
): boolean {
  return account?.tokenType === "api_key"
    && Boolean(account.accessToken)
    && account.credentialHealth?.status !== "reconnect_required"
}

/** A personal key the provider rejected; the member must replace it. */
export function memberApiKeyRejected(
  account: Pick<ConnectedAccount, "credentialHealth"> | null | undefined,
): boolean {
  return account?.credentialHealth?.status === "reconnect_required"
}
