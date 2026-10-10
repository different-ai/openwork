/**
 * Where a signed-in user lands. `/onboarding` owns organization resolution:
 * it runs when no active organization is committed yet, and also while a
 * desktop-initiated sign-in is deliberately holding the choice open for the
 * user (`orgSelectionPending`) — even if a background layer has already
 * written some default organization id.
 */
export function signedInRoute(
  activeOrgId: string | null | undefined,
  options?: { orgSelectionPending?: boolean },
): "/session" | "/onboarding" {
  if (options?.orgSelectionPending) return "/onboarding";
  return activeOrgId?.trim() ? "/session" : "/onboarding";
}

/**
 * Where the Den sign-in gate sends the user. Pure so the routing table can be
 * tested without rendering the shell.
 *
 * A desktop prepared by an agent-first install (`openwork-bootstrap cloud
 * bootstrap-workspace --prepare-desktop`) holds a provisional workspace with no
 * owner yet, so there is nobody to sign in as. Its "Setup complete" page, whose
 * only actions are claiming the workspace or pasting a sign-in code, is shown
 * even when the build forces sign-in (cloud and enterprise). It exposes no
 * workspace data, so it does not weaken the sign-in requirement.
 */
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
      // The prepared page offers its own "Sign in" link to /signin, so a user
      // who chose to sign in with an existing account stays there.
      if (input.hasPreparedBootstrap) {
        return input.onOnboarding || input.onSignin ? null : "/onboarding";
      }
      return input.onSignin ? null : "/signin";
    }
    return input.onSignin ? "signed-in-home" : null;
  }

  if (input.onSignin) {
    // Reached from the prepared page's "Sign in with an existing account".
    return input.hasPreparedBootstrap && !input.isSignedIn ? null : "/session";
  }
  if (!input.isSignedIn && input.hasPreparedBootstrap && !input.onOnboarding) return "/onboarding";
  if (input.isSignedIn && !input.onOnboarding && input.orgSelectionPending) {
    // A desktop-initiated sign-in is still waiting for the user's explicit
    // organization choice (including after an app relaunch mid-flow); the
    // onboarding step owns resolving it.
    return "/onboarding";
  }
  if (input.onOnboarding && !input.isSignedIn && !input.hasPreparedBootstrap) return "/session";
  return null;
}

/** True when the first render should already jump to the prepared page. */
export function shouldRenderPreparedRedirect(input: DenSigninRouteInput): boolean {
  return resolveDenSigninRedirect(input) === "/onboarding" && input.hasPreparedBootstrap && !input.isSignedIn;
}
