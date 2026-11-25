export function signedInRoute(
  activeOrgId: string | null | undefined,
  options?: { orgSelectionPending?: boolean },
): "/session" | "/onboarding" {
  if (options?.orgSelectionPending) return "/onboarding";
  return activeOrgId?.trim() ? "/session" : "/onboarding";
}

export type DenSigninRouteInput = {
  authChecking: boolean;
  isSignedIn: boolean;
  requireSignin: boolean;
  hasPreparedBootstrap: boolean;
  onSignin: boolean;
  onOnboarding: boolean;
  orgSelectionPending: boolean;
};

export type DenSigninRedirect = "/signin" | "/session" | "/onboarding" | "signed-in-home" | null;

export function resolveDenSigninRedirect(input: DenSigninRouteInput): DenSigninRedirect {
  if (input.authChecking) return null;

  if (input.requireSignin) {
    if (!input.isSignedIn) {
      if (input.hasPreparedBootstrap) {
        return input.onOnboarding || input.onSignin ? null : "/onboarding";
      }
      return input.onSignin ? null : "/signin";
    }
    return input.onSignin ? "signed-in-home" : null;
  }

  if (input.onSignin) {
    return input.hasPreparedBootstrap && !input.isSignedIn ? null : "/session";
  }
  if (!input.isSignedIn && input.hasPreparedBootstrap && !input.onOnboarding) return "/onboarding";
  if (input.isSignedIn && !input.onOnboarding && input.orgSelectionPending) {
    return "/onboarding";
  }
  if (input.onOnboarding && !input.isSignedIn && !input.hasPreparedBootstrap) return "/session";
  return null;
}

export function shouldRenderPreparedRedirect(input: DenSigninRouteInput): boolean {
  return resolveDenSigninRedirect(input) === "/onboarding" && input.hasPreparedBootstrap && !input.isSignedIn;
}
