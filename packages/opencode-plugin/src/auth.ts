/**
 * The `openwork` integration's sign-in methods. OpenCode runs them for
 * `opencode auth login openwork` and the TUI's `/connect`, then stores the
 * returned credential in its own credential store, where the plugin reads it.
 */
import { DenAuthError, readAccount, readMe, type Fetch } from "./den.ts"
import { pollDeviceToken, startDeviceAuthorization, timerWaker, type DeviceAuthorization } from "./device.ts"
import { startReturnPage } from "./loopback.ts"
import type { OAuthAuthorization, OAuthCredential, OAuthMethodRegistration } from "./opencode.ts"

export const INTEGRATION_ID = "openwork"
export const INTEGRATION_NAME = "OpenWork Cloud"
export const BROWSER_METHOD_ID = "browser"

/** Used when Den does not report the session's expiry; Den sessions last 7 days and slide on use. */
const FALLBACK_SESSION_MS = 6 * 24 * 60 * 60 * 1000
/** After a transient refresh failure, try again soon without blocking the still-valid token. */
const RETRY_REFRESH_MS = 15 * 60 * 1000

export interface CredentialMetadata {
  readonly apiBaseUrl: string
  readonly orgId: string | null
  readonly orgName: string | null
  readonly orgSlug: string | null
  readonly email: string
  readonly deviceClientId: string
}

export function readCredentialMetadata(credential: OAuthCredential, fallbackApiBaseUrl: string): CredentialMetadata {
  const metadata = credential.metadata ?? {}
  const text = (key: string) => (typeof metadata[key] === "string" && metadata[key] ? String(metadata[key]) : null)
  return {
    apiBaseUrl: text("apiBaseUrl") ?? fallbackApiBaseUrl,
    orgId: text("orgId"),
    orgName: text("orgName"),
    orgSlug: text("orgSlug"),
    email: text("email") ?? "",
    deviceClientId: text("deviceClientId") ?? "",
  }
}

export function credentialLabel(credential: OAuthCredential): string | undefined {
  const metadata = credential.metadata ?? {}
  const email = typeof metadata.email === "string" ? metadata.email : ""
  const org = typeof metadata.orgName === "string" ? metadata.orgName : ""
  const label = [email, org].filter(Boolean).join(" · ")
  return label || undefined
}

async function finish(input: {
  fetcher: Fetch
  apiBaseUrl: string
  methodID: string
  authorization: DeviceAuthorization
  wait: (ms: number) => Promise<void>
  now: () => number
}): Promise<OAuthCredential> {
  const token = await pollDeviceToken({
    fetcher: input.fetcher,
    apiBaseUrl: input.apiBaseUrl,
    authorization: input.authorization,
    waker: { wait: input.wait },
    now: input.now,
  })
  const account = await readAccount(input.fetcher, { apiBaseUrl: input.apiBaseUrl, token, orgId: null })
  const metadata: CredentialMetadata = {
    apiBaseUrl: input.apiBaseUrl,
    orgId: account.orgId,
    orgName: account.orgName,
    orgSlug: account.orgSlug,
    email: account.email,
    deviceClientId: input.authorization.clientId,
  }
  return {
    type: "oauth",
    methodID: input.methodID,
    // Den device sessions have no refresh token; `refresh` re-validates the session itself.
    access: token,
    refresh: token,
    expires: account.sessionExpiresAt ?? input.now() + FALLBACK_SESSION_MS,
    metadata: { ...metadata },
  }
}

export function withReturnTo(verificationUriComplete: string, returnTo: string): string {
  const url = new URL(verificationUriComplete)
  url.searchParams.set("return_to", returnTo)
  return url.toString()
}

export function signInMethods(input: {
  fetcher: Fetch
  apiBaseUrl: () => string
  now?: () => number
}): OAuthMethodRegistration[] {
  const now = input.now ?? Date.now

  const refresh = async (credential: OAuthCredential): Promise<OAuthCredential> => {
    const metadata = readCredentialMetadata(credential, input.apiBaseUrl())
    try {
      // Any authenticated request slides the Den session; /v1/me also reports its new expiry.
      const me = await readMe(input.fetcher, { apiBaseUrl: metadata.apiBaseUrl, token: credential.access, orgId: metadata.orgId })
      return { ...credential, expires: me.sessionExpiresAt ?? now() + FALLBACK_SESSION_MS }
    } catch (error) {
      // The session is gone: fail, so the plugin asks the member to sign in again.
      if (error instanceof DenAuthError) throw error
      return { ...credential, expires: now() + RETRY_REFRESH_MS }
    }
  }

  /**
   * The only sign-in method, so `opencode auth login openwork` and `/connect`
   * start it without asking. It works the same on SSH or a headless machine:
   * open the link on any device and approve; the terminal finishes by polling,
   * and the browser's return to this machine simply has nowhere to land.
   */
  const browser: OAuthMethodRegistration = {
    integrationID: INTEGRATION_ID,
    method: { id: BROWSER_METHOD_ID, type: "oauth", label: "Browser" },
    async authorize(): Promise<OAuthAuthorization> {
      const apiBaseUrl = input.apiBaseUrl()
      const authorization = await startDeviceAuthorization({ fetcher: input.fetcher, apiBaseUrl, now })
      const waker = timerWaker()
      // The return page only wakes the poll; the token still arrives by polling Den.
      // Without a free loopback port, sign-in still works, just without the redirect.
      const page = await startReturnPage(() => waker.wake()).catch(() => null)
      const callback = finish({ fetcher: input.fetcher, apiBaseUrl, methodID: BROWSER_METHOD_ID, authorization, wait: waker.wait, now })
      if (page) {
        // Keep the page up briefly after the poll settles so the redirect still lands on it.
        const closeLater = () => setTimeout(() => page.close(), 30_000).unref()
        callback.then(closeLater, closeLater)
      }
      return {
        mode: "auto",
        url: page ? withReturnTo(authorization.verificationUriComplete, page.url) : authorization.verificationUriComplete,
        instructions: `Sign in to OpenWork in your browser and confirm the code ${authorization.userCode}`,
        expiresAt: authorization.expiresAt,
        callback,
      }
    },
    refresh,
    label: credentialLabel,
  }

  return [browser]
}
