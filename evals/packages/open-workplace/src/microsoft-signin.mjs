#!/usr/bin/env node
// Open Workplace sign-in: a Microsoft Entra-compatible authorization server and Graph front door, so an app's
// ordinary Microsoft 365 connector (OAuth authorization code + PKCE, then Microsoft Graph) can run against Open
// Outlook, Open Calendar and Open Drive instead of a real tenant. Sandbox only: every identity is fictional.
//
// Each person has their own Open Workplace backend (one microsoft365.mjs process each), so one person's mail,
// calendar and files never mix with another's. The consent page asks which fictional person is signing in; the
// access token it leads to reaches only that person's backend, and only within the approved scopes.
//
//   OPEN_WORKPLACE_SIGNIN='{"tenantId":"…","clientId":"…","clientSecret":"…","redirectUris":["…"],
//     "people":[{"handle":"alex","name":"Alex Chen","email":"alex@acme.test","graph":"http://127.0.0.1:3993"}]}' \
//   HOST=127.0.0.1 PORT=3994 node microsoft-signin.mjs
//
// Point the app's Microsoft endpoints here, e.g. for OpenWork Den:
//   DEN_MICROSOFT_OAUTH_AUTHORIZE_URL=<origin>/{tenantId}/oauth2/v2.0/authorize
//   DEN_MICROSOFT_OAUTH_TOKEN_URL=<origin>/{tenantId}/oauth2/v2.0/token
//   DEN_MICROSOFT_GRAPH_BASE_URL=<origin>/v1.0
// Node builtins only, like the rest of this package.
import { createServer } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3994);
const BACKEND_TOKEN = "open-workplace-token";
const TOKEN_MS = 60 * 60 * 1000;
const REFRESH_MS = 8 * 60 * 60 * 1000;
const CODE_MS = 5 * 60 * 1000;
const REQUEST_MS = 10 * 60 * 1000;
const MAX_FORM = 64 * 1024;
const MAX_BODY = 12 * 1024 * 1024;
// Scopes this sign-in grants: Microsoft Graph delegated permissions Open Workplace serves, plus OpenID Connect.
const SUPPORTED_SCOPES = new Set(["openid", "profile", "email", "offline_access", "User.Read", "Mail.Read", "Mail.ReadWrite", "Mail.Send", "Calendars.Read", "Calendars.ReadWrite", "Files.Read", "Files.ReadWrite", "Files.Read.All", "Files.ReadWrite.All"]);

const secret = () => randomBytes(32).toString("base64url");
const digest = (value) => createHash("sha256").update(value).digest("base64url");
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
function same(a, b) {
  const left = Buffer.from(String(a)); const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Validates the sign-in configuration; throws on anything an operator should fix before starting. */
export function signInConfig(raw) {
  let value;
  try { value = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { throw new Error("OPEN_WORKPLACE_SIGNIN must be JSON."); }
  if (!value || typeof value !== "object") throw new Error("OPEN_WORKPLACE_SIGNIN must be a JSON object.");
  const { tenantId, clientId, clientSecret, redirectUris, people } = value;
  if (typeof tenantId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tenantId)) throw new Error("tenantId must be a lowercase GUID.");
  if (typeof clientId !== "string" || !clientId || clientId.length > 200) throw new Error("clientId is required.");
  if (typeof clientSecret !== "string" || clientSecret.length < 16) throw new Error("clientSecret must be at least 16 characters.");
  if (!Array.isArray(redirectUris) || !redirectUris.length) throw new Error("redirectUris must list at least one exact callback URL.");
  for (const uri of redirectUris) {
    const url = new URL(uri);
    if (!["http:", "https:"].includes(url.protocol) || url.hash || url.username || url.password) throw new Error("Each redirect URI must be an exact http(s) URL without credentials or fragment.");
  }
  if (!Array.isArray(people) || !people.length) throw new Error("people must list at least one fictional person.");
  const handles = new Set();
  const checked = people.map((person) => {
    if (!person || typeof person !== "object") throw new Error("Each person must be an object.");
    const { handle, name, email, graph } = person;
    if (typeof handle !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(handle) || handles.has(handle)) throw new Error("Each person needs a unique lowercase handle.");
    if (typeof name !== "string" || !name.trim() || name.length > 100) throw new Error(`Person ${handle} needs a name.`);
    if (typeof email !== "string" || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) throw new Error(`Person ${handle} needs an email address.`);
    const backend = new URL(graph);
    if (!["http:", "https:"].includes(backend.protocol) || backend.pathname !== "/" || backend.search || backend.hash) throw new Error(`Person ${handle} needs the origin of their own Open Workplace backend.`);
    handles.add(handle);
    return { handle, name: name.trim(), email: email.toLowerCase(), graph: backend.origin };
  });
  return { tenantId, clientId, clientSecret, redirectUris: [...new Set(redirectUris)], people: checked };
}

/**
 * The Graph delegated permissions a request needs: any one of the returned scopes is enough. Unknown paths need a
 * permission nobody can be granted, so they are refused rather than passed through.
 */
export function requiredScopes(method, path) {
  const write = !["GET", "HEAD"].includes(method);
  if (path === "/me") return write ? ["(none)"] : ["User.Read"];
  if (path === "/me/sendMail" || /^\/me\/messages\/[^/]+\/send$/.test(path)) return ["Mail.Send"];
  if (/^\/me\/(messages|mailFolders)(\/|$)/.test(path)) return write ? ["Mail.ReadWrite"] : ["Mail.Read", "Mail.ReadWrite"];
  if (/^\/me\/(events|calendar|calendars|calendarView)(\/|$)/.test(path)) return write ? ["Calendars.ReadWrite"] : ["Calendars.Read", "Calendars.ReadWrite"];
  // Microsoft Search is a POST that only reads.
  const reads = !write || path === "/search/query";
  if (/^\/(me\/drive|drives|shares|sites|search\/query)(\/|$|\()/.test(path)) return reads ? ["Files.Read", "Files.ReadWrite", "Files.Read.All", "Files.ReadWrite.All"] : ["Files.ReadWrite", "Files.ReadWrite.All"];
  return ["(none)"];
}

function consentPage({ request, people, scopes, clientId }) {
  const options = people.map((person, index) => `<label class="person"><input type="radio" name="person" value="${escapeHtml(person.handle)}"${index === 0 ? " checked" : ""}> <span><strong>${escapeHtml(person.name)}</strong><br><small>${escapeHtml(person.email)}</small></span></label>`).join("");
  const asked = scopes.filter((scope) => !["openid", "profile", "email", "offline_access"].includes(scope));
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in · Acme Workplace</title>
<style>body{font:15px/1.5 system-ui,sans-serif;background:#f4f4f5;color:#18181b;margin:0;display:grid;place-items:center;min-height:100vh}main{background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:32px;max-width:440px;width:calc(100% - 32px);box-sizing:border-box}h1{font-size:20px;margin:0 0 4px}p{margin:0 0 16px;color:#52525b}.note{font-size:13px;background:#fafafa;border:1px solid #e4e4e7;border-radius:8px;padding:8px 12px}fieldset{border:0;padding:0;margin:0 0 16px}legend{font-weight:600;margin-bottom:8px}.person{display:flex;gap:10px;align-items:flex-start;padding:8px 0}ul{margin:0 0 20px;padding-left:20px;color:#3f3f46}.actions{display:flex;gap:8px;justify-content:flex-end}button{font:inherit;border-radius:8px;padding:8px 14px;border:1px solid #d4d4d8;background:#fff;cursor:pointer}button.primary{background:#18181b;color:#fff;border-color:#18181b}</style>
<main><h1>Sign in to Acme Workplace</h1><p class="note">Fictional sandbox sign-in for Open Outlook, Open Calendar and Open Drive. Not a Microsoft account.</p>
<form method="post"><input type="hidden" name="request" value="${escapeHtml(request)}"><fieldset><legend>Who is signing in?</legend>${options}</fieldset>
<p>The app <strong>${escapeHtml(clientId)}</strong> asks to:</p><ul>${asked.map((scope) => `<li>${escapeHtml(scope)}</li>`).join("") || "<li>Know who you are</li>"}</ul>
<div class="actions"><button name="decision" value="deny">Decline</button><button class="primary" name="decision" value="allow">Allow access</button></div></form></main></html>`;
}

/** The sign-in server as a request handler; `listen` adds the HTTP server. */
export function createMicrosoftSignIn(input) {
  const config = signInConfig(input);
  const byHandle = new Map(config.people.map((person) => [person.handle, person]));
  const requests = new Map(), codes = new Map(), tokens = new Map(), refreshes = new Map();
  const prune = () => { const now = Date.now(); for (const table of [requests, codes, tokens, refreshes]) for (const [key, entry] of table) if (entry.expires <= now) table.delete(key); };

  function send(response, status, value, headers = {}) {
    const html = typeof value === "string";
    response.writeHead(status, {
      "content-type": html ? "text/html; charset=utf-8" : "application/json; charset=utf-8", "cache-control": "no-store", pragma: "no-cache",
      "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
      ...(html ? { "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' " + config.redirectUris.map((uri) => new URL(uri).origin).join(" ") + "; frame-ancestors 'none'; base-uri 'none'" } : {}),
      ...headers,
    });
    response.end(value === null ? undefined : html ? value : JSON.stringify(value));
  }
  const oauthError = (response, status, error, description) => send(response, status, { error, error_description: description });
  const graphError = (response, status, code, message) => send(response, status, { error: { code, message } });
  async function read(request, limit) {
    const chunks = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > limit) throw Object.assign(new Error("too large"), { tooLarge: true }); chunks.push(chunk); }
    return Buffer.concat(chunks);
  }
  async function form(request) {
    const type = String(request.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (type !== "application/x-www-form-urlencoded") return null;
    return new URLSearchParams((await read(request, MAX_FORM)).toString("utf8"));
  }
  function redirect(response, target, params) {
    const url = new URL(target);
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null) url.searchParams.set(key, value);
    response.writeHead(302, { location: url.toString(), "cache-control": "no-store", "referrer-policy": "no-referrer" });
    response.end();
  }
  function idToken(person, audience, nonce) {
    // Unsigned: a fictional identity hint for the client, not a credential. The access token is what grants access.
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: `${origin()}/${config.tenantId}/v2.0`, aud: audience, tid: config.tenantId, sub: digest(`${config.tenantId}:${person.handle}`), oid: digest(`oid:${person.handle}`).slice(0, 32), name: person.name, email: person.email, preferred_username: person.email, iat: now, exp: now + TOKEN_MS / 1000, ...(nonce ? { nonce } : {}) };
    return `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.`;
  }
  let listening = null;
  const origin = () => listening ?? `http://${HOST}:${PORT}`;
  function issue(person, scopes, nonce) {
    const access = secret(); const refresh = secret();
    tokens.set(digest(access), { person: person.handle, scopes, expires: Date.now() + TOKEN_MS });
    refreshes.set(digest(refresh), { person: person.handle, scopes, expires: Date.now() + REFRESH_MS });
    return { token_type: "Bearer", scope: scopes.join(" "), expires_in: TOKEN_MS / 1000, ext_expires_in: TOKEN_MS / 1000, access_token: access, refresh_token: refresh, id_token: idToken(person, config.clientId, nonce) };
  }
  function clientAuthenticated(request, params) {
    let id = params.get("client_id"); let key = params.get("client_secret");
    const basic = String(request.headers.authorization || "").match(/^Basic\s+(.+)$/i);
    if (basic) { const [user, pass] = Buffer.from(basic[1], "base64").toString("utf8").split(":"); id = decodeURIComponent(user || ""); key = decodeURIComponent(pass || ""); }
    return Boolean(id && key && same(id, config.clientId) && same(key, config.clientSecret));
  }

  async function handle(request, response) {
    prune();
    const url = new URL(request.url, "http://signin.local");
    const path = url.pathname;
    if (request.method === "GET" && path === "/health") return send(response, 200, { ok: true, service: "open-workplace-microsoft-signin", people: config.people.length });
    const tenantRoute = path.match(/^\/([^/]+)\/oauth2\/v2\.0\/(authorize|token)$/);
    if (tenantRoute) {
      if (tenantRoute[1] !== config.tenantId) return send(response, 400, { error: "invalid_request", error_description: "Unknown tenant." });
      if (tenantRoute[2] === "authorize" && request.method === "GET") {
        const params = url.searchParams;
        const redirectUri = params.get("redirect_uri");
        // Until the client and its exact redirect URI check out, never redirect anywhere.
        if (params.get("client_id") !== config.clientId || !redirectUri || !config.redirectUris.includes(redirectUri)) return send(response, 400, "<!doctype html><title>Sign-in error</title><p>This app or its return address is not registered with Acme Workplace.</p>");
        const state = params.get("state") ?? undefined;
        if (params.get("response_type") !== "code") return redirect(response, redirectUri, { error: "unsupported_response_type", state });
        const challenge = params.get("code_challenge");
        if (params.get("code_challenge_method") !== "S256" || !challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return redirect(response, redirectUri, { error: "invalid_request", error_description: "S256 PKCE is required.", state });
        const scopes = [...new Set(String(params.get("scope") || "").split(/\s+/).filter(Boolean))];
        if (!scopes.length || scopes.some((scope) => !SUPPORTED_SCOPES.has(scope))) return redirect(response, redirectUri, { error: "invalid_scope", error_description: "Acme Workplace does not offer every requested permission.", state });
        const id = secret();
        requests.set(id, { redirectUri, state, challenge, scopes, nonce: params.get("nonce") || undefined, expires: Date.now() + REQUEST_MS });
        return send(response, 200, consentPage({ request: id, people: config.people, scopes, clientId: config.clientId }));
      }
      if (tenantRoute[2] === "authorize" && request.method === "POST") {
        const fields = await form(request);
        const pending = fields && requests.get(fields.get("request") || "");
        if (!fields || !pending) return send(response, 400, "<!doctype html><title>Sign-in expired</title><p>This sign-in request expired or was already used. Start again from the app.</p>");
        requests.delete(fields.get("request"));
        if (fields.get("decision") !== "allow") return redirect(response, pending.redirectUri, { error: "access_denied", error_description: "The person declined access.", state: pending.state });
        const person = byHandle.get(fields.get("person") || "");
        if (!person) return redirect(response, pending.redirectUri, { error: "access_denied", error_description: "Choose who is signing in.", state: pending.state });
        const code = secret();
        codes.set(digest(code), { person: person.handle, redirectUri: pending.redirectUri, challenge: pending.challenge, scopes: pending.scopes, nonce: pending.nonce, expires: Date.now() + CODE_MS });
        return redirect(response, pending.redirectUri, { code, state: pending.state });
      }
      if (tenantRoute[2] === "token" && request.method === "POST") {
        const params = await form(request);
        if (!params) return oauthError(response, 400, "invalid_request", "Send application/x-www-form-urlencoded.");
        if (!clientAuthenticated(request, params)) return oauthError(response, 401, "invalid_client", "Client authentication failed.");
        const grant = params.get("grant_type");
        if (grant === "authorization_code") {
          const key = digest(params.get("code") || "");
          const entry = codes.get(key);
          codes.delete(key);
          const verifier = params.get("code_verifier") || "";
          if (!entry || entry.redirectUri !== params.get("redirect_uri") || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !same(digest(verifier), entry.challenge)) return oauthError(response, 400, "invalid_grant", "The authorization code is invalid, expired, already used, or does not match.");
          return send(response, 200, issue(byHandle.get(entry.person), entry.scopes, entry.nonce));
        }
        if (grant === "refresh_token") {
          const key = digest(params.get("refresh_token") || "");
          const entry = refreshes.get(key);
          refreshes.delete(key);
          if (!entry) return oauthError(response, 400, "invalid_grant", "The refresh token is invalid, expired or already used.");
          return send(response, 200, issue(byHandle.get(entry.person), entry.scopes));
        }
        return oauthError(response, 400, "unsupported_grant_type", "Use authorization_code or refresh_token.");
      }
      return send(response, 405, { error: "invalid_request", error_description: "Method not allowed." }, { allow: tenantRoute[2] === "token" ? "POST" : "GET, POST" });
    }

    const bearer = String(request.headers.authorization || "").match(/^Bearer\s+([A-Za-z0-9_-]{20,})$/);
    const grant = bearer ? tokens.get(digest(bearer[1])) : undefined;
    if (request.method === "GET" && path === "/oidc/userinfo") {
      if (!grant) return send(response, 401, { error: "invalid_token" }, { "www-authenticate": 'Bearer error="invalid_token"' });
      const person = byHandle.get(grant.person);
      return send(response, 200, { sub: digest(`${config.tenantId}:${person.handle}`), name: person.name, email: person.email, preferred_username: person.email });
    }
    const prefix = path.startsWith("/graph/v1.0/") ? "/graph/v1.0" : path.startsWith("/v1.0/") ? "/v1.0" : null;
    if (!prefix) return graphError(response, 404, "itemNotFound", "Not found.");
    if (!grant) return graphError(response, 401, "InvalidAuthenticationToken", "Access token is missing, invalid or expired.");
    let graphPath;
    try { graphPath = decodeURIComponent(path.slice(prefix.length)); } catch { return graphError(response, 400, "BadRequest", "Invalid URL encoding."); }
    if (!requiredScopes(request.method, graphPath).some((scope) => grant.scopes.includes(scope))) return graphError(response, 403, "ErrorAccessDenied", "Access is denied. The token does not grant the permission this request needs.");
    const person = byHandle.get(grant.person);
    const forward = {};
    for (const name of ["content-type", "accept", "if-match", "if-none-match", "prefer", "range"]) if (request.headers[name]) forward[name] = request.headers[name];
    let body;
    if (!["GET", "HEAD"].includes(request.method)) {
      try { body = await read(request, MAX_BODY); } catch (error) { if (error.tooLarge) return graphError(response, 413, "RequestEntityTooLarge", "Maximum request size is 12 MB."); throw error; }
    }
    // The backend serves exactly one person; only this person's token ever reaches it.
    const upstream = await fetch(`${person.graph}/v1.0${path.slice(prefix.length)}${url.search}`, {
      method: request.method, headers: { ...forward, authorization: `Bearer ${BACKEND_TOKEN}` }, body, redirect: "manual", signal: AbortSignal.timeout(30_000),
    });
    const headers = { "cache-control": "no-store" };
    for (const name of ["content-type", "content-disposition", "etag", "location", "content-range"]) { const value = upstream.headers.get(name); if (value) headers[name] = value; }
    response.writeHead(upstream.status, headers);
    response.end(Buffer.from(await upstream.arrayBuffer()));
  }

  return {
    config,
    async handle(request, response) {
      try { await handle(request, response); } catch (error) {
        if (!response.headersSent) graphError(response, error?.tooLarge ? 413 : 502, error?.tooLarge ? "RequestEntityTooLarge" : "ServiceUnavailable", error?.tooLarge ? "Request too large." : "The request failed.");
        else response.destroy();
      }
    },
    /** For tests and status pages: how many live grants each person has; never the tokens. */
    grants() { prune(); const counts = {}; for (const entry of tokens.values()) counts[entry.person] = (counts[entry.person] || 0) + 1; return counts; },
    setOrigin(value) { listening = new URL(value).origin; },
  };
}

if (import.meta.main) {
  const signIn = createMicrosoftSignIn(process.env.OPEN_WORKPLACE_SIGNIN || "");
  const server = createServer((request, response) => { void signIn.handle(request, response); });
  server.requestTimeout = 30_000; server.headersTimeout = 15_000;
  server.listen(PORT, HOST, () => {
    const address = server.address();
    signIn.setOrigin(process.env.PUBLIC_URL || `http://${HOST}:${address.port}`);
    console.log(`Open Workplace sign-in listening at http://${HOST}:${address.port} (${signIn.config.people.length} people)`);
    process.send?.({ type: "ready", port: address.port });
  });
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { server.close(); server.closeAllConnections(); });
}
