import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { cookies } from "next/headers";
import { NextRequest } from "next/server";
import {
  LAB_CONNECTION_COOKIE,
  type LabCapabilities,
  type LabConnectionStateResponse,
  type LabStatusSnapshot,
  type LabStoredConnection,
  type LabWorkspaceSummary,
  normalizeOpenworkServerUrl,
  parseOpenworkWorkspaceIdFromUrl,
  stripWorkspaceMount,
} from "./openwork-lab-shared";

type OpenworkRequestOptions = {
  method?: string;
  token?: string;
  hostToken?: string;
  body?: BodyInit | null;
  contentType?: string | null;
};

type OpenworkResponse = {
  status: number;
  headers: Headers;
  body: Buffer;
};

function sanitizeConnection(connection: LabStoredConnection) {
  return {
    baseUrl: connection.baseUrl,
    workspaceId: connection.workspaceId,
    token: connection.token,
    hostToken: connection.hostToken,
    hasToken: Boolean(connection.token),
    hasHostToken: Boolean(connection.hostToken),
  };
}

function selectWorkspace(
  workspaces: LabWorkspaceSummary[],
  status: LabStatusSnapshot | null,
  preferredWorkspaceId?: string | null,
) {
  const explicit = (preferredWorkspaceId ?? "").trim();
  if (explicit) {
    const match = workspaces.find((workspace) => workspace.id === explicit);
    if (match) return match;
  }

  const statusWorkspaceId = status?.workspace?.id?.trim();
  if (statusWorkspaceId) {
    const match = workspaces.find((workspace) => workspace.id === statusWorkspaceId);
    if (match) return match;
  }

  const selectedWorkspaceId = status?.selectedWorkspaceId?.trim() || status?.activeWorkspaceId?.trim();
  if (selectedWorkspaceId) {
    const match = workspaces.find((workspace) => workspace.id === selectedWorkspaceId);
    if (match) return match;
  }

  return workspaces[0] ?? null;
}

function getRoutePath(request: NextRequest, routePrefix: string) {
  const incoming = new URL(request.url);
  if (incoming.pathname === routePrefix) return "";
  const normalizedPrefix = `${routePrefix.replace(/\/+$/, "")}/`;
  if (!incoming.pathname.startsWith(normalizedPrefix)) return "";
  return incoming.pathname.slice(normalizedPrefix.length);
}

function buildUpstreamUrl(baseUrl: string, request: NextRequest, targetPath: string) {
  const upstream = new URL(targetPath ? `${baseUrl.replace(/\/+$/, "")}/${targetPath}` : baseUrl);
  upstream.search = new URL(request.url).search;
  return upstream.toString();
}

function buildHeaders(options: { token?: string; hostToken?: string; contentType?: string | null; requestHeaders?: Headers }) {
  const headers = new Headers();
  const copyKeys = ["accept", "user-agent", "x-requested-with", "origin"];
  for (const key of copyKeys) {
    const value = options.requestHeaders?.get(key);
    if (value) headers.set(key, value);
  }
  if (options.contentType) headers.set("content-type", options.contentType);
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.hostToken) headers.set("x-openwork-host-token", options.hostToken);
  return headers;
}

async function requestOpenworkRaw(urlString: string, options: OpenworkRequestOptions = {}): Promise<OpenworkResponse> {
  const target = new URL(urlString);
  const transport = target.protocol === "https:" ? httpsRequest : httpRequest;
  const headers = buildHeaders({
    token: options.token,
    hostToken: options.hostToken,
    contentType: options.contentType ?? (options.body ? "application/json" : null),
  });

  return await new Promise<OpenworkResponse>((resolve, reject) => {
    const req = transport(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        method: options.method ?? "GET",
        path: `${target.pathname}${target.search}`,
        headers: Object.fromEntries(headers.entries()),
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) {
              for (const item of value) {
                if (item) responseHeaders.append(key, item);
              }
            } else if (typeof value === "string") {
              responseHeaders.set(key, value);
            }
          }

          resolve({
            status: response.statusCode ?? 500,
            headers: responseHeaders,
            body: Buffer.concat(chunks),
          });
        });
      },
    );

    req.on("error", reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  return text ? (JSON.parse(text) as T) : ({} as T);
}

export async function readStoredConnection() {
  const store = await cookies();
  const value = store.get(LAB_CONNECTION_COOKIE)?.value;
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as LabStoredConnection;
    if (!parsed?.baseUrl || !parsed?.workspaceId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeStoredConnection(connection: LabStoredConnection) {
  const store = await cookies();
  store.set(LAB_CONNECTION_COOKIE, JSON.stringify(connection), {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

export async function clearStoredConnection() {
  const store = await cookies();
  store.delete(LAB_CONNECTION_COOKIE);
}

export async function requestOpenwork<T>(
  baseUrl: string,
  path: string,
  options: OpenworkRequestOptions = {},
) {
  const response = await requestOpenworkRaw(`${baseUrl.replace(/\/+$/, "")}${path}`, options);
  const text = response.body.toString("utf8");

  if (response.status < 200 || response.status >= 300) {
    throw new Error(text || `OpenWork request failed (${response.status})`);
  }

  return text ? (JSON.parse(text) as T) : ({} as T);
}

export async function resolveConnectionState(
  connection: LabStoredConnection | null,
): Promise<LabConnectionStateResponse> {
  if (!connection) {
    return { connected: false, saved: false, error: null };
  }

  try {
    const [status, capabilities, workspacesPayload] = await Promise.all([
      requestOpenwork<LabStatusSnapshot>(connection.baseUrl, "/status", {
        token: connection.token,
        hostToken: connection.hostToken,
      }),
      requestOpenwork<LabCapabilities>(connection.baseUrl, "/capabilities", {
        token: connection.token,
        hostToken: connection.hostToken,
      }),
      requestOpenwork<{ items?: LabWorkspaceSummary[]; workspaces?: LabWorkspaceSummary[] }>(connection.baseUrl, "/workspaces", {
        token: connection.token,
        hostToken: connection.hostToken,
      }),
    ]);

    const workspaces = workspacesPayload.items ?? workspacesPayload.workspaces ?? [];
    const selectedWorkspace = selectWorkspace(workspaces, status, connection.workspaceId);

    return {
      connected: true,
      saved: true,
      connection: sanitizeConnection({
        ...connection,
        workspaceId: selectedWorkspace?.id ?? connection.workspaceId,
      }),
      status,
      capabilities,
      workspaces,
      selectedWorkspace,
      error: null,
    };
  } catch (error) {
    return {
      connected: false,
      saved: true,
      connection: sanitizeConnection(connection),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function validateAndStoreConnection(input: {
  baseUrl?: string;
  token?: string;
  hostToken?: string;
  workspaceId?: string;
}) {
  const normalized = normalizeOpenworkServerUrl(input.baseUrl ?? "");
  if (!normalized) {
    throw new Error("OpenWork server URL is required.");
  }

  const workspaceIdFromUrl = parseOpenworkWorkspaceIdFromUrl(normalized);
  const baseUrl = stripWorkspaceMount(normalized) ?? normalized;

  const status = await requestOpenwork<LabStatusSnapshot>(baseUrl, "/status", {
    token: input.token?.trim() || undefined,
    hostToken: input.hostToken?.trim() || undefined,
  });
  const capabilities = await requestOpenwork<LabCapabilities>(baseUrl, "/capabilities", {
    token: input.token?.trim() || undefined,
    hostToken: input.hostToken?.trim() || undefined,
  });
  const workspacesPayload = await requestOpenwork<{ items?: LabWorkspaceSummary[]; workspaces?: LabWorkspaceSummary[] }>(
    baseUrl,
    "/workspaces",
    {
      token: input.token?.trim() || undefined,
      hostToken: input.hostToken?.trim() || undefined,
    },
  );

  const workspaces = workspacesPayload.items ?? workspacesPayload.workspaces ?? [];
  const selectedWorkspace = selectWorkspace(
    workspaces,
    status,
    input.workspaceId?.trim() || workspaceIdFromUrl,
  );

  if (!selectedWorkspace?.id) {
    throw new Error("No workspace could be resolved from this OpenWork server.");
  }

  const stored: LabStoredConnection = {
    baseUrl,
    token: input.token?.trim() || undefined,
    hostToken: input.hostToken?.trim() || undefined,
    workspaceId: selectedWorkspace.id,
    connectedAt: Date.now(),
  };

  await writeStoredConnection(stored);

  return {
    connected: true,
    saved: true,
    connection: sanitizeConnection(stored),
    status,
    capabilities,
    workspaces,
    selectedWorkspace,
    error: null,
  } satisfies LabConnectionStateResponse;
}

export async function proxyOpenworkRequest(request: NextRequest, routePrefix: string) {
  const connection = await readStoredConnection();
  if (!connection) {
    return Response.json({ error: "Not connected to OpenWork." }, { status: 401 });
  }

  const targetPath = getRoutePath(request, routePrefix);
  const upstreamUrl = buildUpstreamUrl(connection.baseUrl, request, targetPath);
  const contentType = request.headers.get("content-type");
  const body = request.method === "GET" || request.method === "HEAD"
    ? undefined
    : Buffer.from(await request.arrayBuffer());

  const upstream = await requestOpenworkRaw(upstreamUrl, {
    method: request.method,
    token: connection.token,
    hostToken: connection.hostToken,
    contentType,
    body,
  });

  const headers = new Headers();
  const passThroughHeaders = ["content-type", "cache-control", "content-disposition"];
  for (const key of passThroughHeaders) {
    const value = upstream.headers.get(key);
    if (value) headers.set(key, value);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}
