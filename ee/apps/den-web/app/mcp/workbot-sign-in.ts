/** Presentation only. Den still validates the signed query, consent, PKCE and workspace membership. */
export function isWorkbotSignIn(search: string) {
  const params = new URLSearchParams(search);
  return params.get("client_id") === "openwork-workbot" && params.get("response_type") === "code";
}

/**
 * The OpenWork phone app signs existing accounts in and never creates one: app stores require an app that creates
 * accounts to delete them too, and Den has no account deletion. Workbot adds this to the phone's sign-in
 * (ee/apps/workbot/src/server/den.ts). Presentation only: creating an account on the web is unchanged.
 */
export function isSignInOnly(search: string) {
  return new URLSearchParams(search).get("openwork_sign_in_only") === "true";
}
