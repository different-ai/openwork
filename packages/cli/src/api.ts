import type { Session } from "./config.ts"
import { CliError, type Io } from "./io.ts"
import { field, items, optionalText, text } from "./json.ts"

function describeFailure(status: number, body: unknown): string {
  const issues = items(body, "details").map((issue) => {
    const where = items(issue, "path").join(".")
    return where ? `${where}: ${text(issue, "message")}` : text(issue, "message")
  }).filter((issue) => issue !== "")
  const summary = optionalText(body, "message")
    ?? (issues.length ? "The request was not valid." : `The API answered ${status}${optionalText(body, "error") ? `: ${text(body, "error")}` : ""}.`)
  const billingUrl = optionalText(body, "billingUrl")
  return [summary, ...issues, ...(billingUrl ? [`Start billing: ${billingUrl}`] : [])].join("\n")
}

export class ApiError extends CliError {
  readonly status: number

  constructor(status: number, body: unknown) {
    super(optionalText(body, "error") ?? `http_${status}`, describeFailure(status, body), body)
    this.status = status
  }

  get needsRecentSignIn(): boolean {
    return this.status === 403 && field(this.details, "reason") === "fresh_auth_required"
  }
}

export type RequestOptions = { method?: string; body?: unknown; headers?: Record<string, string> }
export type RawResponse = { status: number; body: unknown; headers: Headers }

const REQUEST_TIMEOUT_MS = 60_000

/** One HTTP call. An error status is returned, not thrown; the caller decides what it means. */
export async function rawRequest(io: Io, baseUrl: string, path: string, options: RequestOptions = {}): Promise<RawResponse> {
  let response: Response
  try {
    response = await io.fetch(`${baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: { "content-type": "application/json", origin: baseUrl, ...options.headers },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "no answer within a minute" : error instanceof Error ? error.message : String(error)
    throw new CliError("network_error", `Could not reach ${baseUrl}: ${reason}`)
  }
  const answer = await response.text()
  let body: unknown = null
  if (answer) {
    try {
      body = JSON.parse(answer)
    } catch {
      body = { message: answer.slice(0, 500) }
    }
  }
  return { status: response.status, body, headers: response.headers }
}

export function authHeaders(session: Session): Record<string, string> {
  return {
    ...(session.auth.kind === "apiKey" ? { "x-api-key": session.auth.value } : { authorization: `Bearer ${session.auth.value}` }),
    ...(session.orgId ? { "x-openwork-org-id": session.orgId } : {}),
  }
}

function rejectedCredential(session: Session): string {
  if (session.source === "profile") return "Your sign-in is no longer valid. Run `openwork auth login`."
  if (session.source === "openwork-bootstrap") return "The sign-in saved by `openwork-bootstrap login` is no longer valid. Run `openwork auth login`."
  return `${session.source} was rejected. Check its value.`
}

export async function api(io: Io, session: Session, method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await rawRequest(io, session.baseUrl, path, { method, body, headers: authHeaders(session) })
  if (response.status === 401) throw new CliError("not_signed_in", rejectedCredential(session), response.body)
  if (response.status >= 400) throw new ApiError(response.status, response.body)
  return response.body
}
