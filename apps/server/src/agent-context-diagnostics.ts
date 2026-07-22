import { createHash, randomUUID } from "node:crypto";
import { basename, extname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  AgentContextDiagnosticCheck,
  AgentContextDiagnosticsReport,
  AgentContextDiagnosticsRequest,
  AgentContextMcpEvidence,
  AgentContextToolPermission,
} from "@openwork/types/agent-context-diagnostics";

import {
  AGENT_CONTEXT_DIAGNOSTICS_SCHEMA_VERSION,
  agentContextDiagnosticsReportSchema,
  agentContextDiagnosticsRequestSchema,
  sanitizeAgentContextDiagnosticText,
} from "./agent-context-diagnostics-schema.js";
import {
  effectiveToolDecision,
  validateEffectiveEngineSnapshot,
  type EffectiveEngineSnapshot,
  type InspectAgentDiagnosticsEngine,
} from "./agent-context-engine-inspection.js";
import {
  probeOpenworkCloudCatalog,
  type CloudCatalogProbe,
} from "./agent-context-cloud-probe.js";
import {
  inspectConnectSnapshot,
  type ConnectSnapshot,
  type ConnectStateInspectionStatus,
} from "./connect-state.js";
import { readJsoncFile } from "./jsonc.js";
import {
  inspectMcpLayersFromRuntimeSnapshot,
  type McpConfigCollision,
  type McpInventoryInspection,
} from "./mcp.js";
import { resolveWorkspaceOpencodeConnection } from "./opencode-connection.js";
import { buildOpenworkRuntimeConfigObjectFromSnapshot } from "./openwork-runtime-config.js";
import {
  inspectRuntimeOpencodeConfigState,
  runtimeMcpMap,
  type RuntimeOpencodeConfig,
  type RuntimeOpencodeConfigInspection,
} from "./runtime-opencode-config-store.js";
import type { McpItem, ServerConfig, WorkspaceInfo } from "./types.js";
import { exists } from "./utils.js";
import { opencodeConfigPath } from "./workspace-files.js";

const OPENWORK_CLOUD_MCP_NAME = "openwork-cloud";
const CLOUD_MCP_TERMINAL_PATH = "/mcp/agent";
const REQUIRED_CLOUD_TOOL_IDS = ["search_capabilities", "execute_capability"] as const;
const REQUIRED_CLOUD_AGENT_TOOL_IDS = REQUIRED_CLOUD_TOOL_IDS.map(
  (toolId) => `${OPENWORK_CLOUD_MCP_NAME}_${toolId}`,
);

export type McpRegistrationStatus =
  | "connected"
  | "disabled"
  | "failed"
  | "needs-auth"
  | "needs-client-registration"
  | "not-recorded";
export type McpRegistrationSource = "transport_failure" | "engine_status";
export type McpRegistrationInspection = {
  status: McpRegistrationStatus;
  source?: McpRegistrationSource | null;
  recordAgeMs?: number | null;
};
export type InspectMcpRegistration = (
  name: string,
  config: Record<string, unknown>,
) => McpRegistrationStatus | McpRegistrationInspection;

type FailedRegistrationDetail = {
  name: string;
  status: McpRegistrationStatus;
  source: McpRegistrationSource | null;
  recordAgeMs: number | null;
  engineReachableNow: boolean;
};

type ProjectAgentInspection = {
  available: boolean;
  defaultAgentOverride: boolean;
  agentConfigOverride: boolean;
  agentFileOverride: boolean;
};

type DiagnosticMcpItem = Omit<McpItem, "source"> & {
  source: McpItem["source"] | "engine.config";
};

type EffectiveToolPolicyDecision = "allow" | "ask" | "deny";

type DiagnosticDependencies = {
  fetchImpl?: typeof fetch;
  now?: () => number;
  uuid?: () => string;
  inspectEffectiveEngine?: InspectAgentDiagnosticsEngine;
  signal?: AbortSignal;
};

type EffectiveToolPolicyAssessment = {
  status: "available" | "denied" | "unavailable";
  decisions: Record<string, EffectiveToolPolicyDecision>;
  deniedToolIds: string[];
  unavailableReasons: string[];
};

function assessEffectiveToolPolicy(
  snapshot: EffectiveEngineSnapshot | null,
): EffectiveToolPolicyAssessment {
  if (!snapshot) {
    return {
      status: "unavailable",
      decisions: {},
      deniedToolIds: [],
      unavailableReasons: ["effective_engine_snapshot_unavailable"],
    };
  }
  const openworkAgent = snapshot.agents.find((agent) => agent.name === "openwork");
  if (!openworkAgent) {
    return {
      status: "unavailable",
      decisions: {},
      deniedToolIds: [],
      unavailableReasons: ["effective_openwork_agent_missing"],
    };
  }
  if (
    snapshot.defaultAgent !== "openwork"
    || openworkAgent.hidden
    || (openworkAgent.mode !== "primary" && openworkAgent.mode !== "all")
  ) {
    return {
      status: "unavailable",
      decisions: {},
      deniedToolIds: [],
      unavailableReasons: ["effective_openwork_agent_unusable_as_default"],
    };
  }
  const decisions: Record<string, EffectiveToolPolicyDecision> = {};
  for (const toolId of REQUIRED_CLOUD_AGENT_TOOL_IDS) {
    decisions[toolId] = effectiveToolDecision(openworkAgent.permission, toolId);
  }

  const deniedToolIds = REQUIRED_CLOUD_AGENT_TOOL_IDS.filter(
    (toolId) => decisions[toolId] === "deny",
  );
  return {
    status: deniedToolIds.length > 0 ? "denied" : "available",
    decisions,
    deniedToolIds,
    unavailableReasons: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeText(value: unknown, max: number, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  const cleaned = sanitizeAgentContextDiagnosticText(value).trim();
  return cleaned.slice(0, max) || fallback;
}

function elapsed(startedAt: number, now: () => number): number {
  return Math.max(0, Math.round(now() - startedAt));
}

function diagnosticCheck(
  input: Omit<AgentContextDiagnosticCheck, "durationMs"> & { durationMs?: number },
): AgentContextDiagnosticCheck {
  return { ...input, durationMs: input.durationMs ?? 0 };
}

export function expectedConnectBranch(snapshot: ConnectSnapshot): AgentContextDiagnosticsReport["connect"]["expectedBranch"] {
  if (snapshot.workspace.resolution !== "resolved") return "cloud-disconnected";
  const health = snapshot.cloudHealth;
  if (health?.usable === true && health.usableByCurrentModel !== false) return "cloud-active";
  if (health) return "cloud-disconnected";
  if (!snapshot.connectCatalogEnabled || snapshot.googleWorkspace.legacyConfigured) return "extensions-only";
  return "cloud-disconnected";
}

export function pluginLabel(spec: string): string | null {
  const trimmed = spec.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("@")) {
    const versionAt = trimmed.indexOf("@", 1);
    return safeText(versionAt > 0 ? trimmed.slice(0, versionAt) : trimmed, 160) || null;
  }
  const windowsPath = /^[A-Za-z]:[\\/]/u.test(trimmed);
  const urlLike = !windowsPath && (
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(trimmed)
    || trimmed.startsWith("//")
  );
  if (!urlLike && !trimmed.includes("/") && !trimmed.includes("\\")) {
    const versionAt = trimmed.indexOf("@");
    return safeText(versionAt > 0 ? trimmed.slice(0, versionAt) : trimmed, 160) || null;
  }
  let candidate = trimmed;
  if (urlLike) {
    try {
      const parsed = new URL(trimmed.startsWith("//") ? `https:${trimmed}` : trimmed);
      const hierarchical = trimmed.startsWith("//")
        || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(trimmed)
        || parsed.protocol.toLowerCase() === "file:";
      if (!hierarchical) return "[redacted-sensitive-label]";
      if (!parsed.pathname || parsed.pathname.endsWith("/")) return "[redacted-sensitive-label]";
      if (/%(?![0-9a-f]{2})/iu.test(parsed.pathname)) return "[redacted-sensitive-label]";
      candidate = decodeURIComponent(parsed.pathname);
    } catch {
      // URL-shaped plugin specs are untrusted. If the URL or its encoded path
      // cannot be parsed, emit a fixed marker instead of falling back to a
      // basename that could retain credentials from userinfo, query, or hash.
      return "[redacted-sensitive-label]";
    }
  }
  const file = basename(candidate.replaceAll("\\", "/"));
  const extension = extname(file);
  return safeText(extension ? file.slice(0, -extension.length) : file, 160) || null;
}

/**
 * OpenCode rewrites path-like plugin declarations to file URLs while loading
 * configuration. Compare that load identity without weakening exact matching
 * for package specs or unrelated URLs that merely share a basename.
 */
function pluginSpecIdentity(spec: string): string {
  if (spec.startsWith("file://")) {
    try {
      return new URL(spec).href;
    } catch {
      return spec;
    }
  }
  if (isAbsolute(spec) || /^[A-Za-z]:[\\/]/u.test(spec)) {
    try {
      return pathToFileURL(spec).href;
    } catch {
      return spec;
    }
  }
  return spec;
}

function promptEvidence(configuredAgent: Record<string, unknown> | null) {
  const prompt = typeof configuredAgent?.prompt === "string" ? configuredAgent.prompt : "";
  return {
    length: prompt.length,
    sha256: prompt ? createHash("sha256").update(prompt).digest("hex") : null,
    markers: {
      searchCapabilities: prompt.includes("search_capabilities"),
      executeCapability: prompt.includes("execute_capability"),
      memoryBank: prompt.includes("Memory Bank"),
    },
  };
}

async function inspectProjectAgent(workspace: WorkspaceInfo, signal?: AbortSignal): Promise<ProjectAgentInspection> {
  if (workspace.workspaceType !== "local" || !workspace.path.trim()) {
    return {
      available: false,
      defaultAgentOverride: false,
      agentConfigOverride: false,
      agentFileOverride: false,
    };
  }
  try {
    const { data, invalid } = await readJsoncFile(
      opencodeConfigPath(workspace.path),
      {} as Record<string, unknown>,
      {
        allowInvalid: true,
        maxBytes: 1024 * 1024,
        regularFileOnly: true,
        signal,
      },
    );
    if (invalid) {
      return {
        available: false,
        defaultAgentOverride: false,
        agentConfigOverride: false,
        agentFileOverride: false,
      };
    }
    const agents = isRecord(data.agent) ? data.agent : {};
    return {
      available: true,
      defaultAgentOverride: typeof data.default_agent === "string",
      agentConfigOverride: Object.hasOwn(agents, "openwork"),
      agentFileOverride: await Promise.all([
        exists(join(workspace.path, ".opencode", "agent", "openwork.md")),
        exists(join(workspace.path, ".opencode", "agents", "openwork.md")),
      ]).then((values) => values.some(Boolean)),
    };
  } catch {
    signal?.throwIfAborted();
    return {
      available: false,
      defaultAgentOverride: false,
      agentConfigOverride: false,
      agentFileOverride: false,
    };
  }
}

function runtimeOnlyMcpInventory(runtime: RuntimeOpencodeConfig): McpInventoryInspection {
  return {
    items: Object.entries(runtimeMcpMap(runtime)).map(([name, config]) => ({
      name,
      config,
      source: "config.remote",
    })),
    collisions: [],
    layerStatus: { project: "unreadable", global: "unreadable" },
    toolPolicy: {
      scope: "passive-static-subset",
      status: "unavailable",
      inspectedToolIds: [...REQUIRED_CLOUD_AGENT_TOOL_IDS],
      deniedToolIds: [],
    },
  };
}

async function inspectMcpInventory(
  workspace: WorkspaceInfo,
  runtime: RuntimeOpencodeConfig,
  signal?: AbortSignal,
): Promise<{ inventory: McpInventoryInspection; passiveLocalLayersAvailable: boolean }> {
  if (workspace.workspaceType !== "local" || !workspace.path.trim()) {
    return { inventory: runtimeOnlyMcpInventory(runtime), passiveLocalLayersAvailable: false };
  }
  try {
    return {
      inventory: await inspectMcpLayersFromRuntimeSnapshot(workspace.path, runtime, {
        signal,
        toolPolicy: {
          agentName: "openwork",
          mcpName: OPENWORK_CLOUD_MCP_NAME,
          toolIds: [...REQUIRED_CLOUD_AGENT_TOOL_IDS],
        },
      }),
      passiveLocalLayersAvailable: true,
    };
  } catch {
    signal?.throwIfAborted();
    return { inventory: runtimeOnlyMcpInventory(runtime), passiveLocalLayersAvailable: false };
  }
}

function mcpType(config: Record<string, unknown>): AgentContextMcpEvidence["type"] {
  if (config.type === "remote") return "remote";
  if (config.type === "local") return "local";
  return "unknown";
}

function mcpOauthMode(
  type: AgentContextMcpEvidence["type"],
  config: Record<string, unknown>,
): AgentContextMcpEvidence["oauthMode"] {
  if (type !== "remote") return type === "local" ? "none" : "unknown";
  if (config.oauth === false) return "disabled";
  if (isRecord(config.oauth)) return "configured";
  return "auto";
}

function cloudTerminalPathEvidence(
  name: string,
  source: DiagnosticMcpItem["source"],
  config: Record<string, unknown>,
): AgentContextMcpEvidence["path"] {
  if (
    name !== OPENWORK_CLOUD_MCP_NAME
    || (source !== "config.remote" && source !== "engine.config")
    || typeof config.url !== "string"
  ) return null;
  try {
    const url = new URL(config.url);
    if (!url.pathname.endsWith(CLOUD_MCP_TERMINAL_PATH) || url.pathname.endsWith(CLOUD_MCP_TERMINAL_PATH + "/")) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    // Deliberately emit only the required terminal route. A deployment may
    // use a prefix, and reporting this suffix must not imply a canonical URL.
    return CLOUD_MCP_TERMINAL_PATH;
  } catch {
    return null;
  }
}

function normalizeRegistrationInspection(
  value: McpRegistrationStatus | McpRegistrationInspection,
): McpRegistrationInspection {
  if (typeof value === "string") return { status: value, source: null, recordAgeMs: null };
  return {
    status: value.status,
    source: value.source ?? null,
    recordAgeMs: typeof value.recordAgeMs === "number" && Number.isFinite(value.recordAgeMs)
      ? Math.max(0, Math.round(value.recordAgeMs))
      : null,
  };
}

function mcpEvidence(
  item: DiagnosticMcpItem,
  syncStatus: AgentContextMcpEvidence["syncStatus"],
  managedMcpNames: ReadonlySet<string>,
): AgentContextMcpEvidence {
  const type = mcpType(item.config);
  return {
    name: safeText(item.name, 160, "unnamed-mcp"),
    source: item.source,
    type,
    enabled: item.config.enabled !== false,
    disabledByTools: item.disabledByTools === true,
    origin: null,
    path: cloudTerminalPathEvidence(item.name, item.source, item.config),
    hasHeaders: isRecord(item.config.headers) && Object.keys(item.config.headers).length > 0,
    oauthMode: mcpOauthMode(type, item.config),
    syncStatus: item.source === "config.remote" && managedMcpNames.has(item.name) ? syncStatus : "not-applicable",
    liveEngineStatus: "unavailable",
  };
}

function collisionDetails(collisions: McpConfigCollision[]): string[] {
  return collisions.slice(0, 100).map((collision) => {
    const name = safeText(collision.name, 160, "unnamed-mcp");
    return (name + ": " + collision.sources.join(", ")).slice(0, 500);
  });
}

function cloudCatalogCheck(probe: CloudCatalogProbe): AgentContextDiagnosticCheck {
  const common = {
    id: "cloud-tool-catalog" as const,
    durationMs: probe.durationMs,
    details: {
      expectedToolIds: [...REQUIRED_CLOUD_TOOL_IDS],
      observedToolIds: probe.toolIds,
      handshakePerformed: probe.performed,
      requestPerformed: probe.toolsListPerformed,
      httpStatus: probe.httpStatus,
    },
  };
  if (probe.status === "observed") {
    const exact = probe.toolIds.length === REQUIRED_CLOUD_TOOL_IDS.length
      && REQUIRED_CLOUD_TOOL_IDS.every((toolId) => probe.toolIds.includes(toolId));
    return diagnosticCheck({
      ...common,
      status: exact ? "passed" : "failed",
      evidenceKind: "observed",
      code: exact ? "cloud_catalog_exact_match" : "cloud_catalog_mismatch",
      message: exact
        ? "The canonical OpenWork Cloud catalog exposes exactly the two required capability tools."
        : "The OpenWork Cloud catalog does not match the required two-tool contract.",
      owner: exact ? "openwork-server" : "openwork-support",
      action: exact
        ? "No action is required."
        : "Review the OpenWork Cloud deployment and restore the canonical capability catalog.",
    });
  }

  let status: AgentContextDiagnosticCheck["status"] = "failed";
  let evidenceKind: AgentContextDiagnosticCheck["evidenceKind"] = probe.performed ? "observed" : "derived";
  let message = "The selected workspace does not have a usable managed OpenWork Cloud MCP configuration.";
  let owner: AgentContextDiagnosticCheck["owner"] = "openwork-server";
  let action = "Reconnect OpenWork Cloud from Settings > Connect and rerun diagnostics.";

  switch (probe.code) {
    case "runtime_config_unavailable":
      status = "warning";
      evidenceKind = "unavailable";
      message = "The passive runtime configuration snapshot is unavailable, so the cloud catalog request was not started.";
      action = "Start or repair the selected workspace runtime, then rerun diagnostics.";
      break;
    case "remote_workspace_unavailable":
      status = "warning";
      evidenceKind = "unavailable";
      message = "A local runtime credential was not inspected or used for this remote workspace shell.";
      action = "Run diagnostics on the OpenWork server that owns the workspace.";
      break;
    case "cloud_mcp_missing":
      owner = "openwork-client";
      message = "The selected client workspace has no synced OpenWork Cloud MCP entry.";
      break;
    case "cloud_mcp_disabled":
      owner = "openwork-client";
      message = "The selected workspace OpenWork Cloud MCP entry is disabled.";
      action = "Enable or reconnect OpenWork Cloud from Settings > Connect, then rerun diagnostics.";
      break;
    case "cloud_tool_policy_unavailable":
      status = "warning";
      evidenceKind = "unavailable";
      owner = "opencode-engine";
      message = "Required tool visibility could not be observed from the selected engine's effective OpenWork agent, so the cloud catalog request was not started.";
      action = "Check the selected workspace engine health and rerun diagnostics.";
      break;
    case "cloud_tool_policy_denied":
      owner = "member";
      message = "Policy evidence denies at least one required OpenWork Cloud tool, so the cloud catalog request was not started.";
      action = "Allow the required openwork-cloud capability tool IDs in the workspace or OpenWork agent policy, then rerun diagnostics.";
      break;
    case "cloud_mcp_not_remote":
      message = "The managed OpenWork Cloud entry is not configured as a remote MCP.";
      action = "Reconnect OpenWork Cloud to restore its managed remote configuration.";
      break;
    case "invalid_endpoint":
      message = "The managed OpenWork Cloud endpoint is not credential-safe or does not end at the required /mcp/agent route.";
      action = "Reconnect OpenWork Cloud to restore its managed endpoint, then rerun diagnostics.";
      break;
    case "untrusted_endpoint":
      message = "The managed OpenWork Cloud endpoint is outside the server's diagnostics trust policy.";
      action = "Use the hosted OpenWork Cloud endpoint or have the server administrator explicitly trust the development origin.";
      break;
    case "credential_missing":
    case "duplicate_authorization":
      owner = "openwork-client";
      message = "The managed OpenWork Cloud entry does not contain one unambiguous authentication value.";
      action = "Reconnect OpenWork Cloud so the client can replace the managed credential, then rerun diagnostics.";
      break;
    case "registration_failed":
      owner = "opencode-engine";
      message = "The selected engine reported that this exact OpenWork Cloud registration failed, so no new egress was started.";
      action = "Repair the selected workspace runtime registration, then rerun diagnostics.";
      break;
    case "registration_disabled":
      owner = "opencode-engine";
      message = "The selected engine reported this enabled OpenWork Cloud registration as disabled, so no new egress was started.";
      action = "Enable the managed OpenWork Cloud MCP in the selected engine, then rerun diagnostics.";
      break;
    case "registration_needs_auth":
      owner = "member";
      message = "The selected engine reported that OpenWork Cloud needs authentication, so no new egress was started.";
      action = "Reconnect OpenWork Cloud from Settings > Connect, then rerun diagnostics.";
      break;
    case "registration_needs_client_registration":
      owner = "openwork-server";
      message = "The selected engine reported that OpenWork Cloud needs MCP client registration, so no new egress was started.";
      action = "Repair the selected engine MCP client-registration flow, then rerun diagnostics.";
      break;
    case "registration_not_recorded":
      status = "warning";
      owner = "opencode-engine";
      message = "This exact runtime-managed OpenWork Cloud configuration has no current engine registration record, so no new egress was started.";
      action = "Start the selected workspace runtime so its managed MCP registration connects, then rerun diagnostics.";
      break;
    case "timeout":
    case "network_error":
    case "redirect_rejected":
    case "http_error":
      owner = "network-admin";
      message = "The one-shot OpenWork Cloud catalog request could not be completed through the configured network path.";
      action = "Verify server egress, DNS, TLS, proxy policy, and the configured OpenWork Cloud service, then rerun diagnostics.";
      break;
    case "dns_error":
      owner = "network-admin";
      message = "The one-shot OpenWork Cloud catalog request could not resolve the configured service hostname.";
      action = "Verify DNS resolution from the OpenWork server, then rerun diagnostics.";
      break;
    case "connection_refused":
      owner = "network-admin";
      message = "The configured OpenWork Cloud service refused the one-shot catalog connection.";
      action = "Verify the service listener, firewall, and egress route, then rerun diagnostics.";
      break;
    case "connection_reset":
      owner = "network-admin";
      message = "The one-shot OpenWork Cloud catalog connection was reset before a response completed.";
      action = "Verify the service, proxy, and network path, then rerun diagnostics.";
      break;
    case "tls_error":
      owner = "network-admin";
      message = "The one-shot OpenWork Cloud catalog request failed TLS certificate validation or negotiation.";
      action = "Verify the server trust store, enterprise certificates, TLS inspection, and service certificate, then rerun diagnostics.";
      break;
    case "proxy_error":
      owner = "network-admin";
      message = "The configured proxy could not complete the one-shot OpenWork Cloud catalog request.";
      action = "Verify proxy reachability, authentication, and bypass policy, then rerun diagnostics.";
      break;
    case "unauthorized":
    case "forbidden":
      owner = "openwork-client";
      message = "OpenWork Cloud rejected the configured credential during the one-shot catalog request.";
      action = "Reconnect OpenWork Cloud so the client can replace the managed credential, then rerun diagnostics.";
      break;
    case "rate_limited":
      status = "warning";
      owner = "openwork-support";
      message = "OpenWork Cloud rate-limited the one-shot catalog request.";
      action = "Wait before rerunning diagnostics; contact OpenWork support if rate limiting persists.";
      break;
    case "probe_busy":
      status = "warning";
      evidenceKind = "unavailable";
      owner = "openwork-server";
      message = "The server's bounded diagnostics probe capacity was busy, so no new egress was started.";
      action = "Wait briefly and rerun diagnostics.";
      break;
    case "response_too_large":
    case "invalid_content_type":
    case "invalid_response":
    case "jsonrpc_error":
    case "pagination_unsupported":
    case "invalid_catalog":
      owner = "openwork-support";
      message = "OpenWork Cloud returned a response that does not satisfy the bounded tools/list protocol contract.";
      action = "Review the OpenWork Cloud deployment and restore the canonical two-tool catalog response.";
      break;
  }
  return diagnosticCheck({
    ...common,
    status,
    evidenceKind,
    code: probe.code,
    message,
    owner,
    action,
  });
}

function organizationCheck(request: AgentContextDiagnosticsRequest): AgentContextDiagnosticCheck {
  if (request.organizationConnectionsProbe.status === "unavailable") {
    return diagnosticCheck({
      id: "organization-connections",
      status: "warning",
      evidenceKind: "client-observed",
      code: "organization_connections_unavailable",
      message: "The client could not observe organization connection readiness.",
      owner: "openwork-client",
      action: "Verify the Den session and organization access, then rerun diagnostics.",
      details: { connectionCount: 0, reportedConnectionCount: 0, truncated: false, notReadyCount: 0 },
    });
  }
  if (request.organizationConnectionsProbe.status === "skipped") {
    const remotePrivacy = request.organizationConnectionsProbe.code === "remote_workspace_privacy";
    return diagnosticCheck({
      id: "organization-connections",
      status: "skipped",
      evidenceKind: "client-observed",
      code: request.organizationConnectionsProbe.code ?? "organization_connections_skipped",
      message: remotePrivacy
        ? "Local Den organization topology was intentionally omitted from the remote OpenWork diagnostics request."
        : "Organization connection readiness was not observed for this run.",
      owner: remotePrivacy ? "openwork-client" : "member",
      action: remotePrivacy
        ? "No action is required; run diagnostics against a local workspace to include local Den organization readiness."
        : "Sign in to Den and select an organization to include organization readiness.",
      details: { connectionCount: 0, reportedConnectionCount: 0, truncated: false, notReadyCount: 0 },
    });
  }
  const needsAttention = request.organizationConnections.filter((connection) => {
    if (connection.needsReconnect || connection.missingFeatureCount > 0) return true;
    return connection.credentialMode === "shared"
      ? !connection.connected
      : !connection.connectedForMe;
  });
  const memberActionCount = needsAttention.filter((connection) => connection.credentialMode === "per_member").length;
  const organizationAdminActionCount = needsAttention.length - memberActionCount;
  const notReadyCount = needsAttention.length;
  const memberAndAdminAction = memberActionCount > 0 && organizationAdminActionCount > 0;
  const truncated = request.organizationConnectionsProbe.truncated;
  return diagnosticCheck({
    id: "organization-connections",
    status: notReadyCount > 0 || truncated ? "warning" : "passed",
    evidenceKind: "client-observed",
    code: truncated
      ? "organization_connections_truncated"
      : memberAndAdminAction
      ? "organization_member_and_admin_action_required"
      : memberActionCount > 0
        ? "organization_member_action_required"
        : organizationAdminActionCount > 0
          ? "organization_admin_action_required"
          : "organization_connections_ready",
    message: truncated
      ? "The client reported the first 200 organization connections; additional connections were omitted from this bounded report."
      : memberAndAdminAction
      ? "Per-member connections need your sign-in or reconnection, and shared connections need organization administrator attention."
      : memberActionCount > 0
        ? "One or more per-member organization connections need your sign-in or reconnection."
        : organizationAdminActionCount > 0
          ? "One or more shared organization connections need organization administrator setup or repair."
          : "The client-observed organization connections are ready.",
    owner: truncated
      ? "openwork-client"
      : memberAndAdminAction
      ? "member-and-organization-admin"
      : memberActionCount > 0
        ? "member"
        : organizationAdminActionCount > 0
          ? "organization-admin"
          : "openwork-client",
    action: truncated
      ? "Review organization connection readiness in Den for the complete inventory."
      : memberAndAdminAction
      ? "Connect or reconnect your per-member accounts in Settings > Connect, and ask an organization administrator to repair the listed shared connections in Den."
      : memberActionCount > 0
        ? "Connect or reconnect your account for the listed per-member connections in Settings > Connect."
        : organizationAdminActionCount > 0
          ? "Ask an organization administrator to repair the listed shared connections in Den, then rerun diagnostics."
          : "No action is required.",
    details: {
      connectionCount: request.organizationConnectionsProbe.totalCount,
      reportedConnectionCount: request.organizationConnections.length,
      truncated,
      notReadyCount,
      memberActionCount,
      organizationAdminActionCount,
    },
  });
}

function engineReadUnavailableCheck(
  id: "engine-config" | "engine-agent",
  inspectionStatus: "not-configured" | "not-supplied" | "invalid" | "unavailable",
  engineApiReadPerformed: boolean,
  durationMs: number,
): AgentContextDiagnosticCheck {
  const subject = id === "engine-config" ? "effective configuration" : "effective agent list";
  const code = inspectionStatus === "not-configured"
    ? "engine_endpoint_not_configured"
    : inspectionStatus === "invalid"
      ? "engine_diagnostics_response_invalid"
      : inspectionStatus === "unavailable"
        ? "engine_diagnostics_request_failed"
        : "engine_diagnostics_reader_unavailable";
  return diagnosticCheck({
    id,
    status: "warning",
    evidenceKind: "unavailable",
    code,
    message: `The selected engine's ${subject} could not be safely observed.`,
    owner: "opencode-engine",
    action: inspectionStatus === "not-configured"
      ? "Configure or start the selected workspace engine, then rerun diagnostics."
      : "Check the selected workspace engine health and rerun diagnostics.",
    details: {
      engineApiReadPerformed,
      engineInspectionStatus: inspectionStatus,
    },
    durationMs,
  });
}

function engineConfigCheck(
  snapshot: EffectiveEngineSnapshot | null,
  inspectionStatus: "observed" | "not-configured" | "not-supplied" | "invalid" | "unavailable",
  engineApiReadPerformed: boolean,
  durationMs: number,
): AgentContextDiagnosticCheck {
  if (!snapshot || inspectionStatus !== "observed") {
    return engineReadUnavailableCheck(
      "engine-config",
      inspectionStatus === "observed" ? "invalid" : inspectionStatus,
      engineApiReadPerformed,
      durationMs,
    );
  }
  return diagnosticCheck({
    id: "engine-config",
    status: "passed",
    evidenceKind: "observed",
    code: "effective_engine_config_observed",
    message: "The selected engine returned its effective merged configuration.",
    owner: "opencode-engine",
    action: "No action is required.",
    details: {
      engineApiReadPerformed: true,
      defaultAgentPresent: snapshot.defaultAgent !== null,
      effectivePluginCount: snapshot.pluginSpecs.length,
      effectiveMcpCount: snapshot.mcps.length,
      rawConfigurationIncluded: false,
    },
    durationMs,
  });
}

function engineAgentCheck(
  snapshot: EffectiveEngineSnapshot | null,
  inspectionStatus: "observed" | "not-configured" | "not-supplied" | "invalid" | "unavailable",
  engineApiReadPerformed: boolean,
  durationMs: number,
): AgentContextDiagnosticCheck {
  if (!snapshot || inspectionStatus !== "observed") {
    return engineReadUnavailableCheck(
      "engine-agent",
      inspectionStatus === "observed" ? "invalid" : inspectionStatus,
      engineApiReadPerformed,
      durationMs,
    );
  }
  const agent = snapshot.agents.find((candidate) => candidate.name === "openwork");
  return diagnosticCheck({
    id: "engine-agent",
    status: agent ? "passed" : "failed",
    evidenceKind: "observed",
    code: agent ? "effective_openwork_agent_observed" : "effective_openwork_agent_missing",
    message: agent
      ? "The selected engine resolved the OpenWork agent."
      : "The selected engine did not resolve an OpenWork agent.",
    owner: agent ? "opencode-engine" : "openwork-server",
    action: agent
      ? "No action is required."
      : "Restore the OpenWork runtime agent injection and restart the selected workspace engine.",
    details: {
      engineApiReadPerformed: true,
      effectiveAgentCount: snapshot.agents.length,
      openworkAgentPresent: Boolean(agent),
      openworkAgentHidden: agent?.hidden ?? null,
      permissionRuleCount: agent?.permission.length ?? null,
      rawPromptIncluded: false,
    },
    durationMs,
  });
}

function runtimeHealthCheck(
  workspace: WorkspaceInfo,
  engineConfigured: boolean,
  inspection: RuntimeOpencodeConfigInspection,
  durationMs: number,
): AgentContextDiagnosticCheck {
  const corrupt = inspection.status === "unreadable"
    || inspection.status === "invalid-row";
  const absent = inspection.status === "database-missing"
    || inspection.status === "row-missing"
    || inspection.status === "table-missing";
  const remote = inspection.status === "remote-workspace";
  const status = corrupt || !engineConfigured ? "failed" : absent || remote ? "warning" : "passed";
  const code = corrupt
    ? "runtime_config_unreadable"
    : !engineConfigured
      ? "workspace_engine_unconfigured"
      : remote
        ? "remote_workspace_runtime_not_inspected"
      : absent
        ? "runtime_config_not_initialized"
        : "workspace_runtime_configured";
  const message = corrupt
    ? "The selected workspace runtime configuration could not be safely decoded."
    : !engineConfigured
      ? "The selected workspace does not have an OpenCode runtime endpoint configured."
      : absent
        ? "The runtime configuration database or selected workspace row has not been initialized."
        : remote
          ? "A local runtime row was not inspected for the remote workspace shell."
        : "The selected workspace runtime configuration is available and the engine endpoint is configured.";
  return diagnosticCheck({
    id: "workspace-runtime",
    status,
    evidenceKind: corrupt ? "unavailable" : "derived",
    code,
    message,
    owner: corrupt ? "openwork-server" : engineConfigured ? "openwork-server" : "member",
    action: status === "passed"
      ? "No action is required."
      : corrupt
        ? "Repair the OpenWork runtime state before relying on injected configuration."
        : remote
          ? "Run diagnostics on the OpenWork server that owns the workspace."
          : "Start or configure the selected workspace runtime, then rerun diagnostics.",
    details: {
      workspaceType: workspace.workspaceType,
      remoteType: workspace.remoteType ?? null,
      runtimeInspectionStatus: inspection.status,
    },
    durationMs,
  });
}

export async function runAgentContextDiagnostics(input: {
  config: ServerConfig;
  workspace: WorkspaceInfo;
  request: AgentContextDiagnosticsRequest;
  inspectRegistration: InspectMcpRegistration;
  dependencies?: DiagnosticDependencies;
}): Promise<AgentContextDiagnosticsReport> {
  const request = agentContextDiagnosticsRequestSchema.parse(input.request);
  input.dependencies?.signal?.throwIfAborted();
  const now = input.dependencies?.now ?? Date.now;
  const uuid = input.dependencies?.uuid ?? randomUUID;
  const fetchImpl = input.dependencies?.fetchImpl ?? fetch;
  const startedMs = now();
  const startedAt = new Date(startedMs).toISOString();
  const runId = uuid();
  const engineConfigured = Boolean(resolveWorkspaceOpencodeConnection(input.config, input.workspace).baseUrl?.trim());

  let effectiveEngine: EffectiveEngineSnapshot | null = null;
  let engineApiReadPerformed = false;
  let engineInspectionStatus: "observed" | "not-configured" | "not-supplied" | "invalid" | "unavailable" = engineConfigured
    ? "not-supplied"
    : "not-configured";
  const engineInspectionStarted = now();
  if (engineConfigured && input.workspace.workspaceType === "local" && input.dependencies?.inspectEffectiveEngine) {
    engineApiReadPerformed = true;
    const timeoutSignal = AbortSignal.timeout(10_000);
    const signal = input.dependencies.signal
      ? AbortSignal.any([input.dependencies.signal, timeoutSignal])
      : timeoutSignal;
    try {
      const payload = await input.dependencies.inspectEffectiveEngine(signal);
      effectiveEngine = validateEffectiveEngineSnapshot(payload);
      engineInspectionStatus = effectiveEngine ? "observed" : "invalid";
    } catch {
      input.dependencies?.signal?.throwIfAborted();
      engineInspectionStatus = "unavailable";
    }
  }
  const engineInspectionDuration = elapsed(engineInspectionStarted, now);

  input.dependencies?.signal?.throwIfAborted();
  const runtimeStarted = now();
  const runtimeInspection: RuntimeOpencodeConfigInspection = input.workspace.workspaceType === "remote"
    ? { status: "remote-workspace", config: {} }
    : await inspectRuntimeOpencodeConfigState(input.config, input.workspace.id, {
      signal: input.dependencies?.signal,
    });
  input.dependencies?.signal?.throwIfAborted();
  const runtimeDuration = elapsed(runtimeStarted, now);
  const runtime = runtimeInspection.config;
  const expectedRuntimeConfig = buildOpenworkRuntimeConfigObjectFromSnapshot(runtime);
  const expectedAgents = isRecord(expectedRuntimeConfig.agent) ? expectedRuntimeConfig.agent : {};
  const expectedAgent = isRecord(expectedAgents.openwork) ? expectedAgents.openwork : null;
  const effectiveOpenworkAgent = effectiveEngine?.agents.find((agent) => agent.name === "openwork") ?? null;
  const effectiveAgentModeUsable = effectiveOpenworkAgent?.mode === "primary"
    || effectiveOpenworkAgent?.mode === "all";
  const effectiveAgentUsable = Boolean(
    effectiveOpenworkAgent
    && effectiveEngine?.defaultAgent === "openwork"
    && !effectiveOpenworkAgent.hidden
    && effectiveAgentModeUsable,
  );
  const agentEvidenceSource = effectiveEngine ? "effective-engine" as const : "configured-intent" as const;
  const reportedAgent = effectiveEngine
    ? effectiveOpenworkAgent
      ? { prompt: effectiveOpenworkAgent.prompt }
      : null
    : expectedAgent;
  const prompt = promptEvidence(reportedAgent);
  const expectedPrompt = promptEvidence(expectedAgent);
  const promptMarkersPresent = prompt.markers.searchCapabilities
    && prompt.markers.executeCapability
    && prompt.markers.memoryBank;
  const canonicalPromptDigestMatch = prompt.sha256 !== null
    && expectedPrompt.sha256 !== null
    && prompt.sha256 === expectedPrompt.sha256;
  const promptMatchesCanonicalIntent = promptMarkersPresent && canonicalPromptDigestMatch;
  const expectedPlugins = Array.isArray(expectedRuntimeConfig.plugin)
    ? expectedRuntimeConfig.plugin.filter((value): value is string => typeof value === "string")
    : [];
  const reportedPlugins = effectiveEngine?.pluginSpecs ?? expectedPlugins;
  const pluginLabels = [...new Set(reportedPlugins.flatMap((spec) => {
    const label = pluginLabel(spec);
    return label ? [label] : [];
  }))].slice(0, 100);
  const canonicalConnectPluginSpec = expectedPlugins.find(
    (spec) => pluginLabel(spec) === "openwork-extensions-preview",
  ) ?? null;
  const canonicalPluginSpecMatched = canonicalConnectPluginSpec !== null
    && reportedPlugins.some(
      (reportedPlugin) => pluginSpecIdentity(reportedPlugin) === pluginSpecIdentity(canonicalConnectPluginSpec),
    );

  const projectAgent = effectiveEngine
    ? {
      available: false,
      defaultAgentOverride: false,
      agentConfigOverride: false,
      agentFileOverride: false,
    }
    : await inspectProjectAgent(input.workspace, input.dependencies?.signal);
  input.dependencies?.signal?.throwIfAborted();
  const projectOverrideDetected = projectAgent.defaultAgentOverride
    || projectAgent.agentConfigOverride
    || projectAgent.agentFileOverride;

  let connectSnapshot: ConnectSnapshot;
  let connectSnapshotAvailable = true;
  let connectStateStatus: ConnectStateInspectionStatus = "unreadable";
  try {
    if (input.workspace.workspaceType === "remote") throw new Error("passive remote inspection");
    const inspection = await inspectConnectSnapshot(input.config, { signal: input.dependencies?.signal });
    connectStateStatus = inspection.status;
    connectSnapshotAvailable = inspection.status === "available" || inspection.status === "missing";
    connectSnapshot = inspection.snapshot;
  } catch {
    input.dependencies?.signal?.throwIfAborted();
    connectSnapshotAvailable = false;
    connectSnapshot = {
      connectEnabled: false,
      connectCatalogEnabled: false,
      cloudMcpPresent: false,
      cloudHealth: null,
      workspace: {
        resolution: "unknown",
        id: null,
        directory: null,
        reason: "Passive Connect inspection was unavailable",
      },
      googleWorkspace: { legacyConfigured: false },
    };
  }
  const selectedCloudMcpPresent = Object.hasOwn(runtimeMcpMap(runtime), OPENWORK_CLOUD_MCP_NAME);
  const branch = expectedConnectBranch(connectSnapshot);
  const crossWorkspaceSteeringDrift = connectSnapshot.cloudMcpPresent && !selectedCloudMcpPresent;

  const { inventory, passiveLocalLayersAvailable } = effectiveEngine
    ? { inventory: runtimeOnlyMcpInventory(runtime), passiveLocalLayersAvailable: false }
    : await inspectMcpInventory(
      input.workspace,
      runtime,
      input.dependencies?.signal,
    );
  const engineConfigItems = effectiveEngine?.mcps.map((item) => ({
    ...item,
    source: "engine.config" as const,
    disabledByTools: item.name === OPENWORK_CLOUD_MCP_NAME
      ? assessEffectiveToolPolicy(effectiveEngine).status === "denied" || undefined
      : undefined,
  }));
  const inventoryTotal = inventory.items.length + (engineConfigItems?.length ?? 0);
  const combinedInventoryItems = [...inventory.items, ...(engineConfigItems ?? [])];
  const inventoryItems = combinedInventoryItems.slice(0, 200);
  const runtimeCloudItem = combinedInventoryItems.find((item) =>
    item.source === "config.remote" && item.name === OPENWORK_CLOUD_MCP_NAME,
  );
  if (
    runtimeCloudItem
    && !inventoryItems.includes(runtimeCloudItem)
    && inventoryItems.length === 200
  ) {
    inventoryItems[199] = runtimeCloudItem;
  }
  const managedMcpNames = new Set(Object.keys(runtimeMcpMap(runtime)));
  const registrationByItem = new Map<DiagnosticMcpItem, McpRegistrationInspection>();
  const registrationForItem = (item: DiagnosticMcpItem): McpRegistrationInspection => {
    const existing = registrationByItem.get(item);
    if (existing) return existing;
    const inspection: McpRegistrationInspection = item.source === "config.remote" && managedMcpNames.has(item.name)
      ? normalizeRegistrationInspection(input.inspectRegistration(item.name, item.config))
      : { status: "not-recorded", source: null, recordAgeMs: null };
    registrationByItem.set(item, inspection);
    return inspection;
  };
  const mcps = inventoryItems.map((item) => mcpEvidence(item, registrationForItem(item).status, managedMcpNames));
  const runtimeCloudConfig = runtimeMcpMap(runtime)[OPENWORK_CLOUD_MCP_NAME] ?? null;
  const staticallyDeniedCloudAgentToolIds = new Set(inventory.toolPolicy.deniedToolIds);
  const effectiveToolPolicy = assessEffectiveToolPolicy(effectiveEngine);
  const cloudToolPolicyStatus = effectiveEngine
    ? effectiveToolPolicy.status
    : staticallyDeniedCloudAgentToolIds.size > 0
      ? "denied" as const
      : "unavailable" as const;
  const deniedCloudAgentToolIds = new Set(
    cloudToolPolicyStatus === "denied"
      ? effectiveEngine
        ? effectiveToolPolicy.deniedToolIds
        : staticallyDeniedCloudAgentToolIds
      : [],
  );
  const policyUnavailableReasons = effectiveEngine
    ? effectiveToolPolicy.unavailableReasons
    : [
      "effective_engine_snapshot_unavailable",
      ...(inventory.toolPolicy.status === "unavailable" ? ["passive_static_policy_unavailable"] : []),
    ];
  const reportedToolPermission = (toolId: string): AgentContextToolPermission => {
    if (deniedCloudAgentToolIds.has(toolId)) return "denied";
    if (cloudToolPolicyStatus !== "available" && effectiveToolPolicy.status !== "denied") {
      return "unspecified";
    }
    const decision = effectiveToolPolicy.decisions[toolId];
    if (decision === "allow") return "allowed";
    if (decision === "ask") return "approval-required";
    return "unspecified";
  };
  const cloudProbe = await probeOpenworkCloudCatalog({
    workspaceId: input.workspace.id,
    workspaceType: input.workspace.workspaceType,
    runtimeConfigAvailable: runtimeInspection.status === "available",
    config: runtimeInspection.status === "unreadable"
      || runtimeInspection.status === "invalid-row"
      || runtimeInspection.status === "table-missing"
      ? null
      : runtimeCloudConfig,
    toolPolicyStatus: cloudToolPolicyStatus,
    toolPolicyProvenance: effectiveEngine && effectiveToolPolicy.status !== "unavailable"
      ? "authoritative-effective-engine"
      : staticallyDeniedCloudAgentToolIds.size > 0
        ? "passive-static-subset"
        : "unavailable",
    registrationStatus: runtimeCloudItem && runtimeCloudConfig
      ? registrationForItem(runtimeCloudItem).status
      : "not-recorded",
    requestId: runId,
    fetchImpl,
    now,
    signal: input.dependencies?.signal,
  });
  input.dependencies?.signal?.throwIfAborted();

  const remoteMcps = inventory.items.filter((item) => item.source === "config.remote");
  const engineReachableNow = engineInspectionStatus === "observed" || engineInspectionStatus === "invalid";
  const registrationInspections = remoteMcps.map((item) => registrationForItem(item));
  const enabledRemoteMcps = remoteMcps.filter((item) => item.config.enabled !== false);
  const disabledRemoteMcps = remoteMcps.filter((item) => item.config.enabled === false);
  const enabledRegistrationInspections = enabledRemoteMcps.map((item) => registrationForItem(item));
  const disabledRegistrationInspections = disabledRemoteMcps.map((item) => registrationForItem(item));
  const enabledRegistrationStatuses = enabledRegistrationInspections.map((inspection) => inspection.status);
  const disabledRegistrationStatuses = disabledRegistrationInspections.map((inspection) => inspection.status);
  const connectedRegistrationCount = enabledRegistrationStatuses.filter((status) => status === "connected").length;
  const missingRegistrationCount = enabledRegistrationStatuses.filter((status) => status === "not-recorded").length;
  const enabledFailedRegistrationDetails = enabledRemoteMcps.flatMap((item): FailedRegistrationDetail[] => {
    const inspection = registrationForItem(item);
    if (inspection.status === "connected" || inspection.status === "not-recorded") return [];
    return [{
      name: safeText(item.name, 160, "unnamed-mcp"),
      status: inspection.status,
      source: inspection.source ?? null,
      recordAgeMs: inspection.recordAgeMs ?? null,
      engineReachableNow,
    }];
  });
  const disabledFailedRegistrationDetails = disabledRemoteMcps.flatMap((item): FailedRegistrationDetail[] => {
    const inspection = registrationForItem(item);
    if (inspection.status === "disabled" || inspection.status === "not-recorded") return [];
    return [{
      name: safeText(item.name, 160, "unnamed-mcp"),
      status: inspection.status,
      source: inspection.source ?? null,
      recordAgeMs: inspection.recordAgeMs ?? null,
      engineReachableNow,
    }];
  });
  const failedRegistrationDetails = [
    ...enabledFailedRegistrationDetails,
    ...disabledFailedRegistrationDetails,
  ];
  const failedRegistrationCount = failedRegistrationDetails.length;
  const staleRegistrationFailure = failedRegistrationDetails.length > 0
    && failedRegistrationDetails.every((failure) =>
      failure.engineReachableNow && failure.recordAgeMs !== null && failure.recordAgeMs > 60_000,
    );
  const layerHealthProblem = inventory.layerStatus.project === "invalid"
    || inventory.layerStatus.project === "unreadable"
    || inventory.layerStatus.global === "invalid"
    || inventory.layerStatus.global === "unreadable";

  const checks: AgentContextDiagnosticCheck[] = [
    diagnosticCheck({
      id: "request-safety",
      status: "passed",
      evidenceKind: "observed",
      code: "strict_request_validated",
      message: "The request matched the strict diagnostics schema and contained only safe organization summaries.",
      owner: "openwork-server",
      action: "No action is required.",
      details: {
        organizationProbeStatus: request.organizationConnectionsProbe.status,
        organizationConnectionTotalCount: request.organizationConnectionsProbe.totalCount,
        organizationConnectionCount: request.organizationConnections.length,
        organizationConnectionsTruncated: request.organizationConnectionsProbe.truncated,
      },
    }),
    runtimeHealthCheck(input.workspace, engineConfigured, runtimeInspection, runtimeDuration),
    diagnosticCheck({
      id: "connect-steering-scope",
      status: !connectSnapshotAvailable || crossWorkspaceSteeringDrift ? "warning" : "passed",
      evidenceKind: connectSnapshotAvailable ? "derived" : "unavailable",
      code: !connectSnapshotAvailable
        ? "connect_state_unavailable"
        : crossWorkspaceSteeringDrift
          ? "cross_workspace_steering_drift"
          : "connect_branch_" + branch,
      message: !connectSnapshotAvailable
        ? "The passive Connect steering state could not be inspected."
        : crossWorkspaceSteeringDrift
          ? "Global Connect steering sees OpenWork Cloud, but the selected workspace does not contain that managed MCP."
          : "The expected Connect steering branch is internally consistent for the selected workspace.",
      owner: !connectSnapshotAvailable || crossWorkspaceSteeringDrift ? "openwork-server" : "openwork-client",
      action: !connectSnapshotAvailable
        ? "Verify the OpenWork server runtime state and rerun diagnostics."
        : crossWorkspaceSteeringDrift
          ? "Reconnect or sync OpenWork Cloud for the selected workspace."
          : "No action is required.",
      details: {
        expectedBranch: branch,
        connectStateStatus,
        connectEnabled: connectSnapshot.connectEnabled,
        legacyGoogleWorkspaceConfigured: connectSnapshot.googleWorkspace.legacyConfigured,
        globalCloudMcpPresent: connectSnapshot.cloudMcpPresent,
        selectedWorkspaceCloudMcpPresent: selectedCloudMcpPresent,
      },
    }),
    diagnosticCheck({
      id: "agent-resolution",
      status: effectiveEngine
        ? effectiveAgentUsable ? "passed" : "failed"
        : "warning",
      evidenceKind: effectiveEngine
        ? "observed"
        : runtimeInspection.status === "available" ? "expected" : "unavailable",
      code: effectiveEngine
        ? !effectiveOpenworkAgent
          ? "effective_openwork_agent_missing"
          : effectiveEngine.defaultAgent !== "openwork"
            ? "effective_default_agent_mismatch"
            : effectiveOpenworkAgent.hidden
              ? "effective_openwork_agent_hidden"
              : !effectiveAgentModeUsable
                ? "effective_openwork_agent_not_primary"
            : "effective_openwork_agent_selected"
        : projectOverrideDetected
          ? "configured_agent_has_override_layers"
          : "runtime_agent_intent_only",
      message: effectiveEngine
        ? !effectiveOpenworkAgent
          ? "The effective engine configuration does not contain the OpenWork agent."
          : effectiveEngine.defaultAgent !== "openwork"
            ? "The effective engine default does not select the OpenWork agent."
            : effectiveOpenworkAgent.hidden
              ? "The effective OpenWork agent is hidden and cannot be used as the default agent."
              : !effectiveAgentModeUsable
                ? "The effective OpenWork agent is subagent-only and cannot be used as the default agent."
            : "The effective engine default selects the resolved OpenWork agent."
        : projectOverrideDetected
          ? "The configured OpenWork agent intent has project override layers and could not be confirmed live."
          : "Only the configured OpenWork agent intent was available; effective resolution was not observed.",
      owner: effectiveEngine ? "opencode-engine" : projectOverrideDetected ? "member" : "opencode-engine",
      action: effectiveEngine && effectiveAgentUsable
        ? "No action is required."
        : effectiveEngine
          ? "Restore the OpenWork agent and default-agent injection, then restart the selected workspace engine."
          : "Check the selected workspace engine health and rerun diagnostics.",
      details: {
        configuredAgentPresent: Boolean(expectedAgent),
        effectiveAgentPresent: effectiveEngine ? Boolean(effectiveOpenworkAgent) : null,
        effectiveDefaultAgentIsOpenwork: effectiveEngine ? effectiveEngine.defaultAgent === "openwork" : null,
        effectiveAgentHidden: effectiveOpenworkAgent?.hidden ?? null,
        effectiveAgentMode: effectiveOpenworkAgent?.mode ?? null,
        effectiveAgentUsableAsDefault: effectiveEngine ? effectiveAgentUsable : null,
        projectLayersAvailable: projectAgent.available,
        projectDefaultAgentOverride: projectAgent.defaultAgentOverride,
        projectAgentConfigOverride: projectAgent.agentConfigOverride,
        projectAgentFileOverride: projectAgent.agentFileOverride,
        runtimeInspectionStatus: runtimeInspection.status,
      },
    }),
    diagnosticCheck({
      id: "agent-prompt-markers",
      status: promptMatchesCanonicalIntent ? "passed" : "failed",
      evidenceKind: effectiveEngine ? "observed" : "expected",
      code: promptMatchesCanonicalIntent
        ? effectiveEngine ? "effective_prompt_matches_canonical" : "configured_prompt_matches_canonical"
        : !promptMarkersPresent
          ? effectiveEngine ? "effective_prompt_markers_missing" : "configured_prompt_markers_missing"
          : effectiveEngine ? "effective_prompt_digest_mismatch" : "configured_prompt_digest_mismatch",
      message: promptMatchesCanonicalIntent
        ? effectiveEngine
          ? "The effective OpenWork base prompt exactly matches the canonical configured injection and contains every required marker."
          : "The configured OpenWork base prompt intent matches its canonical generated injection and contains every required marker."
        : !promptMarkersPresent
          ? effectiveEngine
            ? "The effective OpenWork base prompt is missing one or more required markers."
            : "The configured OpenWork base prompt intent is missing one or more required markers."
          : effectiveEngine
            ? "The effective OpenWork base prompt contains the markers but does not match the canonical configured injection."
            : "The configured OpenWork base prompt markers are present, but its digest does not match the canonical generated injection.",
      owner: effectiveEngine ? "opencode-engine" : "openwork-server",
      action: promptMatchesCanonicalIntent
        ? "No action is required."
        : "Restore the canonical OpenWork runtime agent definition.",
      details: {
        ...prompt.markers,
        promptLength: prompt.length,
        canonicalPromptDigestMatch,
        rawPromptIncluded: false,
      },
    }),
    diagnosticCheck({
      id: "agent-connect-tool-permissions",
      status: cloudToolPolicyStatus === "denied"
        ? "failed"
        : cloudToolPolicyStatus === "unavailable"
          ? "warning"
          : "passed",
      evidenceKind: cloudToolPolicyStatus === "unavailable"
        ? "unavailable"
        : effectiveEngine ? "observed" : "derived",
      code: cloudToolPolicyStatus === "denied"
        ? !effectiveEngine && staticallyDeniedCloudAgentToolIds.size > 0
          ? "required_connect_tools_denied_by_static_policy"
          : "required_connect_tools_denied_by_effective_policy"
        : cloudToolPolicyStatus === "unavailable"
          ? "effective_connect_tool_policy_unavailable"
          : "required_connect_tool_ids_not_denied_by_effective_policy",
      message: cloudToolPolicyStatus === "denied"
        ? !effectiveEngine && staticallyDeniedCloudAgentToolIds.size > 0
          ? "A passively inspected static OpenCode policy denies one or more required OpenWork Cloud capability tools."
          : "The effective OpenCode agent policy hides one or more required OpenWork Cloud capability tools."
        : cloudToolPolicyStatus === "unavailable"
          ? "Required OpenWork Cloud tool visibility could not be verified from the effective selected-engine agent."
          : "The effective OpenCode agent policy does not deny either required OpenWork Cloud candidate tool ID; the live engine tool registry was not read.",
      owner: cloudToolPolicyStatus === "available"
        ? "openwork-server"
        : cloudToolPolicyStatus === "unavailable"
          ? "opencode-engine"
          : "member",
      action: cloudToolPolicyStatus === "denied"
        ? "Allow the denied openwork-cloud capability tool IDs in top-level or OpenWork agent permission policy, then rerun diagnostics."
        : cloudToolPolicyStatus === "unavailable"
          ? "Check the selected workspace engine health and rerun diagnostics."
          : "No policy change is required; confirm catalog and registration evidence because this policy check alone does not prove live tool presence.",
      details: {
        searchCapabilities: reportedToolPermission(`${OPENWORK_CLOUD_MCP_NAME}_search_capabilities`),
        executeCapability: reportedToolPermission(`${OPENWORK_CLOUD_MCP_NAME}_execute_capability`),
        deniedRelevantToolCount: cloudToolPolicyStatus === "unavailable" ? null : deniedCloudAgentToolIds.size,
        staticPolicyScope: inventory.toolPolicy.scope,
        staticPolicyLayerStatus: inventory.toolPolicy.status,
        effectivePolicyStatus: effectiveToolPolicy.status,
        effectivePolicySnapshotApplied: effectiveToolPolicy.status !== "unavailable",
        policyUnavailableReasons,
        effectiveEnginePolicyNotObserved: effectiveToolPolicy.status === "unavailable",
      },
    }),
    diagnosticCheck({
      id: "plugin-registration",
      status: canonicalPluginSpecMatched ? "passed" : "failed",
      evidenceKind: effectiveEngine ? "observed" : "expected",
      code: canonicalPluginSpecMatched
        ? effectiveEngine ? "connect_steering_plugin_effective" : "connect_steering_plugin_configured"
        : "connect_steering_plugin_missing",
      message: canonicalPluginSpecMatched
        ? effectiveEngine
          ? "The Connect steering plugin is present in the effective engine configuration."
          : "The Connect steering plugin is present in the configured runtime injection intent."
        : effectiveEngine
          ? "The Connect steering plugin is missing from the effective engine configuration."
          : "The Connect steering plugin is missing from the configured runtime injection intent.",
      owner: effectiveEngine ? "opencode-engine" : "openwork-server",
      action: canonicalPluginSpecMatched
        ? "No action is required."
        : "Restore the canonical OpenWork runtime plugin bundle.",
      details: {
        configuredPluginLabels: pluginLabels,
        canonicalPluginSpecMatched,
        effectivePluginConfigurationObserved: Boolean(effectiveEngine),
        pluginExecutionNotClaimed: true,
      },
    }),
    diagnosticCheck({
      id: "mcp-inventory",
      status: effectiveEngine
        ? inventoryTotal > 200 ? "warning" : "passed"
        : inventoryTotal > 200
          || inventory.collisions.length > 0
          || !passiveLocalLayersAvailable
          || layerHealthProblem
          ? "warning"
          : "passed",
      evidenceKind: effectiveEngine ? "observed" : layerHealthProblem ? "unavailable" : "derived",
      code: effectiveEngine
        ? inventoryTotal > 200
          ? "mcp_inventory_truncated"
          : "engine_config_and_runtime_mcp_inventory_observed"
        : layerHealthProblem
        ? "mcp_config_layer_unreadable"
        : inventoryTotal > 200
          ? "mcp_inventory_truncated"
          : inventory.collisions.length > 0
            ? "mcp_layer_collisions_present"
            : !passiveLocalLayersAvailable
              ? "local_mcp_layers_unavailable"
              : "bounded_mcp_sources_inventoried",
      message: effectiveEngine
        ? inventoryTotal > 200
          ? "The combined engine-configuration and runtime-managed MCP evidence exceeded the report limit and was truncated."
          : "The selected engine's merged MCP configuration and OpenWork-managed dynamic injection intent were inventoried as separate evidence sources."
        : layerHealthProblem
        ? "One or more static MCP configuration layers are invalid or unreadable."
        : inventoryTotal > 200
          ? "The passive MCP inventory exceeded the report limit and was truncated."
          : inventory.collisions.length > 0
            ? "Multiple configuration layers define one or more MCP names; no effective winner is claimed."
            : !passiveLocalLayersAvailable
              ? "Only server-managed runtime MCP layers were available for this workspace."
              : "The server-managed runtime and selected project/global MCP sources were inventoried without claiming complete OpenCode resolution.",
      owner: effectiveEngine
        ? "opencode-engine"
        : layerHealthProblem ? "member" : inventory.collisions.length > 0 ? "member" : "openwork-server",
      action: effectiveEngine
        ? inventoryTotal > 200
          ? "Reduce the configured MCP count or inspect the engine and OpenWork runtime sources directly."
          : "No action is required; review registration evidence for runtime-managed dynamic MCP connection state."
        : layerHealthProblem
        ? "Repair the invalid or unreadable OpenCode configuration layer, then rerun diagnostics."
        : inventory.collisions.length > 0
          ? "Review the listed MCP layer collisions and remove unintended duplicate definitions."
          : inventoryTotal > 200
            ? "Reduce the configured MCP layer count or inspect the server configuration directly."
            : "No action is required.",
      details: {
        configuredMcpEntryCount: inventoryTotal,
        reportedMcpEntryCount: inventoryItems.length,
        collisionCount: effectiveEngine ? 0 : inventory.collisions.length,
        collisions: effectiveEngine ? [] : collisionDetails(inventory.collisions),
        projectLayerStatus: inventory.layerStatus.project,
        globalLayerStatus: inventory.layerStatus.global,
        inventoryScope: effectiveEngine
          ? "engine-merged-config-plus-runtime-managed-injection"
          : "bounded-openwork-sources",
        completeDynamicMcpStateClaimed: false,
        engineConfigMcpCount: engineConfigItems?.length ?? 0,
        runtimeManagedMcpCount: inventory.items.filter((item) => item.source === "config.remote").length,
      },
    }),
    engineConfigCheck(effectiveEngine, engineInspectionStatus, engineApiReadPerformed, engineInspectionDuration),
    engineAgentCheck(effectiveEngine, engineInspectionStatus, engineApiReadPerformed, engineInspectionDuration),
    diagnosticCheck({
      id: "engine-plugin-tools",
      status: "warning",
      evidenceKind: "unavailable",
      code: "per_request_connect_context_not_observed",
      message: "The canonical Connect plugin configuration was checked, but diagnostics did not start an LLM turn and cannot prove its per-request context transform or complete tool registry execution.",
      owner: "opencode-engine",
      action: "Review the canonical plugin match, effective permission, MCP registration, and cloud catalog checks together; use a controlled agent turn if execution proof is required.",
      details: {
        effectivePluginConfigurationObserved: Boolean(effectiveEngine),
        canonicalPluginSpecMatched,
        engineToolCatalogReadPerformed: false,
        llmTurnStarted: false,
        perRequestContextTransformObserved: false,
      },
    }),
    diagnosticCheck({
      id: "engine-mcp-sync",
      status: failedRegistrationCount > 0
        ? staleRegistrationFailure ? "warning" : "failed"
        : missingRegistrationCount > 0
          ? "warning"
          : remoteMcps.length > 0
            ? "passed"
            : "skipped",
      evidenceKind: "derived",
      code: failedRegistrationCount > 0
        ? staleRegistrationFailure ? "mcp_registration_stale_failure" : "mcp_registration_not_connected"
        : missingRegistrationCount > 0
          ? "mcp_registration_not_recorded"
          : remoteMcps.length > 0
            ? "managed_mcp_registration_states_healthy"
            : "no_managed_mcp_registration",
      message: failedRegistrationCount > 0
        ? staleRegistrationFailure
          ? "Managed MCP registration failure evidence is stale while the engine is reachable."
          : "One or more enabled managed MCPs are not connected, or a disabled managed MCP has an unexpected engine state."
        : missingRegistrationCount > 0
          ? "One or more enabled managed MCPs do not have a current engine registration record."
          : remoteMcps.length > 0
            ? "Every enabled OpenWork-managed MCP has a current connected registration result; configured-disabled entries are not treated as injected tools."
            : "No server-managed MCP registration was available to inspect.",
      owner: failedRegistrationCount > 0 || missingRegistrationCount > 0 ? "opencode-engine" : "openwork-server",
      action: failedRegistrationCount > 0 || missingRegistrationCount > 0
        ? staleRegistrationFailure
          ? "The engine is reachable and this evidence is stale; rerun diagnostics. No repair is needed unless it persists."
          : "Start or repair the workspace runtime and rerun diagnostics."
        : "No action is required.",
      details: {
        managedMcpCount: remoteMcps.length,
        enabledManagedMcpCount: enabledRemoteMcps.length,
        disabledManagedMcpCount: disabledRemoteMcps.length,
        connectedCount: connectedRegistrationCount,
        disabledCount: registrationInspections.filter((inspection) => inspection.status === "disabled").length,
        failedCount: failedRegistrationCount,
        needsAuthCount: registrationInspections.filter((inspection) => inspection.status === "needs-auth").length,
        needsClientRegistrationCount: registrationInspections.filter(
          (inspection) => inspection.status === "needs-client-registration",
        ).length,
        notRecordedCount: missingRegistrationCount,
        engineReachableNow,
        failedRegistrations: failedRegistrationDetails,
        registrationConnectionEvidenceClaimed: connectedRegistrationCount > 0,
        completeLiveToolRegistryClaimed: false,
      },
    }),
    diagnosticCheck({
      id: "engine-mcp-status",
      status: "skipped",
      evidenceKind: "unavailable",
      code: "live_mcp_status_intentionally_not_queried",
      message: "Live MCP status was not queried because that endpoint can connect every enabled MCP.",
      owner: "opencode-engine",
      action: "Review the bounded OpenWork Cloud catalog probe and exact managed registration response evidence instead.",
      details: {
        effectiveMcpConfigurationObserved: Boolean(effectiveEngine),
        mcpStatusApiReadPerformed: false,
      },
    }),
    cloudCatalogCheck(cloudProbe),
    organizationCheck(request),
    diagnosticCheck({
      id: "report-safety",
      status: "passed",
      evidenceKind: "derived",
      code: "sanitized_allowlist_report",
      message: "The report contains only allowlisted evidence and excludes credential-bearing or raw material; diagnostics did not directly request mutations, provider operations, or capability calls.",
      owner: "openwork-server",
      action: engineApiReadPerformed
        ? "Be aware that reading a cold engine may initialize configured bootstrap or plugin hooks whose side effects this report does not inspect."
        : "No action is required.",
      details: {
        rawPromptIncluded: false,
        authorizationHeaderValueIncluded: false,
        providerResponseIncluded: false,
        stackTraceIncluded: false,
        fullUrlIncluded: false,
        engineBootstrapMayHaveRun: engineApiReadPerformed,
        engineBootstrapSideEffectsInspected: false,
      },
    }),
  ];

  const overall = checks.some((check) => check.status === "failed")
    ? "failed"
    : checks.some((check) => check.status === "warning")
      ? "warning"
      : "passed";
  const completedMs = now();
  const report: AgentContextDiagnosticsReport = {
    schemaVersion: AGENT_CONTEXT_DIAGNOSTICS_SCHEMA_VERSION,
    runId,
    startedAt,
    completedAt: new Date(completedMs).toISOString(),
    durationMs: Math.max(0, Math.round(completedMs - startedMs)),
    overall,
    firstFailedCheck: checks.find((check) => check.status === "failed")?.id ?? null,
    workspace: {
      id: safeText(input.workspace.id, 160, "unknown-workspace"),
      name: safeText(input.workspace.name, 240, "Unnamed workspace"),
      type: input.workspace.workspaceType,
      remoteType: input.workspace.remoteType ?? null,
      engineConfigured,
    },
    checks,
    agent: {
      evidenceSource: agentEvidenceSource,
      defaultAgent: safeText(
        effectiveEngine ? effectiveEngine.defaultAgent : expectedRuntimeConfig.default_agent,
        160,
      ) || null,
      configuredOpenworkAgent: {
        state: effectiveEngine
          ? effectiveOpenworkAgent ? "present" : "missing"
          : expectedAgent?.disable === true
            ? "configured-disabled"
            : expectedAgent
              ? "present"
              : "missing",
        mode: effectiveOpenworkAgent
          ? effectiveOpenworkAgent.mode
          : expectedAgent?.mode === "subagent" || expectedAgent?.mode === "primary" || expectedAgent?.mode === "all"
            ? expectedAgent.mode
            : null,
        prompt,
        connectToolPermissions: {
          searchCapabilities: reportedToolPermission(`${OPENWORK_CLOUD_MCP_NAME}_search_capabilities`),
          executeCapability: reportedToolPermission(`${OPENWORK_CLOUD_MCP_NAME}_execute_capability`),
          deniedRelevantToolCount: cloudToolPolicyStatus === "unavailable" ? null : deniedCloudAgentToolIds.size,
        },
      },
      pluginLabels,
    },
    mcps,
    connect: {
      connectEnabled: connectSnapshot.connectEnabled,
      legacyGoogleWorkspaceConfigured: connectSnapshot.googleWorkspace.legacyConfigured,
      expectedBranch: branch,
      globalCloudMcpPresent: connectSnapshot.cloudMcpPresent,
      selectedWorkspaceCloudMcpPresent: selectedCloudMcpPresent,
      crossWorkspaceSteeringDrift,
    },
    observedCloudToolIds: cloudProbe.toolIds,
    organizationConnectionsProbe: request.organizationConnectionsProbe,
    organizationConnections: request.organizationConnections.map((connection) => ({
      ...connection,
      id: safeText(connection.id, 160, "unknown-connection"),
      name: safeText(connection.name, 160, "Unnamed connection"),
    })),
    safety: {
      diagnosticsWorkspaceRuntimeConfigurationReadOnly: true,
      cloudCatalogToolsListPerformed: cloudProbe.toolsListPerformed,
      directNonCloudMcpFetchPerformed: false,
      directMcpToolCallPerformed: false,
      directProviderOperationPerformed: false,
      directConfigurationMutationPerformed: false,
      directEphemeralCredentialMintPerformed: false,
      engineApiReadPerformed,
      engineBootstrapMayHaveRun: engineApiReadPerformed,
      engineBootstrapSideEffectsInspected: false,
      authSessionActivityMayBeRecorded: true,
      tokenValuesIncluded: false,
      authorizationHeaderValuesIncluded: false,
      credentialValuesIncluded: false,
      rawPromptsIncluded: false,
      providerResponsesIncluded: false,
      stackTracesIncluded: false,
      rawEngineErrorsIncluded: false,
      secretBearingUrlsIncluded: false,
      inputStrictlyValidated: true,
    },
  };
  return agentContextDiagnosticsReportSchema.parse(report);
}
