// Standalone fictional workshop authentication. Node builtins only; no upstream identity provider.
// OAuth public clients use S256 PKCE and rotating, resource-bound refresh token families.
import { createHash, randomBytes } from "node:crypto";
import { workshopPage as page, escapeHtml } from "./workshop-html.mjs";

const SESSION_MS = 8 * 60 * 60 * 1000;
const AUTOMATIC_SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const TOKEN_MS = 60 * 60 * 1000;
const CODE_MS = 5 * 60 * 1000;
const LIMIT = 2048;
const secret = () => randomBytes(32).toString("base64url");
const digest = (value) => createHash("sha256").update(value).digest("base64url");
const safeNext = (value) => {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[\\\x00-\x20\x7f]/.test(value)) return "/";
  // Reject encoded slashes/backslashes too: downstream routers may decode before redirecting.
  try { if (/^[\/\\]{2}|\\|[\x00-\x1f\x7f]/.test(decodeURIComponent(value))) return "/"; } catch { return "/"; }
  return value;
};

// Assigned mode is the backwards-compatible default. automaticJoin creates a fictional
// private workspace on a browser GET /login (or validated GET /oauth/authorize).
// POST /login is deliberately unsupported in automatic mode: no credential/code API.
export function createWorkshopAuth({ origin, participants = [], storage, automaticJoin = false }) {
  if (typeof automaticJoin !== "boolean") throw new Error("Invalid automatic workshop configuration");
  const base = new URL(origin);
  if (base.origin !== origin || !["http:", "https:"].includes(base.protocol)) throw new Error("Workshop origin must be an HTTP(S) origin");
  const identities = new Map(participants.map((participant) => [digest(participant.token), participant]));
  const sessions = new Map(), clients = new Map(), codes = new Map(), tokens = new Map(), refreshes = new Map(), rates = new Map();
  const byId = new Map(participants.map((participant) => [participant.id, participant]));
  const guests = new Map();
  const participantFingerprint = (participant) => guests.get(participant.id)?.fingerprint ?? digest(participant.token);
  const tables = { sessions, clients, codes, tokens, refreshes };
  const storageKey = "workshop-auth:v1";
  let unavailable = false, closed = false, queue = Promise.resolve();
  const pendingResponses = new WeakMap();
  function snapshot() {
    return { version: 2, origin, guests: [...guests.values()], tables: Object.fromEntries(Object.entries(tables).map(([name, table]) => [name, [...table].map(([key, entry]) => {
      const { participant, ...fields } = entry;
      return [key, participant ? { ...fields, participantId: participant.id, credentialFingerprint: participantFingerprint(participant) } : fields];
    })])) };
  }
  function restore(saved) {
    if (saved === undefined) return;
    saved = structuredClone(saved);
    const invalid = () => { unavailable = true; throw new Error("Workshop authentication storage is invalid; restore a trusted backup before restarting."); };
    if (!saved || ![1, 2].includes(saved.version) || saved.origin !== origin || !saved.tables || Object.keys(saved.tables).sort().join() !== Object.keys(tables).sort().join()) invalid();
    if (Object.keys(saved).sort().join() !== (saved.version === 1 ? "origin,tables,version" : "guests,origin,tables,version")) invalid();
    // Restore the registry first; fingerprints bind durable capabilities to guests,
    // but are never bearer credentials and never enter the assigned identities map.
    if (saved.version === 2) {
      if (!Array.isArray(saved.guests)) invalid();
      const fingerprints = new Set();
      for (const guest of saved.guests) {
        if (!guest || typeof guest !== "object" || Object.keys(guest).sort().join() !== "createdAt,fingerprint,id,name" || typeof guest.id !== "string" || !/^guest-[a-f0-9]{24}$/.test(guest.id) || typeof guest.name !== "string" || guest.name.length > 80 || !/^Workshop guest [1-9][0-9]*$/.test(guest.name) || typeof guest.fingerprint !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(guest.fingerprint) || !Number.isSafeInteger(guest.createdAt) || guest.createdAt < 0 || byId.has(guest.id) || fingerprints.has(guest.fingerprint)) invalid();
        fingerprints.add(guest.fingerprint); guests.set(guest.id, guest); byId.set(guest.id, guest);
      }
    }
    for (const [name, table] of Object.entries(tables)) {
      const rows = saved.tables[name];
      // Guest browser sessions grow with the durable registry, not a cohort ceiling.
      // OAuth protocol tables retain their independent abuse-protection bounds.
      if (!Array.isArray(rows) || (name !== "sessions" && rows.length > LIMIT * 2)) invalid();
      for (const row of rows) {
        if (!Array.isArray(row) || row.length !== 2) invalid();
        const [key, entry] = row;
        if (typeof key !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(key) || table.has(key) || !entry || typeof entry !== "object" || !Number.isFinite(entry.expires) || "participant" in entry) invalid();
        const allowedFields = {
          sessions: ["participantId", "credentialFingerprint", "expires"],
          clients: ["client_id", "client_name", "redirect_uris", "token_endpoint_auth_method", "grant_types", "response_types", "scope", "expires"],
          codes: ["participantId", "credentialFingerprint", "clientId", "redirectUri", "challenge", "resource", "expires"],
          tokens: ["participantId", "credentialFingerprint", "clientId", "resource", "family", "expires"],
          refreshes: ["participantId", "credentialFingerprint", "clientId", "resource", "family", "expires", "used"],
        }[name];
        if (Object.keys(entry).sort().join() !== allowedFields.sort().join()) invalid();
        if (name === "clients") {
          if (entry.token_endpoint_auth_method !== "none" || entry.scope !== "workplace" || JSON.stringify(entry.grant_types) !== JSON.stringify(["authorization_code", "refresh_token"]) || JSON.stringify(entry.response_types) !== JSON.stringify(["code"])) invalid();
          if (entry.client_id !== key || typeof entry.client_name !== "string" || !Array.isArray(entry.redirect_uris) || !entry.redirect_uris.length || !entry.redirect_uris.every(redirectAllowed)) invalid();
        } else {
          if (typeof entry.participantId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(entry.credentialFingerprint || "")) invalid();
          if (name !== "sessions" && (typeof entry.clientId !== "string" || !resource(entry.resource))) invalid();
          if (name === "codes" && (!redirectAllowed(entry.redirectUri) || !/^[A-Za-z0-9_-]{43}$/.test(entry.challenge || ""))) invalid();
          if (["tokens", "refreshes"].includes(name) && !/^[A-Za-z0-9_-]{43}$/.test(entry.family || "")) invalid();
          if (name === "refreshes" && typeof entry.used !== "boolean") invalid();
          const participant = byId.get(entry.participantId);
          if (saved.version === 2 && (guests.has(entry.participantId) || (!participant && entry.participantId.startsWith("guest-"))) && (!guests.has(entry.participantId) || participantFingerprint(participant) !== entry.credentialFingerprint)) invalid();
          if (!participant || participantFingerprint(participant) !== entry.credentialFingerprint) continue;
          entry.participant = participant;
          delete entry.participantId; delete entry.credentialFingerprint;
        }
        if (entry.expires > Date.now()) table.set(key, entry);
      }
    }
  }
  // read may be synchronous (SQLite) or asynchronous. authenticate stays fail-closed until ready.
  let initialized = !storage, ready = Promise.resolve();
  if (storage) {
    try {
      const saved = storage.read(storageKey);
      if (saved && typeof saved.then === "function") ready = Promise.resolve(saved).then((value) => { restore(value); initialized = true; }).catch(() => { unavailable = true; });
      else { restore(saved); initialized = true; }
    } catch { unavailable = true; }
  }
  function revokeFamily(family) {
    for (const table of [tokens, refreshes]) for (const [key, entry] of table) if (entry.family === family) table.delete(key);
  }
  const cookieName = base.protocol === "https:" ? "__Host-workshop_session" : "workshop_session";
  const prune = (map) => { for (const [key, entry] of map) if (entry.expires <= Date.now()) map.delete(key); };
  function budget(req, category, maximum, failureOnly = false) {
    prune(rates);
    // Many attendees share one venue/proxy IP; authenticated approvals budget per participant.
    const identity = category === "authorize" ? browserParticipant(req)?.id : null;
    const key = `${category}:${identity ? `participant:${identity}` : req.socket?.remoteAddress || "unknown"}`;
    let entry = rates.get(key);
    if (!entry) {
      if (rates.size >= LIMIT) return false;
      entry = { count: 0, expires: Date.now() + 60000 }; rates.set(key, entry);
    }
    if (entry.count >= maximum) return false;
    if (!failureOnly) entry.count++;
    return true;
  }
  function failure(req, category) { budget(req, category, Number.MAX_SAFE_INTEGER); }
  function cookieKey(req) {
    const match = String(req.headers.cookie || "").split(";").map((part) => part.trim()).find((part) => part.startsWith(cookieName + "="));
    return match ? digest(match.slice(cookieName.length + 1)) : null;
  }
  function browserParticipant(req) {
    if (!initialized || unavailable || closed) return null;
    prune(sessions);
    return sessions.get(cookieKey(req))?.participant || null;
  }
  function resource(value) {
    try {
      const parsed = new URL(value);
      return ["/outlook/mcp", "/calendar/mcp", "/drive/mcp", "/jira/mcp", "/confluence/mcp"].some((path) => value === origin + path) && parsed.origin === origin ? parsed.href : null;
    } catch { return null; }
  }
  function authenticate(req) {
    if (!initialized || unavailable || closed) return null;
    if (req.headers.authorization !== undefined) {
      const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(req.headers.authorization);
      if (!match) return null;
      const hash = digest(match[1]);
      if (!automaticJoin && identities.has(hash)) return identities.get(hash);
      prune(tokens);
      const token = tokens.get(hash);
      if (!token || !resource(token.resource)) return null;
      const path = new URL(req.url, origin).pathname;
      const audiencePath = new URL(token.resource).pathname;
      if (path !== audiencePath) return null;
      return token.participant;
    }
    return browserParticipant(req);
  }
  function requireMutationOrigin(req) {
    if (req.headers.origin !== undefined && req.headers.origin !== origin) return false;
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return true;
    if (req.headers.authorization !== undefined) return !!authenticate(req);
    return browserOrigin(req);
  }
  function browserOrigin(req) {
    if (req.headers.origin !== undefined) return req.headers.origin === origin;
    try { return new URL(req.headers.referer).origin === origin; } catch { return false; }
  }
  function send(res, status, body, type = "application/json") {
    // Chromium sends Origin: null for native form POSTs from no-referrer pages.
    // same-origin preserves CSRF validation without leaking referrers to OAuth callbacks.
    pendingResponses.set(res, () => {
      res.writeHead(status, { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-store", "Pragma": "no-cache", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", "Content-Security-Policy": res.getHeader("Content-Security-Policy") || "default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" });
      res.end(type === "application/json" ? JSON.stringify(body) : body);
    });
  }
  const error = (res, status, name) => send(res, status, { error: name });
  function redirect(res, location) {
    pendingResponses.set(res, () => { res.writeHead(303, { Location: location, "Cache-Control": "no-store", "Referrer-Policy": "same-origin" }); res.end(); });
  }
  function setCookie(res, value, age) {
    res.setHeader("Set-Cookie", `${cookieName}=${value}; Path=/; HttpOnly; SameSite=${automaticJoin ? "Lax" : "Strict"}; Max-Age=${age}${base.protocol === "https:" ? "; Secure" : ""}`);
  }
  function browserNavigation(req) {
    if (req.headers.origin !== undefined && req.headers.origin !== origin) return false;
    // Lax supports top-level OAuth returns from different Den origins, not
    // embedded frames, images, scripts or fetches that could exhaust guest slots.
    const destination = req.headers["sec-fetch-dest"];
    if (destination !== undefined) return destination === "document" && (!req.headers["sec-fetch-mode"] || req.headers["sec-fetch-mode"] === "navigate");
    return /(?:^|[,\s])text\/html(?:[;,\s]|$)/i.test(req.headers.accept || "");
  }
  function automaticParticipant(req, res) {
    if (!browserNavigation(req)) { error(res, 403, "browser_navigation_required"); return null; }
    const existing = browserParticipant(req);
    if (existing) return existing;
    // A fresh browser is a new fictional workspace, even behind a shared venue IP.
    // Registry/session counts are not a registration quota; protocol and failed-auth
    // budgets remain separate from this credentialless browser-navigation path.
    let id;
    do { id = "guest-" + randomBytes(12).toString("hex"); } while (byId.has(id));
    const guest = { id, name: `Workshop guest ${guests.size + 1}`, fingerprint: secret(), createdAt: Date.now() };
    guests.set(id, guest); byId.set(id, guest);
    const session = secret();
    sessions.set(digest(session), { participant: guest, expires: Date.now() + AUTOMATIC_SESSION_MS });
    setCookie(res, session, AUTOMATIC_SESSION_MS / 1000);
    return guest;
  }
  async function body(req, json = false) {
    const expected = json ? "application/json" : "application/x-www-form-urlencoded";
    if (String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase() !== expected) throw { status: 415 };
    if (Number(req.headers["content-length"]) > 16384) throw { status: 413 };
    const text = await new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      const cleanup = () => {
        clearTimeout(deadline);
        req.removeListener("data", onData); req.removeListener("end", onEnd);
        req.removeListener("error", onError); req.removeListener("aborted", onAborted);
      };
      const fail = (status) => { cleanup(); req.pause(); reject({ status }); };
      const onData = (chunk) => {
        size += chunk.length;
        if (size > 16384) { fail(413); return; }
        chunks.push(chunk);
      };
      const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks).toString("utf8")); };
      const onError = () => fail(400), onAborted = () => fail(400);
      // An absolute deadline, never refreshed by trickled bytes.
      const deadline = setTimeout(() => fail(408), 5000);
      req.on("data", onData); req.once("end", onEnd);
      req.once("error", onError); req.once("aborted", onAborted);
    });
    if (json) { try { return JSON.parse(text); } catch { throw { status: 400 }; } }
    const result = new URLSearchParams(text);
    if ([...new Set(result.keys())].some((key) => result.getAll(key).length !== 1)) throw { status: 400 };
    return result;
  }
  function redirectAllowed(value) {
    try {
      const target = new URL(value);
      return !value.includes("#") && !target.origin.includes("'") && !target.username && !target.password && (target.protocol === "https:" || (target.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)));
    } catch { return false; }
  }
  function loginPage(res, next, participant = null, message = "", status = 200) {
    // Native labeled controls are appropriate for this dependency-free sandbox (DESIGN P5, C6).
    const destination = new URL(next, origin), client = clients.get(destination.searchParams.get("client_id"));
    const callback = destination.searchParams.get("redirect_uri");
    if (destination.pathname === "/oauth/authorize" && client?.redirect_uris.includes(callback)) res.setHeader("Content-Security-Policy", `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${new URL(callback).origin}; frame-ancestors 'none'; base-uri 'none'`);
    send(res, status, page("Sign in to Acme Workplace", `${participant ? `<div class="account"><span class="muted">Signed in as</span><strong>${escapeHtml(participant.name)}</strong></div>` : `<p class="muted">Use the password on your assigned workshop account card.</p>`}${message ? `<p class="error" role="alert">${escapeHtml(message)}</p>` : ""}<form action="/login" method="post"><input type="hidden" name="next" value="${escapeHtml(next)}"><p><label for="token">Workshop password</label><input id="token" name="token" type="password" autocomplete="current-password" aria-describedby="password-help" required></p><p id="password-help" class="muted">Your account name comes from the workshop roster. Do not use a work password.</p><div class="actions"><button type="submit">Sign in</button><button class="secondary" type="submit" name="decision" value="cancel" formnovalidate>Cancel</button></div></form>${participant ? `<form action="/logout" method="post"><button class="secondary" type="submit">Sign out</button></form>` : ""}`), "text/html");
  }
  function dispatch(req, res, url, parsedBody) {
    const path = url.pathname;
    const metadata = path === "/.well-known/oauth-authorization-server" || path === "/.well-known/oauth-protected-resource" || path.startsWith("/.well-known/oauth-protected-resource/");
    const clientEndpoint = path === "/oauth/register" || path === "/oauth/token" || path === "/oauth/revoke";
    if (!["/login", "/logout", "/oauth/authorize", ...(automaticJoin ? ["/signed-out"] : [])].includes(path) && !metadata && !clientEndpoint) return false;
    res.setHeader("Cache-Control", "no-store");
    if (metadata || clientEndpoint) {
      // Credentialless public OAuth clients may run on another origin. Cookies are never used here.
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return true; }
    }
    try {
      if (metadata && req.method === "GET") {
        if (path === "/.well-known/oauth-authorization-server") send(res, 200, { issuer: origin, authorization_endpoint: origin + "/oauth/authorize", token_endpoint: origin + "/oauth/token", registration_endpoint: origin + "/oauth/register", response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], revocation_endpoint: origin + "/oauth/revoke", revocation_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], scopes_supported: ["workplace"] });
        else if (path === "/.well-known/oauth-protected-resource" || resource(origin + path.slice("/.well-known/oauth-protected-resource".length))) send(res, 200, { resource: origin + path.slice("/.well-known/oauth-protected-resource".length), authorization_servers: [origin], scopes_supported: ["workplace"], bearer_methods_supported: ["header"] });
        else error(res, 404, "resource_not_found");
      } else if (automaticJoin && path === "/signed-out" && req.method === "GET") {
        send(res, 200, page("You left this workspace", `<p class="muted">Existing application connections remain active until disconnected or expired.</p><a class="button" href="/login">Open a new private workspace</a>`), "text/html");
      } else if (path === "/login" && req.method === "GET") {
        if (automaticJoin) {
          if (["token", "code", "password"].some((key) => url.searchParams.has(key))) error(res, 400, "invalid_request");
          else if (automaticParticipant(req, res)) redirect(res, safeNext(url.searchParams.get("next")));
        } else if (url.searchParams.has("token")) error(res, 400, "Access codes must be sent by POST");
        else loginPage(res, safeNext(url.searchParams.get("next")), browserParticipant(req));
      } else if ((path === "/login" || path === "/logout") && req.method === "POST") {
        if (!browserOrigin(req)) { error(res, 403, "Same-origin request required"); return true; }
        if (path === "/logout") { sessions.delete(cookieKey(req)); setCookie(res, "", 0); redirect(res, automaticJoin ? "/signed-out" : "/login"); return true; }
        if (automaticJoin) { error(res, 405, "method_not_allowed"); return true; }
        const form = parsedBody;
        if (form.get("decision") === "cancel") {
          const next = new URL(safeNext(form.get("next")), origin);
          const client = clients.get(next.searchParams.get("client_id"));
          const callback = next.searchParams.get("redirect_uri");
          if (next.pathname === "/oauth/authorize" && client && client.expires > Date.now() && client.redirect_uris.includes(callback)) {
            const target = new URL(callback); target.searchParams.set("error", "access_denied");
            if (next.searchParams.has("state")) target.searchParams.set("state", next.searchParams.get("state"));
            redirect(res, target.href);
          } else redirect(res, "/");
          return true;
        }
        const participant = identities.get(digest(form.get("token") || ""));
        if (!participant) {
          if (!budget(req, "login", 20, true)) { error(res, 429, "too_many_requests"); return true; }
          failure(req, "login"); loginPage(res, safeNext(form.get("next")), null, "That workshop password was not recognized. Check your account card or ask the workshop host for a new password.", 401); return true;
        }
        if (!budget(req, `session:${participant.id}`, 30)) { error(res, 429, "too_many_requests"); return true; }
        prune(sessions); sessions.delete(cookieKey(req));
        const ownSessions = [...sessions].filter(([, entry]) => entry.participant.id === participant.id);
        if (ownSessions.length >= 8) sessions.delete(ownSessions[0][0]);
        if (sessions.size >= LIMIT) { error(res, 503, "temporarily_unavailable"); return true; }
        const session = secret(); sessions.set(digest(session), { participant, expires: Date.now() + SESSION_MS });
        setCookie(res, session, SESSION_MS / 1000); redirect(res, safeNext(form.get("next")));
      } else if (path === "/oauth/register" && req.method === "POST") {
        if (!budget(req, "register", 600)) { error(res, 429, "too_many_requests"); return true; }
        const data = parsedBody;
        if (!data || !Array.isArray(data.redirect_uris) || !data.redirect_uris.length || data.redirect_uris.length > 10 || !data.redirect_uris.every((uri) => typeof uri === "string" && uri.length <= 2048 && redirectAllowed(uri)) || (data.token_endpoint_auth_method !== undefined && data.token_endpoint_auth_method !== "none") || (data.grant_types !== undefined && (!Array.isArray(data.grant_types) || !data.grant_types.includes("authorization_code") || data.grant_types.some((grant) => !["authorization_code", "refresh_token"].includes(grant)) || new Set(data.grant_types).size !== data.grant_types.length)) || (data.response_types !== undefined && (!Array.isArray(data.response_types) || data.response_types.length !== 1 || data.response_types[0] !== "code")) || (data.scope !== undefined && data.scope !== "workplace")) { error(res, 400, "invalid_client_metadata"); return true; }
        prune(clients);
        if (clients.size >= 1024) { error(res, 503, "temporarily_unavailable"); return true; }
        const client = { client_id: secret(), client_name: typeof data.client_name === "string" ? data.client_name.slice(0, 120) : "Workshop MCP client", redirect_uris: [...new Set(data.redirect_uris)], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope: "workplace" };
        clients.set(client.client_id, { ...client, expires: Date.now() + SESSION_MS }); send(res, 201, client);
      } else if (path === "/oauth/authorize" && ["GET", "POST"].includes(req.method)) {
        if (!requireMutationOrigin(req) || (req.method === "POST" && !browserOrigin(req))) { error(res, 403, "Same-origin request required"); return true; }
        if (!budget(req, "authorize", browserParticipant(req) ? 120 : 600)) { error(res, 429, "too_many_requests"); return true; }
        const query = req.method === "POST" ? parsedBody : url.searchParams;
        if ([...new Set(query.keys())].some((key) => query.getAll(key).length !== 1)) { error(res, 400, "invalid_request"); return true; }
        prune(clients); const client = clients.get(query.get("client_id"));
        const redirectUri = query.get("redirect_uri");
        if (!client || !client.redirect_uris.includes(redirectUri)) { error(res, 400, "invalid_request"); return true; }
        if (query.get("response_type") !== "code" || query.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(query.get("code_challenge") || "") || (query.has("scope") && query.get("scope") !== "workplace") || !resource(query.get("resource"))) { error(res, 400, "invalid_request"); return true; }
        let participant = browserParticipant(req);
        if (automaticJoin && req.method === "GET") {
          participant = automaticParticipant(req, res);
          if (!participant) return true;
        }
        if (!participant) {
          if (automaticJoin) error(res, 401, "browser_session_required");
          else redirect(res, "/login?next=" + encodeURIComponent(safeNext("/oauth/authorize?" + query.toString())));
          return true;
        }
        if (req.method === "GET") {
          const permissions = {
            "/outlook/mcp": ["Read sample mail and threads.", "Draft, send or update fictional messages."],
            "/calendar/mcp": ["Read your sample calendar and availability.", "Create, update or cancel fictional events."],
            "/drive/mcp": ["Read and search sample workplace files.", "Create or update fictional files."],
            "/jira/mcp": ["Read sample projects and issues.", "Create or update fictional issues and comments."],
            "/confluence/mcp": ["Read and search sample spaces and pages.", "Create or update fictional pages."],
          }[new URL(query.get("resource")).pathname];
          const fields = [...query].map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`).join("");
          // Chromium checks the final redirect of a form POST against form-action too.
          // Only this client's already-validated callback origin is added to the consent form.
          res.setHeader("Content-Security-Policy", `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${new URL(redirectUri).origin}; frame-ancestors 'none'; base-uri 'none'`);
          send(res, 200, page(`Connect ${client.client_name}`, `<div class="account"><span class="muted">${automaticJoin ? "Private workspace" : "Signed in as"}</span><strong>${escapeHtml(participant.name)}</strong></div><h2>Application requesting access</h2><p>${escapeHtml(client.client_name)}<br><span class="muted">${escapeHtml(new URL(redirectUri).host)} · Unverified workshop application</span></p><h2>Workplace permissions</h2><ul class="permissions">${permissions.map((permission) => `<li>${escapeHtml(permission)}</li>`).join("")}<li>Keep this connection active for up to 8 hours.</li></ul><p class="muted">${automaticJoin ? "Only this private fictional workspace is shared. This guest label is not a verified person." : "Only your assigned sandbox account is shared."} No real work accounts are connected.</p><details><summary>Connection details</summary><p>Resource: <code>${escapeHtml(query.get("resource") || origin)}</code></p><p>Scope: <code>workplace</code></p><p>Access expires after 1 hour. Sign out ends the browser session; the application can disconnect to revoke its connection.</p></details><form action="/oauth/authorize" method="post">${fields}<div class="actions"><button type="submit" name="decision" value="allow">Allow workplace access</button><button class="secondary" type="submit" name="decision" value="deny">Deny access</button></div></form>`), "text/html"); return true;
        }
        if ((automaticJoin && !query.has("decision")) || (query.has("decision") && !["allow", "deny"].includes(query.get("decision")))) { error(res, 400, "invalid_request"); return true; }
        if (query.get("decision") === "deny") {
          const target = new URL(redirectUri); target.searchParams.set("error", "access_denied");
          if (query.has("state")) target.searchParams.set("state", query.get("state"));
          redirect(res, target.href); return true;
        }
        prune(codes);
        if ([...codes.values()].filter((entry) => entry.participant.id === participant.id).length >= 16) { error(res, 429, "authorization_quota_reached"); return true; }
        if (codes.size >= LIMIT) { error(res, 503, "temporarily_unavailable"); return true; }
        const code = secret(); codes.set(digest(code), { participant, clientId: client.client_id, redirectUri, challenge: query.get("code_challenge"), resource: resource(query.get("resource")), expires: Date.now() + CODE_MS });
        const target = new URL(redirectUri); target.searchParams.set("code", code);
        if (query.has("state")) target.searchParams.set("state", query.get("state"));
        redirect(res, target.href);
      } else if (path === "/oauth/token" && req.method === "POST") {
        const form = parsedBody;
        prune(codes); prune(clients); prune(tokens); prune(refreshes);
        if (form.get("grant_type") === "refresh_token") {
          const refresh = refreshes.get(digest(form.get("refresh_token") || ""));
          const validBinding = refresh && clients.has(form.get("client_id")) && refresh.clientId === form.get("client_id") && (resource(form.get("resource")) && resource(form.get("resource")) === refresh.resource) && (!form.has("scope") || form.get("scope") === "workplace");
          if (!validBinding) { error(res, 400, "invalid_grant"); return true; }
          if (refresh.used) { revokeFamily(refresh.family); error(res, 400, "invalid_grant"); return true; }
          if (!budget(req, `refresh:${refresh.participant.id}`, 120)) { error(res, 429, "too_many_requests"); return true; }
          // Keep used hashes for the family's original lifetime to detect replay across restarts.
          if ([...refreshes.values()].filter((entry) => entry.participant.id === refresh.participant.id).length >= 256 || refreshes.size >= LIMIT * 2) { error(res, 429, "refresh_quota_reached"); return true; }
          refresh.used = true;
          issueTokens(res, refresh, refresh.expires); return true;
        }
        if (form.get("grant_type") !== "authorization_code") { error(res, 400, "unsupported_grant_type"); return true; }
        const codeKey = digest(form.get("code") || ""), code = codes.get(codeKey);
        // A failed redemption also consumes the code, preventing verifier guessing and retries.
        codes.delete(codeKey);
        const verifier = form.get("code_verifier") || "";
        if (form.get("grant_type") !== "authorization_code" || !code || !clients.has(form.get("client_id")) || code.clientId !== form.get("client_id") || code.redirectUri !== form.get("redirect_uri") || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || digest(verifier) !== code.challenge || (!resource(form.get("resource")) || resource(form.get("resource")) !== code.resource) || (form.has("scope") && form.get("scope") !== "workplace")) {
          if (!budget(req, "token", 20, true)) { error(res, 429, "too_many_requests"); return true; }
          failure(req, "token"); error(res, 400, "invalid_grant"); return true;
        }
        const ownFamilies = new Set([...refreshes.values()].filter((entry) => entry.participant.id === code.participant.id).map((entry) => entry.family));
        if (ownFamilies.size >= 32 || [...refreshes.values()].filter((entry) => entry.participant.id === code.participant.id).length >= 256) { error(res, 429, "connection_quota_reached"); return true; }
        if (tokens.size >= LIMIT * 2 || refreshes.size >= LIMIT * 2) { error(res, 503, "temporarily_unavailable"); return true; }
        issueTokens(res, { participant: code.participant, clientId: code.clientId, resource: code.resource, family: secret() }, Date.now() + SESSION_MS);
      } else if (path === "/oauth/revoke" && req.method === "POST") {
        const form = parsedBody;
        prune(clients); prune(tokens); prune(refreshes);
        if (!form.get("token")) { error(res, 400, "invalid_request"); return true; }
        if (!clients.has(form.get("client_id"))) { error(res, 400, "invalid_client"); return true; }
        const key = digest(form.get("token") || "");
        const entry = refreshes.get(key) || tokens.get(key);
        // RFC 7009: unknown, already revoked or differently bound tokens all return 200.
        if (entry && entry.clientId === form.get("client_id") && (!form.has("resource") || (resource(form.get("resource")) && resource(form.get("resource")) === entry.resource))) revokeFamily(entry.family);
        send(res, 200, {});
      } else error(res, 405, "method_not_allowed");
    } catch (caught) { error(res, caught.status || 400, "invalid_request"); }
    return true;
  }
  function issueTokens(res, grant, expires) {
    const ownTokens = [...tokens].filter(([, entry]) => entry.participant.id === grant.participant.id);
    if (ownTokens.length >= 32) tokens.delete(ownTokens[0][0]);
    if (tokens.size >= LIMIT * 2) { error(res, 503, "temporarily_unavailable"); return; }
    const access = secret(), refresh = secret(), now = Date.now(), accessExpires = Math.min(now + TOKEN_MS, expires);
    const fields = { participant: grant.participant, clientId: grant.clientId, resource: grant.resource, family: grant.family };
    tokens.set(digest(access), { ...fields, expires: accessExpires });
    refreshes.set(digest(refresh), { ...fields, expires, used: false });
    send(res, 200, { access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: Math.floor((accessExpires - now) / 1000), scope: "workplace" });
  }
  function flush(res) {
    const response = pendingResponses.get(res);
    pendingResponses.delete(res); response?.();
  }
  function immediateError(req, res, status, name, closeConnection = false) {
    // This writer is request-local, including while another request awaits its durable commit.
    if (closeConnection) {
      req.pause(); res.setHeader("Connection", "close");
      res.once("finish", () => req.destroy());
    }
    error(res, status, name); flush(res);
    return true;
  }
  async function handle(req, res, url) {
    await ready;
    if (unavailable || closed) return immediateError(req, res, 503, "authentication_unavailable");
    const path = url.pathname;
    // Automatic GETs can create a session: commit the registry + hashed cookie
    // atomically before returning either a redirect or the explicit consent page.
    const automaticGet = automaticJoin && req.method === "GET" && ["/login", "/oauth/authorize"].includes(path);
    const mutation = automaticGet || (req.method === "POST" && ["/login", "/logout", "/oauth/authorize", "/oauth/register", "/oauth/token", "/oauth/revoke"].includes(path));
    if (!mutation) {
      // Normal MCP/UI traffic never joins the authentication mutation queue.
      const handled = dispatch(req, res, url); flush(res); return handled;
    }
    if (req.method === "POST" && ["/login", "/logout", "/oauth/authorize"].includes(path) && !browserOrigin(req)) return immediateError(req, res, 403, "Same-origin request required", true);
    if (["/oauth/register", "/oauth/token", "/oauth/revoke"].includes(path)) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }
    let parsedBody;
    try { if (req.method === "POST") parsedBody = await body(req, path === "/oauth/register"); }
    catch (caught) { return immediateError(req, res, caught.status || 400, caught.status === 408 ? "request_timeout" : "invalid_request", true); }
    // Only completed, bounded bodies may serialize mutation + atomic storage commit.
    const operation = queue.then(async () => {
      if (unavailable || closed) return immediateError(req, res, 503, "authentication_unavailable");
      const handled = dispatch(req, res, url, parsedBody);
      if (!handled || res.writableEnded) return handled;
      try { if (storage) await storage.write(storageKey, snapshot()); }
      catch {
        unavailable = true;
        res.removeHeader("Set-Cookie"); res.removeHeader("Location");
        error(res, 503, "authentication_unavailable");
      }
      flush(res); return handled;
    });
    queue = operation.catch(() => { unavailable = true; });
    return operation;
  }
  return { authenticate, handle, requireMutationOrigin, isReady: () => initialized && !unavailable && !closed, async close() {
    closed = true;
    await queue; await ready;
    for (const table of Object.values(tables)) table.clear(); rates.clear();
    await storage?.close();
  } };
}
