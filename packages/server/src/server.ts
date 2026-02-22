import { readFile, writeFile, rm, readdir, rename, stat } from "node:fs/promises";
import { createHash, randomInt } from "node:crypto";
import { homedir, hostname } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { ApprovalRequest, Capabilities, ServerConfig, WorkspaceInfo, Actor, ReloadReason, ReloadTrigger, TokenScope } from "./types.js";
import { ApprovalService } from "./approvals.js";
import { addPlugin, listPlugins, normalizePluginSpec, removePlugin } from "./plugins.js";
import { addMcp, listMcp, removeMcp } from "./mcp.js";
import { deleteSkill, listSkills, upsertSkill } from "./skills.js";
import { installHubSkill, listHubSkills } from "./skill-hub.js";
import { deleteCommand, listCommands, upsertCommand } from "./commands.js";
import { deleteScheduledJob, listScheduledJobs, resolveScheduledJob } from "./scheduler.js";
import { ApiError, formatError } from "./errors.js";
import { readJsoncFile, updateJsoncTopLevel, writeJsoncFile } from "./jsonc.js";
import { recordAudit, readAuditEntries, readLastAudit } from "./audit.js";
import { ReloadEventStore } from "./events.js";
import { parseFrontmatter } from "./frontmatter.js";
import { opencodeConfigPath, openworkConfigPath, projectCommandsDir, projectSkillsDir } from "./workspace-files.js";
import { ensureDir, exists, hashToken, shortId } from "./utils.js";
import { workspaceIdForPath } from "./workspaces.js";
import { sanitizeCommandName, validateMcpName } from "./validators.js";
import { TokenService } from "./tokens.js";
import { TOY_UI_CSS, TOY_UI_HTML, TOY_UI_JS, cssResponse, htmlResponse, jsResponse } from "./toy-ui.js";
import pkg from "../package.json" with { type: "json" };

const SERVER_VERSION = pkg.version;

type LogLevel = "info" | "warn" | "error";

type LogAttributes = Record<string, unknown>;

type ServerLogger = {
  log: (level: LogLevel, message: string, attributes?: LogAttributes) => void;
};

const LOG_LEVEL_NUMBERS: Record<LogLevel, number> = {
  info: 9,
  warn: 13,
  error: 17,
};

function toUnixNano(): string {
  return (BigInt(Date.now()) * 1_000_000n).toString();
}

export function createServerLogger(config: ServerConfig): ServerLogger {
  const runId = process.env.OPENWORK_RUN_ID ?? shortId();
  const host = hostname().trim();
  const resource: Record<string, string> = {
    "service.name": "openwork-server",
    "service.version": SERVER_VERSION,
    "service.instance.id": runId,
  };
  if (host) {
    resource["host.name"] = host;
  }
  const baseAttributes: LogAttributes = {
    "run.id": runId,
    "process.pid": process.pid,
  };

  const emit = (level: LogLevel, message: string, attributes?: LogAttributes) => {
    const merged = { ...baseAttributes, ...(attributes ?? {}) };
    if (config.logFormat === "json") {
      const record = {
        timeUnixNano: toUnixNano(),
        severityText: level.toUpperCase(),
        severityNumber: LOG_LEVEL_NUMBERS[level],
        body: message,
        attributes: merged,
        resource,
      };
      process.stdout.write(`${JSON.stringify(record)}\n`);
      return;
    }
    process.stdout.write(`${message}\n`);
  };

  return { log: emit };
}

function logRequest(input: {
  logger: ServerLogger;
  request: Request;
  response: Response;
  durationMs: number;
  authMode: AuthMode;
  proxyService?: "opencode" | "opencode-router";
  proxyBaseUrl?: string;
  error?: string;
}) {
  const { logger, request, response, durationMs, authMode, proxyService, proxyBaseUrl, error } = input;
  const status = response.status;
  const level: LogLevel = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const proxyLabel = proxyBaseUrl ? ` (${proxyService ?? "proxy"})` : "";
  const message = `${method} ${url.pathname} ${status} ${durationMs}ms${proxyLabel}`;
  const attributes: LogAttributes = {
    method,
    path: url.pathname,
    status,
    durationMs,
    auth: authMode,
  };
  if (proxyBaseUrl) {
    attributes["proxy.base_url"] = proxyBaseUrl;
    if (proxyService) attributes["proxy.service"] = proxyService;
  }
  if (error) {
    attributes.error = error;
  }
  logger.log(level, message, attributes);
}

type AuthMode = "none" | "client" | "host";

function normalizeOpenCodeRouterProxyPath(pathname: string): string {
  const trimmed = pathname.trim();
  if (!trimmed) return "/opencode-router";
  if (trimmed === "/opencode-router/") return "/opencode-router";
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function resolveOpenCodeRouterProxyPolicy(
  method: string,
  pathname: string,
): { auth: AuthMode; requiredScope?: TokenScope } {
  const normalized = normalizeOpenCodeRouterProxyPath(pathname);
  const upper = method.trim().toUpperCase();

  if (upper === "GET") {
    if (normalized === "/opencode-router" || normalized === "/opencode-router/health") {
      return { auth: "client" };
    }
    if (normalized === "/opencode-router/bindings") {
      return { auth: "client", requiredScope: "collaborator" };
    }
    if (normalized === "/opencode-router/identities/telegram" || normalized === "/opencode-router/identities/slack") {
      return { auth: "client", requiredScope: "collaborator" };
    }
  }

  return { auth: "host" };
}

function parseWorkspaceMount(pathname: string): { workspaceId: string; restPath: string } | null {
  if (!pathname.startsWith("/w/")) return null;
  const remainder = pathname.slice(3);
  if (!remainder) return null;
  const slash = remainder.indexOf("/");
  if (slash === -1) {
    return { workspaceId: decodeURIComponent(remainder), restPath: "/" };
  }
  const workspaceId = remainder.slice(0, slash);
  const restPath = remainder.slice(slash) || "/";
  if (!workspaceId.trim()) return null;
  return { workspaceId: decodeURIComponent(workspaceId), restPath };
}

function normalizeOpencodeProxyPath(proxyPath: string): string {
  const raw = (proxyPath ?? "").trim() || "/";
  const withoutPrefix = raw.startsWith("/opencode") ? raw.slice("/opencode".length) : raw;
  const normalized = (withoutPrefix || "/").replace(/\/+$/, "");
  return normalized || "/";
}

function assertOpencodeProxyAllowed(actor: Actor, method: string, proxyPath: string) {
  const m = method.toUpperCase();
  const scope = actor.scope ?? "viewer";

  if (scope === "viewer" && m !== "GET" && m !== "HEAD") {
    throw new ApiError(403, "forbidden", "Viewer tokens are read-only");
  }

  // Prevent collaborators/viewers from self-approving OpenCode permission requests via the proxy.
  // OpenCode uses /permission/:requestId/reply (and historically also a session-scoped variant).
  if (scope !== "owner" && m !== "GET" && m !== "HEAD") {
    const normalized = normalizeOpencodeProxyPath(proxyPath);
    if (/\/permission\/[^/]+\/reply$/.test(normalized)) {
      throw new ApiError(403, "forbidden", "Only owner tokens can reply to permission requests");
    }
  }
}

interface Route {
  method: string;
  regex: RegExp;
  keys: string[];
  auth: AuthMode;
  handler: (ctx: RequestContext) => Promise<Response>;
}

interface RequestContext {
  request: Request;
  url: URL;
  params: Record<string, string>;
  config: ServerConfig;
  approvals: ApprovalService;
  reloadEvents: ReloadEventStore;
  tokens: TokenService;
  actor?: Actor;
}

type AgentLabSchedule =
  | { kind: "interval"; seconds: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; weekday: number; hour: number; minute: number };

type AgentLabAutomation = {
  id: string;
  name: string;
  enabled: boolean;
  schedule: AgentLabSchedule;
  prompt: string;
  createdAt: number;
  updatedAt?: number;
  lastRunAt?: number;
  lastRunSessionId?: string;
};

type AgentLabAutomationStore = {
  schemaVersion: number;
  updatedAt: number;
  items: AgentLabAutomation[];
};

type SoulHeartbeatEntry = {
  id: string;
  ts: string | null;
  workspace: string | null;
  summary: string;
  looseEnds: string[];
  nextAction: string | null;
};

type SoulStatus = {
  enabled: boolean;
  state: "off" | "healthy" | "stale" | "error";
  memoryEnabled: boolean;
  instructionsEnabled: boolean;
  heartbeatLogExists: boolean;
  heartbeatCommandExists: boolean;
  heartbeatJob: {
    name: string;
    slug: string;
    schedule: string;
    lastRunAt: string | null;
    lastRunStatus: string | null;
    lastRunError: string | null;
  } | null;
  heartbeatCount: number;
  lastHeartbeatAt: string | null;
  lastHeartbeatSummary: string | null;
  staleAfterMs: number | null;
  overdue: boolean;
  summary: string;
  memoryPath: string;
  heartbeatPath: string;
};

export function startServer(config: ServerConfig) {
  const approvals = new ApprovalService(config.approval);
  const reloadEvents = new ReloadEventStore();
  const tokens = new TokenService(config);
  const routes = createRoutes(config, approvals, tokens);
  const logger = createServerLogger(config);

  const serverOptions: {
    hostname: string;
    port: number;
    fetch: (request: Request) => Response | Promise<Response>;
  } = {
    hostname: config.host,
    port: config.port,
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      const startedAt = Date.now();
      let authMode: AuthMode = "none";
      let proxyService: "opencode" | "opencode-router" | undefined;
      let proxyBaseUrl: string | undefined;
      let errorMessage: string | undefined;

      const finalize = (response: Response) => {
        const wrapped = withCors(response, request, config);
        if (config.logRequests) {
            logRequest({
              logger,
              request,
              response: wrapped,
              durationMs: Date.now() - startedAt,
              authMode,
              proxyService,
              proxyBaseUrl,
              error: errorMessage,
            });
        }
        return wrapped;
      };

      if (request.method === "OPTIONS") {
        return finalize(new Response(null, { status: 204 }));
      }

      const mount = parseWorkspaceMount(url.pathname);
      if (mount && (mount.restPath === "/opencode" || mount.restPath.startsWith("/opencode/"))) {
        authMode = "client";
        try {
          const actor = await requireClient(request, config, tokens);
          assertOpencodeProxyAllowed(actor, request.method, mount.restPath);
          const workspace = await resolveWorkspace(config, mount.workspaceId);
          proxyService = "opencode";
          proxyBaseUrl = workspace.baseUrl?.trim() || undefined;
          const response = await proxyOpencodeRequest({ request, url, workspace, proxyPath: mount.restPath });
          return finalize(response);
        } catch (error) {
          const apiError = error instanceof ApiError
            ? error
            : new ApiError(500, "internal_error", "Unexpected server error");
          errorMessage = apiError.message;
          return finalize(jsonResponse(formatError(apiError), apiError.status));
        }
      }

      if (mount && (mount.restPath === "/opencode-router" || mount.restPath.startsWith("/opencode-router/"))) {
        const policy = resolveOpenCodeRouterProxyPolicy(request.method, mount.restPath);
        authMode = policy.auth;
        try {
          if (authMode === "host") {
            await requireHost(request, config, tokens);
          } else {
            const actor = await requireClient(request, config, tokens);
            if (policy.requiredScope && scopeRank(actor.scope ?? "viewer") < scopeRank(policy.requiredScope)) {
              throw new ApiError(403, "forbidden", "Insufficient token scope", {
                required: policy.requiredScope,
                scope: actor.scope,
              });
            }
          }
          proxyService = "opencode-router";
          proxyBaseUrl = resolveOpenCodeRouterBaseUrl();
          const response = await proxyOpenCodeRouterRequest({ request, url, proxyPath: mount.restPath });
          return finalize(response);
        } catch (error) {
          const apiError = error instanceof ApiError
            ? error
            : new ApiError(500, "internal_error", "Unexpected server error");
          errorMessage = apiError.message;
          return finalize(jsonResponse(formatError(apiError), apiError.status));
        }
      }

      // Allow clients to use a mounted base URL (e.g. http://host:8787/w/<id>) while
      // still calling the existing /workspace/:id/* API surface.
      // Example: baseUrl + "/workspace/<id>/plugins" => "/w/<id>/workspace/<id>/plugins".
      // We strip the mount prefix and route-match on the rest path.
      //
      // Important: when using a mounted base URL, enforce that the nested /workspace/:id
      // matches the mount workspace id to preserve the "single-workspace" mental model.
      if (mount && mount.restPath.startsWith("/workspace/")) {
        const match = mount.restPath.match(/^\/workspace\/([^/]+)/);
        const nestedId = match?.[1] ? decodeURIComponent(match[1]) : null;
        if (nestedId && nestedId !== mount.workspaceId) {
          errorMessage = "not_found";
          return finalize(jsonResponse({ code: "not_found", message: "Not found" }, 404));
        }
        url.pathname = mount.restPath;
      }

      if (url.pathname === "/opencode" || url.pathname.startsWith("/opencode/")) {
        authMode = "client";
        proxyBaseUrl = config.workspaces[0]?.baseUrl?.trim() || undefined;
        try {
          const actor = await requireClient(request, config, tokens);
          assertOpencodeProxyAllowed(actor, request.method, url.pathname);
          proxyService = "opencode";
          const response = await proxyOpencodeRequest({ request, url, workspace: config.workspaces[0] });
          return finalize(response);
        } catch (error) {
          const apiError = error instanceof ApiError
            ? error
            : new ApiError(500, "internal_error", "Unexpected server error");
          errorMessage = apiError.message;
          return finalize(jsonResponse(formatError(apiError), apiError.status));
        }
      }

      if (url.pathname === "/opencode-router" || url.pathname.startsWith("/opencode-router/")) {
        const policy = resolveOpenCodeRouterProxyPolicy(request.method, url.pathname);
        authMode = policy.auth;
        try {
          if (authMode === "host") {
            await requireHost(request, config, tokens);
          } else {
            const actor = await requireClient(request, config, tokens);
            if (policy.requiredScope && scopeRank(actor.scope ?? "viewer") < scopeRank(policy.requiredScope)) {
              throw new ApiError(403, "forbidden", "Insufficient token scope", {
                required: policy.requiredScope,
                scope: actor.scope,
              });
            }
          }
          proxyService = "opencode-router";
          proxyBaseUrl = resolveOpenCodeRouterBaseUrl();
          const response = await proxyOpenCodeRouterRequest({ request, url });
          return finalize(response);
        } catch (error) {
          const apiError = error instanceof ApiError
            ? error
            : new ApiError(500, "internal_error", "Unexpected server error");
          errorMessage = apiError.message;
          return finalize(jsonResponse(formatError(apiError), apiError.status));
        }
      }

      const route = matchRoute(routes, request.method, url.pathname);
      if (!route) {
        errorMessage = "not_found";
        return finalize(jsonResponse({ code: "not_found", message: "Not found" }, 404));
      }

      authMode = route.auth;
      try {
        const actor = route.auth === "host"
          ? await requireHost(request, config, tokens)
          : route.auth === "client"
            ? await requireClient(request, config, tokens)
            : undefined;
        const response = await route.handler({
          request,
          url,
          params: route.params,
          config,
          approvals,
          reloadEvents,
          tokens,
          actor,
        });
        return finalize(response);
      } catch (error) {
        if (!(error instanceof ApiError)) {
          console.error("[openwork-server] Unhandled error:", error);
        }
        const apiError = error instanceof ApiError
          ? error
          : new ApiError(500, "internal_error", "Unexpected server error");
        errorMessage = apiError.message;
        return finalize(jsonResponse(formatError(apiError), apiError.status));
      }
    },
  };

  (serverOptions as { idleTimeout?: number }).idleTimeout = 120;

  const server = Bun.serve(serverOptions);

  return server;
}

function matchRoute(routes: Route[], method: string, path: string) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = path.match(route.regex);
    if (!match) continue;
    const params: Record<string, string> = {};
    route.keys.forEach((key, index) => {
      params[key] = decodeURIComponent(match[index + 1]);
    });
    return { ...route, params };
  }
  return null;
}

function addRoute(routes: Route[], method: string, path: string, auth: AuthMode, handler: Route["handler"]) {
  const keys: string[] = [];
  const regex = pathToRegex(path, keys);
  routes.push({ method, regex, keys, auth, handler });
}

function pathToRegex(path: string, keys: string[]): RegExp {
  const pattern = path.replace(/:([A-Za-z0-9_]+)/g, (_, key) => {
    keys.push(key);
    return "([^/]+)";
  });
  return new RegExp(`^${pattern}$`);
}

function buildOpencodeProxyUrl(baseUrl: string, path: string, search: string) {
  const target = new URL(baseUrl);
  const trimmedPath = path.replace(/^\/opencode/, "");
  target.pathname = trimmedPath.startsWith("/") ? trimmedPath : `/${trimmedPath}`;
  target.search = search;
  return target.toString();
}

async function fetchOpencodeJson(workspace: WorkspaceInfo, path: string, init: { method: string; body?: unknown }) {
  const baseUrl = workspace.baseUrl?.trim() ?? "";
  if (!baseUrl) {
    throw new ApiError(400, "opencode_unconfigured", "OpenCode base URL is missing for this workspace");
  }

  const url = new URL(baseUrl);
  url.pathname = path.startsWith("/") ? path : `/${path}`;
  url.search = "";

  const headers = new Headers();
  headers.set("Content-Type", "application/json");

  const directory = resolveOpencodeDirectory(workspace);
  if (directory) {
    headers.set("x-opencode-directory", directory);
  }

  const auth = buildOpencodeAuthHeader(workspace);
  if (auth) {
    headers.set("Authorization", auth);
  }

  const response = await fetch(url.toString(), {
    method: init.method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  const text = await response.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!response.ok) {
    throw new ApiError(502, "opencode_request_failed", "OpenCode request failed", {
      status: response.status,
      body: json ?? text,
      path,
    });
  }
  return json;
}

function buildOpenCodeRouterProxyUrl(baseUrl: string, path: string, search: string) {
  const target = new URL(baseUrl);
  const trimmedPath = path.replace(/^\/opencode-router/, "");
  const normalized = trimmedPath.startsWith("/") ? trimmedPath : `/${trimmedPath}`;
  target.pathname = normalized === "/" ? "/" : normalized;
  target.search = search;
  return target.toString();
}

async function proxyOpencodeRequest(input: {
  request: Request;
  url: URL;
  workspace?: WorkspaceInfo;
  proxyPath?: string;
}) {
  const workspace = input.workspace;
  const baseUrl = workspace?.baseUrl?.trim() ?? "";
  if (!baseUrl) {
    throw new ApiError(400, "opencode_unconfigured", "OpenCode base URL is missing for this workspace");
  }

  const proxyPath = input.proxyPath ?? input.url.pathname;
  const targetUrl = buildOpencodeProxyUrl(baseUrl, proxyPath, input.url.search);
  const headers = new Headers(input.request.headers);
  headers.delete("authorization");
  headers.delete("x-openwork-host-token");
  headers.delete("x-openwork-client-id");
  headers.delete("host");
  headers.delete("origin");

  const directory = workspace ? resolveOpencodeDirectory(workspace) : null;
  if (directory && !headers.has("x-opencode-directory")) {
    headers.set("x-opencode-directory", directory);
  }

  const auth = workspace ? buildOpencodeAuthHeader(workspace) : null;
  if (auth) {
    headers.set("Authorization", auth);
  }

  const method = input.request.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : input.request.body;
  const response = await fetch(targetUrl, {
    method,
    headers,
    body,
  });

  return response;
}

function resolveOpenCodeRouterBaseUrl(): string {
  const port = parseInteger(process.env.OPENCODE_ROUTER_HEALTH_PORT);
  if (!port) {
    throw new ApiError(404, "opencodeRouter_unconfigured", "OpenCodeRouter is not configured on this host");
  }
  return `http://127.0.0.1:${port}`;
}

async function proxyOpenCodeRouterRequest(input: {
  request: Request;
  url: URL;
  proxyPath?: string;
}) {
  const baseUrl = resolveOpenCodeRouterBaseUrl();
  const proxyPath = input.proxyPath ?? input.url.pathname;
  const targetUrl = buildOpenCodeRouterProxyUrl(baseUrl, proxyPath, input.url.search);
  const headers = new Headers(input.request.headers);
  headers.delete("authorization");
  headers.delete("x-openwork-host-token");
  headers.delete("x-openwork-client-id");
  headers.delete("host");
  headers.delete("origin");

  const method = input.request.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : input.request.body;
  try {
    const response = await fetch(targetUrl, {
      method,
      headers,
      body,
    });
    return response;
  } catch (error) {
    const port = parseInteger(process.env.OPENCODE_ROUTER_HEALTH_PORT);
    throw new ApiError(503, "opencodeRouter_unreachable", "OpenCodeRouter is not reachable on this host", {
      baseUrl,
      port,
      targetUrl,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function opencodeRouterDebugEnabled(): boolean {
  return ["1", "true", "yes"].includes((process.env.OPENWORK_DEBUG_OPENCODE_ROUTER ?? "").toLowerCase());
}

function logOpenCodeRouterDebug(message: string, details?: Record<string, unknown>) {
  if (!opencodeRouterDebugEnabled()) return;
  const payload = details ? ` ${JSON.stringify(details)}` : "";
  console.log(`[opencodeRouter] ${message}${payload}`);
}

function withCors(response: Response, request: Request, config: ServerConfig) {
  const origin = request.headers.get("origin");
  const allowedOrigins = config.corsOrigins;
  let allowOrigin: string | null = null;
  if (allowedOrigins.includes("*")) {
    allowOrigin = "*";
  } else if (origin && allowedOrigins.includes(origin)) {
    allowOrigin = origin;
  }

  if (!allowOrigin) return response;
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", allowOrigin);
  headers.set(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, X-OpenWork-Host-Token, X-OpenWork-Client-Id, X-OpenCode-Directory, X-Opencode-Directory, x-opencode-directory",
  );
  headers.set("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  headers.set("Vary", "Origin");
  return new Response(response.body, { status: response.status, headers });
}

async function requireClient(request: Request, config: ServerConfig, tokens: TokenService): Promise<Actor> {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1];
  if (!token) {
    throw new ApiError(401, "unauthorized", "Invalid bearer token");
  }
  const scope = await tokens.scopeForToken(token);
  if (!scope) {
    throw new ApiError(401, "unauthorized", "Invalid bearer token");
  }
  const clientId = request.headers.get("x-openwork-client-id") ?? undefined;
  return { type: "remote", clientId, tokenHash: hashToken(token), scope };
}

async function requireHost(request: Request, config: ServerConfig, tokens: TokenService): Promise<Actor> {
  const hostToken = request.headers.get("x-openwork-host-token");
  if (hostToken && hostToken === config.hostToken) {
    return { type: "host", tokenHash: hashToken(hostToken), scope: "owner" };
  }

  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const bearer = match?.[1];
  if (!bearer) {
    throw new ApiError(401, "unauthorized", "Invalid host token");
  }
  const scope = await tokens.scopeForToken(bearer);
  if (scope !== "owner") {
    throw new ApiError(401, "unauthorized", "Invalid host token");
  }
  const clientId = request.headers.get("x-openwork-client-id") ?? undefined;
  return { type: "remote", clientId, tokenHash: hashToken(bearer), scope };
}

function buildCapabilities(config: ServerConfig): Capabilities {
  const writeEnabled = !config.readOnly;
  const schemaVersion = 1;
  const sandboxBackend = resolveSandboxBackend();
  const sandboxEnabled = resolveSandboxEnabled(sandboxBackend);
  const inboxEnabled = resolveInboxEnabled();
  const outboxEnabled = resolveOutboxEnabled();
  const maxBytes = resolveInboxMaxBytes();
  const toyUiEnabled = resolveToyUiEnabled();
  const browserProvider = resolveBrowserProvider();
  const opencodeRouterConfigured = Boolean(parseInteger(process.env.OPENCODE_ROUTER_HEALTH_PORT));
  const opencodeConfigured = config.workspaces.some((workspace) => Boolean(workspace.baseUrl?.trim()));
  return {
    schemaVersion,
    serverVersion: SERVER_VERSION,
    skills: { read: true, write: writeEnabled, source: "openwork" },
    hub: {
      skills: {
        read: true,
        install: writeEnabled,
        repo: { owner: "different-ai", name: "openwork-hub", ref: "main" },
      },
    },
    plugins: { read: true, write: writeEnabled },
    mcp: { read: true, write: writeEnabled },
    commands: { read: true, write: writeEnabled },
    config: { read: true, write: writeEnabled },

    approvals: { mode: config.approval.mode, timeoutMs: config.approval.timeoutMs },
    sandbox: { enabled: sandboxEnabled, backend: sandboxBackend },
    ui: { toy: toyUiEnabled },
    tokens: { scoped: true, scopes: ["owner", "collaborator", "viewer"] },
    proxy: {
      opencode: opencodeConfigured,
      opencodeRouter: opencodeRouterConfigured,
    },
    toolProviders: {
      browser: browserProvider,
      files: {
        injection: writeEnabled && inboxEnabled,
        outbox: outboxEnabled,
        inboxPath: ".opencode/openwork/inbox/",
        outboxPath: ".opencode/openwork/outbox/",
        maxBytes,
      },
    },
  };
}

function resolveSandboxBackend(): Capabilities["sandbox"]["backend"] {
  const raw = (process.env.OPENWORK_SANDBOX_BACKEND ?? "").trim().toLowerCase();
  if (raw === "docker") return "docker";
  if (raw === "container") return "container";
  return "none";
}

function resolveSandboxEnabled(backend: Capabilities["sandbox"]["backend"]): boolean {
  const raw = (process.env.OPENWORK_SANDBOX_ENABLED ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return backend !== "none";
}

function resolveInboxEnabled(): boolean {
  const raw = (process.env.OPENWORK_INBOX_ENABLED ?? "").trim().toLowerCase();
  if (!raw) return true;
  return ["1", "true", "yes", "on"].includes(raw);
}

function resolveOutboxEnabled(): boolean {
  const raw = (process.env.OPENWORK_OUTBOX_ENABLED ?? "").trim().toLowerCase();
  if (!raw) return true;
  return ["1", "true", "yes", "on"].includes(raw);
}

function resolveInboxMaxBytes(): number {
  const raw = (process.env.OPENWORK_INBOX_MAX_BYTES ?? "").trim();
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.min(Math.trunc(parsed), 250_000_000);
  }
  return 50_000_000;
}

function resolveToyUiEnabled(): boolean {
  const raw = (process.env.OPENWORK_TOY_UI ?? "").trim().toLowerCase();
  if (!raw) return true;
  return ["1", "true", "yes", "on"].includes(raw);
}

function resolveBrowserProvider(): Capabilities["toolProviders"]["browser"] {
  const raw = (process.env.OPENWORK_BROWSER_PROVIDER ?? "").trim().toLowerCase();
  if (raw === "sandbox-headless") {
    return { enabled: true, placement: "in-sandbox", mode: "headless" };
  }
  if (raw === "host-interactive") {
    return { enabled: true, placement: "host-machine", mode: "interactive" };
  }
  if (raw === "client-interactive") {
    return { enabled: true, placement: "client-machine", mode: "interactive" };
  }
  return { enabled: false, placement: "external", mode: "none" };
}

function resolveInboxDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".opencode", "openwork", "inbox");
}

function resolveOutboxDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".opencode", "openwork", "outbox");
}

function resolveAgentLabDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".opencode", "openwork", "agentlab");
}

function resolveAgentLabAutomationsPath(workspaceRoot: string): string {
  return join(resolveAgentLabDir(workspaceRoot), "automations.json");
}

function resolveAgentLabLogsDir(workspaceRoot: string): string {
  return join(resolveAgentLabDir(workspaceRoot), "logs");
}

function clampInt(value: unknown, options: { min: number; max: number; name: string }): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) {
    throw new ApiError(400, "invalid_payload", `${options.name} must be a number`);
  }
  const int = Math.trunc(num);
  if (int < options.min || int > options.max) {
    throw new ApiError(400, "invalid_payload", `${options.name} must be between ${options.min} and ${options.max}`);
  }
  return int;
}

function parseAgentLabSchedule(value: unknown): AgentLabSchedule {
  if (!value || typeof value !== "object") {
    throw new ApiError(400, "invalid_payload", "schedule is required");
  }
  const schedule = value as Record<string, unknown>;
  const kind = typeof schedule.kind === "string" ? schedule.kind.trim() : "";
  if (kind === "interval") {
    const seconds = clampInt(schedule.seconds, { min: 60, max: 7 * 24 * 60 * 60, name: "schedule.seconds" });
    return { kind: "interval", seconds };
  }
  if (kind === "daily") {
    const hour = clampInt(schedule.hour, { min: 0, max: 23, name: "schedule.hour" });
    const minute = clampInt(schedule.minute, { min: 0, max: 59, name: "schedule.minute" });
    return { kind: "daily", hour, minute };
  }
  if (kind === "weekly") {
    const weekday = clampInt(schedule.weekday, { min: 1, max: 7, name: "schedule.weekday" });
    const hour = clampInt(schedule.hour, { min: 0, max: 23, name: "schedule.hour" });
    const minute = clampInt(schedule.minute, { min: 0, max: 59, name: "schedule.minute" });
    return { kind: "weekly", weekday, hour, minute };
  }
  throw new ApiError(400, "invalid_payload", "schedule.kind must be interval, daily, or weekly");
}

function validateAgentLabAutomationId(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    throw new ApiError(400, "invalid_payload", "automation id is required");
  }
  if (raw.length > 80) {
    throw new ApiError(400, "invalid_payload", "automation id is too long");
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(raw)) {
    throw new ApiError(400, "invalid_payload", "automation id must match /^[a-zA-Z0-9_-]+$/");
  }
  return raw;
}

async function readAgentLabAutomations(workspaceRoot: string): Promise<AgentLabAutomationStore> {
  const path = resolveAgentLabAutomationsPath(workspaceRoot);
  if (!(await exists(path))) {
    return { schemaVersion: 1, updatedAt: Date.now(), items: [] };
  }
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<AgentLabAutomationStore>;
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    const normalized: AgentLabAutomation[] = [];
    for (const item of items) {
      const record = item as Partial<AgentLabAutomation>;
      const id = typeof record.id === "string" ? record.id.trim() : "";
      const name = typeof record.name === "string" ? record.name.trim() : "";
      const prompt = typeof record.prompt === "string" ? record.prompt : "";
      const enabled = typeof record.enabled === "boolean" ? record.enabled : true;
      if (!id || !name || !prompt) continue;
      let schedule: AgentLabSchedule;
      try {
        schedule = parseAgentLabSchedule(record.schedule);
      } catch {
        continue;
      }
      normalized.push({
        id,
        name,
        enabled,
        schedule,
        prompt,
        createdAt: typeof record.createdAt === "number" ? record.createdAt : Date.now(),
        updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : undefined,
        lastRunAt: typeof record.lastRunAt === "number" ? record.lastRunAt : undefined,
        lastRunSessionId: typeof record.lastRunSessionId === "string" ? record.lastRunSessionId : undefined,
      });
    }
    return {
      schemaVersion: typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : 1,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
      items: normalized,
    };
  } catch {
    throw new ApiError(422, "invalid_json", "Failed to parse Agent Lab automations");
  }
}

async function writeAgentLabAutomations(workspaceRoot: string, store: AgentLabAutomationStore): Promise<void> {
  const path = resolveAgentLabAutomationsPath(workspaceRoot);
  await ensureDir(dirname(path));
  await writeFile(path, JSON.stringify({ ...store, updatedAt: Date.now() }, null, 2) + "\n", "utf8");
}

export function normalizeWorkspaceRelativePath(input: string, options: { allowSubdirs: boolean }): string {
  const raw = String(input ?? "").trim();
  if (!raw) {
    throw new ApiError(400, "invalid_path", "Path is required");
  }
  if (raw.includes("\u0000")) {
    throw new ApiError(400, "invalid_path", "Path contains null byte");
  }

  // A lot of user-facing surfaces (artifacts, tool logs) reference files as
  // `workspace/<path>` or `/workspace/<path>`. The server API expects
  // workspace-relative paths, so normalize those common prefixes here.
  let normalized = raw.replace(/\\/g, "/");
  normalized = normalized.replace(/^\/+/, "");
  normalized = normalized.replace(/^\.\//, "");
  normalized = normalized.replace(/^workspace\//, "");
  normalized = normalized.replace(/^\/+/, "");

  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length) {
    throw new ApiError(400, "invalid_path", "Path is required");
  }
  if (!options.allowSubdirs && parts.length > 1) {
    throw new ApiError(400, "invalid_path", "Subdirectories are not allowed");
  }
  for (const part of parts) {
    if (part === "." || part === "..") {
      throw new ApiError(400, "invalid_path", "Path traversal is not allowed");
    }
  }
  return parts.join("/");
}

function resolveSafeChildPath(root: string, child: string): string {
  const rootResolved = resolve(root);
  const candidate = resolve(rootResolved, child);
  if (candidate === rootResolved) {
    throw new ApiError(400, "invalid_path", "Path must point to a file");
  }
  if (!candidate.startsWith(rootResolved + sep)) {
    throw new ApiError(400, "invalid_path", "Path traversal is not allowed");
  }
  return candidate;
}

function encodeArtifactId(path: string): string {
  return Buffer.from(path, "utf8").toString("base64url");
}

function decodeArtifactId(id: string): string {
  const raw = (id ?? "").trim();
  if (!raw) {
    throw new ApiError(400, "invalid_artifact", "Artifact id is required");
  }
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    return normalizeWorkspaceRelativePath(decoded, { allowSubdirs: true });
  } catch {
    throw new ApiError(400, "invalid_artifact", "Artifact id is invalid");
  }
}

function encodeInboxId(path: string): string {
  return encodeArtifactId(path);
}

function decodeInboxId(id: string): string {
  try {
    return decodeArtifactId(id);
  } catch {
    throw new ApiError(400, "invalid_inbox_item", "Inbox item id is invalid");
  }
}

async function listArtifacts(outboxRoot: string): Promise<Array<{ id: string; path: string; size: number; updatedAt: number }>> {
  const rootResolved = resolve(outboxRoot);
  if (!(await exists(rootResolved))) return [];

  const items: Array<{ id: string; path: string; size: number; updatedAt: number }> = [];
  const walk = async (dir: string) => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = normalizeWorkspaceRelativePath(relative(rootResolved, abs), { allowSubdirs: true });
      const info = await stat(abs);
      items.push({
        id: encodeArtifactId(rel),
        path: rel,
        size: info.size,
        updatedAt: info.mtimeMs,
      });
    }
  };

  try {
    await walk(rootResolved);
  } catch {
    return [];
  }

  items.sort((a, b) => b.updatedAt - a.updatedAt);
  return items;
}

async function listInbox(inboxRoot: string): Promise<Array<{ id: string; path: string; size: number; updatedAt: number; name: string }>> {
  const items = await listArtifacts(inboxRoot);
  return items.map((item) => ({
    ...item,
    id: encodeInboxId(item.path),
    name: basename(item.path),
  }));
}

function emitReloadEvent(
  reloadEvents: ReloadEventStore,
  workspace: WorkspaceInfo,
  reason: ReloadReason,
  trigger?: ReloadTrigger,
) {
  void reloadEvents;
  void workspace;
  void reason;
  void trigger;
}

function buildConfigTrigger(path: string): ReloadTrigger {
  const name = path.split(/[\\/]/).filter(Boolean).pop();
  return {
    type: "config",
    name: name || "opencode.json",
    action: "updated",
    path,
  };
}

function serializeWorkspace(workspace: ServerConfig["workspaces"][number]) {
  const { opencodeUsername, opencodePassword, ...rest } = workspace;
  const opencodeDirectory = resolveOpencodeDirectory(workspace);
  const opencode =
    workspace.baseUrl || opencodeDirectory || opencodeUsername || opencodePassword
      ? {
          baseUrl: workspace.baseUrl,
          directory: opencodeDirectory ?? undefined,
          username: opencodeUsername,
          password: opencodePassword,
        }
      : undefined;
  return {
    ...rest,
    opencode,
  };
}

function createRoutes(config: ServerConfig, approvals: ApprovalService, tokens: TokenService): Route[] {
  const routes: Route[] = [];

  addRoute(routes, "GET", "/health", "none", async () => {
    return jsonResponse({ ok: true, version: SERVER_VERSION, uptimeMs: Date.now() - config.startedAt });
  });

  addRoute(routes, "GET", "/w/:id/health", "none", async () => {
    return jsonResponse({ ok: true, version: SERVER_VERSION, uptimeMs: Date.now() - config.startedAt });
  });

  addRoute(routes, "GET", "/ui", "none", async () => {
    if (!resolveToyUiEnabled()) {
      throw new ApiError(404, "ui_disabled", "Toy UI is disabled");
    }
    return htmlResponse(TOY_UI_HTML);
  });

  addRoute(routes, "GET", "/w/:id/ui", "none", async () => {
    if (!resolveToyUiEnabled()) {
      throw new ApiError(404, "ui_disabled", "Toy UI is disabled");
    }
    return htmlResponse(TOY_UI_HTML);
  });

  addRoute(routes, "GET", "/ui/assets/toy.css", "none", async () => {
    if (!resolveToyUiEnabled()) {
      throw new ApiError(404, "ui_disabled", "Toy UI is disabled");
    }
    return cssResponse(TOY_UI_CSS);
  });

  addRoute(routes, "GET", "/ui/assets/toy.js", "none", async () => {
    if (!resolveToyUiEnabled()) {
      throw new ApiError(404, "ui_disabled", "Toy UI is disabled");
    }
    return jsResponse(TOY_UI_JS);
  });

  addRoute(routes, "GET", "/w/:id/status", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    return jsonResponse({
      ok: true,
      version: SERVER_VERSION,
      uptimeMs: Date.now() - config.startedAt,
      readOnly: config.readOnly,
      approval: config.approval,
      corsOrigins: config.corsOrigins,
      workspaceCount: 1,
      activeWorkspaceId: workspace.id,
      workspace: serializeWorkspace(workspace),
      authorizedRoots: config.authorizedRoots,
      server: {
        host: config.host,
        port: config.port,
        configPath: config.configPath ?? null,
      },
      tokenSource: {
        client: config.tokenSource,
        host: config.hostTokenSource,
      },
    });
  });

  addRoute(routes, "GET", "/w/:id/capabilities", "client", async () => {
    return jsonResponse(buildCapabilities(config));
  });

  addRoute(routes, "GET", "/w/:id/workspaces", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    return jsonResponse({ items: [serializeWorkspace(workspace)], activeId: workspace.id });
  });

  addRoute(routes, "GET", "/status", "client", async () => {
    const active = config.workspaces[0];
    return jsonResponse({
      ok: true,
      version: SERVER_VERSION,
      uptimeMs: Date.now() - config.startedAt,
      readOnly: config.readOnly,
      approval: config.approval,
      corsOrigins: config.corsOrigins,
      workspaceCount: config.workspaces.length,
      activeWorkspaceId: active?.id ?? null,
      workspace: active ? serializeWorkspace(active) : null,
      authorizedRoots: config.authorizedRoots,
      server: {
        host: config.host,
        port: config.port,
        configPath: config.configPath ?? null,
      },
      tokenSource: {
        client: config.tokenSource,
        host: config.hostTokenSource,
      },
    });
  });

  addRoute(routes, "GET", "/whoami", "client", async (ctx) => {
    return jsonResponse({ ok: true, actor: ctx.actor ?? null });
  });

  addRoute(routes, "GET", "/capabilities", "client", async () => {
    return jsonResponse(buildCapabilities(config));
  });

  addRoute(routes, "GET", "/workspaces", "client", async () => {
    const active = config.workspaces[0] ?? null;
    const items = config.workspaces.map(serializeWorkspace);
    return jsonResponse({ items, activeId: active?.id ?? null });
  });

  addRoute(routes, "GET", "/tokens", "host", async () => {
    const items = await tokens.list();
    return jsonResponse({ items });
  });

  addRoute(routes, "POST", "/tokens", "host", async (ctx) => {
    ensureWritable(config);
    const body = await readJsonBody(ctx.request);
    const scopeRaw = typeof body.scope === "string" ? body.scope.trim() : "";
    const scope = scopeRaw === "owner" || scopeRaw === "collaborator" || scopeRaw === "viewer" ? scopeRaw : null;
    if (!scope) {
      throw new ApiError(400, "invalid_scope", "Token scope must be owner, collaborator, or viewer");
    }
    const label = typeof body.label === "string" ? body.label.trim() : undefined;
    const issued = await tokens.create(scope, { label });
    return jsonResponse(issued, 201);
  });

  addRoute(routes, "DELETE", "/tokens/:id", "host", async (ctx) => {
    ensureWritable(config);
    const ok = await tokens.revoke(ctx.params.id);
    if (!ok) {
      throw new ApiError(404, "token_not_found", "Token not found");
    }
    return jsonResponse({ ok: true });
  });

  addRoute(routes, "POST", "/workspaces/:id/activate", "host", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    config.workspaces = [
      workspace,
      ...config.workspaces.filter((entry) => entry.id !== workspace.id),
    ];
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "host" },
      action: "workspace.activate",
      target: "workspace",
      summary: "Switched active workspace",
      timestamp: Date.now(),
    });
    return jsonResponse({ activeId: workspace.id, workspace: serializeWorkspace(workspace) });
  });

  addRoute(routes, "DELETE", "/workspaces/:id", "host", async (ctx) => {
    ensureWritable(config);

    const workspace = await resolveWorkspace(config, ctx.params.id);

    // Attempt to persist to server.json (when present) before mutating in-memory state.
    const configPath = config.configPath?.trim() ?? "";
    const persisted = configPath
      ? await persistWorkspaceDeletion(configPath, workspace.id, workspace.path)
      : false;

    const before = config.workspaces.length;
    config.workspaces = config.workspaces.filter((entry) => entry.id !== workspace.id);
    const deleted = before !== config.workspaces.length;

    if (deleted) {
      // Only remove exact matches; authorizedRoots can contain broader entries.
      config.authorizedRoots = config.authorizedRoots.filter((root) => resolve(root) !== resolve(workspace.path));
    }

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "host" },
      action: "workspace.delete",
      target: "workspace",
      summary: "Deleted workspace from OpenWork server",
      timestamp: Date.now(),
    });

    const active = config.workspaces[0] ?? null;
    return jsonResponse({
      ok: true,
      deleted,
      persisted,
      activeId: active?.id ?? null,
      items: config.workspaces.map(serializeWorkspace),
    });
  });

  addRoute(routes, "GET", "/workspace/:id/config", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const opencode = await readOpencodeConfig(workspace.path);
    const openwork = await readOpenworkConfig(workspace.path);
    const lastAudit = await readLastAudit(workspace.path, workspace.id);
    return jsonResponse({ opencode, openwork, updatedAt: lastAudit?.timestamp ?? null });
  });

  addRoute(routes, "GET", "/workspace/:id/audit", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const limitParam = ctx.url.searchParams.get("limit");
    const parsed = limitParam ? Number(limitParam) : NaN;
    const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 200) : 50;
    const items = await readAuditEntries(workspace.path, workspace.id, limit);
    return jsonResponse({ items });
  });

  addRoute(routes, "DELETE", "/workspace/:id/sessions/:sessionId", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");

    const workspace = await resolveWorkspace(config, ctx.params.id);
    const sessionId = (ctx.params.sessionId ?? "").trim();
    if (!sessionId) {
      throw new ApiError(400, "invalid_payload", "sessionId is required");
    }

    // OpenCode session deletion via the upstream API.
    await fetchOpencodeJson(workspace, `/session/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    });

    return jsonResponse({ ok: true });
  });

  addRoute(routes, "PATCH", "/workspace/:id/config", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const opencode = body.opencode as Record<string, unknown> | undefined;
    const openwork = body.openwork as Record<string, unknown> | undefined;

    if (!opencode && !openwork) {
      throw new ApiError(400, "invalid_payload", "opencode or openwork updates required");
    }

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "config.patch",
      summary: "Patch workspace config",
      paths: [opencode ? opencodeConfigPath(workspace.path) : null, openwork ? openworkConfigPath(workspace.path) : null].filter(Boolean) as string[],
    });

    if (opencode) {
      await updateJsoncTopLevel(opencodeConfigPath(workspace.path), opencode);
    }
    if (openwork) {
      await writeOpenworkConfig(workspace.path, openwork, true);
    }

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "config.patch",
      target: "opencode.json",
      summary: "Patched workspace config",
      timestamp: Date.now(),
    });

    if (opencode) {
      emitReloadEvent(ctx.reloadEvents, workspace, "config", buildConfigTrigger(opencodeConfigPath(workspace.path)));
    }

    return jsonResponse({ updatedAt: Date.now() });
  });

  addRoute(routes, "POST", "/workspace/:id/opencode-router/telegram-token", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const token = typeof body.token === "string" ? body.token.trim() : "";
    const healthPort = normalizeHealthPort(body.healthPort);
    const requestHost = ctx.url.hostname;
    logOpenCodeRouterDebug("telegram-token:request", {
      workspaceId: workspace.id,
      actor: ctx.actor?.type ?? "unknown",
      hasToken: Boolean(token),
      healthPort: healthPort ?? null,
      requestHost,
    });
    if (!token) {
      throw new ApiError(400, "token_required", "Telegram token is required");
    }

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "opencodeRouter.telegram.set-token",
      summary: "Set Telegram bot token",
      paths: [resolveOpenCodeRouterConfigPath()],
    });

    const identityId = normalizeOpenCodeRouterIdentityId(workspace.id);
    await persistOpenCodeRouterTelegramIdentity({ id: identityId, token, enabled: true, directory: workspace.path });

    const port = healthPort ?? resolveOpenCodeRouterHealthPort();
    const apply = await tryPostOpenCodeRouterHealth(
      "/identities/telegram",
      { id: identityId, token, enabled: true, directory: workspace.path },
      { port, requestHost, timeoutMs: 3_000 },
    );

    const result: Record<string, unknown> = {
      ok: true,
      persisted: true,
      applied: apply.applied,
      telegram: { configured: true, enabled: true },
    };

    const bot = await fetchTelegramBotInfo(token);
    if (bot) {
      (result.telegram as Record<string, unknown>).bot = bot;
    }

    // Reflect opencodeRouter apply status when available.
    if (apply.body && typeof apply.body === "object") {
      const record = apply.body as Record<string, unknown>;
      if (record.telegram && typeof record.telegram === "object") {
        const telegram = record.telegram as Record<string, unknown>;
        if (typeof telegram.applied === "boolean") {
          (result.telegram as Record<string, unknown>).applied = telegram.applied;
          result.applied = telegram.applied;
        }
        if (typeof telegram.starting === "boolean") {
          (result.telegram as Record<string, unknown>).starting = telegram.starting;
        }
        if (typeof telegram.error === "string" && telegram.error.trim()) {
          (result.telegram as Record<string, unknown>).error = telegram.error;
          result.applyError = telegram.error;
        }
      }
    }

    if (!apply.applied) {
      result.applyError = (typeof result.applyError === "string" && result.applyError.trim())
        ? result.applyError
        : apply.error ?? "OpenCodeRouter did not apply the update";
      if (typeof apply.status === "number") result.applyStatus = apply.status;
    }
    logOpenCodeRouterDebug("telegram-token:updated", {
      workspaceId: workspace.id,
      applied: typeof result.applied === "boolean" ? result.applied : null,
      applyError: typeof result.applyError === "string" ? result.applyError : null,
    });

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "opencodeRouter.telegram.set-token",
      target: "opencodeRouter.telegram",
      summary: "Updated Telegram bot token",
      timestamp: Date.now(),
    });

    return jsonResponse(result);
  });

  addRoute(routes, "GET", "/workspace/:id/opencode-router/telegram", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    await resolveWorkspace(config, ctx.params.id);
    const info = await readOpenCodeRouterTelegramInfo();
    return jsonResponse({ ok: true, ...info });
  });

  addRoute(routes, "POST", "/workspace/:id/opencode-router/telegram-enabled", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const enabled = body.enabled === true || body.enabled === "true";
    const clearToken = body.clearToken === true || body.clearToken === "true";
    const healthPort = normalizeHealthPort(body.healthPort);
    const requestHost = ctx.url.hostname;

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "opencodeRouter.telegram.set-enabled",
      summary: enabled ? "Enable Telegram" : "Disable Telegram",
      paths: [resolveOpenCodeRouterConfigPath()],
    });

    await persistOpenCodeRouterTelegramEnabled(enabled, { clearToken: !enabled && clearToken });

    // OpenCodeRouter no longer exposes a channel-wide enable/disable endpoint.
    // Persisting the flag gates all identities on next start.
    const response: Record<string, unknown> = {
      ok: true,
      persisted: true,
      enabled,
      applied: false,
      applyError: "Restart opencodeRouter to apply",
    };

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "opencodeRouter.telegram.set-enabled",
      target: "opencodeRouter.telegram",
      summary: enabled ? "Enabled Telegram" : "Disabled Telegram",
      timestamp: Date.now(),
    });

    return jsonResponse(response);
  });

  addRoute(routes, "POST", "/workspace/:id/opencode-router/slack-tokens", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const botToken = typeof body.botToken === "string" ? body.botToken.trim() : "";
    const appToken = typeof body.appToken === "string" ? body.appToken.trim() : "";
    const healthPort = normalizeHealthPort(body.healthPort);
    const requestHost = ctx.url.hostname;
    logOpenCodeRouterDebug("slack-tokens:request", {
      workspaceId: workspace.id,
      actor: ctx.actor?.type ?? "unknown",
      hasBotToken: Boolean(botToken),
      hasAppToken: Boolean(appToken),
      healthPort: healthPort ?? null,
      requestHost,
    });
    if (!botToken || !appToken) {
      throw new ApiError(400, "token_required", "Slack botToken and appToken are required");
    }

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "opencodeRouter.slack.set-tokens",
      summary: "Set Slack bot tokens",
      paths: [resolveOpenCodeRouterConfigPath()],
    });

    const identityId = normalizeOpenCodeRouterIdentityId(workspace.id);
    await persistOpenCodeRouterSlackIdentity({ id: identityId, botToken, appToken, enabled: true, directory: workspace.path });

    const port = healthPort ?? resolveOpenCodeRouterHealthPort();
    const apply = await tryPostOpenCodeRouterHealth(
      "/identities/slack",
      { id: identityId, botToken, appToken, enabled: true, directory: workspace.path },
      { port, requestHost, timeoutMs: 3_000 },
    );

    const result: Record<string, unknown> = {
      ok: true,
      persisted: true,
      applied: apply.applied,
      slack: { configured: true, enabled: true },
    };

    if (apply.body && typeof apply.body === "object") {
      const record = apply.body as Record<string, unknown>;
      if (record.slack && typeof record.slack === "object") {
        const slack = record.slack as Record<string, unknown>;
        if (typeof slack.applied === "boolean") {
          (result.slack as Record<string, unknown>).applied = slack.applied;
          result.applied = slack.applied;
        }
        if (typeof slack.starting === "boolean") {
          (result.slack as Record<string, unknown>).starting = slack.starting;
        }
        if (typeof slack.error === "string" && slack.error.trim()) {
          (result.slack as Record<string, unknown>).error = slack.error;
          result.applyError = slack.error;
        }
      }
    }

    if (!apply.applied) {
      result.applyError = (typeof result.applyError === "string" && result.applyError.trim())
        ? result.applyError
        : apply.error ?? "OpenCodeRouter did not apply the update";
      if (typeof apply.status === "number") result.applyStatus = apply.status;
    }
    logOpenCodeRouterDebug("slack-tokens:updated", {
      workspaceId: workspace.id,
      applied: typeof result.applied === "boolean" ? result.applied : null,
      applyError: typeof result.applyError === "string" ? result.applyError : null,
    });

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "opencodeRouter.slack.set-tokens",
      target: "opencodeRouter.slack",
      summary: "Updated Slack bot tokens",
      timestamp: Date.now(),
    });

    return jsonResponse(result);
  });

  addRoute(routes, "GET", "/workspace/:id/opencode-router/identities/telegram", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const workspaceIdentityId = normalizeOpenCodeRouterIdentityId(workspace.id);

    const healthPortParam = parseInteger(ctx.url.searchParams.get("healthPort") ?? undefined);
    const port = healthPortParam ?? resolveOpenCodeRouterHealthPort();
    const requestHost = ctx.url.hostname;

    const apply = await tryFetchOpenCodeRouterHealth("GET", "/identities/telegram", {
      port,
      requestHost,
      timeoutMs: 2_000,
    });

    if (apply.applied && apply.body && typeof apply.body === "object") {
      const payload = apply.body as Record<string, unknown>;
      const rawItems = (payload as any).items;
      if (Array.isArray(rawItems)) {
        const items = rawItems
          .filter(
            (entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)),
          )
          .map((entry) => {
            const id = normalizeOpenCodeRouterIdentityId(entry.id);
            const enabled = entry.enabled === undefined ? true : entry.enabled === true || entry.enabled === "true";
            const running = entry.running === true || entry.running === "true";
            const access = normalizeTelegramAccessMode(
              entry.access,
              entry.pairingRequired === true || entry.pairingRequired === "true" ? "private" : "public",
            );
            return { id, enabled, running, access, pairingRequired: access === "private" };
          })
          .filter((item) => item.id === workspaceIdentityId);
        return jsonResponse({ ...payload, items });
      }
      return jsonResponse(payload);
    }

    const current = await readOpenCodeRouterConfigFile(resolveOpenCodeRouterConfigPath());
    const channels = ensurePlainObject(current.channels);
    const telegram = ensurePlainObject(channels.telegram);
    const botsRaw = (telegram as any).bots;
    const bots = Array.isArray(botsRaw) ? (botsRaw as unknown[]) : [];
    const items = bots
      .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)))
      .map((entry) => {
        const id = normalizeOpenCodeRouterIdentityId(entry.id);
        const enabled = entry.enabled === undefined ? true : entry.enabled === true || entry.enabled === "true";
        const { access } = resolveTelegramAccessFromRecord(entry);
        return { id, enabled, running: false, access, pairingRequired: access === "private" };
      })
      .filter((item) => item.id === workspaceIdentityId);
    return jsonResponse({ ok: true, items });
  });

  addRoute(routes, "POST", "/workspace/:id/opencode-router/identities/telegram", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const token = typeof body.token === "string" ? body.token.trim() : "";
    const enabled = body.enabled === undefined ? true : body.enabled === true || body.enabled === "true";
    const access = normalizeTelegramAccessMode(body.access, "public");
    const pairingCodeInput = typeof body.pairingCode === "string" ? body.pairingCode : "";
    const normalizedPairingCodeInput = normalizeTelegramPairingCode(pairingCodeInput);
    if (
      access === "private" &&
      pairingCodeInput.trim() &&
      (normalizedPairingCodeInput.length < 6 || normalizedPairingCodeInput.length > 24)
    ) {
      throw new ApiError(
        400,
        "invalid_pairing_code",
        "Pairing code must be 6-24 letters or numbers",
      );
    }
    const pairingCode =
      access === "private"
        ? (normalizedPairingCodeInput || normalizeTelegramPairingCode(generateTelegramPairingCode()))
        : "";
    const pairingCodeHash = access === "private" ? hashTelegramPairingCode(pairingCode) : "";
    const workspaceIdentityId = normalizeOpenCodeRouterIdentityId(workspace.id);
    const requestedId = typeof body.id === "string" ? normalizeOpenCodeRouterIdentityId(body.id) : "";
    if (requestedId && requestedId !== workspaceIdentityId) {
      throw new ApiError(
        400,
        "identity_mismatch",
        `Identity id is scoped to this workspace (${workspace.id}).`,
        { expected: workspaceIdentityId, received: requestedId },
      );
    }
    const identityId = workspaceIdentityId;
    if (identityId === "env") {
      throw new ApiError(400, "invalid_identity", "Identity id 'env' is reserved");
    }
    const healthPort = normalizeHealthPort(body.healthPort);
    const requestHost = ctx.url.hostname;
    if (!token) {
      throw new ApiError(400, "token_required", "Telegram token is required");
    }

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "opencodeRouter.telegram.identity.upsert",
      summary: `Upsert Telegram identity (${identityId})`,
      paths: [resolveOpenCodeRouterConfigPath()],
    });

    await persistOpenCodeRouterTelegramIdentity({
      id: identityId,
      token,
      enabled,
      directory: workspace.path,
      access,
      ...(access === "private" ? { pairingCodeHash } : {}),
    });

    const port = healthPort ?? resolveOpenCodeRouterHealthPort();
    const apply = await tryPostOpenCodeRouterHealth(
      "/identities/telegram",
      {
        id: identityId,
        token,
        enabled,
        directory: workspace.path,
        access,
        ...(access === "private" ? { pairingCodeHash } : {}),
      },
      { port, requestHost, timeoutMs: 3_000 },
    );

    const response: Record<string, unknown> = {
      ok: true,
      persisted: true,
      applied: apply.applied,
      telegram: {
        id: identityId,
        enabled,
        access,
        pairingRequired: access === "private",
        ...(access === "private" ? { pairingCode } : {}),
      },
    };

    const bot = await fetchTelegramBotInfo(token);
    if (bot) {
      (response.telegram as Record<string, unknown>).bot = bot;
    }

    if (apply.body && typeof apply.body === "object") {
      const record = apply.body as Record<string, unknown>;
      if (record.telegram && typeof record.telegram === "object") {
        response.telegram = {
          ...(response.telegram as Record<string, unknown>),
          ...(record.telegram as Record<string, unknown>),
          access,
          pairingRequired: access === "private",
          ...(access === "private" ? { pairingCode } : {}),
        };
      }
    }

    if (!apply.applied) {
      response.applyError = apply.error ?? "OpenCodeRouter did not apply the update";
      if (typeof apply.status === "number") response.applyStatus = apply.status;
    }

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "opencodeRouter.telegram.identity.upsert",
      target: "opencodeRouter.telegram",
      summary: `Upserted Telegram identity (${identityId})`,
      timestamp: Date.now(),
    });

    return jsonResponse(response);
  });

  addRoute(routes, "DELETE", "/workspace/:id/opencode-router/identities/telegram/:identityId", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const workspaceIdentityId = normalizeOpenCodeRouterIdentityId(workspace.id);
    const requestedId = normalizeOpenCodeRouterIdentityId(ctx.params.identityId);
    if (requestedId && requestedId !== workspaceIdentityId) {
      throw new ApiError(
        400,
        "identity_mismatch",
        `Identity id is scoped to this workspace (${workspace.id}).`,
        { expected: workspaceIdentityId, received: requestedId },
      );
    }
    const identityId = workspaceIdentityId;
    if (identityId === "env") {
      throw new ApiError(400, "invalid_identity", "Identity id 'env' is reserved");
    }

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "opencodeRouter.telegram.identity.delete",
      summary: `Delete Telegram identity (${identityId})`,
      paths: [resolveOpenCodeRouterConfigPath()],
    });

    const deleted = await deleteOpenCodeRouterTelegramIdentity(identityId);
    const healthPortParam = parseInteger(ctx.url.searchParams.get("healthPort") ?? undefined);
    const port = healthPortParam ?? resolveOpenCodeRouterHealthPort();
    const requestHost = ctx.url.hostname;
    const apply = await tryFetchOpenCodeRouterHealth(
      "DELETE",
      `/identities/telegram/${encodeURIComponent(identityId)}`,
      {
        port,
        requestHost,
        timeoutMs: 3_000,
      },
    );

    const response: Record<string, unknown> = {
      ok: true,
      persisted: true,
      deleted,
      applied: apply.applied,
      telegram: { id: identityId, deleted },
    };

    if (apply.body && typeof apply.body === "object") {
      const record = apply.body as Record<string, unknown>;
      if (record.telegram && typeof record.telegram === "object") {
        response.telegram = record.telegram;
      }
    }

    if (!apply.applied) {
      response.applyError = apply.error ?? "OpenCodeRouter did not apply the update";
      if (typeof apply.status === "number") response.applyStatus = apply.status;
    }

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "opencodeRouter.telegram.identity.delete",
      target: "opencodeRouter.telegram",
      summary: `Deleted Telegram identity (${identityId})`,
      timestamp: Date.now(),
    });

    return jsonResponse(response);
  });

  addRoute(routes, "GET", "/workspace/:id/opencode-router/identities/slack", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const workspaceIdentityId = normalizeOpenCodeRouterIdentityId(workspace.id);

    const healthPortParam = parseInteger(ctx.url.searchParams.get("healthPort") ?? undefined);
    const port = healthPortParam ?? resolveOpenCodeRouterHealthPort();
    const requestHost = ctx.url.hostname;

    const apply = await tryFetchOpenCodeRouterHealth("GET", "/identities/slack", {
      port,
      requestHost,
      timeoutMs: 2_000,
    });

    if (apply.applied && apply.body && typeof apply.body === "object") {
      const payload = apply.body as Record<string, unknown>;
      const rawItems = (payload as any).items;
      if (Array.isArray(rawItems)) {
        const items = rawItems
          .filter(
            (entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)),
          )
          .map((entry) => {
            const id = normalizeOpenCodeRouterIdentityId(entry.id);
            const enabled = entry.enabled === undefined ? true : entry.enabled === true || entry.enabled === "true";
            const running = entry.running === true || entry.running === "true";
            return { id, enabled, running };
          })
          .filter((item) => item.id === workspaceIdentityId);
        return jsonResponse({ ...payload, items });
      }
      return jsonResponse(payload);
    }

    const current = await readOpenCodeRouterConfigFile(resolveOpenCodeRouterConfigPath());
    const channels = ensurePlainObject(current.channels);
    const slack = ensurePlainObject(channels.slack);
    const appsRaw = (slack as any).apps;
    const apps = Array.isArray(appsRaw) ? (appsRaw as unknown[]) : [];
    const items = apps
      .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)))
      .map((entry) => {
        const id = normalizeOpenCodeRouterIdentityId(entry.id);
        const enabled = entry.enabled === undefined ? true : entry.enabled === true || entry.enabled === "true";
        return { id, enabled, running: false };
      })
      .filter((item) => item.id === workspaceIdentityId);
    return jsonResponse({ ok: true, items });
  });

  addRoute(routes, "POST", "/workspace/:id/opencode-router/identities/slack", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const botToken = typeof body.botToken === "string" ? body.botToken.trim() : "";
    const appToken = typeof body.appToken === "string" ? body.appToken.trim() : "";
    const enabled = body.enabled === undefined ? true : body.enabled === true || body.enabled === "true";
    const workspaceIdentityId = normalizeOpenCodeRouterIdentityId(workspace.id);
    const requestedId = typeof body.id === "string" ? normalizeOpenCodeRouterIdentityId(body.id) : "";
    if (requestedId && requestedId !== workspaceIdentityId) {
      throw new ApiError(
        400,
        "identity_mismatch",
        `Identity id is scoped to this workspace (${workspace.id}).`,
        { expected: workspaceIdentityId, received: requestedId },
      );
    }
    const identityId = workspaceIdentityId;
    if (identityId === "env") {
      throw new ApiError(400, "invalid_identity", "Identity id 'env' is reserved");
    }
    const healthPort = normalizeHealthPort(body.healthPort);
    const requestHost = ctx.url.hostname;
    if (!botToken || !appToken) {
      throw new ApiError(400, "token_required", "Slack botToken and appToken are required");
    }

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "opencodeRouter.slack.identity.upsert",
      summary: `Upsert Slack identity (${identityId})`,
      paths: [resolveOpenCodeRouterConfigPath()],
    });

    await persistOpenCodeRouterSlackIdentity({ id: identityId, botToken, appToken, enabled, directory: workspace.path });

    const port = healthPort ?? resolveOpenCodeRouterHealthPort();
    const apply = await tryPostOpenCodeRouterHealth(
      "/identities/slack",
      { id: identityId, botToken, appToken, enabled, directory: workspace.path },
      { port, requestHost, timeoutMs: 3_000 },
    );

    const response: Record<string, unknown> = {
      ok: true,
      persisted: true,
      applied: apply.applied,
      slack: { id: identityId, enabled },
    };

    if (apply.body && typeof apply.body === "object") {
      const record = apply.body as Record<string, unknown>;
      if (record.slack && typeof record.slack === "object") {
        response.slack = record.slack;
      }
    }

    if (!apply.applied) {
      response.applyError = apply.error ?? "OpenCodeRouter did not apply the update";
      if (typeof apply.status === "number") response.applyStatus = apply.status;
    }

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "opencodeRouter.slack.identity.upsert",
      target: "opencodeRouter.slack",
      summary: `Upserted Slack identity (${identityId})`,
      timestamp: Date.now(),
    });

    return jsonResponse(response);
  });

  addRoute(routes, "DELETE", "/workspace/:id/opencode-router/identities/slack/:identityId", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const workspaceIdentityId = normalizeOpenCodeRouterIdentityId(workspace.id);
    const requestedId = normalizeOpenCodeRouterIdentityId(ctx.params.identityId);
    if (requestedId && requestedId !== workspaceIdentityId) {
      throw new ApiError(
        400,
        "identity_mismatch",
        `Identity id is scoped to this workspace (${workspace.id}).`,
        { expected: workspaceIdentityId, received: requestedId },
      );
    }
    const identityId = workspaceIdentityId;
    if (identityId === "env") {
      throw new ApiError(400, "invalid_identity", "Identity id 'env' is reserved");
    }

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "opencodeRouter.slack.identity.delete",
      summary: `Delete Slack identity (${identityId})`,
      paths: [resolveOpenCodeRouterConfigPath()],
    });

    const deleted = await deleteOpenCodeRouterSlackIdentity(identityId);
    const healthPortParam = parseInteger(ctx.url.searchParams.get("healthPort") ?? undefined);
    const port = healthPortParam ?? resolveOpenCodeRouterHealthPort();
    const requestHost = ctx.url.hostname;
    const apply = await tryFetchOpenCodeRouterHealth(
      "DELETE",
      `/identities/slack/${encodeURIComponent(identityId)}`,
      {
        port,
        requestHost,
        timeoutMs: 3_000,
      },
    );

    const response: Record<string, unknown> = {
      ok: true,
      persisted: true,
      deleted,
      applied: apply.applied,
      slack: { id: identityId, deleted },
    };

    if (apply.body && typeof apply.body === "object") {
      const record = apply.body as Record<string, unknown>;
      if (record.slack && typeof record.slack === "object") {
        response.slack = record.slack;
      }
    }

    if (!apply.applied) {
      response.applyError = apply.error ?? "OpenCodeRouter did not apply the update";
      if (typeof apply.status === "number") response.applyStatus = apply.status;
    }

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "opencodeRouter.slack.identity.delete",
      target: "opencodeRouter.slack",
      summary: `Deleted Slack identity (${identityId})`,
      timestamp: Date.now(),
    });

    return jsonResponse(response);
  });

  addRoute(routes, "GET", "/workspace/:id/opencode-router/bindings", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const workspaceIdentityId = normalizeOpenCodeRouterIdentityId(workspace.id);
    const healthPortParam = parseInteger(ctx.url.searchParams.get("healthPort") ?? undefined);
    const port = healthPortParam ?? resolveOpenCodeRouterHealthPort();
    const requestHost = ctx.url.hostname;

    const search = new URLSearchParams();
    const channel = (ctx.url.searchParams.get("channel") ?? "").trim();
    const identityIdParam = (ctx.url.searchParams.get("identityId") ?? "").trim();
    const requestedId = identityIdParam ? normalizeOpenCodeRouterIdentityId(identityIdParam) : "";
    if (requestedId && requestedId !== workspaceIdentityId) {
      throw new ApiError(
        400,
        "identity_mismatch",
        `Identity id is scoped to this workspace (${workspace.id}).`,
        { expected: workspaceIdentityId, received: requestedId },
      );
    }
    if (channel) search.set("channel", channel);
    search.set("identityId", workspaceIdentityId);
    const suffix = search.toString();
    const pathname = suffix ? `/bindings?${suffix}` : "/bindings";

    const apply = await tryFetchOpenCodeRouterHealth("GET", pathname, { port, requestHost, timeoutMs: 2_000 });
    if (apply.applied && apply.body && typeof apply.body === "object") {
      return jsonResponse(apply.body);
    }
    throw new ApiError(503, "opencodeRouter_unreachable", "OpenCodeRouter is not reachable on this host", {
      port,
      error: apply.error,
      status: apply.status,
    });
  });

  addRoute(routes, "POST", "/workspace/:id/opencode-router/bindings", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const workspaceIdentityId = normalizeOpenCodeRouterIdentityId(workspace.id);
    const body = await readJsonBody(ctx.request);
    const channel = typeof body.channel === "string" ? body.channel.trim().toLowerCase() : "";
    const identityIdParam = typeof body.identityId === "string" ? body.identityId.trim() : "";
    const requestedId = identityIdParam ? normalizeOpenCodeRouterIdentityId(identityIdParam) : "";
    if (requestedId && requestedId !== workspaceIdentityId) {
      throw new ApiError(
        400,
        "identity_mismatch",
        `Identity id is scoped to this workspace (${workspace.id}).`,
        { expected: workspaceIdentityId, received: requestedId },
      );
    }
    const identityId = workspaceIdentityId;
    const peerId = typeof body.peerId === "string" ? body.peerId.trim() : "";
    const directory = typeof body.directory === "string" ? body.directory.trim() : "";
    const healthPort = normalizeHealthPort(body.healthPort);
    const requestHost = ctx.url.hostname;

    if (channel !== "telegram" && channel !== "slack") {
      throw new ApiError(400, "invalid_channel", "channel must be 'telegram' or 'slack'");
    }
    if (!peerId) {
      throw new ApiError(400, "peer_required", "peerId is required");
    }

    const action = directory ? "opencodeRouter.binding.set" : "opencodeRouter.binding.clear";
    const summary = directory
      ? `Bind ${channel}/${identityId}:${peerId} -> ${directory}`
      : `Clear binding for ${channel}/${identityId}:${peerId}`;

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action,
      summary,
      paths: [resolveOpenCodeRouterConfigPath()],
    });

    const port = healthPort ?? resolveOpenCodeRouterHealthPort();
    const payload: Record<string, unknown> = {
      channel,
      identityId,
      peerId,
      ...(directory ? { directory } : {}),
    };
    const apply = await tryPostOpenCodeRouterHealth("/bindings", payload, { port, requestHost, timeoutMs: 3_000 });
    if (!apply.applied) {
      throw new ApiError(503, "opencodeRouter_unreachable", "OpenCodeRouter did not apply binding update", {
        port,
        error: apply.error,
        status: apply.status,
      });
    }

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action,
      target: "opencodeRouter.binding",
      summary,
      timestamp: Date.now(),
    });

    if (apply.body && typeof apply.body === "object") {
      return jsonResponse(apply.body);
    }
    return jsonResponse({ ok: true });
  });

  addRoute(routes, "POST", "/workspace/:id/opencode-router/send", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const workspaceIdentityId = normalizeOpenCodeRouterIdentityId(workspace.id);
    const body = await readJsonBody(ctx.request);
    const channel = typeof body.channel === "string" ? body.channel.trim().toLowerCase() : "";
    const text = typeof body.text === "string" ? body.text : "";
    const peerId = typeof body.peerId === "string" ? body.peerId.trim() : "";
    const autoBind = body.autoBind === true || body.autoBind === "true";
    const directoryInput = typeof body.directory === "string" ? body.directory.trim() : "";
    const directory = directoryInput || workspace.path;
    const healthPort = normalizeHealthPort(body.healthPort);
    const requestHost = ctx.url.hostname;

    const identityIdParam = typeof body.identityId === "string" ? body.identityId.trim() : "";
    const requestedId = identityIdParam ? normalizeOpenCodeRouterIdentityId(identityIdParam) : "";
    if (requestedId && requestedId !== workspaceIdentityId) {
      throw new ApiError(
        400,
        "identity_mismatch",
        `Identity id is scoped to this workspace (${workspace.id}).`,
        { expected: workspaceIdentityId, received: requestedId },
      );
    }
    const identityId = requestedId || undefined;

    if (channel !== "telegram" && channel !== "slack") {
      throw new ApiError(400, "invalid_channel", "channel must be 'telegram' or 'slack'");
    }
    if (!directory.trim() && !peerId) {
      throw new ApiError(400, "directory_required", "directory is required when peerId is not provided");
    }
    if (!text.trim()) {
      throw new ApiError(400, "text_required", "text is required");
    }

    const port = healthPort ?? resolveOpenCodeRouterHealthPort();
    const apply = await tryPostOpenCodeRouterHealth(
      "/send",
      {
        channel,
        ...(identityId ? { identityId } : {}),
        ...(directory.trim() ? { directory } : {}),
        ...(peerId ? { peerId } : {}),
        ...(autoBind ? { autoBind: true } : {}),
        text,
      },
      { port, requestHost, timeoutMs: 5_000 },
    );

    if (!apply.applied) {
      throw new ApiError(503, "opencodeRouter_unreachable", "OpenCodeRouter did not send the message", {
        port,
        error: apply.error,
        status: apply.status,
      });
    }

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "opencodeRouter.send",
      target: `opencodeRouter.${channel}`,
      summary: `Sent outbound ${channel} message${identityId ? ` for ${identityId}` : ""}${peerId ? ` to ${peerId}` : ""}`,
      timestamp: Date.now(),
    });

    if (apply.body && typeof apply.body === "object") {
      return jsonResponse(apply.body);
    }
    return jsonResponse({
      ok: true,
      channel,
      identityId,
      directory,
      attempted: 0,
      sent: 0,
    });
  });

  addRoute(routes, "GET", "/workspace/:id/events", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    void ctx;
    return jsonResponse({ items: [], cursor: 0, workspaceId: workspace.id, disabled: true });
  });

  addRoute(routes, "POST", "/workspace/:id/engine/reload", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    throw new ApiError(410, "engine_reload_deprecated", "OpenWork-managed engine reload is disabled", {
      workspaceId: workspace.id,
      guidance: "Use OpenCode hot reload instead",
    });
  });

  addRoute(routes, "GET", "/workspace/:id/inbox", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    if (!resolveInboxEnabled()) {
      return jsonResponse({ items: [] });
    }
    const inboxRoot = resolveInboxDir(workspace.path);
    const items = await listInbox(inboxRoot);
    return jsonResponse({ items });
  });

  addRoute(routes, "GET", "/workspace/:id/inbox/:inboxId", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    if (!resolveInboxEnabled()) {
      throw new ApiError(404, "inbox_disabled", "Workspace inbox is disabled");
    }
    const inboxRoot = resolveInboxDir(workspace.path);
    const relativePath = decodeInboxId(ctx.params.inboxId);
    const absPath = resolveSafeChildPath(inboxRoot, relativePath);
    if (!(await exists(absPath))) {
      throw new ApiError(404, "inbox_item_not_found", "Inbox item not found");
    }
    const info = await stat(absPath);
    if (!info.isFile()) {
      throw new ApiError(404, "inbox_item_not_found", "Inbox item not found");
    }

    const headers = new Headers();
    headers.set("Content-Type", "application/octet-stream");
    headers.set("Content-Length", String(info.size));
    headers.set("Content-Disposition", `attachment; filename=\"${basename(relativePath)}\"`);
    return new Response((Bun as any).file(absPath), { status: 200, headers });
  });

  addRoute(routes, "POST", "/workspace/:id/inbox", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    if (!resolveInboxEnabled()) {
      throw new ApiError(404, "inbox_disabled", "Workspace inbox is disabled");
    }
    const workspace = await resolveWorkspace(config, ctx.params.id);

    const contentType = ctx.request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("multipart/form-data")) {
      throw new ApiError(400, "invalid_payload", "Expected multipart/form-data");
    }
    const form = await ctx.request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new ApiError(400, "file_required", "Form field 'file' is required");
    }

    const queryPath = (ctx.url.searchParams.get("path") ?? "").trim();
    const formPath = typeof form.get("path") === "string" ? String(form.get("path") || "").trim() : "";
    const requestedPath = queryPath || formPath || file.name;

    const relativePath = normalizeWorkspaceRelativePath(requestedPath, { allowSubdirs: true });
    const inboxRoot = resolveInboxDir(workspace.path);
    const dest = resolveSafeChildPath(inboxRoot, relativePath);
    const maxBytes = resolveInboxMaxBytes();
    if (file.size > maxBytes) {
      throw new ApiError(413, "file_too_large", "File exceeds upload limit", { maxBytes, size: file.size });
    }

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "workspace.inbox.upload",
      summary: `Upload ${relativePath} to inbox`,
      paths: [dest],
    });

    await ensureDir(dirname(dest));
    const bytes = Buffer.from(await file.arrayBuffer());
    const tmp = `${dest}.tmp-${shortId()}`;
    await writeFile(tmp, bytes);
    await rename(tmp, dest);

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "workspace.inbox.upload",
      target: dest,
      summary: `Uploaded ${relativePath} to inbox`,
      timestamp: Date.now(),
    });

    return jsonResponse({ ok: true, path: relativePath, bytes: file.size });
  });

  addRoute(routes, "GET", "/workspace/:id/artifacts", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    if (!resolveOutboxEnabled()) {
      return jsonResponse({ items: [] });
    }
    const outboxRoot = resolveOutboxDir(workspace.path);
    const items = await listArtifacts(outboxRoot);
    return jsonResponse({ items });
  });

  addRoute(routes, "GET", "/workspace/:id/artifacts/:artifactId", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    if (!resolveOutboxEnabled()) {
      throw new ApiError(404, "outbox_disabled", "Workspace outbox is disabled");
    }
    const outboxRoot = resolveOutboxDir(workspace.path);
    const relativePath = decodeArtifactId(ctx.params.artifactId);
    const absPath = resolveSafeChildPath(outboxRoot, relativePath);
    if (!(await exists(absPath))) {
      throw new ApiError(404, "artifact_not_found", "Artifact not found");
    }
    const info = await stat(absPath);
    if (!info.isFile()) {
      throw new ApiError(404, "artifact_not_found", "Artifact not found");
    }

    const headers = new Headers();
    headers.set("Content-Type", "application/octet-stream");
    headers.set("Content-Length", String(info.size));
    headers.set("Content-Disposition", `attachment; filename="${basename(relativePath)}"`);
    return new Response((Bun as any).file(absPath), { status: 200, headers });
  });

  addRoute(routes, "GET", "/workspace/:id/files/content", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const requested = (ctx.url.searchParams.get("path") ?? "").trim();
    const relativePath = normalizeWorkspaceRelativePath(requested, { allowSubdirs: true });
    const lowered = relativePath.toLowerCase();
    const isMarkdown = lowered.endsWith(".md") || lowered.endsWith(".mdx") || lowered.endsWith(".markdown");
    if (!isMarkdown) {
      throw new ApiError(400, "invalid_path", "Only markdown files are supported");
    }

    const absPath = resolveSafeChildPath(workspace.path, relativePath);
    if (!(await exists(absPath))) {
      throw new ApiError(404, "file_not_found", "File not found");
    }
    const info = await stat(absPath);
    if (!info.isFile()) {
      throw new ApiError(404, "file_not_found", "File not found");
    }

    const maxBytes = 5_000_000;
    if (info.size > maxBytes) {
      throw new ApiError(413, "file_too_large", "File exceeds size limit", { maxBytes, size: info.size });
    }

    const content = await readFile(absPath, "utf8");
    return jsonResponse({ path: relativePath, content, bytes: info.size, updatedAt: info.mtimeMs });
  });

  addRoute(routes, "POST", "/workspace/:id/files/content", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);

    const requestedPath = String(body.path ?? "");
    const relativePath = normalizeWorkspaceRelativePath(requestedPath, { allowSubdirs: true });
    const lowered = relativePath.toLowerCase();
    const isMarkdown = lowered.endsWith(".md") || lowered.endsWith(".mdx") || lowered.endsWith(".markdown");
    if (!isMarkdown) {
      throw new ApiError(400, "invalid_path", "Only markdown files are supported");
    }

    if (typeof body.content !== "string") {
      throw new ApiError(400, "invalid_payload", "content must be a string");
    }
    const content = body.content;
    const bytes = Buffer.byteLength(content, "utf8");
    const maxBytes = 5_000_000;
    if (bytes > maxBytes) {
      throw new ApiError(413, "file_too_large", "File exceeds size limit", { maxBytes, size: bytes });
    }

    const baseUpdatedAtRaw = body.baseUpdatedAt;
    const baseUpdatedAt =
      typeof baseUpdatedAtRaw === "number" && Number.isFinite(baseUpdatedAtRaw) ? baseUpdatedAtRaw : null;
    const force = body.force === true;

    const absPath = resolveSafeChildPath(workspace.path, relativePath);

    const before = (await exists(absPath)) ? await stat(absPath) : null;
    if (before && !before.isFile()) {
      throw new ApiError(400, "invalid_path", "Path must point to a file");
    }
    const beforeUpdatedAt = before ? before.mtimeMs : null;
    if (!force && beforeUpdatedAt !== null && baseUpdatedAt !== null && beforeUpdatedAt !== baseUpdatedAt) {
      throw new ApiError(409, "conflict", "File changed since it was loaded", {
        baseUpdatedAt,
        currentUpdatedAt: beforeUpdatedAt,
      });
    }

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "workspace.file.write",
      summary: `Write ${relativePath}`,
      paths: [absPath],
    });

    await ensureDir(dirname(absPath));
    const tmp = `${absPath}.tmp-${shortId()}`;
    await writeFile(tmp, content, "utf8");
    await rename(tmp, absPath);
    const after = await stat(absPath);

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "workspace.file.write",
      target: absPath,
      summary: `Wrote ${relativePath}`,
      timestamp: Date.now(),
    });

    return jsonResponse({ ok: true, path: relativePath, bytes, updatedAt: after.mtimeMs });
  });

  addRoute(routes, "GET", "/workspace/:id/plugins", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const includeGlobal = ctx.url.searchParams.get("includeGlobal") === "true";
    const result = await listPlugins(workspace.path, includeGlobal);
    return jsonResponse(result);
  });

  addRoute(routes, "POST", "/workspace/:id/plugins", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const spec = String(body.spec ?? "");
    const normalized = normalizePluginSpec(spec);
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "plugins.add",
      summary: `Add plugin ${spec}`,
      paths: [opencodeConfigPath(workspace.path)],
    });
    const changed = await addPlugin(workspace.path, spec);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "plugins.add",
      target: "opencode.json",
      summary: `Added ${spec}`,
      timestamp: Date.now(),
    });
    if (changed) {
      emitReloadEvent(ctx.reloadEvents, workspace, "plugins", {
        type: "plugin",
        name: normalized,
        action: "added",
      });
    }
    const result = await listPlugins(workspace.path, false);
    return jsonResponse(result);
  });

  addRoute(routes, "DELETE", "/workspace/:id/plugins/:name", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = ctx.params.name ?? "";
    const normalized = normalizePluginSpec(name);
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "plugins.remove",
      summary: `Remove plugin ${name}`,
      paths: [opencodeConfigPath(workspace.path)],
    });
    const removed = await removePlugin(workspace.path, name);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "plugins.remove",
      target: "opencode.json",
      summary: `Removed ${name}`,
      timestamp: Date.now(),
    });
    if (removed) {
      emitReloadEvent(ctx.reloadEvents, workspace, "plugins", {
        type: "plugin",
        name: normalized,
        action: "removed",
      });
    }
    const result = await listPlugins(workspace.path, false);
    return jsonResponse(result);
  });

  addRoute(routes, "GET", "/hub/skills", "client", async () => {
    const items = await listHubSkills();
    return jsonResponse({ items });
  });

  addRoute(routes, "GET", "/workspace/:id/skills", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const includeGlobal = ctx.url.searchParams.get("includeGlobal") === "true";
    const items = await listSkills(workspace.path, includeGlobal);
    return jsonResponse({ items });
  });

  addRoute(routes, "POST", "/workspace/:id/skills/hub/:name", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = String(ctx.params.name ?? "").trim();
    if (!name) {
      throw new ApiError(400, "invalid_skill_name", "Skill name is required");
    }
    const body = await readJsonBody(ctx.request);
    const overwrite = body?.overwrite === true;
    const repoPayload = body?.repo && typeof body.repo === "object" ? (body.repo as Record<string, unknown>) : undefined;
    const repo = repoPayload
      ? {
          owner: typeof repoPayload.owner === "string" ? repoPayload.owner : undefined,
          repo: typeof repoPayload.repo === "string" ? repoPayload.repo : undefined,
          ref: typeof repoPayload.ref === "string" ? repoPayload.ref : undefined,
        }
      : undefined;

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "skills.install_hub",
      summary: `Install hub skill ${name}`,
      paths: [join(workspace.path, ".opencode", "skills", name)],
    });

    const result = await installHubSkill(workspace.path, { name, overwrite, repo });
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "skills.install_hub",
      target: result.path,
      summary: `Installed hub skill ${name}`,
      timestamp: Date.now(),
    });
    emitReloadEvent(ctx.reloadEvents, workspace, "skills", {
      type: "skill",
      name,
      action: result.action,
      path: result.path,
    });

    return jsonResponse({ ok: true, ...result });
  });

  addRoute(routes, "GET", "/workspace/:id/skills/:name", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const includeGlobal = ctx.url.searchParams.get("includeGlobal") === "true";
    const name = String(ctx.params.name ?? "").trim();
    if (!name) {
      throw new ApiError(400, "invalid_skill_name", "Skill name is required");
    }
    const items = await listSkills(workspace.path, includeGlobal);
    const item = items.find((skill) => skill.name === name);
    if (!item) {
      throw new ApiError(404, "skill_not_found", `Skill not found: ${name}`);
    }
    const content = await readFile(item.path, "utf8");
    return jsonResponse({ item, content });
  });

  addRoute(routes, "POST", "/workspace/:id/skills", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const name = String(body.name ?? "");
    const content = String(body.content ?? "");
    const description = body.description ? String(body.description) : undefined;
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "skills.upsert",
      summary: `Upsert skill ${name}`,
      paths: [join(workspace.path, ".opencode", "skills", name, "SKILL.md")],
    });
    const result = await upsertSkill(workspace.path, { name, content, description });
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "skills.upsert",
      target: result.path,
      summary: `Upserted skill ${name}`,
      timestamp: Date.now(),
    });
    emitReloadEvent(ctx.reloadEvents, workspace, "skills", {
      type: "skill",
      name,
      action: result.action,
      path: result.path,
    });
    return jsonResponse({ name, path: result.path, description: description ?? "", scope: "project" });
  });

  addRoute(routes, "DELETE", "/workspace/:id/skills/:name", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = String(ctx.params.name ?? "").trim();
    if (!name) {
      throw new ApiError(400, "invalid_skill_name", "Skill name is required");
    }
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "skills.delete",
      summary: `Delete skill ${name}`,
      paths: [join(workspace.path, ".opencode", "skills", name)],
    });
    const result = await deleteSkill(workspace.path, name);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "skills.delete",
      target: result.path,
      summary: `Deleted skill ${name}`,
      timestamp: Date.now(),
    });
    emitReloadEvent(ctx.reloadEvents, workspace, "skills", {
      type: "skill",
      name,
      action: "removed",
      path: result.path,
    });
    return jsonResponse({ ok: true, name, path: result.path });
  });

  addRoute(routes, "GET", "/workspace/:id/mcp", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const items = await listMcp(workspace.path);
    return jsonResponse({ items });
  });

  addRoute(routes, "POST", "/workspace/:id/mcp", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const name = String(body.name ?? "");
    const configPayload = body.config as Record<string, unknown> | undefined;
    if (!configPayload) {
      throw new ApiError(400, "invalid_payload", "MCP config is required");
    }
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "mcp.add",
      summary: `Add MCP ${name}`,
      paths: [opencodeConfigPath(workspace.path)],
    });
    const result = await addMcp(workspace.path, name, configPayload);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "mcp.add",
      target: "opencode.json",
      summary: `Added MCP ${name}`,
      timestamp: Date.now(),
    });
    emitReloadEvent(ctx.reloadEvents, workspace, "mcp", {
      type: "mcp",
      name,
      action: result.action,
    });
    const items = await listMcp(workspace.path);
    return jsonResponse({ items });
  });

  addRoute(routes, "DELETE", "/workspace/:id/mcp/:name", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = ctx.params.name ?? "";
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "mcp.remove",
      summary: `Remove MCP ${name}`,
      paths: [opencodeConfigPath(workspace.path)],
    });
    const removed = await removeMcp(workspace.path, name);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "mcp.remove",
      target: "opencode.json",
      summary: `Removed MCP ${name}`,
      timestamp: Date.now(),
    });
    if (removed) {
      emitReloadEvent(ctx.reloadEvents, workspace, "mcp", {
        type: "mcp",
        name,
        action: "removed",
      });
    }
    const items = await listMcp(workspace.path);
    return jsonResponse({ items });
  });

  addRoute(routes, "DELETE", "/workspace/:id/mcp/:name/auth", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = String(ctx.params.name ?? "").trim();
    validateMcpName(name);

    const authStorePath = join(homedir(), ".config", "opencode", "mcp-auth.json");
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "mcp.auth.remove",
      summary: `Logout MCP ${name}`,
      paths: [authStorePath],
    });

    // Best-effort disconnect so any active connection is torn down.
    try {
      await fetchOpencodeJson(workspace, `/mcp/${encodeURIComponent(name)}/disconnect`, { method: "POST" });
    } catch {
      // ignore
    }

    try {
      await fetchOpencodeJson(workspace, `/mcp/${encodeURIComponent(name)}/auth`, { method: "DELETE" });
    } catch (error) {
      // Treat missing credentials as a successful logout (idempotent).
      if (
        error instanceof ApiError &&
        error.code === "opencode_request_failed" &&
        error.details &&
        typeof error.details === "object" &&
        "status" in (error.details as Record<string, unknown>) &&
        (error.details as { status?: unknown }).status === 404
      ) {
        // ok
      } else {
        throw error;
      }
    }

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "mcp.auth.remove",
      target: authStorePath,
      summary: `Logged out MCP ${name}`,
      timestamp: Date.now(),
    });

    return jsonResponse({ ok: true });
  });

  addRoute(routes, "GET", "/workspace/:id/commands", "client", async (ctx) => {
    const scope = ctx.url.searchParams.get("scope") === "global" ? "global" : "workspace";
    if (scope === "global") {
      await requireHost(ctx.request, config, tokens);
    }
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const items = await listCommands(workspace.path, scope);
    return jsonResponse({ items });
  });

  addRoute(routes, "POST", "/workspace/:id/commands", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const name = String(body.name ?? "");
    const template = String(body.template ?? "");
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "commands.upsert",
      summary: `Upsert command ${name}`,
      paths: [join(workspace.path, ".opencode", "commands", `${sanitizeCommandName(name)}.md`)],
    });
    const path = await upsertCommand(workspace.path, {
      name,
      description: body.description ? String(body.description) : undefined,
      template,
      agent: body.agent ? String(body.agent) : undefined,
      model: body.model ? String(body.model) : undefined,
      subtask: typeof body.subtask === "boolean" ? body.subtask : undefined,
    });
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "commands.upsert",
      target: path,
      summary: `Upserted command ${name}`,
      timestamp: Date.now(),
    });

    emitReloadEvent(ctx.reloadEvents, workspace, "commands", {
      type: "command",
      name: sanitizeCommandName(name),
      action: "updated",
      path,
    });
    const items = await listCommands(workspace.path, "workspace");
    return jsonResponse({ items });
  });

  addRoute(routes, "DELETE", "/workspace/:id/commands/:name", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = ctx.params.name ?? "";
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "commands.delete",
      summary: `Delete command ${name}`,
      paths: [join(workspace.path, ".opencode", "commands", `${sanitizeCommandName(name)}.md`)],
    });
    await deleteCommand(workspace.path, name);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "commands.delete",
      target: join(workspace.path, ".opencode", "commands"),
      summary: `Deleted command ${name}`,
      timestamp: Date.now(),
    });

    emitReloadEvent(ctx.reloadEvents, workspace, "commands", {
      type: "command",
      name: sanitizeCommandName(name),
      action: "removed",
      path: join(workspace.path, ".opencode", "commands", `${sanitizeCommandName(name)}.md`),
    });
    return jsonResponse({ ok: true });
  });

  addRoute(routes, "GET", "/workspace/:id/agentlab/automations", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const store = await readAgentLabAutomations(workspace.path);
    return jsonResponse({ items: store.items, updatedAt: store.updatedAt });
  });

  addRoute(routes, "POST", "/workspace/:id/agentlab/automations", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);

    const name = typeof body.name === "string" ? body.name.trim() : "";
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const enabled = typeof body.enabled === "boolean" ? body.enabled : true;
    if (!name) {
      throw new ApiError(400, "invalid_payload", "name is required");
    }
    if (!prompt) {
      throw new ApiError(400, "invalid_payload", "prompt is required");
    }

    const schedule = parseAgentLabSchedule(body.schedule);
    const id = body.id ? validateAgentLabAutomationId(body.id) : `agentlab_${shortId().replace(/-/g, "")}`;

    const path = resolveAgentLabAutomationsPath(workspace.path);
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "agentlab.automations.upsert",
      summary: `Upsert automation ${name}`,
      paths: [path],
    });

    const store = await readAgentLabAutomations(workspace.path);
    const now = Date.now();
    const existingIndex = store.items.findIndex((item) => item.id === id);
    if (existingIndex !== -1) {
      const prev = store.items[existingIndex];
      store.items[existingIndex] = {
        ...prev,
        id,
        name,
        enabled,
        schedule,
        prompt,
        updatedAt: now,
      };
    } else {
      store.items.unshift({
        id,
        name,
        enabled,
        schedule,
        prompt,
        createdAt: now,
        updatedAt: now,
      });
    }
    await writeAgentLabAutomations(workspace.path, store);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "agentlab.automations.upsert",
      target: path,
      summary: `Upserted automation ${name}`,
      timestamp: now,
    });

    const next = await readAgentLabAutomations(workspace.path);
    return jsonResponse({ items: next.items, updatedAt: next.updatedAt }, 201);
  });

  addRoute(routes, "DELETE", "/workspace/:id/agentlab/automations/:automationId", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const automationId = validateAgentLabAutomationId(ctx.params.automationId);

    const path = resolveAgentLabAutomationsPath(workspace.path);
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "agentlab.automations.delete",
      summary: `Delete automation ${automationId}`,
      paths: [path],
    });

    const store = await readAgentLabAutomations(workspace.path);
    const before = store.items.length;
    store.items = store.items.filter((item) => item.id !== automationId);
    if (store.items.length === before) {
      throw new ApiError(404, "automation_not_found", "Automation not found");
    }
    await writeAgentLabAutomations(workspace.path, store);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "agentlab.automations.delete",
      target: path,
      summary: `Deleted automation ${automationId}`,
      timestamp: Date.now(),
    });
    return jsonResponse({ ok: true });
  });

  addRoute(routes, "POST", "/workspace/:id/agentlab/automations/:automationId/run", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const automationId = validateAgentLabAutomationId(ctx.params.automationId);

    const store = await readAgentLabAutomations(workspace.path);
    const automation = store.items.find((item) => item.id === automationId);
    if (!automation) {
      throw new ApiError(404, "automation_not_found", "Automation not found");
    }

    const now = Date.now();
    const created = await fetchOpencodeJson(workspace, "/session", {
      method: "POST",
      body: { title: `Automation: ${automation.name}` },
    });
    const sessionId = typeof created?.id === "string" ? created.id : String(created?.id ?? "");
    if (!sessionId.trim()) {
      throw new ApiError(502, "opencode_failed", "OpenCode session did not return an id");
    }

    await fetchOpencodeJson(workspace, `/session/${encodeURIComponent(sessionId)}/prompt_async`, {
      method: "POST",
      body: {
        parts: [{ type: "text", text: automation.prompt }],
      },
    });

    automation.lastRunAt = now;
    automation.lastRunSessionId = sessionId;
    automation.updatedAt = now;
    if (!config.readOnly) {
      await writeAgentLabAutomations(workspace.path, store);
    }

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "agentlab.automations.run",
      target: resolveAgentLabAutomationsPath(workspace.path),
      summary: `Ran automation ${automation.name}`,
      timestamp: now,
    });

    return jsonResponse({ ok: true, automationId, sessionId, ranAt: now });
  });

  addRoute(routes, "GET", "/workspace/:id/agentlab/automations/logs", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const logsDir = resolveAgentLabLogsDir(workspace.path);
    if (!(await exists(logsDir))) {
      return jsonResponse({ items: [] });
    }
    const entries = await readdir(logsDir, { withFileTypes: true });
    const items: Array<{ id: string; path: string; size: number; updatedAt: number }> = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".log")) continue;
      const id = entry.name.slice(0, -4);
      const abs = join(logsDir, entry.name);
      try {
        const info = await stat(abs);
        items.push({ id, path: entry.name, size: info.size, updatedAt: info.mtimeMs });
      } catch {
        // ignore
      }
    }
    items.sort((a, b) => b.updatedAt - a.updatedAt);
    return jsonResponse({ items });
  });

  addRoute(routes, "GET", "/workspace/:id/agentlab/automations/logs/:automationId", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const automationId = validateAgentLabAutomationId(ctx.params.automationId);
    const logsDir = resolveAgentLabLogsDir(workspace.path);
    const abs = join(logsDir, `${automationId}.log`);
    if (!(await exists(abs))) {
      throw new ApiError(404, "log_not_found", "Log not found");
    }
    const content = await readFile(abs, "utf8");
    return jsonResponse({ id: automationId, content });
  });

  addRoute(routes, "GET", "/workspace/:id/scheduler/jobs", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const items = await listScheduledJobs(workspace.path);
    return jsonResponse({ items });
  });

  addRoute(routes, "DELETE", "/workspace/:id/scheduler/jobs/:name", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = ctx.params.name ?? "";
    const { job, jobFile, systemPaths } = await resolveScheduledJob(name, workspace.path);
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "scheduler.delete",
      summary: `Delete scheduled job ${job.name}`,
      paths: [jobFile, ...systemPaths],
    });
    await deleteScheduledJob(job, jobFile);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "scheduler.delete",
      target: jobFile,
      summary: `Deleted scheduled job ${job.name}`,
      timestamp: Date.now(),
    });
    return jsonResponse({ job });
  });

  addRoute(routes, "GET", "/workspace/:id/soul/status", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const status = await getSoulStatus(workspace.path);
    return jsonResponse(status);
  });

  addRoute(routes, "GET", "/workspace/:id/soul/heartbeats", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const limitParam = ctx.url.searchParams.get("limit");
    const parsedLimit = limitParam ? Number(limitParam) : NaN;
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 200) : 20;
    const { items, total, path } = await listSoulHeartbeats(workspace.path, limit);
    return jsonResponse({ items, total, path });
  });

  addRoute(routes, "GET", "/workspace/:id/export", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const exportPayload = await exportWorkspace(workspace);
    return jsonResponse(exportPayload);
  });

  addRoute(routes, "POST", "/workspace/:id/import", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "config.import",
      summary: "Import workspace config",
      paths: [opencodeConfigPath(workspace.path), openworkConfigPath(workspace.path)],
    });
    await importWorkspace(workspace, body);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "config.import",
      target: "workspace",
      summary: "Imported workspace config",
      timestamp: Date.now(),
    });
    emitReloadEvent(ctx.reloadEvents, workspace, "config", buildConfigTrigger(opencodeConfigPath(workspace.path)));
    return jsonResponse({ ok: true });
  });

  addRoute(routes, "GET", "/approvals", "host", async (ctx) => {
    return jsonResponse({ items: ctx.approvals.list() });
  });

  addRoute(routes, "POST", "/approvals/:id", "host", async (ctx) => {
    const body = await readJsonBody(ctx.request);
    const reply = body.reply === "allow" ? "allow" : "deny";
    const result = ctx.approvals.respond(ctx.params.id, reply);
    if (!result) {
      throw new ApiError(404, "approval_not_found", "Approval request not found");
    }
    return jsonResponse({ ok: true, allowed: result.allowed });
  });

  return routes;
}

async function resolveWorkspace(config: ServerConfig, id: string): Promise<WorkspaceInfo> {
  const workspace = config.workspaces.find((entry) => entry.id === id);
  if (!workspace) {
    throw new ApiError(404, "workspace_not_found", "Workspace not found");
  }
  const resolvedWorkspace = resolve(workspace.path);
  const authorized = await isAuthorizedRoot(resolvedWorkspace, config.authorizedRoots);
  if (!authorized) {
    throw new ApiError(403, "workspace_unauthorized", "Workspace is not authorized");
  }
  return { ...workspace, path: resolvedWorkspace };
}

async function isAuthorizedRoot(workspacePath: string, roots: string[]): Promise<boolean> {
  const resolvedWorkspace = resolve(workspacePath);
  for (const root of roots) {
    const resolvedRoot = resolve(root);
    if (resolvedWorkspace === resolvedRoot) return true;
    if (resolvedWorkspace.startsWith(resolvedRoot + sep)) return true;
  }
  return false;
}

function ensureWritable(config: ServerConfig): void {
  if (config.readOnly) {
    throw new ApiError(403, "read_only", "Server is read-only");
  }
}

function scopeRank(scope: TokenScope): number {
  if (scope === "viewer") return 1;
  if (scope === "collaborator") return 2;
  return 3;
}

function requireClientScope(ctx: RequestContext, required: TokenScope): void {
  const scope = ctx.actor?.scope;
  if (!scope) {
    throw new ApiError(401, "unauthorized", "Missing token scope");
  }
  if (scopeRank(scope) < scopeRank(required)) {
    throw new ApiError(403, "forbidden", "Insufficient token scope", { required, scope });
  }
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const json = await request.json();
    return json as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "invalid_json", "Invalid JSON body");
  }
}

function parseInteger(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function expandHome(value: string): string {
  if (value.startsWith("~/")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

function resolveOpenCodeRouterConfigPath(): string {
  const override = process.env.OPENCODE_ROUTER_CONFIG_PATH?.trim();
  if (override) return expandHome(override);
  const dataDir = process.env.OPENCODE_ROUTER_DATA_DIR?.trim() || join(homedir(), ".openwork", "opencode-router");
  return join(expandHome(dataDir), "opencode-router.json");
}

function resolveOpenCodeRouterHealthPort(): number {
  return parseInteger(process.env.OPENCODE_ROUTER_HEALTH_PORT) ?? 3005;
}

function parseJsonResponse(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

function normalizeHealthPort(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const port = Math.trunc(value);
  if (port <= 0 || port > 65535) return null;
  return port;
}

type OpenCodeRouterConfigFile = Record<string, unknown> & {
  version?: number;
  channels?: Record<string, unknown> & {
    telegram?: Record<string, unknown>;
    slack?: Record<string, unknown>;
  };
};

type TelegramBotInfo = {
  id: number;
  username?: string;
  name?: string;
};

function ensurePlainObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

type OpenworkServerConfigFile = Record<string, unknown> & {
  workspaces?: Array<Record<string, unknown>>;
  authorizedRoots?: string[];
};

async function persistWorkspaceDeletion(configPath: string, workspaceId: string, workspacePath: string): Promise<boolean> {
  if (!configPath.trim()) return false;
  if (!(await exists(configPath))) {
    // If the server was started from CLI args/env, avoid implicitly creating server.json
    // because it can change token behavior on restart.
    return false;
  }

  let raw = "";
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    throw new ApiError(500, "server_config_read_failed", "Failed to read server config", {
      path: configPath,
      error: String(error),
    });
  }

  let parsed: OpenworkServerConfigFile;
  try {
    parsed = ensurePlainObject(JSON.parse(raw)) as OpenworkServerConfigFile;
  } catch (error) {
    throw new ApiError(422, "invalid_json", "Failed to parse server config", {
      path: configPath,
      error: String(error),
    });
  }

  const configDir = dirname(configPath);
  const workspacesRaw = parsed.workspaces;
  const workspaces = Array.isArray(workspacesRaw) ? workspacesRaw : [];

  const nextWorkspaces = workspaces.filter((entry) => {
    const obj = ensurePlainObject(entry);
    const path = typeof obj.path === "string" ? obj.path.trim() : "";
    if (!path) return true;
    const id = workspaceIdForPath(resolve(configDir, path));
    return id !== workspaceId;
  });

  const rootsRaw = parsed.authorizedRoots;
  const roots = Array.isArray(rootsRaw) ? rootsRaw : [];
  const nextRoots = roots.filter((root) => {
    const value = typeof root === "string" ? root.trim() : "";
    if (!value) return false;
    return resolve(configDir, value) !== resolve(workspacePath);
  });

  const workspacesChanged = nextWorkspaces.length !== workspaces.length;
  const rootsChanged = nextRoots.length !== roots.length;
  if (!workspacesChanged && !rootsChanged) return false;

  const next: OpenworkServerConfigFile = {
    ...parsed,
    ...(workspacesChanged ? { workspaces: nextWorkspaces } : {}),
    ...(rootsChanged ? { authorizedRoots: nextRoots } : {}),
  };

  await ensureDir(dirname(configPath));
  const tmpPath = `${configPath}.tmp.${shortId()}`;
  try {
    await writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(tmpPath, configPath);
    return true;
  } finally {
    try {
      await rm(tmpPath);
    } catch {
      // ignore
    }
  }
}

function normalizeOpenCodeRouterIdentityId(value: unknown): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return "default";
  const safe = trimmed.replace(/[^a-zA-Z0-9_.-]+/g, "-");
  const cleaned = safe.replace(/^-+|-+$/g, "").slice(0, 48);
  return cleaned || "default";
}

type TelegramAccessMode = "public" | "private";

const TELEGRAM_PAIRING_CODE_HASH_PATTERN = /^[a-f0-9]{64}$/;
const TELEGRAM_PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function normalizeTelegramAccessMode(value: unknown, fallback: TelegramAccessMode = "public"): TelegramAccessMode {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "private") return "private";
  if (raw === "public") return "public";
  return fallback;
}

function normalizeTelegramPairingCode(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeTelegramPairingCodeHash(value: unknown): string {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!TELEGRAM_PAIRING_CODE_HASH_PATTERN.test(raw)) return "";
  return raw;
}

function hashTelegramPairingCode(value: string): string {
  return createHash("sha256").update(normalizeTelegramPairingCode(value)).digest("hex");
}

function generateTelegramPairingCode(): string {
  let code = "";
  for (let index = 0; index < 8; index += 1) {
    code += TELEGRAM_PAIRING_CODE_ALPHABET[randomInt(0, TELEGRAM_PAIRING_CODE_ALPHABET.length)] ?? "";
  }
  if (code.length !== 8) {
    throw new ApiError(500, "pairing_code_generation_failed", "Failed to generate Telegram pairing code");
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function resolveTelegramAccessFromRecord(record: Record<string, unknown>): {
  access: TelegramAccessMode;
  pairingCodeHash: string;
} {
  const pairingCodeHash = normalizeTelegramPairingCodeHash(record.pairingCodeHash);
  const access = normalizeTelegramAccessMode(record.access, pairingCodeHash ? "private" : "public");
  return {
    access,
    pairingCodeHash: access === "private" ? pairingCodeHash : "",
  };
}

async function readOpenCodeRouterConfigFile(configPath: string): Promise<OpenCodeRouterConfigFile> {
  if (!(await exists(configPath))) {
    return { version: 1 };
  }

  let raw = "";
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    throw new ApiError(500, "opencodeRouter_config_read_failed", "Failed to read opencode-router.json", {
      path: configPath,
      error: String(error),
    });
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return ensurePlainObject(parsed) as OpenCodeRouterConfigFile;
  } catch (error) {
    throw new ApiError(422, "invalid_json", "Failed to parse opencode-router.json", {
      path: configPath,
      error: String(error),
    });
  }
}

async function writeOpenCodeRouterConfigFile(configPath: string, config: OpenCodeRouterConfigFile): Promise<void> {
  await ensureDir(dirname(configPath));
  const next: OpenCodeRouterConfigFile = {
    ...config,
    version: typeof config.version === "number" && Number.isFinite(config.version) ? config.version : 1,
  };
  const tmpPath = `${configPath}.tmp.${shortId()}`;
  try {
    await writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(tmpPath, configPath);
  } finally {
    // Best-effort cleanup if rename failed.
    try {
      await rm(tmpPath);
    } catch {
      // ignore
    }
  }
}

async function persistOpenCodeRouterTelegramToken(token: string): Promise<void> {
  const configPath = resolveOpenCodeRouterConfigPath();
  const current = await readOpenCodeRouterConfigFile(configPath);
  const channels = ensurePlainObject(current.channels);
  const telegram = ensurePlainObject(channels.telegram);

  const botsRaw = (telegram as any).bots;
  const bots = Array.isArray(botsRaw) ? (botsRaw as unknown[]) : [];
  const nextBots: Array<Record<string, unknown>> = [];
  let found = false;
  for (const entry of bots) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (id !== "default") {
      nextBots.push(record);
      continue;
    }
    found = true;
    nextBots.push({ id: "default", token, enabled: true });
  }
  if (!found) nextBots.push({ id: "default", token, enabled: true });

  const next: OpenCodeRouterConfigFile = {
    ...current,
    channels: {
      ...channels,
      telegram: {
        ...telegram,
        // New format (multi-identity)
        bots: nextBots,
        // Legacy (single-identity)
        token,
        enabled: true,
      },
    },
  };
  await writeOpenCodeRouterConfigFile(configPath, next);
}

async function persistOpenCodeRouterTelegramIdentity(identity: {
  id: string;
  token: string;
  enabled: boolean;
  directory?: string;
  access?: TelegramAccessMode;
  pairingCodeHash?: string;
}): Promise<void> {
  const configPath = resolveOpenCodeRouterConfigPath();
  const current = await readOpenCodeRouterConfigFile(configPath);
  const channels = ensurePlainObject(current.channels);
  const telegram = ensurePlainObject(channels.telegram);

  const id = normalizeOpenCodeRouterIdentityId(identity.id);
  const token = identity.token.trim();
  const directory = typeof identity.directory === "string" ? identity.directory.trim() : "";
  const requestedAccess = identity.access ? normalizeTelegramAccessMode(identity.access, "public") : undefined;
  const requestedPairingCodeHash = normalizeTelegramPairingCodeHash(identity.pairingCodeHash);
  if (!token) {
    throw new ApiError(400, "token_required", "Telegram token is required");
  }

  const botsRaw = (telegram as any).bots;
  const bots = Array.isArray(botsRaw) ? (botsRaw as unknown[]) : [];
  const nextBots: Array<Record<string, unknown>> = [];
  let found = false;
  for (const entry of bots) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const entryId = normalizeOpenCodeRouterIdentityId(record.id);
    if (entryId !== id) {
      nextBots.push(record);
      continue;
    }
    found = true;
    const prevDir = typeof record.directory === "string" ? record.directory.trim() : "";
    const nextDir = directory || prevDir;
    const existingAccessState = resolveTelegramAccessFromRecord(record);
    const access = requestedAccess ?? existingAccessState.access;
    const pairingCodeHash = access === "private"
      ? (requestedPairingCodeHash || existingAccessState.pairingCodeHash)
      : "";
    if (access === "private" && !pairingCodeHash) {
      throw new ApiError(400, "pairing_code_required", "Telegram private access requires a pairing code hash");
    }
    nextBots.push({
      id,
      token,
      enabled: identity.enabled,
      ...(nextDir ? { directory: nextDir } : {}),
      access,
      ...(access === "private" ? { pairingCodeHash } : {}),
    });
  }
  if (!found) {
    const access = requestedAccess ?? "public";
    const pairingCodeHash = access === "private" ? requestedPairingCodeHash : "";
    if (access === "private" && !pairingCodeHash) {
      throw new ApiError(400, "pairing_code_required", "Telegram private access requires a pairing code hash");
    }
    nextBots.push({
      id,
      token,
      enabled: identity.enabled,
      ...(directory ? { directory } : {}),
      access,
      ...(access === "private" ? { pairingCodeHash } : {}),
    });
  }

  const nextTelegram: Record<string, unknown> = {
    ...telegram,
    enabled: true,
    bots: nextBots,
  };
  if (id === "default") {
    // Legacy fallback.
    nextTelegram.token = token;
  }

  const next: OpenCodeRouterConfigFile = {
    ...current,
    channels: {
      ...channels,
      telegram: nextTelegram,
    },
  };
  await writeOpenCodeRouterConfigFile(configPath, next);
}

async function deleteOpenCodeRouterTelegramIdentity(idRaw: string): Promise<boolean> {
  const id = normalizeOpenCodeRouterIdentityId(idRaw);
  const configPath = resolveOpenCodeRouterConfigPath();
  const current = await readOpenCodeRouterConfigFile(configPath);
  const channels = ensurePlainObject(current.channels);
  const telegram = ensurePlainObject(channels.telegram);

  const botsRaw = (telegram as any).bots;
  const bots = Array.isArray(botsRaw) ? (botsRaw as unknown[]) : [];
  const nextBots: Array<Record<string, unknown>> = [];
  let deleted = false;
  for (const entry of bots) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const entryId = normalizeOpenCodeRouterIdentityId(record.id);
    if (entryId === id) {
      deleted = true;
      continue;
    }
    nextBots.push(record);
  }

  const nextTelegram: Record<string, unknown> = {
    ...telegram,
    bots: nextBots,
  };
  if (id === "default") {
    delete (nextTelegram as any).token;
  }

  const next: OpenCodeRouterConfigFile = {
    ...current,
    channels: {
      ...channels,
      telegram: nextTelegram,
    },
  };
  await writeOpenCodeRouterConfigFile(configPath, next);
  return deleted;
}

async function persistOpenCodeRouterTelegramEnabled(enabled: boolean, options?: { clearToken?: boolean }) {
  const configPath = resolveOpenCodeRouterConfigPath();
  const current = await readOpenCodeRouterConfigFile(configPath);
  const channels = ensurePlainObject(current.channels);
  const telegram = ensurePlainObject(channels.telegram);

  const botsRaw = (telegram as any).bots;
  const bots = Array.isArray(botsRaw) ? (botsRaw as unknown[]) : [];
  const nextBots: Array<Record<string, unknown>> = [];
  for (const entry of bots) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id) {
      nextBots.push(record);
      continue;
    }
    // Leave per-bot enabled as-is; global channel enabled gates all identities.
    if (!enabled && options?.clearToken && id === "default") {
      const nextRecord = { ...record };
      delete (nextRecord as any).token;
      nextBots.push(nextRecord);
      continue;
    }
    nextBots.push(record);
  }

  const nextTelegram: Record<string, unknown> = {
    ...telegram,
    enabled,
    ...(bots.length ? { bots: nextBots } : {}),
  };
  if (!enabled && options?.clearToken) {
    delete nextTelegram.token;
  }

  const next: OpenCodeRouterConfigFile = {
    ...current,
    channels: {
      ...channels,
      telegram: nextTelegram,
    },
  };
  await writeOpenCodeRouterConfigFile(configPath, next);
}

async function fetchTelegramBotInfo(token: string): Promise<TelegramBotInfo | null> {
  const trimmed = token.trim();
  if (!trimmed) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetch(`https://api.telegram.org/bot${trimmed}/getMe`, {
      method: "GET",
      signal: controller.signal,
    });
    const json = (await response.json().catch(() => null)) as any;
    if (!response.ok || !json?.ok || !json?.result) return null;
    const result = json.result as Record<string, unknown>;
    const id = typeof result.id === "number" ? result.id : null;
    if (id == null) return null;
    const username = typeof result.username === "string" ? result.username : undefined;
    const name = typeof result.first_name === "string" ? result.first_name : undefined;
    return { id, username, name };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function readOpenCodeRouterTelegramInfo(): Promise<{
  configured: boolean;
  enabled: boolean;
  bot: TelegramBotInfo | null;
}> {
  const configPath = resolveOpenCodeRouterConfigPath();
  const current = await readOpenCodeRouterConfigFile(configPath);
  const channels = ensurePlainObject(current.channels);
  const telegram = ensurePlainObject(channels.telegram);

  const channelEnabled = telegram.enabled === undefined ? true : telegram.enabled === true || telegram.enabled === "true";

  const botsRaw = (telegram as any).bots;
  const bots = Array.isArray(botsRaw) ? (botsRaw as unknown[]) : [];
  let token = "";
  let identityEnabled = true;
  for (const entry of bots) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (id !== "default") continue;
    token = typeof record.token === "string" ? record.token.trim() : "";
    identityEnabled = record.enabled === undefined ? true : record.enabled === true || record.enabled === "true";
    break;
  }
  if (!token) {
    // Legacy fallback.
    token = typeof telegram.token === "string" ? telegram.token.trim() : "";
  }

  const configured = Boolean(token);
  const bot = configured ? await fetchTelegramBotInfo(token) : null;
  const enabled = configured ? channelEnabled && identityEnabled : false;
  return { configured, enabled, bot };
}

async function persistOpenCodeRouterSlackTokens(botToken: string, appToken: string): Promise<void> {
  const configPath = resolveOpenCodeRouterConfigPath();
  const current = await readOpenCodeRouterConfigFile(configPath);
  const channels = ensurePlainObject(current.channels);
  const slack = ensurePlainObject(channels.slack);

  const appsRaw = (slack as any).apps;
  const apps = Array.isArray(appsRaw) ? (appsRaw as unknown[]) : [];
  const nextApps: Array<Record<string, unknown>> = [];
  let found = false;
  for (const entry of apps) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (id !== "default") {
      nextApps.push(record);
      continue;
    }
    found = true;
    nextApps.push({ id: "default", botToken, appToken, enabled: true });
  }
  if (!found) nextApps.push({ id: "default", botToken, appToken, enabled: true });

  const next: OpenCodeRouterConfigFile = {
    ...current,
    channels: {
      ...channels,
      slack: {
        ...slack,
        // New format (multi-identity)
        apps: nextApps,
        // Legacy (single-identity)
        botToken,
        appToken,
        enabled: true,
      },
    },
  };
  await writeOpenCodeRouterConfigFile(configPath, next);
}

async function persistOpenCodeRouterSlackIdentity(identity: {
  id: string;
  botToken: string;
  appToken: string;
  enabled: boolean;
  directory?: string;
}): Promise<void> {
  const configPath = resolveOpenCodeRouterConfigPath();
  const current = await readOpenCodeRouterConfigFile(configPath);
  const channels = ensurePlainObject(current.channels);
  const slack = ensurePlainObject(channels.slack);

  const id = normalizeOpenCodeRouterIdentityId(identity.id);
  const botToken = identity.botToken.trim();
  const appToken = identity.appToken.trim();
  const directory = typeof identity.directory === "string" ? identity.directory.trim() : "";
  if (!botToken || !appToken) {
    throw new ApiError(400, "token_required", "Slack botToken and appToken are required");
  }

  const appsRaw = (slack as any).apps;
  const apps = Array.isArray(appsRaw) ? (appsRaw as unknown[]) : [];
  const nextApps: Array<Record<string, unknown>> = [];
  let found = false;
  for (const entry of apps) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const entryId = normalizeOpenCodeRouterIdentityId(record.id);
    if (entryId !== id) {
      nextApps.push(record);
      continue;
    }
    found = true;
    const prevDir = typeof record.directory === "string" ? record.directory.trim() : "";
    const nextDir = directory || prevDir;
    nextApps.push({ id, botToken, appToken, enabled: identity.enabled, ...(nextDir ? { directory: nextDir } : {}) });
  }
  if (!found) {
    nextApps.push({ id, botToken, appToken, enabled: identity.enabled, ...(directory ? { directory } : {}) });
  }

  const nextSlack: Record<string, unknown> = {
    ...slack,
    enabled: true,
    apps: nextApps,
  };
  if (id === "default") {
    // Legacy fallback.
    nextSlack.botToken = botToken;
    nextSlack.appToken = appToken;
  }

  const next: OpenCodeRouterConfigFile = {
    ...current,
    channels: {
      ...channels,
      slack: nextSlack,
    },
  };
  await writeOpenCodeRouterConfigFile(configPath, next);
}

async function deleteOpenCodeRouterSlackIdentity(idRaw: string): Promise<boolean> {
  const id = normalizeOpenCodeRouterIdentityId(idRaw);
  const configPath = resolveOpenCodeRouterConfigPath();
  const current = await readOpenCodeRouterConfigFile(configPath);
  const channels = ensurePlainObject(current.channels);
  const slack = ensurePlainObject(channels.slack);

  const appsRaw = (slack as any).apps;
  const apps = Array.isArray(appsRaw) ? (appsRaw as unknown[]) : [];
  const nextApps: Array<Record<string, unknown>> = [];
  let deleted = false;
  for (const entry of apps) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const entryId = normalizeOpenCodeRouterIdentityId(record.id);
    if (entryId === id) {
      deleted = true;
      continue;
    }
    nextApps.push(record);
  }

  const nextSlack: Record<string, unknown> = {
    ...slack,
    apps: nextApps,
  };
  if (id === "default") {
    delete (nextSlack as any).botToken;
    delete (nextSlack as any).appToken;
  }

  const next: OpenCodeRouterConfigFile = {
    ...current,
    channels: {
      ...channels,
      slack: nextSlack,
    },
  };
  await writeOpenCodeRouterConfigFile(configPath, next);
  return deleted;
}

type OpenCodeRouterApplyAttempt = {
  applied: boolean;
  port: number;
  hosts: string[];
  host?: string;
  status?: number;
  error?: string;
  body?: unknown;
};

async function tryPostOpenCodeRouterHealth(
  pathname: string,
  payload: unknown,
  options: { port: number; requestHost?: string | null; timeoutMs: number },
): Promise<OpenCodeRouterApplyAttempt> {
  const candidates = Array.from(
    new Set(
      ["127.0.0.1", options.requestHost].filter(
        (host): host is string => Boolean(host && host.trim()),
      ),
    ),
  );
  const port = options.port;

  let lastError: OpenCodeRouterApplyAttempt | null = null;
  for (const host of candidates) {
    const url = `http://${host}:${port}${pathname}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timer);

      const text = await response.text();
      const parsed = parseJsonResponse(text);

      if (response.ok) {
        return {
          applied: true,
          port,
          hosts: candidates,
          host,
          status: response.status,
          body: parsed,
        };
      }

      const detail =
        typeof parsed === "object" && parsed && "error" in parsed
          ? String((parsed as Record<string, unknown>).error)
          : response.statusText || "OpenCodeRouter request failed";
      lastError = {
        applied: false,
        port,
        hosts: candidates,
        host,
        status: response.status,
        error: detail,
        body: parsed,
      };
    } catch (error) {
      clearTimeout(timer);
      const message =
        error instanceof Error && error.name === "AbortError"
          ? `Timeout after ${options.timeoutMs}ms`
          : String(error);
      lastError = {
        applied: false,
        port,
        hosts: candidates,
        host,
        error: message,
      };
    }
  }

  return (
    lastError ?? {
      applied: false,
      port,
      hosts: candidates,
      error: "OpenCodeRouter health server is unavailable",
    }
  );
}

async function tryFetchOpenCodeRouterHealth(
  method: "GET" | "DELETE",
  pathname: string,
  options: { port: number; requestHost?: string | null; timeoutMs: number },
): Promise<OpenCodeRouterApplyAttempt> {
  const candidates = Array.from(
    new Set(
      ["127.0.0.1", options.requestHost].filter(
        (host): host is string => Boolean(host && host.trim()),
      ),
    ),
  );
  const port = options.port;

  let lastError: OpenCodeRouterApplyAttempt | null = null;
  for (const host of candidates) {
    const url = `http://${host}:${port}${pathname}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
      });
      clearTimeout(timer);

      const text = await response.text();
      const parsed = parseJsonResponse(text);

      if (response.ok) {
        return {
          applied: true,
          port,
          hosts: candidates,
          host,
          status: response.status,
          body: parsed,
        };
      }

      const detail =
        typeof parsed === "object" && parsed && "error" in parsed
          ? String((parsed as Record<string, unknown>).error)
          : response.statusText || "OpenCodeRouter request failed";
      lastError = {
        applied: false,
        port,
        hosts: candidates,
        host,
        status: response.status,
        error: detail,
        body: parsed,
      };
    } catch (error) {
      clearTimeout(timer);
      const message =
        error instanceof Error && error.name === "AbortError"
          ? `Timeout after ${options.timeoutMs}ms`
          : String(error);
      lastError = {
        applied: false,
        port,
        hosts: candidates,
        host,
        error: message,
      };
    }
  }

  return (
    lastError ?? {
      applied: false,
      port,
      hosts: candidates,
      error: "OpenCodeRouter health server is unavailable",
    }
  );
}

async function updateOpenCodeRouterTelegramToken(
  token: string,
  healthPortOverride?: number | null,
  requestHost?: string | null,
): Promise<Record<string, unknown>> {
  // Always persist first so the token is saved even if opencodeRouter is offline.
  await persistOpenCodeRouterTelegramToken(token);

  const port = healthPortOverride ?? resolveOpenCodeRouterHealthPort();
  const apply = await tryPostOpenCodeRouterHealth(
    "/config/telegram-token",
    { token },
    { port, requestHost, timeoutMs: 3_000 },
  );

  const response: Record<string, unknown> = {
    ok: true,
    persisted: true,
    applied: apply.applied,
    telegram: { configured: true, enabled: true },
  };

  const bot = await fetchTelegramBotInfo(token);
  if (bot) {
    (response.telegram as Record<string, unknown>).bot = bot;
  }

  // Prefer opencodeRouter's response payload when available.
  if (apply.body && typeof apply.body === "object") {
    const record = apply.body as Record<string, unknown>;
    if (record.telegram && typeof record.telegram === "object") {
      response.telegram = record.telegram;
    }
  }

  // If opencodeRouter reports apply status, reflect it at the top-level.
  let telegramStarting = false;
  if (response.telegram && typeof response.telegram === "object") {
    const telegram = response.telegram as Record<string, unknown>;
    if (typeof telegram.applied === "boolean") {
      response.applied = telegram.applied;
    }
    if (typeof telegram.starting === "boolean") {
      telegramStarting = telegram.starting;
    }
    if (!response.applyError && typeof telegram.error === "string" && telegram.error.trim()) {
      response.applyError = telegram.error;
    }
  }

  if (!apply.applied) {
    response.applyError = (typeof response.applyError === "string" && response.applyError.trim())
      ? response.applyError
      : apply.error ?? "OpenCodeRouter did not apply the update";
    if (typeof apply.status === "number") response.applyStatus = apply.status;
  } else if (response.applied === false && !telegramStarting && !response.applyError) {
    response.applyError = "OpenCodeRouter did not apply the update";
  }

  return response;
}

async function updateOpenCodeRouterSlackTokens(
  botToken: string,
  appToken: string,
  healthPortOverride?: number | null,
  requestHost?: string | null,
): Promise<Record<string, unknown>> {
  await persistOpenCodeRouterSlackTokens(botToken, appToken);

  const port = healthPortOverride ?? resolveOpenCodeRouterHealthPort();
  const apply = await tryPostOpenCodeRouterHealth(
    "/config/slack-tokens",
    { botToken, appToken },
    { port, requestHost, timeoutMs: 3_000 },
  );

  const response: Record<string, unknown> = {
    ok: true,
    persisted: true,
    applied: apply.applied,
    slack: { configured: true, enabled: true },
  };

  if (apply.body && typeof apply.body === "object") {
    const record = apply.body as Record<string, unknown>;
    if (record.slack && typeof record.slack === "object") {
      response.slack = record.slack;
    }
  }

  let slackStarting = false;
  if (response.slack && typeof response.slack === "object") {
    const slack = response.slack as Record<string, unknown>;
    if (typeof slack.applied === "boolean") {
      response.applied = slack.applied;
    }
    if (typeof slack.starting === "boolean") {
      slackStarting = slack.starting;
    }
    if (!response.applyError && typeof slack.error === "string" && slack.error.trim()) {
      response.applyError = slack.error;
    }
  }

  if (!apply.applied) {
    response.applyError = (typeof response.applyError === "string" && response.applyError.trim())
      ? response.applyError
      : apply.error ?? "OpenCodeRouter did not apply the update";
    if (typeof apply.status === "number") response.applyStatus = apply.status;
  } else if (response.applied === false && !slackStarting && !response.applyError) {
    response.applyError = "OpenCodeRouter did not apply the update";
  }

  return response;
}

function resolveSoulMemoryPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".opencode", "soul.md");
}

function resolveSoulHeartbeatPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".opencode", "soul", "heartbeat.jsonl");
}

function normalizeSoulTimestamp(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : trimmed;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return null;
}

function toSoulStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter(Boolean);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  return [];
}

function parseSoulHeartbeatLine(rawLine: string, lineIndex: number): SoulHeartbeatEntry | null {
  const trimmed = rawLine.trim();
  if (!trimmed) return null;
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(trimmed);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    parsed = value as Record<string, unknown>;
  } catch {
    return null;
  }

  const ts = normalizeSoulTimestamp(parsed.ts);
  const workspace = typeof parsed.workspace === "string" && parsed.workspace.trim()
    ? parsed.workspace.trim()
    : null;
  const looseEnds = toSoulStringArray(parsed.loose_ends ?? parsed.looseEnds);
  const nextActionRaw = parsed.next_action ?? parsed.nextAction;
  const nextAction = typeof nextActionRaw === "string" && nextActionRaw.trim() ? nextActionRaw.trim() : null;
  const summaryRaw = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  const summary =
    summaryRaw ||
    nextAction ||
    (looseEnds.length ? `Loose ends: ${looseEnds.slice(0, 2).join("; ")}` : "(no summary)");

  return {
    id: `${ts ?? "unknown"}-${lineIndex}`,
    ts,
    workspace,
    summary,
    looseEnds,
    nextAction,
  };
}

function parseSoulHeartbeatEntries(content: string): SoulHeartbeatEntry[] {
  const lines = content.split(/\r?\n/);
  const items: SoulHeartbeatEntry[] = [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const item = parseSoulHeartbeatLine(lines[i] ?? "", i + 1);
    if (item) items.push(item);
  }
  return items;
}

function configIncludesSoulInstruction(config: Record<string, unknown>): boolean {
  const target = ".opencode/soul.md";
  const instructions = config.instructions;
  if (typeof instructions === "string") {
    return instructions.includes(target);
  }
  if (Array.isArray(instructions)) {
    return instructions.some((entry) => typeof entry === "string" && entry.includes(target));
  }
  return false;
}

function estimateCronIntervalMs(schedule: string): number | null {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length < 5) return null;
  const [minute, hour, dom, mon, dow] = parts;
  if (!minute || !hour || !dom || !mon || !dow) return null;

  if (minute === "*" && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    return 60_000;
  }

  const minuteEvery = /^\*\/(\d+)$/.exec(minute);
  if (minuteEvery && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    const interval = Number(minuteEvery[1]);
    if (Number.isFinite(interval) && interval > 0) {
      return interval * 60_000;
    }
  }

  const hourEvery = /^\*\/(\d+)$/.exec(hour);
  if (hourEvery && /^\d+$/.test(minute) && dom === "*" && mon === "*" && dow === "*") {
    const interval = Number(hourEvery[1]);
    if (Number.isFinite(interval) && interval > 0) {
      return interval * 60 * 60_000;
    }
  }

  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && dom === "*" && mon === "*" && dow === "*") {
    return 24 * 60 * 60_000;
  }

  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && dom === "*" && mon === "*" && dow !== "*") {
    return 24 * 60 * 60_000;
  }

  return null;
}

async function listSoulHeartbeats(
  workspaceRoot: string,
  limit: number,
): Promise<{ items: SoulHeartbeatEntry[]; total: number; path: string }> {
  const heartbeatPath = resolveSoulHeartbeatPath(workspaceRoot);
  const relativePath = ".opencode/soul/heartbeat.jsonl";
  if (!(await exists(heartbeatPath))) {
    return { items: [], total: 0, path: relativePath };
  }

  const content = await readFile(heartbeatPath, "utf8");
  const all = parseSoulHeartbeatEntries(content);
  return { items: all.slice(0, Math.max(1, limit)), total: all.length, path: relativePath };
}

async function getSoulStatus(workspaceRoot: string): Promise<SoulStatus> {
  const [opencodeConfig, memoryEnabled, heartbeatLogExists] = await Promise.all([
    readOpencodeConfig(workspaceRoot),
    exists(resolveSoulMemoryPath(workspaceRoot)),
    exists(resolveSoulHeartbeatPath(workspaceRoot)),
  ]);

  let heartbeatCommandExists = false;
  try {
    const commands = await listCommands(workspaceRoot, "workspace");
    heartbeatCommandExists = commands.some((command) => command.name === "soul-heartbeat");
  } catch {
    heartbeatCommandExists = false;
  }

  let heartbeatJob: {
    name: string;
    slug: string;
    schedule: string;
    lastRunAt: string | null;
    lastRunStatus: string | null;
    lastRunError: string | null;
  } | null = null;

  try {
    const jobs = await listScheduledJobs(workspaceRoot);
    const found = jobs.find((job) => {
      if (job.name === "soul-heartbeat") return true;
      if (job.slug === "soul-heartbeat") return true;
      return job.slug.includes("soul-heartbeat");
    });
    if (found) {
      heartbeatJob = {
        name: found.name,
        slug: found.slug,
        schedule: found.schedule,
        lastRunAt: found.lastRunAt ?? null,
        lastRunStatus: found.lastRunStatus ?? null,
        lastRunError: found.lastRunError ?? null,
      };
    }
  } catch {
    heartbeatJob = null;
  }

  const instructionsEnabled = configIncludesSoulInstruction(opencodeConfig);
  const heartbeats = await listSoulHeartbeats(workspaceRoot, 500);
  const lastHeartbeat = heartbeats.items[0] ?? null;
  const lastHeartbeatAt = lastHeartbeat?.ts ?? null;
  const lastHeartbeatSummary = lastHeartbeat?.summary ?? null;

  const enabled =
    memoryEnabled ||
    instructionsEnabled ||
    heartbeatLogExists ||
    heartbeatCommandExists ||
    Boolean(heartbeatJob);

  const estimatedIntervalMs = heartbeatJob ? estimateCronIntervalMs(heartbeatJob.schedule) : null;
  const staleAfterMs = enabled
    ? Math.max(estimatedIntervalMs ? estimatedIntervalMs * 2 : 24 * 60 * 60_000, 30 * 60_000)
    : null;

  const parsedLastHeartbeat = lastHeartbeatAt ? Date.parse(lastHeartbeatAt) : NaN;
  const hasLastHeartbeat = Number.isFinite(parsedLastHeartbeat);
  const overdue = Boolean(
    enabled &&
    staleAfterMs != null &&
    (heartbeatJob || lastHeartbeatAt) &&
    (!hasLastHeartbeat || Date.now() - parsedLastHeartbeat > staleAfterMs),
  );

  let state: SoulStatus["state"] = "off";
  if (!enabled) {
    state = "off";
  } else if ((heartbeatJob?.lastRunStatus ?? "") === "failed" || Boolean(heartbeatJob?.lastRunError?.trim())) {
    state = "error";
  } else if (overdue) {
    state = "stale";
  } else {
    state = "healthy";
  }

  const summary = !enabled
    ? "Soul mode is not enabled for this worker yet."
    : state === "error"
      ? "Soul heartbeat ran into an error."
      : state === "stale"
        ? "Soul heartbeat is overdue."
        : heartbeatJob
          ? "Soul mode is active and heartbeat is on schedule."
          : "Soul mode is active. Heartbeat schedule not found.";

  return {
    enabled,
    state,
    memoryEnabled,
    instructionsEnabled,
    heartbeatLogExists,
    heartbeatCommandExists,
    heartbeatJob,
    heartbeatCount: heartbeats.total,
    lastHeartbeatAt,
    lastHeartbeatSummary,
    staleAfterMs,
    overdue,
    summary,
    memoryPath: ".opencode/soul.md",
    heartbeatPath: ".opencode/soul/heartbeat.jsonl",
  };
}

async function readOpencodeConfig(workspaceRoot: string): Promise<Record<string, unknown>> {
  const { data } = await readJsoncFile(opencodeConfigPath(workspaceRoot), {} as Record<string, unknown>);
  return data;
}

async function readOpenworkConfig(workspaceRoot: string): Promise<Record<string, unknown>> {
  const path = openworkConfigPath(workspaceRoot);
  if (!(await exists(path))) return {};
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new ApiError(422, "invalid_json", "Failed to parse openwork.json");
  }
}

function resolveOpencodeDirectory(workspace: WorkspaceInfo): string | null {
  const explicit = workspace.directory?.trim() ?? "";
  if (explicit) return explicit;
  if (workspace.workspaceType === "local") return workspace.path;
  return null;
}

function buildOpencodeReloadUrl(baseUrl: string, directory?: string | null): string {
  try {
    const url = new URL(baseUrl);
    url.pathname = "/instance/dispose";
    url.search = "";
    if (directory) {
      url.searchParams.set("directory", directory);
    }
    return url.toString();
  } catch {
    throw new ApiError(400, "opencode_url_invalid", "OpenCode base URL is invalid");
  }
}

function buildOpencodeAuthHeader(workspace: WorkspaceInfo): string | null {
  const username = workspace.opencodeUsername?.trim() ?? "";
  const password = workspace.opencodePassword?.trim() ?? "";
  if (!username || !password) return null;
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function parseOpencodeErrorBody(input: string): unknown {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

async function reloadOpencodeEngine(workspace: WorkspaceInfo): Promise<void> {
  const baseUrl = workspace.baseUrl?.trim() ?? "";
  if (!baseUrl) {
    throw new ApiError(400, "opencode_unconfigured", "OpenCode base URL is missing for this workspace");
  }

  const directory = resolveOpencodeDirectory(workspace);
  const targetUrl = buildOpencodeReloadUrl(baseUrl, directory);
  const headers: Record<string, string> = {};
  const auth = buildOpencodeAuthHeader(workspace);
  if (auth) headers.Authorization = auth;

  const response = await fetch(targetUrl, { method: "POST", headers });
  if (response.ok) return;
  const body = parseOpencodeErrorBody(await response.text());
  throw new ApiError(502, "opencode_reload_failed", "OpenCode reload failed", {
    status: response.status,
    body,
  });
}

async function writeOpenworkConfig(workspaceRoot: string, payload: Record<string, unknown>, merge: boolean): Promise<void> {
  const path = openworkConfigPath(workspaceRoot);
  const next = merge ? { ...(await readOpenworkConfig(workspaceRoot)), ...payload } : payload;
  await ensureDir(join(workspaceRoot, ".opencode"));
  await writeFile(path, JSON.stringify(next, null, 2) + "\n", "utf8");
}

async function requireApproval(
  ctx: RequestContext,
  input: Omit<ApprovalRequest, "id" | "createdAt" | "actor">,
): Promise<void> {
  const actor = ctx.actor ?? { type: "remote" };
  const result = await ctx.approvals.requestApproval({ ...input, actor });
  if (!result.allowed) {
    throw new ApiError(403, "write_denied", "Write request denied", {
      requestId: result.id,
      reason: result.reason,
    });
  }
}

async function exportWorkspace(workspace: WorkspaceInfo) {
  const opencode = await readOpencodeConfig(workspace.path);
  const openwork = await readOpenworkConfig(workspace.path);
  const skills = await listSkills(workspace.path, false);
  const commands = await listCommands(workspace.path, "workspace");
  const skillContents = await Promise.all(
    skills.map(async (skill) => ({
      name: skill.name,
      description: skill.description,
      content: await readFile(skill.path, "utf8"),
    })),
  );
  const commandContents = await Promise.all(
    commands.map(async (command) => ({
      name: command.name,
      description: command.description,
      template: command.template,
    })),
  );

  return {
    workspaceId: workspace.id,
    exportedAt: Date.now(),
    opencode,
    openwork,
    skills: skillContents,
    commands: commandContents,
  };
}

async function importWorkspace(workspace: WorkspaceInfo, payload: Record<string, unknown>): Promise<void> {
  const modes = (payload.mode as Record<string, string> | undefined) ?? {};
  const opencode = payload.opencode as Record<string, unknown> | undefined;
  const openwork = payload.openwork as Record<string, unknown> | undefined;
  const skills = (payload.skills as { name: string; content: string; description?: string }[] | undefined) ?? [];
  const commands = (payload.commands as { name: string; content?: string; description?: string; template?: string; agent?: string; model?: string | null; subtask?: boolean }[] | undefined) ?? [];

  if (opencode) {
    if (modes.opencode === "replace") {
      await writeJsoncFile(opencodeConfigPath(workspace.path), opencode);
    } else {
      await updateJsoncTopLevel(opencodeConfigPath(workspace.path), opencode);
    }
  }

  if (openwork) {
    if (modes.openwork === "replace") {
      await writeOpenworkConfig(workspace.path, openwork, false);
    } else {
      await writeOpenworkConfig(workspace.path, openwork, true);
    }
  }

  if (skills.length > 0) {
    if (modes.skills === "replace") {
      await rm(projectSkillsDir(workspace.path), { recursive: true, force: true });
    }
    for (const skill of skills) {
      await upsertSkill(workspace.path, skill);
    }
  }

  if (commands.length > 0) {
    if (modes.commands === "replace") {
      await rm(projectCommandsDir(workspace.path), { recursive: true, force: true });
    }
    for (const command of commands) {
      if (command.content) {
        const parsed = parseFrontmatter(command.content);
        const name = command.name || (typeof parsed.data.name === "string" ? parsed.data.name : "");
        const description = command.description || (typeof parsed.data.description === "string" ? parsed.data.description : undefined);
        if (!name) {
          throw new ApiError(400, "invalid_command", "Command name is required");
        }
        const template = parsed.body.trim();
        await upsertCommand(workspace.path, {
          name,
          description,
          template,
          agent: typeof parsed.data.agent === "string" ? parsed.data.agent : undefined,
          model: typeof parsed.data.model === "string" ? parsed.data.model : undefined,
          subtask: typeof parsed.data.subtask === "boolean" ? parsed.data.subtask : undefined,
        });
      } else {
        const name = command.name ?? "";
        const template = command.template ?? "";
        await upsertCommand(workspace.path, {
          name,
          description: command.description,
          template,
          agent: command.agent,
          model: command.model,
          subtask: command.subtask,
        });
      }
    }
  }
}
