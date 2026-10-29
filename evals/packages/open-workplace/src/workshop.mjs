#!/usr/bin/env node
// Opt-in workshop ingress. Never publish the raw fixture ports alongside this service.
// Each participant owns one private process with three loopback-only HTTP services and separate data.
import { createServer, request as httpRequest } from "node:http";
import { fork } from "node:child_process";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { readFile, mkdir, rm, rename } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { createSnapshotStore } from "./workshop-store.mjs";
import { fileURLToPath } from "node:url";
import { createWorkshopAuth } from "./workshop-auth.mjs";
import { workshopPage as page, escapeHtml as escape } from "./workshop-html.mjs";

const MAX_BODY = 10 * 1024 * 1024;
const MAX_RESPONSE = 16 * 1024 * 1024;
const key = () => randomBytes(32).toString("base64url");

export function validateParticipants(value) {
  if (!Array.isArray(value) || value.length < 1) throw new Error("Configure at least one workshop participant.");
  const ids = new Set(), tokens = new Set();
  for (const participant of value) {
    if (!participant || !/^[a-z][a-z0-9-]{0,47}$/.test(participant.id) || ids.has(participant.id)) throw new Error("Participant IDs must be unique lowercase handles.");
    if (typeof participant.name !== "string" || !participant.name.trim() || participant.name.length > 80 || /[|\x00-\x1f<>]/.test(participant.name)) throw new Error("Participant names must be plain text, 1–80 characters.");
    if (typeof participant.token !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(participant.token) || tokens.has(participant.token)) throw new Error("Give each participant a unique random token of at least 32 characters.");
    ids.add(participant.id); tokens.add(participant.token);
  }
  return value.map(({ id, name, token }) => Object.freeze({ id, name, token }));
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": typeof body === "string" ? "text/html; charset=utf-8" : "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "same-origin", "content-security-policy": "default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", ...headers });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}

function worker(script, env) {
  return new Promise((resolve, reject) => {
    // Do not pass the gateway's participant credentials or the host's provider secrets to fixtures.
    const child = fork(fileURLToPath(new URL(script, import.meta.url)), [], { env: { HOST: "127.0.0.1", PORT: "0", ...env }, silent: true, execArgv: [] });
    child.stdout.resume(); child.stderr.resume();
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Service startup timed out.")); }, 15000);
    const failed = () => { clearTimeout(timer); reject(new Error("A private service could not start.")); };
    child.once("error", failed); child.once("exit", failed);
    child.on("message", (message) => {
      if (message?.type !== "workshop-ready" || !message.ports || Object.keys(message.ports).sort().join() !== "atlassian,microsoft,web" || !Object.values(message.ports).every((port) => Number.isInteger(port) && port > 0 && port <= 65535)) return;
      clearTimeout(timer); child.removeListener("exit", failed); child.removeListener("error", failed);
      resolve({ child, origins: Object.fromEntries(Object.entries(message.ports).map(([name, port]) => [name, `http://127.0.0.1:${port}`])) });
    });
  });
}

function backend(path) {
  if (/^\/(?:outlook|calendar|drive)\/mcp$/.test(path)) return "microsoft";
  if (/^\/(?:jira|confluence)\/mcp$/.test(path)) return "atlassian";
  if (/^\/(?:jira|confluence)\/rest\//.test(path)) return "atlassian";
  if (/^\/(?:jira|confluence)(?:\/|$)/.test(path) || path.startsWith("/api/atlassian/") || ["/app.js", "/styles.css"].includes(path)) return "web";
  if (/^\/(?:outlook|calendar|drive|onedrive)$/.test(path) || /^\/(?:v1\.0|graph\/v1\.0|download|preview)\//.test(path)) return "microsoft";
  return null;
}

export async function startWorkshop({ participants = [], origin, host = "127.0.0.1", port = 3990, dataDir, joinMode = "assigned", idleEvictionMs = 60_000, resetToken = process.env.OPEN_WORKPLACE_RESET_TOKEN } = {}) {
  if (!["assigned", "automatic"].includes(joinMode)) throw new Error("Workshop join mode must be automatic or assigned.");
  if (!Number.isInteger(idleEvictionMs) || idleEvictionMs < 0) throw new Error("Invalid workshop idle timeout.");
  if (resetToken !== undefined && (typeof resetToken !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(resetToken) || new Set(resetToken).size < 16 || participants.some((person) => person.token === resetToken))) throw new Error("Configure a separate random operator reset secret of at least 32 characters.");
  const resetDigest = resetToken === undefined ? null : createHash("sha256").update(resetToken).digest();
  const roster = joinMode === "automatic" && Array.isArray(participants) && participants.length === 0 ? [] : validateParticipants(participants);
  const startedAt = new Date().toISOString();
  let publicOrigin = origin ? new URL(origin).origin : null;
  if (origin && (!/^https?:$/.test(new URL(origin).protocol) || new URL(origin).username || new URL(origin).password || new URL(origin).pathname !== "/" || new URL(origin).search || new URL(origin).hash)) throw new Error("PUBLIC_URL must be an HTTP(S) origin without credentials, path, query or fragment.");
  const loopbackListener = ["127.0.0.1", "localhost", "::1"].includes(host);
  if (!publicOrigin && !loopbackListener) throw new Error("Set PUBLIC_URL when exposing a workshop beyond loopback.");
  if (publicOrigin?.startsWith("http:") && (!loopbackListener || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(publicOrigin).hostname))) throw new Error("Hosted workshops require an HTTPS PUBLIC_URL; HTTP is only allowed on a loopback listener and origin.");
  if (dataDir !== undefined && (typeof dataDir !== "string" || !isAbsolute(dataDir))) throw new Error("OPEN_WORKPLACE_DATA_DIR must be an absolute private directory.");
  if (dataDir) await mkdir(join(dataDir, "participants"), { recursive: true, mode: 0o700 });
  const storage = dataDir ? createSnapshotStore({ file: join(dataDir, "auth.sqlite") }) : undefined;
  // Keep the fictional business baseline stable through reset, eviction and restart.
  // This is workshop metadata, not participant data or OAuth state.
  const sampleClock = storage?.read("workshop-sample-clock") ?? startedAt;
  storage?.write("workshop-sample-clock", sampleClock);
  const stacks = new Map(), uploads = new Map(), active = new Map(), resetting = new Set(), idleTimers = new Map(), disposals = new Map();
  const handlers = new Set(), cleanups = new Set();
  let auth, closing = false, resetAll = false, admissions = Promise.resolve();
  function cancelIdle(id) { clearTimeout(idleTimers.get(id)); idleTimers.delete(id); }
  function scheduleIdle(id) {
    cancelIdle(id);
    // Memory-only workspaces cannot be unloaded without losing their saved work.
    if (!dataDir || closing || resetAll || resetting.has(id) || active.get(id) || !stacks.has(id)) return;
    const timer = setTimeout(async () => {
      idleTimers.delete(id);
      if (closing || resetAll || resetting.has(id) || active.get(id)) return;
      try { await disposeStack(id); } catch { /* A failed worker is retried on the next request. */ }
    }, idleEvictionMs);
    timer.unref(); idleTimers.set(id, timer);
  }
  function invalidateUploads(id) { for (const [token, entry] of uploads) if (entry.participant.id === id) uploads.delete(token); }
  async function createStack(participant) {
    const env = { OPEN_WORKPLACE_NOW: sampleClock, OPEN_WORKPLACE_PERSON: `${participant.name}|${participant.id}|Workshop participant`, PUBLIC_URL: publicOrigin, UPLOAD_URL: publicOrigin, JIRA_PUBLIC_URL: `${publicOrigin}/jira`, CONFLUENCE_PUBLIC_URL: `${publicOrigin}/confluence`, OPEN_WORKPLACE_GATEWAY: "1" };
    const directory = dataDir ? join(dataDir, "participants", participant.id) : undefined;
    if (directory) await mkdir(directory, { recursive: true, mode: 0o700 });
    const service = await worker("./workshop-worker.mjs", { ...env, ...(directory ? { OPEN_WORKPLACE_PARTICIPANT_DATA_DIR: directory } : {}) });
    const stack = { ...Object.fromEntries(["microsoft", "atlassian", "web"].map((name) => [name, { child: service.child, origin: service.origins[name] }])), failed: false, stopped: false };
    service.child.once("exit", () => { if (!stack.stopped) { stack.failed = true; invalidateUploads(participant.id); } });
    return stack;
  }
  function stackFor(participant) {
    cancelIdle(participant.id);
    if (closing || resetAll) throw new Error("Workshop is unavailable.");
    if (stacks.has(participant.id)) return stacks.get(participant.id);
    // Serialize identity reservation, not admission: there is no worker quota.
    const admitted = admissions.then(() => {
      if (closing || resetAll) throw new Error("Workshop is unavailable.");
      if (!stacks.has(participant.id)) {
        const pending = createStack(participant);
        stacks.set(participant.id, pending);
        pending.catch(() => { if (stacks.get(participant.id) === pending) stacks.delete(participant.id); });
      }
      return { pending: stacks.get(participant.id) };
    });
    admissions = admitted.then(() => undefined, () => undefined);
    return admitted.then(({ pending }) => pending);
  }
  function disposeStack(id) {
    cancelIdle(id);
    if (disposals.has(id)) return disposals.get(id);
    const pending = stacks.get(id);
    if (!pending) { invalidateUploads(id); return Promise.resolve(); }
    // Keep the entry until the owned child has flushed and stopped.
    const disposal = (async () => {
      try { const stack = await pending; stack.stopped = true; await stop(stack.microsoft.child); }
      finally { stacks.delete(id); invalidateUploads(id); disposals.delete(id); }
    })();
    disposals.set(id, disposal);
    return disposal;
  }
  function capabilityUrls(bytes, participant, isMcp) {
    const result = JSON.parse(bytes.toString("utf8"));
    const wrap = (pending) => {
      if (typeof pending?.uploadUrl !== "string") return;
      const url = new URL(pending.uploadUrl);
      if (url.origin !== publicOrigin || !/^\/upload\/[0-9a-f-]{36}$/.test(url.pathname) || url.search || url.hash) throw new Error("Unexpected upload destination.");
      const token = key();
      uploads.set(token, { participant, path: url.pathname, expires: Date.now() + 15 * 60 * 1000 });
      pending.uploadUrl = `${publicOrigin}/_workshop/uploads/${token}`;
    };
    if (isMcp) {
      if (!result.result?.isError && result.result?.content?.[0]?.type === "text") {
        const pending = JSON.parse(result.result.content[0].text); wrap(pending);
        result.result.content[0].text = JSON.stringify(pending);
      }
    } else wrap(result);
    return Buffer.from(JSON.stringify(result));
  }
  async function proxy(req, res, participant, service, path, uploadToken) {
    const stack = await stackFor(participant);
    if (stack.failed) return send(res, 503, { error: "sandbox_stopped", message: "Your private sandbox stopped. Reset your sample data to start again." });
    const destination = new URL(path, stack[service].origin);
    if (destination.origin !== stack[service].origin) throw new Error("Unexpected private service destination.");
    const privatePort = Number(new URL(stack[service].origin).port);
    if (!Number.isInteger(privatePort) || privatePort < 1 || privatePort > 65535) throw new Error("Invalid private service port.");
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) return send(res, 413, { error: "body_too_large" }); chunks.push(chunk); }
    if (closing) return send(res, 503, { error: "workshop_stopping" });
    const requestPath = new URL(path, stack[service].origin).pathname;
    let isMcpUpload = false;
    if (service === "microsoft" && requestPath === "/drive/mcp" && req.method === "POST") {
      try { const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8")); isMcpUpload = rpc.method === "tools/call" && rpc.params?.name === "file_create_upload_session"; } catch { /* Let the fixture return its normal JSON-RPC parse error. */ }
    }
    let graphPath = "";
    try { graphPath = decodeURIComponent(requestPath); } catch { /* The fixture returns its normal malformed-path error. */ }
    const isUploadCreation = req.method === "POST" && service === "microsoft" && (isMcpUpload || /^\/(?:graph\/)?v1\.0\/me\/drive\/root:\/.+:\/createUploadSession$/.test(graphPath));
    for (const [token, item] of uploads) if (item.expires < Date.now()) uploads.delete(token);
    const headers = { accept: req.headers.accept || "*/*", authorization: service === "microsoft" ? "Bearer open-workplace-token" : "Bearer open-workplace-pat", host: new URL(publicOrigin).host };
    for (const name of ["content-type", "if-match", "if-none-match", "x-csrf-token", "mcp-protocol-version", "mcp-session-id"]) if (req.headers[name]) headers[name] = req.headers[name];
    // Browser origin has already been checked at the only public ingress.
    headers.origin = publicOrigin;
    if (size) headers["content-length"] = size;
    await new Promise((resolve) => {
      // The network destination is fixed by the owned child's ready receipt, never an HTTP caller.
      const upstream = httpRequest({ protocol: "http:", hostname: "127.0.0.1", port: privatePort, path: destination.pathname + destination.search, method: req.method, headers, timeout: 15000 }, (response) => {
        const parts = []; let length = 0;
        response.on("data", (chunk) => { length += chunk.length; if (length > MAX_RESPONSE) response.destroy(new Error("Response limit exceeded.")); else parts.push(chunk); });
        response.on("error", () => { if (!res.headersSent) send(res, 502, { error: "service_unavailable" }); resolve(); });
        response.on("end", () => {
          try {
            let body = Buffer.concat(parts);
            const outgoing = { "cache-control": "no-store", "referrer-policy": "same-origin", "x-content-type-options": "nosniff" };
            for (const name of ["content-type", "content-disposition", "etag", "content-security-policy", "allow", "mcp-session-id"]) if (response.headers[name]) outgoing[name] = response.headers[name];
            if (isUploadCreation && response.statusCode >= 200 && response.statusCode < 300) body = capabilityUrls(body, participant, isMcpUpload);
            if (response.headers.location) {
              const location = new URL(response.headers.location, publicOrigin);
              if (location.origin !== publicOrigin) throw new Error("Unexpected upstream redirect.");
              outgoing.location = location.pathname + location.search;
            }
            if (uploadToken && response.statusCode >= 200 && response.statusCode < 300) uploads.delete(uploadToken);
            res.writeHead(response.statusCode, outgoing); res.end(body); resolve();
          } catch { if (!res.headersSent) send(res, 502, { error: "invalid_service_response" }); resolve(); }
        });
      });
      upstream.on("timeout", () => upstream.destroy());
      upstream.on("error", () => { if (!res.headersSent) send(res, 502, { error: "service_unavailable" }); resolve(); });
      res.once("close", () => upstream.destroy());
      upstream.end(size ? Buffer.concat(chunks) : undefined);
    });
  }
  async function operatorReset(req, res, url) {
    if (!resetDigest) return send(res, 404, { error: "not_found" });
    if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" }, { allow: "POST" });
    const supplied = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(req.headers.authorization || "");
    if (!supplied || !timingSafeEqual(createHash("sha256").update(supplied[1]).digest(), resetDigest)) return send(res, 403, { error: "access_denied" });
    if (req.headers.origin && req.headers.origin !== publicOrigin) return send(res, 403, { error: "cross_origin_denied" });
    if (url.search || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers["content-type"] || "")) return send(res, 400, { error: "invalid_reset_request" });
    if (Number(req.headers["content-length"] || 0) > 1024) return send(res, 413, { error: "body_too_large" });
    const timer = setTimeout(() => req.destroy(), 5000); timer.unref();
    let body;
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 1024) return send(res, 413, { error: "body_too_large" }); chunks.push(chunk); }
      const text = Buffer.concat(chunks).toString("utf8");
      // The one-field confirmation has no extensions or duplicate-key ambiguity.
      if (!/^\s*\{\s*"confirm"\s*:\s*"RESET ALL SAMPLE DATA"\s*\}\s*$/.test(text)) return send(res, 400, { error: "confirmation_required" });
      body = JSON.parse(text);
    } finally { clearTimeout(timer); }
    if (!body || Array.isArray(body) || Object.keys(body).length !== 1 || body.confirm !== "RESET ALL SAMPLE DATA") return send(res, 400, { error: "confirmation_required" });
    if (closing) return send(res, 503, { error: "workshop_stopping" });
    // Do not partially reset a busy workshop. The lock blocks every ingress, including auth,
    // while workers flush. Retrying is explicit; there is no destructive background queue.
    if (resetAll || handlers.size > 1 || resetting.size) return send(res, 409, { error: "workshop_busy" });
    resetAll = true;
    let trash;
    try {
      for (const id of idleTimers.keys()) cancelIdle(id);
      await admissions;
      const workers = stacks.size;
      await Promise.all([...stacks.keys()].map(disposeStack));
      uploads.clear();
      if (dataDir) {
        const root = join(dataDir, "participants");
        trash = join(dataDir, `participants-reset-${Date.now()}-${randomBytes(8).toString("hex")}`);
        await rename(root, trash);
        try { await mkdir(root, { mode: 0o700 }); }
        catch (error) { await rename(trash, root); trash = undefined; throw error; }
      }
      return send(res, 200, { ok: true, reset: "all-sample-data", workersStopped: workers });
    } finally {
      resetAll = false;
      if (trash) {
        const cleanup = rm(trash, { recursive: true, force: true }).catch(() => {}).finally(() => cleanups.delete(cleanup));
        cleanups.add(cleanup);
      }
    }
  }
  const server = createServer(async (req, res) => {
    let participant, counted = false, claimedUpload, finish;
    const done = new Promise((resolve) => { finish = resolve; }); handlers.add(done);
    try {
      if (closing) return send(res, 503, { error: "workshop_stopping" });
      if (resetAll) return send(res, 409, { error: "workshop_resetting" });
      // Reject absolute-form targets, encoded separators and dot-segment aliases before routing.
      if (!req.url?.startsWith("/") || req.url.startsWith("//") || /\\|%2f|%5c|%2e|[\x00-\x20]/i.test(req.url.split("?")[0])) return send(res, 400, { error: "invalid_path" });
      const url = new URL(req.url, publicOrigin);
      if (url.pathname === "/_workshop/reset-all") return await operatorReset(req, res, url);
      if (url.pathname === "/health" && req.method === "GET") return send(res, auth?.isReady() ? 200 : 503, { ok: Boolean(auth?.isReady()), service: "open-workplace-workshop", isolated: true, storage: dataDir ? "sqlite" : "memory", joinMode, startedAt });
      if (await auth.handle(req, res, url)) return;
      participant = auth.authenticate(req);
      let uploadToken;
      const upload = /^\/_workshop\/uploads\/([A-Za-z0-9_-]{43})$/.exec(url.pathname);
      if (upload) {
        const entry = uploads.get(upload[1]);
        if (!entry || entry.expires < Date.now()) return send(res, 404, { error: "upload_expired" });
        if (req.method !== "PUT") return send(res, 405, { error: "upload_only" }, { allow: "PUT" });
        if (req.headers.authorization && !participant || participant && participant.id !== entry.participant.id) return send(res, 403, { error: "access_denied" });
        if (req.headers.origin && req.headers.origin !== publicOrigin) return send(res, 403, { error: "cross_origin_denied" });
        participant = entry.participant; uploadToken = upload[1];
      }
      if (!participant) {
        if (req.method === "GET" && String(req.headers.accept).includes("text/html")) return send(res, 303, "", { location: `/login?next=${encodeURIComponent(url.pathname + url.search)}` });
        return send(res, 401, { error: "authentication_required" }, { "www-authenticate": `Bearer resource_metadata="${publicOrigin}/.well-known/oauth-protected-resource${url.pathname.endsWith("/mcp") ? url.pathname : ""}"` });
      }
      if (!uploadToken && !auth.requireMutationOrigin(req)) return send(res, 403, { error: "cross_origin_denied" });
      if (resetting.has(participant.id)) return send(res, 409, { error: "sandbox_resetting" });
      cancelIdle(participant.id);
      if (disposals.has(participant.id)) await disposals.get(participant.id);
      if (closing) return send(res, 503, { error: "workshop_stopping" });
      if (resetting.has(participant.id)) return send(res, 409, { error: "sandbox_resetting" });
      const count = active.get(participant.id) || 0;
      active.set(participant.id, count + 1); counted = true;
      if (uploadToken) {
        const entry = uploads.get(uploadToken);
        if (entry.inFlight) return send(res, 409, { error: "upload_in_progress" });
        entry.inFlight = true; claimedUpload = entry;
      }
      if (url.pathname === "/" && req.method === "GET") return send(res, 200, page(participant.name, `<p class="muted">Private workshop sandbox · Fictional sample data</p>${joinMode === "automatic" ? '<p>Your private workspace is remembered in this browser. No password or account card is needed.</p><p class="muted">Use a separate browser profile per person. Clearing cookies or switching devices starts a new workspace.</p>' : ''}<nav><a href="/outlook">Open Outlook</a><a href="/calendar">Open Calendar</a><a href="/drive">Open Drive</a><a href="/jira">Open Jira</a><a href="/confluence">Open Confluence</a></nav><details><summary>Connect to OpenWork</summary><p>Use OAuth with these connector addresses:</p><ul>${["outlook", "calendar", "drive", "jira", "confluence"].map((name) => `<li>${escape(publicOrigin)}/${name}/mcp</li>`).join("")}</ul></details><p><a href="/_workshop/reset">Reset my sample data</a></p>${joinMode === "automatic" ? '<p><a href="/_workshop/leave">Forget this browser’s workspace</a></p>' : '<form method="post" action="/logout"><button>Sign out</button></form>'}`));
      if (joinMode === "automatic" && url.pathname === "/_workshop/leave" && req.method === "GET") return send(res, 200, page("Forget this browser’s workspace?", '<p>This removes this browser’s access to the current private workspace. Opening the link again will create a different workspace. There is no password or sign-in account to recover this browser access.</p><p>Saved data is not deleted. Connected apps keep their independent OAuth grants until they expire or are revoked.</p><form method="post" action="/logout"><button>Forget this browser’s workspace</button></form><p><a href="/">Keep my workspace</a></p>'));
      if (url.pathname === "/_workshop/reset") {
        if (req.method === "GET") return send(res, 200, page("Reset my sample data?", '<p>This deletes your workshop changes in all five services. Other participants are not affected.</p><form method="post"><button>Reset my sample data</button></form><p><a href="/">Keep my changes</a></p>'));
        if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" });
        if ((active.get(participant.id) || 0) > 1) return send(res, 409, { error: "sandbox_busy", message: "Finish your current requests before resetting." });
        resetting.add(participant.id);
        try {
          await disposeStack(participant.id);
          if (dataDir) await rm(join(dataDir, "participants", participant.id), { recursive: true, force: true });
        } finally { resetting.delete(participant.id); }
        return send(res, 303, "", { location: "/" });
      }
      const state = /^\/_workshop\/state\/(microsoft|atlassian)$/.exec(url.pathname);
      if (state && req.method === "GET") return await proxy(req, res, participant, state[1], "/state");
      if (uploadToken) return await proxy(req, res, participant, "microsoft", uploads.get(uploadToken).path, uploadToken);
      const service = backend(url.pathname);
      if (!service) return send(res, 404, { error: "not_found" });
      return await proxy(req, res, participant, service, url.pathname + url.search);
    } catch {
      if (!res.headersSent) send(res, 503, { error: "sandbox_unavailable", message: "Your private sandbox could not start. Try again or ask the facilitator." });
    } finally {
      if (claimedUpload) claimedUpload.inFlight = false;
      if (counted) {
        active.set(participant.id, Math.max(0, active.get(participant.id) - 1));
        scheduleIdle(participant.id);
      }
      handlers.delete(done); finish();
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 15000; server.maxRequestsPerSocket = 1000;
  // Listen first when using an ephemeral local port; all callbacks run after auth is constructed.
  try { await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); }); }
  catch (error) { storage?.close(); throw error; }
  publicOrigin ||= `http://${host === "::1" ? "[::1]" : host}:${server.address().port}`;
  try { auth = createWorkshopAuth({ origin: publicOrigin, participants: roster, storage, automaticJoin: joinMode === "automatic" }); }
  catch (error) {
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); storage?.close(); throw error;
  }
  const close = async () => {
    closing = true;
    for (const id of idleTimers.keys()) cancelIdle(id);
    const stopped = new Promise((resolve) => server.close(resolve)); server.closeAllConnections();
    await Promise.all([...handlers]);
    await admissions;
    await Promise.all([...stacks.keys()].map(disposeStack));
    await Promise.all([...disposals.values(), ...cleanups]);
    await stopped; await auth.close?.();
  };
  return { server, origin: publicOrigin, close };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    // Credentials stay in operator configuration, never in source, URLs or startup logs.
    const raw = process.env.OPEN_WORKPLACE_PARTICIPANTS_FILE ? await readFile(process.env.OPEN_WORKPLACE_PARTICIPANTS_FILE, "utf8") : process.env.OPEN_WORKPLACE_PARTICIPANTS;
    const joinMode = process.env.OPEN_WORKPLACE_JOIN_MODE || "automatic";
    if (!raw && joinMode === "assigned") throw new Error("Assigned mode requires a private participant roster.");
    const workshop = await startWorkshop({ participants: raw ? JSON.parse(raw) : [], joinMode, origin: process.env.PUBLIC_URL, host: process.env.HOST || "127.0.0.1", port: Number(process.env.PORT || 3990), dataDir: process.env.OPEN_WORKPLACE_DATA_DIR });
    console.log(`Private workshop ingress listening at ${workshop.origin}`);
    for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, async () => { await workshop.close(); process.exit(0); });
  } catch (error) { console.error(error instanceof SyntaxError ? "Invalid workshop roster JSON." : error.message); process.exitCode = 1; }
}
