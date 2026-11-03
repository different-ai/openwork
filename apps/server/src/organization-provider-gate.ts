import { desktopCapabilityConfig, type DesktopConfig } from "@openwork/types/den/desktop-policies-runtime";

/** Providers an organization owns: Den-imported (lpr_), Gateway (ipr_), hosted OpenWork Models and Smart Routers. */
export const ORGANIZATION_PROVIDER_ID = /^(?:lpr_|ipr_|openwork$|openwork-auto$)/i;

/**
 * When the organization allows only its own providers ("Only models you
 * provide", `allowCustomProviders: false`), whether one provider may run.
 * Null when personal providers are allowed. Both engines use this rule: v1
 * receives it as `enabled_providers`, the v2 provider mirror skips the rest.
 */
export function organizationProviderGate(policy: DesktopConfig | undefined): ((providerId: string) => boolean) | null {
  const effective = policy ? desktopCapabilityConfig(policy) : undefined;
  if (effective?.allowCustomProviders !== false) return null;
  const zen = effective.allowZenModel !== false;
  return (providerId) => ORGANIZATION_PROVIDER_ID.test(providerId) || (zen && providerId === "opencode");
}
