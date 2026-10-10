import { WORKBOT_OAUTH_CLIENT_ID, WORKBOT_OAUTH_SCOPES, workbotOrigin, workbotRedirectUri } from "./config.js"

type ClientRow = { redirectUris?: unknown; skipConsent?: unknown; disabled?: unknown }
type Adapter = {
  findOne<T>(input: { model: string; where: Array<{ field: string; value: string }> }): Promise<T | null>
  create(input: { model: string; data: Record<string, unknown> }): Promise<unknown>
  update(input: { model: string; where: Array<{ field: string; value: string }>; update: Record<string, unknown> }): Promise<unknown>
}

function sameList(stored: unknown, expected: readonly string[]) {
  const list = typeof stored === "string" ? safeJson(stored) : stored
  return Array.isArray(list) && list.length === expected.length && expected.every((value, index) => list[index] === value)
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * Keeps Den's first-party Workbot client in step with DEN_WORKBOT_URL: created on the first sign-in, its return
 * address updated when the URL changes. A public client (PKCE, no secret) that skips the consent screen, since
 * Workbot is part of OpenWork. Without DEN_WORKBOT_URL nothing is created, so Workbot can't sign in.
 */
export async function ensureWorkbotOAuthClient(adapter: Adapter, env: Record<string, string | undefined> = process.env) {
  const origin = workbotOrigin(env)
  if (!origin) return
  const redirectUris = [workbotRedirectUri(origin)]
  const where = [{ field: "clientId", value: WORKBOT_OAUTH_CLIENT_ID }]
  const existing = await adapter.findOne<ClientRow>({ model: "oauthClient", where })
  if (!existing) {
    await adapter.create({
      model: "oauthClient",
      data: {
        clientId: WORKBOT_OAUTH_CLIENT_ID,
        name: "Workbot",
        uri: origin,
        redirectUris,
        scopes: [...WORKBOT_OAUTH_SCOPES],
        grantTypes: ["authorization_code", "refresh_token"],
        responseTypes: ["code"],
        tokenEndpointAuthMethod: "none",
        public: true,
        requirePKCE: true,
        skipConsent: true,
        disabled: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    })
    return
  }
  if (!sameList(existing.redirectUris, redirectUris) || existing.skipConsent !== true || existing.disabled === true) {
    await adapter.update({ model: "oauthClient", where, update: { redirectUris, uri: origin, skipConsent: true, disabled: false, updatedAt: new Date() } })
  }
}
