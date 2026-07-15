import { beforeEach, describe, expect, test } from "bun:test";

import type { DenMcpToken } from "../src/app/lib/den";
import type { DenSettings } from "../src/app/lib/den-types";
import type {
  OpenworkCloudMcpFailure,
  OpenworkCloudMcpHealth,
  OpenworkMcpItem,
} from "../src/app/lib/openwork-server";
import {
  __setCloudMcpUserStateStorageForTest,
  CLOUD_MCP_SERVER_NAME,
  writeCloudMcpUserState,
} from "../src/react-app/domains/connections/cloud-mcp-user-state";
import { runOpenworkCloudMcpReconciler } from "../src/react-app/domains/connections/cloud-mcp-reconciler";
import { syncCloudControlMcpInBackground } from "../src/react-app/domains/connections/use-session-mcp-maintenance";

const NOW = Date.parse("2026-07-14T12:00:00.000Z");
const LEGACY_USER_STATE_KEY = "openwork.den.mcp.cloudControlUserState";

const scope = {
  denBaseUrl: "https://app.openwork.test",
  serverBaseUrl: "https://worker.openwork.test",
  orgId: "org_1",
  workspaceId: "ws_1",
};

const settings: DenSettings = {
  baseUrl: scope.denBaseUrl,
  authToken: "den-session-token",
  activeOrgId: scope.orgId,
  activeOrgSlug: "org-one",
  activeOrgName: "Org One",
};

const context = {
  ...scope,
  denAuthToken: settings.authToken,
  providerModel: { provider: "openwork", model: "gpt-5" },
};

const token: DenMcpToken = {
  token: "owt_mcp_secret_token",
  expiresAt: new Date(NOW + 7 * 24 * 60 * 60 * 1000).toISOString(),
  organizationId: scope.orgId,
  scopes: ["mcp:read", "mcp:write"],
  resource: "https://api.openwork.test/mcp",
};

let storageValues: Map<string, string>;

function installStorageStub(initial?: Record<string, string>) {
  storageValues = new Map(Object.entries(initial ?? {}));
  __setCloudMcpUserStateStorageForTest({
    getItem: (key) => storageValues.get(key) ?? null,
    setItem: (key, value) => storageValues.set(key, value),
    removeItem: (key) => storageValues.delete(key),
  });
}

function failure(code: string): OpenworkCloudMcpFailure {
  return {
    code,
    stage: "engine_status",
    retryable: false,
    recommendedAction: "fix it",
    message: "failed",
  };
}

function health(input: { usable: boolean; failure?: OpenworkCloudMcpFailure | null }): OpenworkCloudMcpHealth {
  const usable = input.usable;
  return {
    schemaVersion: 1,
    phase: usable ? "ready" : "engine_failed",
    usable,
    usableByCurrentModel: usable ? true : null,
    connectCatalogEnabled: true,
    workspace: { id: scope.workspaceId, type: "local", directory: "/workspace", path: "/workspace" },
    desired: {
      present: true,
      name: CLOUD_MCP_SERVER_NAME,
      revision: "rev_desired",
      config: null,
      token: { present: true, metadata: { expiresAt: token.expiresAt, scopes: "mcp:read mcp:write" } },
    },
    delivery: {
      state: usable ? "ready" : "pending",
      desiredRevision: "rev_desired",
      appliedRevision: usable ? "rev_desired" : null,
      updatedAt: NOW,
      appliedAt: usable ? NOW : null,
      lastAttemptAt: NOW,
    },
    engine: { status: usable ? "connected" : "failed" },
    tools: {
      expected: ["openwork-cloud_search_capabilities", "openwork-cloud_execute_capability"],
      present: usable ? ["openwork-cloud_search_capabilities", "openwork-cloud_execute_capability"] : [],
      missing: usable ? [] : ["openwork-cloud_search_capabilities"],
      direct: {
        checked: true,
        source: "mcp_tools_list",
        expected: ["search_capabilities", "execute_capability"],
        present: usable ? ["search_capabilities", "execute_capability"] : [],
        missing: usable ? [] : ["search_capabilities"],
      },
      providerProjection: {
        checked: usable,
        provider: "openwork",
        model: "gpt-5",
        source: "experimental_tool",
        present: usable ? ["openwork-cloud_search_capabilities", "openwork-cloud_execute_capability"] : [],
        missing: usable ? [] : ["openwork-cloud_execute_capability"],
      },
    },
    pluginCanaries: {
      expected: ["openwork_docs_search"],
      present: usable ? ["openwork_docs_search"] : [],
      missing: usable ? [] : ["openwork_docs_search"],
    },
    compatibility: {
      openwork: { serverVersion: "test", app: null },
      opencode: { expectedVersion: "1.17.11", actualVersion: "1.17.11", probe: "ok" },
      pluginFileHashes: [],
      supportedFeatures: { dynamicMcp: true, directoryScoping: true, toolIds: true, providerToolProjection: usable, pluginCanaries: true },
      experimentalToolIds: {
        checked: true,
        expected: ["openwork-cloud_search_capabilities", "openwork-cloud_execute_capability"],
        present: usable ? ["openwork-cloud_search_capabilities", "openwork-cloud_execute_capability"] : [],
        missing: usable ? [] : ["openwork-cloud_execute_capability"],
        includesMcpTools: usable,
      },
      experimentalProviderTools: {
        checked: usable,
        provider: "openwork",
        model: "gpt-5",
        expected: ["openwork-cloud_search_capabilities", "openwork-cloud_execute_capability"],
        present: usable ? ["openwork-cloud_search_capabilities", "openwork-cloud_execute_capability"] : [],
        missing: usable ? [] : ["openwork-cloud_execute_capability"],
        includesMcpTools: usable ? true : null,
      },
    },
    toolDenies: [],
    firstFailure: usable ? null : input.failure ?? failure("cloud_connection_failed"),
    checkedAt: new Date(NOW).toISOString(),
  };
}

function configuredItem(): OpenworkMcpItem {
  return {
    name: CLOUD_MCP_SERVER_NAME,
    config: {
      type: "remote",
      enabled: true,
      url: "https://api.openwork.test/mcp/agent",
      headers: { Authorization: "Bearer owt_mcp_expired" },
    },
    source: "config.remote",
  };
}

describe("cloud MCP maintenance user-state gate", () => {
  beforeEach(() => installStorageStub());

  test("field repro: legacy 'removed' intent must not block token maintenance of an existing enabled entry", async () => {
    // The affected machine had the legacy raw-string value from an old manual
    // toggle. Its 7-day token expired with maintenance permanently skipped.
    installStorageStub({ [LEGACY_USER_STATE_KEY]: "removed" });

    let mintCount = 0;
    let reconcileCount = 0;
    const result = await syncCloudControlMcpInBackground({
      client: {
        baseUrl: scope.serverBaseUrl,
        listMcp: async () => ({ items: [configuredItem()] }),
        getOpenworkCloudMcpHealth: async () => health({ usable: false, failure: failure("invalid_mcp_token") }),
        reconcileOpenworkCloudMcp: async () => {
          reconcileCount += 1;
          return health({ usable: true });
        },
      },
      workspaceId: scope.workspaceId,
      settings,
      mintToken: async () => {
        mintCount += 1;
        return token;
      },
    });

    expect(result).toMatchObject({ outcome: "ready", status: "synced" });
    expect(mintCount).toBeGreaterThanOrEqual(1);
    expect(reconcileCount).toBeGreaterThanOrEqual(1);
  });

  test("provisioning stays gated: recorded intent with no configured entry skips without minting", async () => {
    installStorageStub({ [LEGACY_USER_STATE_KEY]: "removed" });

    let mintCount = 0;
    let reconcileCount = 0;
    const result = await syncCloudControlMcpInBackground({
      client: {
        baseUrl: scope.serverBaseUrl,
        listMcp: async () => ({ items: [] }),
        getOpenworkCloudMcpHealth: async () => health({ usable: false }),
        reconcileOpenworkCloudMcp: async () => {
          reconcileCount += 1;
          return health({ usable: true });
        },
      },
      workspaceId: scope.workspaceId,
      settings,
      mintToken: async () => {
        mintCount += 1;
        return token;
      },
    });

    expect(result).toEqual({ outcome: "skipped", status: "skipped", reason: "disabled", health: null });
    expect(mintCount).toBe(0);
    expect(reconcileCount).toBe(0);
  });

  test("explicitly disabled entries stay skipped even without recorded intent", async () => {
    let mintCount = 0;
    const disabled: OpenworkMcpItem = { ...configuredItem(), config: { ...configuredItem().config, enabled: false } };
    const result = await syncCloudControlMcpInBackground({
      client: {
        baseUrl: scope.serverBaseUrl,
        listMcp: async () => ({ items: [disabled] }),
        getOpenworkCloudMcpHealth: async () => health({ usable: false }),
        reconcileOpenworkCloudMcp: async () => health({ usable: true }),
      },
      workspaceId: scope.workspaceId,
      settings,
      mintToken: async () => {
        mintCount += 1;
        return token;
      },
    });

    expect(result).toEqual({ outcome: "skipped", status: "skipped", reason: "disabled", health: null });
    expect(mintCount).toBe(0);
  });

  test("reconciler: scoped 'removed' intent yields to configuredEnabled=true and blocks when the entry is absent", async () => {
    writeCloudMcpUserState("removed", scope);

    let mintCount = 0;
    const proceeding = await runOpenworkCloudMcpReconciler({
      mode: "repair",
      client: {
        baseUrl: scope.serverBaseUrl,
        getOpenworkCloudMcpHealth: async () => health({ usable: false }),
        reconcileOpenworkCloudMcp: async () => health({ usable: true }),
      },
      context,
      mintToken: async () => {
        mintCount += 1;
        return token;
      },
      force: true,
      refreshMarginMs: 1,
      configuredEnabled: true,
    });
    expect(proceeding.status).toBe("repaired");
    expect(mintCount).toBe(1);

    const blocked = await runOpenworkCloudMcpReconciler({
      mode: "repair",
      client: {
        baseUrl: scope.serverBaseUrl,
        getOpenworkCloudMcpHealth: async () => health({ usable: false }),
        reconcileOpenworkCloudMcp: async () => health({ usable: true }),
      },
      context,
      mintToken: async () => {
        mintCount += 1;
        return token;
      },
      force: true,
      refreshMarginMs: 1,
      configuredEnabled: null,
    });
    expect(blocked.status).toBe("skipped");
    expect(blocked.skippedReason).toBe("disabled");
    expect(mintCount).toBe(1);
  });
});
