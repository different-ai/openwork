import type { Session } from "./config.ts"
import { CliError, type Io } from "./io.ts"
import { field, optionalText } from "./json.ts"

export class ApiError extends CliError {
  readonly status: number

  constructor(status: number, body: unknown) {
    super(optionalText(body, "error") ?? `http_${status}`, optionalText(body, "message") ?? `The API answered ${status}.`, body)
    this.status = status
  }

  get needsRecentSignIn(): boolean {
    return this.status === 403 && field(this.details, "reason") === "fresh_auth_required"
  }
}

export type RequestOptions = { method?: string; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal }
export type RawResponse = { status: number; body: unknown; headers: Headers }

export async function rawRequest(io: Io, baseUrl: string, path: string, options: RequestOptions = {}): Promise<RawResponse> {
  let response: Response
  try {
    response = await io.fetch(`${baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: { "content-type": "application/json", origin: baseUrl, ...options.headers },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    })
  } catch (error) {
    if (options.signal?.aborted) throw error
    throw new CliError("network_error", `Could not reach ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const text = await response.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = { message: text.slice(0, 500) }
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

export async function api(io: Io, session: Session, method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await rawRequest(io, session.baseUrl, path, { method, body, headers: authHeaders(session) })
  if (response.status === 401) {
    throw new CliError("not_signed_in", session.source === "profile"
      ? "Your sign-in is no longer valid. Run `openwork auth login`."
      : `${session.source} was rejected. Check its value.`, response.body)
  }
  if (response.status >= 400) throw new ApiError(response.status, response.body)
  return response.body
}
