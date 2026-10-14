export type OrganizationBrand = {
  whiteLabelEnabled: boolean;
  appName: string;
  logoUrl: string | null;
  iconUrl: string | null;
};

/** An explicit effective feature flag is required, including for old cached claims. */
export function parseOrganizationBrand(value: unknown, whiteLabelEnabled: unknown): OrganizationBrand {
  if (whiteLabelEnabled !== true || typeof value !== "object" || value === null) {
    return { whiteLabelEnabled: false, appName: "OpenWork", logoUrl: null, iconUrl: null };
  }
  const appName = "appName" in value && typeof value.appName === "string" ? value.appName.trim() : "";
  const logoUrl = "logoUrl" in value && typeof value.logoUrl === "string" ? value.logoUrl : null;
  const iconUrl = "iconUrl" in value && typeof value.iconUrl === "string" ? value.iconUrl : null;
  return { whiteLabelEnabled: true, appName: appName || "OpenWork", logoUrl, iconUrl };
}
