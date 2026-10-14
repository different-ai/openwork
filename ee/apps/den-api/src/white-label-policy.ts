export const BRAND_METADATA_KEYS = ["brandAppName", "brandLogoUrl", "brandIconUrl", "brandLogoAsset", "brandIconAsset", "brandAccentColor"]
export const STOCK_BRAND = { appName: "OpenWork", logoUrl: null, iconUrl: null }

/** Read projection only. Never use metadata as runtime feature authority. */
export function projectBrandMetadata(metadata: Record<string, unknown>, whiteLabelEnabled: boolean): Record<string, unknown> {
  const projected = { ...metadata }
  if (!whiteLabelEnabled) {
    for (const key of BRAND_METADATA_KEYS) delete projected[key]
    return { ...projected, whiteLabelEnabled: false, brandAppName: "OpenWork", brandLogoUrl: null, brandIconUrl: null }
  }
  return { ...projected, whiteLabelEnabled: true }
}

/** Startup migration detection only; preserve every nonempty historical branding value. */
export function hasHistoricalBranding(input: { logo: string | null; metadata: unknown }) {
  if (input.logo?.trim()) return true
  let metadata = input.metadata
  if (typeof metadata === "string") {
    try { metadata = JSON.parse(metadata) } catch { return false }
  }
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return false
  return Object.entries(metadata).some(([key, value]) => BRAND_METADATA_KEYS.includes(key) && (
    typeof value === "string" ? value.trim().length > 0
      : typeof value === "object" && value !== null && Object.keys(value).length > 0
  ))
}

export function eligibleHistoricalBranding(input: { createdAt: Date; logo: string | null; metadata: unknown }, cutoff: Date) {
  return input.createdAt < cutoff && hasHistoricalBranding(input)
}
