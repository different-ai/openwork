import type {
  OpenWorkServerV2HealthResponse,
  OpenWorkServerV2OpencodeHealthResponse,
  OpenWorkServerV2RootInfoResponse,
  OpenWorkServerV2RouterHealthResponse,
  OpenWorkServerV2RuntimeSummaryResponse,
  OpenWorkServerV2RuntimeVersionsResponse,
} from "@openwork/server-sdk";
import type {
  OpenworkServerCapabilities,
  OpenworkRuntimeSnapshot,
  OpenworkServerDiagnostics,
} from "../../lib/openwork-server";
import type { ServerTarget } from "./types";

function parseServerLocation(baseUrl: string) {
  try {
    const url = new URL(baseUrl);
    const port = Number.parseInt(url.port || (url.protocol === "https:" ? "443" : "80"), 10);
    return {
      host: url.hostname,
      port: Number.isFinite(port) ? port : 0,
    };
  } catch {
    return {
      host: baseUrl,
      port: 0,
    };
  }
}

export function normalizeLegacyDiagnostics(input: {
  diagnostics: OpenworkServerDiagnostics;
}) {
  return input.diagnostics;
}

export function buildSyntheticDiagnostics(input: {
  capabilities?: OpenworkServerCapabilities | null;
  target: ServerTarget;
  uptimeMs?: number | null;
  version?: string | null;
}): OpenworkServerDiagnostics {
  const server = parseServerLocation(input.target.baseUrl);
  return {
    ok: true,
    version: input.version ?? "",
    uptimeMs: input.uptimeMs ?? 0,
    readOnly: false,
    approval: { mode: "manual", timeoutMs: 0 },
    corsOrigins: [],
    workspaceCount: 0,
    activeWorkspaceId: null,
    selectedWorkspaceId: null,
    workspace: null,
    authorizedRoots: [],
    server: {
      host: server.host,
      port: server.port,
      configPath: null,
    },
    tokenSource: {
      client: input.target.token ? "app-target" : "none",
      host: input.target.hostToken ? "app-target" : "none",
    },
  } satisfies OpenworkServerDiagnostics;
}

export function normalizeServerV2Diagnostics(input: {
  health: OpenWorkServerV2HealthResponse;
  opencode: OpenWorkServerV2OpencodeHealthResponse;
  root: OpenWorkServerV2RootInfoResponse;
  router: OpenWorkServerV2RouterHealthResponse;
  runtimeSummary: OpenWorkServerV2RuntimeSummaryResponse;
  runtimeVersions: OpenWorkServerV2RuntimeVersionsResponse;
  target: ServerTarget;
}): OpenworkServerDiagnostics {
  const server = parseServerLocation(input.target.baseUrl);
  const runtimeSummary = input.runtimeSummary.data;
  const runtimeVersions = input.runtimeVersions.data;

  return {
    ok: input.health.data.status === "ok",
    version: input.root.data.version,
    uptimeMs: input.health.data.uptimeMs,
    readOnly: false,
    approval: { mode: "manual", timeoutMs: 0 },
    corsOrigins: [],
    workspaceCount: 0,
    activeWorkspaceId: null,
    selectedWorkspaceId: null,
    workspace: null,
    authorizedRoots: [],
    server: {
      host: server.host,
      port: server.port,
      configPath: null,
    },
    tokenSource: {
      client: input.target.token ? "app-target" : "none",
      host: input.target.hostToken ? "app-target" : "none",
    },
  } satisfies OpenworkServerDiagnostics;
}

export function summarizeLegacyRuntime(input: OpenworkRuntimeSnapshot | null | undefined) {
  const services = Array.isArray(input?.services) ? input.services : [];
  return {
    opencodeVersion: services.find((entry) => entry.name === "opencode")?.actualVersion ?? null,
    routerVersion: services.find((entry) => entry.name === "opencode-router")?.actualVersion ?? null,
  };
}

export function summarizeServerV2Runtime(input: {
  opencode: OpenWorkServerV2OpencodeHealthResponse;
  router: OpenWorkServerV2RouterHealthResponse;
  runtimeSummary: OpenWorkServerV2RuntimeSummaryResponse;
  runtimeVersions: OpenWorkServerV2RuntimeVersionsResponse;
}) {
  return {
    opencodeBaseUrl: input.opencode.data.baseUrl,
    opencodeStatus: input.opencode.data.status,
    opencodeVersion: input.runtimeVersions.data.active.opencodeVersion,
    routerBaseUrl: input.router.data.baseUrl,
    routerStatus: input.router.data.status,
    routerVersion: input.runtimeVersions.data.active.routerVersion,
    runtimeSource: input.runtimeSummary.data.source,
    runtimeTarget: input.runtimeSummary.data.target,
  };
}
