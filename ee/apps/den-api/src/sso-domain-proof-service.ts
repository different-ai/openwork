import { createHash, randomBytes } from "node:crypto"
import { resolveTxt } from "node:dns/promises"
import { and, eq, or, sql } from "@openwork-ee/den-db/drizzle"
import { AuthVerificationTable, SsoConnectionTable, SsoProviderTable } from "@openwork-ee/den-db/schema"
import { z } from "zod"
import { db } from "./db.js"
import { getSsoDomainVerificationDnsName, getSsoDomainVerificationHost } from "./sso-domain-verification.js"
import { canonicalSsoEmailDomain, stripSsoEmailDomainProof, withSsoEmailDomainProof, type SsoEmailDomainProof } from "./sso-email-domain-proof.js"

type OrganizationId = typeof SsoConnectionTable.$inferSelect.organizationId
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
const challengeTtlMs = 7 * 24 * 60 * 60 * 1000
const challengeSchema = z.object({
  version: z.literal(1), token: z.string().min(1), organizationId: z.string(), connectionId: z.string(),
  providerRowId: z.string(), providerId: z.string(), domain: z.string(), configRevision: z.string(),
})

// DNS never runs under the database lock. Its result is committed only after
// reloading and locking the same connection, provider, and expiring challenge.
export function createSsoDomainProofService(dependencies: {
  database?: typeof db
  resolveTxt?: (hostname: string) => Promise<string[][]>
  now?: () => Date
} = {}) {
  const database = dependencies.database ?? db
  const lookup = dependencies.resolveTxt ?? resolveTxt
  const now = dependencies.now ?? (() => new Date())

  async function readCandidate(organizationId: OrganizationId) {
    // Resolve the row identities before starting a transaction. A consistent
    // read inside it can leave a stale snapshot while the provider lock waits.
    const [candidate] = await database.select({
      id: SsoConnectionTable.id,
      organizationId: SsoConnectionTable.organizationId,
      providerId: SsoConnectionTable.providerId,
      kind: SsoConnectionTable.kind,
      issuer: SsoConnectionTable.issuer,
      domain: SsoConnectionTable.domain,
      configRevision: SsoConnectionTable.configRevision,
    }).from(SsoConnectionTable).where(eq(SsoConnectionTable.organizationId, organizationId)).limit(1)
    if (!candidate) throw new Error("SSO configuration was not found.")
    return candidate
  }

  async function lockBinding(tx: Transaction, candidate: Awaited<ReturnType<typeof readCandidate>>) {
    // Registration locks provider before connection; use the same lock order.
    // These are current locking reads only, never a snapshot read then a lock.
    const [provider] = await tx.select().from(SsoProviderTable).where(and(
      eq(SsoProviderTable.providerId, candidate.providerId), eq(SsoProviderTable.organizationId, candidate.organizationId),
    )).limit(1).for("update")
    const [connection] = await tx.select().from(SsoConnectionTable).where(eq(SsoConnectionTable.id, candidate.id)).limit(1).for("update")
    if (!provider || !connection || provider.organizationId !== candidate.organizationId || provider.providerId !== candidate.providerId
      || connection.organizationId !== candidate.organizationId || connection.providerId !== candidate.providerId
      || connection.kind !== candidate.kind || connection.issuer !== candidate.issuer || connection.domain !== candidate.domain
      || connection.configRevision !== candidate.configRevision) {
      throw new Error("The SSO configuration changed. Request a new verification token.")
    }
    const domain = canonicalSsoEmailDomain(provider.domain)
    if (!domain || canonicalSsoEmailDomain(connection.domain) !== domain) throw new Error("Domain verification requires one exact domain, without a wildcard, URL, or domain list.")
    if (connection.kind !== "oidc" && connection.kind !== "saml") throw new Error("Invalid SSO provider protocol.")
    const config = connection.kind === "oidc" ? provider.oidcConfig : provider.samlConfig
    withSsoEmailDomainProof(config, null)
    const host = getSsoDomainVerificationHost(provider.providerId)
    if (host.length > 63) throw new Error("The SSO verification hostname exceeds the DNS label limit.")
    return { connection, provider, domain, host }
  }

  function reservation(binding: Awaited<ReturnType<typeof lockBinding>>) {
    const identifier = `openwork:sso-email-domain-proof:${binding.connection.id}`
    return { identifier, id: createHash("sha256").update(identifier).digest("base64url") }
  }

  function readChallenge(row: typeof AuthVerificationTable.$inferSelect | undefined, binding: Awaited<ReturnType<typeof lockBinding>>) {
    if (!row || row.expiresAt <= now()) return null
    let value: unknown
    try { value = JSON.parse(row.value) } catch { return null }
    const parsed = challengeSchema.safeParse(value)
    if (!parsed.success) return null
    const challenge = parsed.data
    if (challenge.organizationId !== binding.connection.organizationId || challenge.connectionId !== binding.connection.id
      || challenge.providerRowId !== binding.provider.id || challenge.providerId !== binding.provider.providerId
      || challenge.domain !== binding.domain || challenge.configRevision !== binding.connection.configRevision
      || binding.connection.domainVerificationToken !== challenge.token) return null
    return challenge
  }

  async function request(organizationId: OrganizationId) {
    const candidate = await readCandidate(organizationId)
    return database.transaction(async (tx) => {
      const binding = await lockBinding(tx, candidate)
      const key = reservation(binding)
      const [existing] = await tx.select().from(AuthVerificationTable).where(eq(AuthVerificationTable.id, key.id)).limit(1).for("update")
      const current = readChallenge(existing, binding)
      if (current) {
        // Identifiers are not unique in Better Auth's table. The deterministic
        // primary key is authoritative; discard duplicate identifier rows.
        await tx.delete(AuthVerificationTable).where(and(eq(AuthVerificationTable.identifier, key.identifier), sql`${AuthVerificationTable.id} <> ${key.id}`))
        await tx.update(SsoConnectionTable).set({ domainVerificationToken: current.token }).where(eq(SsoConnectionTable.id, binding.connection.id))
        return { domainVerificationToken: current.token }
      }
      const challenge: z.infer<typeof challengeSchema> = {
        version: 1, token: randomBytes(32).toString("base64url"), organizationId, connectionId: binding.connection.id,
        providerRowId: binding.provider.id, providerId: binding.provider.providerId, domain: binding.domain,
        configRevision: binding.connection.configRevision,
      }
      await tx.delete(AuthVerificationTable).where(or(eq(AuthVerificationTable.id, key.id), eq(AuthVerificationTable.identifier, key.identifier)))
      await tx.insert(AuthVerificationTable).values({ ...key, value: JSON.stringify(challenge), expiresAt: new Date(now().getTime() + challengeTtlMs) })
      await tx.update(SsoConnectionTable).set({ domainVerificationToken: challenge.token }).where(eq(SsoConnectionTable.id, binding.connection.id))
      return { domainVerificationToken: challenge.token }
    })
  }

  async function verify(organizationId: OrganizationId) {
    const candidate = await readCandidate(organizationId)
    const pending = await database.transaction(async (tx) => {
      const binding = await lockBinding(tx, candidate)
      const key = reservation(binding)
      const [row] = await tx.select().from(AuthVerificationTable).where(eq(AuthVerificationTable.id, key.id)).limit(1).for("update")
      const challenge = readChallenge(row, binding)
      if (!challenge || !row) throw new Error("No current domain verification token exists. Request a new token.")
      return { binding, key, challenge, value: row.value }
    })
    let records: string[][]
    try {
      records = await lookup(getSsoDomainVerificationDnsName(pending.binding.provider.providerId, pending.binding.domain))
    } catch {
      throw new Error("Could not read the domain's DNS TXT record. Check the record and try again.")
    }
    if (!records.some((parts) => {
      const value = parts.join("").trim()
      return value === pending.challenge.token || value === `${pending.binding.host}=${pending.challenge.token}`
    })) throw new Error("The DNS TXT record does not match the current verification token. Check the record and try again.")

    await database.transaction(async (tx) => {
      // Pin the binding resolved before DNS; never follow a replacement provider
      // or open a consistent-read snapshot in this commit transaction.
      const binding = await lockBinding(tx, pending.binding.connection)
      const key = reservation(binding)
      const [row] = await tx.select().from(AuthVerificationTable).where(eq(AuthVerificationTable.id, key.id)).limit(1).for("update")
      const challenge = readChallenge(row, binding)
      if (!challenge || !row || key.id !== pending.key.id || row.value !== pending.value
        || binding.connection.kind !== pending.binding.connection.kind
        || binding.provider.issuer !== pending.binding.provider.issuer
        || stripSsoEmailDomainProof(binding.provider.oidcConfig) !== stripSsoEmailDomainProof(pending.binding.provider.oidcConfig)
        || stripSsoEmailDomainProof(binding.provider.samlConfig) !== stripSsoEmailDomainProof(pending.binding.provider.samlConfig)) {
        throw new Error("The SSO configuration or verification token changed or expired. Request a new token.")
      }
      const proof: SsoEmailDomainProof = {
        version: 1, organizationId, providerId: binding.provider.providerId, domain: binding.domain,
        method: "dns-txt", verifiedAt: now().toISOString(),
      }
      const update = binding.connection.kind === "oidc"
        ? { oidcConfig: withSsoEmailDomainProof(binding.provider.oidcConfig, proof) }
        : { samlConfig: withSsoEmailDomainProof(binding.provider.samlConfig, proof) }
      await tx.update(SsoProviderTable).set({ ...update, domainVerified: true }).where(eq(SsoProviderTable.id, binding.provider.id))
      await tx.update(SsoConnectionTable).set({ domainVerificationToken: null }).where(eq(SsoConnectionTable.id, binding.connection.id))
      await tx.delete(AuthVerificationTable).where(eq(AuthVerificationTable.identifier, key.identifier))
    })
  }

  return { request, verify }
}

export const ssoDomainProofService = createSsoDomainProofService()
