function readRedirectUrl(payload: unknown) {
  if (typeof payload !== "object" || payload === null || !("redirect" in payload) || !("url" in payload)) {
    return null
  }
  return payload.redirect === true && typeof payload.url === "string" ? payload.url : null
}

function buildRedirectHeaders(response: Response, url: string) {
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  headers.delete("content-type")
  headers.set("location", url)
  return headers
}

/**
 * Better Auth returns JSON redirect envelopes for fetch-style requests. An
 * OAuth authorization endpoint must navigate the user agent, so normalize
 * that envelope to the same 302 response produced for browser-style requests.
 */
export async function normalizeOAuthAuthorizeRedirect(response: Response) {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""
  if (!contentType.includes("application/json")) {
    return response
  }

  let payload: unknown
  try {
    payload = await response.clone().json()
  } catch {
    return response
  }

  const url = readRedirectUrl(payload)
  if (!url) {
    return response
  }

  return new Response(null, {
    status: 302,
    headers: buildRedirectHeaders(response, url),
  })
}
