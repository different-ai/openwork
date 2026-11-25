import type { ConnectedAccountTable } from "@openwork-ee/den-db/schema"

type ConnectedAccount = typeof ConnectedAccountTable.$inferSelect

export function validMemberApiKey(value: string): boolean {
  return value.length > 0 && value.length <= 8192 && /^[\x21-\x7e]+$/.test(value)
}

export function memberApiKeyAuthorization(value: string, scheme: "bearer" | "token" = "bearer"): string {
  if (!validMemberApiKey(value)) throw new Error("A valid personal API key is required.")
  return `${scheme === "token" ? "Token" : "Bearer"} ${value}`
}

export function usesMemberApiKey(connection: { authType: string; credentialMode: string }): boolean {
  return connection.authType === "apikey" && connection.credentialMode === "per_member"
}

export function memberApiKeyUsable(
  account: Pick<ConnectedAccount, "tokenType" | "accessToken" | "credentialHealth"> | null | undefined,
): boolean {
  return account?.tokenType === "api_key"
    && Boolean(account.accessToken)
    && account.credentialHealth?.status !== "reconnect_required"
}

export function memberApiKeyRejected(
  account: Pick<ConnectedAccount, "credentialHealth"> | null | undefined,
): boolean {
  return account?.credentialHealth?.status === "reconnect_required"
}
