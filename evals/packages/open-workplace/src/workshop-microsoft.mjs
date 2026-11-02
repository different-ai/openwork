// Workshop Microsoft 365 sign-in: an Entra-compatible OAuth front door to the workshop gateway, so an app's ordinary
// Microsoft 365 connector (authorization code + S256 PKCE, rotating refresh, then Microsoft Graph) reaches the same
// private browser workspace the person sees in Open Outlook, Open Calendar and Open Drive. Sandbox only: the identity
// is the workshop's browser workspace (automatic mode) or assigned account, never a real Microsoft account.
//
//   POST /_workshop/microsoft/clients      {"client_name","redirect_uris"} -> confidential client for one app
//   GET|POST /<tenant>/oauth2/v2.0/authorize   consent in the person's own browser workspace
//   POST /<tenant>/oauth2/v2.0/token           authorization_code | refresh_token (client secret required)
//   /v1.0/... with "Authorization: Bearer"     Microsoft Graph for that workspace only, within the granted scopes
//
// An app points its Microsoft endpoints at <origin>/{tenantId}/oauth2/v2.0/{authorize,token} and Graph at
// <origin>/v1.0. The tenant ID is derived from the workshop origin. Node builtins only, like the rest of this package.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { requiredScopes } from "./microsoft-signin.mjs";
import { workshopPage as page, escapeHtml } from "./workshop-html.mjs";

const CLIENT_MS = 120 * 24 * 60 * 60 * 1000;
const FAMILY_MS = 30 * 24 * 60 * 60 * 1000;
const TOKEN_MS = 60 * 60 * 1000;
const CODE_MS = 5 * 60 * 1000;
const REQUEST_MS = 10 * 60 * 1000;
const LIMIT = 4096;
const STORAGE_KEY = "workshop-microsoft:v1";
const OIDC = new Set(["openid", "profile", "email", "offline_access"]);
const SUPPORTED_SCOPES = new Set([...OIDC, "User.Read", "Mail.Read", "Mail.ReadWrite", "Mail.Send", "Calendars.Read", "Calendars.ReadWrite", "Files.Read", "Files.ReadWrite", "Files.Read.All", "Files.ReadWrite.All"]);
const PERMISSIONS = {
  "User.Read": "Know your sample name and email address.",
  "Mail.Read": "Read your sample mail.",
  "Mail.ReadWrite": "Read your sample mail and save drafts.",
  "Mail.Send": "Send fictional mail from your sample mailbox.",
  "Calendars.Read": "Read your sample calendar.",
  "Calendars.ReadWrite": "Read and change your sample calendar.",
  "Files.Read": "Read your sample files.",
  "Files.ReadWrite": "Read and save your sample files.",
  "Files.Read.All": "Read every sample file you can open.",
  "Files.ReadWrite.All": "Read and save every sample file you can open.",
};

const secret = () => randomBytes(32).toString("base64url");
const digest = (value) => createHash("sha256").update(String(value)).digest("base64url");
function same(a, b) {
  const left = Buffer.from(digest(a)); const right = Buffer.from(digest(b));
  return timingSafeEqual(left, right);
}

/** The workshop's fictional tenant: a GUID derived from its public origin, stable across restarts. */
export function workshopTenantId(origin) {
  const hex = createHash("sha256").update(`open-workplace-tenant:${new URL(origin).origin}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Apps people may be asked to connect: their callbacks must be on one of these origins, so a code only ever goes back
 * to a trusted app (which also checks its own state). OpenWork Cloud's Den by default; an operator adds others with
 * OPEN_WORKPLACE_MICROSOFT_APP_ORIGINS (comma-separated https origins). Loopback callbacks stay allowed for local
 * worlds: a code sent there never leaves the person's own machine.
 */
export const DEFAULT_APP_ORIGINS = ["https://api.openworklabs.com", "https://app.openworklabs.com"];
export function trustedAppOrigins(raw = process.env.OPEN_WORKPLACE_MICROSOFT_APP_ORIGINS) {
  const extra = String(raw || "").split(",").map((value) => value.trim()).filter(Boolean).flatMap((value) => {
    try { const url = new URL(value); return url.protocol === "https:" && url.origin === value.replace(/\/+$/, "") ? [url.origin] : []; } catch { return []; }
  });
  return new Set([...DEFAULT_APP_ORIGINS, ...extra]);
}
function redirectAllowed(value, trusted) {
  try {
    const target = new URL(value);
    if (typeof value !== "string" || value.length > 2048 || value.includes("#") || target.username || target.password) return false;
    if (target.protocol === "http:" || target.protocol === "https:") { if (["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)) return true; }
    return target.protocol === "https:" && trusted.has(target.origin);
  } catch { return false; }
}

/**
 * The Microsoft 365 front door for one workshop gateway. `auth` is the workshop's authentication
 * (createWorkshopAuth): it says who the browser is and finds a participant by ID.
 */
export function createWorkshopMicrosoft({ origin, auth, storage, appOrigins = trustedAppOrigins() }) {
  const base = new URL(origin);
  if (base.origin !== origin) throw new Error("Workshop origin must be an HTTP(S) origin");
  const tenantId = workshopTenantId(origin);
  const clients = new Map(), codes = new Map(), tokens = new Map(), refreshes = new Map(), requests = new Map(), rates = new Map();
  const tables = { clients, tokens, refreshes };
  const prune = (table) => { const now = Date.now(); for (const [key, entry] of table) if (entry.expires <= now) table.delete(key); };

  function save() {
    if (!storage) return;
    storage.write(STORAGE_KEY, { version: 1, origin, tables: Object.fromEntries(Object.entries(tables).map(([name, table]) => [name, [...table].map(([key, entry]) => {
      const { participant, ...fields } = entry;
      return [key, participant ? { ...fields, participantId: participant.id } : fields];
    })])) });
  }
  function restore() {
    const saved = storage?.read(STORAGE_KEY);
    if (saved === undefined) return;
    if (!saved || saved.version !== 1 || saved.origin !== origin || !saved.tables) throw new Error("Workshop Microsoft 365 storage is invalid; restore a trusted backup before restarting.");
    for (const [name, table] of Object.entries(tables)) {
      for (const [key, entry] of Array.isArray(saved.tables[name]) ? saved.tables[name] : []) {
        if (typeof key !== "string" || !entry || typeof entry !== "object" || !Number.isFinite(entry.expires) || entry.expires <= Date.now()) continue;
        if (name === "clients") { table.set(key, entry); continue; }
        // A token outlives nothing: a participant who no longer exists takes their grants with them.
        const participant = auth.participant(entry.participantId);
        if (!participant) continue;
        const { participantId: _unused, ...fields } = entry;
        table.set(key, { ...fields, participant });
      }
    }
  }
  restore();

  function budget(req, category, maximum) {
    prune(rates);
    const key = `${category}:${req.socket?.remoteAddress || "unknown"}`;
    let entry = rates.get(key);
    if (!entry) { if (rates.size >= LIMIT) return false; entry = { count: 0, expires: Date.now() + 60_000 }; rates.set(key, entry); }
    if (entry.count >= maximum) return false;
    entry.count++;
    return true;
  }
  function send(res, status, value, headers = {}) {
    const html = typeof value === "string";
    res.writeHead(status, {
      "content-type": html ? "text/html; charset=utf-8" : "application/json; charset=utf-8", "cache-control": "no-store", pragma: "no-cache",
      "x-content-type-options": "nosniff", "referrer-policy": "same-origin",
      // The consent page widens form-action to the app's own callback: browsers check a form's redirect against it too.
      ...(html ? { "content-security-policy": res.getHeader("content-security-policy") || "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" } : {}),
      ...headers,
    });
    res.end(value === null ? undefined : html ? value : JSON.stringify(value));
  }
  const oauthError = (res, status, error, description) => send(res, status, { error, error_description: description });
  const graphError = (res, status, code, message, headers = {}) => send(res, status, { error: { code, message } }, headers);
  function redirect(res, target, params) {
    const url = new URL(target);
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null) url.searchParams.set(key, value);
    res.writeHead(303, { location: url.toString(), "cache-control": "no-store", "referrer-policy": "no-referrer" });
    res.end();
  }
  async function read(req, limit) {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > limit) throw Object.assign(new Error("too large"), { status: 413 }); chunks.push(chunk); }
    return Buffer.concat(chunks).toString("utf8");
  }
  async function form(req) {
    if (String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase() !== "application/x-www-form-urlencoded") return null;
    const fields = new URLSearchParams(await read(req, 16 * 1024));
    if ([...new Set(fields.keys())].some((key) => fields.getAll(key).length !== 1)) return null;
    return fields;
  }
  function sameOrigin(req) {
    if (req.headers.origin !== undefined) return req.headers.origin === origin;
    try { return new URL(req.headers.referer).origin === origin; } catch { return false; }
  }
  const email = (participant) => `${participant.id}@acme.test`;
  /** OpenID Connect claims a grant may see: the name with `profile`, the email with `email`. */
  function identityClaims(participant, scopes) {
    return {
      sub: digest(`${tenantId}:${participant.id}`),
      ...(scopes.includes("profile") ? { name: participant.name } : {}),
      ...(scopes.includes("email") ? { email: email(participant), preferred_username: email(participant) } : {}),
    };
  }
  function idToken(participant, audience, nonce, scopes) {
    // Unsigned: a fictional identity hint for the app, not a credential. The access token is what grants access.
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: `${origin}/${tenantId}/v2.0`, aud: audience, tid: tenantId, oid: digest(`oid:${participant.id}`).slice(0, 32), ...identityClaims(participant, scopes), iat: now, exp: now + TOKEN_MS / 1000, ...(nonce ? { nonce } : {}) };
    return `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.`;
  }
  function revokeFamily(family) { for (const table of [tokens, refreshes]) for (const [key, entry] of table) if (entry.family === family) table.delete(key); }
  function issue(grant) {
    prune(tokens); prune(refreshes);
    if (tokens.size >= LIMIT * 4 || refreshes.size >= LIMIT * 4) return null;
    const access = secret(), refresh = secret();
    const fields = { participant: grant.participant, clientId: grant.clientId, scopes: grant.scopes, family: grant.family };
    tokens.set(digest(access), { ...fields, expires: Math.min(Date.now() + TOKEN_MS, grant.familyExpires) });
    refreshes.set(digest(refresh), { ...fields, familyExpires: grant.familyExpires, expires: grant.familyExpires });
    save();
    return { token_type: "Bearer", scope: grant.scopes.join(" "), expires_in: TOKEN_MS / 1000, ext_expires_in: TOKEN_MS / 1000, access_token: access, refresh_token: refresh, ...(grant.scopes.includes("openid") ? { id_token: idToken(grant.participant, grant.clientId, grant.nonce, grant.scopes) } : {}) };
  }
  function authenticatedClient(req, params) {
    let id = params.get("client_id"); let key = params.get("client_secret");
    const basic = String(req.headers.authorization || "").match(/^Basic\s+(.+)$/i);
    if (basic) { const [user, pass] = Buffer.from(basic[1], "base64").toString("utf8").split(":"); id = decodeURIComponent(user || ""); key = decodeURIComponent(pass || ""); }
    prune(clients);
    const client = id ? clients.get(id) : undefined;
    return client && key && same(digest(key), client.secretDigest) ? client : null;
  }

  function consent(res, { requestId, participant, client, scopes, redirectUri }) {
    const asked = scopes.filter((scope) => !OIDC.has(scope)).map((scope) => PERMISSIONS[scope] ?? scope);
    res.setHeader("Content-Security-Policy", `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${new URL(redirectUri).origin}; frame-ancestors 'none'; base-uri 'none'`);
    send(res, 200, page(`Connect ${client.name}`, `<div class="account"><span class="muted">Private workspace</span><strong>${escapeHtml(participant.name)}</strong></div><h2>Application requesting access</h2><p>${escapeHtml(client.name)}<br><span class="muted">${escapeHtml(new URL(redirectUri).host)} · Sample Microsoft 365 sign-in</span></p><h2>Workplace permissions</h2><ul class="permissions">${(asked.length ? asked : ["Know who you are."]).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}<li>Keep this connection active for up to 30 days.</li></ul><p class="muted">Only this private fictional workspace is shared: the same mail, calendar and files you see in Open Outlook, Open Calendar and Open Drive in this browser. This is not a Microsoft account.</p><form action="/${tenantId}/oauth2/v2.0/authorize" method="post"><input type="hidden" name="request" value="${escapeHtml(requestId)}"><div class="actions"><button type="submit" name="decision" value="allow">Allow workplace access</button><button class="secondary" type="submit" name="decision" value="deny">Deny access</button></div></form>`));
  }

  async function handle(req, res, url) {
    const path = url.pathname;
    if (path === "/_workshop/microsoft/clients") {
      if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" }, { allow: "POST" }), true;
      if (!budget(req, "register", 30)) return send(res, 429, { error: "too_many_requests" }), true;
      if (String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase() !== "application/json") return send(res, 415, { error: "invalid_request" }), true;
      let data;
      try { data = JSON.parse(await read(req, 16 * 1024)); } catch (error) { return send(res, error.status || 400, { error: "invalid_client_metadata" }), true; }
      const uris = data?.redirect_uris;
      if (!Array.isArray(uris) || !uris.length || uris.length > 5 || !uris.every((uri) => redirectAllowed(uri, appOrigins))) return send(res, 400, { error: "invalid_redirect_uri", error_description: "Give one to five exact callback URLs on a trusted app's origin." }), true;
      prune(clients);
      if (clients.size >= LIMIT) return send(res, 503, { error: "temporarily_unavailable" }), true;
      const clientId = `open-workplace-${randomBytes(12).toString("hex")}`, clientSecret = secret();
      // The consent page names the app by where it sends people back, never by what the caller says it is.
      const hosts = [...new Set(uris.map((uri) => new URL(uri).host))];
      const name = DEFAULT_APP_ORIGINS.some((trusted) => uris.every((uri) => new URL(uri).origin === trusted)) ? "OpenWork" : `App at ${hosts.join(", ")}`;
      clients.set(clientId, { clientId, name, redirectUris: [...new Set(uris)], secretDigest: digest(clientSecret), expires: Date.now() + CLIENT_MS });
      save();
      send(res, 201, {
        client_id: clientId, client_secret: clientSecret, tenant_id: tenantId, expires_at: new Date(Date.now() + CLIENT_MS).toISOString(),
        authorize_endpoint: `${origin}/${tenantId}/oauth2/v2.0/authorize`, token_endpoint: `${origin}/${tenantId}/oauth2/v2.0/token`, graph_base_url: `${origin}/v1.0`,
      });
      return true;
    }
    const route = path.match(/^\/([^/]+)\/oauth2\/v2\.0\/(authorize|token)$/);
    if (!route) return false;
    if (route[1] !== tenantId) return oauthError(res, 400, "invalid_request", "Unknown tenant."), true;
    prune(codes); prune(requests); prune(clients);

    if (route[2] === "authorize" && req.method === "GET") {
      const params = url.searchParams;
      const client = clients.get(params.get("client_id") || "");
      const redirectUri = params.get("redirect_uri");
      // Until the client and its exact redirect URI check out, never redirect anywhere.
      if (!client || !redirectUri || !client.redirectUris.includes(redirectUri)) return send(res, 400, page("Sign-in error", "<p>This app or its return address is not registered with this workshop.</p>")), true;
      const state = params.get("state") ?? undefined;
      if (params.get("response_type") !== "code") return redirect(res, redirectUri, { error: "unsupported_response_type", state }), true;
      const challenge = params.get("code_challenge");
      if (params.get("code_challenge_method") !== "S256" || !challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return redirect(res, redirectUri, { error: "invalid_request", error_description: "S256 PKCE is required.", state }), true;
      const scopes = [...new Set(String(params.get("scope") || "").split(/\s+/).filter(Boolean))];
      if (!scopes.length || scopes.some((scope) => !SUPPORTED_SCOPES.has(scope))) return redirect(res, redirectUri, { error: "invalid_scope", error_description: "This workshop does not offer every requested permission.", state }), true;
      const participant = auth.browserParticipant(req);
      // No workspace in this browser yet: the workshop's own entry point creates or signs into one, then returns here.
      if (!participant) return send(res, 303, "", { location: `/login?next=${encodeURIComponent(path + url.search)}` }), true;
      if (!budget(req, "authorize", 120)) return send(res, 429, { error: "too_many_requests" }), true;
      if (requests.size >= LIMIT) return send(res, 503, { error: "temporarily_unavailable" }), true;
      const requestId = secret();
      requests.set(requestId, { participantId: participant.id, clientId: client.clientId, redirectUri, state, challenge, scopes, nonce: params.get("nonce") || undefined, expires: Date.now() + REQUEST_MS });
      consent(res, { requestId, participant, client, scopes, redirectUri });
      return true;
    }
    if (route[2] === "authorize" && req.method === "POST") {
      if (!sameOrigin(req)) return send(res, 403, { error: "cross_origin_denied" }), true;
      let fields;
      try { fields = await form(req); } catch (error) { return send(res, error.status || 400, { error: "invalid_request" }), true; }
      const pending = fields && requests.get(fields.get("request") || "");
      if (!fields || !pending) return send(res, 400, page("Sign-in expired", "<p>This sign-in request expired or was already used. Start again from the app.</p>")), true;
      requests.delete(fields.get("request"));
      const participant = auth.browserParticipant(req);
      // The decision must come from the same browser workspace the consent page was shown to.
      if (!participant || participant.id !== pending.participantId) return send(res, 403, page("Sign-in refused", "<p>This browser is not the workspace that was asked. Start again from the app.</p>")), true;
      if (fields.get("decision") !== "allow") return redirect(res, pending.redirectUri, { error: "access_denied", error_description: "The person declined access.", state: pending.state }), true;
      if (codes.size >= LIMIT) return send(res, 503, { error: "temporarily_unavailable" }), true;
      const code = secret();
      codes.set(digest(code), { participant, clientId: pending.clientId, redirectUri: pending.redirectUri, challenge: pending.challenge, scopes: pending.scopes, nonce: pending.nonce, expires: Date.now() + CODE_MS });
      redirect(res, pending.redirectUri, { code, state: pending.state });
      return true;
    }
    if (route[2] === "token" && req.method === "POST") {
      let params;
      try { params = await form(req); } catch (error) { return oauthError(res, error.status || 400, "invalid_request", "Request too large."), true; }
      if (!params) return oauthError(res, 400, "invalid_request", "Send application/x-www-form-urlencoded."), true;
      const client = authenticatedClient(req, params);
      if (!client) return oauthError(res, 401, "invalid_client", "Client authentication failed."), true;
      const grant = params.get("grant_type");
      if (grant === "authorization_code") {
        const key = digest(params.get("code") || "");
        const entry = codes.get(key);
        // A failed redemption also consumes the code.
        codes.delete(key);
        const verifier = params.get("code_verifier") || "";
        if (!entry || entry.clientId !== client.clientId || entry.redirectUri !== params.get("redirect_uri") || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || digest(verifier) !== entry.challenge) return oauthError(res, 400, "invalid_grant", "The authorization code is invalid, expired, already used, or does not match."), true;
        const issued = issue({ participant: entry.participant, clientId: client.clientId, scopes: entry.scopes, nonce: entry.nonce, family: secret(), familyExpires: Date.now() + FAMILY_MS });
        return issued ? send(res, 200, issued) : send(res, 503, { error: "temporarily_unavailable" }), true;
      }
      if (grant === "refresh_token") {
        prune(refreshes);
        const key = digest(params.get("refresh_token") || "");
        const entry = refreshes.get(key);
        if (!entry || entry.clientId !== client.clientId) return oauthError(res, 400, "invalid_grant", "The refresh token is invalid, expired or already used."), true;
        if (entry.used) { revokeFamily(entry.family); save(); return oauthError(res, 400, "invalid_grant", "The refresh token was already used; sign in again."), true; }
        entry.used = true;
        const issued = issue({ participant: entry.participant, clientId: client.clientId, scopes: entry.scopes, family: entry.family, familyExpires: entry.familyExpires });
        return issued ? send(res, 200, issued) : send(res, 503, { error: "temporarily_unavailable" }), true;
      }
      return oauthError(res, 400, "unsupported_grant_type", "Use authorization_code or refresh_token."), true;
    }
    send(res, 405, { error: "invalid_request", error_description: "Method not allowed." }, { allow: route[2] === "token" ? "POST" : "GET, POST" });
    return true;
  }

  /** Whether a request is Microsoft Graph or OpenID userinfo with a bearer token (rather than the browser's cookie). */
  function isGraphBearer(req, url) {
    return /^Bearer\s/i.test(String(req.headers.authorization || "")) && (url.pathname === "/oidc/userinfo" || url.pathname.startsWith("/v1.0/") || url.pathname.startsWith("/graph/v1.0/"));
  }

  /**
   * For Graph requests with a bearer token: the workspace the token belongs to, after checking the token grants the
   * permission this request needs. Answers the request itself (and returns null) when it is refused or is userinfo.
   */
  function authenticate(req, res, url) {
    const match = String(req.headers.authorization || "").match(/^Bearer\s+([A-Za-z0-9_-]{20,})$/);
    prune(tokens);
    const grant = match ? tokens.get(digest(match[1])) : undefined;
    if (!grant) { graphError(res, 401, "InvalidAuthenticationToken", "Access token is missing, invalid or expired.", { "www-authenticate": 'Bearer error="invalid_token"' }); return null; }
    if (url.pathname === "/oidc/userinfo") {
      if (!grant.scopes.includes("openid")) graphError(res, 403, "ErrorAccessDenied", "Userinfo needs the openid permission.");
      else send(res, 200, identityClaims(grant.participant, grant.scopes));
      return null;
    }
    let graphPath;
    try { graphPath = decodeURIComponent(url.pathname.replace(/^\/(graph\/)?v1\.0/, "")); } catch { graphError(res, 400, "BadRequest", "Invalid URL encoding."); return null; }
    if (!requiredScopes(req.method, graphPath).some((scope) => grant.scopes.includes(scope))) { graphError(res, 403, "ErrorAccessDenied", "Access is denied. The token does not grant the permission this request needs."); return null; }
    return grant.participant;
  }

  return {
    tenantId, handle, isGraphBearer, authenticate,
    /** For tests and status: live access tokens per workspace; never the tokens. */
    grants() { prune(tokens); const counts = {}; for (const entry of tokens.values()) counts[entry.participant.id] = (counts[entry.participant.id] || 0) + 1; return counts; },
  };
}
