import { desktopCapabilityConfig, isLocalModelProviderId, localModelsAllowed, type DesktopConfig } from "@openwork/types/den/desktop-policies-runtime";

/** Providers an organization owns: Den-imported (lpr_), Gateway (ipr_), hosted OpenWork Models and Smart Routers. */
export const ORGANIZATION_PROVIDER_ID = /^(?:lpr_|ipr_|openwork$|openwork-auto$)/i;

/**
 * Whether one provider may run under the organization's model access, or null
 * when nothing is restricted. Both engines use this rule: v1 receives it as
 * `enabled_providers` (or `disabled_providers` for local models alone), the v2
 * provider mirror skips the rest.
 * - "Only models you provide" (`allowCustomProviders: false`): organization
 *   providers, plus local models when `allowLocalModels` allows them.
 * - Local models off (`allowLocalModels: false`): everything except Ollama and LM Studio.
 */
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

/** Whether the organization limits personal providers to its own: v1 then gets an allowlist. */
export function organizationAllowlistsProviders(policy: DesktopConfig | undefined): boolean {
  return (policy ? desktopCapabilityConfig(policy) : undefined)?.allowCustomProviders === false;
}
