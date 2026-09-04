import { apexDomain } from "../../_lib/brand-icon";
import {
  configuredConnectionForPopular,
  connectionForPresetUrl,
  GOOGLE_WORKSPACE_QUICK_ADD_ID,
  MICROSOFT_365_QUICK_ADD_ID,
  POPULAR_CONNECTORS,
  type PopularConnector,
} from "./connector-catalog";
import { EFFORT_LABELS, presetEffort, type ConnectorEffort } from "./connector-effort";
import { isNativeProviderConnectionId, type ExternalMcpConnection, type ExternalMcpPreset } from "./mcp-connections-data";

export const CONNECTOR_DOCS_URL = "https://openworklabs.com/docs/cloud/share-with-your-team/shared-mcp-connections";

/**
 * What a connector detail page is about. The route accepts one id that may
 * name a configured connection, a popular catalog entry (Gmail, GitHub…), a
 * curated preset, or the Microsoft 365 native provider. Configured entries
 * always resolve to their connection so the page can offer connect,
 * disconnect, tools, and removal; unconfigured ones keep their catalog
 * identity so the page can explain and start setup.
 */
export type ConnectorDetailSubject =
  | {
      kind: "connection";
      connection: ExternalMcpConnection;
      /** Catalog identity when the connection came from a popular row or preset. */
      popular?: PopularConnector;
      preset?: ExternalMcpPreset;
    }
  | { kind: "popular"; popular: PopularConnector; preset?: ExternalMcpPreset }
  | { kind: "preset"; preset: ExternalMcpPreset }
  | { kind: "microsoft-365" }
  | { kind: "not_found"; connectorId: string };

function presetForConnection(
  connection: ExternalMcpConnection,
  presets: readonly ExternalMcpPreset[],
): ExternalMcpPreset | undefined {
  return presets.find((preset) => connectionForPresetUrl([connection], preset.url) !== undefined);
}

/**
 * Only preset-backed popular rows map 1:1 to a connection. Gmail, Drive, and
 * Calendar all share the Google Workspace connection, so a connection opened
 * by its own id keeps the Google Workspace identity instead of adopting the
 * first popular row that happens to point at it.
 */
function popularForConnection(
  connection: ExternalMcpConnection,
  presets: readonly ExternalMcpPreset[],
): PopularConnector | undefined {
  return POPULAR_CONNECTORS.find((connector) =>
    connector.target.kind === "preset" && configuredConnectionForPopular(connector, [connection], presets)?.id === connection.id);
}

export function resolveConnectorDetailSubject(
  connectorId: string,
  connections: readonly ExternalMcpConnection[],
  presets: readonly ExternalMcpPreset[],
): ConnectorDetailSubject {
  const connection = connections.find((entry) => entry.id === connectorId);
  if (connection) {
    return {
      kind: "connection",
      connection,
      popular: popularForConnection(connection, presets),
      preset: presetForConnection(connection, presets),
    };
  }

  const popular = POPULAR_CONNECTORS.find((connector) => connector.id === connectorId);
  if (popular) {
    const target = popular.target;
    const preset = target.kind === "preset"
      ? presets.find((entry) => entry.presetId === target.presetId)
      : undefined;
    const configured = configuredConnectionForPopular(popular, connections, presets);
    return configured
      ? { kind: "connection", connection: configured, popular, preset }
      : { kind: "popular", popular, preset };
  }

  const preset = presets.find((entry) => entry.presetId === connectorId);
  if (preset) {
    const configured = connectionForPresetUrl(connections, preset.url);
    return configured
      ? { kind: "connection", connection: configured, preset, popular: popularForConnection(configured, presets) }
      : { kind: "preset", preset };
  }

  if (connectorId === MICROSOFT_365_QUICK_ADD_ID) {
    const configured = connections.find((entry) => entry.id === MICROSOFT_365_QUICK_ADD_ID || entry.nativeProviderKey === "microsoft-365");
    return configured ? { kind: "connection", connection: configured } : { kind: "microsoft-365" };
  }

  return { kind: "not_found", connectorId };
}

export type ConnectorDetailIdentity = {
  name: string;
  description: string;
  icon: { iconUrl?: string; simpleIconSlug?: string; serviceUrl?: string };
};

const GOOGLE_WORKSPACE_IDENTITY: ConnectorDetailIdentity = {
  name: "Google Workspace",
  description: "Gmail, Google Drive, and Google Calendar for everyone in the org",
  icon: { simpleIconSlug: "google", serviceUrl: "https://www.google.com" },
};

const MICROSOFT_365_IDENTITY: ConnectorDetailIdentity = {
  name: "Microsoft 365",
  description: "Outlook email, calendar, and OneDrive",
  icon: { simpleIconSlug: "microsoft" },
};

/** Name, blurb, and icon for the page header. Catalog identity wins over the raw connection row. */
export function connectorDetailIdentity(subject: ConnectorDetailSubject): ConnectorDetailIdentity {
  switch (subject.kind) {
    case "popular":
      return { name: subject.popular.displayName, description: subject.popular.description, icon: subject.popular.icon };
    case "preset":
      return { name: subject.preset.displayName, description: subject.preset.description, icon: { serviceUrl: subject.preset.url } };
    case "microsoft-365":
      return MICROSOFT_365_IDENTITY;
    case "connection": {
      if (subject.popular) {
        return { name: subject.popular.displayName, description: subject.popular.description, icon: subject.popular.icon };
      }
      if (subject.connection.id === GOOGLE_WORKSPACE_QUICK_ADD_ID || subject.connection.nativeProviderKey === "google-workspace") {
        return { ...GOOGLE_WORKSPACE_IDENTITY, name: subject.connection.name || GOOGLE_WORKSPACE_IDENTITY.name };
      }
      if (subject.connection.id === MICROSOFT_365_QUICK_ADD_ID || subject.connection.nativeProviderKey === "microsoft-365") {
        return { ...MICROSOFT_365_IDENTITY, name: subject.connection.name || MICROSOFT_365_IDENTITY.name };
      }
      return {
        name: subject.connection.name,
        description: subject.preset?.description ?? describeConnectionFallback(subject.connection),
        icon: { serviceUrl: subject.connection.url },
      };
    }
    case "not_found":
      return { name: "Connector not found", description: "", icon: {} };
  }
}

function describeConnectionFallback(connection: ExternalMcpConnection): string {
  const host = apexDomain(connection.url);
  return host ? `MCP server at ${host}` : "MCP server";
}

/** How much setup adding this connector takes, before it exists in the org. */
export function connectorDetailEffort(subject: ConnectorDetailSubject): ConnectorEffort | null {
  switch (subject.kind) {
    case "popular":
      if (subject.popular.target.kind !== "preset") return "guided";
      return subject.preset ? presetEffort(subject.preset) : "guided";
    case "preset":
      return presetEffort(subject.preset);
    case "microsoft-365":
      return "guided";
    default:
      return null;
  }
}

/** Primary call to action for an unconfigured connector. */
export function connectorDetailPrimaryAction(effort: ConnectorEffort): { label: string; explanation: string } {
  switch (effort) {
    case "instant":
      return { label: "Add", explanation: "Adds it for everyone in the org right away. No sign-in is needed." };
    case "one_click":
      return { label: "Connect", explanation: "Adds it for everyone in the org and opens the provider sign-in so your own account is connected in the same step. Everyone else connects theirs from Your Connections." };
    case "api_key":
      return { label: "Set up", explanation: "Needs your org's API key for this provider. You'll paste it in the next step." };
    case "oauth_app":
      return { label: "Set up", explanation: "Needs an OAuth app registered with this provider. You'll enter its client id and secret in the next step." };
    case "guided":
      return { label: "Set up", explanation: "A short guided setup collects what this provider needs before anyone can connect." };
  }
}

export type ConnectorFact = {
  label: string;
  value: string;
  href?: string;
  mono?: boolean;
};

function formatDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function accessLabel(connection: ExternalMcpConnection, orgName: string): string | null {
  const access = connection.access;
  if (!access) return null;
  if (access.orgWide) return `Everyone in ${orgName}`;
  const parts: string[] = [];
  if (access.teamIds.length > 0) parts.push(`${access.teamIds.length} ${access.teamIds.length === 1 ? "team" : "teams"}`);
  if (access.memberIds.length > 0) parts.push(`${access.memberIds.length} ${access.memberIds.length === 1 ? "person" : "people"}`);
  return parts.length > 0 ? parts.join(", ") : "Nobody yet";
}

function signInLabel(authType: ExternalMcpConnection["authType"], credentialMode?: ExternalMcpConnection["credentialMode"]): string {
  const auth = authType === "oauth" ? "OAuth sign-in" : authType === "apikey" ? "API key" : "No sign-in";
  if (!credentialMode) return auth;
  return `${auth} · ${credentialMode === "per_member" ? "each person connects their own account" : "one shared org account"}`;
}

/**
 * The "Information" table. Everything here is already known to the page from
 * the connection list and preset catalog; nothing needs a second request.
 */
export function connectorDetailFacts(
  subject: ConnectorDetailSubject,
  context: { orgName: string; pluginHref: (pluginId: string) => string },
): ConnectorFact[] {
  const facts: ConnectorFact[] = [];

  if (subject.kind === "connection") {
    const { connection } = subject;
    const native = isNativeProviderConnectionId(connection.id, connection.nativeProviderKey);
    const host = apexDomain(connection.url);
    if (native) {
      const provider = connection.id === MICROSOFT_365_QUICK_ADD_ID || connection.nativeProviderKey === "microsoft-365" ? "Microsoft" : "Google";
      facts.push({ label: "Provider", value: provider });
      facts.push({ label: "Type", value: "Native OpenWork connector" });
    } else {
      if (host) facts.push({ label: "Provider", value: host, href: `https://${host}` });
      facts.push({ label: "Type", value: subject.connection.identityManagedBy.length > 0 ? "MCP server from a plugin" : "Remote MCP server" });
      facts.push({ label: "Server", value: connection.url, mono: true });
    }
    facts.push({ label: "Sign-in", value: signInLabel(connection.authType, connection.credentialMode) });
    if (connection.exposeDirectly) facts.push({ label: "Exposure", value: "Available as a standard MCP server with its own tool catalog" });
    const access = accessLabel(connection, context.orgName);
    if (access) facts.push({ label: "Access", value: access });
    const added = [connection.createdByName ? `Added by ${connection.createdByName}` : null, formatDate(connection.connectedAt ?? connection.updatedAt)]
      .filter((part): part is string => Boolean(part))
      .join(" · ");
    if (added) facts.push({ label: "Added", value: added });
    for (const owner of connection.identityManagedBy) {
      facts.push({ label: "Managed by", value: owner.name, href: context.pluginHref(owner.pluginId) });
    }
    const requiredBy = connection.requiredBy.filter((plugin) => !connection.identityManagedBy.some((owner) => owner.pluginId === plugin.pluginId));
    for (const plugin of requiredBy) {
      facts.push({ label: "Required by", value: plugin.name, href: context.pluginHref(plugin.pluginId) });
    }
    if (subject.popular?.target.kind === "google-workspace") {
      facts.push({ label: "Part of", value: "Google Workspace — one connection covers Gmail, Drive, and Calendar" });
    }
  } else if (subject.kind === "popular" || subject.kind === "preset") {
    const preset = subject.kind === "preset" ? subject.preset : subject.preset;
    if (subject.kind === "popular" && subject.popular.target.kind === "google-workspace") {
      facts.push({ label: "Provider", value: "Google" });
      facts.push({ label: "Type", value: "Native OpenWork connector" });
      facts.push({ label: "Sign-in", value: "Google sign-in · each person connects their own account" });
      facts.push({ label: "Part of", value: "Google Workspace — one connection covers Gmail, Drive, and Calendar" });
    } else if (preset) {
      const host = apexDomain(preset.url);
      if (host) facts.push({ label: "Provider", value: host, href: `https://${host}` });
      facts.push({ label: "Type", value: "Remote MCP server" });
      facts.push({ label: "Server", value: preset.url, mono: true });
      facts.push({ label: "Sign-in", value: signInLabel(preset.authType, preset.authType === "oauth" ? "per_member" : preset.authType === "none" ? undefined : "shared") });
      facts.push({ label: "Setup", value: EFFORT_LABELS[presetEffort(preset)] });
    } else if (subject.kind === "popular") {
      const host = apexDomain(subject.popular.icon.serviceUrl);
      if (host) facts.push({ label: "Provider", value: host, href: `https://${host}` });
      facts.push({ label: "Type", value: "Remote MCP server" });
      facts.push({ label: "Setup", value: EFFORT_LABELS.guided });
    }
  } else if (subject.kind === "microsoft-365") {
    facts.push({ label: "Provider", value: "Microsoft" });
    facts.push({ label: "Type", value: "Native OpenWork connector" });
    facts.push({ label: "Sign-in", value: "Microsoft sign-in · each person connects their own account" });
  }

  facts.push({ label: "Docs", value: "Shared MCP connections", href: CONNECTOR_DOCS_URL });
  return facts;
}

/** The stable id a catalog row or connection should link to for its detail page. */
export function connectorDetailId(input: { connection?: ExternalMcpConnection; catalogId: string }): string {
  return input.connection?.id ?? input.catalogId;
}
