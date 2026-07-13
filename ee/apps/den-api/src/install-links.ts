import { and, eq, gt, isNull, or } from "@openwork-ee/den-db/drizzle"
import { InstallLinkTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { createHash, randomBytes } from "node:crypto"
import { OPENWORK_DOWNLOAD_URL } from "./CONSTS.js"
import { organizationInstallLinksEnabled } from "./capability-sources/install-links-rollout.js"
import { db } from "./db.js"
import { env } from "./env.js"
import { appLogger } from "./observability/logger.js"

type InstallLinkInsert = typeof InstallLinkTable.$inferInsert
const logger = appLogger.child({ component: "install_links" })

type MintOrganizationInstallLinkInput = Pick<InstallLinkInsert, "organizationId" | "createdByUserId"> & {
  metadata: Record<string, unknown> | string | null | undefined
  rotate?: boolean
}

type InvitationDownloadUrlInput = Pick<MintOrganizationInstallLinkInput, "metadata"> & {
  organizationId: string
  createdByUserId: string
}

export function hashInstallLinkToken(token: string) {
  return createHash("sha256").update(token).digest("hex")
}

function installPageUrl(token: string) {
  return new URL(`/install?token=${encodeURIComponent(token)}`, env.betterAuthUrl).toString()
}

export async function mintOrganizationInstallLink(input: MintOrganizationInstallLinkInput) {
  if (!organizationInstallLinksEnabled(input.metadata, { gatingEnabled: env.installLinksGatingEnabled })) {
    return null
  }

  const token = randomBytes(32).toString("base64url")

  if (input.rotate) {
    const now = new Date()
    await db
      .update(InstallLinkTable)
      .set({ revokedAt: now })
      .where(
        and(
          eq(InstallLinkTable.organizationId, input.organizationId),
          isNull(InstallLinkTable.revokedAt),
          or(isNull(InstallLinkTable.expiresAt), gt(InstallLinkTable.expiresAt, now)),
        ),
      )
  }

  await db.insert(InstallLinkTable).values({
    id: createDenTypeId("installLink"),
    organizationId: input.organizationId,
    tokenHash: hashInstallLinkToken(token),
    createdByUserId: input.createdByUserId,
    expiresAt: null,
    revokedAt: null,
  })

  return { token, installPageUrl: installPageUrl(token) }
}

export async function resolveInvitationDownloadUrl(input: InvitationDownloadUrlInput) {
  try {
    const installLink = await mintOrganizationInstallLink({
      organizationId: normalizeDenTypeId("organization", input.organizationId),
      createdByUserId: normalizeDenTypeId("user", input.createdByUserId),
      metadata: input.metadata,
    })
    return installLink?.installPageUrl ?? OPENWORK_DOWNLOAD_URL
  } catch (error) {
    logger.error("invite install link failed", { organization_id: input.organizationId, error })
    return OPENWORK_DOWNLOAD_URL
  }
}
