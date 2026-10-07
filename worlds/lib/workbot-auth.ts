/** The probe signed in directly on Den API. Use that same internal auth hop,
 * not a loopback HTTP request through Den web, which can infer different secure-cookie settings.
 * Public browser URLs and production OAuth routing are unchanged.
 */
export function workbotProbeAuthorizeUrl(authorize: string, publicDen: string, apiDen: string): string {
  const target = new URL(authorize);
  const web = new URL(publicDen);
  const api = new URL(apiDen);
  if (![web.origin, api.origin].includes(target.origin) || target.pathname !== "/api/auth/oauth2/authorize" || target.username || target.password || target.hash) {
    throw new Error("Workbot returned an untrusted Den authorization URL");
  }
  return `${api.origin}${target.pathname}${target.search}`;
}
