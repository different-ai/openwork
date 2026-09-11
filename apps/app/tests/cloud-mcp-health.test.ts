import { beforeEach, describe, expect, test } from "bun:test";

import type { DenMcpToken } from "../src/app/lib/den";
import type { OpenworkCloudMcpFailure, OpenworkCloudMcpHealth, OpenworkCloudMcpReconcilePayload } from "../src/app/lib/openwork-server";
import {
  __setCloudMcpUserStateStorageForTest,
  getCloudMcpScopeKey,
  readCloudMcpSyncMarker,
  readCloudMcpUnhealthyRemintAttempt,
  writeCloudMcpSyncMarker,
} from "../src/react-app/domains/connections/cloud-mcp-user-state";
import {
  buildOpenworkCloudMcpReconcilePayload,
  cloudMcpDisplaySummary,
  cloudMcpFailureStageLabel,
  isCloudMcpAuthTokenFailure,
  isCloudMcpAuthTokenFailureCode,
  runOpenworkCloudMcpEngineRefresh,
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
  appHostToken: "owt_mcp_private_app_host_token",
  expiresAt: new Date(NOW + 7 * 24 * 60 * 60 * 1000).toISOString(),
  appHostExpiresAt: new Date(NOW + 7 * 24 * 60 * 60 * 1000).toISOString(),
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

function failure(code: string): OpenworkCloudMcpFailure {
  return {
    code,
    stage: "engine_status",
    retryable: false,
    recommendedAction: "fix it",
    message: "failed",
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

  test("uses the minted web proxy resource instead of a stale direct API fallback", () => {
    const payload = buildOpenworkCloudMcpReconcilePayload({
      context: {
        ...context,
        fallbackUrl: "https://api.openwork.test/mcp/agent",
      },
      token: {
        ...token,
        resource: "https://app.openwork.test/api/den/mcp",
      },
    });

    expect(payload?.config.url).toBe("https://app.openwork.test/api/den/mcp/agent");
  });

  test("keeps central search and execute working against an older Den without opening the App host", () => {
    const payload = buildOpenworkCloudMcpReconcilePayload({
      context,
      token: {
        token: token.token,
        expiresAt: token.expiresAt,
        organizationId: token.organizationId,
        scopes: token.scopes,
        resource: token.resource,
      },
    });

    expect(payload?.config.headers).toEqual({ Authorization: `Bearer ${token.token}` });
    expect(payload?.appHostAuthorization).toBeUndefined();
  });

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
          return { ...health({ usable: true }), appHostAuthorizationReady: false };
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
    expect(writes).toBe(0);
  });

  test("Test now with probe asks the server for a direct endpoint verification", async () => {
    const probeOptionsSeen: Array<{ probe?: boolean } | undefined> = [];
    const client = {
      baseUrl: scope.serverBaseUrl,
      getOpenworkCloudMcpHealth: async (
        _workspaceId: string,
        _providerModel?: unknown,
        options?: { probe?: boolean },
      ) => {
        probeOptionsSeen.push(options);
        return health({ usable: true });
      },
      reconcileOpenworkCloudMcp: async () => health({ usable: true }),
    };

    await runOpenworkCloudMcpReconciler({
      mode: "health",
      client,
      context,
      mintToken: async () => token,
      refreshMarginMs: 24 * 60 * 60 * 1000,
      probe: true,
    });
    await runOpenworkCloudMcpReconciler({
      mode: "health",
      client,
      context,
      mintToken: async () => token,
      refreshMarginMs: 24 * 60 * 60 * 1000,
    });

    expect(probeOptionsSeen).toEqual([{ probe: true }, undefined]);
  });

  test("healthy Cloud and a fresh marker still repair missing workspace App-host authorization once", async () => {
    writeCloudMcpSyncMarker({ ...scope, expiresAt: token.expiresAt });
    const missing = { ...health({ usable: true }), appHostAuthorizationReady: false };
    let currentHealth = missing;
    let mintCount = 0;
    const posts: Array<{ workspaceId: string; payload: OpenworkCloudMcpReconcilePayload }> = [];
    const client = {
      baseUrl: scope.serverBaseUrl,
      getOpenworkCloudMcpHealth: async () => currentHealth,
      reconcileOpenworkCloudMcp: async (workspaceId: string, payload: OpenworkCloudMcpReconcilePayload) => {
        posts.push({ workspaceId, payload });
        currentHealth = { ...missing, appHostAuthorizationReady: true };
        return currentHealth;
      },
    };
    const input: Parameters<typeof runOpenworkCloudMcpReconciler>[0] = {
      mode: "repair", client, context, now: NOW, refreshMarginMs: 1,
      mintToken: async () => { mintCount += 1; return token; },
    };
    expect(await runOpenworkCloudMcpReconciler(input)).toMatchObject({
      status: "repaired", attempts: 1, health: { usable: true, appHostAuthorizationReady: true },
    });
    expect(await runOpenworkCloudMcpReconciler(input)).toMatchObject({ status: "unchanged", attempts: 0 });
    expect(mintCount).toBe(1);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.workspaceId).toBe(scope.workspaceId);
    expect(posts[0]?.payload.appHostAuthorization).toBe(`Bearer ${token.appHostToken}`);
    expect(posts[0]?.payload.config.headers).toEqual({ Authorization: `Bearer ${token.token}` });
    expect(JSON.stringify(posts[0]?.payload.config)).not.toContain(token.appHostToken!);
    expect(readCloudMcpUnhealthyRemintAttempt(scope)).toBeNull();
  });

  test("unknown, ineligible and already-provisioned App hosts do not remint healthy Cloud", async () => {
    for (const appHostAuthorizationReady of [undefined, null, true]) {
      let mintCount = 0;
      let postCount = 0;
      const result = await runOpenworkCloudMcpReconciler({
        mode: "repair", context, now: NOW, refreshMarginMs: 1,
        client: {
          baseUrl: scope.serverBaseUrl,
          getOpenworkCloudMcpHealth: async () => ({ ...health({ usable: true }), appHostAuthorizationReady }),
          reconcileOpenworkCloudMcp: async () => { postCount += 1; return health({ usable: true }); },
        },
        mintToken: async () => { mintCount += 1; return token; },
      });
      expect(result.status).toBe("unchanged");
      expect(mintCount).toBe(0);
      expect(postCount).toBe(0);
    }
  });

  test("an unavailable private token has a scoped cooldown without blocking core repair or explicit retry", async () => {
    let mintCount = 0;
    let ordinaryUsable = true;
    const client = {
      baseUrl: scope.serverBaseUrl,
      getOpenworkCloudMcpHealth: async () => ({ ...health({ usable: ordinaryUsable }), appHostAuthorizationReady: false }),
      reconcileOpenworkCloudMcp: async () => ({ ...health({ usable: true }), appHostAuthorizationReady: false }),
    };
    const input: Parameters<typeof runOpenworkCloudMcpReconciler>[0] = {
      mode: "repair", client, context, now: NOW, refreshMarginMs: 1,
      mintToken: async () => {
        mintCount += 1;
        return { ...token, appHostToken: undefined, appHostExpiresAt: undefined };
      },
    };
    const first = await runOpenworkCloudMcpReconciler(input);
    expect(first).toMatchObject({ attempts: 1, health: { usable: true, appHostAuthorizationReady: false } });
    expect(await runOpenworkCloudMcpReconciler(input)).toMatchObject({ status: "unchanged", attempts: 0 });
    expect(mintCount).toBe(1);
    expect(await runOpenworkCloudMcpReconciler({ ...input, context: { ...context, workspaceId: "ws_other" } })).toMatchObject({ attempts: 1 });
    expect(await runOpenworkCloudMcpReconciler({ ...input, force: true })).toMatchObject({ attempts: 1 });
    ordinaryUsable = false;
    expect(await runOpenworkCloudMcpReconciler(input)).toMatchObject({ attempts: 1 });
    ordinaryUsable = true;
    expect(await runOpenworkCloudMcpReconciler({ ...input, now: NOW + 60 * 60 * 1_000 })).toMatchObject({ attempts: 1 });
    expect(mintCount).toBe(5);
  });

  test("failed App-only mint/reconcile attempts retain ordinary health and respect the cooldown", async () => {
    for (const failingStep of ["mint", "reconcile", "empty-token"]) {
      installStorageStub();
      let mintCount = 0;
      const observed = { ...health({ usable: true }), appHostAuthorizationReady: false };
      const input: Parameters<typeof runOpenworkCloudMcpReconciler>[0] = {
        mode: "repair", context, now: NOW, refreshMarginMs: 1,
        client: {
          baseUrl: scope.serverBaseUrl,
          getOpenworkCloudMcpHealth: async () => observed,
          reconcileOpenworkCloudMcp: async () => { throw new Error("Synthetic reconcile unavailable"); },
        },
        mintToken: async () => {
          mintCount += 1;
          if (failingStep === "mint") throw new Error("Synthetic mint unavailable");
          return failingStep === "empty-token" ? null : token;
        },
      };
      const failed = await runOpenworkCloudMcpReconciler(input);
      expect(failed).toMatchObject({ status: "failed", attempts: 1 });
      expect(failed.health).toBe(observed);
      expect(await runOpenworkCloudMcpReconciler(input)).toMatchObject({ status: "unchanged", attempts: 0 });
      expect(mintCount).toBe(1);
      expect(readCloudMcpUnhealthyRemintAttempt(scope)?.attemptedAt).toBe(NOW);
    }
  });

  test("engine refresh maps the endpoint result and skips unsupported servers", async () => {
    const calls: Array<{ workspaceId: string; payload?: { provider?: string; model?: string; trigger?: string } }> = [];
    const refreshedHealth = health({ usable: true });
    const refresh = {
      performed: true,
      trigger: "desktop-engine-refresh",
      startedAt: new Date(NOW).toISOString(),
      finishedAt: new Date(NOW + 500).toISOString(),
      steps: [
        { step: "engine_disconnect", ok: true, latencyMs: 12 },
        { step: "reapply", ok: true, latencyMs: 480 },
      ],
    };
    const result = await runOpenworkCloudMcpEngineRefresh({
      client: {
        baseUrl: scope.serverBaseUrl,
        getOpenworkCloudMcpHealth: async () => refreshedHealth,
        reconcileOpenworkCloudMcp: async () => refreshedHealth,
        refreshOpenworkCloudMcpEngine: async (workspaceId, payload) => {
          calls.push({ workspaceId, payload });
          return { refresh, health: refreshedHealth };
        },
      },
      context,
    });

    expect(result.status).toBe("refreshed");
    expect(result.refresh?.steps.map((step) => step.step)).toEqual(["engine_disconnect", "reapply"]);
    expect(calls).toEqual([
      {
        workspaceId: scope.workspaceId,
        payload: { provider: "openwork", model: "gpt-5", trigger: "desktop-engine-refresh" },
      },
    ]);

    const failed = await runOpenworkCloudMcpEngineRefresh({
      client: {
        baseUrl: scope.serverBaseUrl,
        getOpenworkCloudMcpHealth: async () => refreshedHealth,
        reconcileOpenworkCloudMcp: async () => refreshedHealth,
        refreshOpenworkCloudMcpEngine: async () => ({
          refresh: { ...refresh, steps: [{ step: "engine_disconnect", ok: false, latencyMs: 3 }, { step: "reapply", ok: false, latencyMs: 9 }] },
          health: health({ usable: false }),
        }),
      },
      context,
    });
    expect(failed.status).toBe("failed");

    const skipped = await runOpenworkCloudMcpEngineRefresh({
      client: {
        baseUrl: scope.serverBaseUrl,
        getOpenworkCloudMcpHealth: async () => refreshedHealth,
        reconcileOpenworkCloudMcp: async () => refreshedHealth,
      },
      context,
    });
    expect(skipped.status).toBe("skipped");
    expect(skipped.skippedReason).toBe("unsupported");
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

  test("auth failures remint exactly once", async () => {
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
            ? health({ usable: false, failure: failure("openwork_cloud_token_expired") })
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

  test("expired first-party token codes count as auth failures", () => {
    // Field incident regression: the Den rejects an expired opaque bearer with
    // code `invalid_mcp_token`; the `_mcp_` infix defeated the substring check
    // and the remint retry never fired for ~7 days.
    expect(isCloudMcpAuthTokenFailureCode("invalid_mcp_token")).toBe(true);
    expect(isCloudMcpAuthTokenFailureCode("missing_mcp_token")).toBe(true);
    expect(isCloudMcpAuthTokenFailureCode("openwork_cloud_token_expired")).toBe(true);
    expect(isCloudMcpAuthTokenFailureCode("invalid_token")).toBe(true);
    // Exclusions still hold.
    expect(isCloudMcpAuthTokenFailureCode("openwork_cloud_client_registration_required")).toBe(false);
    expect(isCloudMcpAuthTokenFailureCode("membership_not_found")).toBe(false);
    expect(isCloudMcpAuthTokenFailureCode(null)).toBe(false);
  });

  test("auth aliases trigger the remint retry when the primary code is unrecognized", async () => {
    expect(isCloudMcpAuthTokenFailure({ code: "cloud_connection_failed", aliases: ["openwork_cloud_token_expired"] })).toBe(true);
    expect(isCloudMcpAuthTokenFailure({ code: "cloud_connection_failed", aliases: ["cloud_tools_missing"] })).toBe(false);
    expect(isCloudMcpAuthTokenFailure(null)).toBe(false);

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
            ? health({ usable: false, failure: { ...failure("invalid_mcp_token"), aliases: ["openwork_cloud_token_expired"] } })
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

    const canonicalProjectionFailure = {
      ...failure("provider_tool_projection_missing"),
      stage: "provider_projection" as const,
      recommendedAction: "Choose a model that can use OpenWork Cloud tools",
    };
    expect(cloudMcpFailureStageLabel({
      signedIn: true,
      orgSelected: true,
      health: health({ usable: false, failure: canonicalProjectionFailure }),
    })).toBe("Current model can’t use Cloud tools");
    expect(cloudMcpDisplaySummary({
      signedIn: true,
      orgSelected: true,
      connecting: false,
      health: health({ usable: false, failure: canonicalProjectionFailure }),
    })).toMatchObject({
      statusLabel: "Degraded",
      stageLabel: "Current model can’t use Cloud tools",
      recommendedAction: "Choose a model that can use OpenWork Cloud tools.",
    });

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
