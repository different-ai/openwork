import { createHash, generateKeyPairSync, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { signOidcJwt } from "../idp.ts";
import { accountChooserPage, consentPage } from "./pages.ts";

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
  redirectUris: readonly string[];
  displayName?: string;
}

export interface OAuthAccount {
  sub: string;
  email: string;
  name: string;
  emailVerified?: boolean;
  picture?: string;
}

export interface OAuthEndpoints {
  authorization: string;
  token: string;
  jwks: string;
  userinfo: string;
  discovery: string;
}

export interface OAuthFaults {
  denyConsent?: boolean;
  expiredCode?: boolean;
  invalidClient?: boolean;
  invalidGrant?: boolean;
  nonceMismatch?: boolean;
  badSignature?: boolean;
}

export interface OAuthProviderConfig {
  clients: readonly OAuthClient[];
  accounts?: readonly OAuthAccount[];
  issuer?: string;
  endpoints?: Partial<OAuthEndpoints>;
  faults?: OAuthFaults;
  now?: () => number;
  codeTtlMs?: number;
  tokenTtlMs?: number;
  interactionTtlMs?: number;
  listen?: { host?: string; port?: number };
}

export interface OAuthWitnessEvent {
  type: "authorize" | "account_selected" | "consent" | "code_issued" | "token" | "userinfo" | "discovery" | "jwks" | "rejected";
  at: number;
  clientId?: string;
  redirectUri?: string;
  sub?: string;
  scope?: string;
  state?: string;
  error?: string;
}

export interface StartedOAuthProvider {
  baseUrl: string;
  issuer: string;
  endpoints: OAuthEndpoints;
  publicEndpoints: OAuthEndpoints;
  events: OAuthWitnessEvent[];
  setFaults(faults: OAuthFaults): void;
  registerClient(client: OAuthClient): void;
  stop(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export const GOOGLE_OAUTH_ENDPOINTS: Readonly<OAuthEndpoints> = {
  authorization: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  jwks: "https://www.googleapis.com/oauth2/v3/certs",
  userinfo: "https://www.googleapis.com/oauth2/v3/userinfo",
  discovery: "https://accounts.google.com/.well-known/openid-configuration",
};

const SELECT_PATH = "/mock-oauth/select";
const CONSENT_PATH = "/mock-oauth/consent";
const defaultAccounts: readonly OAuthAccount[] = [{ sub: "google-eval-user-1", email: "oauth.user@acme.test", name: "OAuth Lab User" }];

interface Interaction {
  clientId: string;
  applicationName: string;
  redirectUri: string;
  state: string | null;
  nonce: string | null;
  scope: string;
  challenge: string | null;
  expiresAt: number;
  account?: OAuthAccount;
}

interface CodeRecord extends Interaction {
  account: OAuthAccount;
  expired: boolean;
}

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function page(response: ServerResponse, document: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    // Do not restrict form-action to self: Chromium applies it to the final
    // OAuth callback redirect as well. Forms here use fixed same-origin actions.
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    "x-content-type-options": "nosniff",
  });
  response.end(document);
}

function redirect(response: ServerResponse, location: string, status = 302): void {
  response.writeHead(status, { location, "cache-control": "no-store" });
  response.end();
}

async function form(request: IncomingMessage): Promise<URLSearchParams> {
  if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/x-www-form-urlencoded") throw new Error("Expected form encoding");
  let body = "";
  for await (const chunk of request) {
    body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (Buffer.byteLength(body) > 16_384) throw new Error("Form too large");
  }
  const params = new URLSearchParams(body);
  if ([...params.keys()].some((key) => params.getAll(key).length !== 1)) throw new Error("Duplicate form parameter");
  return params;
}

function credentials(request: IncomingMessage, params: URLSearchParams): { id: string; secret: string } | null {
  const authorization = request.headers.authorization;
  if (!authorization) return { id: params.get("client_id") ?? "", secret: params.get("client_secret") ?? "" };
  if (!authorization.startsWith("Basic ") || params.has("client_secret")) return null;
  try {
    const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return null;
    const id = decodeURIComponent(decoded.slice(0, separator).replace(/\+/g, " "));
    if (params.has("client_id") && params.get("client_id") !== id) return null;
    return { id, secret: decodeURIComponent(decoded.slice(separator + 1).replace(/\+/g, " ")) };
  } catch {
    return null;
  }
}

/** Dependency-free, loopback-only OAuth/OIDC upstream for real provider flows. */
export async function startOAuthProvider(config: OAuthProviderConfig): Promise<StartedOAuthProvider> {
  const clients = config.clients.map((client) => ({ ...client, redirectUris: [...client.redirectUris] }));
  const accounts = (config.accounts ?? defaultAccounts).map((account) => ({ ...account }));
  if (clients.some((client) => !client.clientId || !client.clientSecret || !client.redirectUris.length)) throw new Error("Register confidential clients with redirect URIs");
  if (new Set(clients.map((client) => client.clientId)).size !== clients.length) throw new Error("Duplicate OAuth client");
  if (!accounts.length || accounts.some((account) => !account.sub || !account.email) || new Set(accounts.map((account) => account.sub)).size !== accounts.length) throw new Error("Accounts require unique subjects and an email");
  function validateClient(client: OAuthClient): void {
    if (!client.clientId || !client.clientSecret || !client.redirectUris.length) throw new Error("Register confidential clients with redirect URIs");
    for (const uri of client.redirectUris) {
      const parsed = new URL(uri);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.hash || parsed.username || parsed.password) throw new Error("Invalid registered redirect URI");
    }
  }
  for (const client of clients) validateClient(client);
  function registerClient(client: OAuthClient): void {
    validateClient(client);
    const copy = { ...client, redirectUris: [...client.redirectUris] };
    const index = clients.findIndex((entry) => entry.clientId === client.clientId);
    if (index < 0) clients.push(copy);
    else clients[index] = copy;
  }
  const host = config.listen?.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") throw new Error("OAuth fixture must listen on loopback");
  const issuer = config.issuer ?? "https://accounts.google.com";
  const publicEndpoints = { ...GOOGLE_OAUTH_ENDPOINTS, ...config.endpoints };
  const paths = Object.fromEntries(Object.entries(publicEndpoints).map(([key, value]) => [key, new URL(value).pathname]));
  if (new Set(Object.values(paths)).size !== 5 || Object.values(paths).some((path) => path === SELECT_PATH || path === CONSENT_PATH)) throw new Error("OAuth endpoint paths must be distinct");
  const now = config.now ?? Date.now;
  const codeTtl = config.codeTtlMs ?? 60_000;
  const tokenTtl = config.tokenTtlMs ?? 300_000;
  const interactionTtl = config.interactionTtlMs ?? 300_000;
  if ([codeTtl, tokenTtl, interactionTtl].some((ttl) => !Number.isFinite(ttl) || ttl <= 0)) throw new Error("OAuth TTLs must be positive");
  let faults = { ...config.faults };
  const events: OAuthWitnessEvent[] = [];
  const witness = (event: Omit<OAuthWitnessEvent, "at">) => events.push({ ...event, at: now() });
  const interactions = new Map<string, Interaction>();
  const codes = new Map<string, CodeRecord>();
  const tokens = new Map<string, { account: OAuthAccount; expiresAt: number }>();
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const badKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyId = `oauth-lab-${randomBytes(8).toString("hex")}`;
  const jwk = { ...keys.publicKey.export({ format: "jwk" }), kid: keyId, use: "sig", alg: "RS256" };
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const badPrivateKeyPem = badKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const reject = (response: ServerResponse, status: number, error: string) => {
    witness({ type: "rejected", error });
    if (status === 401) response.setHeader("www-authenticate", error === "invalid_client" ? 'Basic realm="OAuth lab"' : 'Bearer error="invalid_token"');
    json(response, status, { error });
  };
  const callback = (interaction: Interaction, values: Record<string, string>) => {
    const url = new URL(interaction.redirectUri);
    for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
    if (interaction.state !== null) url.searchParams.set("state", interaction.state);
    return url.toString();
  };
  const profile = (account: OAuthAccount) => ({
    sub: account.sub, email: account.email, email_verified: account.emailVerified ?? true,
    name: account.name, ...(account.picture ? { picture: account.picture } : {}),
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const method = request.method;
    // Remove expired handles without timers or nondeterministic sleeps.
    for (const [id, interaction] of interactions) if (interaction.expiresAt <= now()) interactions.delete(id);
    for (const [token, record] of tokens) if (record.expiresAt <= now()) tokens.delete(token);
    for (const [code, record] of codes) if (record.expiresAt <= now()) codes.delete(code);
    if (url.pathname === paths.discovery && method === "GET") {
      witness({ type: "discovery" });
      json(response, 200, {
        issuer, authorization_endpoint: publicEndpoints.authorization, token_endpoint: publicEndpoints.token,
        jwks_uri: publicEndpoints.jwks, userinfo_endpoint: publicEndpoints.userinfo,
        response_types_supported: ["code"], grant_types_supported: ["authorization_code"],
        subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
        code_challenge_methods_supported: ["S256"], scopes_supported: ["openid", "email", "profile"],
        claims_supported: ["iss", "aud", "sub", "iat", "exp", "nonce", "email", "email_verified", "name", "picture"],
      });
      return;
    }
    if (url.pathname === paths.jwks && method === "GET") {
      witness({ type: "jwks" });
      json(response, 200, { keys: [jwk] });
      return;
    }
    if (url.pathname === paths.authorization && method === "GET") {
      const params = url.searchParams;
      const client = clients.find((entry) => entry.clientId === params.get("client_id"));
      const redirectUri = params.get("redirect_uri") ?? "";
      if ([...params.keys()].some((key) => params.getAll(key).length !== 1) || !client || !client.redirectUris.includes(redirectUri)) return reject(response, 400, "invalid_request");
      if (params.get("response_type") !== "code") return reject(response, 400, "unsupported_response_type");
      const challenge = params.get("code_challenge");
      if ((challenge !== null && (!/^[A-Za-z0-9_-]{43}$/.test(challenge) || params.get("code_challenge_method") !== "S256")) || (challenge === null && params.has("code_challenge_method"))) return reject(response, 400, "invalid_request");
      const interaction: Interaction = {
        clientId: client.clientId, applicationName: client.displayName ?? "OpenWork", redirectUri, scope: params.get("scope") ?? "",
        state: params.get("state"), nonce: params.get("nonce"), challenge, expiresAt: now() + interactionTtl,
      };
      const id = randomBytes(24).toString("base64url");
      interactions.set(id, interaction);
      witness({ type: "authorize", clientId: client.clientId, redirectUri, state: interaction.state ?? undefined, scope: interaction.scope });
      page(response, accountChooserPage({ accounts, interaction: id, applicationName: interaction.applicationName, action: SELECT_PATH }));
      return;
    }
    if (url.pathname === SELECT_PATH && method === "POST") {
      const params = await form(request);
      const id = params.get("interaction") ?? "";
      const interaction = interactions.get(id);
      const account = accounts.find((entry) => entry.sub === params.get("account"));
      if (!interaction || interaction.account || !account) return reject(response, 400, "invalid_request");
      interaction.account = account;
      witness({ type: "account_selected", clientId: interaction.clientId, sub: account.sub });
      redirect(response, `${CONSENT_PATH}?interaction=${encodeURIComponent(id)}`, 303);
      return;
    }
    if (url.pathname === CONSENT_PATH && (method === "GET" || method === "POST")) {
      const params = method === "POST" ? await form(request) : url.searchParams;
      const id = params.get("interaction") ?? "";
      const interaction = interactions.get(id);
      if (!interaction?.account) return reject(response, 400, "invalid_request");
      if (method === "GET") {
        page(response, consentPage({ account: interaction.account, interaction: id, applicationName: interaction.applicationName, scope: interaction.scope, action: CONSENT_PATH }));
        return;
      }
      const decision = params.get("decision");
      if (decision !== "approve" && decision !== "deny") return reject(response, 400, "invalid_request");
      interactions.delete(id);
      const denied = decision === "deny" || faults.denyConsent;
      witness({ type: "consent", clientId: interaction.clientId, sub: interaction.account.sub, ...(denied ? { error: "access_denied" } : {}) });
      if (denied) {
        redirect(response, callback(interaction, { error: "access_denied" }));
        return;
      }
      const code = randomBytes(24).toString("base64url");
      codes.set(code, { ...interaction, account: interaction.account, expiresAt: now() + codeTtl, expired: faults.expiredCode === true });
      witness({ type: "code_issued", clientId: interaction.clientId, sub: interaction.account.sub, redirectUri: interaction.redirectUri });
      redirect(response, callback(interaction, { code, scope: interaction.scope }));
      return;
    }
    if (url.pathname === paths.token && method === "POST") {
      const params = await form(request);
      const auth = credentials(request, params);
      const client = clients.find((entry) => auth && equal(entry.clientId, auth.id) && equal(entry.clientSecret, auth.secret));
      if (!client || faults.invalidClient) return reject(response, 401, "invalid_client");
      if (params.get("grant_type") !== "authorization_code") return reject(response, 400, "unsupported_grant_type");
      const code = params.get("code") ?? "";
      const record = codes.get(code);
      codes.delete(code);
      if (!record || record.expired || record.expiresAt <= now() || record.clientId !== client.clientId || record.redirectUri !== params.get("redirect_uri") || faults.invalidGrant) return reject(response, 400, "invalid_grant");
      const verifier = params.get("code_verifier") ?? "";
      if (record.challenge && (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !equal(createHash("sha256").update(verifier).digest("base64url"), record.challenge))) return reject(response, 400, "invalid_grant");
      const issuedAt = Math.floor(now() / 1000);
      const accessToken = randomBytes(32).toString("base64url");
      tokens.set(accessToken, { account: record.account, expiresAt: now() + tokenTtl });
      const claims = {
        ...profile(record.account), iss: issuer, aud: client.clientId, iat: issuedAt, exp: issuedAt + Math.ceil(tokenTtl / 1000),
        ...(record.nonce !== null ? { nonce: faults.nonceMismatch ? `${record.nonce}-mismatch` : record.nonce } : {}),
      };
      witness({ type: "token", clientId: client.clientId, sub: record.account.sub, scope: record.scope });
      json(response, 200, {
        access_token: accessToken, token_type: "Bearer", expires_in: Math.ceil(tokenTtl / 1000), scope: record.scope,
        ...(record.scope.split(/\s+/).includes("openid") ? { id_token: signOidcJwt({ keyId, privateKeyPem: faults.badSignature ? badPrivateKeyPem : privateKeyPem, claims }) } : {}),
      });
      return;
    }
    if (url.pathname === paths.userinfo && method === "GET") {
      const match = /^Bearer ([^\s]+)$/i.exec(request.headers.authorization ?? "");
      const token = tokens.get(match?.[1] ?? "");
      if (!token) return reject(response, 401, "invalid_token");
      witness({ type: "userinfo", sub: token.account.sub });
      json(response, 200, profile(token.account));
      return;
    }
    const known = [...Object.values(paths), SELECT_PATH, CONSENT_PATH].includes(url.pathname);
    reject(response, known ? 405 : 404, known ? "method_not_allowed" : "not_found");
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) reject(response, 400, "invalid_request");
      else response.end();
    });
  });
  await new Promise<void>((resolve, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(config.listen?.port ?? 0, host, () => { server.off("error", rejectListen); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("OAuth fixture did not acquire a TCP address");
  const baseUrl = `http://${host === "::1" ? "[::1]" : host}:${address.port}`;
  const endpoints: OAuthEndpoints = {
    authorization: `${baseUrl}${paths.authorization}`, token: `${baseUrl}${paths.token}`,
    jwks: `${baseUrl}${paths.jwks}`, userinfo: `${baseUrl}${paths.userinfo}`, discovery: `${baseUrl}${paths.discovery}`,
  };
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= new Promise<void>((resolve, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolve());
    server.closeIdleConnections();
  });
  return { baseUrl, issuer, endpoints, publicEndpoints, events, registerClient, setFaults: (next) => { faults = { ...next }; }, stop, [Symbol.asyncDispose]: stop };
}
