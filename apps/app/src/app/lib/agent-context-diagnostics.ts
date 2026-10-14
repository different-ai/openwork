import {
  agentContextDiagnosticsReportSchema,
  isAgentContextDiagnosticTextSafe,
  sanitizeAgentContextDiagnosticText,
  type AgentContextDiagnosticsReport,
  type AgentContextDiagnosticsRequest,
  type AgentContextOrganizationConnectionSummary,
  type AgentContextOrganizationConnectionsProbe,
} from "@openwork/types/agent-context-diagnostics";

import { connectionNeedsReconnect } from "../../react-app/domains/connections/native-provider-connections";
import type { DenExternalMcpConnection } from "./den";

const SAFE_CONNECTION_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const MAX_ORGANIZATION_CONNECTION_OBSERVATIONS = 200;

function summarizeOrganizationConnection(
  connection: DenExternalMcpConnection,
): AgentContextOrganizationConnectionSummary | null {
  const id = connection.id.trim();
  const name = sanitizeAgentContextDiagnosticText(connection.name).trim().slice(0, 160);
  if (
    !id
    || !name
    || id.length > 160
    || !SAFE_CONNECTION_ID_PATTERN.test(id)
    || !isAgentContextDiagnosticTextSafe(id)
  ) return null;
  const missingFeatureCount = Math.min(connection.missingFeatures?.length ?? 0, 100);
  const limitedAccess = connection.nativeProviderKey === "slack"
    && connection.credentialMode === "per_member"
    && connection.connectedForMe
    && !connection.policyBlocked
    && !connectionNeedsReconnect(connection)
    && missingFeatureCount > 0;
  return {
    id,
    name,
    credentialMode: connection.credentialMode,
    connected: connection.connected,
    connectedForMe: connection.connectedForMe,
    needsReconnect: connection.needsReconnect === true,
    ...(connection.policyBlocked === true ? { policyBlocked: true } : {}),
    ...(connection.policyBlocked === true && connection.policyOwner === "openwork"
      ? { policyOwner: connection.policyOwner }
      : {}),
    ...(limitedAccess ? { limitedAccess: true } : {}),
    missingFeatureCount,
  } satisfies AgentContextOrganizationConnectionSummary;
}

function summarizeOrganizationConnectionObservation(
  connections: DenExternalMcpConnection[],
): {
  rows: AgentContextOrganizationConnectionSummary[];
  totalCount: number;
  truncated: boolean;
} {
  const rows: AgentContextOrganizationConnectionSummary[] = [];
  const totalCount = Math.min(connections.length, 1_000_000);
  for (const connection of connections) {
    const summary = summarizeOrganizationConnection(connection);
    if (!summary) continue;
    if (rows.length < MAX_ORGANIZATION_CONNECTION_OBSERVATIONS) rows.push(summary);
  }
  return {
    rows,
    totalCount,
    truncated: totalCount > rows.length,
  };
}

export function summarizeOrganizationConnections(
  connections: DenExternalMcpConnection[],
): AgentContextOrganizationConnectionSummary[] {
  return summarizeOrganizationConnectionObservation(connections).rows;
}

export function resolveOrganizationConnectionsProbe(input: {
  signedIn: boolean;
  activeOrganizationId: string | null | undefined;
  loading: boolean;
  loaded: boolean;
  error: string | null;
}): AgentContextOrganizationConnectionsProbe {
  if (!input.signedIn || !input.activeOrganizationId?.trim()) {
    return { status: "skipped", code: "signed_out", totalCount: 0, truncated: false };
  }
  if (input.error) {
    return { status: "unavailable", code: "list_failed", totalCount: 0, truncated: false };
  }
  if (input.loading || !input.loaded) {
    return { status: "skipped", code: "not_attempted", totalCount: 0, truncated: false };
  }
  return { status: "observed", code: null, totalCount: 0, truncated: false };
}

export function collectAgentContextDiagnosticObservations(input: {
  organizationConnections: DenExternalMcpConnection[];
  organizationConnectionsProbe: AgentContextOrganizationConnectionsProbe;
}): AgentContextDiagnosticsRequest {
  const observation = input.organizationConnectionsProbe.status === "observed"
    ? summarizeOrganizationConnectionObservation(input.organizationConnections)
    : { rows: [], totalCount: 0, truncated: false };
  return {
    organizationConnectionsProbe: {
      ...input.organizationConnectionsProbe,
      totalCount: observation.totalCount,
      truncated: observation.truncated,
    },
    organizationConnections: observation.rows,
  };
}

export function serializeAgentContextDiagnosticsReport(report: AgentContextDiagnosticsReport) {
  const sanitized = agentContextDiagnosticsReportSchema.parse(report);
  return JSON.stringify(sanitized, null, 2);
}
