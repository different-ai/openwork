import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { EnvStoreReadError, InvalidEnvKeyError, isValidEnvKey, type EnvService } from "../env-file.js";
import { ApiError } from "../errors.js";
import {
  createGoogleWorkspaceConnectFlowManager,
  googleWorkspaceDisconnect,
  googleWorkspaceRunScopeSmokeTest,
  googleWorkspaceSetActiveAccount,
  googleWorkspaceStatus,
  googleWorkspaceTestConnection,
} from "../extensions/google-workspace.js";
import { callExperimentalExtensionAction, listExperimentalExtensionActions } from "../extensions/index.js";
import type { TokenService } from "../tokens.js";
import {
  TOY_UI_CSS,
  TOY_UI_FAVICON_SVG,
  TOY_UI_HTML,
  TOY_UI_JS,
  cssResponse,
  htmlResponse,
  jsResponse,
  svgResponse,
} from "../toy-ui.js";
import type { Capabilities, ServerConfig, WorkspaceInfo } from "../types.js";
import { addRoute, type Route } from "./registry.js";

type JsonResponse = (data: unknown, status?: number) => Response;
type ReadJsonBody = (request: Request) => Promise<Record<string, unknown>>;
type ParseOptionalBoolean = (value: string | null, name: string) => boolean | undefined;
type FetchRuntimeControl = (path: string, init?: { method?: string; body?: unknown }) => Promise<unknown>;

interface RegisterCoreRoutesOptions {
  routes: Route[];
  config: ServerConfig;
  tokens: TokenService;
  env: EnvService;
  serverVersion: string;
  opencodeVersion: string;
  jsonResponse: JsonResponse;
  readJsonBody: ReadJsonBody;
  readOptionalJsonBody: ReadJsonBody;
  parseOptionalBoolean: ParseOptionalBoolean;
  ensureWritable: (config: ServerConfig) => void;
  buildCapabilities: (config: ServerConfig) => Capabilities;
  fetchRuntimeControl: FetchRuntimeControl;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  serializeWorkspace: (workspace: ServerConfig["workspaces"][number]) => unknown;
  resolveToyUiEnabled: () => boolean;
  resolveDevLogPath: () => string | null;
  createOpenAiRealtimeVoiceSession: (env: EnvService, input: unknown) => Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function registerCoreRoutes(options: RegisterCoreRoutesOptions): void {
  const {
    routes,
    config,
    tokens,
    env,
    serverVersion,
    opencodeVersion,
    jsonResponse,
    readJsonBody,
    readOptionalJsonBody,
    parseOptionalBoolean,
    ensureWritable,
    buildCapabilities,
    fetchRuntimeControl,
    resolveWorkspace,
    serializeWorkspace,
    resolveToyUiEnabled,
    resolveDevLogPath,
    createOpenAiRealtimeVoiceSession,
  } = options;
  const googleWorkspaceConnectFlows = createGoogleWorkspaceConnectFlowManager(config);
  const envPendingChangesByRuntime = new Map<string, boolean>();

  const healthResponse = () => jsonResponse({
    ok: true,
    version: serverVersion,
    opencodeVersion,
    uptimeMs: Date.now() - config.startedAt,
  });

  addRoute(routes, "GET", "/health", "none", async () => healthResponse());

  addRoute(routes, "GET", "/w/:id/health", "none", async () => healthResponse());

  // Dev log sink: append browser console + error events to a file that an
  // operator (or an AI driver) can tail. Unauth on purpose because this is
  // scoped to the dev host and needs to work before clients finish wiring
  // tokens; it is also a no-op when OPENWORK_DEV_LOG_FILE is unset.
  addRoute(routes, "POST", "/dev/log", "none", async (ctx) => {
    const target = resolveDevLogPath();
    if (!target) {
      return jsonResponse({ ok: false, reason: "dev_log_disabled" }, 404);
    }
    let payload: unknown = null;
    try {
      payload = await ctx.request.json();
    } catch {
      return jsonResponse({ ok: false, reason: "invalid_json" }, 400);
    }
    const entries = Array.isArray(payload) ? payload : [payload];
    try {
      await mkdir(dirname(target), { recursive: true });
      const lines = entries
        .map((entry) => {
          const at = new Date().toISOString();
          try {
            return JSON.stringify(isRecord(entry) ? { at, ...entry } : { at, raw: String(entry) });
          } catch {
            return JSON.stringify({ at, raw: String(entry) });
          }
        })
        .join("\n");
      await appendFile(target, `${lines}\n`, "utf8");
    } catch (error) {
      return jsonResponse({ ok: false, reason: error instanceof Error ? error.message : String(error) }, 500);
    }
    return jsonResponse({ ok: true, count: entries.length });
  });

  addRoute(routes, "GET", "/dev/log", "none", async () => {
    // Probe response: always 200 so the client's capability probe doesn't
    // log a noisy "Failed to load resource: 404" in the browser console
    // when the sink is simply disabled. Clients should key on `ok` + `reason`
    // in the body, not on HTTP status.
    const target = resolveDevLogPath();
    if (!target) {
      return jsonResponse({ ok: false, reason: "dev_log_disabled" });
    }
    return jsonResponse({ ok: true, path: target });
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

  addRoute(routes, "GET", "/ui/assets/openwork-mark.svg", "none", async () => {
    if (!resolveToyUiEnabled()) {
      throw new ApiError(404, "ui_disabled", "Toy UI is disabled");
    }
    return svgResponse(TOY_UI_FAVICON_SVG);
  });

  addRoute(routes, "GET", "/w/:id/status", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    return jsonResponse({
      ok: true,
      version: serverVersion,
      opencodeVersion,
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
      version: serverVersion,
      opencodeVersion,
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

  addRoute(routes, "GET", "/runtime/versions", "client", async () => {
    const snapshot = await fetchRuntimeControl("/runtime/versions");
    return jsonResponse(snapshot);
  });

  addRoute(routes, "POST", "/runtime/upgrade", "host", async (ctx) => {
    const body = await readJsonBody(ctx.request);
    const result = await fetchRuntimeControl("/runtime/upgrade", { method: "POST", body });
    return jsonResponse(result, 202);
  });

  addRoute(routes, "GET", "/w/:id/runtime/versions", "client", async () => {
    const snapshot = await fetchRuntimeControl("/runtime/versions");
    return jsonResponse(snapshot);
  });

  addRoute(routes, "POST", "/w/:id/runtime/upgrade", "host", async (ctx) => {
    const body = await readJsonBody(ctx.request);
    const result = await fetchRuntimeControl("/runtime/upgrade", { method: "POST", body });
    return jsonResponse(result, 202);
  });

  addRoute(routes, "GET", "/whoami", "client", async (ctx) => {
    return jsonResponse({ ok: true, actor: ctx.actor ?? null });
  });

  addRoute(routes, "GET", "/capabilities", "client", async () => {
    return jsonResponse(buildCapabilities(config));
  });

  addRoute(routes, "GET", "/experimental/extensions/actions", "client", async (ctx) => {
    const extensionId = ctx.url.searchParams.get("extensionId") ?? "";
    return jsonResponse({
      ok: true,
      schemaVersion: 1,
      actions: listExperimentalExtensionActions(extensionId),
    });
  });

  addRoute(routes, "POST", "/experimental/extensions/call", "client", async (ctx) => {
    if (ctx.actor?.scope === "viewer") {
      throw new ApiError(403, "forbidden", "Viewer tokens cannot call extension actions");
    }
    const body = await readJsonBody(ctx.request);
    return jsonResponse(await callExperimentalExtensionAction(config, env, body));
  });

  addRoute(routes, "GET", "/experimental/google-workspace/status", "client", async () => {
    return jsonResponse(await googleWorkspaceStatus(config));
  });

  addRoute(routes, "POST", "/experimental/google-workspace/connect/start", "client", async (ctx) => {
    if (ctx.actor?.scope === "viewer") throw new ApiError(403, "forbidden", "Viewer tokens cannot connect Google Workspace");
    const body = await readOptionalJsonBody(ctx.request);
    const featuresValue = body.features;
    const features = Array.isArray(featuresValue) ? featuresValue.filter((item): item is string => typeof item === "string") : [];
    return jsonResponse(await googleWorkspaceConnectFlows.start({ gmailRead: body.gmailRead === true, features }), 201);
  });

  addRoute(routes, "GET", "/experimental/google-workspace/connect/status/:flowId", "client", async (ctx) => {
    return jsonResponse(await googleWorkspaceConnectFlows.status(ctx.params.flowId));
  });

  addRoute(routes, "POST", "/experimental/google-workspace/disconnect", "client", async (ctx) => {
    if (ctx.actor?.scope === "viewer") throw new ApiError(403, "forbidden", "Viewer tokens cannot disconnect Google Workspace");
    const body = await readOptionalJsonBody(ctx.request);
    const accountId = typeof body.accountId === "string" && body.accountId.trim() ? body.accountId.trim() : null;
    return jsonResponse(await googleWorkspaceDisconnect(config, accountId));
  });

  addRoute(routes, "POST", "/experimental/google-workspace/active-account", "client", async (ctx) => {
    if (ctx.actor?.scope === "viewer") throw new ApiError(403, "forbidden", "Viewer tokens cannot update Google Workspace settings");
    const body = await readJsonBody(ctx.request);
    const accountId = typeof body.accountId === "string" && body.accountId.trim() ? body.accountId.trim() : "";
    if (!accountId) throw new ApiError(400, "invalid_payload", "accountId is required");
    return jsonResponse(await googleWorkspaceSetActiveAccount(config, accountId));
  });

  addRoute(routes, "POST", "/experimental/google-workspace/test", "client", async () => {
    return jsonResponse(await googleWorkspaceTestConnection(config));
  });

  addRoute(routes, "POST", "/experimental/google-workspace/smoke-test", "client", async () => {
    return jsonResponse(await googleWorkspaceRunScopeSmokeTest(config));
  });

  addRoute(routes, "GET", "/workspaces", "client", async () => {
    const active = config.workspaces[0] ?? null;
    const items = config.workspaces.map(serializeWorkspace);
    return jsonResponse({ items, workspaces: items, activeId: active?.id ?? null });
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

  function rethrowEnvStoreReadError(error: unknown): never {
    if (error instanceof EnvStoreReadError) {
      throw new ApiError(
        409,
        error.code,
        "Environment variable store is invalid. Fix or remove the local env file before editing.",
      );
    }
    throw error;
  }

  // User-level env vars (see apps/app/pr/environment-variables.md). All routes
  // require the desktop host token (not owner bearer tokens). List callers can
  // request metadata-only results so renderer settings panes do not receive
  // every raw secret value up front. Reload semantics are driven from the UI
  // after a write; this surface is user-scoped, not workspace-scoped, so no audit.
  addRoute(routes, "GET", "/env", "host-token", async (ctx) => {
    const includeValues = parseOptionalBoolean(ctx.url.searchParams.get("includeValues"), "includeValues") ?? true;
    const items = await env.list().catch(rethrowEnvStoreReadError);
    return jsonResponse({
      items: items.map((item) => ({
        key: item.key,
        updatedAt: item.updatedAt,
        hasValue: item.value.length > 0,
        ...(includeValues ? { value: item.value } : {}),
      })),
    });
  });

  addRoute(routes, "GET", "/env/keys", "host-token", async () => {
    const items = await env.list().catch(rethrowEnvStoreReadError);
    return jsonResponse({ keys: items.map((item) => item.key) });
  });

  function envRuntimeKeyFromUrl(url: URL): string {
    return url.searchParams.get("runtimeKey")?.trim() || "default";
  }

  addRoute(routes, "GET", "/env/status", "host-token", async (ctx) => {
    const runtimeKey = envRuntimeKeyFromUrl(ctx.url);
    return jsonResponse({ runtimeKey, pendingChanges: envPendingChangesByRuntime.get(runtimeKey) === true });
  });

  addRoute(routes, "PUT", "/env/status", "host-token", async (ctx) => {
    const body = await readJsonBody(ctx.request);
    const runtimeKey = typeof body.runtimeKey === "string" && body.runtimeKey.trim()
      ? body.runtimeKey.trim()
      : "default";
    const pendingChanges = body.pendingChanges === true;
    if (pendingChanges) {
      envPendingChangesByRuntime.set(runtimeKey, true);
    } else {
      envPendingChangesByRuntime.delete(runtimeKey);
    }
    return jsonResponse({ runtimeKey, pendingChanges });
  });

  addRoute(routes, "GET", "/env/:key", "host-token", async (ctx) => {
    const key = ctx.params.key;
    if (!isValidEnvKey(key)) {
      throw new ApiError(400, "invalid_env_key", "Invalid environment variable name");
    }
    const item = (await env.list().catch(rethrowEnvStoreReadError)).find((entry) => entry.key === key);
    if (!item) {
      throw new ApiError(404, "env_not_found", "Environment variable not found");
    }
    return jsonResponse({
      item: {
        key: item.key,
        updatedAt: item.updatedAt,
        hasValue: item.value.length > 0,
        value: item.value,
      },
    });
  });

  addRoute(routes, "PUT", "/env", "host-token", async (ctx) => {
    ensureWritable(config);
    const body = await readJsonBody(ctx.request);
    const rawEntries = Array.isArray(body.entries)
      ? body.entries
      : [{ key: body.key, value: body.value }];
    const entries: Array<{ key: string; value: string }> = [];
    for (const raw of rawEntries) {
      if (!isRecord(raw)) {
        throw new ApiError(400, "invalid_entry", "Each entry must be an object");
      }
      const key = typeof raw.key === "string" ? raw.key.trim() : "";
      const value = typeof raw.value === "string" ? raw.value : "";
      if (!isValidEnvKey(key)) {
        throw new ApiError(400, "invalid_env_key", "Invalid environment variable name");
      }
      entries.push({ key, value });
    }
    if (entries.length === 0) {
      throw new ApiError(400, "no_entries", "No entries provided");
    }
    try {
      await env.upsertMany(entries);
    } catch (error) {
      if (error instanceof EnvStoreReadError) {
        rethrowEnvStoreReadError(error);
      }
      if (error instanceof InvalidEnvKeyError) {
        throw new ApiError(
          400,
          error.code,
          error.code === "reserved_env_key"
            ? "Environment variable name is reserved for OpenWork internals"
            : "Invalid environment variable name",
        );
      }
      throw error;
    }
    return jsonResponse({ ok: true, count: entries.length });
  });

  addRoute(routes, "DELETE", "/env/:key", "host-token", async (ctx) => {
    ensureWritable(config);
    const key = ctx.params.key;
    if (!isValidEnvKey(key)) {
      throw new ApiError(400, "invalid_env_key", "Invalid environment variable name");
    }
    const removed = await env.delete(key).catch(rethrowEnvStoreReadError);
    if (!removed) {
      throw new ApiError(404, "env_not_found", "Environment variable not found");
    }
    return jsonResponse({ ok: true });
  });

  addRoute(routes, "POST", "/voice/realtime/session", "host", async (ctx) => {
    const body = await readJsonBody(ctx.request);
    return jsonResponse(await createOpenAiRealtimeVoiceSession(env, body));
  });
}
