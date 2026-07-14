"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRequestError, requestJson } from "../../_lib/den-flow";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

const ORG_SCOPE_HEADER = "x-openwork-org-id";

function getOrgScopeHeaders(orgId: string) {
  return { [ORG_SCOPE_HEADER]: orgId };
}

function requireOrgId(orgId: string | null) {
  if (!orgId) {
    throw new Error("Select an organization before managing connections.");
  }
  return orgId;
}

export type ExternalMcpAuthType = "oauth" | "apikey" | "none";
export type ExternalMcpCredentialMode = "shared" | "per_member";
export type ExternalMcpConnectionScope = "usable" | "manageable";

export type ExternalMcpAccessSummary = {
  orgWide: boolean;
  memberIds: string[];
  teamIds: string[];
  marketplaceIds?: string[];
};

export type ExternalMcpRequiredBy = {
  pluginId: string;
  name: string;
};

export type ExternalMcpConnection = {
  id: string;
  name: string;
  url: string;
  authType: ExternalMcpAuthType;
  credentialMode: ExternalMcpCredentialMode;
  connected: boolean;
  connectedAt: string | null;
  updatedAt: string | null;
  connectedForMe: boolean;
  needsReconnect?: boolean;
  missingFeatures?: string[];
  externalAccountId?: string | null;
  grantedScopes?: string[];
  requestedOAuthScopes?: string[];
  tenantId?: string | null;
  requiredBy: ExternalMcpRequiredBy[];
  identityManagedBy: ExternalMcpRequiredBy[];
  /** Direct assignments edited from the Connections dialog. */
  access: ExternalMcpAccessSummary | null;
  /** Effective assignments inherited from marketplace/plugin bindings. */
  inheritedAccess: ExternalMcpAccessSummary | null;
  oauthClientId?: string | null;
};

export type ExternalMcpTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
};

export type ExternalMcpPreset = {
  presetId: string;
  displayName: string;
  description: string;
  url: string;
  authType: ExternalMcpAuthType;
  requiresOAuthClient?: boolean;
};

export type ExternalMcpDiscoveryEvidenceSource =
  | "live_protocol"
  | "oauth_metadata"
  | "plugin_manifest"
  | "openwork_preset"
  | "unknown";

export type ExternalMcpDiscoveryConfidence = "verified" | "declared" | "curated" | "inferred" | "unknown";

export type ExternalMcpDiscoveryInput = {
  id: string;
  label: string;
  placement: "api_key" | "argument" | "environment" | "header" | "oauth_client_id" | "oauth_client_secret" | "url";
  required: boolean;
  secret: boolean;
  source: ExternalMcpDiscoveryEvidenceSource;
  supported: boolean;
  variable: string | null;
};

export type ExternalMcpOAuthDiscovery = {
  authorizationServer: string | null;
  clientIdRequired: boolean;
  clientSecretRequired: boolean;
  documentationUrl: string | null;
  pkce: "s256" | "missing" | "unknown";
  registration: "dynamic" | "client_metadata_document" | "pre_registered" | "unknown";
  scopes: string[];
  scopesSource: "challenge" | "protected_resource" | "plugin_manifest" | "authorization_server" | "none";
};

export type ExternalMcpConfigurationDiscovery = {
  auth: {
    confidence: ExternalMcpDiscoveryConfidence;
    kind: ExternalMcpAuthType | "unknown";
    source: ExternalMcpDiscoveryEvidenceSource;
  };
  inputs: ExternalMcpDiscoveryInput[];
  oauth: ExternalMcpOAuthDiscovery | null;
  support: {
    status: "auto_configurable" | "needs_manual_oauth_client" | "needs_review" | "needs_values" | "unsupported";
  };
  transport: {
    kind: "remote_http";
    supported: boolean;
    url: string;
  };
  warnings: string[];
};

export type CreatedMcpConnection = ExternalMcpConnection & {
  links?: {
    yourConnections?: string;
    oauthCallback?: string;
  };
};

export function isNativeProviderConnectionId(id: string): boolean {
  return id === "google-workspace" || id === "microsoft-365";
}

type DisconnectableMcpAccount = Pick<ExternalMcpConnection, "id" | "connectedForMe" | "credentialMode">;

export function canDisconnectMyMcpAccount(connection: DisconnectableMcpAccount): boolean {
  return connection.connectedForMe
    && (isNativeProviderConnectionId(connection.id) || connection.credentialMode === "per_member");
}

export function myMcpAccountDisconnectPath(connection: Pick<ExternalMcpConnection, "id" | "credentialMode">): string {
  if (isNativeProviderConnectionId(connection.id)) {
    return `/v1/oauth-providers/${encodeURIComponent(connection.id)}/disconnect`;
  }
  if (connection.credentialMode === "per_member") {
    return `/v1/mcp-connections/${encodeURIComponent(connection.id)}/my-account/disconnect`;
  }
  throw new Error("Only per-member MCP connections have a personal account to disconnect.");
}

export const mcpConnectionQueryKeys = {
  all: ["mcp-connections"] as const,
  list: (orgId?: string | null, scope?: ExternalMcpConnectionScope) =>
    [...mcpConnectionQueryKeys.all, "list", orgId ?? "none", scope ?? "usable"] as const,
  presets: () => [...mcpConnectionQueryKeys.all, "presets"] as const,
  tools: (orgId?: string | null, connectionId?: string | null) =>
    [...mcpConnectionQueryKeys.all, "tools", orgId ?? "none", connectionId ?? "none"] as const,
  discovery: (orgId?: string | null) => [...mcpConnectionQueryKeys.all, "discovery", orgId ?? "none"] as const,
  nativeProviderClient: (orgId?: string | null, providerId?: string | null) =>
    [...mcpConnectionQueryKeys.all, "native-provider-client", orgId ?? "none", providerId ?? "none"],
  telegram: (orgId?: string | null) => [...mcpConnectionQueryKeys.all, "telegram", orgId ?? "none"] as const,
};

export function useMcpConnectionTools(connectionId: string, enabled: boolean) {
  const { orgId } = useOrgDashboard();
  return useQuery({
    enabled: enabled && Boolean(orgId),
    queryKey: mcpConnectionQueryKeys.tools(orgId, connectionId),
    queryFn: async (): Promise<ExternalMcpTool[]> => {
      const { response, payload } = await requestJson(
        `/v1/mcp-connections/${encodeURIComponent(connectionId)}/tools`,
        { headers: getOrgScopeHeaders(requireOrgId(orgId)) },
        30000,
      );
      if (!response.ok) {
        throw getRequestError(payload, response, `Failed to inspect MCP tools (${response.status}).`);
      }
      const record = payload as { tools?: ExternalMcpTool[] };
      return record.tools ?? [];
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function httpUrlOrNull(value: unknown): string | null {
  const raw = stringOrNull(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function parseDiscoveryEvidenceSource(value: unknown): ExternalMcpDiscoveryEvidenceSource | null {
  if (value === "live_protocol" || value === "oauth_metadata" || value === "plugin_manifest" || value === "openwork_preset" || value === "unknown") {
    return value;
  }
  return null;
}

function parseDiscoveryConfidence(value: unknown): ExternalMcpDiscoveryConfidence | null {
  if (value === "verified" || value === "declared" || value === "curated" || value === "inferred" || value === "unknown") {
    return value;
  }
  return null;
}

function parseDiscoveryInput(value: unknown): ExternalMcpDiscoveryInput | null {
  if (!isRecord(value)) return null;
  const id = stringOrNull(value.id);
  const label = stringOrNull(value.label);
  const source = parseDiscoveryEvidenceSource(value.source);
  const variable = value.variable === null ? null : stringOrNull(value.variable);
  const placement = value.placement;
  if (
    !id
    || !label
    || !source
    || (placement !== "api_key" && placement !== "argument" && placement !== "environment" && placement !== "header" && placement !== "oauth_client_id" && placement !== "oauth_client_secret" && placement !== "url")
    || typeof value.required !== "boolean"
    || typeof value.secret !== "boolean"
    || typeof value.supported !== "boolean"
  ) {
    return null;
  }
  return {
    id,
    label,
    placement,
    required: value.required,
    secret: value.secret,
    source,
    supported: value.supported,
    variable,
  };
}

function parseOAuthDiscovery(value: unknown): ExternalMcpOAuthDiscovery | null {
  if (!isRecord(value)) return null;
  const registration = value.registration;
  const pkce = value.pkce;
  const scopesSource = value.scopesSource;
  if (
    typeof value.clientIdRequired !== "boolean"
    || typeof value.clientSecretRequired !== "boolean"
    || !isStringArray(value.scopes)
    || (registration !== "dynamic" && registration !== "client_metadata_document" && registration !== "pre_registered" && registration !== "unknown")
    || (pkce !== "s256" && pkce !== "missing" && pkce !== "unknown")
    || (scopesSource !== "challenge" && scopesSource !== "protected_resource" && scopesSource !== "plugin_manifest" && scopesSource !== "authorization_server" && scopesSource !== "none")
  ) {
    return null;
  }
  return {
    authorizationServer: value.authorizationServer === null ? null : httpUrlOrNull(value.authorizationServer),
    clientIdRequired: value.clientIdRequired,
    clientSecretRequired: value.clientSecretRequired,
    documentationUrl: value.documentationUrl === null ? null : httpUrlOrNull(value.documentationUrl),
    pkce,
    registration,
    scopes: value.scopes,
    scopesSource,
  };
}

export function parseExternalMcpConfigurationDiscovery(value: unknown): ExternalMcpConfigurationDiscovery | null {
  if (!isRecord(value) || !isRecord(value.auth) || !isRecord(value.support) || !isRecord(value.transport)) return null;
  const confidence = parseDiscoveryConfidence(value.auth.confidence);
  const source = parseDiscoveryEvidenceSource(value.auth.source);
  const kind = value.auth.kind;
  const status = value.support.status;
  const url = stringOrNull(value.transport.url);
  const inputs = Array.isArray(value.inputs) ? value.inputs.map(parseDiscoveryInput) : [];
  if (
    !confidence
    || !source
    || (kind !== "oauth" && kind !== "apikey" && kind !== "none" && kind !== "unknown")
    || (status !== "auto_configurable" && status !== "needs_manual_oauth_client" && status !== "needs_review" && status !== "needs_values" && status !== "unsupported")
    || value.transport.kind !== "remote_http"
    || typeof value.transport.supported !== "boolean"
    || !url
    || !Array.isArray(value.inputs)
    || inputs.some((input) => input === null)
    || !isStringArray(value.warnings)
  ) {
    return null;
  }
  const oauth = value.oauth === null ? null : parseOAuthDiscovery(value.oauth);
  if (value.oauth !== null && !oauth) return null;
  return {
    auth: { confidence, kind, source },
    inputs: inputs.filter((input): input is ExternalMcpDiscoveryInput => input !== null),
    oauth,
    support: { status },
    transport: { kind: "remote_http", supported: value.transport.supported, url },
    warnings: value.warnings,
  };
}

export function parseExternalMcpDiscoveryPayload(payload: unknown): ExternalMcpConfigurationDiscovery {
  const discovery = isRecord(payload) ? parseExternalMcpConfigurationDiscovery(payload.discovery) : null;
  if (!discovery) throw new Error("MCP discovery response was incomplete.");
  return discovery;
}

function parseRequiredBy(value: unknown): ExternalMcpRequiredBy[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.pluginId !== "string" || typeof entry.name !== "string") return [];
    return [{ pluginId: entry.pluginId, name: entry.name }];
  });
}

function parseAccessSummary(value: unknown): ExternalMcpAccessSummary | null {
  if (!isRecord(value)
    || typeof value.orgWide !== "boolean"
    || !isStringArray(value.memberIds)
    || !isStringArray(value.teamIds)
    || !(value.marketplaceIds === undefined || isStringArray(value.marketplaceIds))) return null;
  return {
    orgWide: value.orgWide,
    memberIds: [...new Set(value.memberIds)],
    teamIds: [...new Set(value.teamIds)],
    marketplaceIds: [...new Set(value.marketplaceIds ?? [])],
  };
}

async function fetchConnections(scope: ExternalMcpConnectionScope, orgId: string): Promise<ExternalMcpConnection[]> {
  const { response, payload } = await requestJson(
    `/v1/mcp-connections?scope=${scope}`,
    { headers: getOrgScopeHeaders(orgId) },
    15000,
  );
  if (!response.ok) {
    throw getRequestError(payload, response, `Failed to load MCP connections (${response.status}).`);
  }
  const record = payload as { connections?: ExternalMcpConnection[] };
  return (record.connections ?? []).map((connection) => ({
    ...connection,
    requiredBy: parseRequiredBy(connection.requiredBy),
    identityManagedBy: parseRequiredBy(connection.identityManagedBy),
    access: parseAccessSummary(connection.access),
    inheritedAccess: parseAccessSummary(connection.inheritedAccess),
    updatedAt: typeof connection.updatedAt === "string" ? connection.updatedAt : null,
    ...(typeof connection.needsReconnect === "boolean" ? { needsReconnect: connection.needsReconnect } : {}),
    ...(isStringArray(connection.missingFeatures) ? { missingFeatures: connection.missingFeatures } : {}),
    ...(typeof connection.externalAccountId === "string" || connection.externalAccountId === null
      ? { externalAccountId: connection.externalAccountId }
      : {}),
    ...(isStringArray(connection.grantedScopes) ? { grantedScopes: connection.grantedScopes } : {}),
    ...(isStringArray(connection.requestedOAuthScopes) ? { requestedOAuthScopes: connection.requestedOAuthScopes } : {}),
    ...(typeof connection.tenantId === "string" || connection.tenantId === null ? { tenantId: connection.tenantId } : {}),
  }));
}

export function useMcpConnections(scope: ExternalMcpConnectionScope = "manageable") {
  const { orgId } = useOrgDashboard();
  return useQuery({
    enabled: Boolean(orgId),
    queryKey: mcpConnectionQueryKeys.list(orgId, scope),
    queryFn: () => fetchConnections(scope, requireOrgId(orgId)),
  });
}

export function useMcpConnectionPresets() {
  return useQuery({
    queryKey: mcpConnectionQueryKeys.presets(),
    queryFn: async (): Promise<ExternalMcpPreset[]> => {
      const { response, payload } = await requestJson("/v1/mcp-connections/presets", {}, 15000);
      if (!response.ok) {
        throw getRequestError(payload, response, `Failed to load MCP presets (${response.status}).`);
      }
      const record = payload as { presets?: ExternalMcpPreset[] };
      return record.presets ?? [];
    },
  });
}

export function useDiscoverMcpConnection() {
  const { orgId, runReauthableAction } = useOrgDashboard();

  return useMutation({
    mutationKey: mcpConnectionQueryKeys.discovery(orgId),
    mutationFn: async (input: { url: string; manifest?: Record<string, unknown> }): Promise<ExternalMcpConfigurationDiscovery> => {
      let discovery: ExternalMcpConfigurationDiscovery | null = null;
      await runReauthableAction("discover-mcp-connection", async () => {
        const { response, payload } = await requestJson(
          "/v1/mcp-connections/discover",
          {
            method: "POST",
            headers: getOrgScopeHeaders(requireOrgId(orgId)),
            body: JSON.stringify(input),
          },
          20000,
        );
        if (!response.ok) {
          throw getRequestError(payload, response, `Failed to inspect MCP server (${response.status}).`);
        }
        discovery = parseExternalMcpDiscoveryPayload(payload);
      });
      if (!discovery) throw new Error("MCP discovery response was incomplete.");
      return discovery;
    },
  });
}

export type McpConnectionAccessInput = {
  orgWide: boolean;
  memberIds: string[];
  teamIds: string[];
  marketplaceIds?: string[];
};

export type CreateMcpConnectionInput = {
  name: string;
  url: string;
  authType: ExternalMcpAuthType;
  credentialMode: ExternalMcpCredentialMode;
  apiKey?: string;
  oauthClient?: {
    clientId: string;
    clientSecret?: string;
  };
  requestedOAuthScopes?: string[];
  access: McpConnectionAccessInput;
};

export type UpdateMcpConnectionInput = {
  connectionId: string;
  expectedUpdatedAt: string;
  name: string;
  url: string;
  authType: ExternalMcpAuthType;
  credentialMode: ExternalMcpCredentialMode;
  apiKey?: string;
  oauthClient?: {
    clientId: string;
    clientSecret?: string;
  };
  access: McpConnectionAccessInput;
};

export type UpdatedMcpConnection = ExternalMcpConnection & {
  identityChanged: boolean;
  reconnectionRequired: boolean;
};

export function useCreateMcpConnection() {
  const queryClient = useQueryClient();
  const { orgId, runReauthableAction } = useOrgDashboard();

  return useMutation({
    mutationFn: async (input: CreateMcpConnectionInput): Promise<CreatedMcpConnection> => {
      let created: CreatedMcpConnection | null = null;
      await runReauthableAction("create-mcp-connection", async () => {
        const { response, payload } = await requestJson(
          "/v1/mcp-connections",
          { method: "POST", headers: getOrgScopeHeaders(requireOrgId(orgId)), body: JSON.stringify(input) },
          20000,
        );
        if (!response.ok) {
          throw getRequestError(payload, response, `Failed to add MCP connection (${response.status}).`);
        }
        created = payload as CreatedMcpConnection;
      });
      if (!created) throw new Error("Create MCP connection response was incomplete.");
      return created;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: mcpConnectionQueryKeys.all });
    },
  });
}

export function useUpdateMcpConnection() {
  const queryClient = useQueryClient();
  const { orgId, runReauthableAction } = useOrgDashboard();

  return useMutation({
    mutationFn: async (input: UpdateMcpConnectionInput): Promise<UpdatedMcpConnection> => {
      let updated: UpdatedMcpConnection | null = null;
      await runReauthableAction("update-mcp-connection", async () => {
        const { connectionId, ...body } = input;
        const { response, payload } = await requestJson(
          `/v1/mcp-connections/${encodeURIComponent(connectionId)}`,
          { method: "PUT", headers: getOrgScopeHeaders(requireOrgId(orgId)), body: JSON.stringify(body) },
          30000,
        );
        if (!response.ok) {
          throw getRequestError(payload, response, `Failed to update MCP connection (${response.status}).`);
        }
        updated = payload as UpdatedMcpConnection;
      });
      if (!updated) throw new Error("Update MCP connection response was incomplete.");
      return updated;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: mcpConnectionQueryKeys.all });
    },
  });
}

export function useReplaceMcpConnectionAccess() {
  const queryClient = useQueryClient();
  const { orgId, runReauthableAction } = useOrgDashboard();

  return useMutation({
    mutationFn: async (input: { connectionId: string; access: McpConnectionAccessInput }): Promise<string> => {
      let result: string | null = null;
      await runReauthableAction("replace-mcp-connection-access", async () => {
        const { response, payload } = await requestJson(
          `/v1/mcp-connections/${encodeURIComponent(input.connectionId)}/access`,
          { method: "PUT", headers: getOrgScopeHeaders(requireOrgId(orgId)), body: JSON.stringify({ access: input.access }) },
          15000,
        );
        if (!response.ok) {
          throw getRequestError(payload, response, `Failed to update connection access (${response.status}).`);
        }
        result = input.connectionId;
      });
      if (!result) throw new Error("Update connection access response was incomplete.");
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: mcpConnectionQueryKeys.all });
    },
  });
}

export function useStartMcpConnectionOAuth() {
  const { orgId } = useOrgDashboard();

  return useMutation({
    mutationFn: async (connectionId: string): Promise<{ status: "connected" | "needs_auth"; authorizeUrl: string | null }> => {
      const { response, payload } = await requestJson(
        `/v1/mcp-connections/${encodeURIComponent(connectionId)}/connect/start`,
        { headers: getOrgScopeHeaders(requireOrgId(orgId)) },
        20000,
      );
      if (!response.ok) {
        throw getRequestError(payload, response, `Failed to start OAuth (${response.status}).`);
      }
      return payload as { status: "connected" | "needs_auth"; authorizeUrl: string | null };
    },
  });
}

export function useDisconnectMyMcpAccount() {
  const queryClient = useQueryClient();
  const { orgId } = useOrgDashboard();

  return useMutation({
    mutationFn: async (connection: Pick<ExternalMcpConnection, "id" | "credentialMode">): Promise<string> => {
      const { response, payload } = await requestJson(
        myMcpAccountDisconnectPath(connection),
        { method: "POST", headers: getOrgScopeHeaders(requireOrgId(orgId)) },
        15000,
      );
      if (!response.ok) {
        throw getRequestError(payload, response, `Failed to disconnect account (${response.status}).`);
      }
      return connection.id;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: mcpConnectionQueryKeys.all });
    },
  });
}

export function useDeleteMcpConnection() {
  const queryClient = useQueryClient();
  const { orgId, runReauthableAction } = useOrgDashboard();

  return useMutation({
    mutationFn: async (connectionId: string): Promise<string> => {
      let result: string | null = null;
      await runReauthableAction("delete-mcp-connection", async () => {
        const { response, payload } = await requestJson(
          `/v1/mcp-connections/${encodeURIComponent(connectionId)}`,
          { method: "DELETE", headers: getOrgScopeHeaders(requireOrgId(orgId)) },
          15000,
        );
        if (!response.ok) {
          throw getRequestError(payload, response, `Failed to remove MCP connection (${response.status}).`);
        }
        result = connectionId;
      });
      if (!result) throw new Error("Delete MCP connection response was incomplete.");
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: mcpConnectionQueryKeys.all });
    },
  });
}

export type SaveNativeProviderClientInput = {
  providerId: string;
  clientId?: string;
  clientSecret?: string;
  tenantId?: string;
  features: string[];
};

export type NativeProviderClient = {
  providerId: string;
  configured: boolean;
  clientId: string | null;
  tenantId: string | null;
  features: string[];
  scopes: string[];
  redirectUri: string;
};

function parseNativeProviderClient(payload: unknown): NativeProviderClient {
  if (!isRecord(payload)) {
    throw new Error("Native provider client response was incomplete.");
  }
  const { providerId, configured, clientId, tenantId, features, scopes, redirectUri } = payload;
  if (
    typeof providerId !== "string"
    || typeof configured !== "boolean"
    || (typeof clientId !== "string" && clientId !== null)
    || (typeof tenantId !== "string" && tenantId !== null)
    || !isStringArray(features)
    || !isStringArray(scopes)
    || typeof redirectUri !== "string"
  ) {
    throw new Error("Native provider client response was incomplete.");
  }
  return { providerId, configured, clientId, tenantId, features, scopes, redirectUri };
}

/**
 * Native providers are configured with an org OAuth
 * client instead of a server URL. Saving one makes the provider appear in
 * the usable connections list for every granted member.
 */
export function useSaveNativeProviderClient() {
  const queryClient = useQueryClient();
  const { orgId, runReauthableAction } = useOrgDashboard();

  return useMutation({
    mutationFn: async (input: SaveNativeProviderClientInput): Promise<void> => {
      await runReauthableAction("save-native-oauth-client", async () => {
        const clientId = input.clientId?.trim();
        const clientSecret = input.clientSecret?.trim();
        const tenantId = input.tenantId?.trim();
        const { response, payload } = await requestJson(
          `/v1/oauth-providers/${encodeURIComponent(input.providerId)}/client`,
          {
            method: "POST",
            headers: getOrgScopeHeaders(requireOrgId(orgId)),
            body: JSON.stringify({
              ...(clientId ? { clientId } : {}),
              ...(clientSecret ? { clientSecret } : {}),
              ...(tenantId ? { tenantId } : {}),
              features: input.features,
            }),
          },
          20000,
        );
        if (!response.ok) {
          throw getRequestError(payload, response, `Failed to save the OAuth client (${response.status}).`);
        }
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: mcpConnectionQueryKeys.all });
    },
  });
}

export function useNativeProviderClient(providerId: string, enabled: boolean) {
  const { orgId, runReauthableAction } = useOrgDashboard();

  return useQuery({
    enabled: enabled && Boolean(orgId),
    queryKey: mcpConnectionQueryKeys.nativeProviderClient(orgId, providerId),
    retry: false,
    queryFn: async (): Promise<NativeProviderClient> => {
      let client: NativeProviderClient | null = null;
      await runReauthableAction("load-native-oauth-client", async () => {
        const { response, payload } = await requestJson(
          `/v1/oauth-providers/${encodeURIComponent(providerId)}/client`,
          { headers: getOrgScopeHeaders(requireOrgId(orgId)) },
          15000,
        );
        if (!response.ok) {
          throw getRequestError(payload, response, `Failed to load the OAuth client (${response.status}).`);
        }
        client = parseNativeProviderClient(payload);
      });
      if (!client) {
        throw new Error("Native provider client response was incomplete.");
      }
      return client;
    },
  });
}

export type TelegramConnection = {
  id: string;
  status: "active" | "error";
  connected: boolean;
  bot: { id: string; username: string | null; displayName: string };
  worker: { id: string; name: string; status: string };
  webhook: { registered: boolean; lastReceivedAt: string | null; lastError: string | null };
  pairing: {
    paired: boolean;
    chat: { username: string | null; firstName: string | null; pairedAt: string } | null;
  };
  createdAt: string;
  updatedAt: string;
};

export type TelegramPairing = {
  url: string;
  code: string;
  expiresAt: string;
};

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error("Telegram connection response was incomplete.");
  return value;
}

function nullableString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value !== "string" && value !== null) throw new Error("Telegram connection response was incomplete.");
  return value;
}

function parseTelegramConnectionValue(value: unknown): TelegramConnection {
  if (!isRecord(value) || !isRecord(value.bot) || !isRecord(value.worker) || !isRecord(value.webhook) || !isRecord(value.pairing)) {
    throw new Error("Telegram connection response was incomplete.");
  }
  const { bot, worker, webhook, pairing } = value;
  const chat = pairing.chat;
  if (
    (value.status !== "active" && value.status !== "error")
    || typeof value.connected !== "boolean"
    || typeof webhook.registered !== "boolean"
    || typeof pairing.paired !== "boolean"
    || (chat !== null && !isRecord(chat))
  ) {
    throw new Error("Telegram connection response was incomplete.");
  }
  return {
    id: requiredString(value, "id"),
    status: value.status,
    connected: value.connected,
    bot: {
      id: requiredString(bot, "id"),
      username: nullableString(bot, "username"),
      displayName: requiredString(bot, "displayName"),
    },
    worker: {
      id: requiredString(worker, "id"),
      name: requiredString(worker, "name"),
      status: requiredString(worker, "status"),
    },
    webhook: {
      registered: webhook.registered,
      lastReceivedAt: nullableString(webhook, "lastReceivedAt"),
      lastError: nullableString(webhook, "lastError"),
    },
    pairing: {
      paired: pairing.paired,
      chat: chat === null ? null : {
        username: nullableString(chat, "username"),
        firstName: nullableString(chat, "firstName"),
        pairedAt: requiredString(chat, "pairedAt"),
      },
    },
    createdAt: requiredString(value, "createdAt"),
    updatedAt: requiredString(value, "updatedAt"),
  };
}

function parseTelegramConnectionPayload(payload: unknown): TelegramConnection | null {
  if (!isRecord(payload) || !("connection" in payload)) {
    throw new Error("Telegram connection response was incomplete.");
  }
  return payload.connection === null ? null : parseTelegramConnectionValue(payload.connection);
}

export function useTelegramConnection(enabled: boolean) {
  const { orgId, runReauthableAction } = useOrgDashboard();
  return useQuery({
    enabled: enabled && Boolean(orgId),
    queryKey: mcpConnectionQueryKeys.telegram(orgId),
    retry: false,
    queryFn: async (): Promise<TelegramConnection | null> => {
      let connection: TelegramConnection | null = null;
      let loaded = false;
      await runReauthableAction("load-telegram-connection", async () => {
        const { response, payload } = await requestJson(
          "/v1/telegram/connection",
          { headers: getOrgScopeHeaders(requireOrgId(orgId)) },
          15000,
        );
        if (!response.ok) throw getRequestError(payload, response, `Failed to load Telegram (${response.status}).`);
        connection = parseTelegramConnectionPayload(payload);
        loaded = true;
      });
      if (!loaded) throw new Error("Telegram connection response was incomplete.");
      return connection;
    },
  });
}

export function useSaveTelegramConnection() {
  const queryClient = useQueryClient();
  const { orgId, runReauthableAction } = useOrgDashboard();
  return useMutation({
    mutationFn: async (input: { botToken: string; workerId: string }): Promise<TelegramConnection> => {
      let connection: TelegramConnection | null = null;
      await runReauthableAction("save-telegram-connection", async () => {
        const { response, payload } = await requestJson(
          "/v1/telegram/connection",
          { method: "PUT", headers: getOrgScopeHeaders(requireOrgId(orgId)), body: JSON.stringify(input) },
          30000,
        );
        if (!response.ok) throw getRequestError(payload, response, `Failed to connect Telegram (${response.status}).`);
        connection = parseTelegramConnectionPayload(payload);
      });
      if (!connection) throw new Error("Telegram connection response was incomplete.");
      return connection;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: mcpConnectionQueryKeys.telegram(orgId) }),
  });
}

export function useCreateTelegramPairing() {
  const queryClient = useQueryClient();
  const { orgId, runReauthableAction } = useOrgDashboard();
  return useMutation({
    mutationFn: async (): Promise<TelegramPairing> => {
      let pairing: TelegramPairing | null = null;
      await runReauthableAction("create-telegram-pairing", async () => {
        const { response, payload } = await requestJson(
          "/v1/telegram/connection/pairing",
          { method: "POST", headers: getOrgScopeHeaders(requireOrgId(orgId)), body: JSON.stringify({}) },
          15000,
        );
        if (!response.ok) throw getRequestError(payload, response, `Failed to create Telegram pairing (${response.status}).`);
        if (!isRecord(payload) || !isRecord(payload.pairing)) throw new Error("Telegram pairing response was incomplete.");
        pairing = {
          url: requiredString(payload.pairing, "url"),
          code: requiredString(payload.pairing, "code"),
          expiresAt: requiredString(payload.pairing, "expiresAt"),
        };
      });
      if (!pairing) throw new Error("Telegram pairing response was incomplete.");
      return pairing;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: mcpConnectionQueryKeys.telegram(orgId) }),
  });
}

export function useDeleteTelegramConnection() {
  const queryClient = useQueryClient();
  const { orgId, runReauthableAction } = useOrgDashboard();
  return useMutation({
    mutationFn: async (): Promise<void> => {
      await runReauthableAction("delete-telegram-connection", async () => {
        const { response, payload } = await requestJson(
          "/v1/telegram/connection",
          { method: "DELETE", headers: getOrgScopeHeaders(requireOrgId(orgId)) },
          20000,
        );
        if (!response.ok) throw getRequestError(payload, response, `Failed to disconnect Telegram (${response.status}).`);
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: mcpConnectionQueryKeys.telegram(orgId) }),
  });
}

export function formatMcpConnectedTimestamp(value: string | null): string {
  if (!value) return "Not connected";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not connected";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(date);
}
