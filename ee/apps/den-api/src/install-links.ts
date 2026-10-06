import { and, eq, gt, isNull, or } from "@openwork-ee/den-db/drizzle"
import { InstallLinkTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { createHash, randomBytes } from "node:crypto"
import { OPENWORK_DOWNLOAD_URL } from "./CONSTS.js"
import { db } from "./db.js"
import { env } from "./env.js"
import { organizationFeatureEnabled } from "./features.js"
import { appLogger } from "./observability/logger.js"

type InstallLinkInsert = typeof InstallLinkTable.$inferInsert
const logger = appLogger.child({ component: "install_links" })

type MintOrganizationInstallLinkInput = Pick<InstallLinkInsert, "organizationId" | "createdByUserId"> & {
  rotate?: boolean
}

type InvitationDownloadUrlInput = {
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
  if (!(await organizationFeatureEnabled(input.organizationId, "installLinks"))) {
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

  const installLinkId = createDenTypeId("installLink")
  await db.insert(InstallLinkTable).values({
    id: installLinkId,
    organizationId: input.organizationId,
    tokenHash: hashInstallLinkToken(token),
    createdByUserId: input.createdByUserId,
    expiresAt: null,
    revokedAt: null,
  })

  return { installLinkId, token, installPageUrl: installPageUrl(token) }
}

export async function resolveInvitationDownloadUrl(input: InvitationDownloadUrlInput) {
  try {
    const installLink = await mintOrganizationInstallLink({
      organizationId: normalizeDenTypeId("organization", input.organizationId),
      createdByUserId: normalizeDenTypeId("user", input.createdByUserId),
    })
    return installLink?.installPageUrl ?? OPENWORK_DOWNLOAD_URL
  } catch (error) {
    logger.error("invite install link failed", { organization_id: input.organizationId, error })
    return OPENWORK_DOWNLOAD_URL
  }
}
