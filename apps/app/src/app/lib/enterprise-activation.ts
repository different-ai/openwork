import type { DenBootstrapConfig } from "./den";
import type { DesktopDistributionInfo } from "./desktop";

export function enterpriseActivationRequired(
  distribution: DesktopDistributionInfo,
  bootstrap: Pick<DenBootstrapConfig, "requireActivation" | "enterpriseActivation">,
) {
  const requireActivation = distribution.flavor === "enterprise"
    ? distribution.requireActivation
    : (typeof bootstrap.requireActivation === "boolean"
        ? bootstrap.requireActivation
        : distribution.requireActivation);
  return requireActivation
    && !(
      bootstrap.enterpriseActivation?.activatedAt
      && bootstrap.enterpriseActivation?.denBaseUrl
    );
}
