import { z } from "zod";
import {
  CONNECT_AGENT_PATH,
  CONNECT_CONTRACT_VERSION,
  CONNECT_RUNTIME_VERSION,
} from "@openwork/connect-core/profile";

import { ConnectLocalService } from "../connect-local-service.js";
import { ConnectLocalStore, type ConnectMode } from "../connect-local-store.js";
import { ApiError } from "../errors.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

type JsonResponse = (data: unknown, status?: number) => Response;
type ReadJsonBody = (request: Request) => Promise<Record<string, unknown>>;

const modeSchema = z.object({
  mode: z.enum(["hosted", "local", "disabled"]),
});

const connectionInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  serverUrl: z.string().trim().url().max(2_048),
  authType: z.enum(["none", "api-key", "oauth"]),
  allowPrivateNetwork: z.boolean().optional(),
  apiKey: z.string().trim().min(1).max(16_384).optional(),
  oauthClient: z.object({
    clientId: z.string().trim().min(1).max(2_048),
    clientSecret: z.string().trim().min(1).max(16_384).optional(),
  }).optional(),
}).superRefine((value, context) => {
  if (value.authType === "api-key" && !value.apiKey) {
    context.addIssue({ code: "custom", path: ["apiKey"], message: "An API key is required." });
  }
  if (value.authType !== "api-key" && value.apiKey) {
    context.addIssue({ code: "custom", path: ["apiKey"], message: "API keys are accepted only for API-key connections." });
  }
  if (value.authType !== "oauth" && value.oauthClient) {
    context.addIssue({ code: "custom", path: ["oauthClient"], message: "OAuth client details are accepted only for OAuth connections." });
  }
});

export type RegisterConnectRoutesOptions = {
  routes: Route[];
  config: ServerConfig;
  jsonResponse: JsonResponse;
  readJsonBody: ReadJsonBody;
  ensureWritable: (config: ServerConfig) => void;
  reconcileLocalWorkspace: (input: {
    workspace: WorkspaceInfo;
    endpoint: string;
    token: string;
  }) => Promise<unknown>;
  disableLocalWorkspace: (workspace: WorkspaceInfo) => Promise<void>;
};

function oauthCallbackPage(input: { ok: boolean; title: string; message: string }, status = 200): Response {
  const color = input.ok ? "#16a34a" : "#dc2626";
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${input.title}</title>
  </head>
  <body style="font-family:system-ui,sans-serif;max-width:560px;margin:80px auto;padding:24px;color:#18181b">
    <div style="width:48px;height:48px;border-radius:999px;background:${color};margin-bottom:20px"></div>
    <h1>${input.title}</h1>
    <p>${input.message}</p>
    <p>You can close this window and return to OpenWork.</p>
    <script>setTimeout(() => window.close(), 1200)</script>
  </body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
      "Cache-Control": "no-store",
    },
  });
}

export function registerConnectRoutes(options: RegisterConnectRoutesOptions): void {
  const {
    routes,
    config,
    jsonResponse,
    readJsonBody,
    ensureWritable,
    reconcileLocalWorkspace,
    disableLocalWorkspace,
  } = options;
  const profileStore = new ConnectLocalStore(config);
  let service: ConnectLocalService | undefined;

  const localService = (): ConnectLocalService => {
    const vault = ConnectLocalService.vaultStatus();
    if (vault.status !== "ready") {
      throw new ApiError(503, "connect_vault_unavailable", vault.message, { vault });
    }
    service ??= new ConnectLocalService(config);
    return service;
  };

  const profile = (requestUrl: string) => {
    const vault = ConnectLocalService.vaultStatus();
    if (vault.status === "ready") return localService().profile(requestUrl);
    const connections = profileStore.listConnections();
    return {
      mode: profileStore.mode(),
      deployment: process.versions.electron ? "desktop-local" : "self-hosted",
      runtimeVersion: CONNECT_RUNTIME_VERSION,
      contractVersion: CONNECT_CONTRACT_VERSION,
      localAvailable: false,
      vault,
      agentEndpoint: new URL(CONNECT_AGENT_PATH, requestUrl).toString(),
      connectionCount: connections.length,
      connectedCount: connections.filter((connection) => connection.status === "connected").length,
      features: {
        organizations: false,
        teams: false,
        sharedCredentials: false,
        perActorCredentials: false,
        externalMcp: true,
        localSkills: false,
        installedPlugins: false,
        nativeProviders: [],
        privateNetworkSources: true,
        externalClients: false,
        audit: false,
      },
    };
  };

  addRoute(routes, "GET", "/v1/connect/profile", "client", async (ctx) => {
    return jsonResponse(profile(ctx.request.url));
  });

  addRoute(routes, "PUT", "/v1/connect/profile", "host", async (ctx) => {
    ensureWritable(config);
    const parsed = modeSchema.safeParse(await readJsonBody(ctx.request));
    if (!parsed.success) throw new ApiError(400, "connect_invalid_profile", "Connect mode is invalid.");
    const mode: ConnectMode = parsed.data.mode;
    const previousMode = profileStore.mode();
    const deliveries: Array<{ workspaceId: string; status: "updated" | "failed"; result?: unknown; error?: string }> = [];
    if (mode === "local") {
      const connect = localService();
      connect.setMode(mode);
      const endpoint = connect.agentEndpoint(ctx.request.url);
      const token = connect.agentToken();
      for (const workspace of config.workspaces) {
        try {
          const result = await reconcileLocalWorkspace({ workspace, endpoint, token });
          deliveries.push({ workspaceId: workspace.id, status: "updated", result });
        } catch (error) {
          deliveries.push({
            workspaceId: workspace.id,
            status: "failed",
            error: error instanceof Error ? error.message : "Local Connect delivery failed.",
          });
        }
      }
    } else {
      profileStore.setMode(mode);
      if (mode === "disabled" || previousMode === "local") {
        for (const workspace of config.workspaces) {
          try {
            await disableLocalWorkspace(workspace);
            deliveries.push({ workspaceId: workspace.id, status: "updated" });
          } catch (error) {
            deliveries.push({
              workspaceId: workspace.id,
              status: "failed",
              error: error instanceof Error ? error.message : "Local Connect removal failed.",
            });
          }
        }
      }
    }
    return jsonResponse({ profile: profile(ctx.request.url), deliveries });
  });

  addRoute(routes, "GET", "/v1/connect/connections", "client", async () => {
    return jsonResponse({ items: profileStore.listConnections() });
  });

  addRoute(routes, "POST", "/v1/connect/connections", "host", async (ctx) => {
    ensureWritable(config);
    const parsed = connectionInputSchema.safeParse(await readJsonBody(ctx.request));
    if (!parsed.success) {
      throw new ApiError(400, "connect_invalid_connection", "Connection details are invalid.", parsed.error.flatten());
    }
    const connection = await localService().createConnection(parsed.data);
    return jsonResponse(connection, 201);
  });

  addRoute(routes, "DELETE", "/v1/connect/connections/:id", "host", async (ctx) => {
    ensureWritable(config);
    if (!localService().deleteConnection(ctx.params.id)) {
      throw new ApiError(404, "connect_connection_not_found", "Connect connection not found.");
    }
    return jsonResponse({ deleted: true });
  });

  addRoute(routes, "POST", "/v1/connect/connections/:id/connect", "host", async (ctx) => {
    ensureWritable(config);
    return jsonResponse(await localService().connect(ctx.params.id, ctx.request.url));
  });

  addRoute(routes, "POST", "/v1/connect/connections/:id/disconnect", "host", async (ctx) => {
    ensureWritable(config);
    return jsonResponse(localService().disconnect(ctx.params.id));
  });

  addRoute(routes, "GET", "/v1/connect/connections/:id/callback", "none", async (ctx) => {
    const code = ctx.url.searchParams.get("code")?.trim() ?? "";
    const state = ctx.url.searchParams.get("state")?.trim() ?? "";
    const providerError = ctx.url.searchParams.get("error")?.trim() ?? "";
    if (!state) return oauthCallbackPage({ ok: false, title: "Connection failed", message: "The OAuth state was missing." }, 400);
    if (providerError) {
      await localService().abandonAuthorization({ id: ctx.params.id, requestUrl: ctx.request.url, state });
      return oauthCallbackPage({ ok: false, title: "Connection cancelled", message: "The provider did not authorize this connection." }, 400);
    }
    if (!code) return oauthCallbackPage({ ok: false, title: "Connection failed", message: "The authorization code was missing." }, 400);
    try {
      await localService().completeAuthorization({
        id: ctx.params.id,
        requestUrl: ctx.request.url,
        code,
        state,
      });
      return oauthCallbackPage({ ok: true, title: "Connected", message: "The MCP connection is ready in OpenWork." });
    } catch (error) {
      const status = error instanceof ApiError && error.status >= 400 && error.status < 500 ? error.status : 502;
      return oauthCallbackPage({ ok: false, title: "Connection failed", message: "OpenWork could not complete authorization." }, status);
    }
  });

  const agentHandler = async (ctx: RequestContext) => {
    const vault = ConnectLocalService.vaultStatus();
    if (vault.status !== "ready") {
      return jsonResponse({ error: "connect_vault_unavailable" }, 503);
    }
    return localService().handleAgentRequest(ctx.request);
  };
  addRoute(routes, "POST", CONNECT_AGENT_PATH, "none", agentHandler);
  addRoute(routes, "GET", CONNECT_AGENT_PATH, "none", agentHandler);
  addRoute(routes, "DELETE", CONNECT_AGENT_PATH, "none", agentHandler);
}
