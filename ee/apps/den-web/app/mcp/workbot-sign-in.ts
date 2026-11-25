export function isWorkbotSignIn(search: string) {
  const params = new URLSearchParams(search);
  return params.get("client_id") === "openwork-workbot" && params.get("response_type") === "code";
}

export function isSignInOnly(search: string) {
  return new URLSearchParams(search).get("openwork_sign_in_only") === "true";
}
