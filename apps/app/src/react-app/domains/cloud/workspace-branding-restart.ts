import type { DenDesktopConfig } from "../../../app/lib/den";

const BRANDING_KEYS = [
  "brandAppName",
  "brandLogoUrl",
  "brandIconUrl",
  "brandAccentColor",
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
