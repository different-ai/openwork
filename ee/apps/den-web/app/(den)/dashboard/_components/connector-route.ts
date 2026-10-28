import { type ConnectorSignInMethod, connectorSignInMethod } from "./connector-sign-in-method";
import type { McpRequestHeaderInput, McpRequirementsDiscovery } from "./mcp-connections-data";

/**
 * The route an admin picks for a custom connector before its checks run.
 * OpenWork detects one; the admin may take another, as Claude's custom
 * connector dialog allows.
 */
export type ConnectorRouteAuth = "oauth" | "api_key" | "none";
export type ConnectorRouteClient = "automatic" | "own";

export type RequestHeaderDraft = { id: string; name: string; value: string };

export type ConnectorRoute = {
  auth: ConnectorRouteAuth;
  client: ConnectorRouteClient;
  requestHeaders: McpRequestHeaderInput[];
};

export const MAX_REQUEST_HEADERS = 4;

type DiscoveryAuthentication = Pick<McpRequirementsDiscovery, "authentication">;

/** What detection found, so each matching option can say "Detected". */
export type DetectedRoute = {
  auth: ConnectorRouteAuth | null;
  client: ConnectorRouteClient | null;
  /** How OpenWork registers itself when it can: its published client details, or dynamic registration. */
  automaticRegistration: "client_metadata" | "dynamic" | null;
};

export function detectedRoute(discovery: (DiscoveryAuthentication & Pick<McpRequirementsDiscovery, "status">) | null): DetectedRoute {
  if (!discovery || discovery.status === "unreachable") return { auth: null, client: null, automaticRegistration: null };
  const methods = discovery.authentication.availableRegistrationMethods ?? [];
  const recommended = discovery.authentication.recommendedRegistrationMethod;
  const automaticRegistration = recommended !== "pre_registered" && methods.includes(recommended)
    ? recommended
    : methods.includes("client_metadata") ? "client_metadata" : methods.includes("dynamic") ? "dynamic" : null;
  const method = connectorSignInMethod(discovery);
  switch (method) {
    case "sign_in":
      return { auth: "oauth", client: "automatic", automaticRegistration };
    case "oauth_app":
      return { auth: "oauth", client: "own", automaticRegistration };
    case "api_key":
      return { auth: "api_key", client: null, automaticRegistration };
    case "none":
      return { auth: "none", client: null, automaticRegistration };
    default:
      return { auth: null, client: null, automaticRegistration };
  }
}

/** The setup check's sign-in method for the route the admin chose. */
export function routeSignInMethod(route: Pick<ConnectorRoute, "auth" | "client">): ConnectorSignInMethod {
  if (route.auth === "api_key") return "api_key";
  if (route.auth === "none") return "none";
  return route.client === "own" ? "oauth_app" : "sign_in";
}

const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;

/** OpenWork or the MCP transport sets these; a custom value would break the connection or its sign-in. */
const RESERVED_HEADER_NAMES = new Set([
  "host",
  "content-length",
  "content-type",
  "accept",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authorization",
  "proxy-connection",
  "cookie",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
]);

/** Plain-English problem with one header row, or null when it can be saved. */
export function requestHeaderProblem(
  draft: Pick<RequestHeaderDraft, "name" | "value">,
  others: readonly Pick<RequestHeaderDraft, "name">[],
  auth: ConnectorRouteAuth,
): string | null {
  const name = draft.name.trim();
  if (!name && !draft.value) return null;
  if (!name) return "Add the header name.";
  if (!HEADER_NAME_PATTERN.test(name)) return "Use letters, numbers and dashes, like X-Api-Key.";
  const lower = name.toLowerCase();
  if (RESERVED_HEADER_NAMES.has(lower) || lower.startsWith("x-openwork-")) return `OpenWork sets ${name} itself.`;
  if (lower === "authorization" && auth !== "none") return auth === "api_key" ? "The API key is sent as Authorization. Use another name." : "Sign-in sends Authorization. Use another name.";
  if (others.some((other) => other.name.trim().toLowerCase() === lower)) return `${name} is already added.`;
  if (!draft.value) return "Add the value.";
  if (draft.value.length > 4096) return "The value is too long.";
  if (/[\r\n\0]/.test(draft.value)) return "The value has to be on one line.";
  return null;
}

/** Rows with a name or value, checked together; `problems` is keyed by row id. */
export function requestHeadersFromDrafts(drafts: readonly RequestHeaderDraft[], auth: ConnectorRouteAuth): {
  headers: McpRequestHeaderInput[];
  problems: Record<string, string>;
} {
  const problems: Record<string, string> = {};
  const headers: McpRequestHeaderInput[] = [];
  drafts.forEach((draft, index) => {
    const earlier = drafts.slice(0, index).filter((row) => row.name.trim());
    const problem = requestHeaderProblem(draft, earlier, auth);
    if (problem) {
      problems[draft.id] = problem;
      return;
    }
    if (draft.name.trim()) headers.push({ name: draft.name.trim(), value: draft.value });
  });
  return { headers, problems };
}
