"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRequestError, requestJson } from "../../_lib/den-flow";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import {
  type ExternalMcpDiagnostic,
  parseExternalMcpDiagnostic,
} from "./mcp-tool-error-attribution";
import type { McpAuthorizationDebugDetails } from "./mcp-authorization-url";

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
  /** True when granted members may use this connection as a standard MCP server with its own tool catalog. */
  exposeDirectly: boolean;
  connected: boolean;
  connectedAt: string | null;
  createdByName?: string | null;
  updatedAt: string | null;
  connectedForMe: boolean;
  needsReconnect?: boolean;
  credentialHealth?: "unknown" | "ready" | "reconnect_required";
  credentialHealthReason?: "authorization_rejected" | "credential_expired" | "post_authorization_validation_failed" | null;
  credentialHealthCheckedAt?: string | null;
  issuerReviewRequired?: boolean;
  reconnectActionOwner?: "member" | "organization_admin" | null;
  missingFeatures?: string[];
  externalAccountId?: string | null;
  nativeProviderKey?: string | null;
  grantedScopes?: string[];
  tenantId?: string | null;
  requiredBy: ExternalMcpRequiredBy[];
  identityManagedBy: ExternalMcpRequiredBy[];
  requiredAuthType?: ExternalMcpAuthType | null;
  authPolicyConfirmed?: boolean;
  authTypeMismatch?: boolean;
  oauthClientConfigured?: boolean;
  oauthClientRequired?: boolean;
  setupRequired?: boolean;
  access: ExternalMcpAccessSummary | null;
  oauthClientId?: string | null;
  oauthCallbackUrl?: string | null;
  oauthSharedCallbackUrl?: string | null;
  oauthClientMetadataUrl?: string | null;
  oauthCallbackMode?: "shared-v1" | "isolated-v1" | "legacy-v1" | null;
  oauthRegistrationSource?: "pre-registered" | "client-metadata" | "dynamic" | null;
  authorizationServerIssuer?: string | null;
  requestedScopes?: string[];
};

export type McpRequirementsDiscovery = {
  status: "ready" | "manual_action_required" | "unsupported" | "unreachable";
  server: {
    url: string;
    protocolVersion?: string;
    initialize: "succeeded" | "authentication_required" | "failed";
  };
  authentication: {
    kind: "none" | "oauth" | "manual_bearer" | "unknown";
    resource?: string;
    protectedResourceMetadataUrl?: string;
    authorizationServers: Array<{
      issuer: string;
      authorizationEndpoint?: string;
      tokenEndpoint?: string;
      registrationEndpoint?: string;
      clientIdMetadataDocumentSupported: boolean;
      scopesSupported?: string[];
      grantTypesSupported?: string[];
      codeChallengeMethodsSupported?: string[];
      tokenEndpointAuthMethodsSupported?: string[];
    }>;
    requiredScopes: string[];
    recommendedScopes: string[];
    refreshSupport: "supported" | "not_advertised" | "unknown";
    availableRegistrationMethods: Array<"pre_registered" | "client_metadata" | "dynamic">;
    recommendedRegistrationMethod: "client_metadata" | "dynamic" | "pre_registered";
  };
  tools: {
    visibility: "available_without_auth" | "requires_auth" | "unavailable";
    count?: number;
    items?: Array<{
      name: string;
      readOnlyHint?: boolean;
      destructiveHint?: boolean;
      openWorldHint?: boolean;
    }>;
  };
  manualRequirements: Array<{ code: string; label: string; reason: string; required: boolean }>;
  warnings: Array<{ code: string; message: string }>;
};

export type McpIssuerReview = {
  currentIssuer: string | null;
  advertisedIssuers: string[];
  reviewRequired: boolean;
  issuerChanged?: boolean;
  reconnectionRequired?: boolean;
  updatedAt?: string;
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

export type ExternalMcpToolPolicyView = {
  allDisabled: boolean;
  disabledTools: string[];
  updatedBy: string | null;
  updatedAt: string | null;
};

export type ExternalMcpToolCatalog = {
  tools: ExternalMcpTool[];
  policy: ExternalMcpToolPolicyView;
};

export type ExternalMcpToolRun = {
  referenceId: string;
  durationMs: number;
  result: unknown;
  inspection: ExternalMcpToolCallInspection | null;
};

export type ExternalMcpInspectionHeader = {
  name: string;
  value: string;
  redacted: boolean;
};

export type ExternalMcpInspectionBody = {
  text: string;
  bytes: number;
  truncated: boolean;
  unavailable?: boolean;
};

export type ExternalMcpToolCallInspection = {
  request?: {
    method: string;
    url: string;
    startedAt: string;
    headers: ExternalMcpInspectionHeader[];
    body: ExternalMcpInspectionBody;
  };
  response?: {
    status: number;
    statusText: string;
    durationMs: number;
    headers: ExternalMcpInspectionHeader[];
    body: ExternalMcpInspectionBody;
  };
  diagnosis: {
    status: "succeeded" | "failed";
    layer: "openwork" | "network" | "mcp_connection" | "remote_http" | "mcp_tool";
    summary: string;
  };
};

export class ExternalMcpToolRunError extends Error {
  readonly inspection: ExternalMcpToolCallInspection | null;
  readonly diagnostic: ExternalMcpDiagnostic | null;

  constructor(
    message: string,
    inspection: ExternalMcpToolCallInspection | null,
    diagnostic: ExternalMcpDiagnostic | null,
  ) {
    super(message);
    this.name = "ExternalMcpToolRunError";
    this.inspection = inspection;
    this.diagnostic = diagnostic;
  }
}

export class ExternalMcpToolPolicyBlockedError extends ExternalMcpToolRunError {
  readonly disabledBy: string | null;
  readonly disabledAt: string | null;

  constructor(message: string, disabledBy: string | null, disabledAt: string | null) {
    super(message, null, null);
    this.name = "ExternalMcpToolPolicyBlockedError";
    this.disabledBy = disabledBy;
    this.disabledAt = disabledAt;
  }
}

export type ExternalMcpPreset = {
  presetId: string;
  displayName: string;
  description: string;
  url: string;
  authType: ExternalMcpAuthType;
  requiresOAuthClient?: boolean;
};

export type CreatedMcpConnection = ExternalMcpConnection & {
  links?: {
    yourConnections?: string;
    oauthCallback?: string;
  };
};

export function isNativeProviderConnectionId(id: string, nativeProviderKey?: string | null): boolean {
  return nativeProviderKey != null || id === "google-workspace" || id === "microsoft-365";
}

export function canDisconnectMyConnectionAccount(connection: Pick<ExternalMcpConnection, "id" | "nativeProviderKey" | "credentialMode" | "connectedForMe">): boolean {
  return connection.connectedForMe && (isNativeProviderConnectionId(connection.id, connection.nativeProviderKey) || connection.credentialMode === "per_member");
}

export const mcpConnectionQueryKeys = {
  all: ["mcp-connections"] as const,
  list: (orgId?: string | null, scope?: ExternalMcpConnectionScope) =>
    [...mcpConnectionQueryKeys.all, "list", orgId ?? "none", scope ?? "usable"] as const,
  presets: () => [...mcpConnectionQueryKeys.all, "presets"] as const,
  tools: (orgId?: string | null, connectionId?: string | null) =>
    [...mcpConnectionQueryKeys.all, "tools", orgId ?? "none", connectionId ?? "none"] as const,
  nativeProviderClient: (orgId?: string | null, providerId?: string | null) =>
    [...mcpConnectionQueryKeys.all, "native-provider-client", orgId ?? "none", providerId ?? "none"],
};

function isExternalMcpTool(value: unknown): value is ExternalMcpTool {
  if (!isRecord(value) || typeof value.name !== "string" || !isRecord(value.inputSchema)) return false;
  if (value.title !== undefined && typeof value.title !== "string") return false;
  if (value.description !== undefined && typeof value.description !== "string") return false;
  if (value.outputSchema !== undefined && !isRecord(value.outputSchema)) return false;
  const annotations = value.annotations;
  if (annotations === undefined) return true;
  if (!isRecord(annotations)) return false;
  return ["title", "readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"].every((key) => (
    annotations[key] === undefined
    || typeof annotations[key] === (key === "title" ? "string" : "boolean")
  ));
}

function parseExternalMcpToolPolicy(value: unknown): ExternalMcpToolPolicyView | null {
  if (
    !isRecord(value)
    || typeof value.allDisabled !== "boolean"
    || !Array.isArray(value.disabledTools)
    || !value.disabledTools.every((toolName) => typeof toolName === "string")
    || (value.updatedBy !== null && typeof value.updatedBy !== "string")
    || (value.updatedAt !== null && typeof value.updatedAt !== "string")
  ) return null;
  return {
    allDisabled: value.allDisabled,
    disabledTools: value.disabledTools,
    updatedBy: value.updatedBy,
    updatedAt: value.updatedAt,
  };
}

export function useMcpConnectionTools(connectionId: string, enabled: boolean) {
  const { orgId } = useOrgDashboard();
  return useQuery({
    enabled: enabled && Boolean(orgId),
    queryKey: mcpConnectionQueryKeys.tools(orgId, connectionId),
    queryFn: async (): Promise<ExternalMcpToolCatalog> => {
      const { response, payload } = await requestJson(
        `/v1/mcp-connections/${encodeURIComponent(connectionId)}/tools`,
        { headers: getOrgScopeHeaders(requireOrgId(orgId)) },
        30000,
      );
      if (!response.ok) {
        throw getRequestError(payload, response, `Failed to inspect MCP tools (${response.status}).`);
      }
      if (!isRecord(payload) || !Array.isArray(payload.tools)) {
        throw new Error("MCP tool catalog response was incomplete.");
      }
      const policy = parseExternalMcpToolPolicy(payload.policy);
      if (!policy || !payload.tools.every(isExternalMcpTool)) {
        throw new Error("MCP tool catalog response was incomplete.");
      }
      return { tools: payload.tools, policy };
    },
  });
}

export function useUpdateMcpConnectionToolPolicy(connectionId: string) {
  const queryClient = useQueryClient();
  const { orgId } = useOrgDashboard();
  return useMutation({
    mutationFn: async (input: Pick<ExternalMcpToolPolicyView, "allDisabled" | "disabledTools">): Promise<ExternalMcpToolPolicyView> => {
      const { response, payload } = await requestJson(
        `/v1/mcp-connections/${encodeURIComponent(connectionId)}/tool-policy`,
        {
          method: "PUT",
          headers: getOrgScopeHeaders(requireOrgId(orgId)),
          body: JSON.stringify(input),
        },
        30000,
      );
      if (!response.ok) {
        throw getRequestError(payload, response, `Failed to update MCP tool policy (${response.status}).`);
      }
      const policy = isRecord(payload) ? parseExternalMcpToolPolicy(payload.policy) : null;
      if (!policy) throw new Error("MCP tool policy response was incomplete.");
      return policy;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: mcpConnectionQueryKeys.tools(orgId, connectionId) }),
  });
}

// The den-api tool run is bounded by its 150s MCP tool lifecycle deadline;
// give the request a little headroom so the server's structured failure
// arrives instead of a client-side timeout.
const RUN_TOOL_REQUEST_TIMEOUT_MS = 160000;

export function useRunMcpConnectionTool(connectionId: string) {
  const { orgId } = useOrgDashboard();
  return useMutation({
    mutationFn: async (input: { toolName: string; arguments: Record<string, unknown> }): Promise<ExternalMcpToolRun> => {
      const { response, payload } = await requestJson(
        `/v1/mcp-connections/${encodeURIComponent(connectionId)}/tools/call`,
        {
          method: "POST",
          headers: getOrgScopeHeaders(requireOrgId(orgId)),
          body: JSON.stringify(input),
        },
        RUN_TOOL_REQUEST_TIMEOUT_MS,
      );
      if (!response.ok) {
        if (response.status === 403 && isRecord(payload) && payload.error === "policy_blocked") {
          throw new ExternalMcpToolPolicyBlockedError(
            typeof payload.message === "string" ? payload.message : "This tool is disabled by organization policy.",
            typeof payload.disabledBy === "string" ? payload.disabledBy : null,
            typeof payload.disabledAt === "string" ? payload.disabledAt : null,
          );
        }
        const requestError = getRequestError(payload, response, `Failed to run MCP tool (${response.status}).`);
        throw new ExternalMcpToolRunError(
          requestError.message,
          isRecord(payload) ? parseToolCallInspection(payload.inspection) : null,
          isRecord(payload) ? parseExternalMcpDiagnostic(payload.diagnostic) : null,
        );
      }
      if (
        !isRecord(payload)
        || typeof payload.referenceId !== "string"
        || typeof payload.durationMs !== "number"
        || !("result" in payload)
      ) {
        throw new Error("MCP tool result was incomplete.");
      }
      return {
        referenceId: payload.referenceId,
        durationMs: payload.durationMs,
        result: payload.result,
        // A missing or unparseable inspection must not fail a tool run that
        // succeeded (for example across a den-api/den-web deploy skew); the
        // runner simply renders without the inspector panel.
        inspection: parseToolCallInspection(payload.inspection),
      };
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class McpOAuthStartError extends Error {
  readonly details: McpAuthorizationDebugDetails;

  constructor(message: string, details: McpAuthorizationDebugDetails) {
    super(message);
    this.name = "McpOAuthStartError";
    this.details = details;
  }
}

export class McpOAuthConfigurationRequiredError extends McpOAuthStartError {
  constructor(message: string, details: McpAuthorizationDebugDetails) {
    super(message, details);
    this.name = "McpOAuthConfigurationRequiredError";
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function mcpOAuthStartDebugDetails(payload: unknown, httpStatus: number): McpAuthorizationDebugDetails {
  const record = isRecord(payload) ? payload : null;
  const errorCode = nonEmptyString(record?.error);
  const message = nonEmptyString(record?.message);
  const redirectUri = nonEmptyString(record?.callbackUrl);
  const clientMetadataUrl = nonEmptyString(record?.clientMetadataUrl);
  const manualRequirements = isStringArray(record?.manualRequirements)
    ? record.manualRequirements
    : undefined;
  const diagnostic = parseExternalMcpDiagnostic(record?.diagnostic);
  const responsePayload: Record<string, unknown> = {
    ...(errorCode ? { error: errorCode } : {}),
    ...(redirectUri ? { callbackUrl: redirectUri } : {}),
    ...(clientMetadataUrl ? { clientMetadataUrl } : {}),
    ...(message ? { message } : {}),
    ...(manualRequirements ? { manualRequirements } : {}),
    ...(diagnostic ? { diagnostic } : {}),
  };

  return {
    httpStatus,
    ...(errorCode ? { errorCode } : {}),
    ...(redirectUri ? { redirectUri } : {}),
    ...(clientMetadataUrl ? { clientMetadataUrl } : {}),
    ...(diagnostic?.referenceId ? { diagnosticReference: diagnostic.referenceId } : {}),
    ...(diagnostic?.phase ? { phase: diagnostic.phase } : {}),
    ...(diagnostic?.category ? { category: diagnostic.category } : {}),
    ...(diagnostic?.highestPassed ? { highestPassed: diagnostic.highestPassed } : {}),
    ...(diagnostic?.retryable !== undefined ? { retryable: diagnostic.retryable } : {}),
    ...(diagnostic?.actionOwner ? { actionOwner: diagnostic.actionOwner } : {}),
    ...(diagnostic?.operatorAction ? { operatorAction: diagnostic.operatorAction } : {}),
    ...(diagnostic?.providerStatus !== undefined ? { providerStatus: diagnostic.providerStatus } : {}),
    ...(diagnostic?.providerRequestId ? { providerRequestId: diagnostic.providerRequestId } : {}),
    ...(diagnostic?.providerCode ? { providerCode: diagnostic.providerCode } : {}),
    responseJson: JSON.stringify(responsePayload, null, 2),
  };
}

function parseInspectionHeaders(value: unknown): ExternalMcpInspectionHeader[] | null {
  if (!Array.isArray(value)) return null;
  const headers: ExternalMcpInspectionHeader[] = [];
  for (const header of value) {
    if (
      !isRecord(header)
      || typeof header.name !== "string"
      || typeof header.value !== "string"
      || typeof header.redacted !== "boolean"
    ) return null;
    headers.push({ name: header.name, value: header.value, redacted: header.redacted });
  }
  return headers;
}

function parseInspectionBody(value: unknown): ExternalMcpInspectionBody | null {
  if (
    !isRecord(value)
    || typeof value.text !== "string"
    || typeof value.bytes !== "number"
    || typeof value.truncated !== "boolean"
    || (value.unavailable !== undefined && typeof value.unavailable !== "boolean")
  ) return null;
  return {
    text: value.text,
    bytes: value.bytes,
    truncated: value.truncated,
    ...(value.unavailable === true ? { unavailable: true } : {}),
  };
}

function parseInspectionRequest(value: unknown): ExternalMcpToolCallInspection["request"] | null {
  if (
    !isRecord(value)
    || typeof value.method !== "string"
    || typeof value.url !== "string"
    || typeof value.startedAt !== "string"
  ) return null;
  const headers = parseInspectionHeaders(value.headers);
  const body = parseInspectionBody(value.body);
  if (!headers || !body) return null;
  return { method: value.method, url: value.url, startedAt: value.startedAt, headers, body };
}

function parseInspectionResponse(value: unknown): ExternalMcpToolCallInspection["response"] | null {
  if (
    !isRecord(value)
    || typeof value.status !== "number"
    || typeof value.statusText !== "string"
    || typeof value.durationMs !== "number"
  ) return null;
  const headers = parseInspectionHeaders(value.headers);
  const body = parseInspectionBody(value.body);
  if (!headers || !body) return null;
  return { status: value.status, statusText: value.statusText, durationMs: value.durationMs, headers, body };
}

function parseToolCallInspection(value: unknown): ExternalMcpToolCallInspection | null {
  if (!isRecord(value) || !isRecord(value.diagnosis)) return null;
  const status = value.diagnosis.status;
  const layer = value.diagnosis.layer;
  if (
    (status !== "succeeded" && status !== "failed")
    || (layer !== "openwork" && layer !== "network" && layer !== "mcp_connection" && layer !== "remote_http" && layer !== "mcp_tool")
    || typeof value.diagnosis.summary !== "string"
  ) return null;
  const request = value.request === undefined ? undefined : parseInspectionRequest(value.request);
  const response = value.response === undefined ? undefined : parseInspectionResponse(value.response);
  if (request === null || response === null) return null;
  return {
    ...(request ? { request } : {}),
    ...(response ? { response } : {}),
    diagnosis: { status, layer, summary: value.diagnosis.summary },
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function parseRequiredBy(value: unknown): ExternalMcpRequiredBy[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.pluginId !== "string" || typeof entry.name !== "string") return [];
    return [{ pluginId: entry.pluginId, name: entry.name }];
  });
}

async function fetchConnections(scope: ExternalMcpConnectionScope, orgId: string): Promise<ExternalMcpConnection[]> {
  const { response, payload } = await requestJson(
    `/v1/mcp-connections?scope=${scope}`,
    { headers: getOrgScopeHeaders(orgId) },
    15000,
  );
  if (!response.ok) {
    throw getRequestError(payload, response, `Failed to load MCP connectors (${response.status}).`);
  }
  const record = payload as { connections?: ExternalMcpConnection[] };
  return (record.connections ?? []).map((connection) => ({
    ...connection,
    requiredBy: parseRequiredBy(connection.requiredBy),
    identityManagedBy: parseRequiredBy(connection.identityManagedBy),
    updatedAt: typeof connection.updatedAt === "string" ? connection.updatedAt : null,
    exposeDirectly: connection.exposeDirectly === true,
    ...(typeof connection.createdByName === "string" || connection.createdByName === null ? { createdByName: connection.createdByName } : {}),
    ...(typeof connection.needsReconnect === "boolean" ? { needsReconnect: connection.needsReconnect } : {}),
    ...(connection.credentialHealth === "unknown" || connection.credentialHealth === "ready" || connection.credentialHealth === "reconnect_required"
      ? { credentialHealth: connection.credentialHealth }
      : {}),
    ...(typeof connection.issuerReviewRequired === "boolean" ? { issuerReviewRequired: connection.issuerReviewRequired } : {}),
    ...(connection.reconnectActionOwner === "member" || connection.reconnectActionOwner === "organization_admin" || connection.reconnectActionOwner === null
      ? { reconnectActionOwner: connection.reconnectActionOwner }
      : {}),
    ...(isStringArray(connection.missingFeatures) ? { missingFeatures: connection.missingFeatures } : {}),
    ...(typeof connection.externalAccountId === "string" || connection.externalAccountId === null
      ? { externalAccountId: connection.externalAccountId }
      : {}),
    ...(isStringArray(connection.grantedScopes) ? { grantedScopes: connection.grantedScopes } : {}),
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

export type McpConnectionAccessInput = {
  orgWide: boolean;
  memberIds: string[];
  teamIds: string[];
};

export type CreateMcpConnectionInput = {
  name: string;
  url: string;
  authType: ExternalMcpAuthType;
  credentialMode: ExternalMcpCredentialMode;
  exposeDirectly?: boolean;
  apiKey?: string;
  oauthClient?: {
    clientId: string;
    clientSecret?: string;
  };
  authorizationServerIssuer?: string | null;
  requestedScopes?: string[];
  access: McpConnectionAccessInput;
};

export type CreateNativeProviderConnectionInput = {
  nativeProviderKey: string;
  name: string;
  oauthClient: {
    clientId: string;
    clientSecret?: string;
    features: string[];
  };
};

export type UpdateMcpConnectionInput = {
  connectionId: string;
  expectedUpdatedAt: string;
  name: string;
  url: string;
  authType: ExternalMcpAuthType;
  credentialMode: ExternalMcpCredentialMode;
  exposeDirectly: boolean;
  apiKey?: string;
  oauthClient?: {
    clientId: string;
    clientSecret?: string;
  };
  authorizationServerIssuer?: string | null;
  requestedScopes?: string[];
  access: McpConnectionAccessInput;
};

export type McpConnectionResolution = {
  resolution: "preset" | "discovered" | "not_found";
  attempted: string[];
  reason?: string;
  preset?: ExternalMcpPreset;
  match?: {
    url: string;
    suggestedName: string;
    discovery: McpRequirementsDiscovery;
  };
};

/**
 * Smart resolution for the add-connection flow: sends whatever the admin
 * typed (URL, bare host, or product name) and gets back a matched preset or
 * a probed endpoint with its requirements discovery inline.
 */
export function useResolveMcpConnection() {
  const { orgId } = useOrgDashboard();
  return useMutation({
    mutationFn: async (query: string): Promise<McpConnectionResolution> => {
      const { response, payload } = await requestJson(
        "/v1/mcp-connections/resolve",
        {
          method: "POST",
          headers: getOrgScopeHeaders(requireOrgId(orgId)),
          body: JSON.stringify({ query }),
        },
        30000,
      );
      if (!response.ok) {
        throw getRequestError(payload, response, `Failed to look up the MCP server (${response.status}).`);
      }
      return payload as McpConnectionResolution;
    },
  });
}

export function useDiscoverMcpConnectionRequirements() {
  const { orgId } = useOrgDashboard();
  return useMutation({
    mutationFn: async (url: string): Promise<McpRequirementsDiscovery> => {
      const { response, payload } = await requestJson(
        "/v1/mcp-connections/discover",
        {
          method: "POST",
          headers: getOrgScopeHeaders(requireOrgId(orgId)),
          body: JSON.stringify({ url }),
        },
        20000,
      );
      if (!response.ok) {
        throw getRequestError(payload, response, `Failed to discover MCP requirements (${response.status}).`);
      }
      return payload as McpRequirementsDiscovery;
    },
  });
}

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

export function useCreateNativeProviderConnection() {
  const queryClient = useQueryClient();
  const { orgId, runReauthableAction } = useOrgDashboard();

  return useMutation({
    mutationFn: async (input: CreateNativeProviderConnectionInput): Promise<CreatedMcpConnection> => {
      let created: CreatedMcpConnection | null = null;
      await runReauthableAction("create-mcp-connection", async () => {
        const { response, payload } = await requestJson(
          "/v1/mcp-connections",
          {
            method: "POST",
            headers: getOrgScopeHeaders(requireOrgId(orgId)),
            body: JSON.stringify({ kind: "native_provider", ...input }),
          },
          20000,
        );
        if (!response.ok) {
          throw getRequestError(payload, response, `Failed to add native provider connection (${response.status}).`);
        }
        created = payload as CreatedMcpConnection;
      });
      if (!created) throw new Error("Create native provider connection response was incomplete.");
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

export function useReviewMcpIssuer() {
  const queryClient = useQueryClient();
  const { orgId, runReauthableAction } = useOrgDashboard();

  return useMutation({
    mutationFn: async (input: {
      connectionId: string;
      action: "preview" | "confirm";
      expectedUpdatedAt?: string;
      authorizationServerIssuer?: string;
    }): Promise<McpIssuerReview> => {
      let review: McpIssuerReview | null = null;
      const request = async () => {
        const { connectionId, ...body } = input;
        const { response, payload } = await requestJson(
          `/v1/mcp-connections/${encodeURIComponent(connectionId)}/oauth/issuer-review`,
          {
            method: "POST",
            headers: getOrgScopeHeaders(requireOrgId(orgId)),
            body: JSON.stringify(body),
          },
          30000,
        );
        if (!response.ok) {
          throw getRequestError(payload, response, `Failed to review the OAuth issuer (${response.status}).`);
        }
        review = payload as McpIssuerReview;
      };
      if (input.action === "confirm") {
        await runReauthableAction("review-mcp-oauth-issuer", request);
      } else {
        await request();
      }
      if (!review) throw new Error("OAuth issuer review response was incomplete.");
      return review;
    },
    onSuccess: (_review, input) => {
      if (input.action === "confirm") {
        queryClient.invalidateQueries({ queryKey: mcpConnectionQueryKeys.all });
      }
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
        const details = mcpOAuthStartDebugDetails(payload, response.status);
        const requestError = getRequestError(payload, response, `Failed to start OAuth (${response.status}).`);
        if (details.errorCode === "mcp_oauth_configuration_required") {
          throw new McpOAuthConfigurationRequiredError(
            requestError.message,
            details,
          );
        }
        throw new McpOAuthStartError(requestError.message, details);
      }
      return payload as { status: "connected" | "needs_auth"; authorizeUrl: string | null };
    },
  });
}

export function useDisconnectMyProviderAccount() {
  const queryClient = useQueryClient();
  const { orgId } = useOrgDashboard();

  return useMutation({
    mutationFn: async (connection: Pick<ExternalMcpConnection, "id" | "nativeProviderKey">): Promise<string> => {
      const path = isNativeProviderConnectionId(connection.id, connection.nativeProviderKey)
        ? `/v1/oauth-providers/${encodeURIComponent(connection.id)}/disconnect`
        : `/v1/mcp-connections/${encodeURIComponent(connection.id)}/disconnect-my-account`;
      const { response, payload } = await requestJson(
        path,
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

export function useDisconnectMcpConnection() {
  const queryClient = useQueryClient();
  const { orgId, runReauthableAction } = useOrgDashboard();

  return useMutation({
    mutationFn: async (connectionId: string): Promise<string> => {
      let result: string | null = null;
      await runReauthableAction("disconnect-mcp-connection", async () => {
        const { response, payload } = await requestJson(
          `/v1/mcp-connections/${encodeURIComponent(connectionId)}/disconnect`,
          { method: "POST", headers: getOrgScopeHeaders(requireOrgId(orgId)) },
          15000,
        );
        if (!response.ok) {
          throw getRequestError(payload, response, `Failed to disconnect MCP connection (${response.status}).`);
        }
        result = connectionId;
      });
      if (!result) throw new Error("Disconnect MCP connection response was incomplete.");
      return result;
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

export function formatMcpConnectedTimestamp(value: string | null): string {
  if (!value) return "Not connected";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not connected";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(date);
}
