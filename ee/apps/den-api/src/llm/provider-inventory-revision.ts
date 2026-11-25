import { createHmac } from "node:crypto"
import type { GatewayProviderCredentialTable } from "@openwork-ee/den-db/schema"
import { parseGatewayProviderSecret } from "@openwork/types/den/gateway"

export function providerInventoryReadiness(credentials: readonly Pick<typeof GatewayProviderCredentialTable.$inferSelect, "id" | "kind" | "secret" | "expires_at">[], now: number) {
  return credentials.map((credential) => {
    let clientExpired = false
    try {
      const parsed = parseGatewayProviderSecret(credential.kind, credential.secret)
      if (parsed.kind === "aws_sso") clientExpired = parsed.awsSso.clientSecretExpiresAt * 1_000 <= now
    } catch {}
    return { id: credential.id, expired: credential.expires_at !== null && credential.expires_at.getTime() <= now, clientExpired }
  })
}

function canonical(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

export function providerInventoryRevision(input: {
  organizationId: string
  memberId: string
  gatewayBaseUrl: string
  rows: Record<string, readonly unknown[]>
}, secret: string): string {
  const rows = Object.fromEntries(Object.entries(input.rows).map(([key, values]) => [key, values.map(canonical).sort()]))
  return createHmac("sha256", secret).update(canonical({ version: 1, ...input, rows })).digest("hex")
}
