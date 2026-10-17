import assert from "node:assert/strict"
import { test } from "node:test"
import { renderOpenWorkBootstrapScript, type OpenWorkBootstrapConfig } from "@openwork-ee/cloud-runtime/bootstrap"
import { createCloudRuntimeOrchestrator, type CloudRuntimeOrchestratorConfig } from "@openwork-ee/cloud-runtime/orchestrator"
import { createInMemoryRuntimeInstanceStore } from "@openwork-ee/cloud-runtime/testing"
import { createFakeProvider } from "@openwork/sandbox/testing"

const bootstrap: OpenWorkBootstrapConfig = {
  dataMountPath: "/mnt/data",
  workspaceMountPath: "/mnt/workspace",
  runtimeDataPath: "/runtime/data",
  runtimeWorkspacePath: "/runtime/workspace",
  sidecarDir: "/runtime/sidecar",
  intervalSeconds: 60,
  keep: 3,
  port: 8787,
  workerId: "worker-1",
  clientToken: "client-token",
  hostToken: "host-token",
  activityHeartbeat: { url: "https://den.invalid/heartbeat", token: "activity-token" },
  runtimeProvider: "fake",
  imageDescription: "test image",
  rebuildHint: "rebuild the test image",
}

type EnginePolicy = {
  engineV2ForceUpgrade: boolean
}

function assertRollout(script: string, policy: Partial<EnginePolicy>) {
  // Even OFF must be delivered explicitly, so the server can revert only
  // profiles marked as force-upgraded and leave voluntary v2 users alone.
  assert.match(script, /OPENWORK_ENGINE_FORCE_POLICY='1'/)
  if (policy.engineV2ForceUpgrade) {
    assert.match(script, /OPENWORK_ENGINE_AUTO_UPGRADE='1'/)
    assert.match(script, /OPENWORK_FRESH_INSTALL_ENGINE='v2'/)
  } else {
    assert.match(script, /OPENWORK_ENGINE_AUTO_UPGRADE='0'/)
    assert.doesNotMatch(script, /OPENWORK_FRESH_INSTALL_ENGINE=/)
  }
  // The server, not the shell, owns safe transitions and persisted engine state.
  assert.doesNotMatch(script, /OPENWORK_(?:ENGINE|FRESH_INSTALL_ENGINE)='v1'/)
}

for (const policy of [
  {},
  { engineV2ForceUpgrade: false },
  { engineV2ForceUpgrade: true },
]) {
  test(`bootstrap explicitly applies org force-upgrade policy (${JSON.stringify(policy)})`, () => {
    const script = renderOpenWorkBootstrapScript({ ...bootstrap, ...policy })
    assertRollout(script, policy)
    assert.match(script, /OPENWORK_OPENCODE2_BIN='\/usr\/local\/bin\/opencode2'/)
    assert.match(script, /OPENWORK_RUNTIME_SURFACE='web'/)
    // Existing dual-engine images still honor rollout rollback. Only the image
    // contract retires v1, and the bootstrap must accept its v2-only contents.
    assert.match(script, /OPENWORK_ENGINE_V2_ONLY:-0/)
    assert.match(script, /then engine_bin=opencode2; else engine_bin=opencode; fi/)
    assert.doesNotMatch(script, /OPENWORK_OPENCODE_BIN=/)
    assert.ok(script.indexOf("hydrate_checkpoint\nattempt=0") < script.indexOf("OPENWORK_ENGINE_AUTO_UPGRADE="))
    // Policy delivery never directly removes or rewrites restored engine state.
    assert.doesNotMatch(script, /engine-v2-preview\.json|engine\.json/)
  })
}

function runtimeConfig(enginePolicy: (workerId: string) => Promise<EnginePolicy>): CloudRuntimeOrchestratorConfig {
  return {
    instanceNamePrefix: "test",
    sharedVolumeName: "shared",
    workspaceMountPath: bootstrap.workspaceMountPath,
    dataMountPath: bootstrap.dataMountPath,
    runtimeWorkspacePath: bootstrap.runtimeWorkspacePath,
    runtimeDataPath: bootstrap.runtimeDataPath,
    sidecarDir: bootstrap.sidecarDir,
    checkpointIntervalSeconds: 60,
    checkpointKeep: 3,
    port: bootstrap.port,
    publicEndpoint: false,
    lifecycle: { autoStopMinutes: 10, autoArchiveMinutes: 60, autoDeleteMinutes: 0 },
    resources: { cpu: 2, memoryGb: 4, diskGb: 10 },
    endpointTtlSeconds: 3600,
    endpointRefreshLeadMs: 1000,
    createTimeoutMs: 1000,
    stopTimeoutMs: 1000,
    destroyTimeoutMs: 1000,
    healthcheckTimeoutMs: 1000,
    pollIntervalMs: 1,
    activityHeartbeatUrl: () => bootstrap.activityHeartbeat.url,
    bootstrap: {
      imageDescription: bootstrap.imageDescription,
      rebuildHint: bootstrap.rebuildHint,
      enginePolicy,
    },
  }
}

const provisionInput = {
  workerId: bootstrap.workerId,
  name: "test-worker",
  clientToken: bootstrap.clientToken,
  hostToken: bootstrap.hostToken,
  activityToken: bootstrap.activityHeartbeat.token,
}

test("cached orchestrator re-resolves policy on fresh launch, wake, and restored image replacement", async () => {
  let policy = { engineV2ForceUpgrade: false }
  const resolvedWorkers: string[] = []
  const scripts: string[] = []
  const image = { id: "test-image", version: "old-image" }
  const provider = createFakeProvider({
    image,
    onExec: ({ spec }) => {
      if (spec.script) scripts.push(spec.script)
      return { exitCode: 0 }
    },
  })
  const store = createInMemoryRuntimeInstanceStore()
  const runtime = createCloudRuntimeOrchestrator({
    provider,
    store,
    config: runtimeConfig(async (workerId) => {
      resolvedWorkers.push(workerId)
      return policy
    }),
    logger: { warn() {} },
    fetch: async () => new Response("{}"),
  })

  await runtime.provision(provisionInput)
  assertRollout(scripts.at(-1) ?? "", policy)

  policy = { engineV2ForceUpgrade: true }
  await runtime.stop(provisionInput.workerId)
  await runtime.wake(provisionInput)
  assertRollout(scripts.at(-1) ?? "", policy)

  // A checkpoint restored onto a replacement image uses the current policy,
  // not the value the old sandbox was created with. Explicit OFF lets the
  // server safely revert only profiles marked as force-upgraded.
  policy = { engineV2ForceUpgrade: false }
  await runtime.stop(provisionInput.workerId)
  store.imageVersions.set(provisionInput.workerId, image.version)
  image.version = "new-image"
  provider.fake.writeVolumeFile("shared", `workers/${provisionInput.workerId}/data/checkpoints/ckpt-1.tar`)
  await runtime.wake(provisionInput)
  assertRollout(scripts.at(-1) ?? "", policy)
  assert.equal(provider.fake.count("create"), 2)
  assert.equal(provider.fake.count("destroy"), 1)

  policy = { engineV2ForceUpgrade: true }
  await runtime.stop(provisionInput.workerId)
  store.imageVersions.set(provisionInput.workerId, runtime.currentImageVersion())
  await runtime.wake(provisionInput)
  assertRollout(scripts.at(-1) ?? "", policy)

  // OFF remains explicit after another restart; it never forces fresh v1.
  policy = { engineV2ForceUpgrade: false }
  await runtime.stop(provisionInput.workerId)
  await runtime.wake(provisionInput)
  assertRollout(scripts.at(-1) ?? "", policy)
  assert.deepEqual(resolvedWorkers, Array(5).fill(provisionInput.workerId))
  assert.equal(scripts.length, 5)
})
