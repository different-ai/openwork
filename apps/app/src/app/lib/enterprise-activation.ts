import type { DenBootstrapConfig } from "./den";
import type { DesktopDistributionInfo } from "./desktop";

export function enterpriseActivationRequired(
  distribution: DesktopDistributionInfo,
  bootstrap: Pick<DenBootstrapConfig, "enterpriseActivation">,
) {
  return distribution.flavor === "enterprise"
    && !(
      bootstrap.enterpriseActivation?.activatedAt
      && bootstrap.enterpriseActivation?.denBaseUrl
    );
}
