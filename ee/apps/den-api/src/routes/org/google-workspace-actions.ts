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
    /** Omitted: the signed capability header or the default. null: always the default. */
    connectionId?: string | null
  }) => Promise<GoogleWorkspaceAccessToken>
  fetch: (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Read Google's legacy `errors[]` and google.rpc `details[]` error shapes. */
export function parseGoogleError(body: unknown): { reasons: Set<string>; status?: string; message?: string; service?: string } {
  const reasons = new Set<string>()
  if (!isRecord(body) || !isRecord(body.error)) return { reasons }
  const error = body.error
  let service: string | undefined
  for (const entry of [...(Array.isArray(error.errors) ? error.errors : []), ...(Array.isArray(error.details) ? error.details : [])]) {
    if (!isRecord(entry)) continue
    if (typeof entry.reason === "string") reasons.add(entry.reason)
    if (isRecord(entry.metadata) && typeof entry.metadata.serviceTitle === "string") service ??= entry.metadata.serviceTitle
  }
  return {
    reasons,
    status: typeof error.status === "string" ? error.status : undefined,
    message: typeof error.message === "string" ? error.message.slice(0, 300) : undefined,
    service,
  }
}

/** Only a rejected or under-scoped token is fixed by reconnecting. */
export function isGoogleAuthorizationFailure(status: number, reasons: ReadonlySet<string>): boolean {
  if (status === 401) return true
  return status === 403 && (reasons.has("authError") || reasons.has("insufficientPermissions") || reasons.has("ACCESS_TOKEN_SCOPE_INSUFFICIENT"))
}

function googleFailureMessage(status: number, google: ReturnType<typeof parseGoogleError>, url: URL, method: string | undefined): string {
  let hint = ""
  if (google.reasons.has("SERVICE_DISABLED") || google.reasons.has("accessNotConfigured")) {
    hint = ` An organization admin must enable ${google.service ?? "this Google API"} in the Google Cloud project that owns the Google Workspace connector's OAuth client; reconnecting does not help.`
  } else if (google.reasons.has("exportSizeLimitExceeded")) {
    hint = " Google exports Docs, Sheets and Slides files only up to 10 MB. Export a smaller format such as csv or txt, or split the file."
  } else if (google.status === "FAILED_PRECONDITION" && url.pathname.includes("/v4/spreadsheets/")) {
    hint = " Sheets actions only work on native Google Sheets. To work on an Office file such as .xlsx, pull it into the workspace with the drive_pull_file tool and edit it there, or save it as a Google Sheet in Drive first."
  } else if (status === 404 || (status === 403 && google.reasons.size === 0)) {
    hint = " The connected Google account may not have access to this item, or the ID may be wrong."
  }
  const uncertain = method && method !== "GET" && status >= 500 ? " Check whether the operation completed before retrying." : ""
  const detail = google.message ? `: ${google.message}${/[.!?]$/.test(google.message) ? "" : "."}` : "."
  return `Google returned HTTP ${status}${detail}${hint}${uncertain}`
}

/** Reuse the selected credential; require both account grants and current connector permissions. */
export async function requestGoogleAction(
  c: Pick<Context<{ Variables: OrgRouteVariables }>, "get" | "json" | "req" | "header">,
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
    const google = parseGoogleError(await readGoogleActionJson(response))
    if (isGoogleAuthorizationFailure(response.status, google.reasons)) {
      return { ok: false, reply: c.json({
        error: "needs_connection",
        message: "Google rejected this connection's authorization. Reconnect Google Workspace and grant the enabled permissions, then retry.",
      }, 409) }
    }
    return { ok: false, reply: c.json({ error: "google_api_error", message: googleFailureMessage(response.status, google, url, init.method) }, 502) }
  }
  return { ok: true, response }
}
