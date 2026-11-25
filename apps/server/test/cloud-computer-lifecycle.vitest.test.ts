import { expect, test } from "vitest";
import { createFakeProvider } from "../../../packages/sandbox/src/testing/fake-provider.js";
import { createCloudRuntimeOrchestrator, type CloudRuntimeOrchestratorConfig } from "../../../ee/packages/cloud-runtime/src/orchestrator/orchestrator.js";
import { createInMemoryRuntimeInstanceStore } from "../../../ee/packages/cloud-runtime/src/testing/in-memory-store.js";

const config: CloudRuntimeOrchestratorConfig = {
  instanceNamePrefix: "computer-test", sharedVolumeName: "computer-data", workspaceMountPath: "/workspace", dataMountPath: "/persist",
  runtimeWorkspacePath: "/tmp/workspace", runtimeDataPath: "/tmp/data", sidecarDir: "/tmp/sidecars", checkpointIntervalSeconds: 60, checkpointKeep: 2,
  port: 8787, publicEndpoint: false, lifecycle: { autoStopMinutes: 0 }, resources: { cpu: 2, memoryGb: 4, diskGb: 8 },
  endpointTtlSeconds: 3600, endpointRefreshLeadMs: 60_000, createTimeoutMs: 1000, stopTimeoutMs: 1000, destroyTimeoutMs: 1000,
  healthcheckTimeoutMs: 1000, pollIntervalMs: 1, activityHeartbeatUrl: () => "https://example.com/activity",
  bootstrap: { imageDescription: "test image", rebuildHint: "rebuild", cloudComputerDisplay: ":99" },
};
const input = { workerId: "computer-worker", name: "Cloud computer", hostToken: "test-host", clientToken: "test-client", activityToken: "test-activity" };

for (const memory of [true, false]) test(memory ? "idle VM pause and wake preserve the existing browser process" : "container workers keep their existing cold stop and bootstrap behavior", async () => {
  let pauses = 0;
  const provider = createFakeProvider({ capabilities: { memorySnapshotRestore: memory, platform: { os: "linux", isolation: memory ? "vm" : "container" } }, onOperation: operation => { if (operation.name === "pause") pauses++; } });
  const store = createInMemoryRuntimeInstanceStore();
  const runtime = createCloudRuntimeOrchestrator({ provider, store, config, logger: { warn() {} }, fetch: async () => new Response("ok") });
  await runtime.provision(input);
  store.imageVersions.set(input.workerId, "fake-image");
  const launches = provider.fake.count("exec");
  await runtime.stop(input.workerId);
  expect(pauses).toBe(memory ? 1 : 0);
  expect(provider.fake.count("stop")).toBe(memory ? 0 : 1);
  await runtime.wake(input);
  expect(provider.fake.count("exec")).toBe(memory ? launches : launches + 1);
  expect(provider.fake.count("destroy")).toBe(0);
  expect(store.records.size).toBe(1);
});

test("a resumed VM without a healthy runtime uses the cold bootstrap", async () => {
  const provider = createFakeProvider({ capabilities: { memorySnapshotRestore: true, platform: { os: "linux", isolation: "vm" } } });
  const store = createInMemoryRuntimeInstanceStore();
  let cold = false;
  const runtime = createCloudRuntimeOrchestrator({ provider, store, config, logger: { warn() {} }, fetch: async () => {
    if (cold) { cold = false; return new Response("not running", { status: 503 }); }
    return new Response("ok");
  } });
  await runtime.provision(input); store.imageVersions.set(input.workerId, "fake-image");
  await runtime.stop(input.workerId); cold = true;
  await runtime.wake(input);
  expect(provider.fake.count("exec")).toBe(2);
  expect(provider.fake.count("destroy")).toBe(0);
});


test("opening Web while pause is still converging preserves the warm runtime", async () => {
  const provider = createFakeProvider({ capabilities: { memorySnapshotRestore: true, platform: { os: "linux", isolation: "vm" } } });
  const store = createInMemoryRuntimeInstanceStore();
  const runtime = createCloudRuntimeOrchestrator({ provider, store, config, logger: { warn() {} }, fetch: async () => new Response("ok") });
  await runtime.provision(input); store.imageVersions.set(input.workerId, "fake-image");
  await runtime.stop(input.workerId);
  const record = provider.fake.sandboxes()[0];
  if (!record) throw new Error("No test instance");
  provider.fake.setState(record.id, "stopping");
  const settle = setTimeout(() => provider.fake.setState(record.id, "stopped"), 5);
  try { await runtime.wake(input); } finally { clearTimeout(settle); }
  expect(provider.fake.count("exec")).toBe(1);
});


test("credentials rotated during pause are installed before Web reconnects", async () => {
  const provider = createFakeProvider({ capabilities: { memorySnapshotRestore: true, platform: { os: "linux", isolation: "vm" } } });
  const store = createInMemoryRuntimeInstanceStore();
  const runtime = createCloudRuntimeOrchestrator({ provider, store, config, logger: { warn() {} }, fetch: async url => new Response("ok", { status: url.endsWith("/whoami") ? 401 : 200 }) });
  await runtime.provision(input); store.imageVersions.set(input.workerId, "fake-image");
  await runtime.stop(input.workerId);
  await runtime.wake({ ...input, clientToken: "rotated-client" });
  expect(provider.fake.count("exec")).toBe(2);
});
