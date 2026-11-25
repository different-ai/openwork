import type { DeviceShareOptions } from "@openwork/types/den/device-provider-share";
import { isCloudManagedProviderKey } from "../../connections/provider-auth/cloud-provider-config";
import type { ProviderCredentialHealth } from "../../connections/provider-auth/credential-health";
import type { SharedDeviceProviderArrival } from "../../connections/provider-auth/shared-provider-sync";

export type ShareableDeviceProvider = { id: string; name: string; source?: "env" | "api" | "config" | "custom" };

export function deviceShareCandidates(
  providers: readonly ShareableDeviceProvider[],
  health: (providerId: string) => ProviderCredentialHealth,
): ShareableDeviceProvider[] {
  return providers.filter((provider) => provider.source === "api" && !isCloudManagedProviderKey(provider.id) && health(provider.id) !== "rejected");
}

export type DeviceProviderShareRow =
  | { state: "shareable" }
  | { state: "shared"; sharedAs: string };

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

export function shareLockedLine(managerName: string | null, organizationName: string): string {
  return `${managerName || "Your workspace owner"} manages AI providers for ${organizationName}.`;
}

export function shareConsentFacts(input: { providerName: string; organizationName: string }): Array<{ label: string; value: string }> {
  return [
    { label: "Who can use it", value: `Everyone in ${input.organizationName}, including people you invite later` },
    { label: "Your key", value: "A copy is stored encrypted in AI Gateway. Members never see it. Afterwards you choose whether it also stays on this device" },
    { label: "Cost", value: `Their usage is billed to your ${input.providerName} account` },
    { label: "Changing it", value: "Limit who uses it, or remove it, in AI Gateway" },
  ];
}

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
    case "account_mismatch": return "Verify with the account already signed in on this device.";
    case "no_session":
    case "organization_mismatch": return "Your account or organization changed. Close this and try again.";
    case "share_failed":
    case "den_unreachable": return "Could not share this provider. Nothing was shared.";
    default: return "Could not confirm this share. Check AI Providers before trying again.";
  }
}

export function shareNeedsVerification(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "verification_required";
}

export function shareNeedsReview(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
  return typeof code !== "string" || ![
    "already_shared", "not_shareable", "no_device_key", "forbidden", "gateway_unavailable",
    "feature_disabled", "no_session", "organization_mismatch", "account_mismatch",
    "share_failed", "den_unreachable", "verification_required", "invalid_provider",
  ].includes(code);
}

export type SharedProviderArrival = SharedDeviceProviderArrival;

export function shareOutcomeFacts(input: { providerName: string; organizationName: string; arrival: SharedProviderArrival }): Array<{ label: string; value: string }> {
  if (input.arrival.status === "pending") return [
    { label: "Shared", value: `${input.organizationName} has ${input.providerName} in AI Gateway` },
    { label: "This device", value: `Not listed under ${input.organizationName} here yet. Your key on this device still works` },
  ];
  return [
    { label: "Shared as", value: `${input.arrival.name}, listed under From ${input.organizationName}` },
    { label: "Use their copy", value: `Removes your key from this device. ${input.providerName} models run through ${input.organizationName}` },
    { label: "Keep both", value: `Your key stays on this device, and ${input.providerName} models are listed twice` },
  ];
}

export function shareOutcomeTitle(input: { providerName: string; organizationName: string; arrival: SharedProviderArrival }): string {
  return input.arrival.status === "arrived"
    ? `${input.providerName} is shared with ${input.organizationName}`
    : `${input.providerName} is shared, but not on this device yet`;
}
