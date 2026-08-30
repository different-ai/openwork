import { expect } from "vitest";
import { test } from "@openwork/testkit";
import { createDenTypeId } from "../../ee/packages/utils/src/typeid.js";
import type {
  DaytonaProvisioningRuntime,
  DaytonaSandboxRuntime,
} from "../../ee/apps/den-api/src/workers/daytona.js";

type ReconcilerModule = typeof import("../../ee/apps/den-api/src/workers/reconciler.js");
type DaytonaModule = typeof import("../../ee/apps/den-api/src/workers/daytona.js");
type LifecycleModule = typeof import("../../ee/apps/den-api/src/workers/cloud-lifecycle.js");
type SharedWorkersModule = typeof import("../../ee/apps/den-api/src/routes/workers/shared.js");
type LifecycleOptions = NonNullable<Parameters<LifecycleModule["recoverClaimedCloudWorker"]>[1]>;
type LifecycleStore = NonNullable<LifecycleOptions["store"]>;
type ContinueOptions = NonNullable<Parameters<SharedWorkersModule["continueCloudProvisioning"]>[1]>;
type ProvisioningStore = NonNullable<ContinueOptions["store"]>;
type ReconcileOptions = NonNullable<Parameters<ReconcilerModule["reconcileStaleProvisioningWorkers"]>[0]>;
type ReconcileStore = NonNullable<ReconcileOptions["store"]>;
type ReconcileWorker = Awaited<ReturnType<ReconcileStore["listStaleWorkers"]>>[number];
type ReconcileToken = Awaited<ReturnType<ReconcileStore["getActiveTokens"]>>[number];
type ContinueProvisioning = NonNullable<ReconcileOptions["continueProvisioning"]>;
type ProvisionInput = Parameters<DaytonaModule["provisionWorkerOnDaytonaWithRuntime"]>[0];

function seedRequiredEnv() {
  process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_test";
  process.env.DEN_DB_ENCRYPTION_KEY ??= "x".repeat(32);
  process.env.BETTER_AUTH_SECRET ??= "y".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:8790";
  process.env.CORS_ORIGINS ??= "http://127.0.0.1:8790";
  process.env.PROVISIONER_MODE = "stub";
  process.env.DAYTONA_API_KEY = "daytona-test-key";
  process.env.DAYTONA_SNAPSHOT = "openwork-test-snapshot";
}

function makeWorker(updatedAt: Date): ReconcileWorker {
  return {
    id: createDenTypeId("worker"),
    org_id: createDenTypeId("org"),
    created_by_user_id: createDenTypeId("user"),
    name: "Cloud",
    description: null,
    destination: "cloud",
    status: "provisioning",
    image_version: null,
    workspace_path: null,
    sandbox_backend: "daytona",
    last_heartbeat_at: null,
    last_active_at: null,
    created_at: updatedAt,
    updated_at: updatedAt,
  };
}

function makeTokens(workerId: ReconcileWorker["id"]): ReconcileToken[] {
  const scopes: ReconcileToken["scope"][] = ["host", "client", "activity"];
  return scopes.map((scope) => ({
    id: createDenTypeId("workerToken"),
    worker_id: workerId,
    scope,
    token: `${scope}-token`,
    created_at: new Date("2026-08-26T10:00:00.000Z"),
    revoked_at: null,
  }));
}

function namedError(name: string, message: string) {
  const error = new Error(message);
  error.name = name;
  return error;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, label: string) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await sleep(2);
  }
}

function makeDaytonaRuntime(lookupName: string, visibleAtLookup: number | null) {
  let lookupCount = 0;
  let createCount = 0;
  let persistedCount = 0;
  const sandbox = {
    id: "sbx_late_visible",
    state: "started",
    target: "us-test",
    async refreshData() {},
    async start() { sandbox.state = "started"; },
    async stop() { sandbox.state = "stopped"; },
    async delete() {},
    async getSignedPreviewUrl() {
      return { url: "https://late-visible.preview.example.test" };
    },
    process: {
      async createSession() {},
      async executeSessionCommand() {
        return { cmdId: "cmd_1" };
      },
      async getSessionCommand() {
        return { exitCode: null };
      },
      async getSessionCommandLogs() {
        return { stdout: "", stderr: "" };
      },
    },
  } satisfies DaytonaSandboxRuntime;
  const runtime = {
    async getVolume() {
      return { id: "vol_shared", state: "ready" };
    },
    async getSandbox(name: string) {
      if (name === lookupName) {
        lookupCount += 1;
        if (visibleAtLookup !== null && lookupCount >= visibleAtLookup) return sandbox;
      }
      throw namedError("DaytonaNotFoundError", `sandbox ${name} not found`);
    },
    async createSandbox() {
      createCount += 1;
      throw namedError("DaytonaConflictError", "Sandbox with name already exists");
    },
    async upsertSandbox() {
      persistedCount += 1;
    },
    async checkpointExists() {
      return false;
    },
    async verifyRestoreMarker() {
      return false;
    },
    async waitForHealth() {},
  } satisfies DaytonaProvisioningRuntime;

  return {
    runtime,
    get lookupCount() {
      return lookupCount;
    },
    get createCount() {
      return createCount;
    },
    get persistedCount() {
      return persistedCount;
    },
  };
}

test("cloud provisioning remains single-owner and survives Daytona read-after-write lag", async ({ evidence }) => {
  seedRequiredEnv();
  const [reconciler, daytona] = await Promise.all([
    import("../../ee/apps/den-api/src/workers/reconciler.js"),
    import("../../ee/apps/den-api/src/workers/daytona.js"),
  ]);

  const staleWorker = makeWorker(new Date("2026-08-26T10:00:00.000Z"));
  const tokens = makeTokens(staleWorker.id);
  const claimedAt = new Date("2026-08-26T10:30:00.000Z");
  let durableUpdatedAt = staleWorker.updated_at;
  let claimCount = 0;
  let provisionAttempts = 0;
  const store: ReconcileStore = {
    async listStaleWorkers() {
      return [{ ...staleWorker }];
    },
    async claimWorker(input) {
      if (durableUpdatedAt.getTime() !== input.worker.updated_at.getTime()) return false;
      durableUpdatedAt = input.claimedAt;
      claimCount += 1;
      return true;
    },
    async getActiveTokens() {
      return tokens;
    },
    async markFailed() {
      throw new Error("claimed worker unexpectedly failed");
    },
  };
  const continueProvisioning: ContinueProvisioning = async () => {
    provisionAttempts += 1;
  };

  await Promise.all([
    reconciler.reconcileStaleProvisioningWorkers({ store, continueProvisioning, now: claimedAt }),
    reconciler.reconcileStaleProvisioningWorkers({ store, continueProvisioning, now: claimedAt }),
  ]);

  expect(claimCount).toBe(1);
  expect(provisionAttempts).toBe(1);
  expect(durableUpdatedAt).toEqual(claimedAt);
  evidence.recordAssertionEvidence(
    "Concurrent stale-worker reconciliation has one durable owner",
    "Both reconcilers selected the same stale worker, but the atomic claim admitted exactly one provisioning attempt.",
    true,
  );

  const provisionInput: ProvisionInput = {
    workerId: createDenTypeId("worker"),
    name: "Cloud",
    hostToken: "host-token",
    clientToken: "client-token",
    activityToken: "activity-token",
  };
  const sandboxName = daytona.currentDaytonaSandboxName(provisionInput);
  const lateVisible = makeDaytonaRuntime(sandboxName, 7);
  let lateVisibleWaitMs = 0;
  const provisioned = await daytona.provisionWorkerOnDaytonaWithRuntime(provisionInput, lateVisible.runtime, {
    sleep: async (ms) => {
      lateVisibleWaitMs += ms;
    },
  });

  expect(provisioned.status).toBe("healthy");
  expect(provisioned.url).toBe("https://late-visible.preview.example.test");
  expect(provisioned.url).not.toContain("workers.example.test");
  expect(lateVisible.createCount).toBe(1);
  expect(lateVisible.lookupCount).toBe(7);
  expect(lateVisibleWaitMs).toBe(10_000);
  expect(lateVisible.persistedCount).toBe(1);

  const permanentlyMissing = makeDaytonaRuntime(sandboxName, null);
  let missingWaitMs = 0;
  await expect(daytona.provisionWorkerOnDaytonaWithRuntime(provisionInput, permanentlyMissing.runtime, {
    sleep: async (ms) => {
      missingWaitMs += ms;
    },
  })).rejects.toThrow("Sandbox with name already exists");

  expect(permanentlyMissing.createCount).toBe(1);
  expect(permanentlyMissing.lookupCount).toBe(7);
  expect(missingWaitMs).toBe(10_000);
  expect(permanentlyMissing.persistedCount).toBe(0);
  evidence.recordAssertionEvidence(
    "Daytona read-after-write lag is retried but bounded",
    "A sandbox hidden through the observed 10-second window became healthy and persisted; a sandbox still missing after the same bounded grace rejected without persistence.",
    true,
  );
});

test("a live provisioning claim heartbeats its fence while an orphaned claim is rescued after the shorter staleness", async ({ evidence }) => {
  seedRequiredEnv();
  const [lifecycle, shared, reconciler, heartbeat, envModule] = await Promise.all([
    import("../../ee/apps/den-api/src/workers/cloud-lifecycle.js"),
    import("../../ee/apps/den-api/src/routes/workers/shared.js"),
    import("../../ee/apps/den-api/src/workers/reconciler.js"),
    import("../../ee/apps/den-api/src/workers/provisioning-heartbeat.js"),
    import("../../ee/apps/den-api/src/env.js"),
  ]);

  // The rescue window only shrinks safely because live owners beat well below it.
  expect(heartbeat.provisioningHeartbeatIntervalMs).toBe(30_000);
  expect(envModule.env.workerProvisioningReconcileStaleMs).toBe(180_000);
  expect(envModule.env.workerProvisioningReconcileStaleMs)
    .toBeGreaterThanOrEqual(4 * heartbeat.provisioningHeartbeatIntervalMs);

  const claimedAt = new Date("2026-08-27T10:00:00.000Z");
  const worker = makeWorker(claimedAt);
  const tokens = makeTokens(worker.id);
  let durableUpdatedAt = claimedAt;
  let touches = 0;
  const statusWrites: Array<{ status: string; onlyWhenStatus?: string }> = [];
  const lifecycleStore: LifecycleStore = {
    async getWorker() {
      return worker;
    },
    async getActiveTokens() {
      return tokens;
    },
    async listIdleWorkers() {
      return [];
    },
    async reserveWake() {
      return false;
    },
    async reserveIdleStop() {
      return false;
    },
    async updateWorkerStatus(input) {
      statusWrites.push({ status: input.status, onlyWhenStatus: input.onlyWhenStatus });
      if (input.onlyWhenStatus && worker.status !== input.onlyWhenStatus) return;
      worker.status = input.status;
    },
    async touchProvisioningWorker() {
      if (worker.status !== "provisioning") return;
      durableUpdatedAt = new Date();
      touches += 1;
    },
  };

  const recovery = lifecycle.recoverClaimedCloudWorker(worker.id, {
    store: lifecycleStore,
    heartbeatIntervalMs: 5,
    wakeWorker: async () => {
      await waitUntil(() => touches >= 3, 2_000, "three provisioning heartbeats");
      return { provider: "daytona", url: "https://waking.preview.example.test", status: "healthy" };
    },
    materializeProviders: async () => ({ ok: true, status: "noop", fingerprint: "owp:v1:test", providers: 0 }),
  });

  // Negative half: a reconciler holding the pre-claim snapshot must lose the
  // updated_at fence against the live heartbeat and start nothing.
  let rescueAttempts = 0;
  const fencedStore: ReconcileStore = {
    async listStaleWorkers() {
      return [{ ...worker, status: "provisioning", updated_at: claimedAt }];
    },
    async claimWorker(input) {
      if (durableUpdatedAt.getTime() !== input.worker.updated_at.getTime()) return false;
      durableUpdatedAt = input.claimedAt;
      return true;
    },
    async getActiveTokens() {
      return tokens;
    },
    async markFailed() {
      throw new Error("live worker unexpectedly failed");
    },
  };
  await waitUntil(() => touches >= 1, 2_000, "the first provisioning heartbeat");
  await reconciler.reconcileStaleProvisioningWorkers({
    store: fencedStore,
    continueProvisioning: async () => {
      rescueAttempts += 1;
    },
    now: new Date("2026-08-27T10:10:00.000Z"),
  });
  expect(rescueAttempts).toBe(0);

  await recovery;
  expect(worker.status).toBe("healthy");
  expect(statusWrites.at(-1)).toEqual({ status: "healthy", onlyWhenStatus: "provisioning" });
  expect(touches).toBeGreaterThanOrEqual(3);
  const touchesAfterRecovery = touches;
  await sleep(30);
  expect(touches).toBe(touchesAfterRecovery);
  evidence.recordAssertionEvidence(
    "A live provisioning claim is fenced, not reclaimed",
    "The claim owner's heartbeat moved updated_at while its provider action ran, a reconciler holding the stale snapshot lost the claim and started nothing, and the heartbeat stopped once the owner wrote healthy.",
    true,
  );

  // With the owner dead, no heartbeat moves the fence: the same snapshot now
  // wins the claim and concurrent reconcilers admit exactly one rescue.
  const orphan = makeWorker(new Date("2026-08-27T11:00:00.000Z"));
  const orphanTokens = makeTokens(orphan.id);
  let orphanUpdatedAt = orphan.updated_at;
  let orphanRescues = 0;
  const orphanStore: ReconcileStore = {
    async listStaleWorkers() {
      return [{ ...orphan }];
    },
    async claimWorker(input) {
      if (orphanUpdatedAt.getTime() !== input.worker.updated_at.getTime()) return false;
      orphanUpdatedAt = input.claimedAt;
      return true;
    },
    async getActiveTokens() {
      return orphanTokens;
    },
    async markFailed() {
      throw new Error("orphaned worker unexpectedly failed");
    },
  };
  const orphanRescueAt = new Date("2026-08-27T11:03:30.000Z");
  await Promise.all([
    reconciler.reconcileStaleProvisioningWorkers({
      store: orphanStore,
      continueProvisioning: async () => {
        orphanRescues += 1;
      },
      now: orphanRescueAt,
    }),
    reconciler.reconcileStaleProvisioningWorkers({
      store: orphanStore,
      continueProvisioning: async () => {
        orphanRescues += 1;
      },
      now: orphanRescueAt,
    }),
  ]);
  expect(orphanRescues).toBe(1);
  evidence.recordAssertionEvidence(
    "An orphaned provisioning claim is rescued once within the shorter staleness",
    "Three and a half minutes after its last touch, concurrent reconcilers admitted exactly one recovery attempt for the worker whose owner stopped heartbeating.",
    true,
  );

  // Initial provisioning heartbeats through the same primitive as wake recovery.
  let provisioningTouches = 0;
  const provisioningWrites: string[] = [];
  const provisioningStore: ProvisioningStore = {
    async updateWorkerStatus(input) {
      provisioningWrites.push(input.status);
    },
    async insertWorkerInstance() {},
    async touchProvisioningWorker() {
      provisioningTouches += 1;
    },
  };
  await shared.continueCloudProvisioning({
    workerId: createDenTypeId("worker"),
    name: "Cloud",
    hostToken: "host-token",
    clientToken: "client-token",
    activityToken: "activity-token",
  }, {
    store: provisioningStore,
    heartbeatIntervalMs: 5,
    provisionWorker: async () => {
      await waitUntil(() => provisioningTouches >= 2, 2_000, "two provisioning heartbeats");
      return {
        provider: "daytona",
        url: "https://fresh.preview.example.test",
        status: "healthy",
        imageVersion: "openwork-test-snapshot",
      };
    },
    materializeProviders: async () => ({ ok: true, status: "noop", fingerprint: "owp:v1:test", providers: 0 }),
  });
  expect(provisioningTouches).toBeGreaterThanOrEqual(2);
  expect(provisioningWrites).toEqual(["healthy"]);
});
