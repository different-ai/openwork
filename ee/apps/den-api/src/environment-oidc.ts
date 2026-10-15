import type { BetterAuthPlugin } from "better-auth"
import { genericOAuth } from "better-auth/plugins"
import { createRemoteJWKSet, decodeJwt } from "jose"
import { z } from "zod"
import { discoverEnvironmentOidc, type EnvironmentOidcConfig } from "./environment-oidc-config.js"

const identitySchema = z.object({
  sub: z.string().min(1),
  exp: z.number().int(),
  iat: z.number().int(),
  aud: z.union([z.string(), z.array(z.string()).min(1)]),
  azp: z.string().optional(),
  email: z.email(),
  // Never coerce "false" to true, or assume an absent claim means verified.
  email_verified: z.literal(true),
  name: z.string().optional(),
  picture: z.url().optional(),
})

/** Better Auth owns state, PKCE, nonce binding, code exchange and account/session
 * persistence. Validate discovery ourselves: genericOAuth otherwise permits an
 * incomplete document to silently omit signature/issuer/nonce verification.
 */
export function environmentOidcPlugin(config: EnvironmentOidcConfig, authorizeIdentity: (identity: { sub: string; email: string }) => Promise<boolean>): BetterAuthPlugin {
  return {
    id: "environment-oidc",
    init: async (ctx) => {
      // Do not contact an optional IdP when Den boots or serves an existing
      // session. Discovery is lazy, so switching this feature off remains a
      // usable recovery path even while the IdP is unreachable.
      const shellPlugin = genericOAuth({ config: [{
        providerId: config.providerId, clientId: config.clientId,
        clientSecret: config.clientSecret, name: config.name,
      }] })
      const shell = await shellPlugin.init(ctx)
      const shellProvider = shell.context.socialProviders.find((entry) => entry.id === config.providerId)
      if (!shellProvider) throw new Error("OIDC provider initialization failed")
      const initialize = async () => {
        const endpoints = await discoverEnvironmentOidc(config)
        const plugin = genericOAuth({ config: [{
          providerId: config.providerId,
          name: config.name,
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          authorizationUrl: endpoints.authorizationUrl,
          tokenUrl: endpoints.tokenUrl,
          scopes: config.scopes,
          pkce: config.pkce,
          authentication: config.authentication === "client_secret_basic" ? "basic" : "post",
          requireEmailVerification: true,
          getUserInfo: async (tokens) => {
            // The provider below verifies the ID token before this mapper.
            // No access-token/userinfo fallback can bypass the signed assertion.
            if (!tokens.idToken) return null
            const result = identitySchema.safeParse(decodeJwt(tokens.idToken))
            if (!result.success) return null
            if (result.data.azp !== undefined && result.data.azp !== config.clientId) return null
            if (Array.isArray(result.data.aud) && result.data.aud.length > 1 && result.data.azp !== config.clientId) return null
            const identity = { ...result.data, email: result.data.email.trim().toLowerCase() }
            if (!await authorizeIdentity(identity)) return null
            return {
              id: identity.sub,
              email: identity.email,
              emailVerified: true,
              name: identity.name ?? identity.email,
              image: identity.picture,
            }
          },
        }] })
        const initialized = await plugin.init({ ...ctx, socialProviders: ctx.socialProviders.filter((entry) => entry.id !== config.providerId) })
        const provider = initialized.context.socialProviders.find((entry) => entry.id === config.providerId)
        if (!provider) throw new Error("OIDC provider initialization failed")
        provider.issuer = config.issuer
        provider.idToken = {
          jwks: createRemoteJWKSet(new URL(endpoints.jwksUrl), { timeoutDuration: 10_000 }),
          issuer: config.issuer,
          audience: config.clientId,
          algorithms: endpoints.algorithms,
          maxTokenAge: "10m",
        }
        provider.requiresIdTokenNonce = true
        return provider
      }
      let pending: ReturnType<typeof initialize> | undefined
      const getProvider = () => {
        pending ??= initialize().catch((error: unknown) => { pending = undefined; throw error })
        return pending
      }
      shellProvider.issuer = config.issuer
      shellProvider.requiresIdTokenNonce = true
      shellProvider.createAuthorizationURL = async (data) => (await getProvider()).createAuthorizationURL(data)
      shellProvider.validateAuthorizationCode = async (data) => (await getProvider()).validateAuthorizationCode(data)
      shellProvider.getUserInfo = async (tokens) => (await getProvider()).getUserInfo(tokens)
      shellProvider.refreshAccessToken = async (token, context) => {
        const provider = await getProvider()
        if (!provider.refreshAccessToken) throw new Error("OIDC provider cannot refresh tokens")
        return provider.refreshAccessToken(token, context)
      }
      return shell
    },
  }
}
