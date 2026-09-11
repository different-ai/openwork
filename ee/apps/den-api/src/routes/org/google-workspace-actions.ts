import type { Context } from "hono"
import type { GoogleWorkspaceAccessToken } from "./google-workspace.js"
import type { OrgRouteVariables } from "./shared.js"

export const GOOGLE_ACTION_MAX_BODY_BYTES = 6 * 1024 * 1024

/** Bound decoded provider bytes before JSON parsing, including chunked responses. */
export async function readGoogleActionJson(response: Response): Promise<unknown> {
  if (!response.body) return null
  const reader = response.body.getReader()
  try {
    if (Number(response.headers.get("content-length")) > GOOGLE_ACTION_MAX_BODY_BYTES) return null
    const decoder = new TextDecoder()
    let bytes = 0
    let text = ""
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > GOOGLE_ACTION_MAX_BODY_BYTES) return null
      text += decoder.decode(chunk.value, { stream: true })
    }
    return JSON.parse(text + decoder.decode())
  } catch {
    return null
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export type GoogleWorkspaceActionDependencies = {
  token: (input: {
    organizationId: NonNullable<OrgRouteVariables["organizationContext"]>["organization"]["id"]
    orgMembershipId: NonNullable<OrgRouteVariables["organizationContext"]>["currentMember"]["id"]
  }) => Promise<GoogleWorkspaceAccessToken>
  fetch: (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>
}

/** Reuse the selected credential; require both account grants and current connector permissions. */
export async function requestGoogleAction(
  c: Context<{ Variables: OrgRouteVariables }>,
  dependencies: GoogleWorkspaceActionDependencies,
  scopes: readonly string[],
  url: URL,
  init: RequestInit = {},
  requiredFeatures?: readonly string[],
): Promise<{ ok: true; response: Response } | { ok: false; reply: Response }> {
  const context = c.get("organizationContext")
  if (!context) return { ok: false, reply: c.json({ error: "unauthorized", message: "Sign in to an organization first." }, 401) }
  const token = await dependencies.token({ organizationId: context.organization.id, orgMembershipId: context.currentMember.id })
  if (token.kind !== "ok") {
    return { ok: false, reply: c.json({ error: token.kind, message: token.message }, token.kind === "policy_blocked" ? 403 : token.kind === "needs_connection" ? 409 : 502) }
  }
  if (requiredFeatures && !token.enabledFeatures?.some((feature) => requiredFeatures.includes(feature))) {
    return { ok: false, reply: c.json({ error: "needs_connection", message: "The administrator has not enabled this action for the selected Google connector. Enable it in connector setup before using it." }, 409) }
  }
  if (!token.account.scopes?.some((scope) => scopes.includes(scope))
    || !token.enabledScopes?.some((scope) => scopes.includes(scope))) {
    return { ok: false, reply: c.json({ error: "needs_connection", message: "Enable the required Google Workspace permission in connector setup, then reconnect this account. Existing or unknown grants do not authorize this operation." }, 409) }
  }
  const headers = new Headers(init.headers)
  headers.set("authorization", `Bearer ${token.accessToken}`)
  if (init.body) headers.set("content-type", "application/json")
  let response: Response
  try {
    response = await dependencies.fetch(url, { ...init, headers, signal: c.req.raw.signal })
  } catch {
    return { ok: false, reply: c.json({
      error: "google_api_error",
      message: init.method && init.method !== "GET"
        ? "Google did not confirm the operation. It may have completed; check the service before retrying."
        : "Google could not be reached. Try the read again later.",
    }, 502) }
  }
  if (!response.ok) {
    const authorizationFailure = response.status === 401 || response.status === 403
    return { ok: false, reply: c.json({
      error: authorizationFailure ? "needs_connection" : "google_api_error",
      message: authorizationFailure
        ? "Google rejected this account's permissions. Check access to the item and reconnect with the required permissions."
        : `Google returned HTTP ${response.status}.${init.method && init.method !== "GET" && response.status >= 500 ? " Check whether the operation completed before retrying." : ""}`,
    }, authorizationFailure ? 409 : 502) }
  }
  return { ok: true, response }
}
