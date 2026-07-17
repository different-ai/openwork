import {
  agentContextDiagnosticsReportSchema,
  isAgentContextDiagnosticTextSafe,
  sanitizeAgentContextDiagnosticText,
  type AgentContextDiagnosticsReport,
  type AgentContextDiagnosticsRequest,
  type AgentContextOrganizationConnectionSummary,
  type AgentContextOrganizationConnectionsProbe,
} from "@openwork/types/agent-context-diagnostics";

import type { DenExternalMcpConnection } from "./den";

const SAFE_CONNECTION_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const MAX_ORGANIZATION_CONNECTION_OBSERVATIONS = 200;

export function isAgentContextDiagnosticsWorkspaceAllowed(workspace: {
  workspaceType: "local" | "remote";
  remoteType?: "openwork" | "opencode" | null;
} | null): boolean {
  if (!workspace) return false;
  return workspace.workspaceType === "local" || workspace.remoteType === "openwork";
}

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
  return {
    id,
    name,
    credentialMode: connection.credentialMode,
    connected: connection.connected,
    connectedForMe: connection.connectedForMe,
    needsReconnect: connection.needsReconnect === true,
    missingFeatureCount: Math.min(connection.missingFeatures?.length ?? 0, 100),
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
  workspaceType: "local" | "remote";
}): AgentContextDiagnosticsRequest {
  if (input.workspaceType === "remote") {
    return {
      organizationConnectionsProbe: {
        status: "skipped",
        code: "remote_workspace_privacy",
        totalCount: 0,
        truncated: false,
      },
      organizationConnections: [],
    };
  }

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
