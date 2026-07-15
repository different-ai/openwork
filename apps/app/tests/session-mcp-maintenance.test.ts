import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import type { DenMcpToken, DenSettings } from "../src/app/lib/den";
import type { OpenworkCloudMcpHealth, OpenworkCloudMcpReconcilePayload } from "../src/app/lib/openwork-server";
import {
  __setCloudMcpUserStateStorageForTest,
  readCloudMcpSyncMarker,
  writeCloudMcpUserState,
} from "../src/react-app/domains/connections/cloud-mcp-user-state";
import { cleanupOpenworkCloudMcpAfterSignOut } from "../src/react-app/domains/connections/cloud-mcp-reconciler";
import {
  getSessionMcpMaintenanceTargetKey,
  runCloudMcpMaintenanceWithRetry,
  runSessionMcpMaintenanceTask,
  syncCloudControlMcpInBackground,
} from "../src/react-app/domains/connections/use-session-mcp-maintenance";

const NOW = Date.parse("2026-07-09T12:00:00.000Z");
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
      providerProjection: {
        checked: usable,
        provider: "openwork",
        model: "gpt-5",
        present: usable ? ["openwork-cloud_search_capabilities", "openwork-cloud_execute_capability"] : [],
        missing: [],
      },
    },
    pluginCanaries: { expected: [], present: [], missing: [] },
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

function retryableCloudHealth(): OpenworkCloudMcpHealth {
  const health = cloudHealth(false);
  return {
    ...health,
    firstFailure: health.firstFailure
      ? { ...health.firstFailure, retryable: true }
      : null,
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

afterAll(() => {
  __setCloudMcpUserStateStorageForTest(null);
});

describe("session MCP maintenance", () => {
  beforeEach(() => installStorageStub());

  test("mints and hot-updates the Cloud MCP without opening Settings", async () => {
    const writes: Array<{ workspaceId: string; payload: OpenworkCloudMcpReconcilePayload }> = [];
    const client = {
      baseUrl: "https://worker.openwork.test",
      listMcp: async () => ({ items: [] }),
      getOpenworkCloudMcpHealth: async () => cloudHealth(false),
      reconcileOpenworkCloudMcp: async (workspaceId: string, payload: OpenworkCloudMcpReconcilePayload) => {
        writes.push({ workspaceId, payload });
        return cloudHealth(true);
      },
    };

    await expect(syncCloudControlMcpInBackground({
      client,
      workspaceId: WORKSPACE_ID,
      settings: SETTINGS,
      now: NOW,
      mintToken: async () => MINTED,
    })).resolves.toMatchObject({ outcome: "ready", status: "synced" });

    expect(writes).toEqual([{
      workspaceId: WORKSPACE_ID,
      payload: {
        workspaceId: WORKSPACE_ID,
        name: "openwork-cloud",
        config: {
          type: "remote",
          enabled: true,
          url: "https://api.openwork.test/mcp/agent",
          headers: { Authorization: "Bearer mcp-token" },
          oauth: false,
        },
        tokenMetadata: {
          organizationId: "organization_1",
          expiresAt: MINTED.expiresAt,
          resource: "https://api.openwork.test/mcp",
          scopes: "mcp:read mcp:write",
        },
        org: { id: "organization_1", slug: null, name: null },
        connectCatalogEnabled: true,
        trigger: "desktop-background",
      },
    }]);
    expect(readCloudMcpSyncMarker({
      denBaseUrl: SETTINGS.baseUrl,
      serverBaseUrl: client.baseUrl,
      orgId: SETTINGS.activeOrgId ?? "",
      workspaceId: WORKSPACE_ID,
    })).toEqual({
      denBaseUrl: SETTINGS.baseUrl,
      serverBaseUrl: client.baseUrl,
      orgId: "organization_1",
      workspaceId: WORKSPACE_ID,
      expiresAt: MINTED.expiresAt,
    });
  });

  test("keeps a retryable injection failure visible until a bounded retry restores the tools", async () => {
    let reconcileCount = 0;
    const waits: number[] = [];
    const attempts: Array<{ outcome: string; attempt: number; willRetry: boolean }> = [];
    const client = {
      baseUrl: "https://worker.openwork.test",
      listMcp: async () => ({
        items: [{
          name: "openwork-cloud",
          config: { type: "remote", enabled: true, url: "https://api.openwork.test/mcp/agent" },
        }],
      }),
      getOpenworkCloudMcpHealth: async () => retryableCloudHealth(),
      reconcileOpenworkCloudMcp: async () => {
        reconcileCount += 1;
        return reconcileCount === 3 ? cloudHealth(true) : retryableCloudHealth();
      },
    };

    const result = await runCloudMcpMaintenanceWithRetry({
      attempt: () => syncCloudControlMcpInBackground({
        client,
        workspaceId: WORKSPACE_ID,
        settings: SETTINGS,
        now: NOW,
        mintToken: async () => MINTED,
      }),
      retryDelaysMs: [25, 50],
      wait: async (delayMs) => {
        waits.push(delayMs);
      },
      onAttempt: (attempt) => {
        attempts.push({
          outcome: attempt.result.outcome,
          attempt: attempt.attempt,
          willRetry: attempt.willRetry,
        });
      },
    });

    expect(result).toMatchObject({ outcome: "ready", status: "synced" });
    expect(reconcileCount).toBe(3);
    expect(waits).toEqual([25, 50]);
    expect(attempts).toEqual([
      { outcome: "failed", attempt: 1, willRetry: true },
      { outcome: "failed", attempt: 2, willRetry: true },
      { outcome: "ready", attempt: 3, willRetry: false },
    ]);
  });

  test("a fresh per-workspace marker prevents repeated token and config writes", async () => {
    let mintCount = 0;
    let writeCount = 0;
    let healthReady = false;
    const client = {
      baseUrl: "https://worker.openwork.test",
      listMcp: async () => ({
        items: [{
          name: "openwork-cloud",
          config: { type: "remote", enabled: true, url: "https://api.openwork.test/mcp/agent" },
        }],
      }),
      getOpenworkCloudMcpHealth: async () => cloudHealth(healthReady),
      reconcileOpenworkCloudMcp: async () => {
        writeCount += 1;
        healthReady = true;
        return cloudHealth(true);
      },
    };

    await syncCloudControlMcpInBackground({
      client,
      workspaceId: WORKSPACE_ID,
      settings: SETTINGS,
      now: NOW,
      mintToken: async () => MINTED,
    });
    mintCount = 0;
    writeCount = 0;

    await expect(syncCloudControlMcpInBackground({
      client,
      workspaceId: WORKSPACE_ID,
      settings: SETTINGS,
      now: NOW + 1_000,
      mintToken: async () => {
        mintCount += 1;
        return MINTED;
      },
    })).resolves.toMatchObject({ outcome: "ready", status: "unchanged" });
    expect(mintCount).toBe(0);
    expect(writeCount).toBe(0);
  });

  test("keeps independent markers when switching between workspaces", async () => {
    let mintCount = 0;
    const writes: string[] = [];
    const readyWorkspaces = new Set<string>();
    const client = {
      baseUrl: "https://worker.openwork.test",
      listMcp: async () => ({
        items: [{
          name: "openwork-cloud",
          config: { type: "remote", enabled: true, url: "https://api.openwork.test/mcp/agent" },
        }],
      }),
      addMcp: async (workspaceId: string) => {
        writes.push(workspaceId);
        return { items: [] };
      },
      getOpenworkCloudMcpHealth: async (workspaceId: string) => cloudHealth(readyWorkspaces.has(workspaceId)),
      reconcileOpenworkCloudMcp: async (workspaceId: string) => {
        writes.push(workspaceId);
        readyWorkspaces.add(workspaceId);
        return cloudHealth(true);
      },
    };
    const mintToken = async () => {
      mintCount += 1;
      return MINTED;
    };

    await expect(syncCloudControlMcpInBackground({
      client,
      workspaceId: "workspace_a",
      settings: SETTINGS,
      now: NOW,
      mintToken,
    })).resolves.toMatchObject({ outcome: "ready", status: "synced" });
    await expect(syncCloudControlMcpInBackground({
      client,
      workspaceId: "workspace_b",
      settings: SETTINGS,
      now: NOW,
      mintToken,
    })).resolves.toMatchObject({ outcome: "ready", status: "synced" });
    await expect(syncCloudControlMcpInBackground({
      client,
      workspaceId: "workspace_a",
      settings: SETTINGS,
      now: NOW + 1_000,
      mintToken,
    })).resolves.toMatchObject({ outcome: "ready", status: "unchanged" });

    expect(mintCount).toBe(2);
    expect(writes).toEqual(["workspace_a", "workspace_b"]);
  });

  test("keeps same-named remote workspaces separate across workers", async () => {
    let mintCount = 0;
    const writes: string[] = [];
    const readyWorkers = new Set<string>();
    const makeClient = (baseUrl: string) => ({
      baseUrl,
      listMcp: async () => ({
        items: [{
          name: "openwork-cloud",
          config: { type: "remote", enabled: true, url: "https://api.openwork.test/mcp/agent" },
        }],
      }),
      addMcp: async () => {
        writes.push(baseUrl);
        return { items: [] };
      },
      getOpenworkCloudMcpHealth: async () => cloudHealth(readyWorkers.has(baseUrl)),
      reconcileOpenworkCloudMcp: async () => {
        writes.push(baseUrl);
        readyWorkers.add(baseUrl);
        return cloudHealth(true);
      },
    });
    const workerA = makeClient("https://worker-a.openwork.test");
    const workerB = makeClient("https://worker-b.openwork.test");
    const mintToken = async () => {
      mintCount += 1;
      return MINTED;
    };

    for (const client of [workerA, workerB, workerA]) {
      await syncCloudControlMcpInBackground({
        client,
        workspaceId: "workspace_shared_id",
        settings: SETTINGS,
        now: NOW,
        mintToken,
      });
    }

    expect(mintCount).toBe(2);
    expect(writes).toEqual([workerA.baseUrl, workerB.baseUrl]);
  });

  test("explicit removal keeps background maintenance disabled", async () => {
    writeCloudMcpUserState("removed", {
      denBaseUrl: SETTINGS.baseUrl,
      serverBaseUrl: "https://worker.openwork.test",
      orgId: SETTINGS.activeOrgId ?? "",
      workspaceId: WORKSPACE_ID,
    });
    let reconciled = false;
    let minted = false;

    await expect(syncCloudControlMcpInBackground({
      client: {
        baseUrl: "https://worker.openwork.test",
        // The engine list is consulted (an existing enabled entry must stay
        // maintained even under recorded intent), but with no entry present
        // the recorded removal keeps provisioning skipped.
        listMcp: async () => ({ items: [] }),
        getOpenworkCloudMcpHealth: async () => cloudHealth(false),
        reconcileOpenworkCloudMcp: async () => {
          reconciled = true;
          return cloudHealth(true);
        },
      },
      workspaceId: WORKSPACE_ID,
      settings: SETTINGS,
      mintToken: async () => {
        minted = true;
        return MINTED;
      },
    })).resolves.toEqual({ outcome: "skipped", status: "skipped", reason: "disabled", health: null });
    expect(reconciled).toBe(false);
    expect(minted).toBe(false);
  });

  test("pre-signout cleanup removes runtime MCP and disconnects the exact active workspace before resolving", async () => {
    const events: string[] = [];
    await cleanupOpenworkCloudMcpAfterSignOut({
      context: {
        denBaseUrl: SETTINGS.baseUrl,
        serverBaseUrl: "https://worker.openwork.test",
        orgId: SETTINGS.activeOrgId ?? "",
        workspaceId: WORKSPACE_ID,
      },
      openworkClient: {
        baseUrl: "https://worker.openwork.test",
        removeMcp: async (workspaceId, name) => {
          events.push(`remove:${workspaceId}:${name}`);
        },
      },
      opencodeClient: {
        mcp: {
          disconnect: async (input) => {
            events.push(`disconnect:${input.directory}:${input.name}`);
          },
        },
      },
      directory: "/workspace/exact",
    });
    events.push("auth-cleared");

    expect(events.slice(0, 2).sort()).toEqual([
      "disconnect:/workspace/exact:openwork-cloud",
      `remove:${WORKSPACE_ID}:openwork-cloud`,
    ].sort());
    expect(events[2]).toBe("auth-cleared");
  });

  test("deduplicates the same target without blocking another workspace", async () => {
    const firstClient = { baseUrl: "https://worker.openwork.test" };
    const recreatedClient = { baseUrl: "https://worker.openwork.test/" };
    const targetA = getSessionMcpMaintenanceTargetKey({
      client: firstClient,
      cloudSignedIn: true,
      denBaseUrl: SETTINGS.baseUrl,
      orgId: SETTINGS.activeOrgId,
      workspaceId: "workspace_a",
    });
    const recreatedTargetA = getSessionMcpMaintenanceTargetKey({
      client: recreatedClient,
      cloudSignedIn: true,
      denBaseUrl: SETTINGS.baseUrl,
      orgId: SETTINGS.activeOrgId,
      workspaceId: "workspace_a",
    });
    const targetB = getSessionMcpMaintenanceTargetKey({
      client: recreatedClient,
      cloudSignedIn: true,
      denBaseUrl: SETTINGS.baseUrl,
      orgId: SETTINGS.activeOrgId,
      workspaceId: "workspace_b",
    });
    let releaseTargetA = () => {};
    let targetARuns = 0;
    let targetBRuns = 0;
    const targetABlocked = new Promise<void>((resolve) => {
      releaseTargetA = resolve;
    });

    const firstTargetA = runSessionMcpMaintenanceTask({
      targetKey: targetA,
      task: async () => {
        targetARuns += 1;
        await targetABlocked;
      },
    });
    await Promise.resolve();

    await expect(runSessionMcpMaintenanceTask({
      targetKey: recreatedTargetA,
      task: async () => {
        targetARuns += 1;
      },
    })).resolves.toBe(false);
    await expect(runSessionMcpMaintenanceTask({
      targetKey: targetB,
      task: async () => {
        targetBRuns += 1;
      },
    })).resolves.toBe(true);

    releaseTargetA();
    await expect(firstTargetA).resolves.toBe(true);
    expect(targetARuns).toBe(1);
    expect(targetBRuns).toBe(1);
  });
});
