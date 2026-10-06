import { env } from "../../env.js"
import { publicRequestUrl } from "../../request-url.js"

/**
 * The public API base URL an external OAuth server should redirect back to.
 * A configured pathname is preserved for self-hosted deployments that expose
 * Den behind a prefix such as `/api/den`. Behind a
 * reverse proxy (e.g. Daytona's port-forwarding proxy), `request.url`
 * reflects the *internal* bind address (http://127.0.0.1:8788) rather than
 * the public URL the browser actually called, since the proxy doesn't
 * rewrite the request's own URL — `x-forwarded-proto` can correct the
 * scheme, while `DEN_API_PUBLIC_URL`, when set, is still needed when the
 * proxy does not preserve the public host.
 */
export function resolvePublicApiBaseUrl(request: Request, apiPublicUrl: string | undefined): string {
  if (apiPublicUrl) {
    const url = new URL(apiPublicUrl)
    const pathname = url.pathname.replace(/\/+$/, "")
    return `${url.origin}${pathname === "/" ? "" : pathname}`
  }
  return publicRequestUrl(request, { trustedOrigins: env.publicUrlTrustedOrigins }).origin
}

/** Compatibility name retained for existing callback and webhook builders. */
export const resolvePublicOrigin = resolvePublicApiBaseUrl
