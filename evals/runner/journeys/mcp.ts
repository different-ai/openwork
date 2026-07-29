import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EvalError } from "../context.ts";
import { allocateFreePort } from "../ports.ts";
import { apiSignIn, denApiFetch, denWebUrl, validateActor } from "./den.ts";
import type { ChildProcess } from "node:child_process";
import type { Actor } from "../actors.ts";
import type { FlowContext } from "../flow.ts";
import type { Surface } from "../surfaces.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MOCK_SERVER_SCRIPT = join(REPO_ROOT, "scripts", "mock-oauth-mcp-server.mjs");
const MCP_CONNECTIONS_SCREEN_READY = "document.body.innerText.includes('Connectors') || document.body.innerText.includes('Add MCP') || document.body.innerText.includes('MCP Connections') || document.body.innerText.includes('Add a custom MCP server')";

export type McpAuthType = "oauth" | "apikey" | "none";

export interface McpAccessSummary {
  orgWide: boolean;
  memberIds: string[];
  teamIds: string[];
}

export interface McpConnection {
  id: string;
  name: string;
  url: string;
  authType: McpAuthType;
  credentialMode: "shared" | "per_member";
  connected: boolean;
  connectedForMe: boolean;
  connectedAt?: string | null;
  updatedAt?: string;
  needsReconnect?: boolean;
  credentialHealth?: string;
  access?: McpAccessSummary | null;
}

export interface CreateNoAuthConnectionOptions {
  actor: Actor;
  name: string;
  url: string;
  token?: string;
  organizationId?: string;
  access?: Partial<McpAccessSummary>;
}

export interface CreateOAuthConnectionOptions {
  actor: Actor;
  name: string;
  url: string;
  token?: string;
  organizationId?: string;
  credentialMode?: "shared" | "per_member";
  requestedScopes?: string[];
  access?: Partial<McpAccessSummary>;
}

export interface ListConnectionsOptions {
  actor: Actor;
  token?: string;
  organizationId?: string;
}

export interface ConnectionByIdOptions extends ListConnectionsOptions {
  connectionId: string;
}

export interface ReconnectNoAuthConnectionOptions extends ConnectionByIdOptions {
  url: string;
}

export interface RunConnectionToolOptions extends ConnectionByIdOptions {
  toolName: string;
  arguments: Record<string, unknown>;
}

export interface MintMcpTokenOptions extends ListConnectionsOptions {
  scopes?: string[];
}

export interface McpAgentCallOptions {
  mcpToken: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface CapabilityMatch {
  name: string;
  summary: string;
  schemaDigest?: string;
  argumentsSchema?: unknown;
}

export interface SearchCapabilitiesOptions extends MintMcpTokenOptions {
  query: string;
  limit?: number;
  type?: string;
  mcpToken?: string;
}

export interface ExecuteCapabilityOptions extends MintMcpTokenOptions {
  name: string;
  body?: Record<string, unknown>;
  schemaDigest?: string;
  mcpToken?: string;
}

export interface OpenMcpConnectionsOptions {
  surface: string | Surface;
}

export interface MockMcpServerFixture {
  url: string;
  logPath: string;
  stop(): Promise<void>;
}

export interface StartMockMcpServerOptions {
  port?: number;
  allowUnauthenticated?: boolean;
}

export interface ExpectUsableConnectionOptions extends ConnectionByIdOptions {
  uiConnected: boolean;
  connectionName: string;
  toolName?: string;
  arguments?: Record<string, unknown>;
  expectedText?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function booleanField(record: Record<string, unknown>, key: string): boolean {
  return record[key] === true;
}

function authType(value: unknown): McpAuthType | null {
  if (value === "oauth" || value === "apikey" || value === "none") return value;
  return null;
}

function credentialMode(value: unknown): "shared" | "per_member" | null {
  if (value === "shared" || value === "per_member") return value;
  return null;
}

function accessSummary(value: unknown): McpAccessSummary | null {
  if (!isRecord(value)) return null;
  return {
    orgWide: value.orgWide === true,
    memberIds: Array.isArray(value.memberIds) ? value.memberIds.filter((entry) => typeof entry === "string") : [],
    teamIds: Array.isArray(value.teamIds) ? value.teamIds.filter((entry) => typeof entry === "string") : [],
  };
}

function mcpConnection(value: unknown): McpConnection | null {
  if (!isRecord(value)) return null;
  const parsedAuthType = authType(value.authType);
  const parsedCredentialMode = credentialMode(value.credentialMode);
  const id = stringField(value, "id");
  const name = stringField(value, "name");
  const url = stringField(value, "url");
  if (!id || !name || !url || !parsedAuthType || !parsedCredentialMode) return null;
  const connection: McpConnection = {
    id,
    name,
    url,
    authType: parsedAuthType,
    credentialMode: parsedCredentialMode,
    connected: booleanField(value, "connected"),
    connectedForMe: booleanField(value, "connectedForMe"),
  };
  if (typeof value.connectedAt === "string" || value.connectedAt === null) connection.connectedAt = value.connectedAt;
  if (typeof value.updatedAt === "string") connection.updatedAt = value.updatedAt;
  if (typeof value.needsReconnect === "boolean") connection.needsReconnect = value.needsReconnect;
  if (typeof value.credentialHealth === "string") connection.credentialHealth = value.credentialHealth;
  if (value.access === null) connection.access = null;
  else {
    const access = accessSummary(value.access);
    if (access) connection.access = access;
  }
  return connection;
}

function connectionsFromBody(body: unknown): McpConnection[] {
  const entries = isRecord(body) && Array.isArray(body.connections) ? body.connections : [];
  return entries.flatMap((entry) => {
    const connection = mcpConnection(entry);
    return connection ? [connection] : [];
  });
}

function authHeaders(token: string, organizationId?: string): Headers {
  const headers = new Headers();
  headers.set("authorization", `Bearer ${token}`);
  if (organizationId) headers.set("x-openwork-org-id", organizationId);
  return headers;
}

async function sessionToken(ctx: FlowContext, actor: Actor, token?: string): Promise<string> {
  const configured = token?.trim();
  if (configured) return configured;
  return apiSignIn(ctx, { actor });
}

function responseBodySnippet(body: unknown): string {
  try {
    return JSON.stringify(body).slice(0, 500);
  } catch {
    return String(body).slice(0, 500);
  }
}

function stopChild(child: ChildProcess): Promise<void> {
  return new Promise((resolveStop) => {
    if (!child.pid || child.exitCode !== null) {
      resolveStop();
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolveStop();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveStop();
    });
    child.kill("SIGINT");
  });
}

async function waitForMockHealth(url: string): Promise<void> {
  const startedAt = Date.now();
  let lastError = "not attempted";
  while (Date.now() - startedAt < 15_000) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new EvalError(`Mock MCP server did not become healthy at ${url}: ${lastError}`);
}

export async function startMockMcpServer(ctx: FlowContext, options: StartMockMcpServerOptions = {}): Promise<MockMcpServerFixture> {
  const port = options.port ?? await allocateFreePort();
  const url = `http://127.0.0.1:${port}`;
  const logPath = join(ctx.outDir, `${ctx.flowId}-mock-oauth-mcp.log`);
  const logFd = openSync(logPath, "a");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    ISSUER: url,
    MOCK_ALLOW_UNAUTHENTICATED_MCP: options.allowUnauthenticated === false ? "0" : "1",
  };
  const child = spawn(process.execPath, [MOCK_SERVER_SCRIPT], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  const killOnExit = () => {
    if (child.pid && child.exitCode === null) child.kill("SIGKILL");
  };
  process.once("exit", killOnExit);
  await waitForMockHealth(url);
  ctx.log(`Started mock MCP fixture at ${url}; log ${logPath}`);
  return {
    url,
    logPath,
    stop: async () => {
      process.removeListener("exit", killOnExit);
      await stopChild(child);
      ctx.log(`Stopped mock MCP fixture at ${url}.`);
    },
  };
}

export function mcpTextContent(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.content)) return "";
  return result.content
    .map((entry) => isRecord(entry) && typeof entry.text === "string" ? entry.text : "")
    .filter(Boolean)
    .join("\n");
}

export function capabilityMatchesFromSearchResult(result: unknown): CapabilityMatch[] {
  const text = mcpTextContent(result).trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const matches = isRecord(parsed) && Array.isArray(parsed.matches) ? parsed.matches : [];
  return matches.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const name = stringField(entry, "name");
    const summary = stringField(entry, "summary");
    if (!name) return [];
    return [{
      name,
      summary,
      ...(typeof entry.schemaDigest === "string" && entry.schemaDigest.trim() ? { schemaDigest: entry.schemaDigest.trim() } : {}),
      ...(entry.argumentsSchema !== undefined ? { argumentsSchema: entry.argumentsSchema } : {}),
    }];
  });
}

export async function listManageableConnections(ctx: FlowContext, options: ListConnectionsOptions): Promise<McpConnection[]> {
  const actor = validateActor(options.actor);
  const token = await sessionToken(ctx, actor, options.token);
  const listed = await denApiFetch(ctx, "/v1/mcp-connections?scope=manageable", {
    headers: authHeaders(token, options.organizationId),
  });
  if (!listed.response.ok) {
    throw new EvalError(`Listing manageable MCP connections failed: ${listed.response.status} ${listed.text.slice(0, 300)}`);
  }
  return connectionsFromBody(listed.body);
}

export async function createNoAuthConnection(ctx: FlowContext, options: CreateNoAuthConnectionOptions): Promise<McpConnection> {
  const actor = validateActor(options.actor);
  const token = await sessionToken(ctx, actor, options.token);
  const access = {
    orgWide: options.access?.orgWide ?? true,
    memberIds: options.access?.memberIds ?? [],
    teamIds: options.access?.teamIds ?? [],
  };
  // Provenance: evals/flows/cloud-web-connect-e2e.flow.mjs:369-377 creates
  // no-auth MCP connections through POST /v1/mcp-connections and grants
  // org-wide access explicitly.
  const created = await denApiFetch(ctx, "/v1/mcp-connections", {
    method: "POST",
    headers: authHeaders(token, options.organizationId),
    body: JSON.stringify({
      name: options.name,
      url: options.url,
      authType: "none",
      access,
    }),
  });
  if (!created.response.ok) {
    throw new EvalError(`Creating no-auth MCP connection failed: ${created.response.status} ${created.text.slice(0, 500)}`);
  }
  const connection = mcpConnection(created.body);
  if (!connection) throw new EvalError(`MCP connection create response did not include a connection: ${responseBodySnippet(created.body)}`);
  return connection;
}

export async function createOAuthConnection(ctx: FlowContext, options: CreateOAuthConnectionOptions): Promise<McpConnection> {
  const actor = validateActor(options.actor);
  const token = await sessionToken(ctx, actor, options.token);
  const access = {
    orgWide: options.access?.orgWide ?? true,
    memberIds: options.access?.memberIds ?? [],
    teamIds: options.access?.teamIds ?? [],
  };
  const created = await denApiFetch(ctx, "/v1/mcp-connections", {
    method: "POST",
    headers: authHeaders(token, options.organizationId),
    body: JSON.stringify({
      name: options.name,
      url: options.url,
      authType: "oauth",
      credentialMode: options.credentialMode ?? "shared",
      requestedScopes: options.requestedScopes ?? [],
      access,
    }),
  });
  if (!created.response.ok) {
    throw new EvalError(`Creating OAuth MCP connection failed: ${created.response.status} ${created.text.slice(0, 500)}`);
  }
  const connection = mcpConnection(created.body);
  if (!connection) throw new EvalError(`OAuth MCP connection create response did not include a connection: ${responseBodySnippet(created.body)}`);
  return connection;
}

export async function disconnectConnection(ctx: FlowContext, options: ConnectionByIdOptions): Promise<void> {
  const actor = validateActor(options.actor);
  const token = await sessionToken(ctx, actor, options.token);
  const disconnected = await denApiFetch(ctx, `/v1/mcp-connections/${encodeURIComponent(options.connectionId)}/disconnect`, {
    method: "POST",
    headers: authHeaders(token, options.organizationId),
  });
  if (!disconnected.response.ok) {
    throw new EvalError(`Disconnecting MCP connection ${options.connectionId} failed: ${disconnected.response.status} ${disconnected.text.slice(0, 300)}`);
  }
}

export async function reconnectNoAuthConnection(ctx: FlowContext, options: ReconnectNoAuthConnectionOptions): Promise<McpConnection> {
  const actor = validateActor(options.actor);
  const token = await sessionToken(ctx, actor, options.token);
  const connections = await listManageableConnections(ctx, { ...options, token });
  const connection = connections.find((entry) => entry.id === options.connectionId);
  if (!connection) throw new EvalError(`MCP connection ${options.connectionId} was not found before reconnect.`);
  if (connection.authType !== "none") throw new EvalError(`MCP connection ${options.connectionId} is ${connection.authType}, not no-auth.`);
  if (!connection.updatedAt) throw new EvalError(`MCP connection ${options.connectionId} did not include updatedAt for reconnect.`);
  const access = connection.access ?? { orgWide: true, memberIds: [], teamIds: [] };
  const updated = await denApiFetch(ctx, `/v1/mcp-connections/${encodeURIComponent(options.connectionId)}`, {
    method: "PUT",
    headers: authHeaders(token, options.organizationId),
    body: JSON.stringify({
      expectedUpdatedAt: connection.updatedAt,
      name: connection.name,
      url: options.url,
      authType: "none",
      credentialMode: connection.credentialMode,
      access,
    }),
  });
  if (!updated.response.ok) {
    throw new EvalError(`Reconnecting no-auth MCP connection failed: ${updated.response.status} ${updated.text.slice(0, 500)}`);
  }
  const reconnected = mcpConnection(updated.body);
  if (!reconnected) throw new EvalError(`MCP reconnect response did not include a connection: ${responseBodySnippet(updated.body)}`);
  return reconnected;
}

export async function deleteConnection(ctx: FlowContext, options: ConnectionByIdOptions): Promise<void> {
  const actor = validateActor(options.actor);
  const token = await sessionToken(ctx, actor, options.token);
  const removed = await denApiFetch(ctx, `/v1/mcp-connections/${encodeURIComponent(options.connectionId)}`, {
    method: "DELETE",
    headers: authHeaders(token, options.organizationId),
  });
  if (!removed.response.ok) {
    throw new EvalError(`Deleting MCP connection ${options.connectionId} failed: ${removed.response.status} ${removed.text.slice(0, 300)}`);
  }
}

export async function deleteConnectionsByPrefix(ctx: FlowContext, options: ListConnectionsOptions & { prefix: string }): Promise<number> {
  const token = await sessionToken(ctx, validateActor(options.actor), options.token);
  const connections = await listManageableConnections(ctx, { ...options, token });
  let removed = 0;
  for (const connection of connections) {
    if (!connection.name.startsWith(options.prefix)) continue;
    await deleteConnection(ctx, { ...options, token, connectionId: connection.id });
    removed += 1;
  }
  return removed;
}

export async function waitForConnectionConnected(ctx: FlowContext, options: ListConnectionsOptions & { connectionId: string; timeoutMs?: number }): Promise<McpConnection> {
  const token = await sessionToken(ctx, validateActor(options.actor), options.token);
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? 60_000;
  let last: McpConnection | null = null;
  while (Date.now() - startedAt < timeoutMs) {
    const connections = await listManageableConnections(ctx, { ...options, token });
    last = connections.find((connection) => connection.id === options.connectionId) ?? null;
    if (last?.connected && last.connectedForMe && last.needsReconnect !== true) return last;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new EvalError(`MCP connection ${options.connectionId} did not become connected within ${timeoutMs}ms. Last state: ${responseBodySnippet(last)}`);
}

export async function listConnectionTools(ctx: FlowContext, options: ConnectionByIdOptions): Promise<unknown[]> {
  const actor = validateActor(options.actor);
  const token = await sessionToken(ctx, actor, options.token);
  const tools = await denApiFetch(ctx, `/v1/mcp-connections/${encodeURIComponent(options.connectionId)}/tools`, {
    headers: authHeaders(token, options.organizationId),
  });
  if (!tools.response.ok) {
    throw new EvalError(`Listing MCP tools failed: ${tools.response.status} ${tools.text.slice(0, 500)}`);
  }
  return isRecord(tools.body) && Array.isArray(tools.body.tools) ? tools.body.tools : [];
}

export async function runConnectionTool(ctx: FlowContext, options: RunConnectionToolOptions): Promise<unknown> {
  const actor = validateActor(options.actor);
  const token = await sessionToken(ctx, actor, options.token);
  const executed = await denApiFetch(ctx, `/v1/mcp-connections/${encodeURIComponent(options.connectionId)}/tools/call`, {
    method: "POST",
    headers: authHeaders(token, options.organizationId),
    body: JSON.stringify({ toolName: options.toolName, arguments: options.arguments }),
  });
  if (!executed.response.ok) {
    throw new EvalError(`Running MCP tool ${options.toolName} failed: ${executed.response.status} ${executed.text.slice(0, 500)}`);
  }
  return isRecord(executed.body) ? executed.body.result : executed.body;
}

export async function expectUsableConnection(ctx: FlowContext, options: ExpectUsableConnectionOptions): Promise<unknown> {
  const toolName = options.toolName ?? "mock_echo";
  try {
    const result = await runConnectionTool(ctx, {
      ...options,
      toolName,
      arguments: options.arguments ?? { text: options.expectedText ?? "mcp usable" },
    });
    if (options.expectedText) {
      const text = mcpTextContent(result);
      if (!text.includes(options.expectedText)) {
        throw new EvalError(`live tool call returned ${JSON.stringify(text)}, expected ${JSON.stringify(options.expectedText)}`);
      }
    }
    return result;
  } catch (error) {
    if (options.uiConnected) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new EvalError(`UI reports connected but a live tool call failed for ${options.connectionName}: ${detail}`);
    }
    throw error;
  }
}

export async function mintMcpToken(ctx: FlowContext, options: MintMcpTokenOptions): Promise<string> {
  const actor = validateActor(options.actor);
  const token = await sessionToken(ctx, actor, options.token);
  // Provenance: evals/flows/lib/den-web.mjs:147-156 mints the agent-facing
  // token through POST /v1/mcp/token before calling /mcp/agent.
  const minted = await denApiFetch(ctx, "/v1/mcp/token", {
    method: "POST",
    headers: authHeaders(token, options.organizationId),
    body: JSON.stringify(options.scopes ? { scopes: options.scopes } : {}),
  });
  if (!minted.response.ok || !isRecord(minted.body) || typeof minted.body.token !== "string" || !minted.body.token.trim()) {
    throw new EvalError(`Minting MCP token failed: ${minted.response.status} ${minted.text.slice(0, 300)}`);
  }
  return minted.body.token;
}

export async function mcpAgentCall(ctx: FlowContext, options: McpAgentCallOptions): Promise<unknown> {
  const apiUrl = ctx.env.OPENWORK_EVAL_DEN_API_URL?.trim().replace(/\/+$/, "");
  if (!apiUrl) throw new EvalError("OPENWORK_EVAL_DEN_API_URL is required for MCP agent calls.");
  // Provenance: evals/flows/lib/den-web.mjs:158-174 calls /mcp/agent and
  // reads the first Server-Sent Events data frame as the JSON-RPC result.
  const response = await fetch(`${apiUrl}/mcp/agent`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${options.mcpToken}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: options.method, params: options.params ?? {} }),
  });
  const raw = await response.text();
  if (!response.ok) throw new EvalError(`MCP ${options.method} failed: ${response.status} ${raw.slice(0, 300)}`);
  const dataLine = raw.split("\n").find((line) => line.startsWith("data:"));
  if (!dataLine) throw new EvalError(`MCP ${options.method} returned no data frame: ${raw.slice(0, 300)}`);
  const payload: unknown = JSON.parse(dataLine.slice(5));
  if (!isRecord(payload)) throw new EvalError(`MCP ${options.method} returned a non-object JSON-RPC payload.`);
  if (payload.error) throw new EvalError(`MCP ${options.method} returned JSON-RPC error: ${responseBodySnippet(payload.error)}`);
  return payload.result;
}

export async function searchCapabilities(ctx: FlowContext, options: SearchCapabilitiesOptions): Promise<CapabilityMatch[]> {
  const mcpToken = options.mcpToken ?? await mintMcpToken(ctx, options);
  const args: Record<string, unknown> = { query: options.query };
  if (options.limit !== undefined) args.limit = options.limit;
  if (options.type) args.type = options.type;
  const result = await mcpAgentCall(ctx, {
    mcpToken,
    method: "tools/call",
    params: { name: "search_capabilities", arguments: args },
  });
  return capabilityMatchesFromSearchResult(result);
}

export async function executeCapability(ctx: FlowContext, options: ExecuteCapabilityOptions): Promise<unknown> {
  const mcpToken = options.mcpToken ?? await mintMcpToken(ctx, options);
  const args: Record<string, unknown> = {
    name: options.name,
    body: options.body ?? {},
  };
  if (options.schemaDigest) args.schemaDigest = options.schemaDigest;
  return mcpAgentCall(ctx, {
    mcpToken,
    method: "tools/call",
    params: { name: "execute_capability", arguments: args },
  });
}

export async function openMcpConnections(ctx: FlowContext, options: OpenMcpConnectionsOptions): Promise<void> {
  await ctx.on(options.surface, async () => {
    await ctx.waitFor(
      `(() => {
        if (window.location.pathname.includes('mcp-connections')) return true;
        const link = [...document.querySelectorAll('nav a')].find((a) => a.getAttribute('href')?.includes('mcp-connections'));
        if (link) {
          link.click();
          return false;
        }
        const group = [...document.querySelectorAll('nav a, nav button')].find((el) => (el.textContent ?? '').trim().startsWith('Extensions'));
        group?.click();
        return false;
      })()`,
      { timeoutMs: 30_000, label: "MCP Connections nav link clicked" },
    );
    await ctx.waitFor("window.location.pathname.includes('mcp-connections')", {
      timeoutMs: 20_000,
      label: "MCP Connections route",
    });
    await ctx.waitFor(MCP_CONNECTIONS_SCREEN_READY, {
      timeoutMs: 30_000,
      label: "MCP Connections screen",
    });
  });
}

export function connectionUrl(ctx: FlowContext, path = "/dashboard/mcp-connections"): string {
  return new URL(path, `${denWebUrl(ctx)}/`).toString();
}
