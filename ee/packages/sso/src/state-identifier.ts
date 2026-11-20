/**
 * The verification-table key Better Auth stores OAuth and SAML relay state
 * under. Better Auth 1.7.7 prefixes the raw state (`auth-state:<state>`) but
 * does not export its helper from the package root, so this mirrors it.
 * Nothing checks the two still agree, so look again when Better Auth is upgraded.
 */
export function ssoStateVerificationIdentifier(state: string) {
  return `auth-state:${state}`
}
