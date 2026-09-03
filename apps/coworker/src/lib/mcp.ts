export type CoworkerManagedMcpConnection = {
  name: string;
  serverUrl: string;
  enabled: boolean;
  status: "needs_auth" | "connecting" | "connected" | "reconnect_required";
  lastError: string | null;
  hasCredential: boolean;
  updatedAt: number;
};

export type CoworkerMcpItem = {
  name: string;
  config: Record<string, unknown>;
  source: "config.project" | "config.global" | "config.remote";
  disabledByTools?: boolean;
  managedOAuth?: CoworkerManagedMcpConnection | null;
};

export type CoworkerMcpAppResource = {
  serverName: string;
  toolName: string;
  resourceUri: string;
  html: string;
  csp: {
    connectDomains: string[];
    resourceDomains: string[];
    frameDomains: string[];
    baseUriDomains: string[];
  };
  prefersBorder: boolean;
};

export type CoworkerMcpAppLaunchReference = {
  connectionId?: string;
  toolName: string;
  resourceUri: string;
  arguments: Record<string, unknown>;
};

export type CoworkerMcpAppCatalogApp = {
  serverName: string;
  connectionId?: string;
  toolName: string;
  projectedToolName: string;
  resourceUri: string;
  title: string | null;
  description: string | null;
  requiresInput: boolean;
  requiresApproval: boolean;
};

export type CoworkerMcpAppCatalogServer = {
  serverName: string;
  displayName?: string;
  connectionId?: string;
  reachable: boolean;
  error?: string;
  apps: CoworkerMcpAppCatalogApp[];
};

export type CoworkerMcpServerTool = {
  name: string;
  title: string | null;
  description: string | null;
  resourceUri: string | null;
};

export type PreservedMcpAppResult = {
  content: Array<Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
};

export class CoworkerMcpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "CoworkerMcpError";
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function preservedResult(value: unknown): PreservedMcpAppResult | null {
  if (!isRecord(value) || !Array.isArray(value.content) || !value.content.every(isRecord)) return null;
  return {
    content: value.content,
    ...(isRecord(value.structuredContent) ? { structuredContent: value.structuredContent } : {}),
    ...(typeof value.isError === "boolean" ? { isError: value.isError } : {}),
    ...(isRecord(value._meta) ? { _meta: value._meta } : {}),
  };
}

export function preservedMcpAppResult(input: {
  output: unknown;
  metadata: Record<string, unknown>;
}): PreservedMcpAppResult | null {
  return preservedResult(input.metadata.openworkMcpResult)
    ?? preservedResult(input.metadata.openworkMcpApp)
    ?? preservedResult(input.output);
}

export function gatewayMcpAppLaunch(meta: unknown): CoworkerMcpAppLaunchReference | null {
  if (!isRecord(meta) || !isRecord(meta["openwork/mcpApp"])) return null;
  const launch = meta["openwork/mcpApp"];
  if ((launch.connectionId !== undefined && typeof launch.connectionId !== "string")
    || typeof launch.toolName !== "string"
    || typeof launch.resourceUri !== "string"
    || !isRecord(launch.arguments)) return null;
  return {
    ...(typeof launch.connectionId === "string" ? { connectionId: launch.connectionId } : {}),
    toolName: launch.toolName,
    resourceUri: launch.resourceUri,
    arguments: launch.arguments,
  };
}

export function createCoworkerMcpClient(input: {
  serverUrl: string;
  workspaceId: string;
  token: string;
}) {
  const baseUrl = input.serverUrl.replace(/\/$/, "");
  const workspace = encodeURIComponent(input.workspaceId);

  async function request<T>(path: string, options?: { method?: string; body?: unknown; timeoutMs?: number }): Promise<T> {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), options?.timeoutMs ?? 15_000);
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method: options?.method ?? "GET",
        headers: {
          Authorization: `Bearer ${input.token}`,
          "Content-Type": "application/json",
        },
        body: options?.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
      const text = await response.text();
      const payload: unknown = text ? JSON.parse(text) : null;
      if (!response.ok) {
        const error = isRecord(payload) ? payload : {};
        throw new CoworkerMcpError(
          response.status,
          typeof error.code === "string" ? error.code : "request_failed",
          typeof error.message === "string" ? error.message : response.statusText,
          error.details,
        );
      }
      return payload as T;
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") {
        throw new CoworkerMcpError(408, "request_timeout", "OpenWork did not respond in time.");
      }
      throw cause;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  return {
    listInventory: () => request<{ items: CoworkerMcpItem[] }>(`/workspace/${workspace}/mcp`),
    /** How the coworker's AI service sees each configured server right now, by name. */
    engineStatus: () => request<unknown>(`/workspace/${workspace}/opencode/mcp`)
      .then((value): Record<string, unknown> => (isRecord(value) ? value : {})),
    /** Every tool identifier the AI service offers, including "<server>_<tool>" for each server's tools. */
    toolIds: () => request<unknown>(`/workspace/${workspace}/opencode/experimental/tool/ids`)
      .then((ids) => (Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [])),
    /** What one configured remote server offers, as it describes itself. */
    listServerTools: (serverName: string) => request<unknown>(`/workspace/${workspace}/mcp/${encodeURIComponent(serverName)}/tools`, { timeoutMs: 20_000 })
      .then((payload): CoworkerMcpServerTool[] => {
        const tools = isRecord(payload) && Array.isArray(payload.tools) ? payload.tools : [];
        return tools.flatMap((tool): CoworkerMcpServerTool[] => {
          if (!isRecord(tool) || typeof tool.name !== "string") return [];
          return [{
            name: tool.name,
            title: typeof tool.title === "string" ? tool.title : null,
            description: typeof tool.description === "string" ? tool.description : null,
            resourceUri: typeof tool.resourceUri === "string" ? tool.resourceUri : null,
          }];
        });
      }),
    listApps: () => request<{ servers: CoworkerMcpAppCatalogServer[] }>(
      `/workspace/${workspace}/mcp-apps/list`,
      { timeoutMs: 30_000 },
    ),
    resolveApp: (projectedToolName: string, launch?: CoworkerMcpAppLaunchReference) =>
      request<{ app: CoworkerMcpAppResource | null }>(`/workspace/${workspace}/mcp-apps/resolve`, {
        method: "POST",
        body: { projectedToolName, ...(launch ? { launch } : {}) },
      }),
    callAppTool: (payload: {
      serverName: string;
      name: string;
      resourceUri: string;
      arguments?: Record<string, unknown>;
      approved?: boolean;
    }) => request<PreservedMcpAppResult>(`/workspace/${workspace}/mcp-apps/call`, {
      method: "POST",
      body: payload,
    }),
    sandboxFor: (app: CoworkerMcpAppResource, hostOrigin: string) => {
      const messageOrigin = hostOrigin === "file://" ? "null" : hostOrigin;
      const url = new URL(`${baseUrl}/mcp-apps/sandbox.html`);
      if (url.origin === hostOrigin && url.hostname === "localhost") url.hostname = "127.0.0.1";
      else if (url.origin === hostOrigin && url.hostname === "127.0.0.1") url.hostname = "localhost";
      url.searchParams.set("csp", JSON.stringify(app.csp));
      url.searchParams.set("hostOrigin", messageOrigin);
      return { url: url.toString(), expectedOrigin: url.origin };
    },
  };
}

export type CoworkerMcpClient = ReturnType<typeof createCoworkerMcpClient>;
