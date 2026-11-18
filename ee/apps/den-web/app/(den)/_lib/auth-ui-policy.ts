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

/**
 * Where sign-up is closed, an email with no account gets the password step like any other email: the panel never
 * offers to create an account, and does not say whether one exists.
 */
export function emailFirstStepWhenSignUpClosed<Step extends string>(step: Step, signUpClosed: boolean): Step | "password" {
  return signUpClosed && step === "new_account" ? "password" : step;
}
