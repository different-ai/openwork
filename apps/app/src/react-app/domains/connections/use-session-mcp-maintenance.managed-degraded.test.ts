declare const afterEach: (fn: () => void) => void;
declare const beforeEach: (fn: () => void) => void;
declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void | Promise<void>) => void;
declare const expect: (value: unknown) => {
  toBe: (expected: unknown) => void;
  toEqual: (expected: unknown) => void;
  toContain: (expected: string) => void;
  not: { toContain: (expected: string) => void };
};

import type { DenMcpToken, DenSettings } from "../../../app/lib/den";
import {
  OpenworkServerError,
  type OpenworkCloudMcpHealth,
} from "../../../app/lib/openwork-server";
import { __setCloudMcpUserStateStorageForTest } from "./cloud-mcp-user-state";
import { syncCloudControlMcpInBackground } from "./use-session-mcp-maintenance";

const NOW = Date.parse("2026-08-15T12:00:00.000Z");
const WORKSPACE_ID = "workspace_1";
const SETTINGS: DenSettings = {
  baseUrl: "https://app.openwork.test",
  authToken: "session-token",
  activeOrgId: "organization_1",
};
const MINTED: DenMcpToken = {
  token: "mcp-token",
  expiresAt: new Date(NOW + 7 * 24 * 60 * 60 * 1000).toISOString(),
  organizationId: "organization_1",
  scopes: ["mcp:read", "mcp:write"],
  resource: "https://api.openwork.test/mcp",
};

function cloudHealth(usable: boolean): OpenworkCloudMcpHealth {
  return {
    schemaVersion: 1,
    phase: usable ? "ready" : "missing_desired",
    usable,
    usableByCurrentModel: usable ? true : null,
    connectCatalogEnabled: true,
    workspace: { id: WORKSPACE_ID, type: "local", directory: "/workspace", path: "/workspace" },
    desired: {
      present: usable,
      name: "openwork-cloud",
      revision: usable ? "rev_ready" : null,
      config: null,
      token: { present: usable, metadata: {} },
    },
    delivery: {
      state: usable ? "ready" : "not_desired",
      desiredRevision: usable ? "rev_ready" : null,
      appliedRevision: usable ? "rev_ready" : null,
      updatedAt: usable ? NOW : null,
      appliedAt: usable ? NOW : null,
      lastAttemptAt: usable ? NOW : null,
    },
    engine: { status: usable ? "connected" : "not_checked" },
    tools: {
      expected: ["openwork-cloud_search_capabilities", "openwork-cloud_execute_capability"],
      present: usable ? ["openwork-cloud_search_capabilities", "openwork-cloud_execute_capability"] : [],
      missing: usable ? [] : ["openwork-cloud_search_capabilities", "openwork-cloud_execute_capability"],
      direct: {
        checked: false,
        source: "mcp_tools_list",
        expected: [],
        present: [],
        missing: [],
      },
      providerProjection: {
        checked: usable,
        provider: "openwork",
        model: "gpt-5",
        present: usable ? ["openwork-cloud_search_capabilities", "openwork-cloud_execute_capability"] : [],
        missing: [],
      },
    },
    pluginCanaries: { expected: [], present: [], missing: [] },
    compatibility: {
      openwork: { serverVersion: null, app: null },
      opencode: { expectedVersion: null, actualVersion: null, probe: "not_checked" },
      pluginFileHashes: [],
      supportedFeatures: {
        dynamicMcp: true,
        directoryScoping: true,
        toolIds: true,
        providerToolProjection: true,
        pluginCanaries: true,
      },
      experimentalToolIds: {
        checked: false,
        expected: [],
        present: [],
        missing: [],
        includesMcpTools: null,
      },
      experimentalProviderTools: {
        checked: false,
        expected: [],
        present: [],
        missing: [],
        includesMcpTools: null,
      },
    },
    toolDenies: [],
    firstFailure: usable ? null : {
      code: "cloud_desired_missing",
      stage: "desired",
      retryable: false,
      recommendedAction: "Connect OpenWork Cloud",
      message: "missing",
    },
    checkedAt: new Date(NOW).toISOString(),
  };
}

function installStorageStub() {
  const values = new Map<string, string>();
  __setCloudMcpUserStateStorageForTest({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  });
}

beforeEach(() => installStorageStub());
afterEach(() => __setCloudMcpUserStateStorageForTest(null));

describe("managed MCP secure-storage degradation in session maintenance", () => {
  test("a structured listMcp server error surfaces its own code and message instead of the generic banner", async () => {
    let reconcileCalls = 0;
    const client = {
      baseUrl: "https://worker.openwork.test",
      listMcp: async (): Promise<never> => {
        throw new OpenworkServerError(
          503,
          "managed_mcp_secure_storage_unavailable",
          "Secure storage for OpenWork-managed MCP credentials is unavailable.",
        );
      },
      getOpenworkCloudMcpHealth: async () => cloudHealth(false),
      reconcileOpenworkCloudMcp: async () => {
        reconcileCalls += 1;
        return cloudHealth(true);
      },
    };

    const result = await syncCloudControlMcpInBackground({
      client,
      workspaceId: WORKSPACE_ID,
      settings: SETTINGS,
      now: NOW,
      mintToken: async () => MINTED,
    });

    if (result.outcome !== "failed") {
      throw new Error(`expected a failed outcome, got ${result.outcome}`);
    }
    expect(result.status).toBe("failed");
    expect(result.issue.code).toBe("managed_mcp_secure_storage_unavailable");
    expect(result.issue.message).toContain("Secure storage");
    expect(result.issue.message).not.toContain("could not verify connected service tools");
    expect(result.health).toBe(null);
    expect(reconcileCalls).toBe(0);
  });

  test("a degraded-but-valid listMcp response still proceeds to the reconciler", async () => {
    let reconcileCalls = 0;
    const client = {
      baseUrl: "https://worker.openwork.test",
      listMcp: async () => ({
        items: [{
          name: "openwork-cloud",
          config: { type: "remote", enabled: true, url: "https://api.openwork.test/mcp/agent" },
          source: "config.remote" as const,
        }],
        managedOAuthState: { available: false, recovery: null },
      }),
      getOpenworkCloudMcpHealth: async () => cloudHealth(false),
      reconcileOpenworkCloudMcp: async () => {
        reconcileCalls += 1;
        return cloudHealth(true);
      },
    };

    const result = await syncCloudControlMcpInBackground({
      client,
      workspaceId: WORKSPACE_ID,
      settings: SETTINGS,
      now: NOW,
      mintToken: async () => MINTED,
    });

    expect(result.outcome).toBe("ready");
    expect(result.status).toBe("synced");
    expect(reconcileCalls).toBe(1);
  });
});
