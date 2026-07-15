import type { AuthMode } from "./den-flow";
import type { DenWebRuntimeConfig } from "./runtime-config";

export function isSingleOrgSignupDisabled(config: DenWebRuntimeConfig, runtimeConfigLoaded: boolean) {
  return runtimeConfigLoaded && config.orgMode === "single_org" && !config.singleOrgAllowPublicSignup;
}

export function resolveVisibleAuthMode(input: {
  authMode: AuthMode;
  runtimeConfig: DenWebRuntimeConfig;
  runtimeConfigLoaded: boolean;
}): AuthMode {
  return isSingleOrgSignupDisabled(input.runtimeConfig, input.runtimeConfigLoaded) && input.authMode === "sign-up"
    ? "sign-in"
    : input.authMode;
}
