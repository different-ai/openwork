import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:http"

function seedRequiredEnv() {
  process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY ??= "x".repeat(32)
  process.env.BETTER_AUTH_SECRET ??= "y".repeat(32)
  process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS ??= "http://127.0.0.1:8790"
  process.env.PROVISIONER_MODE = "stub"
  // Sibling suites read the pinned snapshot from the shared env module.
  process.env.DAYTONA_SNAPSHOT ??= "openwork-0.18.8"
}

type ActivityModule = typeof import("../src/workers/cloud-activity.js")
let activity: ActivityModule
let server: Server
let baseUrl = ""
let mode: "idle" | "busy" | "waiting" | "html" | "not_found" | "error" | "unknown_json" = "idle"
const seenHeaders: Array<string | undefined> = []

beforeAll(async () => {
  seedRequiredEnv()
  activity = await import("../src/workers/cloud-activity.js")
  server = createServer((request, response) => {
    seenHeaders.push(request.headers["x-openwork-host-token"]?.toString())
    if (request.url !== "/runtime/activity") {
      response.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not_found" }))
      return
    }
    switch (mode) {
      case "html":
        response.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><html><body>OpenWork</body></html>")
        return
      case "not_found":
        response.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not_found" }))
        return
      case "error":
        response.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: "unavailable" }))
        return
      case "unknown_json":
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, verdict: "unknown", busySessions: 0, waitingRequests: 0, connectedClients: 0 }))
        return
      case "busy":
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, verdict: "busy", busySessions: 2, waitingRequests: 0, connectedClients: 1 }))
        return
      case "waiting":
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, verdict: "busy", busySessions: 0, waitingRequests: 1, connectedClients: 0 }))
        return
      default:
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, verdict: "idle", busySessions: 0, waitingRequests: 0, connectedClients: 3 }))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("activity server did not bind")
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
})

const fetchImpl = (url: string, init: RequestInit) => fetch(url, init)

describe("cloud worker activity probe", () => {
  test("reads busy, waiting, and idle verdicts with the host token and counts only", async () => {
    mode = "busy"
    expect(await activity.probeCloudWorkerActivity({ instanceUrl: `${baseUrl}/`, hostToken: "host-secret", fetchImpl })).toEqual({
      verdict: "busy", reason: "busy_sessions", alive: true, busySessions: 2, waitingRequests: 0, connectedClients: 1,
    })
    mode = "waiting"
    expect(await activity.probeCloudWorkerActivity({ instanceUrl: baseUrl, hostToken: "host-secret", fetchImpl })).toMatchObject({
      verdict: "busy", reason: "waiting_requests", waitingRequests: 1,
    })
    mode = "idle"
    expect(await activity.probeCloudWorkerActivity({ instanceUrl: baseUrl, hostToken: "host-secret", fetchImpl })).toEqual({
      verdict: "idle", reason: "idle", alive: true, busySessions: 0, waitingRequests: 0, connectedClients: 3,
    })
    expect(seenHeaders.every((header) => header === "host-secret")).toBe(true)
  })

  test("treats an instance that predates the route as alive without a verdict, and silence as neither", async () => {
    mode = "html"
    expect(await activity.probeCloudWorkerActivity({ instanceUrl: baseUrl, hostToken: "host-secret", fetchImpl })).toMatchObject({
      verdict: "unknown", reason: "route_unsupported", alive: true,
    })
    mode = "not_found"
    expect(await activity.probeCloudWorkerActivity({ instanceUrl: baseUrl, hostToken: "host-secret", fetchImpl })).toMatchObject({
      verdict: "unknown", reason: "route_unsupported", alive: true,
    })
    mode = "error"
    expect(await activity.probeCloudWorkerActivity({ instanceUrl: baseUrl, hostToken: "host-secret", fetchImpl })).toMatchObject({
      verdict: "unknown", reason: "probe_failed", alive: false,
    })
    mode = "unknown_json"
    expect(await activity.probeCloudWorkerActivity({ instanceUrl: baseUrl, hostToken: "host-secret", fetchImpl })).toMatchObject({
      verdict: "unknown", reason: "probe_failed", alive: true,
    })
    expect(await activity.probeCloudWorkerActivity({
      instanceUrl: "http://127.0.0.1:9",
      hostToken: "host-secret",
      fetchImpl,
      timeoutMs: 500,
    })).toMatchObject({ verdict: "unknown", reason: "probe_failed", alive: false })
  })
})

describe("cloud worker interruptibility", () => {
  const workerId = createDenTypeId("worker")
  const idle = { verdict: "idle" as const, reason: "idle" as const, alive: true, busySessions: 0, waitingRequests: 0, connectedClients: 0 }

  test("fails closed and lets only an idle or legacy instance be interrupted", async () => {
    const decide = (input: {
      automationRun?: boolean
      instance?: { url: string; hostToken: string } | null
      activity?: Awaited<ReturnType<ActivityModule["probeCloudWorkerActivity"]>>
    }) => activity.resolveCloudWorkerInterruptibility({
      workerId,
      trigger: "update",
      hasActiveAutomationRun: async () => input.automationRun ?? false,
      instance: async () => input.instance === undefined ? { url: baseUrl, hostToken: "host-secret" } : input.instance,
      probeActivity: async () => input.activity ?? idle,
    })

    expect(await decide({ automationRun: true })).toMatchObject({ verdict: "busy", reason: "automation_run", activity: null })
    expect(await decide({ instance: null })).toMatchObject({ verdict: "unknown", reason: "no_instance" })
    expect(await decide({ activity: { ...idle, verdict: "busy", reason: "busy_sessions", busySessions: 1 } })).toMatchObject({ verdict: "busy", reason: "busy_sessions" })
    expect(await decide({ activity: { ...idle, verdict: "unknown", reason: "probe_failed", alive: false } })).toMatchObject({ verdict: "unknown", reason: "probe_failed" })
    expect(await decide({ activity: { ...idle, verdict: "unknown", reason: "route_unsupported" } })).toMatchObject({ verdict: "interruptible", reason: "legacy_instance" })
    expect(await decide({})).toMatchObject({ verdict: "interruptible", reason: "idle" })
  })
})
