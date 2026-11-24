import { execFile } from "node:child_process";
import { createHash, createSign, generateKeyPairSync, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A stand-in for Microsoft Entra ID's v2.0 endpoints for one tenant and one
 * app registration: the authorize page, the token endpoint (authorization
 * code with PKCE, and refresh) and the tenant's signing keys. It issues
 * Entra-shaped v2 access and ID tokens signed with its own key.
 *
 * It is not Microsoft. It proves what OpenWork sends to Entra ID and that a
 * relying party validates the tokens against published keys, never that a
 * real tenant issues them.
 *
 * Product code only ever talks to https://login.microsoftonline.com. A world
 * points that one host here from the outside: Node processes through
 * `egressEnv` (an HTTPS proxy plus a certificate they are told to trust), and
 * a browser by answering its requests with `respond`.
 */

export const ENTRA_LOGIN_HOST = "login.microsoftonline.com";
const ENTRA_LOGIN_ORIGIN = `https://${ENTRA_LOGIN_HOST}`;
const ACCESS_TOKEN_SECONDS = 3_600;
const MAX_BODY_BYTES = 64 * 1_024;

export interface EntraStandInAccount {
  /** Entra object id (`oid`): the stable identity a relying party maps to its own user. */
  objectId: string;
  userName: string;
  displayName: string;
}

export interface EntraStandInRequest {
  method: string;
  /** Absolute URL, or a path on the login host. */
  url: string;
  body?: string;
}

export interface EntraStandInResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface EntraStandInTokenRequest {
  grantType: string;
  scope: string;
  clientAuthenticated: boolean;
  /** Whether the PKCE verifier matched the challenge; null for a refresh. */
  pkceVerified: boolean | null;
  account: string | null;
  status: number;
}

export interface EntraStandInIssuedToken {
  account: string;
  /** The access token's `uti` claim: names the token without holding it. */
  tokenId: string;
  grantType: "authorization_code" | "refresh_token";
}

export interface EntraStandInMintOptions {
  audience?: string;
  issuer?: string;
  expiresInSeconds?: number;
  /** Sign with a key the tenant never published. */
  foreignKey?: boolean;
  objectId?: string;
}

export interface EntraStandIn extends AsyncDisposable {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** The API scope the app registration exposes, e.g. api://<client id>/access. */
  apiScope: string;
  /** `iss` of every token: the tenant's v2.0 issuer on the real login host. */
  issuer: string;
  accounts: Record<string, EntraStandInAccount>;
  /** The tenant's signing keys over plain HTTP, for a relying party that reaches this computer as `host`. */
  jwksUrl(host?: string): string;
  /** Environment that sends a Node process's requests for the login host here; everything else is tunnelled untouched. */
  egressEnv: Record<string, string>;
  /** Answer a browser request for the login host. */
  respond(request: EntraStandInRequest): EntraStandInResponse;
  /** What an administrator does under Authentication > Web > Redirect URIs. */
  addRedirectUri(uri: string): void;
  /** An access token for one account, or a deliberately wrong one, to probe a relying party directly. */
  mintAccessToken(account: string, options?: EntraStandInMintOptions): string;
  tokenRequests(): EntraStandInTokenRequest[];
  issuedTokens(): EntraStandInIssuedToken[];
}

interface SigningKey {
  kid: string;
  privateKey: KeyObject;
  jwk: Record<string, unknown>;
}

interface PendingAuthorization {
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
  scope: string;
}

interface AuthorizationCode extends PendingAuthorization {
  account: string;
}

function signingKey(): SigningKey {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2_048 });
  const kid = randomBytes(12).toString("base64url");
  return { kid, privateKey, jwk: { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" } };
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signJwt(key: SigningKey, claims: Record<string, unknown>): string {
  const body = `${encode({ typ: "JWT", alg: "RS256", kid: key.kid })}.${encode(claims)}`;
  return `${body}.${createSign("RSA-SHA256").update(body).sign(key.privateKey).toString("base64url")}`;
}

function sameText(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function page(title: string, content: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; background: #f3f4f6; color: #111827; font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  .banner { max-width: 440px; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 8px; background: #fff; color: #374151; font-size: 13px; }
  main { width: 440px; max-width: calc(100vw - 32px); box-sizing: border-box; padding: 36px 40px; background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; }
  h1 { margin: 0 0 4px; font-size: 22px; font-weight: 600; }
  p { margin: 0 0 20px; color: #4b5563; }
  a.account { display: flex; flex-direction: column; gap: 2px; padding: 12px 14px; margin-top: 8px; border: 1px solid #e5e7eb; border-radius: 8px; color: inherit; text-decoration: none; }
  a.account:hover, a.account:focus-visible { background: #f9fafb; border-color: #9ca3af; outline: none; }
  a.account span { color: #6b7280; font-size: 13px; }
  code { font-size: 12px; word-break: break-all; }
</style></head><body>
<div class="banner" data-testid="entra-stand-in-banner">Test identity provider standing in for Microsoft Entra ID. This page is not Microsoft.</div>
<main>${content}</main></body></html>`;
}

function html(status: number, title: string, content: string): EntraStandInResponse {
  return { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }, body: page(title, content) };
}

function json(status: number, value: unknown): EntraStandInResponse {
  return { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, body: JSON.stringify(value) };
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 30_000 }, (error, _stdout, stderr) => {
      if (error) reject(new Error(`${command} failed: ${error.message}\n${stderr}`));
      else resolve();
    });
  });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The Entra stand-in did not bind a TCP port.");
  return address.port;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

export async function startEntraStandIn(input: { accounts: Record<string, { userName: string; displayName: string }>; appName?: string }): Promise<EntraStandIn> {
  const tenantId = randomUUID();
  const clientId = randomUUID();
  const clientSecret = randomBytes(30).toString("base64url");
  const apiScope = `api://${clientId}/access`;
  const issuer = `${ENTRA_LOGIN_ORIGIN}/${tenantId}/v2.0`;
  const appName = input.appName ?? "OpenWork model access";
  const key = signingKey();
  const foreign = { ...signingKey(), kid: key.kid };
  const accounts: Record<string, EntraStandInAccount> = Object.fromEntries(
    Object.entries(input.accounts).map(([name, account]) => [name, { ...account, objectId: randomUUID() }]),
  );
  const redirectUris = new Set<string>();
  const pending = new Map<string, PendingAuthorization>();
  const codes = new Map<string, AuthorizationCode>();
  const refreshTokens = new Map<string, string>();
  const tokenRequests: EntraStandInTokenRequest[] = [];
  const issuedTokens: EntraStandInIssuedToken[] = [];
  const base = `/${tenantId}`;

  function accessToken(name: string, options: EntraStandInMintOptions = {}): { token: string; tokenId: string } {
    const account = accounts[name];
    if (!account) throw new Error(`The Entra stand-in has no account ${JSON.stringify(name)}.`);
    const now = Math.floor(Date.now() / 1_000);
    const tokenId = randomBytes(16).toString("base64url");
    const objectId = options.objectId ?? account.objectId;
    const token = signJwt(options.foreignKey ? foreign : key, {
      aud: options.audience ?? clientId, iss: options.issuer ?? issuer, iat: now, nbf: now, exp: now + (options.expiresInSeconds ?? ACCESS_TOKEN_SECONDS),
      azp: clientId, azpacr: "1", name: account.displayName, oid: objectId, preferred_username: account.userName,
      scp: "access", sub: createHash("sha256").update(`${clientId}:${objectId}`).digest("base64url"), tid: tenantId, uti: tokenId, ver: "2.0",
    });
    return { token, tokenId };
  }

  function tokens(name: string, grantType: "authorization_code" | "refresh_token", nonce: string | null) {
    const account = accounts[name];
    if (!account) throw new Error(`The Entra stand-in has no account ${JSON.stringify(name)}.`);
    const access = accessToken(name);
    const refreshToken = `standin-refresh.${randomBytes(48).toString("base64url")}`;
    refreshTokens.set(refreshToken, name);
    issuedTokens.push({ account: name, tokenId: access.tokenId, grantType });
    const now = Math.floor(Date.now() / 1_000);
    const idToken = nonce === null ? null : signJwt(key, {
      aud: clientId, iss: issuer, iat: now, nbf: now, exp: now + ACCESS_TOKEN_SECONDS, name: account.displayName, nonce, oid: account.objectId,
      preferred_username: account.userName, sub: createHash("sha256").update(`${clientId}:${account.objectId}`).digest("base64url"), tid: tenantId, ver: "2.0",
    });
    return { token_type: "Bearer", scope: apiScope, expires_in: ACCESS_TOKEN_SECONDS, ext_expires_in: ACCESS_TOKEN_SECONDS, access_token: access.token,
      refresh_token: refreshToken, ...(idToken ? { id_token: idToken } : {}) };
  }

  function authorize(url: URL): EntraStandInResponse {
    const query = url.searchParams;
    if (query.get("client_id") !== clientId) {
      return html(400, "Sign in", `<h1>Sorry, we can't sign you in</h1><p>AADSTS700016: Application was not found in the directory.</p>`);
    }
    const redirectUri = query.get("redirect_uri") ?? "";
    if (!redirectUris.has(redirectUri)) {
      return html(400, "Sign in", `<h1>Sorry, we can't sign you in</h1><p>AADSTS50011: The redirect URI specified in the request does not match the redirect URIs configured for the application.</p><code>${escapeHtml(redirectUri)}</code>`);
    }
    const scope = query.get("scope") ?? "";
    const state = query.get("state") ?? "";
    const nonce = query.get("nonce") ?? "";
    const codeChallenge = query.get("code_challenge") ?? "";
    if (query.get("response_type") !== "code" || query.get("code_challenge_method") !== "S256" || !codeChallenge || !state || !nonce
      || !scope.split(/\s+/).includes(apiScope)) {
      return html(400, "Sign in", `<h1>Sorry, we can't sign you in</h1><p>AADSTS900144: The request is missing a required parameter or asks for a scope this application does not expose.</p>`);
    }
    const request = randomBytes(24).toString("base64url");
    pending.set(request, { redirectUri, state, nonce, codeChallenge, scope });
    const choices = Object.entries(accounts).map(([name, account]) =>
      `<a class="account" data-testid="entra-account-${escapeHtml(name)}" href="${base}/oauth2/v2.0/authorize/complete?request=${request}&amp;account=${encodeURIComponent(name)}">${escapeHtml(account.displayName)}<span>${escapeHtml(account.userName)}</span></a>`).join("");
    return html(200, "Sign in to your account", `<h1>Pick an account</h1><p>to continue to ${escapeHtml(appName)}</p>${choices}`);
  }

  function completeAuthorization(url: URL): EntraStandInResponse {
    const request = url.searchParams.get("request") ?? "";
    const name = url.searchParams.get("account") ?? "";
    const authorization = pending.get(request);
    if (!authorization || !accounts[name]) return html(400, "Sign in", `<h1>Sorry, we can't sign you in</h1><p>This sign-in request is no longer valid. Start again.</p>`);
    pending.delete(request);
    const code = `standin-code.${randomBytes(32).toString("base64url")}`;
    codes.set(code, { ...authorization, account: name });
    const location = new URL(authorization.redirectUri);
    location.searchParams.set("code", code);
    location.searchParams.set("state", authorization.state);
    return { status: 302, headers: { location: location.toString(), "cache-control": "no-store" }, body: "" };
  }

  function token(body: string): EntraStandInResponse {
    const form = new URLSearchParams(body);
    const grantType = form.get("grant_type") ?? "";
    const scope = form.get("scope") ?? "";
    const clientAuthenticated = form.get("client_id") === clientId && sameText(form.get("client_secret") ?? "", clientSecret);
    const answer = (status: number, value: unknown, facts: { pkceVerified: boolean | null; account: string | null }) => {
      tokenRequests.push({ grantType, scope, clientAuthenticated, status, ...facts });
      return json(status, value);
    };
    if (!clientAuthenticated) {
      return answer(401, { error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret provided." }, { pkceVerified: null, account: null });
    }
    if (!scope.split(/\s+/).includes(apiScope)) {
      return answer(400, { error: "invalid_scope", error_description: "AADSTS70011: The provided value for the input parameter 'scope' is not valid." }, { pkceVerified: null, account: null });
    }
    if (grantType === "authorization_code") {
      const code = form.get("code") ?? "";
      const authorization = codes.get(code);
      codes.delete(code);
      const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
      const pkceVerified = Boolean(authorization) && challenge === authorization?.codeChallenge;
      if (!authorization || !pkceVerified || form.get("redirect_uri") !== authorization.redirectUri) {
        return answer(400, { error: "invalid_grant", error_description: "AADSTS70008: The provided authorization code is invalid or was already redeemed." }, { pkceVerified, account: authorization?.account ?? null });
      }
      return answer(200, tokens(authorization.account, "authorization_code", authorization.nonce), { pkceVerified, account: authorization.account });
    }
    if (grantType === "refresh_token") {
      const presented = form.get("refresh_token") ?? "";
      const name = refreshTokens.get(presented);
      if (!name) return answer(400, { error: "invalid_grant", error_description: "AADSTS700082: The refresh token has expired." }, { pkceVerified: null, account: null });
      refreshTokens.delete(presented);
      return answer(200, tokens(name, "refresh_token", null), { pkceVerified: null, account: name });
    }
    return answer(400, { error: "unsupported_grant_type" }, { pkceVerified: null, account: null });
  }

  function respond(request: EntraStandInRequest): EntraStandInResponse {
    const url = new URL(request.url, ENTRA_LOGIN_ORIGIN);
    const path = url.pathname.toLowerCase();
    const method = request.method.toUpperCase();
    if (method === "GET" && path === `${base}/discovery/v2.0/keys`) return json(200, { keys: [key.jwk] });
    if (method === "GET" && path === `${base}/v2.0/.well-known/openid-configuration`) {
      return json(200, {
        issuer, authorization_endpoint: `${ENTRA_LOGIN_ORIGIN}${base}/oauth2/v2.0/authorize`, token_endpoint: `${ENTRA_LOGIN_ORIGIN}${base}/oauth2/v2.0/token`,
        jwks_uri: `${ENTRA_LOGIN_ORIGIN}${base}/discovery/v2.0/keys`, response_types_supported: ["code"], subject_types_supported: ["pairwise"],
        id_token_signing_alg_values_supported: ["RS256"],
      });
    }
    if (method === "GET" && path === `${base}/oauth2/v2.0/authorize`) return authorize(url);
    if (method === "GET" && path === `${base}/oauth2/v2.0/authorize/complete`) return completeAuthorization(url);
    if (method === "POST" && path === `${base}/oauth2/v2.0/token`) return token(request.body ?? "");
    return json(404, { error: "not_found" });
  }

  const serve = (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    request.on("end", () => {
      const answer = size > MAX_BODY_BYTES
        ? json(413, { error: "request_too_large" })
        : respond({ method: request.method ?? "GET", url: request.url ?? "/", body: Buffer.concat(chunks).toString("utf8") });
      response.writeHead(answer.status, { ...answer.headers, "content-length": String(Buffer.byteLength(answer.body)) }).end(answer.body);
    });
  };

  const directory = await mkdtemp(join(tmpdir(), "openwork-entra-stand-in-"));
  const keyPath = join(directory, "login-host-key.pem");
  const certificatePath = join(directory, "login-host-certificate.pem");
  let plain: Server | undefined;
  let secure: Server | undefined;
  try {
    // One self-signed certificate for the login host; only processes handed egressEnv trust it.
    await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certificatePath, "-days", "2",
      "-subj", `/CN=${ENTRA_LOGIN_HOST}`, "-addext", `subjectAltName=DNS:${ENTRA_LOGIN_HOST}`]);
    const securePort = await listen(secure = createHttpsServer({ key: await readFile(keyPath), cert: await readFile(certificatePath) }, serve));
    plain = createHttpServer(serve);
    // The same listener is the HTTPS proxy: the login host lands here, every other host is tunnelled as asked.
    plain.on("connect", (request: IncomingMessage, socket, head: Buffer) => {
      const [host = "", port = "443"] = (request.url ?? "").split(":");
      const upstream = host.toLowerCase() === ENTRA_LOGIN_HOST ? connect(securePort, "127.0.0.1") : connect(Number(port), host);
      upstream.once("connect", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
    });
    const plainPort = await listen(plain);
    const servers = [plain, secure];
    return {
      tenantId, clientId, clientSecret, apiScope, issuer, accounts, respond,
      jwksUrl: (host = "127.0.0.1") => `http://${host}:${plainPort}${base}/discovery/v2.0/keys`,
      egressEnv: {
        NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: `http://127.0.0.1:${plainPort}`, NO_PROXY: "127.0.0.1,localhost,::1", NODE_EXTRA_CA_CERTS: certificatePath,
      },
      addRedirectUri: (uri) => { redirectUris.add(uri); },
      mintAccessToken: (account, options) => accessToken(account, options).token,
      tokenRequests: () => tokenRequests.map((entry) => ({ ...entry })),
      issuedTokens: () => issuedTokens.map((entry) => ({ ...entry })),
      async [Symbol.asyncDispose]() {
        await Promise.all(servers.map(close));
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await Promise.all([plain, secure].flatMap((server) => server ? [close(server)] : []));
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
