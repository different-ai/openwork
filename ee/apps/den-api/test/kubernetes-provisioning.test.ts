import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { beforeAll, describe, expect, test } from "bun:test"
import type { KubernetesClient } from "../src/workers/kubernetes-client.js"
import { KubernetesApiError, KubernetesNotFoundError } from "../src/workers/kubernetes-client.js"
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
  conflictOnCreate?: Array<"createPvc" | "createSecret" | "createService">
} = {}) {
  const ops: RecordedOp[] = []
  let deployment = input.deployment ?? null
  // A pre-existing deployment implies a pre-existing worker whose PVCs exist.
  let pvc: Record<string, unknown> | null = input.deployment ? {} : null
  let secret: Record<string, unknown> | null = null
  let service: Record<string, unknown> | null = null

  const notFound = (name: string) => {
    throw new KubernetesNotFoundError(`deployments/${name}`, "")
  }

  // Simulates a concurrent replica winning the create: the object lands in the
  // store and the create reports 409 once per listed occurrence.
  const pendingConflicts = [...(input.conflictOnCreate ?? [])]
  const conflictIfRequested = (op: "createPvc" | "createSecret" | "createService") => {
    const index = pendingConflicts.indexOf(op)
    if (index === -1) {
      return
    }
    pendingConflicts.splice(index, 1)
    if (op === "createPvc") {
      pvc = pvc ?? {}
    } else if (op === "createSecret") {
      secret = secret ?? {}
    } else {
      service = service ?? {}
    }
    throw new KubernetesApiError(`Kubernetes API POST ${op} failed (409)`, 409, "already exists")
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
      if (!deployment) {
        notFound(name)
      }
      deployment = null
    },
    async getService(name: string) {
      ops.push({ op: "getService", name })
      if (!service) {
        notFound(name)
      }
      return service
    },
    async createService(manifest: Record<string, unknown>) {
      ops.push({ op: "createService" })
      conflictIfRequested("createService")
      service = manifest
      return manifest
    },
    async deleteService(name: string) {
      ops.push({ op: "deleteService", name })
      if (!service) {
        notFound(name)
      }
      service = null
    },
    async getSecret(name: string) {
      ops.push({ op: "getSecret", name })
      if (!secret) {
        notFound(name)
      }
      return secret
    },
    async createSecret(manifest: Record<string, unknown>) {
      ops.push({ op: "createSecret" })
      conflictIfRequested("createSecret")
      secret = manifest
      return manifest
    },
    async deleteSecret(name: string) {
      ops.push({ op: "deleteSecret", name })
      if (!secret) {
        notFound(name)
      }
      secret = null
    },
    async createPvc(manifest: Record<string, unknown>) {
      ops.push({ op: "createPvc" })
      conflictIfRequested("createPvc")
      pvc = manifest
      return manifest
    },
    async getPvc(name: string) {
      ops.push({ op: "getPvc", name })
      if (!pvc) {
        notFound(name)
      }
      return pvc
    },
    async deletePvc(name: string) {
      ops.push({ op: "deletePvc", name })
      if (!pvc) {
        notFound(name)
      }
      pvc = null
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

  test("tolerates 409 conflicts on supporting-object creates in the fresh path", async () => {
    const input = provisionInput()
    const fake = makeClient({ conflictOnCreate: ["createPvc", "createPvc", "createSecret", "createService"] })
    const provisioned = await kubernetes.provisionWorkerOnKubernetesWithRuntime(
      input,
      makeRuntime(fake.client),
    )

    expect(fake.ops.filter((entry) => entry.op === "getPvc").length).toBe(2)
    expect(fake.ops.some((entry) => entry.op === "getSecret")).toBe(true)
    expect(fake.ops.some((entry) => entry.op === "getService")).toBe(true)
    expect(provisioned.status).toBe("healthy")
  })

  test("upserts the token secret by delete and recreate after a create conflict", async () => {
    const input = provisionInput()
    const fake = makeClient({ deployment: { spec: { replicas: 1 } }, conflictOnCreate: ["createSecret"] })
    const provisioned = await kubernetes.provisionWorkerOnKubernetesWithRuntime(
      input,
      makeRuntime(fake.client),
    )

    const secretOps = fake.ops.filter((entry) => entry.op === "createSecret" || entry.op === "deleteSecret").map((entry) => entry.op)
    expect(secretOps).toEqual(["createSecret", "deleteSecret", "createSecret"])
    expect(provisioned.status).toBe("healthy")
  })

  test("patches an adopted deployment running a stale image before reporting healthy", async () => {
    const input = provisionInput()
    const fake = makeClient({
      deployment: {
        spec: {
          replicas: 1,
          template: {
            spec: {
              containers: [{ name: "openwork-server", image: "registry.test/openwork-worker:stale" }],
            },
          },
        },
      },
    })
    const provisioned = await kubernetes.provisionWorkerOnKubernetesWithRuntime(
      input,
      makeRuntime(fake.client),
    )

    const patch = fake.ops.find((entry) => entry.op === "patchDeployment")?.patch as {
      spec?: { template?: { spec?: { containers?: Array<{ image?: string }> } } }
    } | undefined
    expect(patch?.spec?.template?.spec?.containers?.[0]?.image).toBe("registry.test/openwork-worker:test")
    expect(provisioned.imageVersion).toBe("registry.test/openwork-worker:test")
  })

  test("substitutes the DNS-safe worker name into WORKER_URL_TEMPLATE", async () => {
    const input = provisionInput()
    const original = env.workerUrlTemplate
    env.workerUrlTemplate = "https://{workerId}.workers.example.test:8787"
    try {
      const fake = makeClient()
      const provisioned = await kubernetes.provisionWorkerOnKubernetesWithRuntime(input, makeRuntime(fake.client))
      expect(provisioned.url).toBe(`https://${kubernetes.kubernetesWorkerName(input.workerId)}.workers.example.test:8787`)
      expect(provisioned.url).not.toContain("_")
    } finally {
      env.workerUrlTemplate = original
    }
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
    ).rejects.toThrow(/CrashLoopBackOff[\s\S]*worker crashed at boot/s)
  })

  test("redacts tokens printed by the worker entrypoint from health-timeout diagnostics", async () => {
    const input = provisionInput()
    const logs = [
      "Starting OpenWork micro-sandbox",
      `- client token: ${input.clientToken}`,
      `- host token: ${input.hostToken}`,
      "worker crashed at boot",
    ].join("\n")
    const fake = makeClient({ podPhase: "CrashLoopBackOff", podLogs: logs })
    const runtime = makeRuntime(fake.client, failingFetch())

    const error = await kubernetes.provisionWorkerOnKubernetesWithRuntime(input, runtime).catch((e) => e)
    const message = error instanceof Error ? error.message : String(error)
    expect(message).toContain("CrashLoopBackOff")
    expect(message).toContain("worker crashed at boot")
    expect(message).not.toContain(input.clientToken)
    expect(message).not.toContain(input.hostToken)
    expect(message).toContain("[REDACTED]")
  })
})
