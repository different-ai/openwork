/**
 * The browser cookie Den API sets after a password, Google or GitHub sign-in
 * and clears after an SSO sign-in (den-api src/last-sign-in-method.ts).
 * Feature: `lastUsedSignIn`.
 */
export const LAST_SIGN_IN_METHOD_COOKIE = "openwork-last-sign-in";

export const LAST_SIGN_IN_METHODS = ["google", "github", "password"] as const;

export type LastSignInMethod = (typeof LAST_SIGN_IN_METHODS)[number];

/** The remembered method in a `document.cookie` string, or null. */
export function readLastSignInMethod(cookieHeader: string): LastSignInMethod | null {
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== LAST_SIGN_IN_METHOD_COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    const method = LAST_SIGN_IN_METHODS.find((candidate) => candidate === value);
    if (method) return method;
  }
  return null;
}
