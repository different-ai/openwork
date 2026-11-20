import { getManagedBrandIconUrl, parseOrganizationMetadata } from "../../_lib/den-org";

function brandImageUrl(value: unknown): string | null {
  return typeof value === "string" && /^https?:\/\//i.test(value) && URL.canParse(value) ? value : null;
}

export function readSidebarBrand(metadata: string | null | undefined, enabled: boolean) {
  const parsed = enabled ? parseOrganizationMetadata(metadata ?? null) : null;
  return {
    loading: metadata === undefined,
    appName: typeof parsed?.brandAppName === "string" ? parsed.brandAppName.trim() || null : null,
    wordmarkUrl: brandImageUrl(parsed?.brandLogoUrl),
    iconUrl: brandImageUrl(parsed?.brandIconUrl) ?? getManagedBrandIconUrl(metadata ?? null),
    enabled,
  };
}

export function selectSidebarBrand(brand: ReturnType<typeof readSidebarBrand>, failedUrls: readonly string[]) {
  const wordmarkUrl = brand.wordmarkUrl && !failedUrls.includes(brand.wordmarkUrl) ? brand.wordmarkUrl : null;
  if (wordmarkUrl) return { kind: "wordmark", url: wordmarkUrl, name: brand.appName };

  const iconUrl = brand.iconUrl && !failedUrls.includes(brand.iconUrl) ? brand.iconUrl : null;
  if (iconUrl || brand.appName) {
    return { kind: "icon", url: iconUrl, name: brand.enabled ? brand.appName ?? "OpenWork" : null };
  }

  return { kind: brand.loading ? "loading" : "default", url: null, name: null };
}
