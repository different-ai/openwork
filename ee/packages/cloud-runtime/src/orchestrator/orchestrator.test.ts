import { describe, expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import { RuntimeProviderError } from "../contract/errors"
import type { ExecSpec } from "../contract/provider"
import { createFakeProvider, type FakeOperation, type FakeProviderOptions } from "../testing/fake-provider"
import { createInMemoryRuntimeInstanceStore } from "../testing/in-memory-store"
import { CloudRuntimeError, isCloudRuntimeInstanceMissingError } from "./errors"
import {
  baseInstanceName,
  currentInstanceName,
  instanceNameForImageVersion,
  instanceLookupNames,
  legacyInstanceNamesForLocalMatch,
  recoveryInstanceName,
} from "./names"
import {
  createCloudRuntimeOrchestrator,
  type CloudRuntimeOrchestratorConfig,
  type ProvisionInput,
} from "./orchestrator"

const imageVersion = "openwork-0.18.8"
const previousImageVersion = "openwork-0.18.7"
const prefix = "den-cloud-worker"
const legacyName = "den-cloud-worker-cloud-worker-01hzz"
const legacyVersionedName = `${legacyName}-openwork-0-18-8`
const workerIds = ["wrk_01jz7m8n9p2q3r4s5t6v7w8x9a", "wrk_01jz7m8n9p2q3r4s5t6v7w8x9b"]

function config(overrides: Partial<CloudRuntimeOrchestratorConfig> = {}): CloudRuntimeOrchestratorConfig {
  return {
    instanceNamePrefix: prefix,
    sharedVolumeName: "den-cloud-workers",
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
    endpointRefreshLeadMs: 5 * 60 * 1000,
    createTimeoutMs: 300_000,
    stopTimeoutMs: 120_000,
    destroyTimeoutMs: 120_000,
    healthcheckTimeoutMs: 300_000,
    pollIntervalMs: 1_000,
    activityHeartbeatUrl: (workerId) => `https://den.example/v1/workers/${workerId}/activity-heartbeat`,
    bootstrap: { imageDescription: "test runtime image", rebuildHint: "rebuild the test image" },
    ...overrides,
  }
}

function provisionInput(): ProvisionInput {
  return {
    workerId: "worker_01hzz0000000000000000test0",
    name: "Cloud",
    hostToken: "host-token",
    clientToken: "client-token",
    activityToken: "activity-token",
  }
}

type HarnessOptions = {
  provider?: FakeProviderOptions
  config?: Partial<CloudRuntimeOrchestratorConfig>
  /** Decide whether a health probe passes; defaults to healthy. */
  health?: (url: string) => boolean | Promise<boolean>
  onOperation?: (operation: FakeOperation) => void | Promise<void>
  restoreMarkerVerified?: boolean
  now?: () => number
}

function harness(options: HarnessOptions = {}) {
  const sleeps: number[] = []
  const healthChecks: string[] = []
  const execs: ExecSpec[] = []
  const provider = createFakeProvider({
    image: { id: imageVersion, version: imageVersion },
    region: "us-test",
    onExec: ({ spec }) => {
      execs.push(spec)
      if (spec.detach) return { exitCode: null }
      if (spec.command?.includes("test -s") && spec.command.includes("openwork-restore-marker")) {
        return { exitCode: options.restoreMarkerVerified === false ? 1 : 0 }
      }
      return { exitCode: 0 }
    },
    onOperation: options.onOperation,
    now: options.now,
    ...options.provider,
  })
  const store = createInMemoryRuntimeInstanceStore()
  const warnings: string[] = []
  const orchestrator = createCloudRuntimeOrchestrator({
    provider,
    store,
    config: config(options.config),
    logger: { warn: (message) => warnings.push(message) },
    fetch: async (url) => {
      healthChecks.push(url)
      const healthy = options.health ? await options.health(url) : true
      return new Response(null, { status: healthy ? 200 : 503 })
    },
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    now: options.now,
    randomSuffix: () => "abcd1234",
  })
  return {
    provider,
    store,
    orchestrator,
    sleeps,
    healthChecks,
    execs,
    warnings,
    restoreMarkerChecks: () => execs.filter((spec) => !spec.detach && spec.command?.includes("test -s") && spec.command.includes("openwork-restore-marker")).length,
    stopFlushes: () => execs.filter((spec) => !spec.detach && spec.command?.includes("flush_checkpoint")).length,
    checkpointChecks: () => provider.fake.count("storage.exists"),
    sandboxIdOf: (idempotencyKey: string) => provider.fake.sandbox(idempotencyKey)?.id ?? null,
  }
}

function currentName(input: ProvisionInput) {
  return instanceNameForImageVersion(prefix, input, imageVersion)
}

function ownerLabels(input: ProvisionInput) {
  return { "openwork.den.provider": "fake", "openwork.den.worker-id": input.workerId }
}

function conflict() {
  return new RuntimeProviderError({ providerId: "fake", code: "conflict", message: "Sandbox with name already exists" })
}

async function seedRecord(h: ReturnType<typeof harness>, input: ProvisionInput, sandboxId: string, workerImageVersion: string | null) {
  await h.store.upsert({
    workerId: input.workerId,
    sandbox: { providerId: "fake", ref: { sandboxId } },
    storage: { workspaceVolumeId: "vol-1", dataVolumeId: "vol-1" },
    endpointUrl: `http://${sandboxId}.fake.invalid:8787`,
    endpointExpiresAt: new Date(Date.now() + 60_000),
    region: "us-test",
  })
  h.store.imageVersions.set(input.workerId, workerImageVersion)
  h.store.upserts.length = 0
}

async function seedCheckpoint(h: ReturnType<typeof harness>, input: ProvisionInput) {
  await h.provider.storage.ensureVolume("den-cloud-workers", { timeoutMs: 1_000 })
  h.provider.fake.writeVolumeFile("den-cloud-workers", `workers/${input.workerId}/data/checkpoints/ckpt-1.tar`)
  h.provider.fake.calls.length = 0
}

describe("Cloud runtime health deadline", () => {
  test("aborts a hung health request within the remaining readiness budget", async () => {
    let aborted = false
    const provider = createFakeProvider({ image: { id: imageVersion, version: imageVersion } })
    const orchestrator = createCloudRuntimeOrchestrator({
      provider,
      store: createInMemoryRuntimeInstanceStore(),
      config: config({ healthcheckTimeoutMs: 20 }),
      logger: { warn: () => undefined },
      fetch: (_url, init) => new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (!signal) {
          reject(new Error("health request did not receive an abort signal"))
          return
        }
        const onAbort = () => {
          aborted = true
          reject(signal.reason)
        }
        if (signal.aborted) onAbort()
        else signal.addEventListener("abort", onAbort, { once: true })
      }),
      sleep: async () => undefined,
    })
    const startedAt = Date.now()

    const failure = await orchestrator.provision(provisionInput()).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(CloudRuntimeError)
    expect((failure as CloudRuntimeError).code).toBe("runtime_health_timeout")
    expect((failure as CloudRuntimeError).message).toContain("Timed out waiting for Cloud runtime health")
    expect(aborted).toBe(true)
    expect(Date.now() - startedAt).toBeLessThan(500)
  })

  test("surfaces a bootstrap that exited instead of waiting out the deadline", async () => {
    const h = harness({
      health: () => false,
      provider: {
        onExec: ({ spec }) => (spec.detach ? { exitCode: 1, stderr: "opencode binary missing" } : { exitCode: 0 }),
      },
    })

    const failure = await h.orchestrator.provision(provisionInput()).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(CloudRuntimeError)
    expect((failure as CloudRuntimeError).code).toBe("runtime_start_failed")
    expect((failure as CloudRuntimeError).message).toContain("openwork session exited with 1")
    expect((failure as CloudRuntimeError).message).toContain("opencode binary missing")
    expect(h.store.upserts).toHaveLength(0)
  })
})

describe("Cloud runtime provisioning adoption", () => {
  test.each([legacyVersionedName, legacyName])("adopts legacy instance %s through an owner-scoped list after a create conflict", async (name) => {
    const input = provisionInput()
    let existingId = ""
    const h = harness({
      onOperation: (operation) => {
        if (operation.name === "create" && operation.attempt === 1) {
          h.provider.fake.setVisible(existingId, true)
          throw conflict()
        }
      },
    })
    existingId = h.provider.fake.seed({ idempotencyKey: name, state: "stopped", labels: ownerLabels(input), hidden: true }).id
    const find = spyOn(h.provider, "find")
    const list = spyOn(h.provider, "list")

    const result = await h.orchestrator.provision(input)

    const lookupNames = instanceLookupNames(prefix, input, imageVersion)
    expect(find.mock.calls).toEqual([...lookupNames, ...lookupNames].map((idempotencyKey) => [{ idempotencyKey, labels: ownerLabels(input) }]))
    expect(list.mock.calls).toEqual([[{ labels: ownerLabels(input) }], [{ labels: ownerLabels(input) }]])
    expect(result.status).toBe("healthy")
    expect(result.imageVersion).toBe(imageVersion)
    expect(result.url).toBe(`http://${existingId}.fake.invalid:8787`)
    expect(h.provider.fake.count("create")).toBe(1)
    expect(h.provider.fake.count("start", existingId)).toBe(1)
    expect(h.provider.fake.count("destroy")).toBe(0)
    expect(h.healthChecks).toHaveLength(1)
    expect(h.store.upserts).toHaveLength(1)
    expect(h.store.upserts[0]?.sandbox).toEqual({ providerId: "fake", ref: { sandboxId: existingId } })
  })

  test.each([currentName(provisionInput()), legacyVersionedName, legacyName])("rechecks a create conflict for %s through the host's read-after-write window", async (name) => {
    const input = provisionInput()
    let existingId = ""
    let currentLookups = 0
    const h = harness({
      onOperation: (operation) => {
        if (operation.name === "create") throw conflict()
        if (operation.name === "find" && operation.idempotencyKey === currentName(input)) {
          currentLookups += 1
          if (currentLookups === 7) h.provider.fake.setVisible(existingId, true)
        }
      },
    })
    existingId = h.provider.fake.seed({ idempotencyKey: name, state: "running", labels: ownerLabels(input), hidden: true }).id

    const result = await h.orchestrator.provision(input)

    expect(result.status).toBe("healthy")
    expect(h.provider.fake.count("create")).toBe(1)
    expect(h.provider.fake.count("list")).toBe(name === currentName(input) ? 6 : 7)
    expect(h.provider.fake.calls).not.toContain(`find:${legacyVersionedName}`)
    expect(h.provider.fake.calls).not.toContain(`find:${legacyName}`)
    expect(currentLookups).toBe(7)
    expect(h.sleeps).toEqual([2_000, 2_000, 2_000, 2_000, 2_000])
    expect(h.store.upserts[0]?.sandbox.ref.sandboxId).toBe(existingId)
    expect(h.provider.fake.count("stop", existingId)).toBe(1)
    expect(h.provider.fake.count("start", existingId)).toBe(1)
  })

  test("bounds create-conflict rechecks when the instance stays missing", async () => {
    const input = provisionInput()
    const h = harness({
      onOperation: (operation) => {
        if (operation.name === "create") throw conflict()
      },
    })

    await expect(h.orchestrator.provision(input)).rejects.toThrow("Sandbox with name already exists")

    expect(h.provider.fake.count("create")).toBe(1)
    expect(h.provider.fake.calls.filter((call) => call === `find:${currentName(input)}`)).toHaveLength(7)
    expect(h.provider.fake.calls.filter((call) => call === `find:${baseInstanceName(prefix, input)}`)).toHaveLength(7)
    expect(h.provider.fake.calls).not.toContain(`find:${legacyVersionedName}`)
    expect(h.provider.fake.calls).not.toContain(`find:${legacyName}`)
    expect(h.provider.fake.calls.filter((call) => call.startsWith("list:"))).toEqual(Array(7).fill(`list:${JSON.stringify(ownerLabels(input))}`))
    expect(h.sleeps).toEqual([2_000, 2_000, 2_000, 2_000, 2_000])
    expect(h.store.upserts).toHaveLength(0)
  })

  test("creates a new instance when the deterministic name is unused", async () => {
    const input = provisionInput()
    const h = harness()

    const result = await h.orchestrator.provision(input)

    const createdId = h.sandboxIdOf(currentName(input))
    expect(result.status).toBe("healthy")
    expect(result.imageVersion).toBe(imageVersion)
    expect(result.provider).toBe("fake")
    expect(createdId).not.toBeNull()
    expect(h.provider.fake.count("create")).toBe(1)
    expect(h.provider.fake.count("start")).toBe(0)
    expect(h.provider.fake.count("destroy")).toBe(0)
    expect(h.store.upserts).toHaveLength(1)
    expect(h.store.upserts[0]?.sandbox.ref.sandboxId).toBe(createdId)
    expect(h.store.upserts[0]?.storage).toEqual({ workspaceVolumeId: "vol-1", dataVolumeId: "vol-1" })
    const created = h.provider.fake.sandbox(currentName(input))
    expect(created?.spec.labels).toEqual({ "openwork.den.provider": "fake", "openwork.den.worker-id": input.workerId })
    expect(created?.spec.env).toEqual({ DEN_WORKER_ID: input.workerId, DEN_RUNTIME_PROVIDER: "fake" })
    expect(created?.spec.storage.map((attachment) => attachment.subpath)).toEqual([
      `workers/${input.workerId}/workspace`,
      `workers/${input.workerId}/data`,
    ])
    const bootstrap = created?.execs[0]?.spec
    expect(bootstrap?.command).toBeUndefined()
    expect(bootstrap?.script).toStartWith("set -u\n")
    expect(bootstrap?.script).toContain("openwork-server --workspace")
    expect(bootstrap?.script).not.toContain("sh -lc")
    expect(bootstrap).toMatchObject({ detach: true, timeoutMs: config().createTimeoutMs })
    for (const token of [input.clientToken, input.hostToken, input.activityToken]) {
      expect(bootstrap?.script).toContain(token)
      expect(JSON.stringify(created?.spec)).not.toContain(token)
      expect(JSON.stringify(h.execs.map((spec) => spec.command))).not.toContain(token)
    }
  })

  test("isolates workers sharing the same name and ID prefix while keeping retries idempotent", async () => {
    const version = "snapshot-".repeat(20)
    const h = harness({ config: { instanceNamePrefix: prefix.repeat(10) }, provider: { image: { id: version, version } } })
    const first = { ...provisionInput(), workerId: workerIds[0] }
    const second = { ...provisionInput(), workerId: workerIds[1] }

    const firstResult = await h.orchestrator.provision(first)
    const secondResult = await h.orchestrator.provision(second)
    const retried = await h.orchestrator.provision({ ...first, name: "Renamed workspace" })

    expect(first.workerId.slice(0, 12)).toBe(second.workerId.slice(0, 12))
    expect(firstResult.url).not.toBe(secondResult.url)
    expect(retried.url).toBe(firstResult.url)
    expect(h.provider.fake.count("create")).toBe(2)
    expect(h.store.upserts.map((record) => record.workerId)).toEqual([first.workerId, second.workerId, first.workerId])
    const secondSandbox = h.provider.fake.sandbox(h.orchestrator.instanceName(second))!
    expect(h.provider.fake.count("stop", secondSandbox.id)).toBe(0)
    expect(h.provider.fake.count("start", secondSandbox.id)).toBe(0)
    expect(secondSandbox.execs).toHaveLength(1)
  })

  const rejectedLabels: Array<[string, Record<string, string>]> = [
    ["foreign worker", { "openwork.den.provider": "fake", "openwork.den.worker-id": workerIds[1] }],
    ["missing worker", { "openwork.den.provider": "fake" }],
    ["foreign provider", { "openwork.den.provider": "other", "openwork.den.worker-id": workerIds[0] }],
    ["missing provider", { "openwork.den.worker-id": workerIds[0] }],
    ["unlabelled", {}],
  ]
  test.each(rejectedLabels)("never adopts %s name matches, including after a create conflict", async (_description, labels) => {
    const input = { ...provisionInput(), workerId: workerIds[0] }
    for (const hiddenUntilCreate of [false, true]) {
      const h = harness({
        onOperation: (operation) => {
          if (operation.name === "create") {
            for (const sandbox of existing) h.provider.fake.setVisible(sandbox.id, true)
          }
        },
      })
      const lookupNames = instanceLookupNames(prefix, input, imageVersion)
      const legacyNames = legacyInstanceNamesForLocalMatch(prefix, input, imageVersion)
      const existing = [...lookupNames, ...legacyNames].map((idempotencyKey) => h.provider.fake.seed({
        idempotencyKey, state: "running", labels, hidden: hiddenUntilCreate,
      }))

      await expect(h.orchestrator.provision(input)).rejects.toThrow("already exists")

      for (const sandbox of existing) {
        const operations: FakeOperation["name"][] = ["stop", "start", "exec", "endpoint", "destroy"]
        for (const operation of operations) {
          expect(h.provider.fake.count(operation, sandbox.id)).toBe(0)
        }
        expect(sandbox.state).toBe("running")
        expect(sandbox.execs).toHaveLength(0)
        expect(h.provider.fake.calls.filter((call) => call === `find:${sandbox.spec.idempotencyKey}`)).toHaveLength(lookupNames.includes(sandbox.spec.idempotencyKey) ? 7 : 0)
      }
      expect(h.provider.fake.count("create")).toBe(1)
      expect(h.provider.fake.calls.filter((call) => call.startsWith("list:"))).toEqual(Array(7).fill(`list:${JSON.stringify(ownerLabels(input))}`))
      expect(h.healthChecks).toHaveLength(0)
      expect(h.store.upserts).toHaveLength(0)
      expect(await h.store.get(input.workerId)).toBeNull()
    }
  })

  test.each([false, true])("never adopts other image versions or arbitrary owner-labelled names (create conflict: %s)", async (createConflict) => {
    const input = provisionInput()
    const h = harness({
      onOperation: (operation) => {
        if (createConflict && operation.name === "create") throw conflict()
      },
    })
    const existing = [
      `${legacyName}-openwork-0-18-7`,
      instanceNameForImageVersion(prefix, input, previousImageVersion),
      "unrelated-instance",
    ].map((idempotencyKey) => h.provider.fake.seed({ idempotencyKey, state: "running", labels: ownerLabels(input) }))

    if (createConflict) {
      await expect(h.orchestrator.provision(input)).rejects.toThrow("Sandbox with name already exists")
      expect(h.store.upserts).toHaveLength(0)
      expect(h.sleeps).toEqual([2_000, 2_000, 2_000, 2_000, 2_000])
    } else {
      const result = await h.orchestrator.provision(input)
      expect(result.status).toBe("healthy")
      expect(h.store.upserts[0]?.sandbox.ref.sandboxId).toBe(h.sandboxIdOf(currentName(input)))
    }

    for (const sandbox of existing) {
      const operations: FakeOperation["name"][] = ["stop", "start", "exec", "endpoint", "destroy"]
      for (const operation of operations) {
        expect(h.provider.fake.count(operation, sandbox.id)).toBe(0)
      }
      expect(sandbox.state).toBe("running")
      expect(sandbox.execs).toHaveLength(0)
    }
    expect(h.provider.fake.calls.filter((call) => call.startsWith("create:"))).toEqual([`create:${currentName(input)}`])
    expect(h.provider.fake.calls.filter((call) => call.startsWith("list:"))).toEqual(
      Array(createConflict ? 7 : 1).fill(`list:${JSON.stringify(ownerLabels(input))}`),
    )
  })

  test("a one-second endpoint is already unsafe after issuance and a delayed health wait", async () => {
    const input = provisionInput()
    let now = 1_000
    let mintedAt = 0
    const h = harness({
      config: { endpointTtlSeconds: 1 },
      now: () => now,
      onOperation: (operation) => {
        if (operation.name === "endpoint") mintedAt = now
      },
      health: () => {
        now += 30_000
        return true
      },
    })

    await h.orchestrator.provision(input)

    const refreshAt = h.store.upserts[0]?.endpointExpiresAt.getTime()
    expect(mintedAt).toBeGreaterThan(0)
    expect(refreshAt).toBeLessThanOrEqual(mintedAt)
  })

  test("does not destroy an adopted instance when starting it fails", async () => {
    const input = provisionInput()
    const h = harness({
      onOperation: (operation) => {
        if (operation.name === "start") throw new Error("start failed")
      },
    })
    const existing = h.provider.fake.seed({ idempotencyKey: legacyName, state: "stopped", labels: ownerLabels(input) })

    await expect(h.orchestrator.provision(input)).rejects.toThrow("start failed")

    expect(h.provider.fake.count("create")).toBe(0)
    expect(h.provider.fake.count("start", existing.id)).toBe(1)
    expect(h.provider.fake.count("destroy")).toBe(0)
    expect(h.store.upserts).toHaveLength(0)
  })
})

describe("Cloud runtime version-aware recycle", () => {
  test("recycles a stale stopped instance with a checkpoint into a version-qualified replacement", async () => {
    const input = provisionInput()
    const h = harness({
      onOperation: (operation) => {
        if (operation.name === "destroy" && operation.sandboxId === old.id) {
          expect(h.restoreMarkerChecks()).toBe(1)
          expect(h.store.upserts[0]?.sandbox.ref.sandboxId).toBe(h.sandboxIdOf(currentName(input)))
        }
      },
    })
    const old = h.provider.fake.seed({ idempotencyKey: "sbx-old-name", state: "stopped" })
    await seedRecord(h, input, old.id, previousImageVersion)
    await seedCheckpoint(h, input)

    const result = await h.orchestrator.wake(input)

    const replacementId = h.sandboxIdOf(currentName(input))
    expect(result.status).toBe("healthy")
    expect(result.imageVersion).toBe(imageVersion)
    expect(h.provider.fake.count("create")).toBe(1)
    expect(replacementId).not.toBeNull()
    expect(h.checkpointChecks()).toBe(1)
    expect(h.restoreMarkerChecks()).toBe(1)
    expect(h.store.upserts).toHaveLength(1)
    expect(h.store.upserts[0]?.sandbox.ref.sandboxId).toBe(replacementId)
    expect(h.provider.fake.count("start", old.id)).toBe(0)
    expect(h.provider.fake.count("destroy", old.id)).toBe(1)
    expect(h.provider.fake.count("destroy", replacementId ?? "")).toBe(0)
  })

  test("restarts rather than duplicates the process on a stale running instance", async () => {
    const input = provisionInput()
    const h = harness()
    const old = h.provider.fake.seed({ idempotencyKey: "sbx-running", state: "running" })
    await seedRecord(h, input, old.id, previousImageVersion)
    await seedCheckpoint(h, input)

    const result = await h.orchestrator.wake(input)

    expect(result.status).toBe("healthy")
    expect(result.imageVersion).toBe(previousImageVersion)
    expect(h.provider.fake.count("create")).toBe(0)
    expect(h.checkpointChecks()).toBe(0)
    expect(h.stopFlushes()).toBe(1)
    expect(h.provider.fake.calls.indexOf(`exec:${old.id}`)).toBeLessThan(h.provider.fake.calls.indexOf(`stop:${old.id}`))
    expect(h.provider.fake.count("stop", old.id)).toBe(1)
    expect(h.provider.fake.count("start", old.id)).toBe(1)
    expect(h.provider.fake.count("destroy", old.id)).toBe(0)
    expect(h.store.upserts[0]?.sandbox.ref.sandboxId).toBe(old.id)
  })

  test("a failed flush never blocks the restart of an untrusted running instance", async () => {
    const input = provisionInput()
    const h = harness({
      provider: {
        onExec: ({ spec }) => spec.detach
          ? { exitCode: null }
          : spec.command?.includes("flush_checkpoint") ? { exitCode: 1, stderr: "checkpoint flush tar failed" } : { exitCode: 0 },
      },
    })
    const old = h.provider.fake.seed({ idempotencyKey: "sbx-running-flush-fails", state: "running" })
    await seedRecord(h, input, old.id, previousImageVersion)

    const result = await h.orchestrator.wake(input)

    const flushes = h.provider.fake.sandboxes().find((record) => record.id === old.id)?.execs
      .filter((exec) => !exec.spec.detach && exec.spec.command?.includes("flush_checkpoint")) ?? []
    expect(result.status).toBe("healthy")
    expect(flushes).toHaveLength(1)
    expect(flushes[0]?.result.exitCode).toBe(1)
    expect(h.provider.fake.count("stop", old.id)).toBe(1)
    expect(h.provider.fake.count("start", old.id)).toBe(1)
    expect(h.warnings.some((warning) => warning.includes("checkpoint flush before stop"))).toBe(true)
  })

  test("replaces an unrecoverable running instance when a checkpoint can restore it", async () => {
    const input = provisionInput()
    const h = harness({
      onOperation: (operation) => {
        if (operation.name === "stop" && operation.attempt === 1) throw new Error("provider refused sandbox stop")
      },
    })
    const old = h.provider.fake.seed({ idempotencyKey: "sbx-unrecoverable", state: "running" })
    await seedRecord(h, input, old.id, imageVersion)
    await seedCheckpoint(h, input)

    const result = await h.orchestrator.wake(input)

    const replacement = h.provider.fake.sandboxes().find((record) => record.id !== old.id)
    expect(result.status).toBe("healthy")
    expect(h.provider.fake.count("create")).toBe(1)
    expect(replacement?.spec.idempotencyKey).toBe(recoveryInstanceName(prefix, input, imageVersion, "abcd1234"))
    expect(h.checkpointChecks()).toBe(1)
    expect(h.restoreMarkerChecks()).toBe(1)
    expect(h.provider.fake.count("stop", old.id)).toBe(1)
    expect(h.provider.fake.count("destroy", old.id)).toBe(1)
    expect(h.provider.fake.count("destroy", replacement?.id ?? "")).toBe(0)
    expect(h.store.upserts[0]?.sandbox.ref.sandboxId).toBe(replacement?.id)
  })

  test("does not destroy an established workspace when failed wake has no checkpoint", async () => {
    const input = provisionInput()
    const wakeError = new Error("provider refused sandbox stop")
    const h = harness({
      onOperation: (operation) => {
        if (operation.name === "stop") throw wakeError
      },
    })
    const old = h.provider.fake.seed({ idempotencyKey: "sbx-no-checkpoint", state: "running" })
    await seedRecord(h, input, old.id, imageVersion)
    await h.provider.storage.ensureVolume("den-cloud-workers", { timeoutMs: 1_000 })

    await expect(h.orchestrator.wake(input)).rejects.toBe(wakeError)

    expect(h.checkpointChecks()).toBe(1)
    expect(h.provider.fake.count("create")).toBe(0)
    expect(h.provider.fake.count("destroy", old.id)).toBe(0)
  })

  test("replaces a never-healthy instance even before its first checkpoint", async () => {
    const input = provisionInput()
    const h = harness({
      onOperation: (operation) => {
        if (operation.name === "stop" && operation.attempt === 1) throw new Error("provider refused sandbox stop")
      },
    })
    const old = h.provider.fake.seed({ idempotencyKey: "sbx-initial-failure", state: "running" })
    await seedRecord(h, input, old.id, null)

    const result = await h.orchestrator.wake(input)

    const replacement = h.provider.fake.sandboxes().find((record) => record.id !== old.id)
    expect(result.status).toBe("healthy")
    expect(h.provider.fake.count("create")).toBe(1)
    expect(h.restoreMarkerChecks()).toBe(0)
    expect(h.provider.fake.count("destroy", old.id)).toBe(1)
    expect(h.store.upserts[0]?.sandbox.ref.sandboxId).toBe(replacement?.id)
  })

  test("does not recycle a stale stopped instance before a checkpoint exists", async () => {
    const input = provisionInput()
    const h = harness()
    const old = h.provider.fake.seed({ idempotencyKey: "sbx-stale-no-checkpoint", state: "stopped" })
    await seedRecord(h, input, old.id, previousImageVersion)
    await h.provider.storage.ensureVolume("den-cloud-workers", { timeoutMs: 1_000 })

    const result = await h.orchestrator.wake(input)

    expect(result.status).toBe("healthy")
    expect(result.imageVersion).toBe(previousImageVersion)
    expect(h.provider.fake.count("create")).toBe(0)
    expect(h.checkpointChecks()).toBe(1)
    expect(h.provider.fake.count("start", old.id)).toBe(1)
    expect(h.provider.fake.count("destroy", old.id)).toBe(0)
    expect(h.store.upserts[0]?.sandbox.ref.sandboxId).toBe(old.id)
  })

  test("destroys a failed replacement, keeps the old instance, and wakes the old instance", async () => {
    const input = provisionInput()
    const h = harness({ restoreMarkerVerified: false })
    const old = h.provider.fake.seed({ idempotencyKey: "sbx-old-safe", state: "stopped" })
    await seedRecord(h, input, old.id, previousImageVersion)
    await seedCheckpoint(h, input)

    const result = await h.orchestrator.wake(input)

    const replacement = h.provider.fake.sandboxes().find((record) => record.id !== old.id)
    expect(result.status).toBe("healthy")
    expect(result.imageVersion).toBe(previousImageVersion)
    expect(h.provider.fake.count("create")).toBe(1)
    expect(h.restoreMarkerChecks()).toBe(1)
    expect(h.healthChecks).toHaveLength(2)
    expect(h.provider.fake.count("destroy", replacement?.id ?? "")).toBe(1)
    expect(h.provider.fake.count("destroy", old.id)).toBe(0)
    expect(h.provider.fake.count("start", old.id)).toBe(1)
    expect(h.store.upserts).toHaveLength(1)
    expect(h.store.upserts[0]?.sandbox.ref.sandboxId).toBe(old.id)
    expect(h.warnings).toContain("instance recycle failed; waking existing instance")
  })

  test("stops the old instance before a second bootstrap after endpoint and replacement creation failures", async () => {
    const input = provisionInput()
    const h = harness({
      onOperation: (operation) => {
        if (operation.name === "endpoint" && operation.attempt === 1) throw new Error("endpoint unavailable")
        if (operation.name === "create") throw new Error("replacement creation failed")
      },
    })
    const old = h.provider.fake.seed({ idempotencyKey: "sbx-recovery-fallback", state: "stopped" })
    await seedRecord(h, input, old.id, imageVersion)
    const storage = { workspaceVolumeId: "vol-old-workspace", dataVolumeId: "vol-old-data" }
    h.store.records.get(input.workerId)!.storage = storage
    await seedCheckpoint(h, input)

    const result = await h.orchestrator.wake(input)

    expect(h.provider.fake.calls.filter((call) => /^(start|stop|exec):/.test(call))).toEqual([
      `start:${old.id}`,
      `exec:${old.id}`,
      // The checkpoint flush that precedes every stop of a running instance.
      `exec:${old.id}`,
      `stop:${old.id}`,
      `start:${old.id}`,
      `exec:${old.id}`,
    ])
    expect(h.stopFlushes()).toBe(1)
    expect(result.status).toBe("healthy")
    expect(result.imageVersion).toBe(imageVersion)
    expect(h.provider.fake.count("create")).toBe(1)
    expect(h.provider.fake.count("destroy")).toBe(0)
    expect(h.provider.fake.count("endpoint", old.id)).toBe(2)
    expect(h.healthChecks).toHaveLength(1)
    expect(h.store.upserts).toHaveLength(1)
    expect(h.store.upserts[0]?.sandbox.ref.sandboxId).toBe(old.id)
    expect(h.store.upserts[0]?.storage).toEqual(storage)
  })

  test("keeps the same-version stopped instance on the normal wake path", async () => {
    const input = provisionInput()
    const h = harness()
    const old = h.provider.fake.seed({ idempotencyKey: "sbx-current", state: "stopped" })
    await seedRecord(h, input, old.id, imageVersion)
    await seedCheckpoint(h, input)

    const result = await h.orchestrator.wake(input)

    expect(result.status).toBe("healthy")
    expect(result.imageVersion).toBe(imageVersion)
    expect(h.provider.fake.count("create")).toBe(0)
    expect(h.checkpointChecks()).toBe(0)
    expect(h.provider.fake.count("start", old.id)).toBe(1)
    expect(h.provider.fake.count("inspect", old.id)).toBe(1)
    expect(h.provider.fake.count("endpoint", old.id)).toBe(1)
    expect(h.healthChecks).toHaveLength(1)
    expect(h.provider.fake.count("destroy", old.id)).toBe(0)
    expect(h.store.upserts[0]?.sandbox.ref.sandboxId).toBe(old.id)
  })

  test("reports a missing instance so the caller can fall back to provisioning", async () => {
    const input = provisionInput()
    const h = harness()

    const noRecord = await h.orchestrator.wake(input).catch((error: unknown) => error)
    expect(isCloudRuntimeInstanceMissingError(noRecord)).toBe(true)

    await seedRecord(h, input, "sbx-gone", imageVersion)
    const noInstance = await h.orchestrator.wake(input).catch((error: unknown) => error)
    expect(isCloudRuntimeInstanceMissingError(noInstance)).toBe(true)
    expect(h.provider.fake.count("create")).toBe(0)
  })
})

describe("Cloud runtime wake start convergence", () => {
  test("converges when a state-change conflict is already starting the instance", async () => {
    const input = provisionInput()
    let sandboxId = ""
    const h = harness({
      onOperation: (operation) => {
        if (operation.name === "start" && operation.attempt === 1) {
          throw new RuntimeProviderError({ providerId: "fake", code: "invalid_state", message: "Sandbox state change in progress" })
        }
        if (operation.name === "inspect" && operation.attempt === 3) {
          h.provider.fake.setState(sandboxId, "running")
        }
      },
    })
    sandboxId = h.provider.fake.seed({ idempotencyKey: "sbx-conflict-start", state: "stopped" }).id
    await seedRecord(h, input, sandboxId, imageVersion)

    const result = await h.orchestrator.wake(input)

    expect(result.status).toBe("healthy")
    expect(h.provider.fake.count("start", sandboxId)).toBe(1)
    expect(h.provider.fake.count("inspect", sandboxId)).toBe(3)
    expect(h.healthChecks).toHaveLength(1)
    expect(h.store.upserts[0]?.sandbox.ref.sandboxId).toBe(sandboxId)
  })

  test("retries a transient host failure during start before waking the instance", async () => {
    const input = provisionInput()
    const h = harness({
      onOperation: (operation) => {
        if (operation.name === "start" && operation.attempt === 1) {
          throw new RuntimeProviderError({ providerId: "fake", code: "transient", message: "Request failed with status code 502" })
        }
      },
    })
    const sandbox = h.provider.fake.seed({ idempotencyKey: "sbx-transient-start", state: "stopped" })
    await seedRecord(h, input, sandbox.id, imageVersion)

    const result = await h.orchestrator.wake(input)

    expect(result.status).toBe("healthy")
    expect(h.provider.fake.count("start", sandbox.id)).toBe(2)
    expect(h.sleeps).toContain(250)
    expect(h.healthChecks).toHaveLength(1)
    expect(h.store.upserts[0]?.sandbox.ref.sandboxId).toBe(sandbox.id)
  })

  test("bounds persistent transient start failures", async () => {
    const input = provisionInput()
    const h = harness({
      onOperation: (operation) => {
        if (operation.name === "start") {
          throw new RuntimeProviderError({ providerId: "fake", code: "transient", message: "Request failed with status code 502" })
        }
      },
    })
    const sandbox = h.provider.fake.seed({ idempotencyKey: "sbx-persistent-start-failure", state: "stopped" })
    await seedRecord(h, input, sandbox.id, imageVersion)

    await expect(h.orchestrator.wake(input)).rejects.toThrow("Request failed with status code 502")

    expect(h.provider.fake.count("start", sandbox.id)).toBe(3)
    expect(h.healthChecks).toHaveLength(0)
    expect(h.store.upserts).toHaveLength(0)
  })
})

describe("Cloud runtime instance name lookup", () => {
  test.each([prefix, "Very_Long_Prefix-".repeat(20), "---"])("reserves the worker identity and lifecycle tags with prefix %s", (namePrefix) => {
    const version = "snapshot-".repeat(20)
    const suffix = "recovery-".repeat(20)
    const names: string[] = []
    for (const workerId of workerIds) {
      const input = { workerId, name: "Cloud" }
      const identity = createHash("sha256").update(workerId).digest("hex").slice(0, 32)
      for (const image of [null, version, `${version}next`]) {
        const current = currentInstanceName(namePrefix, input, image)
        const recovery = recoveryInstanceName(namePrefix, input, image, suffix)
        const imageTag = image ? `-v${createHash("sha256").update(image).digest("hex").slice(0, 8)}` : ""
        expect(current).toBe(currentInstanceName(namePrefix, { ...input, name: "Private workspace name" }, image))
        expect(recovery).toBe(recoveryInstanceName(namePrefix, { ...input, name: "Private workspace name" }, image, suffix))
        expect(recovery).not.toBe(recoveryInstanceName(namePrefix, input, image, `${suffix}next`))
        expect(current).toEndWith(`${identity}${imageTag}`)
        expect(recovery).toMatch(new RegExp(`${identity}${imageTag}-r[0-9a-f]{8}$`))
        for (const name of [current, recovery]) {
          expect(name.length).toBeLessThanOrEqual(63)
          expect(name).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
          expect(name).toContain(identity)
          names.push(name)
        }
      }
      expect(baseInstanceName(namePrefix, input)).toBe(currentInstanceName(namePrefix, input, null))
    }
    expect(new Set(names).size).toBe(names.length)
  })

  test("keeps lookup names opaque and preserves legacy computations only for local matching", () => {
    const input = provisionInput()
    const renamed = { ...input, name: "Private workspace title" }
    expect(instanceLookupNames(prefix, input, imageVersion)).toEqual([currentName(input), baseInstanceName(prefix, input)])
    expect(instanceLookupNames(prefix, input, null)).toEqual([baseInstanceName(prefix, input)])
    expect(instanceLookupNames(prefix, renamed, imageVersion)).toEqual(instanceLookupNames(prefix, input, imageVersion))
    expect(instanceLookupNames(prefix, renamed, null)).toEqual(instanceLookupNames(prefix, input, null))
    expect(legacyInstanceNamesForLocalMatch(prefix, input, imageVersion)).toEqual([legacyVersionedName, legacyName])
    expect(legacyInstanceNamesForLocalMatch(prefix, input, null)).toEqual([legacyName])
    const longPrefix = "p".repeat(100)
    expect(instanceLookupNames(longPrefix, input, "v".repeat(100))).toEqual([
      instanceNameForImageVersion(longPrefix, input, "v".repeat(100)),
      baseInstanceName(longPrefix, input),
    ])
    expect(legacyInstanceNamesForLocalMatch(longPrefix, input, "v".repeat(100))).toEqual([
      `${"p".repeat(38)}-${"v".repeat(24)}`,
      "p".repeat(63),
    ])
  })

  test.each([0, 1, 2, 3])("preserves lookup priority independently of list order (first available candidate: %s)", async (firstAvailable) => {
    const input = provisionInput()
    const lookupNames = instanceLookupNames(prefix, input, imageVersion)
    const names = [...lookupNames, ...legacyInstanceNamesForLocalMatch(prefix, input, imageVersion)]
    for (const createConflict of [false, true]) {
      const h = harness({
        onOperation: (operation) => {
          if (createConflict && operation.name === "create") {
            for (const sandbox of existing) h.provider.fake.setVisible(sandbox.id, true)
            throw conflict()
          }
        },
      })
      const existing = names.slice(firstAvailable).reverse().map((idempotencyKey) => h.provider.fake.seed({
        idempotencyKey, state: "stopped", labels: ownerLabels(input), hidden: createConflict,
      }))

      await h.orchestrator.provision(input)

      const selected = existing.find((sandbox) => sandbox.spec.idempotencyKey === names[firstAvailable])!
      const expectedLookups = [
        ...(createConflict ? lookupNames : []),
        ...lookupNames.slice(0, firstAvailable === 0 ? 1 : 2),
      ]
      expect(h.provider.fake.calls.filter((call) => call.startsWith("find:"))).toEqual(expectedLookups.map((name) => `find:${name}`))
      expect(h.provider.fake.count("list")).toBe((createConflict ? 1 : 0) + (firstAvailable >= 2 ? 1 : 0))
      expect(h.provider.fake.count("create")).toBe(createConflict ? 1 : 0)
      expect(h.store.upserts[0]?.sandbox).toEqual({ providerId: "fake", ref: { sandboxId: selected.id } })
      expect(h.provider.fake.count("start", selected.id)).toBe(1)
      expect(h.provider.fake.count("destroy")).toBe(0)
      for (const sandbox of existing.filter((sandbox) => sandbox.id !== selected.id)) {
        expect(h.provider.fake.count("start", sandbox.id)).toBe(0)
        expect(sandbox.execs).toHaveLength(0)
      }
    }
  })

  test.each([imageVersion, null])("adopts owner-scoped fallback names without transmitting display text (image: %s)", async (version) => {
    const input = { ...provisionInput(), name: "Private Workspace Title" }
    const baseName = baseInstanceName(prefix, input)
    for (const name of [baseName, ...legacyInstanceNamesForLocalMatch(prefix, input, version)]) {
      const h = harness({ provider: { image: version ? { id: version, version } : null } })
      const existing = h.provider.fake.seed({ idempotencyKey: name, state: "stopped", labels: ownerLabels(input) })
      const find = spyOn(h.provider, "find")
      const list = spyOn(h.provider, "list")

      await h.orchestrator.provision(input)

      expect(find.mock.calls).toEqual(instanceLookupNames(prefix, input, version).map((idempotencyKey) => [{ idempotencyKey, labels: ownerLabels(input) }]))
      expect(list.mock.calls).toEqual(name === baseName ? [] : [[{ labels: ownerLabels(input) }]])
      const requests = JSON.stringify([...find.mock.calls, ...list.mock.calls])
      expect(requests).not.toContain(input.name)
      expect(requests).not.toContain("private-workspace-title")
      expect(h.store.upserts[0]?.sandbox).toEqual({ providerId: "fake", ref: { sandboxId: existing.id } })
      expect(h.provider.fake.count("create")).toBe(0)
      expect(h.provider.fake.count("start", existing.id)).toBe(1)
    }
  })

  test("exposes the current instance name for operator display", () => {
    const input = provisionInput()
    const h = harness()
    expect(h.orchestrator.instanceName(input)).toBe(currentName(input))
    expect(h.orchestrator.currentImageVersion()).toBe(imageVersion)
    expect(h.orchestrator.providerId).toBe("fake")
  })
})

describe("Cloud runtime instance maintenance", () => {
  test("stop leaves data alone and reports the resulting state", async () => {
    const input = provisionInput()
    const h = harness()
    expect(await h.orchestrator.stop(input.workerId)).toEqual({ status: "no_instance" })

    const running = h.provider.fake.seed({ idempotencyKey: "sbx-stop", state: "running" })
    await seedRecord(h, input, running.id, imageVersion)
    expect(await h.orchestrator.stop(input.workerId)).toEqual({ status: "stopped" })
    expect(h.provider.fake.count("stop", running.id)).toBe(1)
    expect(await h.orchestrator.stop(input.workerId)).toEqual({ status: "stopped" })
    expect(h.provider.fake.count("stop", running.id)).toBe(1)
    expect(h.provider.fake.count("destroy")).toBe(0)
    expect(h.provider.fake.count("storage.eraseSubpaths")).toBe(0)
  })

  test("inspect reports the host state or null when nothing is live", async () => {
    const input = provisionInput()
    const h = harness()
    expect(await h.orchestrator.inspect(input.workerId)).toBeNull()

    const sandbox = h.provider.fake.seed({ idempotencyKey: "sbx-inspect", state: "stopped" })
    await seedRecord(h, input, sandbox.id, imageVersion)
    expect(await h.orchestrator.inspect(input.workerId)).toEqual({ state: "stopped" })

    h.provider.fake.setState(sandbox.id, "missing")
    expect(await h.orchestrator.inspect(input.workerId)).toBeNull()
  })

  test("refreshEndpoint stores the new endpoint with its safety margin applied", async () => {
    const input = provisionInput()
    let now = 10_000
    const h = harness({ now: () => now, config: { endpointTtlSeconds: 3_600, endpointRefreshLeadMs: 300_000 } })
    const sandbox = h.provider.fake.seed({ idempotencyKey: "sbx-refresh", state: "running" })
    await seedRecord(h, input, sandbox.id, imageVersion)

    const refreshed = await h.orchestrator.refreshEndpoint(input.workerId)

    expect(refreshed?.endpointUrl).toBe(`http://${sandbox.id}.fake.invalid:8787`)
    expect(refreshed?.endpointExpiresAt.getTime()).toBe(now + 3_600_000 - 300_000)
    expect((await h.store.get(input.workerId))?.endpointExpiresAt.getTime()).toBe(now + 3_600_000 - 300_000)
    expect(await h.orchestrator.refreshEndpoint("worker_unknown")).toBeNull()
  })

  test("flushCheckpoint runs the flush command and reports its exit code", async () => {
    const input = provisionInput()
    const h = harness()
    expect(await h.orchestrator.flushCheckpoint(input.workerId)).toBe(false)

    const sandbox = h.provider.fake.seed({ idempotencyKey: "sbx-flush", state: "running" })
    await seedRecord(h, input, sandbox.id, imageVersion)
    expect(await h.orchestrator.flushCheckpoint(input.workerId)).toBe(true)
    const flush = h.execs.find((spec) => !spec.detach)
    expect(flush?.command).toContain("flush_checkpoint")
  })

  test("deprovision destroys the instance and erases only this worker's data", async () => {
    const input = provisionInput()
    const h = harness()
    const sandbox = h.provider.fake.seed({ idempotencyKey: "sbx-deprovision", state: "running" })
    await seedRecord(h, input, sandbox.id, imageVersion)
    await h.provider.storage.ensureVolume("den-cloud-workers", { timeoutMs: 1_000 })
    h.provider.fake.writeVolumeFile("den-cloud-workers", `workers/${input.workerId}/data/checkpoints/ckpt-1.tar`)
    h.provider.fake.writeVolumeFile("den-cloud-workers", "workers/worker_other/data/checkpoints/ckpt-1.tar")

    await h.orchestrator.deprovision(input.workerId)

    expect(h.provider.fake.count("destroy", sandbox.id)).toBe(1)
    expect(Array.from(h.provider.fake.volumeFiles("den-cloud-workers"))).toEqual(["workers/worker_other/data/checkpoints/ckpt-1.tar"])
  })

  test.each(["succeeds", "fails"])("deprovision snapshots every labelled orphan when the first delete %s", async (firstDelete) => {
    const input = provisionInput()
    const h = harness({
      onOperation: (operation) => {
        if (operation.name === "destroy" && operation.sandboxId === first.id && firstDelete === "fails") {
          throw new Error("delete failed")
        }
      },
    })
    const labels = ownerLabels(input)
    const first = h.provider.fake.seed({ idempotencyKey: "orphan-1", state: "stopped", labels })
    const second = h.provider.fake.seed({ idempotencyKey: "orphan-2", state: "running", labels })
    const other = h.provider.fake.seed({ idempotencyKey: "other", state: "running", labels: { ...labels, "openwork.den.worker-id": workerIds[1] } })
    const otherProvider = h.provider.fake.seed({ idempotencyKey: "other-provider", state: "running", labels: { ...labels, "openwork.den.provider": "other" } })
    await seedCheckpoint(h, input)
    h.provider.fake.writeVolumeFile("den-cloud-workers", `workers/${input.workerId}/workspace/file.txt`)
    const otherFile = `workers/${workerIds[1]}/data/checkpoints/ckpt-1.tar`
    h.provider.fake.writeVolumeFile("den-cloud-workers", otherFile)

    await h.orchestrator.deprovision(input.workerId)

    expect(h.provider.fake.count("destroy", first.id)).toBe(1)
    expect(h.provider.fake.count("destroy", second.id)).toBe(1)
    expect(h.provider.fake.count("destroy", other.id)).toBe(0)
    expect(h.provider.fake.count("destroy", otherProvider.id)).toBe(0)
    expect(h.provider.fake.calls.filter((call) => /^(list|find|destroy):/.test(call))).toEqual([
      `list:${JSON.stringify(labels)}`,
      `destroy:${first.id}`,
      `destroy:${second.id}`,
    ])
    expect(first.state).toBe(firstDelete === "fails" ? "stopped" : "missing")
    expect(second.state).toBe("missing")
    expect(other.state).toBe("running")
    expect(otherProvider.state).toBe("running")
    expect(Array.from(h.provider.fake.volumeFiles("den-cloud-workers"))).toEqual([otherFile])
    if (firstDelete === "fails") {
      expect((await h.provider.find({ labels }))?.ref.ref.sandboxId).toBe(first.id)
      expect(h.warnings).toContain("failed to destroy instance")
    }
  })
})
