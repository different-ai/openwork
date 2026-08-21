import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  CONNECT_MCP_APP_HOST_CAPABILITY,
  CONNECT_MCP_APP_HOST_CAPABILITY_HEADER,
  connectMcpAppHostName,
  findOpenWorkConnectMcpAppHostServer,
  readOpenWorkConnectMcpAppHostAuthorization,
  refreshOpenWorkConnectMcpAppHostCatalog,
} from "./connect-mcp-server-catalog.js";
import type { ServerConfig } from "./types.js";
import {
  assertLocalManagedMcpUrl,
  createLocalManagedMcpGuardedFetch,
  LocalManagedMcpPrivateUrlError,
} from "./local-managed-mcp-url-guard.js";
import { diagnoseMcpToolDenies, listMcp } from "./mcp.js";

const MCP_APP_EXTENSION = "io.modelcontextprotocol/ui";
const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
const MCP_PROTOCOL_VERSION = "2025-06-18";
const MAX_TOOL_PAGES = 32;
const MAX_TOOLS = 2_048;
const MAX_RESOURCE_BYTES = 768 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;

type McpAppCsp = {
  connectDomains: string[];
  resourceDomains: string[];
  frameDomains: string[];
  baseUriDomains: string[];
};

export type McpAppResource = {
  serverName: string;
  toolName: string;
  resourceUri: string;
  html: string;
  csp: McpAppCsp;
  prefersBorder: boolean;
};

export type ConnectMcpAppLaunchReference = {
  connectionId: string;
  toolName: string;
  resourceUri: string;
};

export type SameServerMcpAppLaunchReference = {
  toolName: string;
  resourceUri: string;
};

export class McpAppHostError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "McpAppHostError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringHeaders(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

export function projectedMcpToolName(serverName: string, toolName: string): string {
  const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${sanitize(serverName)}_${sanitize(toolName)}`;
}

export function toolUiResourceUri(tool: Partial<Tool>): string | null {
  const meta = isRecord(tool._meta) ? tool._meta : {};
  const ui = isRecord(meta.ui) ? meta.ui : {};
  const nested = typeof ui.resourceUri === "string" ? ui.resourceUri : null;
  const legacy = typeof meta["ui/resourceUri"] === "string" ? meta["ui/resourceUri"] : null;
  const uri = nested ?? legacy;
  if (!uri) return null;
  if (!uri.startsWith("ui://")) throw new McpAppHostError("invalid_resource_uri", "MCP App resource URI must use ui://.");
  return uri;
}

function safeDomain(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    if (url.protocol === "https:") return url.origin;
    if (url.protocol === "http:" && isLoopbackHostname(url.hostname)) return url.origin;
  } catch {
    return null;
  }
  return null;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

function domainList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 16) {
    if (value === undefined) return [];
    throw new McpAppHostError("invalid_resource_csp", "MCP App CSP domain lists must contain at most 16 origins.");
  }
  const domains = value.map(safeDomain);
  if (domains.some((domain) => domain === null)) {
    throw new McpAppHostError("invalid_resource_csp", "MCP App CSP domains must be HTTPS origins (or loopback HTTP origins).");
  }
  return Array.from(new Set(domains as string[]));
}

function resourcePresentationMeta(value: unknown): { csp: McpAppCsp; prefersBorder: boolean } {
  const meta = isRecord(value) ? value : {};
  const ui = isRecord(meta.ui) ? meta.ui : {};
  const csp = isRecord(ui.csp) ? ui.csp : {};
  const permissions = isRecord(ui.permissions) ? ui.permissions : {};
  if (Object.keys(permissions).length > 0 || ui.domain !== undefined) {
    throw new McpAppHostError(
      "unsupported_resource_permissions",
      "This OpenWork host slice does not grant device permissions or dedicated sandbox origins.",
    );
  }
  return {
    csp: {
      connectDomains: domainList(csp.connectDomains),
      resourceDomains: domainList(csp.resourceDomains),
      frameDomains: domainList(csp.frameDomains),
      baseUriDomains: domainList(csp.baseUriDomains),
    },
    prefersBorder: ui.prefersBorder !== false,
  };
}

function remoteUrl(config: Record<string, unknown>): URL | null {
  if (config.enabled === false || typeof config.url !== "string") return null;
  try {
    const url = new URL(config.url);
    if (url.username || url.password) return null;
    return url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHostname(url.hostname)) ? url : null;
  } catch {
    return null;
  }
}

function clientOptions() {
  return {
    capabilities: {
      extensions: {
        [MCP_APP_EXTENSION]: { mimeTypes: [MCP_APP_MIME_TYPE] },
      },
    },
  };
}

async function withRemoteClient<T>(
  config: Record<string, unknown>,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const url = remoteUrl(config);
  if (!url) throw new McpAppHostError("unsupported_transport", "MCP Apps currently require a configured remote HTTP MCP server.");
  try {
    await assertLocalManagedMcpUrl(url.toString());
  } catch (error) {
    if (error instanceof LocalManagedMcpPrivateUrlError) {
      throw new McpAppHostError("unsafe_server_url", error.message);
    }
    throw error;
  }
  const guardedFetch = createLocalManagedMcpGuardedFetch();
  const requestInit = {
    headers: stringHeaders(config.headers),
  };
  const attempts = [
    () => new StreamableHTTPClientTransport(url, { requestInit, fetch: guardedFetch }),
    () => new SSEClientTransport(url, { requestInit, fetch: guardedFetch }),
  ];
  let lastError: unknown;
  for (const createTransport of attempts) {
    const client = new Client({ name: "openwork-mcp-app-host", version: "1.0.0" }, clientOptions());
    let connected = false;
    try {
      await client.connect(createTransport());
      connected = true;
      return await run(client);
    } catch (error) {
      if (connected) throw error;
      lastError = error;
    } finally {
      await client.close().catch(() => undefined);
    }
  }
  throw new McpAppHostError(
    "mcp_unreachable",
    lastError instanceof Error ? lastError.message : "The MCP server could not be reached.",
  );
}

async function listTools(client: Client): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
    const listed = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...listed.tools);
    if (tools.length > MAX_TOOLS) {
      throw new McpAppHostError("tool_catalog_too_large", "The MCP tool catalog exceeds the host limit.");
    }
    if (!listed.nextCursor) return tools;
    cursor = listed.nextCursor;
  }
  throw new McpAppHostError("tool_catalog_too_large", "MCP tool pagination exceeded the host limit.");
}

function toolVisibility(tool: Partial<Tool>, audience: "model" | "app"): boolean {
  const meta = isRecord(tool._meta) ? tool._meta : {};
  const ui = isRecord(meta.ui) ? meta.ui : {};
  if (ui.visibility === undefined) return true;
  return Array.isArray(ui.visibility)
    && ui.visibility.every((entry) => entry === "model" || entry === "app")
    && ui.visibility.includes(audience);
}

function strictBase64Bytes(value: string): Uint8Array {
  if (value.length > Math.ceil(MAX_RESOURCE_BYTES / 3) * 4) {
    throw new McpAppHostError("resource_too_large", "The MCP App resource exceeds the 768 KiB host limit.");
  }
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new McpAppHostError("invalid_resource", "The MCP App resource blob is not valid base64.");
  }
  return Buffer.from(value, "base64");
}

function decodeResourceHtml(content: { text?: string; blob?: string }): { html: string; bytes: number } {
  if (typeof content.text === "string" && content.blob === undefined) {
    const bytes = new TextEncoder().encode(content.text).byteLength;
    return { html: content.text, bytes };
  }
  if (typeof content.blob === "string" && content.text === undefined) {
    const bytes = strictBase64Bytes(content.blob);
    try {
      return { html: new TextDecoder("utf-8", { fatal: true }).decode(bytes), bytes: bytes.byteLength };
    } catch {
      throw new McpAppHostError("invalid_resource", "The MCP App resource blob is not valid UTF-8 HTML.");
    }
  }
  throw new McpAppHostError("invalid_resource", "The MCP App resource must contain exactly one of text or blob HTML.");
}

async function privateConnectMcpConfig(input: {
  serverConfig: ServerConfig;
  workspaceId: string;
  connectionId?: string;
  serverName?: string;
}): Promise<{ serverName: string; config: Record<string, unknown> } | null> {
  let descriptor = await findOpenWorkConnectMcpAppHostServer(
    input.serverConfig,
    input.workspaceId,
    { connectionId: input.connectionId, serverName: input.serverName },
  );
  if (!descriptor) {
    const refreshed = await refreshOpenWorkConnectMcpAppHostCatalog(input.serverConfig, input.workspaceId);
    if (refreshed.status === "synced") {
      descriptor = await findOpenWorkConnectMcpAppHostServer(
        input.serverConfig,
        input.workspaceId,
        { connectionId: input.connectionId, serverName: input.serverName },
      );
    }
  }
  if (!descriptor) return null;
  const appHostAuthorization = await readOpenWorkConnectMcpAppHostAuthorization(
    input.serverConfig,
    input.workspaceId,
    descriptor.url,
  );
  if (!appHostAuthorization) return null;
  return {
    serverName: connectMcpAppHostName(descriptor.connectionId),
    config: {
      type: "remote",
      url: descriptor.url,
      enabled: true,
      headers: {
        Authorization: appHostAuthorization,
        [CONNECT_MCP_APP_HOST_CAPABILITY_HEADER]: CONNECT_MCP_APP_HOST_CAPABILITY,
      },
    },
  };
}

function findHtmlResource(
  resourceUri: string,
  result: Awaited<ReturnType<Client["readResource"]>>,
): { html: string; meta: unknown } {
  const candidates = result.contents.filter((content) => content.uri === resourceUri);
  if (candidates.length !== 1) {
    throw new McpAppHostError("invalid_resource", "The MCP App resource must return exactly one matching HTML resource.");
  }
  const content = candidates[0];
  if (!content) throw new McpAppHostError("invalid_resource", "The MCP App resource did not return HTML content.");
  if (content.mimeType?.toLowerCase() !== MCP_APP_MIME_TYPE) {
    throw new McpAppHostError("invalid_resource_mime", `MCP App resources must use ${MCP_APP_MIME_TYPE}.`);
  }
  const decoded = decodeResourceHtml(content);
  if (decoded.bytes > MAX_RESOURCE_BYTES) {
    throw new McpAppHostError("resource_too_large", "The MCP App resource exceeds the 768 KiB host limit.");
  }
  return { html: decoded.html, meta: content._meta };
}

export async function resolveMcpAppResource(input: {
  serverConfig: ServerConfig;
  workspaceId: string;
  workspaceRoot: string;
  projectedToolName: string;
}): Promise<McpAppResource | null> {
  if (!/^[a-zA-Z0-9_-]{1,256}$/.test(input.projectedToolName)) {
    throw new McpAppHostError("invalid_tool_name", "Projected MCP tool name is invalid.");
  }
  const configured = await listMcp(input.serverConfig, input.workspaceId, input.workspaceRoot);
  const candidates = configured.filter((item) => (
    item.config.enabled !== false
    && input.projectedToolName.startsWith(`${item.name.replace(/[^a-zA-Z0-9_-]/g, "_")}_`)
  ));
  const matches: McpAppResource[] = [];
  const resolutionErrors: McpAppHostError[] = [];
  for (const item of candidates) {
    if (!remoteUrl(item.config)) continue;
    const match = await withRemoteClient(item.config, async (client) => {
      const tool = (await listTools(client)).find((candidate) => (
        projectedMcpToolName(item.name, candidate.name) === input.projectedToolName
      ));
      if (!tool) return null;
      if (!toolVisibility(tool, "model")) return null;
      const resourceUri = toolUiResourceUri(tool);
      if (!resourceUri) return null;
      if ((await diagnoseMcpToolDenies(input.workspaceRoot, item.name, [input.projectedToolName])).length > 0) {
        throw new McpAppHostError("tool_denied", "This MCP App tool is denied by the workspace tool policy.");
      }
      const read = await client.readResource({ uri: resourceUri }).catch(() => {
        throw new McpAppHostError(
          "resource_read_failed",
          "The current MCP App tool definition advertises a resource that resources/read could not load.",
        );
      });
      const resource = findHtmlResource(resourceUri, read);
      const presentation = resourcePresentationMeta(resource.meta);
      return {
        serverName: item.name,
        toolName: tool.name,
        resourceUri,
        html: resource.html,
        ...presentation,
      } satisfies McpAppResource;
    }).catch((error) => {
      if (error instanceof McpAppHostError && error.code !== "mcp_unreachable") throw error;
      resolutionErrors.push(error instanceof McpAppHostError
        ? error
        : new McpAppHostError("mcp_app_resolution_failed", "The MCP App resource could not be resolved."));
      return null;
    });
    if (match) matches.push(match);
  }
  if (matches.length > 1) {
    throw new McpAppHostError("ambiguous_tool", "More than one configured MCP App matches this projected tool name.");
  }
  if (matches.length === 0 && resolutionErrors[0]) throw resolutionErrors[0];
  return matches[0] ?? null;
}

/**
 * Resolves a capability-gateway launch back to the exact native Connect MCP
 * tool. The gateway reference is only a routing hint: the local host derives
 * the managed server name, re-lists the provider tool, and requires its live
 * UI binding to match before reading or executing any resource.
 */
export async function resolveConnectMcpAppResource(input: {
  serverConfig: ServerConfig;
  workspaceId: string;
  workspaceRoot: string;
  launch: ConnectMcpAppLaunchReference;
}): Promise<McpAppResource> {
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(input.launch.connectionId)) {
    throw new McpAppHostError("invalid_launch_reference", "The MCP App connection reference is invalid.");
  }
  if (!/^[^\s]{1,256}$/.test(input.launch.toolName)) {
    throw new McpAppHostError("invalid_launch_reference", "The MCP App tool reference is invalid.");
  }
  if (!input.launch.resourceUri.startsWith("ui://") || input.launch.resourceUri.length > 2_048) {
    throw new McpAppHostError("invalid_resource_uri", "MCP App resource URI must use ui://.");
  }

  const item = await privateConnectMcpConfig({
    serverConfig: input.serverConfig,
    workspaceId: input.workspaceId,
    connectionId: input.launch.connectionId,
  });
  if (!item || !remoteUrl(item.config)) {
    throw new McpAppHostError("server_unavailable", "The originating Connect MCP server is not available to this workspace.");
  }
  const { serverName } = item;

  return await withRemoteClient(item.config, async (client) => {
    const tool = (await listTools(client)).find((candidate) => candidate.name === input.launch.toolName);
    if (!tool) {
      throw new McpAppHostError("tool_not_found", "The originating MCP App tool is no longer advertised.");
    }
    if (!toolVisibility(tool, "app")) {
      throw new McpAppHostError("tool_not_visible", "The originating MCP App tool is not visible to apps.");
    }
    const resourceUri = toolUiResourceUri(tool);
    if (resourceUri !== input.launch.resourceUri) {
      throw new McpAppHostError("tool_resource_mismatch", "The originating MCP App tool now advertises a different resource.");
    }
    const projectedName = projectedMcpToolName(serverName, tool.name);
    if ((await diagnoseMcpToolDenies(input.workspaceRoot, serverName, [projectedName])).length > 0) {
      throw new McpAppHostError("tool_denied", "This MCP App tool is denied by the workspace tool policy.");
    }
    const read = await client.readResource({ uri: resourceUri }).catch(() => {
      throw new McpAppHostError(
        "resource_read_failed",
        "The current MCP App tool definition advertises a resource that resources/read could not load.",
      );
    });
    const resource = findHtmlResource(resourceUri, read);
    const presentation = resourcePresentationMeta(resource.meta);
    return {
      serverName,
      toolName: tool.name,
      resourceUri,
      html: resource.html,
      ...presentation,
    };
  });
}

/** Resolve an indirect launch against the same MCP server that owns the
 * model-visible capability gateway tool. The target launch tool stays
 * app-visible, but its standard UI binding and resource are revalidated live.
 */
export async function resolveSameServerMcpAppResource(input: {
  serverConfig: ServerConfig;
  workspaceId: string;
  workspaceRoot: string;
  projectedToolName: string;
  launch: SameServerMcpAppLaunchReference;
}): Promise<McpAppResource> {
  if (!/^[a-zA-Z0-9_-]{1,256}$/.test(input.projectedToolName)) {
    throw new McpAppHostError("invalid_tool_name", "Projected MCP tool name is invalid.");
  }
  if (!/^[^\s]{1,256}$/.test(input.launch.toolName)) {
    throw new McpAppHostError("invalid_launch_reference", "The MCP App tool reference is invalid.");
  }
  if (!input.launch.resourceUri.startsWith("ui://") || input.launch.resourceUri.length > 2_048) {
    throw new McpAppHostError("invalid_resource_uri", "MCP App resource URI must use ui://.");
  }

  const configured = await listMcp(input.serverConfig, input.workspaceId, input.workspaceRoot);
  const candidates = configured.filter((item) => (
    item.config.enabled !== false
    && remoteUrl(item.config)
    && input.projectedToolName.startsWith(`${item.name.replace(/[^a-zA-Z0-9_-]/g, "_")}_`)
  ));
  const matches: McpAppResource[] = [];
  for (const item of candidates) {
    const match = await withRemoteClient(item.config, async (client) => {
      const tools = await listTools(client);
      const gatewayTool = tools.find((tool) => projectedMcpToolName(item.name, tool.name) === input.projectedToolName);
      if (!gatewayTool || !toolVisibility(gatewayTool, "model")) return null;
      const launchTool = tools.find((tool) => tool.name === input.launch.toolName);
      if (!launchTool) throw new McpAppHostError("tool_not_found", "The same-server MCP App tool is no longer advertised.");
      if (!toolVisibility(launchTool, "app")) {
        throw new McpAppHostError("tool_not_visible", "The same-server MCP App tool is not visible to apps.");
      }
      const resourceUri = toolUiResourceUri(launchTool);
      if (resourceUri !== input.launch.resourceUri) {
        throw new McpAppHostError("tool_resource_mismatch", "The same-server MCP App tool now advertises a different resource.");
      }
      const projectedLaunchName = projectedMcpToolName(item.name, launchTool.name);
      if ((await diagnoseMcpToolDenies(input.workspaceRoot, item.name, [projectedLaunchName])).length > 0) {
        throw new McpAppHostError("tool_denied", "This MCP App tool is denied by the workspace tool policy.");
      }
      const read = await client.readResource({ uri: resourceUri }).catch(() => {
        throw new McpAppHostError("resource_read_failed", "The MCP App resource could not be loaded from its same-server provider.");
      });
      const resource = findHtmlResource(resourceUri, read);
      return {
        serverName: item.name,
        toolName: launchTool.name,
        resourceUri,
        html: resource.html,
        ...resourcePresentationMeta(resource.meta),
      } satisfies McpAppResource;
    });
    if (match) matches.push(match);
  }
  if (matches.length > 1) {
    throw new McpAppHostError("ambiguous_tool", "More than one configured MCP server matches this capability gateway launch.");
  }
  if (!matches[0]) throw new McpAppHostError("server_unavailable", "The MCP server that produced this App launch is unavailable.");
  return matches[0];
}

export async function callMcpAppTool(input: {
  serverConfig: ServerConfig;
  workspaceId: string;
  workspaceRoot: string;
  serverName: string;
  name: string;
  resourceUri?: string;
  arguments?: Record<string, unknown>;
  approved?: boolean;
}): Promise<CallToolResult> {
  const privateItem = await privateConnectMcpConfig({
    serverConfig: input.serverConfig,
    workspaceId: input.workspaceId,
    serverName: input.serverName,
  });
  const configured = privateItem ? [] : await listMcp(input.serverConfig, input.workspaceId, input.workspaceRoot);
  const item = privateItem ?? configured.find((candidate) => candidate.name === input.serverName);
  if (!item || item.config.enabled === false) {
    throw new McpAppHostError("server_unavailable", "The originating MCP server is not available to this workspace.");
  }
  return await withRemoteClient(item.config, async (client) => {
    const tool = (await listTools(client)).find((candidate) => candidate.name === input.name);
    if (!tool) throw new McpAppHostError("tool_not_found", "The requested same-server MCP tool was not found.");
    if (!toolVisibility(tool, "app")) {
      throw new McpAppHostError("tool_not_visible", "The requested MCP tool is not visible to apps.");
    }
    const boundResourceUri = toolUiResourceUri(tool);
    if (boundResourceUri && boundResourceUri !== input.resourceUri) {
      throw new McpAppHostError(
        "tool_resource_mismatch",
        "The requested MCP tool is bound to a different MCP App resource.",
      );
    }
    const projectedName = projectedMcpToolName(input.serverName, tool.name);
    if ((await diagnoseMcpToolDenies(input.workspaceRoot, input.serverName, [projectedName])).length > 0) {
      throw new McpAppHostError("tool_denied", "This same-server MCP tool is denied by the workspace tool policy.");
    }
    if ((tool.annotations?.readOnlyHint !== true || tool.annotations?.destructiveHint === true) && !input.approved) {
      throw new McpAppHostError(
        "tool_requires_approval",
        "This MCP App tool requires user approval before OpenWork can call it.",
      );
    }
    const result = await client.callTool({ name: input.name, arguments: input.arguments ?? {} });
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_RESULT_BYTES) {
      throw new McpAppHostError("result_too_large", "The MCP App tool result exceeds the 1 MiB host limit.");
    }
    return result as CallToolResult;
  });
}

export const mcpAppHostProtocol = {
  extension: MCP_APP_EXTENSION,
  mimeType: MCP_APP_MIME_TYPE,
  protocolVersion: MCP_PROTOCOL_VERSION,
};
