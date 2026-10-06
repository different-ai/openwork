import { eq } from "@openwork-ee/den-db/drizzle"
import { OrganizationBrandAssetTable } from "@openwork-ee/den-db/schema"
import { coreHooks } from "../default-registry.js"
import { CORE_HOOK_ORDER } from "../types.js"

// Future owner: branding.

coreHooks.registerTx({
  point: "org.deletion.purge",
  id: "legacy/branding/purge-organization-brand-assets",
  registrant: "legacy",
  alwaysRun: "cleanup",
  order: CORE_HOOK_ORDER.cleanup + 8,
  handler: async ({ tx, organizationId }) => {
    await tx.delete(OrganizationBrandAssetTable).where(eq(OrganizationBrandAssetTable.organizationId, organizationId))
  },
})

coreHooks.registerContributor({
  point: "me.desktopConfig",
  id: "legacy/branding/desktop-config-branding",
  registrant: "legacy",
  errorPolicy: "propagate",
  order: CORE_HOOK_ORDER.default + 5,
  contribute: async ({ normalizedMetadata }) => ({
    ...(typeof normalizedMetadata.brandAppName === "string" ? { brandAppName: normalizedMetadata.brandAppName } : {}),
    ...(typeof normalizedMetadata.brandLogoUrl === "string" ? { brandLogoUrl: normalizedMetadata.brandLogoUrl } : {}),
    ...(typeof normalizedMetadata.brandIconUrl === "string" ? { brandIconUrl: normalizedMetadata.brandIconUrl } : {}),
    ...(typeof normalizedMetadata.brandAccentColor === "string" ? { brandAccentColor: normalizedMetadata.brandAccentColor } : {}),
  }),
})

// Invitation previews show the organization's branding instead of OpenWork's.
coreHooks.registerDecorator({
  point: "invitation.preview",
  id: "legacy/branding/invitation-branding",
  registrant: "legacy",
  errorPolicy: "propagate",
  handler: async (branding, { normalizedMetadata }) => ({
    appName: typeof normalizedMetadata.brandAppName === "string" ? normalizedMetadata.brandAppName : branding.appName,
    logoUrl: typeof normalizedMetadata.brandLogoUrl === "string" ? normalizedMetadata.brandLogoUrl : branding.logoUrl,
    iconUrl: typeof normalizedMetadata.brandIconUrl === "string" ? normalizedMetadata.brandIconUrl : branding.iconUrl,
  }),
})
