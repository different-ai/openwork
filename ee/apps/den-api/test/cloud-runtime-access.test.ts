import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { beforeAll, describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:http"
import type {
  CloudRuntimeStore,
  CloudRuntimeWorker,
  ResolveCloudRuntimeAccessOptions,
} from "../src/workers/worker-access.js"

function seedRequiredEnv() {
  process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY ??= "x".repeat(32)
  process.env.BETTER_AUTH_SECRET ??= "y".repeat(32)
  process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS ??= "http://127.0.0.1:8790"
  process.env.PROVISIONER_MODE = "stub"
  process.env.DAYTONA_SNAPSHOT = "openwork-0.18.8"
}

type RuntimeAccessModule = typeof import("../src/workers/worker-access.js")
type LifecycleModule = typeof import("../src/workers/cloud-lifecycle.js")
type LifecycleOptions = NonNullable<Parameters<LifecycleModule["recoverClaimedCloudWorker"]>[1]>
type LifecycleStore = NonNullable<LifecycleOptions["store"]>
type LifecycleWorker = NonNullable<Awaited<ReturnType<LifecycleStore["getWorker"]>>>
type LifecycleToken = Awaited<ReturnType<LifecycleStore["getActiveTokens"]>>[number]
let runtimeAccess: RuntimeAccessModule
let lifecycle: LifecycleModule

beforeAll(async () => {
  seedRequiredEnv()
  ;[runtimeAccess, lifecycle] = await Promise.all([
    import("../src/workers/worker-access.js"),
    import("../src/workers/cloud-lifecycle.js"),
  ])
})

function worker(status: CloudRuntimeWorker["status"]): CloudRuntimeWorker {
  return {
    id: createDenTypeId("worker"),
    name: "Cloud runtime test",
    status,
    image_version: "openwork-0.18.8",
  }
}

function store(input: { tokens?: Array<{ scope: "host" | "client" | "activity"; token: string }>; claimFailed?: boolean } = {}): CloudRuntimeStore {
  return {
    async claimFailedWorker() {
      return input.claimFailed ?? false
    },
    async claimRecycleWorker() {
      return false
    },
    async getActiveTokens() {
      return input.tokens ?? [
        { scope: "host", token: "host-token" },
        { scope: "client", token: "client-token" },
        { scope: "activity", token: "activity-token" },
      ]
    },
    async markProvisioningWorkerFailed() {},
    async markHealthyWorkerFailed() {},
  }
}

function options(input: {
  runtimeWorker: CloudRuntimeWorker
  expiresAt?: Date
  signedPreviewUrl?: string
  runtimeStore?: CloudRuntimeStore
}): ResolveCloudRuntimeAccessOptions {
  return {
    loadWorker: async () => input.runtimeWorker,
    store: input.runtimeStore ?? store(),
    getSandboxRecord: async () => ({
      signed_preview_url: input.signedPreviewUrl ?? "https://fresh.preview.example.test",
      signed_preview_url_expires_at: input.expiresAt ?? new Date("2026-08-27T12:00:00.000Z"),
    }),
    inspectSandbox: async () => ({ state: "started" }),
    refreshSignedPreview: async () => null,
    probeSignedPreview: async () => true,
    startWake: () => {},
    now: () => new Date("2026-08-27T10:00:00.000Z").getTime(),
  }
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) return resolve()
    server.close((error) => error ? reject(error) : resolve())
  })
}

describe("Cloud runtime access resolver", () => {
  test("returns a probed fresh signed preview and both runtime tokens", async () => {
    const runtimeWorker = worker("healthy")
    const probed: string[] = []
    const result = await runtimeAccess.resolveCloudRuntimeAccess({
      organizationId: createDenTypeId("organization"),
      userId: createDenTypeId("user"),
    }, {
      ...options({ runtimeWorker }),
      probeSignedPreview: async (url) => {
        probed.push(url)
        return true
      },
    })

    expect(result).toEqual({
      status: "ready",
      workerId: runtimeWorker.id,
      url: "https://fresh.preview.example.test",
      expiresAt: new Date("2026-08-27T12:00:00.000Z"),
      clientToken: "client-token",
      hostToken: "host-token",
    })
    expect(probed).toEqual(["https://fresh.preview.example.test"])
  })

  test("refreshes and probes an expired signed preview before returning it", async () => {
    const runtimeWorker = worker("healthy")
    const probed: string[] = []
    const result = await runtimeAccess.resolveCloudRuntimeAccess({
      organizationId: createDenTypeId("organization"),
      workerId: runtimeWorker.id,
    }, {
      ...options({
        runtimeWorker,
        signedPreviewUrl: "https://expired.preview.example.test",
        expiresAt: new Date("2026-08-27T09:00:00.000Z"),
      }),
      refreshSignedPreview: async () => ({
        signed_preview_url: "https://refreshed.preview.example.test",
        signed_preview_url_expires_at: new Date("2026-08-27T12:00:00.000Z"),
      }),
      probeSignedPreview: async (url) => {
        probed.push(url)
        return true
      },
    })

    expect(result.status).toBe("ready")
    if (result.status !== "ready") throw new Error("expected ready runtime")
    expect(result.url).toBe("https://refreshed.preview.example.test")
    expect(probed).toEqual(["https://refreshed.preview.example.test"])
  })

  test("rejects a refreshed preview whose safety time is already stale", async () => {
    const runtimeWorker = worker("healthy")
    let probes = 0
    const result = await runtimeAccess.resolveCloudRuntimeAccess({
      organizationId: createDenTypeId("organization"),
      workerId: runtimeWorker.id,
    }, {
      ...options({
        runtimeWorker,
        signedPreviewUrl: "https://expired.preview.example.test",
        expiresAt: new Date("2026-08-27T09:00:00.000Z"),
      }),
      refreshSignedPreview: async () => ({
        signed_preview_url: "https://still-stale.preview.example.test",
        signed_preview_url_expires_at: new Date("2026-08-27T10:00:00.000Z"),
      }),
      probeSignedPreview: async () => {
        probes += 1
        return true
      },
    })

    expect(result).toEqual(expect.objectContaining({
      status: "failed",
      workerId: runtimeWorker.id,
      reason: "preview_expired",
      failure: expect.objectContaining({ code: "preview_expired", stage: "runtime" }),
    }))
    expect(probes).toBe(0)
  })

  test("wakes a stopped worker without reporting ready", async () => {
    const runtimeWorker = worker("stopped")
    const wakes: string[] = []
    const result = await runtimeAccess.resolveCloudRuntimeAccess({
      organizationId: createDenTypeId("organization"),
      workerId: runtimeWorker.id,
    }, {
      ...options({ runtimeWorker }),
      startWake: (workerId) => wakes.push(workerId),
    })

    expect(result).toEqual({ status: "waking", workerId: runtimeWorker.id, reason: "stopped" })
    expect(wakes).toEqual([runtimeWorker.id])
  })

  test("keeps provisioning and failed lifecycle states distinct", async () => {
    const organizationId = createDenTypeId("organization")
    const provisioningWorker = worker("provisioning")
    const provisioning = await runtimeAccess.resolveCloudRuntimeAccess({
      organizationId,
      workerId: provisioningWorker.id,
    }, {
      ...options({ runtimeWorker: provisioningWorker }),
      getSandboxRecord: async () => null,
    })
    const failedWorker = worker("failed")
    const failed = await runtimeAccess.resolveCloudRuntimeAccess({
      organizationId,
      workerId: failedWorker.id,
    }, options({ runtimeWorker: failedWorker, runtimeStore: store({ claimFailed: false }) }))

    expect(provisioning).toEqual({ status: "provisioning", workerId: provisioningWorker.id })
    expect(failed).toEqual({ status: "failed", workerId: failedWorker.id })
  })

  test("keeps transport failure classified unreachable while recovery is in progress", async () => {
    const organizationId = createDenTypeId("organization")
    const runtimeWorker = worker("healthy")
    const resolverOptions: ResolveCloudRuntimeAccessOptions = {
      ...options({ runtimeWorker }),
      probeSignedPreview: async () => false,
      refreshSignedPreview: async () => null,
    }
    const first = await runtimeAccess.resolveCloudRuntimeAccess({
      organizationId,
      workerId: runtimeWorker.id,
    }, resolverOptions)
    runtimeWorker.status = "provisioning"
    const recovering = await runtimeAccess.resolveCloudRuntimeAccess({
      organizationId,
      workerId: runtimeWorker.id,
    }, resolverOptions)

    expect(first).toEqual(expect.objectContaining({
      status: "waking",
      workerId: runtimeWorker.id,
      reason: "unreachable",
      failure: expect.objectContaining({ code: "runtime_unreachable", stage: "runtime" }),
    }))
    expect(recovering).toEqual({ status: "waking", workerId: runtimeWorker.id, reason: "unreachable" })
  })

  test("a failed-worker claim executes the production-shaped recovery primitive exactly once", async () => {
    const organizationId = createDenTypeId("organization")
    const now = new Date("2026-08-27T10:00:00.000Z")
    const runtimeWorker: LifecycleWorker = {
      id: createDenTypeId("worker"),
      name: "Claimed recovery",
      status: "failed",
      org_id: organizationId,
      last_active_at: null,
      updated_at: now,
    }
    const scopes: LifecycleToken["scope"][] = ["host", "client", "activity"]
    const tokens: LifecycleToken[] = scopes.map((scope) => ({
      id: createDenTypeId("workerToken"),
      worker_id: runtimeWorker.id,
      scope,
      token: `${scope}-token`,
      created_at: now,
      revoked_at: null,
    }))
    const lifecycleStore: LifecycleStore = {
      async getWorker() { return runtimeWorker },
      async getActiveTokens() { return tokens },
      async listIdleWorkers() { return [] },
      async reserveWake() { return false },
      async reserveIdleStop() { return false },
      async updateWorkerStatus(input) {
        if (input.onlyWhenStatus && runtimeWorker.status !== input.onlyWhenStatus) return
        runtimeWorker.status = input.status
      },
      async touchProvisioningWorker() {},
    }
    const runtimeStore: CloudRuntimeStore = {
      async claimFailedWorker() {
        if (runtimeWorker.status !== "failed") return false
        runtimeWorker.status = "provisioning"
        return true
      },
      async claimRecycleWorker() { return false },
      async getActiveTokens() { return tokens },
      async markProvisioningWorkerFailed() { runtimeWorker.status = "failed" },
      async markHealthyWorkerFailed() { runtimeWorker.status = "failed" },
    }
    let providerActions = 0
    let recovery: Promise<void> | null = null
    const result = await runtimeAccess.resolveCloudRuntimeAccess({ organizationId, workerId: runtimeWorker.id }, {
      ...options({ runtimeWorker, runtimeStore }),
      getSandboxRecord: async () => ({
        signed_preview_url: "https://recover.preview.example.test",
        signed_preview_url_expires_at: new Date("2026-08-27T12:00:00.000Z"),
      }),
      startRecovery: (workerId) => {
        recovery = lifecycle.recoverClaimedCloudWorker(workerId, {
          store: lifecycleStore,
          wakeWorker: async () => {
            providerActions += 1
            return { provider: "daytona", url: "https://recover.preview.example.test", status: "healthy" }
          },
          materializeProviders: async () => ({ ok: true, status: "noop", fingerprint: "owp:v1:test", providers: 0 }),
        })
      },
    })
    if (!recovery) throw new Error("claimed recovery did not start")
    await recovery

    expect(result).toEqual({ status: "waking", workerId: runtimeWorker.id, reason: "recovering" })
    expect(providerActions).toBe(1)
    expect(runtimeWorker.status).toBe("healthy")
  })

  test("fails closed when a ready runtime is missing either access token", async () => {
    const runtimeWorker = worker("healthy")
    const result = await runtimeAccess.resolveCloudRuntimeAccess({
      organizationId: createDenTypeId("organization"),
      workerId: runtimeWorker.id,
    }, options({
      runtimeWorker,
      runtimeStore: store({ tokens: [{ scope: "client", token: "client-token" }] }),
    }))

    expect(result).toEqual(expect.objectContaining({
      status: "failed",
      workerId: runtimeWorker.id,
      reason: "missing_tokens",
      failure: expect.objectContaining({ code: "access_tokens_missing", stage: "runtime" }),
    }))
  })

  test("signed preview health probe refuses sandbox-controlled redirects", async () => {
    let redirectedTargetHit = false
    const target = createServer((_request, response) => {
      redirectedTargetHit = true
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ ok: true }))
    })
    const sandbox = createServer((_request, response) => {
      const address = target.address()
      if (!address || typeof address === "string") throw new Error("target server did not bind")
      response.writeHead(302, { location: `http://127.0.0.1:${address.port}/internal-health` })
      response.end()
    })

    await Promise.all([listen(target), listen(sandbox)])
    try {
      const address = sandbox.address()
      if (!address || typeof address === "string") throw new Error("sandbox server did not bind")
      const healthy = await runtimeAccess.probeCloudRuntimeSignedPreview(`http://127.0.0.1:${address.port}`)
      expect(healthy).toBe(false)
      expect(redirectedTargetHit).toBe(false)
    } finally {
      await Promise.all([close(target), close(sandbox)])
    }
  })

  test("passes ownership to the loader and reports missing for a different organization", async () => {
    const organizationId = createDenTypeId("organization")
    const otherOrganizationId = createDenTypeId("organization")
    const runtimeWorker = worker("healthy")
    const seen: string[] = []
    const result = await runtimeAccess.resolveCloudRuntimeAccess({
      organizationId: otherOrganizationId,
      workerId: runtimeWorker.id,
    }, {
      ...options({ runtimeWorker }),
      loadWorker: async (ownership) => {
        seen.push(ownership.organizationId)
        return ownership.organizationId === organizationId ? runtimeWorker : null
      },
    })

    expect(result).toEqual({ status: "missing" })
    expect(seen).toEqual([otherOrganizationId])
  })
})
