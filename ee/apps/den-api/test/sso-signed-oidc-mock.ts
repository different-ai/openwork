import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { createServer } from "node:http"
import { exportJWK, generateKeyPair, SignJWT } from "jose"

export type OidcTokenFailure = "signature" | "audience" | "issuer" | "expired"

// Ephemeral keys are shared only within this test process; no real IdP or keys.
const signingKeys = generateKeyPair("RS256")
const wrongSigningKeys = generateKeyPair("RS256")

export async function startSignedOidcMock(options: {
  profile: Record<string, unknown>
  redirectURI: string
  tokenFailure?: OidcTokenFailure
  tokenIssuer?: string
  beforeToken?: () => void
}) {
  const [{ privateKey, publicKey }, wrongKeys] = await Promise.all([signingKeys, wrongSigningKeys])
  const jwk = { ...await exportJWK(publicKey), kid: "synthetic-key", alg: "RS256", use: "sig" }
  const clientId = "synthetic-oidc-client"
  const clientSecret = "synthetic-oidc-secret"
  const accessToken = randomUUID()
  const codes = new Map<string, { redirectURI: string; challenge: string; nonce: string | null }>()
  const requests = { authorize: 0, token: 0, userinfo: 0, jwks: 0 }
  const errors: unknown[] = []
  let issuer = ""

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", issuer)
      if (url.pathname === "/authorize" && request.method === "GET") {
        requests.authorize++
        assert.equal(url.searchParams.get("client_id"), clientId)
        assert.equal(url.searchParams.get("response_type"), "code")
        assert.equal(url.searchParams.get("redirect_uri"), options.redirectURI)
        assert.equal(url.searchParams.get("code_challenge_method"), "S256")
        const state = url.searchParams.get("state")
        const challenge = url.searchParams.get("code_challenge")
        assert.ok(state)
        assert.ok(challenge)
        const code = randomUUID()
        codes.set(code, { redirectURI: options.redirectURI, challenge, nonce: url.searchParams.get("nonce") })
        const callback = new URL(options.redirectURI)
        callback.searchParams.set("code", code)
        callback.searchParams.set("state", state)
        response.writeHead(302, { location: callback.toString() }).end()
        return
      }
      if (url.pathname === "/token" && request.method === "POST") {
        requests.token++
        request.setEncoding("utf8")
        let encodedBody = ""
        for await (const chunk of request) {
          assert.equal(typeof chunk, "string")
          encodedBody += chunk
        }
        const body = new URLSearchParams(encodedBody)
        assert.equal(body.get("grant_type"), "authorization_code")
        assert.equal(body.get("client_id"), clientId)
        assert.equal(body.get("client_secret"), clientSecret)
        const code = body.get("code")
        assert.ok(code)
        const authorization = codes.get(code)
        assert.ok(authorization, "token exchange requires an unused authorization code")
        codes.delete(code)
        assert.equal(body.get("redirect_uri"), authorization.redirectURI)
        const verifier = body.get("code_verifier")
        assert.ok(verifier)
        assert.equal(createHash("sha256").update(verifier).digest("base64url"), authorization.challenge)
        options.beforeToken?.()
        const idToken = await new SignJWT({
          ...options.profile,
          ...(authorization.nonce ? { nonce: authorization.nonce } : {}),
        })
          .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
          .setIssuer(options.tokenFailure === "issuer" ? `${issuer}/wrong-issuer` : options.tokenIssuer ?? issuer)
          .setAudience(options.tokenFailure === "audience" ? "another-client" : clientId)
          .setIssuedAt()
          .setExpirationTime(options.tokenFailure === "expired" ? "-1m" : "5m")
          .sign(options.tokenFailure === "signature" ? wrongKeys.privateKey : privateKey)
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          access_token: accessToken,
          token_type: "Bearer",
          expires_in: 300,
          scope: "openid email profile",
          id_token: idToken,
        }))
        return
      }
      if (url.pathname === "/userinfo" && request.method === "GET") {
        requests.userinfo++
        assert.equal(request.headers.authorization, `Bearer ${accessToken}`)
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(options.profile))
        return
      }
      if (url.pathname === "/jwks" && request.method === "GET") {
        requests.jwks++
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ keys: [jwk] }))
        return
      }
      throw new Error(`Unexpected synthetic OIDC request: ${request.method} ${url.pathname}`)
    })().catch((error: unknown) => {
      errors.push(error)
      response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "synthetic_oidc_failure" }))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  issuer = `http://127.0.0.1:${address.port}`

  return {
    issuer,
    requests,
    errors,
    config: {
      issuer,
      clientId,
      clientSecret,
      authorizationEndpoint: `${issuer}/authorize`,
      tokenEndpoint: `${issuer}/token`,
      tokenEndpointAuthentication: "client_secret_post",
      jwksEndpoint: `${issuer}/jwks`,
      pkce: true,
      scopes: ["openid", "email", "profile"],
    },
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
      server.closeAllConnections()
    }),
  }
}
