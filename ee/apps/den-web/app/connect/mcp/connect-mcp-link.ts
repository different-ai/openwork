export type ConnectMcpLink = {
  connectionId: string;
  organizationId: string;
  name: string;
};

export type ConnectStartResult =
  | { kind: "connected" }
  | { kind: "redirect"; authorizeUrl: string }
  /** The connection is gone or not shared with this person: no retry will help. */
  | { kind: "unavailable"; message: string }
  | { kind: "error"; message: string };

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Reads the link den-api returns as `links.signIn` from POST /v1/mcp-connections. */
export function readConnectMcpLink(params: URLSearchParams): ConnectMcpLink | null {
  const connectionId = params.get("connectionId")?.trim() ?? "";
  const organizationId = params.get("org")?.trim() ?? "";
  if (!ID_PATTERN.test(connectionId) || !ID_PATTERN.test(organizationId)) return null;
  const name = params.get("name")?.trim().slice(0, 120) || "this connection";
  return { connectionId, organizationId, name };
}

function readField(payload: unknown, key: string): unknown {
  return typeof payload === "object" && payload !== null ? Reflect.get(payload, key) : undefined;
}

export function readConnectStartResult(payload: unknown, ok: boolean, name = "The provider"): ConnectStartResult {
  if (ok) {
    const status = readField(payload, "status");
    const authorizeUrl = readField(payload, "authorizeUrl");
    if (status === "connected") return { kind: "connected" };
    if (status === "needs_auth" && typeof authorizeUrl === "string" && authorizeUrl) {
      return { kind: "redirect", authorizeUrl };
    }
    return { kind: "error", message: `${name} did not open a sign-in page. Try again.` };
  }
  const error = readField(payload, "error");
  if (error === "connection_not_found" || error === "forbidden") {
    return { kind: "unavailable", message: "This connection was removed or is not shared with you. Ask your agent for a new link." };
  }
  const message = readField(payload, "message");
  if (typeof message === "string" && message.trim()) return { kind: "error", message: message.trim() };
  return { kind: "error", message: "Could not start sign-in. Try again." };
}

/** The workspace name for the link's organization, from GET /v1/me/orgs. */
export function readWorkspaceName(payload: unknown, organizationId: string): string | null {
  const orgs = readField(payload, "orgs");
  if (!Array.isArray(orgs)) return null;
  for (const org of orgs) {
    if (readField(org, "id") !== organizationId) continue;
    const name = readField(org, "name");
    return typeof name === "string" && name.trim() ? name.trim() : null;
  }
  return null;
}
