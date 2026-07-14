import type { ExternalMcpAuthType, ExternalMcpCredentialMode, ExternalMcpPreset } from "./mcp-connections-data";
import type { MarketplacePluginCloudReadinessConnection } from "./marketplace-data";

function normalizeMcpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return null;
    const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
    return `${url.protocol.toLowerCase()}//${url.host}${pathname}${url.search}`;
  } catch {
    return null;
  }
}

function titleCase(value: string): string {
  return value
    .split(/[\s_-]+/g)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function findPresetForRequirement(presets: ExternalMcpPreset[], connection: MarketplacePluginCloudReadinessConnection): ExternalMcpPreset | null {
  const url = normalizeMcpUrl(connection.url);
  if (!url) return null;
  return presets.find((preset) => normalizeMcpUrl(preset.url) === url) ?? null;
}

export function serviceNameForRequirement(connection: MarketplacePluginCloudReadinessConnection, preset: ExternalMcpPreset | null): string {
  return preset?.displayName ?? titleCase(connection.serverName || connection.name || "MCP server");
}

export function pluginSetupAuthType(preset: ExternalMcpPreset | null): ExternalMcpAuthType {
  return preset?.authType ?? "oauth";
}

export function pluginSetupInitialState(preset: ExternalMcpPreset | null): {
  authAssumed: boolean;
  authType: ExternalMcpAuthType;
  credentialMode: ExternalMcpCredentialMode;
} {
  const authType = pluginSetupAuthType(preset);
  return {
    authAssumed: !preset,
    authType,
    credentialMode: pluginSetupCredentialMode(authType, "per_member"),
  };
}

export function pluginSetupCredentialMode(authType: ExternalMcpAuthType, selectedMode: ExternalMcpCredentialMode): ExternalMcpCredentialMode {
  return authType === "oauth" ? selectedMode : "shared";
}

export function pluginSetupAuthLabel(authType: ExternalMcpAuthType): string {
  switch (authType) {
    case "oauth":
      return "OAuth";
    case "apikey":
      return "API key";
    case "none":
      return "No authentication";
  }
}

export function pluginSetupRequest(input: {
  apiKey: string;
  authType: ExternalMcpAuthType;
  credentialMode: ExternalMcpCredentialMode;
  oauthClient?: { clientId: string; clientSecret?: string };
}): {
  apiKey?: string;
  authType: ExternalMcpAuthType;
  credentialMode: ExternalMcpCredentialMode;
  oauthClient?: { clientId: string; clientSecret?: string };
} {
  return {
    authType: input.authType,
    credentialMode: pluginSetupCredentialMode(input.authType, input.credentialMode),
    ...(input.authType === "apikey" ? { apiKey: input.apiKey } : {}),
    ...(input.authType === "oauth" && input.oauthClient ? { oauthClient: input.oauthClient } : {}),
  };
}

export function pluginSetupSuccessCopy(input: {
  authType: ExternalMcpAuthType;
  credentialMode: ExternalMcpCredentialMode;
  pluginName: string;
  serviceName: string;
}): { body: string; linkLabel: string | null } {
  if (input.authType === "oauth" && input.credentialMode === "per_member") {
    return {
      body: `${input.serviceName} is now bound to ${input.pluginName}. Assigned users connect their own account from Your Connections. No OAuth was started automatically.`,
      linkLabel: "Open Your Connections",
    };
  }
  if (input.authType === "oauth") {
    return {
      body: `${input.serviceName} is now bound to ${input.pluginName}. Connect the organization account from Your Connections. No OAuth was started automatically.`,
      linkLabel: "Connect organization account",
    };
  }
  return {
    body: `${input.serviceName} is ready for ${input.pluginName}. No user sign-in is needed.`,
    linkLabel: null,
  };
}

export type PluginReadinessConnectionAction = {
  connectionId: string;
  label: string;
  note: string;
  type: "connect_member" | "connect_org";
};

export function pluginReadinessConnectionAction(
  connection: MarketplacePluginCloudReadinessConnection,
  isAdmin: boolean,
): PluginReadinessConnectionAction | null {
  if (connection.id && connection.credentialMode === "per_member" && connection.connectedForMe === false) {
    return {
      connectionId: connection.id,
      label: isAdmin ? "Open Your Connections" : "Connect your account",
      note: isAdmin
        ? "Assigned members connect individually from Your Connections. This link only focuses the connection; it will not start OAuth."
        : "Connect your own account from Your Connections. OAuth starts only after you click Connect there.",
      type: "connect_member",
    };
  }
  if (isAdmin && connection.id && connection.credentialMode === "shared" && connection.connectedForMe === false) {
    return {
      connectionId: connection.id,
      label: "Connect organization account",
      note: "An admin connects one organization account from Your Connections. OAuth starts only after an admin clicks Connect there.",
      type: "connect_org",
    };
  }
  return null;
}

export function pluginSetupActionLabel(preset: ExternalMcpPreset | null): string {
  return preset ? "Quick connect" : "Configure connection";
}
