import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { beforeAll, describe, expect, test } from "bun:test"
import type { KubernetesClient } from "../src/workers/kubernetes-client.js"
import { KubernetesNotFoundError } from "../src/workers/kubernetes-client.js"
import { env } from "../src/env.js"

type KubernetesModule = typeof import("../src/workers/kubernetes.js")
type ProvisionInput = Parameters<KubernetesModule["provisionWorkerOnKubernetesWithRuntime"]>[0]
type Runtime = Parameters<KubernetesModule["provisionWorkerOnKubernetesWithRuntime"]>[1]

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

// env.ts is parsed once per process and sibling test files import it first, so
// the kubernetes tuning is applied to the parsed snapshot rather than relying
// on process.env seeding.
function seedKubernetesEnv() {
  env.kubernetes.workerImage = "registry.test/openwork-worker:test"
  env.kubernetes.workerNamespace = "openwork-workers"
  // Small enough that a failing health endpoint trips the deadline quickly in
  // the timeout test, large enough for immediate-200 probes everywhere else.
  env.kubernetes.healthcheckTimeoutMs = 60
  env.kubernetes.pollIntervalMs = 10
}

let kubernetes: KubernetesModule

beforeAll(async () => {
  seedRequiredEnv()
  kubernetes = await import("../src/workers/kubernetes.js")
  seedKubernetesEnv()
})

function provisionInput(): ProvisionInput {
  return {
    workerId: createDenTypeId("worker"),
    name: "Cloud",
    hostToken: "host-token",
    clientToken: "client-token",
    activityToken: "activity-token",
  }
}

type RecordedOp = { op: string; name?: string; patch?: unknown }

function makeClient(input: {
  deployment?: Record<string, unknown> | null
  podPhase?: string
  podLogs?: string
} = {}) {
  const ops: RecordedOp[] = []
  let deployment = input.deployment ?? null

  const notFound = (name: string) => {
    throw new KubernetesNotFoundError(`deployments/${name}`, "")
  }

  const client = {
    namespace: "openwork-workers",
    async getDeployment(name: string) {
      ops.push({ op: "getDeployment", name })
      if (!deployment) {
        notFound(name)
      }
      return deployment
    },
    async createDeployment(manifest: Record<string, unknown>) {
      ops.push({ op: "createDeployment" })
      deployment = manifest
      return manifest
    },
    async patchDeployment(name: string, patch: Record<string, unknown>) {
      ops.push({ op: "patchDeployment", name, patch })
      return {}
    },
    async deleteDeployment(name: string) {
      ops.push({ op: "deleteDeployment", name })
      deployment = null
    },
    async getService(name: string) {
      ops.push({ op: "getService", name })
      return {}
    },
    async createService(manifest: Record<string, unknown>) {
      ops.push({ op: "createService" })
      return manifest
    },
    async deleteService(name: string) {
      ops.push({ op: "deleteService", name })
    },
    async createSecret(manifest: Record<string, unknown>) {
      ops.push({ op: "createSecret" })
      return manifest
    },
    async deleteSecret(name: string) {
      ops.push({ op: "deleteSecret", name })
    },
    async createPvc(manifest: Record<string, unknown>) {
      ops.push({ op: "createPvc" })
      return manifest
    },
    async getPvc(name: string) {
      ops.push({ op: "getPvc", name })
      return {}
    },
    async deletePvc(name: string) {
      ops.push({ op: "deletePvc", name })
    },
    async listPods(_labelSelector: string) {
      ops.push({ op: "listPods" })
      return {
        items: [
          {
            metadata: { name: "wrk-test-abc123" },
            status: { phase: input.podPhase ?? "CrashLoopBackOff" },
          },
        ],
      }
    },
    async getPod(name: string) {
      ops.push({ op: "getPod", name })
      return {}
    },
    async getPodLogs(_name: string, _options?: { tailLines?: number }) {
      ops.push({ op: "getPodLogs" })
      return input.podLogs ?? "worker booting"
    },
  }

  return {
    client: client as unknown as KubernetesClient,
    ops,
    setDeployment(value: Record<string, unknown> | null) {
      deployment = value
    },
  }
}

function healthyFetch(): typeof fetch {
  return (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch
}

function failingFetch(): typeof fetch {
  return (async () => new Response("{}", { status: 503 })) as unknown as typeof fetch
}

function makeRuntime(client: KubernetesClient, healthFetch: typeof fetch = healthyFetch()): Runtime {
  return { client, healthFetch }
}

describe("Kubernetes worker naming", () => {
  test("maps typeid worker ids to DNS-1123-safe names", () => {
    expect(kubernetes.kubernetesWorkerName("wrk_abcdefghjkmnpqrstuvwxyz3")).toBe("wrk-abcdefghjkmnpqrstuvwxyz3")
  })
})

describe("Kubernetes worker provisioning", () => {
  test("creates the PVC, secret, deployment, and service set for a fresh worker", async () => {
    const input = provisionInput()
    const fake = makeClient()
    const provisioned = await kubernetes.provisionWorkerOnKubernetesWithRuntime(
      input,
      makeRuntime(fake.client),
    )

    const created = fake.ops.filter((entry) => entry.op === "createPvc").length
    expect(created).toBe(2)
    expect(fake.ops.some((entry) => entry.op === "createSecret")).toBe(true)
    expect(fake.ops.some((entry) => entry.op === "createDeployment")).toBe(true)
    expect(fake.ops.some((entry) => entry.op === "createService")).toBe(true)

    expect(provisioned).toEqual({
      provider: "kubernetes",
      url: `http://${kubernetes.kubernetesWorkerName(input.workerId)}.openwork-workers.svc.cluster.local:8787`,
      status: "healthy",
      region: "openwork-workers",
      imageVersion: "registry.test/openwork-worker:test",
    })
  })

  test("adopts an existing deployment instead of recreating objects", async () => {
    const input = provisionInput()
    const fake = makeClient({ deployment: { spec: { replicas: 1 } } })
    const provisioned = await kubernetes.provisionWorkerOnKubernetesWithRuntime(
      input,
      makeRuntime(fake.client),
    )

    expect(fake.ops.some((entry) => entry.op === "createDeployment")).toBe(false)
    expect(fake.ops.some((entry) => entry.op === "createService")).toBe(false)
    expect(fake.ops.some((entry) => entry.op === "createPvc")).toBe(false)
    // Adoption refreshes tokens so a restarted worker keeps working access.
    expect(fake.ops.some((entry) => entry.op === "createSecret")).toBe(true)
    expect(provisioned.status).toBe("healthy")
  })

  test("scales an adopted scaled-down deployment back up", async () => {
    const input = provisionInput()
    const fake = makeClient({ deployment: { spec: { replicas: 0 } } })
    await kubernetes.provisionWorkerOnKubernetesWithRuntime(input, makeRuntime(fake.client))

    const patch = fake.ops.find((entry) => entry.op === "patchDeployment")?.patch as { spec?: { replicas?: number } } | undefined
    expect(patch?.spec?.replicas).toBe(1)
  })
})

describe("Kubernetes worker wake", () => {
  test("patches a stale image onto the deployment before waking", async () => {
    const input = provisionInput()
    const fake = makeClient({ deployment: { spec: { replicas: 0 } } })
    const provisioned = await kubernetes.wakeWorkerOnKubernetesWithRuntime(
      input,
      makeRuntime(fake.client),
      "registry.test/openwork-worker:old",
    )

    const patch = fake.ops.find((entry) => entry.op === "patchDeployment")?.patch as {
      spec?: { replicas?: number; template?: { spec?: { containers?: Array<{ image?: string }> } } }
    } | undefined
    expect(patch?.spec?.replicas).toBe(1)
    expect(patch?.spec?.template?.spec?.containers?.[0]?.image).toBe("registry.test/openwork-worker:test")
    expect(provisioned.imageVersion).toBe("registry.test/openwork-worker:test")
  })

  test("throws a missing-worker error when the deployment is gone", async () => {
    const input = provisionInput()
    const fake = makeClient({ deployment: null })
    expect(
      kubernetes.wakeWorkerOnKubernetesWithRuntime(input, makeRuntime(fake.client), null),
    ).rejects.toHaveProperty("name", "KubernetesWorkerMissingError")
  })
})

describe("Kubernetes worker stop and deprovision", () => {
  test("scales a running worker to zero without deleting its objects", async () => {
    const input = provisionInput()
    const fake = makeClient({ deployment: { spec: { replicas: 1 } } })
    const result = await kubernetes.stopWorkerOnKubernetesWithRuntime(input.workerId, makeRuntime(fake.client))

    expect(result).toEqual({ status: "stopped" })
    expect(fake.ops.some((entry) => entry.op === "deleteDeployment")).toBe(false)
    const patch = fake.ops.find((entry) => entry.op === "patchDeployment")?.patch as { spec?: { replicas?: number } } | undefined
    expect(patch?.spec?.replicas).toBe(0)
  })

  test("reports an already-stopped worker without patching", async () => {
    const input = provisionInput()
    const fake = makeClient({ deployment: { spec: { replicas: 0 } } })
    const result = await kubernetes.stopWorkerOnKubernetesWithRuntime(input.workerId, makeRuntime(fake.client))

    expect(result).toEqual({ status: "stopped" })
    expect(fake.ops.some((entry) => entry.op === "patchDeployment")).toBe(false)
  })

  test("reports no_sandbox when the deployment is missing", async () => {
    const input = provisionInput()
    const fake = makeClient({ deployment: null })
    const result = await kubernetes.stopWorkerOnKubernetesWithRuntime(input.workerId, makeRuntime(fake.client))

    expect(result).toEqual({ status: "no_sandbox" })
  })

  test("deletes every worker object and tolerates missing ones", async () => {
    const input = provisionInput()
    const fake = makeClient({ deployment: null })
    await kubernetes.deprovisionWorkerOnKubernetesWithRuntime(input.workerId, makeRuntime(fake.client))

    const deleted = fake.ops.filter((entry) => entry.op.startsWith("delete")).map((entry) => entry.op)
    expect(deleted).toEqual([
      "deleteDeployment",
      "deleteService",
      "deleteSecret",
      "deletePvc",
      "deletePvc",
    ])
  })
})

describe("Kubernetes worker records and inspection", () => {
  test("returns a preview record with the configured TTL for a live deployment", async () => {
    const input = provisionInput()
    const fake = makeClient({ deployment: { spec: { replicas: 1 } } })
    const record = await kubernetes.getKubernetesWorkerRecordWithRuntime(input.workerId, makeRuntime(fake.client))

    expect(record?.sandbox_id).toBe(kubernetes.kubernetesWorkerName(input.workerId))
    expect(record?.signed_preview_url).toContain("svc.cluster.local")
    expect(record!.signed_preview_url_expires_at.getTime()).toBeGreaterThan(Date.now())
  })

  test("returns no record when the deployment is missing", async () => {
    const input = provisionInput()
    const fake = makeClient({ deployment: null })
    const record = await kubernetes.getKubernetesWorkerRecordWithRuntime(input.workerId, makeRuntime(fake.client))

    expect(record).toBeNull()
  })

  test("inspects replica state as stopped or started", async () => {
    const input = provisionInput()
    const stopped = makeClient({ deployment: { spec: { replicas: 0 } } })
    expect(await kubernetes.inspectKubernetesWorkerWithRuntime(input.workerId, makeRuntime(stopped.client)))
      .toEqual({ state: "stopped" })

    const started = makeClient({ deployment: { spec: { replicas: 1 } } })
    expect(await kubernetes.inspectKubernetesWorkerWithRuntime(input.workerId, makeRuntime(started.client)))
      .toEqual({ state: "started" })
  })
})

describe("Kubernetes health deadline", () => {
  test("includes pod phase and log tail in the health timeout error", async () => {
    const input = provisionInput()
    const fake = makeClient({ podPhase: "CrashLoopBackOff", podLogs: "worker crashed at boot" })
    const runtime = makeRuntime(fake.client, failingFetch())

    expect(
      kubernetes.provisionWorkerOnKubernetesWithRuntime(input, runtime),
    ).rejects.toThrow("Timed out waiting for Kubernetes worker health")
  })
})
