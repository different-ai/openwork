/**
 * Connection states in the words a person reads: Connected, Not connected,
 * Needs sign-in, Needs setup by an admin. Every source the Apps & tools panel
 * shows — the OpenWork Connect gateway, an organization connection behind it,
 * a plugin's readiness, a tool set up on this Mac — maps here exactly, so the
 * panel never says "ready" when the source says otherwise, and never shows a
 * status code or a raw error outside Technical details.
 */
import type { ConnectState } from "./connect.ts";

export type StatusTone = "mint" | "amber" | "rose" | "mist";

export type PlainStatus = {
  label: string;
  tone: StatusTone;
  /** One sentence of help, empty when the label says it all. */
  detail: string;
};

/** Gateway failures a new sign-in resolves. */
const GATEWAY_SIGN_IN_CODES = new Set([
  "invalid_mcp_token",
  "missing_mcp_token",
  "mcp_session_revoked",
  "cloud_mcp_needs_auth",
  "insufficient_mcp_scope",
]);

/** Gateway failures only an organization admin can resolve. */
const GATEWAY_ADMIN_CODES = new Set([
  "mcp_membership_revoked",
  "cloud_mcp_disabled",
  "wrong_mcp_resource",
  "cloud_token_org_mismatch",
]);

export type ConnectRowStatus = PlainStatus & {
  /** What the person can do about it from here. */
  action: "sign-in" | "repair" | null;
};

/** The "Connected with OpenWork" row, from the gateway's own state. */
export function connectRowStatus(state: ConnectState | null, signedIn: boolean, orgName: string): ConnectRowStatus {
  if (!signedIn) {
    return { label: "Not connected", tone: "mist", detail: "Sign in to use the apps and tools available through your OpenWork account.", action: "sign-in" };
  }
  if (!state || state.status === "connecting") return { label: "Connecting", tone: "mist", detail: "Setting up OpenWork Connect for this coworker.", action: null };
  if (state.status === "connected") {
    const name = orgName.trim();
    return { label: name ? `Connected as ${name}` : "Connected", tone: "mint", detail: "", action: null };
  }
  if (state.status === "attention") {
    const code = state.health?.failure?.code ?? "";
    if (GATEWAY_SIGN_IN_CODES.has(code)) {
      return { label: "Needs sign-in", tone: "amber", detail: "Sign in to OpenWork again to reconnect this coworker.", action: "sign-in" };
    }
    if (GATEWAY_ADMIN_CODES.has(code)) {
      return {
        label: "Needs setup by an admin",
        tone: "amber",
        detail: "Ask your workspace admin to restore access to connected apps in OpenWork.",
        action: null,
      };
    }
    return {
      label: "Needs attention",
      tone: "amber",
      detail: "Your connected apps aren't ready yet. Try reconnecting; your current work is saved.",
      action: "repair",
    };
  }
  return { label: "Temporarily unavailable", tone: "amber", detail: "Couldn't reach your connected apps. Try reconnecting when you're online.", action: "repair" };
}

/** The status the gateway's search returns for an organization connection that needs a person. */
export type CloudConnectionStatus = {
  connectionId: string;
  connectionName: string;
  state: "needs_connection" | "reauth_required" | "provider_error";
  actor: "member" | "organization_admin" | "provider_admin" | "network_admin" | "openwork";
  action: {
    type: "connect" | "reconnect" | "update_credentials" | "inspect_connection" | "fix_provider" | "fix_network" | "contact_openwork";
    surface: "openwork_your_connections" | "openwork_organization_connections" | "provider_admin_console" | "network_infrastructure" | "openwork_support";
    label?: string;
    url?: string;
  };
  message: string;
};

const SURFACES: Record<CloudConnectionStatus["action"]["surface"], string> = {
  openwork_your_connections: "your Connections page in OpenWork",
  openwork_organization_connections: "the organization's Connections dashboard in OpenWork",
  provider_admin_console: "the provider's own admin console",
  network_infrastructure: "your network setup",
  openwork_support: "OpenWork support",
};

function readAsRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
}

function oneOf<const T extends readonly string[]>(value: unknown, allowed: T): T[number] | null {
  return typeof value === "string" && allowed.includes(value) ? value : null;
}

/** Read a connection status out of a search match; null when it is not one. */
export function parseCloudConnectionStatus(value: unknown): CloudConnectionStatus | null {
  const record = readAsRecord(value);
  if (!record) return null;
  const action = readAsRecord(record.action);
  const state = oneOf(record.state, ["needs_connection", "reauth_required", "provider_error"] as const);
  const actor = oneOf(record.actor, ["member", "organization_admin", "provider_admin", "network_admin", "openwork"] as const);
  const type = oneOf(action?.type, ["connect", "reconnect", "update_credentials", "inspect_connection", "fix_provider", "fix_network", "contact_openwork"] as const);
  const surface = oneOf(action?.surface, ["openwork_your_connections", "openwork_organization_connections", "provider_admin_console", "network_infrastructure", "openwork_support"] as const);
  if (typeof record.connectionId !== "string" || typeof record.connectionName !== "string" || !state || !actor || !action || !type || !surface) return null;
  return {
    connectionId: record.connectionId,
    connectionName: record.connectionName,
    state,
    actor,
    action: {
      type,
      surface,
      ...(typeof action.label === "string" ? { label: action.label } : {}),
      ...(typeof action.url === "string" ? { url: action.url } : {}),
    },
    message: typeof record.message === "string" ? record.message : "",
  };
}

export type ConnectionWords = PlainStatus & {
  /** The exact human step that unblocks it, naming where to do it. */
  humanAction: string;
};

function verbFor(type: CloudConnectionStatus["action"]["type"], name: string): string {
  switch (type) {
    case "connect": return `connect ${name}`;
    case "reconnect": return `reconnect ${name}`;
    case "update_credentials": return `update the credentials for ${name}`;
    case "inspect_connection": return `check ${name}`;
    case "fix_provider": return `fix ${name}`;
    case "fix_network": return `check the network path to ${name}`;
    case "contact_openwork": return `ask about ${name}`;
  }
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Plain words for one organization connection that needs a person, and the step that unblocks it. */
export function connectionStatusWords(status: CloudConnectionStatus): ConnectionWords {
  const where = SURFACES[status.action.surface];
  const step = `${verbFor(status.action.type, status.connectionName)} on ${where}`;
  if (status.actor === "member") {
    const label = status.state === "provider_error" ? "Needs attention" : "Needs sign-in";
    return { label, tone: "amber", detail: status.message, humanAction: `${capitalize(step)}.` };
  }
  if (status.actor === "organization_admin") {
    return { label: "Needs setup by an admin", tone: "amber", detail: status.message, humanAction: `Ask an organization admin to ${step}.` };
  }
  if (status.actor === "provider_admin") {
    return { label: "Needs attention", tone: "amber", detail: status.message, humanAction: `Ask the provider's administrator to ${step}.` };
  }
  if (status.actor === "network_admin") {
    return { label: "Needs attention", tone: "amber", detail: status.message, humanAction: `Ask whoever runs your network to ${step}.` };
  }
  return { label: "Needs attention", tone: "amber", detail: status.message, humanAction: `${capitalize(verbFor(status.action.type, status.connectionName))} with ${where}.` };
}

/** How the coworker's AI service sees one tool set up on this Mac. */
export type EngineToolStatus =
  | { status: "connected" }
  | { status: "disabled" }
  | { status: "failed"; error: string }
  | { status: "needs_auth" }
  | { status: "needs_client_registration"; error: string };

export function parseEngineToolStatus(value: unknown): EngineToolStatus | null {
  const record = readAsRecord(value);
  if (!record) return null;
  const error = typeof record.error === "string" ? record.error : "";
  switch (record.status) {
    case "connected": return { status: "connected" };
    case "disabled": return { status: "disabled" };
    case "needs_auth": return { status: "needs_auth" };
    case "failed": return { status: "failed", error };
    case "needs_client_registration": return { status: "needs_client_registration", error };
    default: return null;
  }
}

export type LocalToolWords = PlainStatus & {
  /** The raw error, for Technical details only. */
  technical: string;
};

/**
 * A tool set up on this Mac: what the workspace configured, what the managed
 * sign-in knows, and what the AI service reports, in that order of authority.
 */
export function localToolStatus(input: {
  enabled: boolean;
  managedOAuth?: { status: "needs_auth" | "connecting" | "connected" | "reconnect_required"; lastError?: string | null } | null;
  engine?: EngineToolStatus | null;
  /** From the App catalog probe, when the AI service has not reported. */
  reachable?: boolean;
}): LocalToolWords {
  if (!input.enabled || input.engine?.status === "disabled") {
    return { label: "Off", tone: "mist", detail: "Turned off for this coworker.", technical: "" };
  }
  const managed = input.managedOAuth?.status;
  if (managed === "needs_auth" || managed === "reconnect_required" || input.engine?.status === "needs_auth") {
    return { label: "Needs sign-in", tone: "amber", detail: "Sign in to this tool before the coworker can use it.", technical: input.managedOAuth?.lastError ?? "" };
  }
  if (managed === "connecting") return { label: "Connecting", tone: "mist", detail: "Finishing the sign-in.", technical: "" };
  if (input.engine?.status === "needs_client_registration") {
    return { label: "Needs setup", tone: "amber", detail: "OpenWork has to register with this tool before it can connect.", technical: input.engine.error };
  }
  if (input.engine?.status === "failed") {
    return { label: "Not connected", tone: "rose", detail: "OpenWork could not reach this tool. Check that it is running and reachable, then refresh.", technical: input.engine.error };
  }
  if (input.engine?.status === "connected") return { label: "Connected", tone: "mint", detail: "", technical: "" };
  if (input.reachable === false) {
    return { label: "Not connected", tone: "rose", detail: "OpenWork could not reach this tool. Check that it is running and reachable, then refresh.", technical: "" };
  }
  if (input.reachable === true) return { label: "Connected", tone: "mint", detail: "", technical: "" };
  return { label: "Checking", tone: "mist", detail: "", technical: "" };
}

/** A plugin's or skill's readiness in OpenWork Cloud, from the states the gateway reports. */
export function readinessWords(state: string | undefined): PlainStatus {
  switch (state) {
    case undefined:
    case "":
    case "ready":
    case "connection_available":
    case "executed":
      return { label: "Ready", tone: "mint", detail: "" };
    case "needs_signin":
    case "needs_connection":
    case "reconnect":
      return { label: "Needs sign-in", tone: "amber", detail: "Sign in to the service this uses on your Connections page in OpenWork." };
    case "needs_admin_setup":
      return { label: "Needs setup by an admin", tone: "amber", detail: "An organization admin has to set up the service this uses." };
    case "needs_install":
    case "desktop_only":
      return { label: "Desktop only", tone: "mist", detail: "This one runs in OpenWork Desktop, not here." };
    case "content_not_synced":
    case "not_synced":
      return { label: "Not ready yet", tone: "mist", detail: "Still being prepared in OpenWork Cloud." };
    default:
      return { label: "Not available", tone: "mist", detail: "" };
  }
}
