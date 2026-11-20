import { expect, test } from "bun:test";
import { DenApiError } from "../src/app/lib/den.ts";
import { OpenworkServerError, type OpenworkCloudMcpHealth } from "../src/app/lib/openwork-server.ts";
import {
  CLOUD_MCP_MAINTENANCE_RETRY_DELAYS_MS,
  cloudMcpMaintenanceFailure,
  runCloudMcpMaintenanceWithRetry,
  syncCloudControlMcpInBackground,
} from "../src/react-app/domains/connections/use-session-mcp-maintenance.ts";

test("connected-tools maintenance stops retrying when this computer's disk is full", () => {
  const full = cloudMcpMaintenanceFailure(new OpenworkServerError(507, "insufficient_storage", "Not enough disk space. Free up space on the computer running OpenWork, then try again."));
  expect(full.outcome).toBe("failed");
  if (full.outcome !== "failed") return;
  expect(full.issue).toMatchObject({
    code: "insufficient_storage",
    retryable: false,
    recommendedAction: "Free up disk space on this computer, then try again.",
    message: "Not enough disk space. Free up space on the computer running OpenWork, then try again.",
  });
});

test("other maintenance failures keep their retries and their advice", () => {
  const server = cloudMcpMaintenanceFailure(new OpenworkServerError(500, "internal_error", "Unexpected server error"));
  expect(server.outcome === "failed" && server.issue.retryable).toBe(true);
  expect(server.outcome === "failed" && server.issue.recommendedAction).toBe("Retry, then open Settings → Connect if the problem continues.");
  // A storage error from Den is another machine's disk, so nothing changes for it.
  const den = cloudMcpMaintenanceFailure(new DenApiError(507, "insufficient_storage", "Storage is full"));
  expect(den.outcome === "failed" && den.issue.retryable).toBe(true);
  // A request the server never answered is still worth another try.
  const unknown = cloudMcpMaintenanceFailure(new Error("network down"));
  expect(unknown.outcome === "failed" && unknown.issue.retryable).toBe(true);
});

const sandboxMessage = "This action can only run in the sandbox. Use the sandbox tools instead.";
const sandboxOnly = new OpenworkServerError(403, "sandbox_only", sandboxMessage);
const localBaseUrl = "http://127.0.0.1:3000";

function runListMcpMaintenance(errorForAttempt: (attempt: number) => OpenworkServerError | undefined, baseUrl = localBaseUrl) {
  const workspace = { id: "workspace-1", type: "local", directory: "/tmp/workspace", path: "/tmp/workspace" };
  const health: OpenworkCloudMcpHealth = {
    schemaVersion: 1, phase: "ready", usable: true, usableByCurrentModel: null, connectCatalogEnabled: true,
    workspace,
    desired: { present: true, name: "openwork-cloud", revision: null, config: null, token: { present: true, metadata: {} } },
    delivery: { state: "ready", desiredRevision: null, appliedRevision: null, updatedAt: null, appliedAt: null, lastAttemptAt: null },
    engine: { status: "connected" },
    tools: {
      expected: [], present: [], missing: [],
      direct: { checked: false, source: "mcp_tools_list", expected: [], present: [], missing: [] },
      providerProjection: { checked: false, present: [], missing: [] },
    },
    pluginCanaries: { expected: [], present: [], missing: [] },
    compatibility: {
      openwork: { serverVersion: "test", app: null },
      opencode: { expectedVersion: null, actualVersion: null, probe: "unknown" },
      pluginFileHashes: [],
      supportedFeatures: { dynamicMcp: true, directoryScoping: true, toolIds: true, providerToolProjection: true, pluginCanaries: true },
      experimentalToolIds: { checked: false, expected: [], present: [], missing: [], includesMcpTools: null },
      experimentalProviderTools: { checked: false, expected: [], present: [], missing: [], includesMcpTools: null },
    },
    toolDenies: [], firstFailure: null, checkedAt: new Date(0).toISOString(),
  };
  let listCalls = 0;
  const reports: { outcome: string; willRetry: boolean }[] = [];
  const delays: number[] = [];
  const done = runCloudMcpMaintenanceWithRetry({
    attempt: () => syncCloudControlMcpInBackground({
      workspaceId: workspace.id,
      settings: { baseUrl: "https://den.example.test", authToken: "test-token", activeOrgId: "org-1" },
      client: {
        baseUrl,
        listMcp: async () => {
          const error = errorForAttempt(++listCalls);
          if (error) throw error;
          return { items: [{ name: "openwork-cloud", config: { enabled: true }, source: "config.project" }] };
        },
        getOpenworkCloudMcpHealth: async () => health,
        reconcileOpenworkCloudMcp: async () => { throw new Error("Unexpected reconcile"); },
      },
    }),
    wait: async (delay) => { delays.push(delay); },
    onAttempt: ({ result, willRetry }) => { reports.push({ outcome: result.outcome, willRetry }); },
  });
  return { done, reports, delays };
}

test("maintenance reports retrying and becomes ready when the local sandbox transition clears", async () => {
  const { done, reports, delays } = runListMcpMaintenance((attempt) => attempt === 1 ? sandboxOnly : undefined);
  expect(await done).toMatchObject({ outcome: "ready" });
  expect(reports).toEqual([{ outcome: "failed", willRetry: true }, { outcome: "ready", willRetry: false }]);
  expect(delays).toEqual([1_000]);
});

test("maintenance exhausts retries on a persistent local sandbox refusal and preserves its message", async () => {
  const { done, reports, delays } = runListMcpMaintenance(() => sandboxOnly);
  expect(await done).toMatchObject({ outcome: "failed", issue: { code: "sandbox_only", message: sandboxMessage } });
  expect(delays).toEqual(CLOUD_MCP_MAINTENANCE_RETRY_DELAYS_MS);
  expect(reports.map(({ willRetry }) => willRetry)).toEqual([...delays.map(() => true), false]);
});

test.each([
  { baseUrl: localBaseUrl, error: new OpenworkServerError(403, "organization_policy_denied", "Blocked by policy") },
  { baseUrl: "https://worker.example.test", error: sandboxOnly },
])("maintenance does not retry $error.code from $baseUrl", async ({ baseUrl, error }) => {
  const { done, reports, delays } = runListMcpMaintenance(() => error, baseUrl);
  expect(await done).toMatchObject({ outcome: "failed", issue: { code: error.code, message: error.message, retryable: false } });
  expect(reports).toEqual([{ outcome: "failed", willRetry: false }]);
  expect(delays).toEqual([]);
});
