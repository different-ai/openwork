import type { DenBootstrapConfig } from "./den";
import { DESKTOP_POLICY_ENFORCEMENT_ENABLED } from "@openwork/types/den/desktop-policies";
import type { DesktopDistributionInfo } from "./desktop";

type ActivationBootstrap = Pick<DenBootstrapConfig, "requireActivation" | "enterpriseActivation">;

function activationRequirement(distribution: DesktopDistributionInfo, bootstrap: ActivationBootstrap) {
  return distribution.flavor === "enterprise"
    ? distribution.requireActivation
    : (typeof bootstrap.requireActivation === "boolean"
        ? bootstrap.requireActivation
        : distribution.requireActivation);
}

export function enterpriseActivationRequired(
  distribution: DesktopDistributionInfo,
  bootstrap: ActivationBootstrap,
) {
  return activationRequirement(distribution, bootstrap)
    && !(
      bootstrap.enterpriseActivation?.activatedAt
      && bootstrap.enterpriseActivation?.denBaseUrl
    );
}

export function outboundEgressAllowed(
  distribution: DesktopDistributionInfo,
  bootstrap: ActivationBootstrap,
  options: { desktopConfigLoading?: boolean } = {},
) {
  if (!activationRequirement(distribution, bootstrap)) return true;
  return !enterpriseActivationRequired(distribution, bootstrap)
    && (!DESKTOP_POLICY_ENFORCEMENT_ENABLED || options.desktopConfigLoading !== true);
}

export function externalTelemetryAllowed(distribution: Pick<DesktopDistributionInfo, "flavor">): boolean {
  return distribution.flavor !== "enterprise";
}
