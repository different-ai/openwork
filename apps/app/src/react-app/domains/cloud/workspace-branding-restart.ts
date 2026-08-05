import type { BrandIconState } from "../../../app/lib/desktop-types";
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

/**
 * Level-based reconcile between a fresh org desktop config and the shell's
 * applied brand-icon state. The provider's config diff is edge-triggered, but
 * the shell restores its cached/bootstrap icon at every launch — so a clear
 * whose edge was missed (stale localStorage cache, failed IPC, org switch)
 * would otherwise never be retried and the branded icon would stick forever.
 *
 * Returns the URL to apply (`{ apply: string | null }`, where null means
 * "reset to the stock icon"), or null when the shell already matches. A
 * mismatch between two applied URLs is left to the edge diff, which owns
 * config-change transitions.
 */
export function brandIconReconcileAction(
  config: Pick<DenDesktopConfig, "brandIconUrl">,
  state: Pick<BrandIconState, "applied"> | null,
): { apply: string | null } | null {
  if (!state) return null;
  const configuredIconUrl = typeof config.brandIconUrl === "string" ? config.brandIconUrl : null;
  if (configuredIconUrl !== null && !state.applied) return { apply: configuredIconUrl };
  if (configuredIconUrl === null && state.applied) return { apply: null };
  return null;
}
