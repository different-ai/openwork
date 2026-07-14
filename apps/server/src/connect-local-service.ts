import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  createConnectMcpServer,
  createConnectRuntime,
  createRemoteMcpCapabilitySource,
  CONNECT_AGENT_PATH,
  CONNECT_CONTRACT_VERSION,
  CONNECT_RUNTIME_VERSION,
  registerConnectTools,
  textContent,
  type ConnectToolResult,
  type RemoteMcpCapabilityConnection,
} from "@openwork/connect-core";
import type { ConnectProfile as PortableConnectProfile } from "@openwork/connect-core/profile";
import {
  assertPublicUrl,
  createEnterpriseMcpClient,
  createGuardedFetch,
  createRealmSafeFetch,
  EnterpriseMcpClientError,
  PrivateUrlError,
  type EnterpriseMcpConnection,
} from "@openwork/enterprise-mcp-client";

import {
  ConnectLocalStore,
  type ConnectLocalConnection,
  type ConnectLocalConnectionInput,
  type ConnectMode,
} from "./connect-local-store.js";
import { ConnectLocalVault, readConnectVaultStatus, type ConnectVaultStatus } from "./connect-local-vault.js";
import { ApiError } from "./errors.js";
import type { ServerConfig } from "./types.js";

const LOCAL_CONNECT_INSTRUCTIONS = [
  "This is OpenWork Connect running on the user's OpenWork Server.",
  "It exposes exactly two tools: search_capabilities and execute_capability.",
  "Always search first and execute only exact names returned by search.",
  "Connections and credentials are managed by the server owner in Settings > Connect and are not supplied by the agent.",
].join("\n");

function enabled(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof EnterpriseMcpClientError) {
    const request = error.requestPhase ? ` during ${error.requestPhase}` : "";
    return `${error.code}${request}. Check the connection and try again.`;
  }
  if (error instanceof PrivateUrlError) return error.message.slice(0, 800);
  if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return "The remote MCP request timed out.";
  }
  return "The remote MCP request failed. Check the server URL, sign-in method, and network policy.";
}

function normalizeToolResult(result: unknown): ConnectToolResult {
  if (typeof result === "object" && result !== null && "content" in result && Array.isArray(result.content)) {
    const text = result.content
      .filter((item): item is { type: "text"; text: string } => (
        typeof item === "object"
        && item !== null
        && "type" in item
        && item.type === "text"
        && "text" in item
        && typeof item.text === "string"
      ));
    if (text.length === result.content.length) {
      const isError = "isError" in result && result.isError === true;
      return { content: text, ...(isError ? { isError: true } : {}) };
    }
  }
  return { content: textContent(JSON.stringify(result, null, 2)) };
}

function validRemoteMcpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiError(400, "connect_invalid_url", "MCP server URL must be a valid HTTP or HTTPS URL.");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.hash) {
    throw new ApiError(400, "connect_invalid_url", "MCP server URL must use HTTP or HTTPS and cannot contain credentials or a fragment.");
  }
  return url;
}

export type ConnectProfile = PortableConnectProfile;

export class ConnectLocalService {
  private readonly config: ServerConfig;
  private readonly vault: ConnectLocalVault;
  private readonly store: ConnectLocalStore;
  private readonly allowPrivateUrls: boolean;

  constructor(config: ServerConfig) {
    this.config = config;
    this.vault = new ConnectLocalVault();
    this.store = new ConnectLocalStore(config, this.vault);
    this.allowPrivateUrls = enabled(process.env.OPENWORK_CONNECT_ALLOW_PRIVATE_URLS);
  }

  static vaultStatus(): ConnectVaultStatus {
    return readConnectVaultStatus();
  }

  profile(requestUrl: string): ConnectProfile {
    const connections = this.store.listConnections();
    return {
      mode: this.store.mode(),
      deployment: process.versions.electron ? "desktop-local" : "self-hosted",
      runtimeVersion: CONNECT_RUNTIME_VERSION,
      contractVersion: CONNECT_CONTRACT_VERSION,
      localAvailable: true,
      vault: { status: "ready" },
      agentEndpoint: this.agentEndpoint(requestUrl),
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
  }

  setMode(mode: ConnectMode): void {
    this.store.setMode(mode);
  }

  agentEndpoint(requestUrl: string): string {
    const override = process.env.OPENWORK_CONNECT_AGENT_URL?.trim();
    if (override) return new URL(CONNECT_AGENT_PATH, override).toString();
    const request = new URL(requestUrl);
    const host = this.config.host === "0.0.0.0" || this.config.host === "::"
      ? "127.0.0.1"
      : this.config.host;
    const base = new URL(request.origin);
    base.hostname = host;
    return new URL(CONNECT_AGENT_PATH, base).toString();
  }

  agentToken(): string {
    return this.vault.agentToken(this.store.agentRevision());
  }

  listConnections(): ConnectLocalConnection[] {
    return this.store.listConnections();
  }

  async createConnection(input: ConnectLocalConnectionInput): Promise<ConnectLocalConnection> {
    const url = validRemoteMcpUrl(input.serverUrl);
    if (!this.allowPrivateUrls && !input.allowPrivateNetwork) await assertPublicUrl(url.toString());
    return this.store.createConnection({ ...input, serverUrl: url.toString() });
  }

  deleteConnection(id: string): boolean {
    return this.store.deleteConnection(id);
  }

  async connect(id: string, requestUrl: string): Promise<{ status: "connected" | "needs_auth"; authorizeUrl?: string }> {
    const connection = this.requireConnection(id);
    const redirectUri = this.redirectUri(requestUrl, connection.id);
    const authorizationId = connection.authType === "oauth"
      ? this.vault.createAuthorizationId({ connectionId: connection.id, redirectUri })
      : undefined;
    try {
      const result = await this.clientFor(connection).connect({
        connection: this.enterpriseConnection(connection, redirectUri),
        redirectUri,
        ...(authorizationId ? { authorizationId } : {}),
      });
      if (result.status === "needs_auth") {
        this.store.setConnectionStatus(id, "needs_auth");
        return { status: "needs_auth", authorizeUrl: result.authorizeUrl };
      }
      this.store.setConnectionStatus(id, "connected");
      return { status: "connected" };
    } catch (error) {
      this.store.setConnectionStatus(id, connection.authType === "oauth" ? "needs_auth" : "error", safeErrorMessage(error));
      throw new ApiError(502, "connect_handshake_failed", "The MCP connection could not be established.", {
        connectionId: id,
        reason: safeErrorMessage(error),
      });
    }
  }

  async completeAuthorization(input: {
    id: string;
    requestUrl: string;
    code: string;
    state: string;
  }): Promise<void> {
    const connection = this.requireConnection(input.id);
    if (connection.authType !== "oauth") {
      throw new ApiError(400, "connect_oauth_not_configured", "This connection does not use OAuth.");
    }
    const redirectUri = this.redirectUri(input.requestUrl, connection.id);
    if (!this.vault.verifiesAuthorizationId({
      candidate: input.state,
      connectionId: connection.id,
      redirectUri,
    })) {
      throw new ApiError(400, "connect_oauth_state_invalid", "The OAuth authorization state is invalid or expired.");
    }
    try {
      const client = this.clientFor(connection);
      await client.completeAuthorization({
        connection: this.enterpriseConnection(connection, redirectUri),
        redirectUri,
        code: input.code,
        authorizationId: input.state,
      });
      await client.listTools({
        connection: this.enterpriseConnection(connection, redirectUri),
        redirectUri,
      });
      this.store.setConnectionStatus(connection.id, "connected");
    } catch (error) {
      this.store.setConnectionStatus(connection.id, "needs_auth", safeErrorMessage(error));
      throw new ApiError(502, "connect_oauth_callback_failed", "OAuth authorization could not be completed.", {
        connectionId: connection.id,
        reason: safeErrorMessage(error),
      });
    }
  }

  async abandonAuthorization(input: { id: string; requestUrl: string; state: string }): Promise<void> {
    const connection = this.requireConnection(input.id);
    if (connection.authType !== "oauth") return;
    const redirectUri = this.redirectUri(input.requestUrl, connection.id);
    if (!this.vault.verifiesAuthorizationId({
      candidate: input.state,
      connectionId: connection.id,
      redirectUri,
    })) return;
    await this.clientFor(connection).abandonAuthorization({
      connection: this.enterpriseConnection(connection, redirectUri),
      authorizationId: input.state,
      reason: "provider-rejected",
    }).catch(() => undefined);
    this.store.setConnectionStatus(connection.id, "needs_auth", "Authorization was cancelled or rejected.");
  }

  disconnect(id: string): ConnectLocalConnection {
    const connection = this.requireConnection(id);
    if (connection.authType === "oauth") this.store.clearCredentials(id);
    this.store.setConnectionStatus(id, connection.authType === "oauth" ? "needs_auth" : "disconnected");
    return this.requireConnection(id);
  }

  async handleAgentRequest(request: Request): Promise<Response> {
    if (this.store.mode() !== "local") {
      return new Response(JSON.stringify({ error: "local_connect_disabled" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    const authorization = request.headers.get("authorization") ?? "";
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (!match?.[1] || !this.vault.verifiesAgentToken(match[1], this.store.agentRevision())) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "WWW-Authenticate": "Bearer",
        },
      });
    }
    const source = createRemoteMcpCapabilitySource({
      id: "local-remote-mcp",
      listConnections: async () => this.remoteConnections(),
      listTools: async (connection) => {
        const stored = this.requireConnection(connection.id);
        const redirectUri = this.redirectUri(request.url, stored.id);
        return this.clientFor(stored).listTools({
          connection: this.enterpriseConnection(stored, redirectUri),
          redirectUri,
        });
      },
      callTool: async ({ connection, toolName, arguments: args }) => {
        const stored = this.requireConnection(connection.id);
        try {
          const redirectUri = this.redirectUri(request.url, stored.id);
          const result = await this.clientFor(stored).callTool({
            connection: this.enterpriseConnection(stored, redirectUri),
            redirectUri,
            toolName,
            arguments: args,
          });
          return normalizeToolResult(result);
        } catch (error) {
          this.store.setConnectionStatus(stored.id, "error", safeErrorMessage(error));
          return {
            isError: true,
            content: textContent(JSON.stringify({
              error: "remote_mcp_call_failed",
              connectionId: stored.id,
              message: safeErrorMessage(error),
            })),
          };
        }
      },
    });
    const runtime = createConnectRuntime({ sources: [source] });
    const server = createConnectMcpServer({
      name: "openwork-local-connect",
      version: "1.0.0",
      instructions: LOCAL_CONNECT_INSTRUCTIONS,
    });
    registerConnectTools(server, runtime);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      await server.close();
    }
  }

  private redirectUri(requestUrl: string, connectionId: string): string {
    const override = process.env.OPENWORK_CONNECT_PUBLIC_URL?.trim();
    const base = override ? new URL(override) : new URL(requestUrl);
    return new URL(`/v1/connect/connections/${encodeURIComponent(connectionId)}/callback`, base.origin).toString();
  }

  private requireConnection(id: string): ConnectLocalConnection {
    const connection = this.store.getConnection(id);
    if (!connection) throw new ApiError(404, "connect_connection_not_found", "Connect connection not found.");
    return connection;
  }

  private enterpriseConnection(connection: ConnectLocalConnection, redirectUri: string): EnterpriseMcpConnection {
    if (connection.authType === "oauth") {
      return {
        id: connection.id,
        serverUrl: connection.serverUrl,
        authorization: { type: "oauth", persistence: this.store.oauthPersistence(connection.id, redirectUri) },
      };
    }
    if (connection.authType === "api-key") {
      const token = this.store.apiKey(connection.id);
      if (!token) throw new ApiError(400, "connect_api_key_missing", "This connection has no stored API key.");
      return {
        id: connection.id,
        serverUrl: connection.serverUrl,
        authorization: { type: "api-key", token },
      };
    }
    return {
      id: connection.id,
      serverUrl: connection.serverUrl,
      authorization: { type: "none" },
    };
  }

  private clientFor(connection: ConnectLocalConnection): ReturnType<typeof createEnterpriseMcpClient> {
    return createEnterpriseMcpClient({
      fetch: this.allowPrivateUrls || connection.networkPolicy === "private"
        ? createRealmSafeFetch()
        : createGuardedFetch(),
      clientName: "OpenWork Local Connect",
      clientVersion: "1.0.0",
    });
  }

  private remoteConnections(): RemoteMcpCapabilityConnection[] {
    return this.store.listConnections().map((connection) => ({
      id: connection.id,
      name: connection.name,
      serverUrl: connection.serverUrl,
      status: connection.status === "connected"
        ? "connected"
        : connection.status === "needs_auth"
          ? "needs_auth"
          : "error",
      ...(connection.lastError ? { statusMessage: connection.lastError } : {}),
    }));
  }
}
