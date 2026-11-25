import { desktopCapabilityConfig, isLocalModelProviderId, localModelsAllowed, type DesktopConfig } from "@openwork/types/den/desktop-policies-runtime";

export const ORGANIZATION_PROVIDER_ID = /^(?:lpr_|ipr_|openwork$|openwork-auto$)/i;

export function organizationProviderGate(policy: DesktopConfig | undefined): ((providerId: string) => boolean) | null {
  const effective = policy ? desktopCapabilityConfig(policy) : undefined;
  const local = localModelsAllowed(effective);
  if (effective?.allowCustomProviders === false) {
    const zen = effective.allowZenModel !== false;
    return (providerId) => ORGANIZATION_PROVIDER_ID.test(providerId) || (zen && providerId === "opencode")
      || (local && isLocalModelProviderId(providerId));
  }
  if (!local) return (providerId) => !isLocalModelProviderId(providerId);
  return null;
}

export function organizationAllowlistsProviders(policy: DesktopConfig | undefined): boolean {
  return (policy ? desktopCapabilityConfig(policy) : undefined)?.allowCustomProviders === false;
}
