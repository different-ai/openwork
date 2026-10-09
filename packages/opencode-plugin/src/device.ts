/**
 * OpenWork sign-in: Den's OAuth 2.0 Device Authorization Grant (RFC 8628).
 *
 * The member approves a short code on Den web's /device page and picks the
 * organization there; polling returns a new Den session token valid on /v1.
 * Prior art: packages/openwork-bootstrap/bin/openwork.mjs (deviceLogin).
 */
import { isRecord, normalizeBaseUrl, postPublic, type Fetch } from "./den.ts"

/** Shown on the approval page as "OpenWork - OpenCode Plugin". */
export const DEVICE_CLIENT_ID = "openwork-opencode-plugin"
/**
 * Accepted by every Den release. Used only when Den does not know
 * DEVICE_CLIENT_ID yet (older self-hosted installs, or the rollout flag off).
 */
export const FALLBACK_DEVICE_CLIENT_ID = "openwork-cli"
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"

export interface DeviceAuthorization {
  readonly clientId: string
  readonly deviceCode: string
  /** ABCD-EFGH */
  readonly userCode: string
  readonly verificationUri: string
  readonly verificationUriComplete: string
  readonly intervalMs: number
  /** Milliseconds since the epoch. */
  readonly expiresAt: number
}

export class DeviceFlowError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DeviceFlowError"
  }
}

export function formatUserCode(value: string): string {
  const clean = value.replace(/[\s-]/g, "").toUpperCase()
  return clean.length === 8 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean
}

function errorCode(body: unknown): string | null {
  return isRecord(body) && typeof body.error === "string" ? body.error : null
}

export async function startDeviceAuthorization(input: {
  fetcher: Fetch
  apiBaseUrl: string
  clientIds?: readonly string[]
  now?: () => number
}): Promise<DeviceAuthorization> {
  const now = input.now ?? Date.now
  const clientIds = input.clientIds ?? [DEVICE_CLIENT_ID, FALLBACK_DEVICE_CLIENT_ID]
  let last: { status: number; body: unknown } | null = null
  for (const clientId of clientIds) {
    const started = await postPublic(input.fetcher, input.apiBaseUrl, "/api/auth/device/code", { client_id: clientId })
    last = started
    // Den rejects an unknown client with 400 invalid_client: try the next id.
    if (started.status === 400 && errorCode(started.body) === "invalid_client") continue
    const body = started.body
    if (started.status !== 200 || !isRecord(body) || typeof body.device_code !== "string" || typeof body.user_code !== "string") {
      break
    }
    const verificationUri = typeof body.verification_uri === "string" ? body.verification_uri : `${normalizeBaseUrl(input.apiBaseUrl)}/device`
    const verificationUriComplete = typeof body.verification_uri_complete === "string"
      ? body.verification_uri_complete
      : `${verificationUri}?user_code=${encodeURIComponent(body.user_code)}`
    const interval = Number(body.interval)
    const expiresIn = Number(body.expires_in)
    return {
      clientId,
      deviceCode: body.device_code,
      userCode: formatUserCode(body.user_code),
      verificationUri,
      verificationUriComplete,
      intervalMs: Math.max(1, Number.isFinite(interval) ? interval : 5) * 1000,
      expiresAt: now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 900) * 1000,
    }
  }
  throw new DeviceFlowError(
    `Could not start OpenWork sign-in (${last?.status ?? "no response"}${errorCode(last?.body) ? `: ${errorCode(last?.body)}` : ""}).`,
  )
}

/** A waker lets the browser return page end the current wait early, so the poll runs at once. */
export interface PollWaker {
  wait(ms: number): Promise<void>
}

export function timerWaker(): PollWaker & { wake(): void } {
  let wake: (() => void) | null = null
  return {
    wait(ms) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          wake = null
          resolve()
        }, ms)
        wake = () => {
          clearTimeout(timer)
          wake = null
          resolve()
        }
      })
    },
    wake() {
      wake?.()
    },
  }
}

/** Polls /api/auth/device/token until approved, denied, or expired. Returns the Den session token. */
export async function pollDeviceToken(input: {
  fetcher: Fetch
  apiBaseUrl: string
  authorization: DeviceAuthorization
  waker?: PollWaker
  now?: () => number
  isCancelled?: () => boolean
}): Promise<string> {
  const now = input.now ?? Date.now
  const waker = input.waker ?? timerWaker()
  let intervalMs = input.authorization.intervalMs
  while (now() < input.authorization.expiresAt) {
    await waker.wait(Math.min(intervalMs, Math.max(0, input.authorization.expiresAt - now())))
    if (input.isCancelled?.()) throw new DeviceFlowError("Sign-in was cancelled.")
    const polled = await postPublic(input.fetcher, input.apiBaseUrl, "/api/auth/device/token", {
      grant_type: DEVICE_CODE_GRANT,
      device_code: input.authorization.deviceCode,
      client_id: input.authorization.clientId,
    })
    if (polled.status === 200 && isRecord(polled.body) && typeof polled.body.access_token === "string") {
      return polled.body.access_token
    }
    const error = errorCode(polled.body)
    if (error === "authorization_pending") continue
    if (error === "slow_down") {
      intervalMs += 5_000
      continue
    }
    if (error === "access_denied") throw new DeviceFlowError("Sign-in was denied in the browser.")
    if (error === "expired_token") break
    throw new DeviceFlowError(`OpenWork sign-in failed (${polled.status}${error ? `: ${error}` : ""}).`)
  }
  throw new DeviceFlowError("The sign-in code expired before it was approved. Run the sign-in again.")
}
