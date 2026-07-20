export type OrganizationSettingsUpdate = {
  name?: unknown
  allowedEmailDomains?: unknown
  allowedDesktopVersions?: unknown
  requireSso?: unknown
  brandAppName?: unknown
  brandLogoUrl?: unknown
  brandIconUrl?: unknown
  brandAccentColor?: unknown
}

export function isDesktopVersionOnlyOrganizationUpdate(
  input: OrganizationSettingsUpdate,
) {
  return input.allowedDesktopVersions !== undefined
    && input.name === undefined
    && input.allowedEmailDomains === undefined
    && input.requireSso === undefined
    && input.brandAppName === undefined
    && input.brandLogoUrl === undefined
    && input.brandIconUrl === undefined
    && input.brandAccentColor === undefined
}
