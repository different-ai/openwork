/**
 * Whether a page that lives in OpenWork Cloud (Artifacts, Automations) has a
 * sidebar entry and a route.
 *
 * Signed in, the member's deployment decides: Den's flag for that page is the
 * gate. Signed out there is no deployment to ask, so the page stays, on every
 * runtime, as an empty state whose action is signing in. While the first
 * sign-in check runs the answer is not known yet, so only an already-enabled
 * deployment shows the page; that keeps it from flashing for a member whose
 * deployment has it turned off.
 */
export function cloudSurfaceAvailable(input: {
  /** Den's deployment flag for this page, false until the config has loaded. */
  deploymentEnabled: boolean;
  /** The first sign-in check has not finished. */
  authChecking: boolean;
  signedIn: boolean;
}): boolean {
  if (input.deploymentEnabled) return true;
  return !input.authChecking && !input.signedIn;
}
