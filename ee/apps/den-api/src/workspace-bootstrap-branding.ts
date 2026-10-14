import { eq } from "@openwork-ee/den-db/drizzle"
import { OrganizationTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { readOrganizationMetadata } from "@openwork/types/den/managed-models-policy"
import { z } from "zod"
import { db } from "./db.js"
import { organizationFeatureEnabled } from "./features.js"
import { STOCK_BRAND } from "./white-label-policy.js"

export const bootstrapWorkspaceBrandingSchema = z.object({
  whiteLabelEnabled: z.boolean(),
  brand: z.object({
    appName: z.string(),
    logoUrl: z.string().url().nullable(),
    iconUrl: z.string().url().nullable(),
  }),
})

/** The organization is selected by the server, never by incoming brand metadata. */
export async function resolveBootstrapWorkspaceBranding(organizationId: string) {
  const [organization] = await db.select({ metadata: OrganizationTable.metadata, logo: OrganizationTable.logo })
    .from(OrganizationTable).where(eq(OrganizationTable.id, normalizeDenTypeId("organization", organizationId))).limit(1)
  if (!organization) throw new Error("bootstrap_organization_not_found")
  const whiteLabelEnabled = await organizationFeatureEnabled(organizationId, "whiteLabel")
  if (!whiteLabelEnabled) return { whiteLabelEnabled, brand: { ...STOCK_BRAND } }
  const metadata = readOrganizationMetadata(organization.metadata)
  return {
    whiteLabelEnabled,
    brand: {
      appName: typeof metadata.brandAppName === "string" ? metadata.brandAppName : "OpenWork",
      logoUrl: typeof metadata.brandLogoUrl === "string" ? metadata.brandLogoUrl : organization.logo ?? null,
      iconUrl: typeof metadata.brandIconUrl === "string" ? metadata.brandIconUrl : null,
    },
  }
}
