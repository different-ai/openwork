/**
 * The verification-table key Better Auth stores OAuth and SAML relay state
 * under. Better Auth 1.7.7 prefixes the raw state (`auth-state:<state>`) but
 * does not export its helper from the package root, so this mirrors it;
 * test/sso-state-identifier.test.ts fails if the two drift apart.
 */
export function ssoStateVerificationIdentifier(state: string) {
  return `auth-state:${state}`
}
