import type { DenBootstrapConfig, DenDesktopConfig } from "../../../app/lib/den";

const BRANDING_KEYS = [
  "brandAppName",
  "brandLogoUrl",
  "brandIconUrl",
  "brandAccentColor",
] as const satisfies readonly (keyof DenDesktopConfig)[];

const BOOTSTRAP_BRANDING_KEYS = [
  "brandAppName",
  "brandLogoUrl",
  "brandIconUrl",
] as const satisfies readonly (keyof DenDesktopConfig)[];

export function hasWorkspaceBranding(config: DenDesktopConfig): boolean {
  return BRANDING_KEYS.some((key) => {
    const value = config[key];
    return typeof value === "string" && value.trim().length > 0;
  });
}

export function workspaceBrandingFingerprint(
  orgId: string,
  config: DenDesktopConfig,
): string {
  return JSON.stringify([
    orgId,
    config.brandAppName ?? null,
    config.brandLogoUrl ?? null,
    config.brandIconUrl ?? null,
    config.brandAccentColor ?? null,
  ]);
}

export type BootstrapBrandingFields = {
  brandAppName: string | null;
  brandLogoUrl: string | null;
  brandIconUrl: string | null;
};

export function bootstrapBrandingFromDesktopConfig(
  config: DenDesktopConfig,
): BootstrapBrandingFields {
  return {
    brandAppName: typeof config.brandAppName === "string" ? config.brandAppName : null,
    brandLogoUrl: typeof config.brandLogoUrl === "string" ? config.brandLogoUrl : null,
    brandIconUrl: typeof config.brandIconUrl === "string" ? config.brandIconUrl : null,
  };
}

export function bootstrapBrandingNeedsSync(
  bootstrap: Pick<DenBootstrapConfig, "brandAppName" | "brandLogoUrl" | "brandIconUrl">,
  config: DenDesktopConfig,
): boolean {
  const next = bootstrapBrandingFromDesktopConfig(config);
  return BOOTSTRAP_BRANDING_KEYS.some((key) => (bootstrap[key] ?? null) !== next[key]);
}
