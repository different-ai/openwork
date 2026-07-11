"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import {
  MCP_DIAGNOSTIC_ATTEMPT_STATUSES,
  MCP_DIAGNOSTIC_ACTION_OWNERS,
  MCP_DIAGNOSTIC_EVENT_OUTCOMES,
  MCP_DIAGNOSTIC_HEALTH_LEVELS,
  MCP_DIAGNOSTIC_PHASES,
  type McpDiagnosticAttempt,
  type McpDiagnosticEvent,
  type McpDiagnosticSafeEvidence,
  type McpDiagnosticSnapshot,
  type McpDiagnosticStreamMessage,
} from "@openwork/types/den/mcp-diagnostics";
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
};

export type ExternalMcpConnection = {
  id: string;
  name: string;
  url: string;
  authType: ExternalMcpAuthType;
  credentialMode: ExternalMcpCredentialMode;
  connected: boolean;
  connectedAt: string | null;
  connectedForMe: boolean;
  needsReconnect?: boolean;
  missingFeatures?: string[];
  externalAccountId?: string | null;
  grantedScopes?: string[];
  tenantId?: string | null;
  access: ExternalMcpAccessSummary | null;
};

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

export function isNativeProviderConnectionId(id: string): boolean {
  return id === "google-workspace" || id === "microsoft-365";
}

export function canDisconnectNativeProviderAccount(connection: Pick<ExternalMcpConnection, "id" | "connectedForMe">): boolean {
  return connection.connectedForMe && isNativeProviderConnectionId(connection.id);
}

export const mcpConnectionQueryKeys = {
  all: ["mcp-connections"] as const,
  list: (orgId?: string | null, scope?: ExternalMcpConnectionScope) =>
    [...mcpConnectionQueryKeys.all, "list", orgId ?? "none", scope ?? "usable"] as const,
  presets: () => [...mcpConnectionQueryKeys.all, "presets"] as const,
  nativeProviderClient: (orgId?: string | null, providerId?: string | null) =>
    [...mcpConnectionQueryKeys.all, "native-provider-client", orgId ?? "none", providerId ?? "none"],
  telegram: (orgId?: string | null) => [...mcpConnectionQueryKeys.all, "telegram", orgId ?? "none"] as const,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
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
    ...(typeof connection.needsReconnect === "boolean" ? { needsReconnect: connection.needsReconnect } : {}),
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
  apiKey?: string;
  oauthClient?: {
    clientId: string;
    clientSecret?: string;
  };
  access: McpConnectionAccessInput;
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

function isEnumValue<TValue extends string>(values: readonly TValue[], value: unknown): value is TValue {
  return typeof value === "string" && values.some((entry) => entry === value);
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

export function isSafeMcpAuthorizationUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4096) return false;
  try {
    const parsed = new URL(value);
    if (parsed.username !== "" || parsed.password !== "") return false;
    if (parsed.protocol === "https:") return true;
    if (parsed.protocol !== "http:") return false;
    const hostname = parsed.hostname.toLowerCase();
    return hostname === "localhost"
      || hostname.endsWith(".localhost")
      || hostname === "[::1]"
      || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  } catch {
    return false;
  }
}

function isSafeDiagnosticEvidence(value: unknown): value is McpDiagnosticSafeEvidence {
  if (!isRecord(value) || value.detailsRedacted !== true) return false;
  return hasOnlyKeys(value, ["method", "origin", "path", "status", "contentType", "errorCode", "protocolVersion", "toolCount", "pageCount", "detailsRedacted"])
    && isOptionalString(value.method)
    && isOptionalString(value.origin)
    && isOptionalString(value.path)
    && isOptionalNumber(value.status)
    && isOptionalString(value.contentType)
    && isOptionalString(value.errorCode)
    && (value.protocolVersion === undefined || (typeof value.protocolVersion === "string" && value.protocolVersion.length <= 64))
    && isOptionalNumber(value.toolCount)
    && isOptionalNumber(value.pageCount);
}

function isDiagnosticEvent(value: unknown): value is McpDiagnosticEvent {
  return isRecord(value)
    && hasOnlyKeys(value, ["id", "attemptId", "sequence", "occurredAt", "phase", "outcome", "elapsedMs", "phaseDurationMs", "healthLevel", "messageSafe", "category", "retryable", "actionOwner", "operatorAction", "evidence"])
    && typeof value.id === "string"
    && typeof value.attemptId === "string"
    && typeof value.sequence === "number"
    && Number.isInteger(value.sequence)
    && typeof value.occurredAt === "string"
    && isEnumValue(MCP_DIAGNOSTIC_PHASES, value.phase)
    && isEnumValue(MCP_DIAGNOSTIC_EVENT_OUTCOMES, value.outcome)
    && typeof value.elapsedMs === "number"
    && (value.phaseDurationMs === null || typeof value.phaseDurationMs === "number")
    && isEnumValue(MCP_DIAGNOSTIC_HEALTH_LEVELS, value.healthLevel)
    && typeof value.messageSafe === "string"
    && isNullableString(value.category)
    && (value.retryable === null || typeof value.retryable === "boolean")
    && (value.actionOwner === null || isEnumValue(MCP_DIAGNOSTIC_ACTION_OWNERS, value.actionOwner))
    && isNullableString(value.operatorAction)
    && isSafeDiagnosticEvidence(value.evidence);
}

function isDiagnosticAttempt(value: unknown): value is McpDiagnosticAttempt {
  return isRecord(value)
    && hasOnlyKeys(value, ["id", "connectionId", "status", "highestHealthLevel", "firstFailedPhase", "firstFailureCategory", "firstFailureMessage", "actionOwner", "operatorAction", "startedAt", "completedAt", "expiresAt"])
    && typeof value.id === "string"
    && typeof value.connectionId === "string"
    && isEnumValue(MCP_DIAGNOSTIC_ATTEMPT_STATUSES, value.status)
    && isEnumValue(MCP_DIAGNOSTIC_HEALTH_LEVELS, value.highestHealthLevel)
    && (value.firstFailedPhase === null || isEnumValue(MCP_DIAGNOSTIC_PHASES, value.firstFailedPhase))
    && isNullableString(value.firstFailureCategory)
    && isNullableString(value.firstFailureMessage)
    && (value.actionOwner === null || isEnumValue(MCP_DIAGNOSTIC_ACTION_OWNERS, value.actionOwner))
    && isNullableString(value.operatorAction)
    && typeof value.startedAt === "string"
    && isNullableString(value.completedAt)
    && typeof value.expiresAt === "string";
}

function isDiagnosticSnapshot(value: unknown): value is McpDiagnosticSnapshot {
  return isRecord(value)
    && hasOnlyKeys(value, ["attempt", "events"])
    && isDiagnosticAttempt(value.attempt)
    && Array.isArray(value.events)
    && value.events.every(isDiagnosticEvent);
}

export function isMcpDiagnosticStreamMessage(value: unknown): value is McpDiagnosticStreamMessage {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "event") {
    return hasOnlyKeys(value, ["type", "event", "attempt"])
      && isDiagnosticEvent(value.event)
      && isDiagnosticAttempt(value.attempt);
  }
  if (value.type === "authorization_required") return hasOnlyKeys(value, ["type", "authorizeUrl"]) && isSafeMcpAuthorizationUrl(value.authorizeUrl);
  if (value.type === "snapshot" || value.type === "complete") return hasOnlyKeys(value, ["type", "snapshot"]) && isDiagnosticSnapshot(value.snapshot);
  return false;
}

async function diagnosticStreamError(response: Response): Promise<Error> {
  const text = await response.text();
  let payload: unknown = text;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    // getRequestError safely handles bounded non-JSON responses.
  }
  return getRequestError(payload, response, `Failed to start MCP diagnostics (${response.status}).`);
}

class McpDiagnosticStreamProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpDiagnosticStreamProtocolError";
  }
}

function diagnosticAttemptId(message: McpDiagnosticStreamMessage): string | null {
  if (message.type === "event") return message.attempt.id;
  if (message.type === "snapshot" || message.type === "complete") return message.snapshot.attempt.id;
  return null;
}

const OAUTH_FALLBACK_PHASES = new Set(["AUTH_RESOURCE_DISCOVERY", "AUTH_ISSUER_DISCOVERY"]);

export function selectMcpDiagnosticTimelineEvents(events: McpDiagnosticEvent[]): McpDiagnosticEvent[] {
  const latestByPhase = new Map<string, McpDiagnosticEvent>();
  const retained: McpDiagnosticEvent[] = [];
  for (const event of events) {
    if (OAUTH_FALLBACK_PHASES.has(event.phase)) {
      retained.push(event);
      continue;
    }
    const previous = latestByPhase.get(event.phase);
    if (!previous || previous.sequence < event.sequence) latestByPhase.set(event.phase, event);
  }
  return [...retained, ...latestByPhase.values()].sort((left, right) => left.sequence - right.sequence);
}

export async function consumeMcpDiagnosticStream(input: {
  response: Response;
  signal: AbortSignal;
  onMessage: (message: McpDiagnosticStreamMessage) => void;
  onLastEventId?: (lastEventId: string) => void;
}): Promise<{ completed: boolean; attemptId: string | null; lastEventId: string | null }> {
  if (!input.response.headers.get("content-type")?.includes("text/event-stream") || !input.response.body) {
    await input.response.body?.cancel().catch(() => undefined);
    throw new McpDiagnosticStreamProtocolError("The diagnostic stream returned an invalid response.");
  }

  const reader = input.response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  let attemptId: string | null = null;
  let lastEventId: string | null = null;
  let readerDone = false;
  let cancelPromise: Promise<void> | null = null;
  const cancelReader = (reason?: unknown) => {
    cancelPromise ??= reader.cancel(reason).catch(() => undefined);
    return cancelPromise;
  };
  const onAbort = () => { void cancelReader(input.signal.reason); };
  if (input.signal.aborted) onAbort();
  else input.signal.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        readerDone = true;
        break;
      }
      buffer += decoder.decode(result.value, { stream: true });
      if (buffer.length > 1024 * 1024) {
        throw new McpDiagnosticStreamProtocolError("The diagnostic stream exceeded its safe buffer limit.");
      }
      buffer = buffer.replaceAll("\r\n", "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const lines = block.split("\n");
        const eventId = lines
          .filter((line) => line.startsWith("id:"))
          .map((line) => line.slice(3).trimStart())
          .at(-1);
        if (eventId && /^\d{1,15}$/.test(eventId)) {
          lastEventId = eventId;
          input.onLastEventId?.(eventId);
        }
        const data = lines
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            throw new McpDiagnosticStreamProtocolError("The diagnostic stream returned malformed JSON.");
          }
          if (!isMcpDiagnosticStreamMessage(parsed)) {
            throw new McpDiagnosticStreamProtocolError("The diagnostic stream returned an invalid event.");
          }
          attemptId = diagnosticAttemptId(parsed) ?? attemptId;
          if (parsed.type === "complete") completed = true;
          input.onMessage(parsed);
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
    return { completed, attemptId, lastEventId };
  } finally {
    input.signal.removeEventListener("abort", onAbort);
    if (!readerDone) await cancelReader();
    reader.releaseLock();
  }
}

async function waitForDiagnosticReconnect(delayMs: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function useMcpConnectionDiagnosticStream() {
  const { orgId } = useOrgDashboard();

  return useCallback(async (input: {
    connectionId: string;
    signal: AbortSignal;
    onMessage: (message: McpDiagnosticStreamMessage) => void;
  }): Promise<void> => {
    let response = await fetch(
      `/api/den/v1/mcp-connections/${encodeURIComponent(input.connectionId)}/diagnostics/stream`,
      {
        method: "POST",
        headers: {
          Accept: "text/event-stream",
          ...getOrgScopeHeaders(requireOrgId(orgId)),
        },
        credentials: "include",
        signal: input.signal,
      },
    );
    if (!response.ok) throw await diagnosticStreamError(response);
    let attemptId = response.headers.get("x-openwork-mcp-diagnostic-attempt-id");
    let lastEventId: string | null = null;
    for (let streamAttempt = 0; streamAttempt <= 4; streamAttempt += 1) {
      if (streamAttempt > 0) {
        if (!attemptId) break;
        await waitForDiagnosticReconnect(Math.min(2_000, 250 * 2 ** (streamAttempt - 1)), input.signal);
        try {
          const reconnectHeaders = new Headers({
            Accept: "text/event-stream",
            ...getOrgScopeHeaders(requireOrgId(orgId)),
          });
          if (lastEventId) reconnectHeaders.set("Last-Event-ID", lastEventId);
          response = await fetch(
            `/api/den/v1/mcp-connections/${encodeURIComponent(input.connectionId)}/diagnostics/${encodeURIComponent(attemptId)}/stream`,
            {
              headers: reconnectHeaders,
              credentials: "include",
              signal: input.signal,
            },
          );
        } catch (error) {
          if (input.signal.aborted) return;
          if (streamAttempt === 4) throw error;
          continue;
        }
        if (!response.ok) {
          if (response.status >= 500 && streamAttempt < 4) {
            await response.body?.cancel();
            continue;
          }
          throw await diagnosticStreamError(response);
        }
      }
      try {
        const result = await consumeMcpDiagnosticStream({
          response,
          signal: input.signal,
          onMessage: input.onMessage,
          onLastEventId: (value) => { lastEventId = value; },
        });
        attemptId = result.attemptId ?? attemptId;
        if (result.completed || input.signal.aborted) return;
      } catch (error) {
        if (input.signal.aborted) return;
        if (error instanceof McpDiagnosticStreamProtocolError) throw error;
      }
    }
    if (!input.signal.aborted) throw new Error("The diagnostic stream ended before the attempt completed.");
  }, [orgId]);
}

export function useDisconnectMyProviderAccount() {
  const queryClient = useQueryClient();
  const { orgId } = useOrgDashboard();

  return useMutation({
    mutationFn: async (providerId: string): Promise<string> => {
      const { response, payload } = await requestJson(
        `/v1/oauth-providers/${encodeURIComponent(providerId)}/disconnect`,
        { method: "POST", headers: getOrgScopeHeaders(requireOrgId(orgId)) },
        15000,
      );
      if (!response.ok) {
        throw getRequestError(payload, response, `Failed to disconnect account (${response.status}).`);
      }
      return providerId;
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
  const { orgId } = useOrgDashboard();

  return useQuery({
    enabled: enabled && Boolean(orgId),
    queryKey: mcpConnectionQueryKeys.nativeProviderClient(orgId, providerId),
    queryFn: async (): Promise<NativeProviderClient> => {
      const { response, payload } = await requestJson(
        `/v1/oauth-providers/${encodeURIComponent(providerId)}/client`,
        { headers: getOrgScopeHeaders(requireOrgId(orgId)) },
        15000,
      );
      if (!response.ok) {
        throw getRequestError(payload, response, `Failed to load the OAuth client (${response.status}).`);
      }
      return parseNativeProviderClient(payload);
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
  const { orgId } = useOrgDashboard();
  return useQuery({
    enabled: enabled && Boolean(orgId),
    queryKey: mcpConnectionQueryKeys.telegram(orgId),
    queryFn: async (): Promise<TelegramConnection | null> => {
      const { response, payload } = await requestJson(
        "/v1/telegram/connection",
        { headers: getOrgScopeHeaders(requireOrgId(orgId)) },
        15000,
      );
      if (!response.ok) throw getRequestError(payload, response, `Failed to load Telegram (${response.status}).`);
      return parseTelegramConnectionPayload(payload);
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
