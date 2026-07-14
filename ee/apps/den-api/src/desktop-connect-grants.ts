import { createHash, randomBytes } from "node:crypto"
import {
  buildConnectExchangeDeepLink,
  CONNECT_LINK_AUDIENCE,
  CONNECT_LINK_EXCHANGE_TTL_MINUTES,
  CONNECT_LINK_VERSION,
  connectLinkClaimsSchema,
  type ConnectLinkClaims,
} from "@openwork/connect-link"
import { and, eq, gt, isNull, lt } from "@openwork-ee/den-db/drizzle"
import { DesktopConnectGrantTable, InstallLinkTable } from "@openwork-ee/den-db/schema"
import { db } from "./db.js"
import type { DesktopConnectLinkInput } from "./desktop-connect-link.js"

export type DesktopConnectGrantFailureCode = "invalid_token" | "expired" | "replayed"

export type DesktopConnectGrantResult =
  | { ok: true; claims: ConnectLinkClaims }
  | { ok: false; code: DesktopConnectGrantFailureCode }

type DesktopConnectGrantRow = {
  grant: typeof DesktopConnectGrantTable.$inferSelect
  installLink: typeof InstallLinkTable.$inferSelect
}

function hashConnectGrantCode(code: string) {
  return createHash("sha256").update(code).digest("hex")
}

function validateGrantRow(row: DesktopConnectGrantRow | undefined, now: Date): DesktopConnectGrantResult {
  if (!row || row.installLink.revokedAt || (row.installLink.expiresAt && row.installLink.expiresAt <= now)) {
    return { ok: false, code: "invalid_token" }
  }
  if (row.grant.consumedAt) {
    return { ok: false, code: "replayed" }
  }
  if (row.grant.expiresAt <= now) {
    return { ok: false, code: "expired" }
  }
  const claims = connectLinkClaimsSchema.safeParse(row.grant.claims)
  return claims.success
    ? { ok: true, claims: claims.data }
    : { ok: false, code: "invalid_token" }
}

export async function mintDesktopConnectGrant(
  input: DesktopConnectLinkInput & {
    installLinkId: typeof DesktopConnectGrantTable.$inferInsert.installLinkId
  },
) {
  const now = new Date()
  await db.delete(DesktopConnectGrantTable).where(lt(DesktopConnectGrantTable.expiresAt, now))

  const code = randomBytes(24).toString("base64url")
  const codeHash = hashConnectGrantCode(code)
  const issuedAt = Math.floor(now.getTime() / 1000)
  const expiresAt = new Date((issuedAt + CONNECT_LINK_EXCHANGE_TTL_MINUTES * 60) * 1000)
  const claims = connectLinkClaimsSchema.parse({
    iss: input.apiUrl,
    aud: CONNECT_LINK_AUDIENCE,
    iat: issuedAt,
    exp: Math.floor(expiresAt.getTime() / 1000),
    jti: codeHash,
    v: CONNECT_LINK_VERSION,
    org: { name: input.organizationName },
    brand: {
      appName: input.appName,
      logoUrl: input.logoUrl,
      iconUrl: input.iconUrl,
    },
    den: {
      baseUrl: input.webUrl,
      apiBaseUrl: input.apiUrl,
    },
    requireSignin: true,
  })

  await db.insert(DesktopConnectGrantTable).values({
    codeHash,
    installLinkId: input.installLinkId,
    claims,
    expiresAt,
    consumedAt: null,
    consumedNonce: null,
  })

  return {
    connectUrl: buildConnectExchangeDeepLink(code, input.apiUrl),
    connectExpiresAt: expiresAt.toISOString(),
  }
}

export async function previewDesktopConnectGrant(code: string): Promise<DesktopConnectGrantResult> {
  const now = new Date()
  const [row] = await db
    .select({ grant: DesktopConnectGrantTable, installLink: InstallLinkTable })
    .from(DesktopConnectGrantTable)
    .innerJoin(InstallLinkTable, eq(DesktopConnectGrantTable.installLinkId, InstallLinkTable.id))
    .where(eq(DesktopConnectGrantTable.codeHash, hashConnectGrantCode(code)))
    .limit(1)
  return validateGrantRow(row, now)
}

export async function consumeDesktopConnectGrant(code: string): Promise<DesktopConnectGrantResult> {
  const codeHash = hashConnectGrantCode(code)
  const now = new Date()
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ grant: DesktopConnectGrantTable, installLink: InstallLinkTable })
      .from(DesktopConnectGrantTable)
      .innerJoin(InstallLinkTable, eq(DesktopConnectGrantTable.installLinkId, InstallLinkTable.id))
      .where(eq(DesktopConnectGrantTable.codeHash, codeHash))
      .limit(1)
    const available = validateGrantRow(row, now)
    if (!available.ok) {
      return available
    }

    const consumedAt = new Date()
    const consumedNonce = randomBytes(16).toString("base64url")
    await tx
      .update(DesktopConnectGrantTable)
      .set({ consumedAt, consumedNonce })
      .where(
        and(
          eq(DesktopConnectGrantTable.codeHash, codeHash),
          isNull(DesktopConnectGrantTable.consumedAt),
          gt(DesktopConnectGrantTable.expiresAt, now),
        ),
      )

    const [claimed] = await tx
      .select({ codeHash: DesktopConnectGrantTable.codeHash })
      .from(DesktopConnectGrantTable)
      .where(
        and(
          eq(DesktopConnectGrantTable.codeHash, codeHash),
          eq(DesktopConnectGrantTable.consumedNonce, consumedNonce),
        ),
      )
      .limit(1)

    return claimed ? available : { ok: false, code: "replayed" }
  })
}
