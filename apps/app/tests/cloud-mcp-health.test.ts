import { beforeEach, describe, expect, test } from "bun:test";

import type { DenMcpToken } from "../src/app/lib/den";
import type { OpenworkCloudMcpFailure, OpenworkCloudMcpHealth, OpenworkCloudMcpReconcilePayload } from "../src/app/lib/openwork-server";
import {
  __setCloudMcpUserStateStorageForTest,
  getCloudMcpScopeKey,
  readCloudMcpSyncMarker,
  writeCloudMcpSyncMarker,
} from "../src/react-app/domains/connections/cloud-mcp-user-state";
import {
  cloudMcpDisplaySummary,
  cloudMcpFailureStageLabel,
  isCloudMcpAuthTokenFailure,
  isCloudMcpAuthTokenFailureCode,
  runOpenworkCloudMcpReconciler,
} from "../src/react-app/domains/connections/cloud-mcp-reconciler";

const NOW = Date.parse("2026-07-09T12:00:00.000Z");
const scope = {
  denBaseUrl: "https://app.openwork.test",
  serverBaseUrl: "https://worker.openwork.test",
  orgId: "org_1",
  workspaceId: "ws_1",
};
const context = {
  ...scope,
  denAuthToken: "den-session-token",
  providerModel: { provider: "openwork", model: "gpt-5" },
};
const token: DenMcpToken = {
  token: "owt_mcp_secret_token",
  expiresAt: new Date(NOW + 7 * 24 * 60 * 60 * 1000).toISOString(),
  organizationId: "org_1",
  scopes: ["mcp:read", "mcp:write"],
  resource: "https://api.openwork.test/mcp",
};

function installStorageStub() {
  const values = new Map<string, string>();
  __setCloudMcpUserStateStorageForTest({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  });
}

function failure(code: string, aliases?: string[]): OpenworkCloudMcpFailure {
  return {
    code,
    stage: "engine_status",
    retryable: false,
    recommendedAction: "fix it",
    message: "failed",
    ...(aliases ? { aliases } : {}),
  };
}

function health(input: { usable: boolean; failure?: OpenworkCloudMcpFailure | null; projectionChecked?: boolean }): OpenworkCloudMcpHealth {
  const usable = input.usable;
  const projectionChecked = input.projectionChecked ?? usable;
  return {
    schemaVersion: 1,
    phase: usable ? "ready" : "engine_failed",
    usable,
    usableByCurrentModel: projectionChecked ? usable : null,
    connectCatalogEnabled: true,
    workspace: { id: scope.workspaceId, type: "local", directory: "/workspace", path: "/workspace" },
    desired: {
      present: true,
      name: "openwork-cloud",
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
        checked: projectionChecked,
        provider: "openwork",
        model: "gpt-5",
        source: "experimental_tool",
        present: usable ? ["openwork-cloud_search_capabilities", "openwork-cloud_execute_capability"] : [],
        missing: usable ? [] : ["openwork-cloud_execute_capability"],
      },
    },
    pluginCanaries: { expected: ["openwork_docs_search"], present: usable ? ["openwork_docs_search"] : [], missing: usable ? [] : ["openwork_docs_search"] },
    compatibility: {
      openwork: { serverVersion: "test", app: null },
      opencode: { expectedVersion: "1.17.11", actualVersion: "1.17.11", probe: "ok" },
      pluginFileHashes: [],
      supportedFeatures: { dynamicMcp: true, directoryScoping: true, toolIds: true, providerToolProjection: projectionChecked, pluginCanaries: true },
      experimentalToolIds: {
        checked: true,
        expected: ["openwork-cloud_search_capabilities", "openwork-cloud_execute_capability"],
        present: usable ? ["openwork-cloud_search_capabilities", "openwork-cloud_execute_capability"] : [],
        missing: usable ? [] : ["openwork-cloud_execute_capability"],
        includesMcpTools: usable,
      },
      experimentalProviderTools: {
        checked: projectionChecked,
        provider: "openwork",
        model: "gpt-5",
        expected: ["openwork-cloud_search_capabilities", "openwork-cloud_execute_capability"],
        present: usable ? ["openwork-cloud_search_capabilities", "openwork-cloud_execute_capability"] : [],
        missing: usable ? [] : ["openwork-cloud_execute_capability"],
        includesMcpTools: projectionChecked ? usable : null,
      },
    },
    toolDenies: [],
    firstFailure: usable ? null : input.failure ?? failure("cloud_connection_failed"),
    checkedAt: new Date(NOW).toISOString(),
  };
}

describe("OpenWork Cloud MCP reconciler", () => {
  beforeEach(() => installStorageStub());

  test("Test now performs only GET health", async () => {
    const values = new Map<string, string>();
    let writes = 0;
    __setCloudMcpUserStateStorageForTest({
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        writes += 1;
        values.set(key, value);
      },
      removeItem: (key) => values.delete(key),
    });
    writeCloudMcpSyncMarker({ ...scope, expiresAt: token.expiresAt });
    writes = 0;
    let getCount = 0;
    let mintCount = 0;
    let postCount = 0;
    const result = await runOpenworkCloudMcpReconciler({
      mode: "health",
      client: {
        baseUrl: scope.serverBaseUrl,
        getOpenworkCloudMcpHealth: async () => {
          getCount += 1;
          return health({ usable: true });
        },
        reconcileOpenworkCloudMcp: async () => {
          postCount += 1;
          return health({ usable: true });
        },
      },
      context,
      mintToken: async () => {
        mintCount += 1;
        return token;
      },
      refreshMarginMs: 24 * 60 * 60 * 1000,
    });

    expect(result.health?.usable).toBe(true);
    expect(getCount).toBe(1);
    expect(mintCount).toBe(0);
    expect(postCount).toBe(0);
    expect(result.markerWritten).toBe(false);
    expect(writes).toBe(0);
  });

  test("writes marker only when returned health is usable", async () => {
    const client = {
      baseUrl: scope.serverBaseUrl,
      getOpenworkCloudMcpHealth: async () => health({ usable: false, failure: failure("cloud_status_missing") }),
      reconcileOpenworkCloudMcp: async () => health({ usable: false, failure: failure("cloud_status_missing") }),
    };

    await runOpenworkCloudMcpReconciler({ mode: "repair", client, context, mintToken: async () => token, force: true, refreshMarginMs: 1 });
    expect(readCloudMcpSyncMarker(scope)).toBeNull();

    await runOpenworkCloudMcpReconciler({
      mode: "repair",
      client: { ...client, reconcileOpenworkCloudMcp: async () => health({ usable: true }) },
      context,
      mintToken: async () => token,
      force: true,
      refreshMarginMs: 1,
    });
    expect(readCloudMcpSyncMarker(scope)?.expiresAt).toBe(token.expiresAt);
  });

  test("the exact invalid_mcp_token failure remints exactly once", async () => {
    expect(isCloudMcpAuthTokenFailureCode("invalid_mcp_token")).toBe(true);
    let mintCount = 0;
    const posts: OpenworkCloudMcpReconcilePayload[] = [];
    const result = await runOpenworkCloudMcpReconciler({
      mode: "repair",
      client: {
        baseUrl: scope.serverBaseUrl,
        getOpenworkCloudMcpHealth: async () => health({ usable: false }),
        reconcileOpenworkCloudMcp: async (_workspaceId, payload) => {
          posts.push(payload);
          return posts.length === 1
            ? health({ usable: false, failure: failure("invalid_mcp_token") })
            : health({ usable: true });
        },
      },
      context,
      mintToken: async () => {
        mintCount += 1;
        return { ...token, token: `owt_mcp_secret_${mintCount}` };
      },
      force: true,
      refreshMarginMs: 1,
    });

    expect(result.health?.usable).toBe(true);
    expect(mintCount).toBe(2);
    expect(posts).toHaveLength(2);
  });

  test("a canonical auth alias remints exactly once", async () => {
    let mintCount = 0;
    let postCount = 0;
    const result = await runOpenworkCloudMcpReconciler({
      mode: "repair",
      client: {
        baseUrl: scope.serverBaseUrl,
        getOpenworkCloudMcpHealth: async () => health({ usable: false }),
        reconcileOpenworkCloudMcp: async () => {
          postCount += 1;
          return postCount === 1
            ? health({ usable: false, failure: failure("cloud_connection_failed", ["openwork_cloud_token_expired"]) })
            : health({ usable: true });
        },
      },
      context,
      mintToken: async () => {
        mintCount += 1;
        return token;
      },
      force: true,
      refreshMarginMs: 1,
    });

    expect(isCloudMcpAuthTokenFailure(failure("cloud_connection_failed", ["openwork_cloud_token_expired"]))).toBe(true);
    expect(result.health?.usable).toBe(true);
    expect(mintCount).toBe(2);
    expect(postCount).toBe(2);
  });

  test("membership and scope failures do not retry", async () => {
    for (const code of ["openwork_cloud_membership_required", "openwork_cloud_scope_missing", "openwork_cloud_resource_forbidden"]) {
      expect(isCloudMcpAuthTokenFailureCode(code)).toBe(false);
    }
    let mintCount = 0;
    let postCount = 0;
    await runOpenworkCloudMcpReconciler({
      mode: "repair",
      client: {
        baseUrl: scope.serverBaseUrl,
        getOpenworkCloudMcpHealth: async () => health({ usable: false }),
        reconcileOpenworkCloudMcp: async () => {
          postCount += 1;
          return health({ usable: false, failure: failure("openwork_cloud_membership_required") });
        },
      },
      context,
      mintToken: async () => {
        mintCount += 1;
        return token;
      },
      force: true,
      refreshMarginMs: 1,
    });

    expect(mintCount).toBe(1);
    expect(postCount).toBe(1);
  });

  test("dedupe key is scoped by deployment, server, workspace, and org without token", () => {
    const key = getCloudMcpScopeKey(scope);
    expect(key).toContain(scope.denBaseUrl);
    expect(key).toContain(scope.serverBaseUrl);
    expect(key).toContain(scope.workspaceId);
    expect(key).toContain(scope.orgId);
    expect(key).not.toContain("den-session-token");
    expect(getCloudMcpScopeKey({ ...scope, orgId: "org_2" })).not.toBe(key);
  });

  test("plain-language helpers map model projection and missing provider checks", () => {
    expect(cloudMcpFailureStageLabel({
      signedIn: true,
      orgSelected: true,
      health: health({ usable: false, failure: failure("provider_projection_missing") }),
    })).toBe("Current model can’t use Cloud tools");

    const summary = cloudMcpDisplaySummary({
      signedIn: true,
      orgSelected: true,
      connecting: false,
      health: health({ usable: true, projectionChecked: false }),
    });
    expect(summary.statusLabel).toBe("Ready");
    expect(summary.recommendedAction).toContain("not checked");
  });

  test("missing desired config is degraded while explicit disabled config is disabled", () => {
    const missingDesired = {
      ...health({ usable: false, failure: { ...failure("cloud_mcp_missing"), stage: "desired_config" } }),
      desired: {
        present: false,
        name: "openwork-cloud",
        revision: null,
        config: null,
        token: { present: false, metadata: {} },
      },
    };
    const missingSummary = cloudMcpDisplaySummary({
      signedIn: true,
      orgSelected: true,
      connecting: false,
      health: missingDesired,
    });
    expect(missingSummary.statusLabel).toBe("Degraded");
    expect(missingSummary.stageLabel).toBe("Couldn’t apply Cloud access to this workspace");

    const disabledSummary = cloudMcpDisplaySummary({
      signedIn: true,
      orgSelected: true,
      connecting: false,
      health: {
        ...health({ usable: false, failure: { ...failure("cloud_mcp_disabled"), stage: "desired_config" } }),
        desired: {
          ...health({ usable: false }).desired,
          config: { enabled: false },
        },
      },
    });
    expect(disabledSummary.statusLabel).toBe("Disabled");
  });
});
