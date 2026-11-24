import { APIError } from "better-auth/api"
import { assertPublicUrl, PrivateUrlError, UnresolvedHostError } from "../capability-sources/url-guard.js"
import { env } from "../env.js"

function ownOrigins(): Set<string> {
  const origins = new Set<string>()
  for (const candidate of [env.betterAuthUrl, env.apiPublicUrl, ...env.corsOrigins]) {
    if (!candidate) continue
    try {
      origins.add(new URL(candidate).origin)
    } catch {
    }
  }
  return origins
}

export async function isCimdClientIdUrlAllowed(clientIdUrl: string): Promise<boolean> {
  let url: URL
  try {
    url = new URL(clientIdUrl)
  } catch {
    return false
  }
  if (url.protocol !== "https:") return false
  if (ownOrigins().has(url.origin)) return false
  if (env.allowPrivateMcpUrls) return true
  try {
    await assertPublicUrl(clientIdUrl)
    return true
  } catch (error) {
    if (error instanceof UnresolvedHostError && error.temporary) {
      throw new APIError("SERVICE_UNAVAILABLE", {
        error: "temporarily_unavailable",
        error_description: "Could not look up the client_id host. Try again in a moment.",
      })
    }
    if (error instanceof PrivateUrlError) return false
    throw error
  }
}

export async function fetchCimdMetadataResource(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  if (!(await isCimdClientIdUrlAllowed(url))) {
    throw new Error("Client metadata URL is not permitted by the server's fetch policy")
  }
  return fetch(url, { ...init, redirect: "error" })
}
