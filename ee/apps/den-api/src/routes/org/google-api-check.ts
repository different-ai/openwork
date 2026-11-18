import { isGoogleAuthorizationFailure, parseGoogleError } from "./google-workspace-actions.js"

const DRIVE_FEATURES = ["driveFile", "driveRead", "driveFull"]
// A well-formed ID no file has: an enabled API answers "not found", a turned-off one "disabled".
const PROBE_ID = "openwork-api-check"

/**
 * The Google APIs the Google Workspace connector calls, which permissions need each one, and
 * one read per API that shows whether it is turned on without returning anyone's content.
 * Documents opens Google Docs and Sheets through their own APIs, so Drive permissions need both.
 */
export const GOOGLE_CONNECTOR_APIS = [
  { id: "drive", name: "Google Drive API", service: "drive.googleapis.com", features: DRIVE_FEATURES, host: "https://www.googleapis.com", path: "/drive/v3/about?fields=kind" },
  { id: "docs", name: "Google Docs API", service: "docs.googleapis.com", features: DRIVE_FEATURES, host: "https://docs.googleapis.com", path: `/v1/documents/${PROBE_ID}?fields=documentId` },
  { id: "sheets", name: "Google Sheets API", service: "sheets.googleapis.com", features: ["sheetsRead", "sheetsWrite", ...DRIVE_FEATURES], host: "https://sheets.googleapis.com", path: `/v4/spreadsheets/${PROBE_ID}?fields=spreadsheetId` },
  { id: "gmail", name: "Gmail API", service: "gmail.googleapis.com", features: ["gmailDraft", "gmailSend", "gmailRead", "gmailManage", "gmailLabels"], host: "https://gmail.googleapis.com", path: "/gmail/v1/users/me/profile?fields=historyId" },
  { id: "calendar", name: "Google Calendar API", service: "calendar-json.googleapis.com", features: ["calendarRead", "calendarWrite"], host: "https://www.googleapis.com", path: "/calendar/v3/calendars/primary/events?maxResults=1&fields=kind" },
  { id: "chat", name: "Google Chat API", service: "chat.googleapis.com", features: ["chat"], host: "https://chat.googleapis.com", path: "/v1/spaces?pageSize=1&fields=nextPageToken" },
] as const

export type GoogleApiCheck = {
  id: string
  name: string
  service: string
  /** The enabled permissions that call this API. */
  features: string[]
  status: "enabled" | "disabled" | "unknown"
  /** Where an admin turns the API on, when Google reported it off. */
  enableUrl: string | null
  detail: string | null
}

/** The connector's APIs that at least one enabled permission calls. */
export function requiredGoogleApis(features: readonly string[]) {
  return GOOGLE_CONNECTOR_APIS
    .map((api) => ({ ...api, features: api.features.filter((feature) => features.includes(feature)) }))
    .filter((api) => api.features.length > 0)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Google's own activation link, kept only when it points at the Google Cloud console. */
function activationUrl(body: unknown, service: string): string {
  const details = isRecord(body) && isRecord(body.error) && Array.isArray(body.error.details) ? body.error.details : []
  for (const entry of details) {
    const link = isRecord(entry) && isRecord(entry.metadata) ? entry.metadata.activationUrl : undefined
    if (typeof link !== "string") continue
    try {
      const url = new URL(link)
      if (url.protocol === "https:" && (url.hostname === "console.developers.google.com" || url.hostname === "console.cloud.google.com")) return url.toString()
    } catch { /* fall through to the library page */ }
  }
  return `https://console.cloud.google.com/apis/library/${service}`
}

export function classifyGoogleApiProbe(status: number, body: unknown, service: string): Pick<GoogleApiCheck, "status" | "enableUrl" | "detail"> {
  const google = parseGoogleError(body)
  if (google.reasons.has("SERVICE_DISABLED") || google.reasons.has("accessNotConfigured")) {
    return { status: "disabled", enableUrl: activationUrl(body, service), detail: "Turned off in the Google Cloud project that owns this connector's OAuth client." }
  }
  // Not found and invalid-request answers come from an API that is on.
  if (status < 300 || status === 400 || status === 404) return { status: "enabled", enableUrl: null, detail: null }
  if (isGoogleAuthorizationFailure(status, google.reasons)) {
    return { status: "unknown", enableUrl: null, detail: "Your Google sign-in on this connector doesn't include this permission. Sign in again to check it." }
  }
  return { status: "unknown", enableUrl: null, detail: `Google returned HTTP ${status}.` }
}

/** Probe each API the enabled permissions need, using one member's own connector sign-in. */
export async function checkGoogleConnectorApis(input: {
  accessToken: string
  features: readonly string[]
  /** Replaces every Google host, as `env.googleApiBaseUrl` does for test servers. */
  baseUrl?: string
  fetch?: typeof fetch
}): Promise<GoogleApiCheck[]> {
  const request = input.fetch ?? fetch
  return Promise.all(requiredGoogleApis(input.features).map(async (api): Promise<GoogleApiCheck> => {
    const base = { id: api.id, name: api.name, service: api.service, features: [...api.features] }
    try {
      const response = await request(new URL(`${input.baseUrl ?? api.host}${api.path}`), {
        headers: { authorization: `Bearer ${input.accessToken}` },
        signal: AbortSignal.timeout(10_000),
      })
      const body: unknown = await response.json().catch(() => null)
      return { ...base, ...classifyGoogleApiProbe(response.status, body, api.service) }
    } catch {
      return { ...base, status: "unknown", enableUrl: null, detail: "Google could not be reached. Try again." }
    }
  }))
}
