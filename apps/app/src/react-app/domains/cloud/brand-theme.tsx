/** @jsxImportSource react */
import { useEffect, useRef, type ReactNode } from "react";
import { desktopPolicyKeys, type BrandAccentColor } from "@openwork/types/den/desktop-policies";

import { useNotificationStore } from "../../kernel/notification-store";
import { useOrgRestrictions } from "./desktop-config-provider";

// ---------------------------------------------------------------------------
// Radix accent-color mapping
// ---------------------------------------------------------------------------
// For each Radix color family we map the --dls-accent* CSS custom properties
// to the appropriate scale step. Radix step conventions:
//   9  = solid background   (the primary accent fill)
//   10 = hover state
//   11 = low-contrast text on a light surface
// The foreground is always white except for very light scales (yellow, lime,
// mint, sky) where dark text is more legible.

const LIGHT_FG_COLORS = new Set<BrandAccentColor>(["yellow", "lime", "mint", "sky"]);

function applyBrandAccent(color: BrandAccentColor) {
  const root = document.documentElement;

  // Set the main accent variables referencing existing Radix CSS vars.
  root.style.setProperty("--dls-accent", `var(--${color}-9)`);
  root.style.setProperty("--dls-accent-hover", `var(--${color}-10)`);
  root.style.setProperty("--dls-accent-fg", LIGHT_FG_COLORS.has(color) ? "#000000" : "#ffffff");

  // Compute --dls-accent-rgb from the resolved color so rgba() usages work.
  const probe = document.createElement("div");
  probe.style.color = `var(--${color}-9)`;
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  root.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  root.removeChild(probe);

  const match = computed.match(/(\d+),\s*(\d+),\s*(\d+)/);
  if (match) {
    root.style.setProperty("--dls-accent-rgb", `${match[1]} ${match[2]} ${match[3]}`);
  }

  root.dataset.brandAccent = color;
}

function clearBrandAccent() {
  const root = document.documentElement;
  root.style.removeProperty("--dls-accent");
  root.style.removeProperty("--dls-accent-hover");
  root.style.removeProperty("--dls-accent-fg");
  root.style.removeProperty("--dls-accent-rgb");
  delete root.dataset.brandAccent;
}

// ---------------------------------------------------------------------------
// React integration
// ---------------------------------------------------------------------------

/**
 * Applies the org's white-label brand accent color (from desktop config) to
 * the document root in real-time. Cleans up on unmount or when the config
 * changes back to default.
 */
export function BrandThemeEffect() {
  const config = useOrgRestrictions();
  const brandAccentColor = config.brandAccentColor;

  useEffect(() => {
    if (!brandAccentColor) {
      clearBrandAccent();
      return;
    }
    applyBrandAccent(brandAccentColor);
    return () => clearBrandAccent();
  }, [brandAccentColor]);

  return null;
}

/**
 * Hook returning the org's brand logo URL if set via desktop policy.
 */
export function useBrandLogoUrl(): string | undefined {
  return useOrgRestrictions().brandLogoUrl;
}

/** Organization-managed display name. It does not change the signed app identity. */
export function useBrandAppName(): string {
  return useOrgRestrictions().brandAppName ?? "OpenWork";
}

const POLICY_NOTIFICATION_DEDUPE = "desktop-policy-active";

/**
 * Pushes a notification when any desktop policy restriction or branding
 * override is active. Fires at most once per provider mount (deduped).
 */
function DesktopPolicyNotificationEffect() {
  const config = useOrgRestrictions();
  const firedRef = useRef(false);
  const addNotification = useNotificationStore((state) => state.add);

  useEffect(() => {
    if (firedRef.current) return;

    const hasRestriction = desktopPolicyKeys.some(
      (key) => config[key] === false,
    );
    const hasBranding = Boolean(config.brandAppName ?? config.brandLogoUrl ?? config.brandAccentColor);
    if (!hasRestriction && !hasBranding) return;

    firedRef.current = true;
    addNotification({
      kind: "cloud",
      severity: "info",
      title: "Organization policies active",
      body: "Some features and appearance settings are managed by your administrator.",
      dedupeKey: POLICY_NOTIFICATION_DEDUPE,
    });
  }, [config, addNotification]);

  return null;
}

/**
 * Provider that mounts the brand theme side-effect and passes children
 * through. Place inside `DesktopConfigProvider`.
 */
export function BrandThemeProvider({ children }: { children: ReactNode }) {
  return (
    <>
      <BrandThemeEffect />
      <DesktopPolicyNotificationEffect />
      {children}
    </>
  );
}
