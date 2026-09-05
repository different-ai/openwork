import type { DynamicToolUIPart } from "ai";

import { getMcpServerName, MCP_QUICK_CONNECT } from "@/app/constants";
import type { DenExternalMcpConnection } from "@/app/lib/den";
import type { McpServerEntry } from "@/app/types";
import {
  resolveExtensionIconSrc,
  resolveExtensionIconUrl,
} from "@/react-app/design-system/extension-icon-src";

export type ConnectorToolIdentity = {
  id: string;
  name: string;
  iconUrl: string | null;
  serviceUrl: string | null;
  toolNamespace: string | null;
  connectionId: string | null;
};

const NATIVE_CONNECTOR_IDENTITIES: ConnectorToolIdentity[] = [
  {
    id: "native:google-workspace",
    name: "Google Workspace",
    iconUrl: resolveExtensionIconSrc("/ext-google-workspace.svg"),
    serviceUrl: null,
    toolNamespace: null,
    connectionId: null,
  },
  {
    id: "native:microsoft-365",
    name: "Microsoft 365",
    iconUrl: resolveExtensionIconUrl({ iconSlug: "microsoft" }) ?? null,
    serviceUrl: null,
    toolNamespace: null,
    connectionId: null,
  },
];

function normalized(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function remoteUrl(server: McpServerEntry): string | null {
  const url = server.config.url?.trim();
  return url || null;
}

function quickConnectFor(input: { name?: string; url?: string | null; nativeProviderKey?: string | null }) {
  const name = normalized(input.nativeProviderKey ?? input.name ?? "");
  const url = input.url?.trim() ?? "";
  return MCP_QUICK_CONNECT.find((entry) => {
    if (url && entry.url === url) return true;
    const serverName = getMcpServerName(entry);
    return Boolean(name) && (normalized(serverName) === name || normalized(entry.name) === name);
  });
}

function iconFor(input: { name: string; url: string | null; nativeProviderKey?: string | null }): string | null {
  const native = input.nativeProviderKey
    ? NATIVE_CONNECTOR_IDENTITIES.find((identity) => normalized(identity.name) === normalized(input.nativeProviderKey ?? ""))
    : null;
  if (native?.iconUrl) return native.iconUrl;

  const quickConnect = quickConnectFor(input);
  return resolveExtensionIconUrl({
    iconSrc: quickConnect?.iconSrc,
    iconSlug: quickConnect?.iconSlug,
    serviceUrl: input.url ?? quickConnect?.url,
  }) ?? null;
}

function identityFromServer(server: McpServerEntry): ConnectorToolIdentity {
  const url = remoteUrl(server);
  const quickConnect = quickConnectFor({ name: server.name, url });
  const toolNamespace = quickConnect ? getMcpServerName(quickConnect) : server.name.trim();
  return {
    id: `mcp:${server.id ?? toolNamespace}`,
    name: server.name,
    iconUrl: iconFor({ name: server.name, url }),
    serviceUrl: url,
    toolNamespace: toolNamespace || null,
    connectionId: server.orgMcpConnectionId?.trim() || null,
  };
}

function identityFromConnection(connection: DenExternalMcpConnection): ConnectorToolIdentity {
  const url = connection.url.trim() || null;
  const native = connection.nativeProviderKey
    ? NATIVE_CONNECTOR_IDENTITIES.find((identity) => normalized(identity.name) === normalized(connection.nativeProviderKey ?? ""))
    : null;
  return {
    id: `connection:${connection.id}`,
    name: native?.name ?? connection.name,
    iconUrl: native?.iconUrl ?? iconFor({
      name: connection.name,
      url,
      nativeProviderKey: connection.nativeProviderKey,
    }),
    serviceUrl: native?.serviceUrl ?? url,
    toolNamespace: null,
    connectionId: connection.id,
  };
}

/**
 * One first-class presentation inventory for every connector source the
 * desktop knows about. Later, user- and organization-specific entries replace
 * catalog fallbacks with the exact name, URL, and connection id in use.
 */
export function buildConnectorToolIdentities(input: {
  mcpServers: McpServerEntry[];
  orgConnections: DenExternalMcpConnection[];
}): ConnectorToolIdentity[] {
  const identities = new Map<string, ConnectorToolIdentity>();

  for (const identity of NATIVE_CONNECTOR_IDENTITIES) identities.set(identity.id, identity);
  for (const entry of MCP_QUICK_CONNECT) {
    if (entry.kind !== "mcp") continue;
    const serverName = getMcpServerName(entry);
    identities.set(`catalog:${serverName}`, {
      id: `catalog:${serverName}`,
      name: entry.name,
      iconUrl: resolveExtensionIconUrl({
        iconSrc: entry.iconSrc,
        iconSlug: entry.iconSlug,
        serviceUrl: entry.url,
      }) ?? null,
      serviceUrl: entry.url ?? null,
      toolNamespace: serverName,
      connectionId: null,
    });
  }
  for (const server of input.mcpServers) {
    const identity = identityFromServer(server);
    identities.set(identity.id, identity);
  }
  for (const connection of input.orgConnections) {
    const identity = identityFromConnection(connection);
    identities.set(identity.id, identity);
  }

  return [...identities.values()];
}

function capabilityName(part: DynamicToolUIPart): string | null {
  if (!part.toolName.endsWith("execute_capability")) return null;
  if (!part.input || typeof part.input !== "object" || Array.isArray(part.input)) return null;
  const name = "name" in part.input ? part.input.name : null;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

/** Resolve a rendered tool call only when it can be attributed to a connector. */
export function resolveConnectorToolIdentity(
  part: DynamicToolUIPart,
  identities: ConnectorToolIdentity[],
): ConnectorToolIdentity | null {
  const capability = capabilityName(part);
  if (capability) {
    if (capability.startsWith("mcp:")) {
      const connectionId = capability.split(":")[1]?.trim();
      if (connectionId) {
        const match = identities.find((identity) => identity.connectionId === connectionId);
        if (match) return match;
      }
    }

    const normalizedCapability = normalized(capability);
    const native = NATIVE_CONNECTOR_IDENTITIES.find((identity) => (
      normalizedCapability.includes(normalized(identity.name))
    ));
    if (native) return native;

    const named = identities.find((identity) => (
      normalizedCapability.startsWith(normalized(identity.name))
    ));
    if (named) return named;
  }

  const namespaceMatch = identities
    .filter((identity) => identity.toolNamespace)
    .sort((left, right) => (right.toolNamespace?.length ?? 0) - (left.toolNamespace?.length ?? 0))
    .find((identity) => (
      part.toolName === identity.toolNamespace
      || part.toolName.startsWith(`${identity.toolNamespace}_`)
    ));
  return namespaceMatch ?? null;
}
