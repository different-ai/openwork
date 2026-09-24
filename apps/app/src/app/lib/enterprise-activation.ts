import type { DenBootstrapConfig } from "./den";
import { DESKTOP_POLICY_ENFORCEMENT_ENABLED } from "@openwork/types/den/desktop-policies";
import type { DesktopDistributionInfo } from "./desktop";

type ActivationBootstrap = Pick<DenBootstrapConfig, "requireActivation" | "enterpriseActivation">;

/** Whether this install has to be activated at all, regardless of whether it already is. */
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

/**
 * Whether this install may reach hosts beyond its organization server: the
 * hosted runtime-config probe, product analytics, Cloud inventory. Installs
 * that never require activation always may. An activation-required install
 * may only once it is activated. Desktop-config readiness only participates
 * when desktop policy enforcement is enabled.
 */
export function outboundEgressAllowed(
  distribution: DesktopDistributionInfo,
  bootstrap: ActivationBootstrap,
  options: { desktopConfigLoading?: boolean } = {},
) {
  if (!activationRequirement(distribution, bootstrap)) return true;
  return !enterpriseActivationRequired(distribution, bootstrap)
    && (!DESKTOP_POLICY_ENFORCEMENT_ENABLED || options.desktopConfigLoading !== true);
}
