/**
 * OpenWork Connect for a coworker: the organization's connected apps, skills,
 * and plugins reach the coworker through one gateway MCP (`openwork-cloud`)
 * registered in its workspace — exactly how the OpenWork desktop does it. A
 * minted bearer token from the signed-in account authorizes the gateway; the
 * embedded server owns the registration, probing, and engine refresh.
 */
import { z } from "zod";
import type { RuntimeInfo } from "./bridge.ts";
import type { ConnectToken, DenSession } from "./den.ts";

export const CONNECT_MCP_NAME = "openwork-cloud";

const HOSTED_WEB_HOST = "app.openworklabs.com";
const HOSTED_API_ORIGIN = "https://api.app.openworklabs.com";

/**
 * The gateway URL for a minted token's `resource`. Older Den builds mint the
 * web-app origin or its proxy path; the hosted API answers `/mcp/agent`.
 */
export function connectGatewayUrl(resource: string): string | null {
  const trimmed = resource.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const pathname = url.pathname.replace(/\/+$/, "");
    if (url.protocol === "https:" && url.hostname.toLowerCase() === HOSTED_WEB_HOST && (pathname === "/mcp" || pathname === "/api/den/mcp")) {
      return `${HOSTED_API_ORIGIN}/mcp/agent`;
    }
    url.search = "";
    url.hash = "";
    url.pathname = pathname;
    return `${url.toString().replace(/\/+$/, "")}/agent`;
  } catch {
    return null;
  }
}

/** The exact body the embedded server's reconcile route validates. */
export function connectReconcilePayload(input: {
  workspaceId: string;
  session: DenSession;
  token: ConnectToken;
  appVersion: string;
}): Record<string, unknown> | null {
  const url = connectGatewayUrl(input.token.resource);
  if (!url) return null;
  return {
    workspaceId: input.workspaceId,
    name: CONNECT_MCP_NAME,
    config: {
      type: "remote",
      enabled: true,
      url,
      headers: { Authorization: `Bearer ${input.token.token}` },
      oauth: false,
    },
    ...(input.token.appHostToken ? { appHostAuthorization: `Bearer ${input.token.appHostToken}` } : {}),
    tokenMetadata: {
      organizationId: input.token.organizationId,
      expiresAt: input.token.expiresAt,
      resource: input.token.resource,
      scopes: input.token.scopes.join(" "),
    },
    org: { id: input.session.orgId, slug: null, name: input.session.orgName || null },
    app: { version: input.appVersion, name: "open-coworker" },
    connectCatalogEnabled: true,
    trigger: "coworker-sign-in",
  };
}

const failureSchema = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
  recommendedAction: z.string().optional(),
}).loose();

const healthSchema = z.object({
  usable: z.boolean(),
  phase: z.string().optional(),
  tools: z.object({
    present: z.array(z.string()).default([]),
    missing: z.array(z.string()).default([]),
  }).loose().optional(),
  firstFailure: failureSchema.nullable().optional(),
  checkedAt: z.string().optional(),
}).loose();

export type ConnectHealth = {
  usable: boolean;
  phase: string;
  toolsPresent: string[];
  toolsMissing: string[];
  failure: { code: string; message: string; recommendedAction: string } | null;
};

export function parseConnectHealth(payload: unknown): ConnectHealth {
  const parsed = healthSchema.parse(payload);
  return {
    usable: parsed.usable,
    phase: parsed.phase ?? "",
    toolsPresent: parsed.tools?.present ?? [],
    toolsMissing: parsed.tools?.missing ?? [],
    failure: parsed.firstFailure
      ? {
          code: parsed.firstFailure.code ?? "",
          message: parsed.firstFailure.message ?? "",
          recommendedAction: parsed.firstFailure.recommendedAction ?? "",
        }
      : null,
  };
}

function headers(runtime: Pick<RuntimeInfo, "ownerToken">): Record<string, string> {
  return { Accept: "application/json", Authorization: `Bearer ${runtime.ownerToken}` };
}

function mcpPath(runtime: Pick<RuntimeInfo, "serverUrl">, workspaceId: string, suffix: string): string {
  return `${runtime.serverUrl.replace(/\/+$/, "")}/workspace/${encodeURIComponent(workspaceId)}/mcp/${CONNECT_MCP_NAME}${suffix}`;
}

async function failureMessage(response: Response, fallback: string): Promise<string> {
  try {
    const payload: unknown = await response.json();
    if (typeof payload === "object" && payload !== null && "message" in payload && typeof payload.message === "string") return payload.message;
  } catch {
    // Non-JSON error bodies fall through to the fallback.
  }
  return `${fallback} (${response.status})`;
}

/** Register (or refresh) the gateway in one coworker workspace and probe it. */
export async function reconcileConnect(
  runtime: Pick<RuntimeInfo, "serverUrl" | "ownerToken">,
  workspaceId: string,
  payload: Record<string, unknown>,
): Promise<ConnectHealth> {
  const response = await fetch(mcpPath(runtime, workspaceId, "/reconcile"), {
    method: "POST",
    headers: { ...headers(runtime), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(await failureMessage(response, "Connecting OpenWork to this coworker failed"));
  return parseConnectHealth(await response.json());
}

/** Current gateway health for one workspace; null when the gateway is not registered there. */
export async function readConnectHealth(
  runtime: Pick<RuntimeInfo, "serverUrl" | "ownerToken">,
  workspaceId: string,
  options: { probe?: boolean } = {},
): Promise<ConnectHealth | null> {
  const response = await fetch(mcpPath(runtime, workspaceId, `/health${options.probe ? "?probe=1" : ""}`), {
    headers: headers(runtime),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(await failureMessage(response, "Reading the OpenWork Connect state failed"));
  const health = parseConnectHealth(await response.json());
  return health;
}

/** Remove the gateway from one workspace; the coworker keeps working without organization capabilities. */
export async function removeConnect(runtime: Pick<RuntimeInfo, "serverUrl" | "ownerToken">, workspaceId: string): Promise<void> {
  const response = await fetch(mcpPath(runtime, workspaceId, ""), {
    method: "DELETE",
    headers: headers(runtime),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok && response.status !== 404) throw new Error(await failureMessage(response, "Disconnecting OpenWork from this coworker failed"));
}

export type ConnectState =
  | { status: "connecting" }
  | { status: "connected"; health: ConnectHealth }
  | { status: "attention"; health: ConnectHealth | null; message: string }
  | { status: "unavailable"; message: string };

/** One status word plus one plain sentence for the Apps & tools card. */
export function describeConnect(state: ConnectState | null, signedIn: boolean): { label: string; tone: "mint" | "amber" | "rose" | "mist"; detail: string } {
  if (!signedIn) return { label: "Not connected", tone: "mist", detail: "Sign in to OpenWork to bring your organization's apps, skills, and plugins to this coworker." };
  if (!state || state.status === "connecting") return { label: "Connecting", tone: "mist", detail: "Setting up OpenWork Connect for this coworker." };
  if (state.status === "connected") return { label: "Connected", tone: "mint", detail: "" };
  if (state.status === "attention") {
    return {
      label: "Needs attention",
      tone: "amber",
      detail: state.health?.failure?.recommendedAction || state.message || "OpenWork Connect is not ready for this coworker yet.",
    };
  }
  return { label: "Unavailable", tone: "rose", detail: state.message };
}

/** Whether the health means the coworker can search and execute organization capabilities. */
export function connectStateFromHealth(health: ConnectHealth): ConnectState {
  if (health.usable) return { status: "connected", health };
  return {
    status: "attention",
    health,
    message: health.failure?.message || `OpenWork Connect is ${health.phase || "not ready"} for this coworker.`,
  };
}
