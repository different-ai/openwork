import { rawRequest } from "./api.ts"
import { CliError, type Io } from "./io.ts"
import { field } from "./json.ts"

const DEVICE_CLIENT_ID = "openwork-cli"
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"

function retryAfterMs(value: string | null): number {
  const seconds = value && /^\d+$/.test(value.trim()) ? Number(value.trim()) : 0
  return Math.min(seconds, 3600) * 1000
}

/**
 * OAuth 2.0 Device Authorization Grant (RFC 8628): show a link and a one-time
 * code on stderr, then poll until the person approves or denies it in the
 * browser, or the code expires. No password reaches this command.
 */
export async function deviceLogin(io: Io, baseUrl: string, json: boolean): Promise<{ accessToken: string; expiresAt: string | null }> {
  const started = await rawRequest(io, baseUrl, "/api/auth/device/code", { method: "POST", body: { client_id: DEVICE_CLIENT_ID } })
  const deviceCode = field(started.body, "device_code")
  const userCode = field(started.body, "user_code")
  if (started.status !== 200 || typeof deviceCode !== "string" || typeof userCode !== "string") {
    throw new CliError("sign_in_failed", `${baseUrl} did not start a sign-in (status ${started.status}).`, started.body)
  }
  const link = field(started.body, "verification_uri_complete") ?? field(started.body, "verification_uri")
  const displayCode = userCode.length === 8 ? `${userCode.slice(0, 4)}-${userCode.slice(4)}` : userCode
  const expiresIn = Number(field(started.body, "expires_in")) || 900
  let intervalMs = Math.max(1, Number(field(started.body, "interval")) || 5) * 1000
  const deadline = Date.now() + expiresIn * 1000

  io.err(json
    ? JSON.stringify({ event: "device_authorization", verification_uri: link, user_code: displayCode, expires_in: expiresIn })
    : `Open this link to sign in:\n\n  ${String(link)}\n\nand confirm the code ${displayCode}. Waiting for approval...`)

  let delayMs = intervalMs
  while (Date.now() + delayMs < deadline) {
    await io.sleep(delayMs)
    const polled = await rawRequest(io, baseUrl, "/api/auth/device/token", {
      method: "POST",
      body: { grant_type: DEVICE_CODE_GRANT, device_code: deviceCode, client_id: DEVICE_CLIENT_ID },
    })
    const accessToken = field(polled.body, "access_token")
    if (polled.status === 200 && typeof accessToken === "string") {
      const lifetime = Number(field(polled.body, "expires_in"))
      return { accessToken, expiresAt: Number.isFinite(lifetime) && lifetime > 0 ? new Date(Date.now() + lifetime * 1000).toISOString() : null }
    }
    const error = field(polled.body, "error")
    if (error === "access_denied") throw new CliError("sign_in_denied", "The sign-in was denied in the browser.")
    if (error === "expired_token") break
    if (polled.status === 429 || error === "slow_down") {
      intervalMs += 5000
      delayMs = Math.max(intervalMs, retryAfterMs(polled.headers.get("retry-after")), retryAfterMs(polled.headers.get("x-retry-after")))
      continue
    }
    delayMs = intervalMs
    if (error === "authorization_pending") continue
    throw new CliError("sign_in_failed", `Sign-in failed (status ${polled.status}).`, polled.body)
  }
  throw new CliError("sign_in_expired", "The code expired before it was approved. Run `openwork auth login` again.")
}
