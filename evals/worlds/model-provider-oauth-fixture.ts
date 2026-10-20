import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";

export const fixtureOAuthClientId = "fixture-client.apps.googleusercontent.com";
export const fixtureOAuthClientSecret = "synthetic-loopback-client-secret";
const scopes = "openid email https://www.googleapis.com/auth/cloud-platform";

/** Full authorization-code + PKCE + signed OIDC provider, not a ready-state stub.
 * Production token/identity verification still runs. Only the external HTTP
 * transport is redirected to this loopback service in the owned Den process. */
export async function modelProviderOAuthFixture(preloadPath: string) {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...keys.publicKey.export({ format: "jwk" }), kid: "fixture-google-key", use: "sig", alg: "RS256" };
  const attempts = new Map<string, { redirectUri: string; state: string; nonce: string; challenge: string; clientId: string }>();
  const codes = new Map<string, NonNullable<ReturnType<typeof attempts.get>>>();
  const witness = { authorizations: 0, approvals: 0, tokenExchanges: 0, jwksReads: 0, rejectedExchanges: 0, unexpectedRequests: 0 };
  const provider = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const json = (status: number, body: unknown) => { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(body)); };
    if (request.method === "GET" && url.pathname === "/authorize") {
      const value = { redirectUri: url.searchParams.get("redirect_uri") ?? "", state: url.searchParams.get("state") ?? "",
        nonce: url.searchParams.get("nonce") ?? "", challenge: url.searchParams.get("code_challenge") ?? "", clientId: url.searchParams.get("client_id") ?? "" };
      if (!value.redirectUri.startsWith("http://127.0.0.1:") || !value.state || !value.nonce || !value.challenge
        || value.clientId !== fixtureOAuthClientId || url.searchParams.get("code_challenge_method") !== "S256") return json(400, { error: "invalid_authorization_request" });
      const id = randomBytes(16).toString("hex"); attempts.set(id, value); witness.authorizations++;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(`<!doctype html><html><body><main><h1>Loopback provider consent</h1><p>This isolated fixture verifies the authorization code, PKCE and signed identity.</p><form method="post" action="/approve?attempt=${id}"><button type="submit">Approve fixture access</button></form></main></body></html>`);
      return;
    }
    if (request.method === "POST" && url.pathname === "/approve") {
      const id = url.searchParams.get("attempt") ?? ""; const attempt = attempts.get(id);
      if (!attempt) return json(400, { error: "invalid_attempt" });
      attempts.delete(id); const code = randomBytes(24).toString("base64url"); codes.set(code, attempt); witness.approvals++;
      const redirect = new URL(attempt.redirectUri); redirect.searchParams.set("state", attempt.state); redirect.searchParams.set("code", code);
      response.writeHead(302, { location: redirect.toString(), "cache-control": "no-store" }); response.end(); return;
    }
    if (request.method === "POST" && url.pathname === "/token") {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const parameters = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const code = parameters.get("code") ?? ""; const attempt = codes.get(code);
      const challenge = createHash("sha256").update(parameters.get("code_verifier") ?? "").digest("base64url");
      if (!attempt || parameters.get("grant_type") !== "authorization_code" || parameters.get("client_id") !== attempt.clientId
        || parameters.get("client_secret") !== fixtureOAuthClientSecret || parameters.get("redirect_uri") !== attempt.redirectUri || challenge !== attempt.challenge) {
        witness.rejectedExchanges++; return json(400, { error: "invalid_grant" });
      }
      codes.delete(code); witness.tokenExchanges++;
      const now = Math.floor(Date.now() / 1000);
      const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: jwk.kid, typ: "JWT" })).toString("base64url");
      const claims = Buffer.from(JSON.stringify({ iss: "https://accounts.google.com", aud: attempt.clientId, sub: "loopback-provider-member",
        email: "provider-member@example.test", email_verified: true, nonce: attempt.nonce, iat: now - 1, exp: now + 3600 })).toString("base64url");
      const signature = sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), keys.privateKey).toString("base64url");
      return json(200, { access_token: `fixture-access-${randomBytes(16).toString("hex")}`, refresh_token: `fixture-refresh-${randomBytes(16).toString("hex")}`,
        token_type: "Bearer", expires_in: 3600, scope: scopes, id_token: `${header}.${claims}.${signature}` });
    }
    if (request.method === "GET" && url.pathname === "/jwks") { witness.jwksReads++; return json(200, { keys: [jwk] }); }
    if (request.method === "POST" && url.pathname === "/revoke") return json(200, {});
    witness.unexpectedRequests++; return json(404, { error: "unexpected_fixture_request" });
  });
  provider.listen(0, "127.0.0.1"); await once(provider, "listening");
  const address = provider.address(); if (!address || typeof address === "string") throw new Error("Loopback provider did not bind TCP");
  const origin = `http://127.0.0.1:${address.port}`;
  // Node --import is a process-local HTTP transport seam. It does not replace
  // OAuth functions, credentials, host outcomes, native models or app stores.
  await writeFile(preloadPath, `const originalFetch=globalThis.fetch;\nconst origin=${JSON.stringify(origin)};\nconst paths=new Map([["https://oauth2.googleapis.com/token","/token"],["https://www.googleapis.com/oauth2/v3/certs","/jwks"],["https://oauth2.googleapis.com/revoke","/revoke"]]);\nglobalThis.fetch=(input,init)=>{const request=new Request(input,init);const path=paths.get(request.url);return originalFetch(path?new Request(origin+path,request):request);};\n`, { mode: 0o600 });
  return { origin, witness: () => ({ ...witness }),
    authorizationRedirect(url: URL) { const target = new URL("/authorize", origin); target.search = url.search; return target.toString(); },
    async [Symbol.asyncDispose]() { provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); },
  };
}
