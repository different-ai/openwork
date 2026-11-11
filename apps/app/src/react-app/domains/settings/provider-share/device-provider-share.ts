import type { DeviceShareOptions } from "@openwork/types/den/device-provider-share";
import { isCloudManagedProviderKey } from "../../connections/provider-auth/cloud-provider-config";
import type { ProviderCredentialHealth } from "../../connections/provider-auth/credential-health";

/**
 * Sharing a key saved on this device with the organization (Den feature
 * `shareDeviceProvider`): what Settings › AI Providers shows for each row and
 * for an organization that has nothing shared yet. Pure, so the rules are
 * unit-tested; Den decides who may share and what can be shared.
 */

export type ShareableDeviceProvider = { id: string; name: string; source?: "env" | "api" | "config" | "custom" };

/**
 * Providers worth asking Den about: an API key this person pasted, which this
 * computer's server can read. Sign-ins (ChatGPT, Claude Code), environment
 * credentials and hand-written config are not one key someone can hand over,
 * and a key the provider already refused is not worth sharing.
 */
export function deviceShareCandidates(
  providers: readonly ShareableDeviceProvider[],
  health: (providerId: string) => ProviderCredentialHealth,
): ShareableDeviceProvider[] {
  return providers.filter((provider) => provider.source === "api" && !isCloudManagedProviderKey(provider.id) && health(provider.id) !== "rejected");
}

export type DeviceProviderShareRow =
  /** One confirmation shares it. */
  | { state: "shareable" }
  /** The organization already has this provider, under this name. */
  | { state: "shared"; sharedAs: string };

/** What a device row shows, by provider id. A provider with no entry shows nothing about sharing. */
export function deviceProviderShareRows(
  options: DeviceShareOptions | null | undefined,
  candidates: readonly ShareableDeviceProvider[],
): ReadonlyMap<string, DeviceProviderShareRow> {
  const rows = new Map<string, DeviceProviderShareRow>();
  if (!options?.canShare) return rows;
  for (const provider of options.providers) {
    if (!candidates.some((candidate) => candidate.id === provider.providerId)) continue;
    if (provider.status === "shareable") rows.set(provider.providerId, { state: "shareable" });
    else if (provider.status === "shared") rows.set(provider.providerId, { state: "shared", sharedAs: provider.sharedAs?.trim() || provider.name });
  }
  return rows;
}

/**
 * The organization section while nothing is shared yet (DESIGN C6: what
 * happened and the next action; P4: locked with who can change it).
 * - `share`: this person can share a key that is already on this device.
 * - `add`: they can share, but nothing here is one key; AI Gateway's own form is the way.
 * - `locked`: someone else manages providers.
 * - null: the feature is off or Den has not answered; the section keeps its plain empty line.
 */
export type OrganizationShareEmptyState =
  | { kind: "share"; provider: { id: string; name: string } }
  | { kind: "add" }
  | { kind: "locked"; managerName: string | null }
  | null;

export function organizationShareEmptyState(
  options: DeviceShareOptions | null | undefined,
  candidates: readonly ShareableDeviceProvider[],
): OrganizationShareEmptyState {
  if (!options) return null;
  if (!options.canShare) return options.blocker === "no_permission" ? { kind: "locked", managerName: options.managerName?.trim() || null } : null;
  const rows = deviceProviderShareRows(options, candidates);
  const first = candidates.find((candidate) => rows.get(candidate.id)?.state === "shareable");
  return first ? { kind: "share", provider: { id: first.id, name: first.name } } : { kind: "add" };
}

/** "Avery Owner manages AI providers for Acme." */
export function shareLockedLine(managerName: string | null, organizationName: string): string {
  return `${managerName || "Your workspace owner"} manages AI providers for ${organizationName}.`;
}

/** What the person agrees to, as label and value rows (DESIGN P9: action, data, risk, reversibility). */
export function shareConsentFacts(input: { providerName: string; organizationName: string }): Array<{ label: string; value: string }> {
  return [
    { label: "Who can use it", value: `Everyone in ${input.organizationName}, including people you invite later` },
    { label: "Your key", value: "Leaves this device and is stored encrypted in AI Gateway. Members never see it" },
    { label: "Cost", value: `Their usage is billed to your ${input.providerName} account` },
    { label: "Changing it", value: "Limit who uses it, or remove it, in AI Gateway" },
  ];
}

/** A plain sentence for a share that did not happen. Server codes come from apps/server/src/device-provider-share.ts. */
export function shareFailureMessage(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "";
  switch (code) {
    case "already_shared": return "Your organization already has this provider.";
    case "not_shareable": return "This provider can't be shared from this device. Add it in AI Gateway instead.";
    case "no_device_key": return "No API key for this provider is saved on this device.";
    case "forbidden": return "Only people who manage AI Gateway can share a provider.";
    case "gateway_unavailable": return "AI Gateway is not set up for this OpenWork yet.";
    case "feature_disabled": return "Sharing from this device is not available for your organization.";
    case "share_unconfirmed": return "OpenWork Cloud did not confirm the share. Check AI Providers before trying again.";
    case "no_session":
    case "organization_mismatch": return "Your account or organization changed. Close this and try again.";
    default: return "Could not share this provider. Nothing was shared.";
  }
}

/** Den asks for a recent sign-in before AI Gateway changes. */
export function shareNeedsVerification(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "verification_required";
}
