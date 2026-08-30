import { test } from "@openwork/testkit";
import { expect } from "vitest";
import { createDenTypeId } from "../../ee/packages/utils/src/typeid.js";
import type { DaytonaProvisioningRuntime, DaytonaSandboxRuntime } from "../../ee/apps/den-api/src/workers/daytona.js";
import type { CloudRuntimeStore, CloudRuntimeWorker } from "../../ee/apps/den-api/src/workers/worker-access.js";

function seedRequiredEnv() {
  process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_test";
  process.env.DEN_DB_ENCRYPTION_KEY ??= "x".repeat(32);
  process.env.BETTER_AUTH_SECRET ??= "y".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:8790";
  process.env.CORS_ORIGINS ??= "http://127.0.0.1:8790";
  process.env.PROVISIONER_MODE = "stub";
  process.env.DAYTONA_API_KEY ??= "daytona-test-key";
  process.env.DAYTONA_SNAPSHOT ??= "openwork-test-snapshot";
}

test("Cloud startup failures are diagnosable and explicitly retryable without leaking credentials", async ({ evidence }) => {
  seedRequiredEnv();
  const [failureModule, runtimeModule, gatewayModule, clientModule, workspaceStatusModule, daytonaModule] = await Promise.all([
    import("../../ee/apps/den-api/src/workers/cloud-failure.js"),
    import("../../ee/apps/den-api/src/workers/worker-access.js"),
    import("../../ee/apps/den-gateway/src/app.js"),
    import("../../apps/app/src/app/lib/den.js"),
    import("../../apps/app/src/react-app/shell/cloud-workspace-status.js"),
    import("../../ee/apps/den-api/src/workers/daytona.js"),
  ]);

  const failure = failureModule.createCloudStartupFailure({
    stage: "recovery",
    error: new Error("Timed out waiting for Daytona worker health\nAuthorization: Bearer runtime-secret"),
    now: () => new Date("2026-08-28T12:00:00.000Z"),
  });
  const publicFailure = failureModule.publicCloudStartupFailure(failure);
  expect(publicFailure.code).toBe("runtime_health_timeout");
  expect(JSON.stringify(publicFailure)).not.toContain("runtime-secret");
  evidence.recordAssertionEvidence(
    "A failed sandbox keeps a safe, correlated startup diagnosis",
    `The provider error normalized to ${publicFailure.code} at ${publicFailure.stage} with reference ${publicFailure.reference}; the public payload omitted the raw bearer-bearing error.`,
    true,
  );

  const worker: CloudRuntimeWorker = {
    id: createDenTypeId("worker"),
    name: "Cloud diagnostics proof",
    status: "failed",
    cloud_failure_code: "provider_operation_failed",
    cloud_failure_stage: "provisioning",
    cloud_failure_reference: "cwf_initial-proof",
    cloud_failure_at: new Date(1_000),
  };
  let claimAttempts = 0;
  let now = 1_000;
  let recoveryCalls = 0;
  const store: CloudRuntimeStore = {
    async claimFailedWorker() {
      claimAttempts += 1;
      if (worker.status !== "failed") return false;
      worker.status = "provisioning";
      return true;
    },
    async claimRecycleWorker() { return false; },
    async getActiveTokens() {
      return [
        { scope: "host", token: "host-token" },
        { scope: "client", token: "client-token" },
        { scope: "activity", token: "activity-token" },
      ];
    },
    async markProvisioningWorkerFailed() {},
    async markHealthyWorkerFailed() {},
  };
  const options = {
    refreshSignedPreview: async () => null,
    getSandboxRecord: async () => null,
    inspectSandbox: async () => null,
    probeSignedPreview: async () => false,
    startWake: () => {},
    startRecovery: () => { recoveryCalls += 1; },
    store,
    now: () => now,
  };

  const first = await runtimeModule.resolveCloudRuntimeState({
    worker,
    organizationId: createDenTypeId("organization"),
  }, options);
  worker.status = "failed";
  worker.cloud_failure_stage = "recovery";
  worker.cloud_failure_at = new Date(1_000);
  const passive = await runtimeModule.resolveCloudRuntimeState({
    worker,
    organizationId: createDenTypeId("organization"),
  }, options);
  const explicit = await runtimeModule.resolveCloudRuntimeState({
    worker,
    organizationId: createDenTypeId("organization"),
  }, { ...options, forceFailedRecovery: true });
  worker.status = "failed";
  const repeatedExplicit = await runtimeModule.resolveCloudRuntimeState({
    worker,
    organizationId: createDenTypeId("organization"),
  }, { ...options, forceFailedRecovery: true });
  now += 60_000;
  const cooledExplicit = await runtimeModule.resolveCloudRuntimeState({
    worker,
    organizationId: createDenTypeId("organization"),
  }, { ...options, forceFailedRecovery: true });
  await Promise.resolve();
  await Promise.resolve();

  expect(first.status).toBe("provisioning");
  expect(passive.status).toBe("failed");
  expect(explicit.status).toBe("provisioning");
  expect(repeatedExplicit.status).toBe("failed");
  expect(cooledExplicit.status).toBe("provisioning");
  expect(claimAttempts).toBe(3);
  expect(recoveryCalls).toBe(3);
  evidence.recordAssertionEvidence(
    "Recovery uses a durable passive cooldown and a bounded explicit retry",
    "A persisted recovery failure throttled passive polling without process-local memory, one explicit retry bypassed that cooldown, an immediate repeated retry made no provider attempt, and retry became available again after 60 seconds.",
    true,
  );

  const unavailable = workspaceStatusModule.mapCloudWorkspaceState({
    instance: null,
    updating: false,
    requestFailed: true,
  });
  const sandboxFailed = workspaceStatusModule.mapCloudWorkspaceState({
    instance: {
      status: "failed",
      url: null,
      imageVersion: "openwork-test-snapshot",
      latestVersion: "openwork-test-snapshot",
    },
    updating: false,
    requestFailed: false,
  });
  expect(unavailable.variant).toBe("unavailable");
  expect(unavailable.statusLine).toBe("Couldn’t check workspace status");
  expect(sandboxFailed.variant).toBe("failed");
  expect(workspaceStatusModule.cloudWorkspaceTakeoverCopy({ variant: unavailable.variant, slow: false }).body)
    .toContain("sandbox may still be running");
  evidence.recordAssertionEvidence(
    "A control-plane request failure is not mislabeled as a sandbox failure",
    "A failed status request maps to the unavailable state and explicitly says the sandbox may still be running, while a durable failed instance keeps the workspace-needs-attention recovery state.",
    true,
  );

  let sandboxState = "started";
  let stopCalls = 0;
  let startCalls = 0;
  let processStarts = 0;
  const recoverySandbox = {
    id: "sandbox_recovery_proof",
    get state() { return sandboxState; },
    get target() { return "us-test"; },
    async refreshData() {},
    async start() {
      startCalls += 1;
      sandboxState = "started";
    },
    async stop() {
      stopCalls += 1;
      sandboxState = "stopped";
    },
    async delete() {},
    async getSignedPreviewUrl() {
      return { url: "https://recovered.preview.example.test" };
    },
    process: {
      async createSession() {},
      async executeSessionCommand() {
        processStarts += 1;
        return { cmdId: "command_recovery_proof" };
      },
      async getSessionCommand() { return { exitCode: null }; },
      async getSessionCommandLogs() { return { stdout: "", stderr: "" }; },
    },
  } satisfies DaytonaSandboxRuntime;
  const persistedSandboxes: Array<Parameters<DaytonaProvisioningRuntime["upsertSandbox"]>[0]> = [];
  const recoveryRuntime = {
    async getVolume() { return { id: "volume_recovery_proof", state: "ready" }; },
    async getSandbox() { return recoverySandbox; },
    async createSandbox() { throw new Error("recovery must reuse the existing sandbox"); },
    async upsertSandbox(input) { persistedSandboxes.push(input); },
    async checkpointExists() { return false; },
    async verifyRestoreMarker() { return false; },
    async waitForHealth() {},
    now: () => new Date("2026-08-28T12:00:00.000Z").getTime(),
  } satisfies DaytonaProvisioningRuntime;
  const recoveryWorkerId = createDenTypeId("worker");
  const recovered = await daytonaModule.wakeWorkerOnDaytonaWithRuntime({
    workerId: recoveryWorkerId,
    name: "Cloud recovery proof",
    hostToken: "host-token",
    clientToken: "client-token",
    activityToken: "activity-token",
  }, recoveryRuntime, {
    sandbox_id: recoverySandbox.id,
    workspace_volume_id: "volume_recovery_proof",
    data_volume_id: "volume_recovery_proof",
  }, "openwork-test-snapshot");
  expect(recovered.status).toBe("healthy");
  expect(stopCalls).toBe(1);
  expect(startCalls).toBe(1);
  expect(processStarts).toBe(1);
  expect(persistedSandboxes).toHaveLength(1);
  evidence.recordAssertionEvidence(
    "Recovery replaces an untrusted running process instead of duplicating it",
    "The production Daytona wake path stopped and restarted an already-running sandbox once, launched exactly one OpenWork process, passed health, and persisted one refreshed preview.",
    true,
  );

  let failedSandboxDeletes = 0;
  const failedStopSandbox = {
    id: "sandbox_failed_stop_proof",
    state: "started",
    target: "us-test",
    async refreshData() {},
    async start() {},
    async stop() { throw new Error("provider refused sandbox stop"); },
    async delete() { failedSandboxDeletes += 1; },
    async getSignedPreviewUrl() { return { url: "https://failed.preview.example.test" }; },
    process: {
      async createSession() {},
      async executeSessionCommand() { return { cmdId: "command_failed_stop_proof" }; },
      async getSessionCommand() { return { exitCode: null }; },
      async getSessionCommandLogs() { return { stdout: "", stderr: "" }; },
    },
  } satisfies DaytonaSandboxRuntime;
  let replacementProcessStarts = 0;
  const replacementSandbox = {
    id: "sandbox_replacement_proof",
    state: "started",
    target: "us-test",
    async refreshData() {},
    async start() {},
    async stop() {},
    async delete() {},
    async getSignedPreviewUrl() { return { url: "https://replacement.preview.example.test" }; },
    process: {
      async createSession() {},
      async executeSessionCommand() {
        replacementProcessStarts += 1;
        return { cmdId: "command_replacement_proof" };
      },
      async getSessionCommand() { return { exitCode: null }; },
      async getSessionCommandLogs() { return { stdout: "", stderr: "" }; },
    },
  } satisfies DaytonaSandboxRuntime;
  let replacementCreates = 0;
  let replacementCheckpointChecks = 0;
  let replacementRestoreChecks = 0;
  const replacementRows: Array<Parameters<DaytonaProvisioningRuntime["upsertSandbox"]>[0]> = [];
  const replacementRuntime = {
    async getVolume() { return { id: "volume_replacement_proof", state: "ready" }; },
    async getSandbox() { return failedStopSandbox; },
    async createSandbox() {
      replacementCreates += 1;
      return replacementSandbox;
    },
    async upsertSandbox(input) { replacementRows.push(input); },
    async checkpointExists() {
      replacementCheckpointChecks += 1;
      return true;
    },
    async verifyRestoreMarker() {
      replacementRestoreChecks += 1;
      return true;
    },
    async waitForHealth() {},
    now: () => new Date("2026-08-28T12:00:00.000Z").getTime(),
  } satisfies DaytonaProvisioningRuntime;
  const replacementResult = await daytonaModule.wakeWorkerOnDaytonaWithRuntime({
    workerId: createDenTypeId("worker"),
    name: "Cloud replacement proof",
    hostToken: "host-token",
    clientToken: "client-token",
    activityToken: "activity-token",
  }, replacementRuntime, {
    sandbox_id: failedStopSandbox.id,
    workspace_volume_id: "volume_replacement_proof",
    data_volume_id: "volume_replacement_proof",
  }, "openwork-test-snapshot");
  expect(replacementResult.status).toBe("healthy");
  expect(replacementCreates).toBe(1);
  expect(replacementCheckpointChecks).toBe(1);
  expect(replacementRestoreChecks).toBe(1);
  expect(replacementProcessStarts).toBe(1);
  expect(failedSandboxDeletes).toBe(1);
  expect(replacementRows).toHaveLength(1);
  expect(replacementRows[0]?.sandboxId).toBe(replacementSandbox.id);
  evidence.recordAssertionEvidence(
    "A provider-level wake failure escalates to a restored replacement sandbox",
    "When the existing sandbox could not be stopped, recovery found the shared checkpoint, started and verified one replacement, switched the durable sandbox record, and deleted the unhealthy sandbox only after the replacement was healthy.",
    true,
  );

  const originalHealthFetch = globalThis.fetch;
  let healthRequestAborted = false;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return reject(new Error("health request did not receive a deadline"));
      const onAbort = () => {
        healthRequestAborted = true;
        reject(signal.reason);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    })) satisfies typeof fetch,
  });
  const healthStartedAt = Date.now();
  try {
    await expect(daytonaModule.waitForHealth(
      "https://hung.preview.example.test",
      20,
      recoverySandbox,
      "session_health_proof",
      "command_health_proof",
    )).rejects.toThrow("Timed out waiting for Daytona worker health");
  } finally {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalHealthFetch });
  }
  expect(healthRequestAborted).toBe(true);
  expect(Date.now() - healthStartedAt).toBeLessThan(500);
  evidence.recordAssertionEvidence(
    "A hung health request cannot exceed the sandbox readiness budget",
    "The health request received an abort deadline, was cancelled inside the 20 ms readiness budget, and the recovery wait completed in under 500 ms instead of hanging indefinitely.",
    true,
  );

  const originalFetch = globalThis.fetch;
  const retryRequests: Array<{ method: string; path: string }> = [];
  const retryFetch: typeof fetch = async (input, init) => {
    const request = {
      method: init?.method ?? "GET",
      path: new URL(String(input)).pathname,
    };
    retryRequests.push(request);
    return request.path.endsWith("/retry")
      ? Response.json({ error: "not_found" }, { status: 404 })
      : Response.json({ status: "failed", url: null });
  };
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: retryFetch });
  let legacyRetry;
  try {
    legacyRetry = await clientModule
      .createDenClient({ baseUrl: "https://den.example.test", token: "den-token" })
      .retryCloudInstance("org_test");
  } finally {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  }

  expect(legacyRetry.status).toBe("failed");
  expect(retryRequests).toEqual([
    { method: "POST", path: "/api/den/v1/cloud/instance/retry" },
    { method: "GET", path: "/api/den/v1/cloud/instance" },
  ]);
  evidence.recordAssertionEvidence(
    "Retry stays compatible with a Den that predates explicit recovery",
    "When the explicit retry route returned 404, the client made one fallback request to the established instance-status route, preserved the failed workspace state, and did not repeat the unsupported POST.",
    true,
  );

  let instanceFetches = 0;
  const gateway = gatewayModule.createGatewayApp({
    denApiBase: "https://den.example.test",
    gatewayKey: "gateway-secret",
    logRequests: false,
    fetchImpl: async () => Response.json({
      status: "failed",
      url: null,
      clientToken: null,
      hostToken: null,
      expiresAt: null,
      failure: publicFailure,
    }),
    instanceFetch: async () => {
      instanceFetches += 1;
      return Response.json({ token: "must-not-be-reached" });
    },
  });
  const response = await gateway.fetch(new Request("https://web.example.test/workspaces", {
    headers: { Authorization: "Bearer browser-session-secret" },
  }));
  const payload = await response.json();

  expect(response.status).toBe(503);
  expect(response.headers.get("retry-after")).toBe("5");
  expect(payload).toEqual({ error: "workspace_not_ready", status: "failed", failure: publicFailure });
  expect(JSON.stringify(payload)).not.toContain("browser-session-secret");
  expect(instanceFetches).toBe(0);
  evidence.recordAssertionEvidence(
    "The gateway reports not-ready as an error instead of a malformed success",
    "A failed workspace returned HTTP 503 workspace_not_ready with Retry-After: 5 and the safe diagnostic; the runtime was never proxied and browser credentials were absent.",
    true,
  );
});
