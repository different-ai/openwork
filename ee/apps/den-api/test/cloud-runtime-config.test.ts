import { beforeAll, describe, expect, test } from "bun:test"

type CloudRuntimeModule = typeof import("../src/workers/cloud-runtime.js")

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
  process.env.WORKER_ACTIVITY_BASE_URL = "https://den.example/"
  process.env.CLOUD_RUNTIME_PROVIDER = "daytona"
  process.env.DAYTONA_API_KEY = "daytona-test-key"
  process.env.DAYTONA_SNAPSHOT = "openwork-0.18.8"
  process.env.DAYTONA_RUNTIME_DATA_PATH = "/tmp/openwork-data"
  process.env.DAYTONA_RUNTIME_WORKSPACE_PATH = "/tmp/openwork-workspace"
  process.env.DAYTONA_DATA_MOUNT_PATH = "/persist/openwork"
  process.env.DAYTONA_WORKSPACE_MOUNT_PATH = "/workspace"
  process.env.DAYTONA_SIDECAR_DIR = "/tmp/openwork-sidecars"
  process.env.DAYTONA_STOP_TIMEOUT_SECONDS = "45"
  process.env.DEN_CKPT_INTERVAL_SECONDS = "300"
  process.env.DEN_CKPT_KEEP = "3"
}

let cloudRuntime: CloudRuntimeModule

beforeAll(async () => {
  seedRequiredEnv()
  cloudRuntime = await import("../src/workers/cloud-runtime.js")
})

describe("Cloud runtime configuration", () => {
  test("CLOUD_RUNTIME_PROVIDER selects the contract provider and its credential decides availability", () => {
    expect(cloudRuntime.cloudRuntimeConfigured()).toBe(true)
    expect(cloudRuntime.cloudRuntimeAvailable()).toBe(true)
    expect(cloudRuntime.cloudRuntimeAvailable({ daytonaApiKey: "" })).toBe(false)
    expect(cloudRuntime.cloudRuntimeConfigured({ provisionerMode: "stub" })).toBe(false)
    expect(cloudRuntime.cloudRuntimeAvailable({ provisionerMode: "render" })).toBe(false)
    expect(cloudRuntime.isCloudRuntimeProviderId("daytona")).toBe(true)
    expect(cloudRuntime.isCloudRuntimeProviderId("render")).toBe(false)
    expect(cloudRuntime.isCloudRuntimeProviderId("stub")).toBe(false)
  })

  test("the pinned image version is configuration, not a credential", () => {
    expect(cloudRuntime.currentCloudImageVersion()).toBe("openwork-0.18.8")
    expect(cloudRuntime.currentCloudImageVersion({ provisionerMode: "stub" })).toBeNull()
  })

  test("maps the runtime environment onto the provider-neutral orchestrator config", () => {
    const config = cloudRuntime.cloudRuntimeOrchestratorConfig()

    expect(config).toMatchObject({
      instanceNamePrefix: "den-daytona-worker",
      sharedVolumeName: "den-daytona-workers",
      workspaceMountPath: "/workspace",
      dataMountPath: "/persist/openwork",
      runtimeWorkspacePath: "/tmp/openwork-workspace",
      runtimeDataPath: "/tmp/openwork-data",
      sidecarDir: "/tmp/openwork-sidecars",
      checkpointIntervalSeconds: 300,
      checkpointKeep: 3,
      port: 8787,
      publicEndpoint: false,
      lifecycle: { autoStopMinutes: 0, autoArchiveMinutes: 10080, autoDeleteMinutes: -1 },
      resources: { cpu: 2, memoryGb: 4, diskGb: 8 },
      endpointTtlSeconds: 86_400,
      endpointRefreshLeadMs: 300_000,
      createTimeoutMs: 300_000,
      stopTimeoutMs: 45_000,
      destroyTimeoutMs: 120_000,
      healthcheckTimeoutMs: 300_000,
      pollIntervalMs: 1_000,
    })
    expect(config.activityHeartbeatUrl("worker_01test")).toBe("https://den.example/v1/workers/worker_01test/activity-heartbeat")
    // The bootstrap still tells operators which image to rebuild.
    expect(config.bootstrap.rebuildHint).toContain("Daytona snapshot")
  })

  test("the orchestrator boots against the configured provider and pin", () => {
    const runtime = cloudRuntime.getCloudRuntime()
    expect(runtime.providerId).toBe("daytona")
    expect(runtime.currentImageVersion()).toBe("openwork-0.18.8")
    const workerId = "worker_01hzz0000000000000000test0"
    const instanceName = runtime.instanceName({ workerId, name: "Cloud" })
    expect(instanceName).toMatch(/^den-daytona-worker-[a-f0-9]{32}-v[a-f0-9]{8}$/)
    expect(runtime.instanceName({ workerId, name: "Another label" })).toBe(instanceName)
  })
})
