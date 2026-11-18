/**
 * ssoPerOrganization: Den answers 403 `sso_required` (or Better Auth's
 * `SSO_REQUIRED` code for set-active) when an organization requires SSO and
 * this session did not sign in through it. The answer carries the
 * organization's SSO sign-in path; the person is sent there and comes back to
 * the page they were opening.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The organization's SSO sign-in path from a refusal, or null when the payload is something else. */
export function readSsoRequiredSignInPath(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  if (payload.error !== "sso_required" && payload.code !== "SSO_REQUIRED") return null;
  const path = payload.signInPath;
  return typeof path === "string" && path.startsWith("/") && !path.startsWith("//") ? path : null;
}

/** Where to go: the SSO sign-in page, returning to `returnTo` afterwards. */
export function buildSsoRequiredRedirect(signInPath: string, returnTo: string, origin: string): string {
  const target = new URL(signInPath, origin);
  if (target.origin !== origin) {
    return new URL("/", origin).toString();
  }
  target.searchParams.set("callbackURL", returnTo);
  return target.toString();
}

export class SsoRequiredError extends Error {
  readonly signInPath: string;

  constructor(signInPath: string, message = "This organization requires single sign-on.") {
    super(message);
    this.name = "SsoRequiredError";
    this.signInPath = signInPath;
  }
}

/** Send the browser to the organization's SSO. */
export function redirectToOrganizationSso(signInPath: string) {
  if (typeof window === "undefined") return;
  window.location.assign(buildSsoRequiredRedirect(signInPath, window.location.href, window.location.origin));
}
