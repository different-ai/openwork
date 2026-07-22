#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import http from "node:http";
import { join } from "node:path";

const REPO_ROOT = "/workspace";
const SERVER_TOKEN = "repro-token";

const runTag = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
const children = new Set();
const logStreams = new Set();
const proxySockets = new Set();
const proxyHoldTimers = new Set();
let proxyServer = null;
let cleanupStarted = false;

function log(message) {
  process.stderr.write(`[repro-engine-mcp-evidence] ${message}\n`);
}
function writeLog(stream, chunk) {
  if (!stream.writableEnded && !stream.destroyed) stream.write(chunk);
}

function envString(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function envPort(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be an integer TCP port (got ${raw})`);
  }
  return value;
}

function envDelayMs() {
  const raw = process.env.DELAY_MS?.trim();
  if (!raw) return 9000;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`DELAY_MS must be a non-negative number of milliseconds (got ${raw})`);
  }
  return Math.round(value);
}
function windowMs() {
  const raw = process.env.WINDOW_MS?.trim();
  if (!raw) return 15000;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`WINDOW_MS must be a positive number of milliseconds (got ${raw})`);
  }
  return Math.round(value);
}

function stripTrailingSlashes(value) {
  return value.replace(/\/+$/, "");
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function own(value, key) {
  return isRecord(value) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
}
function parseJsonText(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function fetchJson(url, options = {}) {
  const headers = new Headers(options.headers ?? {});
  if (!headers.has("accept")) headers.set("accept", "application/json");
  if (options.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(url, { ...options, headers });
  const text = await response.text();
  return { response, body: parseJsonText(text), text };
}
async function readNodeRequestJson(request) {
  let body = "";
  for await (const chunk of request) body += chunk.toString();
  return parseJsonText(body);
}
function authOrigins(denApiUrl) {
  const url = new URL(denApiUrl);
  const origins = [url.origin];
  if (url.hostname === "127.0.0.1") {
    const localhost = new URL(url.toString());
    localhost.hostname = "localhost";
    origins.push(localhost.origin);
  } else if (url.hostname === "localhost") {
    const loopback = new URL(url.toString());
    loopback.hostname = "127.0.0.1";
    origins.push(loopback.origin);
  }
  return [...new Set(origins)];
}
async function denAuthFetch(denApiUrl, path, options = {}) {
  let last = null;
  for (const origin of authOrigins(denApiUrl)) {
    const result = await fetchJson(`${denApiUrl}${path}`, {
      ...options,
      headers: { origin, ...(options.headers ?? {}) },
    });
    last = result;
    if (!(result.response.status === 403 && own(result.body, "code") === "INVALID_ORIGIN")) return result;
  }
  return last;
}
async function denFetch(denApiUrl, path, token, options = {}) {
  return fetchJson(`${denApiUrl}${path}`, {
    ...options,
    headers: { authorization: `Bearer ${token}`, ...(options.headers ?? {}) },
  });
}
function assertOk(result, label) {
  if (!result.response.ok) throw new Error(`${label} failed with HTTP ${result.response.status}: ${JSON.stringify(result.body)}`);
}
function organizationFromBody(body) {
  const nested = own(body, "organization");
  const organization = isRecord(nested) ? nested : isRecord(body) && typeof own(body, "id") === "string" ? body : null;
  if (!organization || typeof own(organization, "id") !== "string") {
    throw new Error(`Unable to resolve organization id from /v1/org response: ${JSON.stringify(body)}`);
  }
  return organization;
}
async function ensureOrganization(denApiUrl, sessionToken) {
  const existing = await denFetch(denApiUrl, "/v1/org", sessionToken);
  if (existing.response.ok) return organizationFromBody(existing.body);
  if (existing.response.status !== 404) {
    throw new Error(`GET /v1/org failed with HTTP ${existing.response.status}: ${JSON.stringify(existing.body)}`);
  }

  const created = await denFetch(denApiUrl, "/v1/org", sessionToken, {
    method: "POST",
    body: JSON.stringify({ name: `Engine MCP Evidence ${runTag}` }),
  });
  const singleOrgMode = created.response.status === 409
    && (own(created.body, "error") === "single_org_mode" || own(created.body, "code") === "single_org_mode");
  if (!created.response.ok && !singleOrgMode) {
    throw new Error(`POST /v1/org failed with HTTP ${created.response.status}: ${JSON.stringify(created.body)}`);
  }

  const reread = await denFetch(denApiUrl, "/v1/org", sessionToken);
  assertOk(reread, "GET /v1/org after organization bootstrap");
  return organizationFromBody(reread.body);
}
async function bootstrapDen(denApiUrl) {
  const email = `engine-mcp-evidence-${runTag}@acme.test`;
  const password = `OpenWork-${runTag}-Evidence!`;
  log(`Signing up Den admin ${email}`);
  const signUp = await denAuthFetch(denApiUrl, "/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email, name: "Engine MCP Evidence Admin", password }),
  });
  assertOk(signUp, "POST /api/auth/sign-up/email");

  const signIn = await denAuthFetch(denApiUrl, "/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  assertOk(signIn, "POST /api/auth/sign-in/email");
  const sessionToken = own(signIn.body, "token");
  if (typeof sessionToken !== "string" || !sessionToken) throw new Error("Den sign-in did not return a bearer token");

  log("Resolving Den organization");
  const organization = await ensureOrganization(denApiUrl, sessionToken);

  log("Minting Den MCP token");
  const minted = await denFetch(denApiUrl, "/v1/mcp/token", sessionToken, {
    method: "POST",
    body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }),
  });
  assertOk(minted, "POST /v1/mcp/token");
  const token = own(minted.body, "token");
  if (typeof token !== "string" || !token) throw new Error("POST /v1/mcp/token did not return token");
  return { sessionToken, organization, mcpToken: token, mcpTokenBody: minted.body };
}
function startDelayProxy(targetBase, port) {
  const targetOrigin = stripTrailingSlashes(targetBase);
  let armedUntilMs = 0;
  let activeDelayMs = 0;
  const holds = [];

  const server = http.createServer(async (request, response) => {
    const requestUrl = request.url ?? "/";
    const requestPath = new URL(requestUrl, "http://127.0.0.1").pathname;
    if (request.method === "POST" && requestPath === "/__repro/arm") {
      const body = await readNodeRequestJson(request);
      const nextDelayMs = Number(own(body, "delayMs"));
      const nextWindowMs = Number(own(body, "windowMs"));
      activeDelayMs = Number.isFinite(nextDelayMs) && nextDelayMs >= 0 ? Math.round(nextDelayMs) : 9000;
      const activeWindowMs = Number.isFinite(nextWindowMs) && nextWindowMs > 0 ? Math.round(nextWindowMs) : windowMs();
      const armedAtMs = Date.now();
      armedUntilMs = armedAtMs + activeWindowMs;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ armedAtMs, armedUntilMs, delayMs: activeDelayMs, windowMs: activeWindowMs }));
      log(`Delay proxy armed for ${activeWindowMs}ms with per-request hold ${activeDelayMs}ms`);
      return;
    }

    const forward = () => {
      const targetUrl = new URL(`${targetOrigin}${requestUrl}`);
      const headers = { ...request.headers };
      delete headers.host;
      const proxyRequest = http.request(targetUrl, { method: request.method, headers }, (proxyResponse) => {
        response.writeHead(proxyResponse.statusCode ?? 502, proxyResponse.statusMessage, proxyResponse.headers);
        proxyResponse.pipe(response);
      });
      proxyRequest.on("error", (error) => {
        if (response.headersSent) {
          response.destroy(error);
          return;
        }
        response.writeHead(502, { "content-type": "application/json" });
        response.end(JSON.stringify({ code: "proxy_forward_failed", message: error.message }));
      });
      request.pipe(proxyRequest);
    };
    if (requestPath.startsWith("/mcp/agent") && Date.now() <= armedUntilMs) {
      const arrivedAtMs = Date.now();
      log(`Delaying ${request.method ?? ""} ${requestUrl} for ${activeDelayMs}ms`);
      const timer = setTimeout(() => {
        proxyHoldTimers.delete(timer);
        const heldMs = Date.now() - arrivedAtMs;
        holds.push({ path: requestUrl, heldMs, at: new Date(arrivedAtMs).toISOString() });
        log(`Forwarding held ${request.method ?? ""} ${requestUrl} after ${heldMs}ms`);
        forward();
      }, activeDelayMs);
      proxyHoldTimers.add(timer);
      return;
    }
    forward();
  });
  server.on("connection", (socket) => {
    proxySockets.add(socket);
    socket.on("close", () => proxySockets.delete(socket));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      proxyServer = server;
      log(`Delay proxy listening on http://127.0.0.1:${port}, forwarding to ${targetOrigin}`);
      resolve({ holds });
    });
  });
}

async function waitForServerListening(child, logStream) {
  let stdout = "";
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for OpenWork server listening log")), 90_000);
    const finish = (value) => {
      clearTimeout(timeout);
      resolve(value);
    };
    const fail = (error) => {
      clearTimeout(timeout);
      reject(error);
    };
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      writeLog(logStream, text);
      if (stdout.includes("OpenWork server listening")) finish();
    });
    child.stderr.on("data", (chunk) => writeLog(logStream, chunk));
    child.once("error", fail);
    child.once("exit", (code, signal) => fail(new Error(`OpenWork server exited before listening (code ${code}, signal ${signal})`)));
  });
}

async function startOpenworkServer(paths, serverPort, opencodeBin) {
  await mkdir(paths.workspaceRoot, { recursive: true });
  await mkdir(paths.xdgOpenwork, { recursive: true });
  await mkdir(paths.home, { recursive: true });
  await mkdir(paths.logs, { recursive: true });
  const serverLog = join(paths.logs, "server.log");
  const logStream = createWriteStream(serverLog, { flags: "a" });
  logStreams.add(logStream);
  const args = ["apps/server/src/cli.ts", "--host", "127.0.0.1", "--port", String(serverPort), "--token", SERVER_TOKEN, "--workspace", paths.workspaceRoot];
  log(`Starting OpenWork server on 127.0.0.1:${serverPort}`);
  const child = spawn("bun", args, {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      OPENWORK_MANAGE_OPENCODE: "1",
      OPENWORK_OPENCODE_BIN: opencodeBin,
      OPENWORK_SERVER_CONFIG: join(paths.xdgOpenwork, "server.json"),
      XDG_CONFIG_HOME: paths.xdg,
      HOME: paths.home,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  children.add(child);
  try {
    await waitForServerListening(child, logStream);
  } catch (error) {
    logStream.end();
    throw error;
  }
  log(`OpenWork server log: ${serverLog}`);
  return { baseUrl: `http://127.0.0.1:${serverPort}` };
}

async function serverJson(baseUrl, path, options = {}) {
  const result = await fetchJson(`${baseUrl}${path}`, {
    ...options,
    headers: { authorization: `Bearer ${SERVER_TOKEN}`, ...(options.headers ?? {}) },
  });
  assertOk(result, `${options.method ?? "GET"} ${path}`);
  return result.body;
}
async function armProxy(proxyPort, delayMs, activeWindowMs) {
  const result = await fetchJson(`http://127.0.0.1:${proxyPort}/__repro/arm`, {
    method: "POST",
    body: JSON.stringify({ delayMs, windowMs: activeWindowMs }),
  });
  assertOk(result, "POST /__repro/arm");
  return result.body;
}

function firstWorkspaceId(workspacesBody) {
  const activeId = own(workspacesBody, "activeId");
  if (typeof activeId === "string" && activeId) return activeId;
  const items = Array.isArray(own(workspacesBody, "items")) ? own(workspacesBody, "items") : own(workspacesBody, "workspaces");
  const id = own(Array.isArray(items) ? items[0] : null, "id");
  if (typeof id === "string" && id) return id;
  throw new Error(`Unable to discover workspace id from /workspaces: ${JSON.stringify(workspacesBody)}`);
}

function isHealthConnected(health) {
  return own(health, "usable") === true
    || own(health, "phase") === "ready"
    || own(own(health, "engine"), "status") === "connected";
}

async function sleep(ms) {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollHealedHealth(baseUrl, workspaceId) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < 30_000) {
    last = await serverJson(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/mcp/openwork-cloud/health`);
    if (isHealthConnected(last)) return last;
    await sleep(1000);
  }
  return last;
}

function redact(value, secrets) {
  if (typeof value === "string") {
    let output = value;
    for (const secret of secrets) {
      if (secret) output = output.split(secret).join("<redacted>");
    }
    return output.replace(/Bearer\s+[^\s"',)}\]]+/gi, "Bearer <redacted>");
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (!isRecord(value)) return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    const lower = key.toLowerCase();
    output[key] = typeof child === "string" && (lower === "authorization" || lower === "token")
      ? "<redacted>"
      : redact(child, secrets);
  }
  return output;
}

function killProcessGroup(child, signal) {
  if (typeof child.pid === "number") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }
  child.kill(signal);
}

async function cleanup() {
  if (cleanupStarted) return;
  cleanupStarted = true;
  for (const timer of proxyHoldTimers) clearTimeout(timer);
  proxyHoldTimers.clear();
  proxyServer?.unref();
  proxyServer?.closeAllConnections?.();
  for (const socket of proxySockets) socket.destroy();
  const closeProxy = proxyServer
    ? new Promise((resolve) => proxyServer.close(() => resolve()))
    : Promise.resolve();
  for (const child of children) {
    if (child.exitCode === null) killProcessGroup(child, "SIGTERM");
  }
  await Promise.race([closeProxy, sleep(1000)]);
  await sleep(1200);
  for (const child of children) {
    if (child.exitCode === null) killProcessGroup(child, "SIGKILL");
  }
  for (const stream of logStreams) stream.end();
}

async function writeFinalJson(value) {
  await new Promise((resolve) => process.stdout.write(`${JSON.stringify(value)}\n`, resolve));
}

async function main() {
  for (const name of ["DEN_API_LOCAL", "OPENWORK_OPENCODE_BIN", "REPRO_DIR"]) envString(name);
  const denApiUrl = stripTrailingSlashes(envString("DEN_API_LOCAL"));
  const opencodeBin = envString("OPENWORK_OPENCODE_BIN");
  const reproDir = envString("REPRO_DIR");
  const delayMs = envDelayMs();
  const activeWindowMs = windowMs();
  const serverPort = envPort("SERVER_PORT", 8790);
  const proxyPort = envPort("PROXY_PORT", 8791);
  const paths = { workspaceRoot: join(reproDir, "ws"), xdg: join(reproDir, "xdg"), xdgOpenwork: join(reproDir, "xdg", "openwork"), home: join(reproDir, "home"), logs: join(reproDir, "logs") };

  const den = await bootstrapDen(denApiUrl);
  const proxy = await startDelayProxy(denApiUrl, proxyPort);
  const openwork = await startOpenworkServer(paths, serverPort, opencodeBin);
  const workspaces = await serverJson(openwork.baseUrl, "/workspaces");
  const workspaceId = firstWorkspaceId(workspaces);
  log(`Using workspace ${workspaceId}`);

  const reconcilePayload = {
    workspaceId,
    name: "openwork-cloud",
    config: {
      type: "remote",
      url: `http://127.0.0.1:${proxyPort}/mcp/agent`,
      enabled: true,
      headers: { Authorization: `Bearer ${den.mcpToken}` },
      oauth: false,
    },
    tokenMetadata: {
      expiresAt: own(den.mcpTokenBody, "expiresAt") ?? null,
      organizationId: own(den.mcpTokenBody, "organizationId") ?? own(den.organization, "id"),
      resource: own(den.mcpTokenBody, "resource") ?? null,
      scopes: Array.isArray(own(den.mcpTokenBody, "scopes")) ? own(den.mcpTokenBody, "scopes") : ["mcp:read", "mcp:write"],
    },
    org: { id: own(den.organization, "id"), name: own(den.organization, "name") ?? null, slug: own(den.organization, "slug") ?? null },
    trigger: "repro-engine-mcp-evidence",
  };

  log("PHASE 1: seeding delayed openwork-cloud reconcile");
  const armed = await armProxy(proxyPort, delayMs, activeWindowMs);
  const armedUntilMs = Number(own(armed, "armedUntilMs"));
  if (!Number.isFinite(armedUntilMs)) throw new Error(`Proxy arm response did not include armedUntilMs: ${JSON.stringify(armed)}`);
  const seedReconcile = await serverJson(openwork.baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/mcp/openwork-cloud/reconcile`, {
    method: "POST",
    body: JSON.stringify(reconcilePayload),
  });
  const seedMcp = await serverJson(openwork.baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/mcp`);
  const seedHealth = await serverJson(openwork.baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/mcp/openwork-cloud/health`);

  log("PHASE 2: waiting for delayed Den MCP handshake to heal live engine state");
  await sleep(armedUntilMs + 8000 - Date.now());
  const healedHealth = await pollHealedHealth(openwork.baseUrl, workspaceId);
  const healedMcp = await serverJson(openwork.baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/mcp`);

  log("PHASE 3: collecting agent-context diagnostics");
  const diagnosticsRequest = {
    organizationConnectionsProbe: { status: "observed", code: null, totalCount: 0, truncated: false },
    organizationConnections: [],
  };
  const diagnosticsReport = await serverJson(openwork.baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/diagnostics/agent-context`, {
    method: "POST",
    body: JSON.stringify(diagnosticsRequest),
  });
  const checks = Array.isArray(own(diagnosticsReport, "checks")) ? own(diagnosticsReport, "checks") : [];
  const engineMcpSyncCheck = checks.find((check) => own(check, "id") === "engine-mcp-sync") ?? null;
  const mcps = Array.isArray(own(diagnosticsReport, "mcps")) ? own(diagnosticsReport, "mcps") : [];
  const openworkCloudSyncStatuses = mcps.filter((mcp) => own(mcp, "name") === "openwork-cloud").map((mcp) => ({
    name: own(mcp, "name"), source: own(mcp, "source"), type: own(mcp, "type"), enabled: own(mcp, "enabled"),
    syncStatus: own(mcp, "syncStatus"), liveEngineStatus: own(mcp, "liveEngineStatus"),
  }));
  const contradictionReproduced = isHealthConnected(healedHealth)
    && own(engineMcpSyncCheck, "status") === "failed"
    && own(engineMcpSyncCheck, "code") === "mcp_registration_not_connected";

  const evidence = {
    runTag,
    phases: {
      seed: { reconcile: seedReconcile, mcp: seedMcp, health: seedHealth },
      healed: { mcp: healedMcp, health: healedHealth },
      diagnostics: { engineMcpSyncCheck, openworkCloudSyncStatuses, firstFailedCheck: own(diagnosticsReport, "firstFailedCheck") ?? null, overall: own(diagnosticsReport, "overall") ?? null },
    },
    proxyHolds: proxy.holds,
    contradictionReproduced,
  };

  await writeFinalJson(redact(evidence, [den.mcpToken, den.sessionToken]));
  const forcedExit = setTimeout(() => process.exit(0), 2000);
  forcedExit.unref();
  await cleanup();
  clearTimeout(forcedExit);
  process.exit(0);
}

process.once("SIGINT", () => void cleanup().finally(() => process.exit(130)));
process.once("SIGTERM", () => void cleanup().finally(() => process.exit(143)));

main().catch(async (error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  await cleanup();
  process.exit(1);
});
