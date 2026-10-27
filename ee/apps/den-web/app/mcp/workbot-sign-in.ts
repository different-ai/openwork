/** Presentation only. Den still validates the signed query, consent, PKCE and workspace membership. */
export function isWorkbotSignIn(search: string) {
  const params = new URLSearchParams(search);
  return params.get("client_id") === "openwork-workbot" && params.get("response_type") === "code";
}
