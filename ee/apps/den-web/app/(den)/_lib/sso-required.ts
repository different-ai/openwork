function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function readSsoRequiredSignInPath(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  if (payload.error !== "sso_required" && payload.code !== "SSO_REQUIRED") return null;
  const path = payload.signInPath;
  return typeof path === "string" && path.startsWith("/") && !path.startsWith("//") ? path : null;
}

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

export function redirectToOrganizationSso(signInPath: string) {
  if (typeof window === "undefined") return;
  window.location.assign(buildSsoRequiredRedirect(signInPath, window.location.href, window.location.origin));
}
