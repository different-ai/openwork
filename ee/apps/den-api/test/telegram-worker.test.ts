import { afterEach, beforeAll, describe, expect, test } from "bun:test"

type WorkerRequest = {
  authorization: string | null
  hostToken: string | null
  method: string
  pathname: string
}

let stopServer: (() => void) | null = null
let workerModule: typeof import("../src/capability-sources/telegram-worker.js")

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_telegram"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  workerModule = await import("../src/capability-sources/telegram-worker.js")
})

afterEach(() => {
  stopServer?.()
  stopServer = null
})

function assistant(id: string, text: string, parentId?: string) {
  return {
    info: { id, role: "assistant", parentID: parentId },
    parts: [{ type: "text", text }],
  }
}

function fakeWorker() {
  const requests: WorkerRequest[] = []
  let snapshotCount = 0
  let promptMessageId = ""
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      requests.push({
        authorization: request.headers.get("authorization"),
        hostToken: request.headers.get("x-openwork-host-token"),
        method: request.method,
        pathname: url.pathname,
      })

      if (url.pathname === "/workspaces") {
        return Response.json({ activeId: "ws_main", items: [{ id: "ws_main" }] })
      }
      if (url.pathname === "/workspace/ws_main/sessions/ses_1/snapshot") {
        snapshotCount += 1
        if (snapshotCount === 1) {
          return Response.json({ item: { status: { type: "idle" }, messages: [assistant("old", "Old answer")] } })
        }
        if (snapshotCount === 2) {
          return Response.json({ item: { status: { type: "busy" }, messages: [assistant("old", "Old answer")] } })
        }
        return Response.json({
          item: {
            status: { type: "idle" },
            messages: [
              assistant("old", "Old answer"),
              assistant("late", "Late answer from a prior request", "msg_prior"),
              assistant("new", "Fresh answer", promptMessageId),
            ],
          },
        })
      }
      if (url.pathname === "/workspace/ws_main/opencode/session/ses_1/prompt_async") {
        const body: unknown = await request.json()
        if (typeof body === "object" && body !== null && "messageID" in body && typeof body.messageID === "string") {
          promptMessageId = body.messageID
        }
        return new Response(null, { status: 204 })
      }
      return Response.json({ message: "not found" }, { status: 404 })
    },
  })
  stopServer = () => server.stop(true)
  return { baseUrl: server.url.origin, requests }
}

function fakeCrashRecoveryWorker() {
  const events: string[] = []
  let acceptedMessageId = ""
  let promptCount = 0
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/workspaces") {
        return Response.json({ activeId: "ws_retry", items: [{ id: "ws_retry" }] })
      }
      if (url.pathname === "/workspace/ws_retry/opencode/session" && request.method === "POST") {
        events.push("session-created")
        return Response.json({ id: "ses_retry" })
      }
      if (url.pathname === "/workspace/ws_retry/sessions/ses_retry/snapshot") {
        if (!acceptedMessageId) {
          return Response.json({ item: { status: { type: "idle" }, messages: [] } })
        }
        return Response.json({
          item: {
            status: { type: "idle" },
            messages: [
              { info: { id: acceptedMessageId, role: "user" }, parts: [{ type: "text", text: "Do the work" }] },
              assistant("asst_retry", "Recovered answer", acceptedMessageId),
            ],
          },
        })
      }
      if (url.pathname === "/workspace/ws_retry/opencode/session/ses_retry/prompt_async") {
        const body: unknown = await request.json()
        if (typeof body === "object" && body !== null && "messageID" in body && typeof body.messageID === "string") {
          acceptedMessageId = body.messageID
        }
        promptCount += 1
        events.push("prompt-accepted")
        return Response.json({ message: "connection dropped after upstream acceptance" }, { status: 502 })
      }
      return Response.json({ message: "not found" }, { status: 404 })
    },
  })
  stopServer = () => server.stop(true)
  return {
    baseUrl: server.url.origin,
    events,
    promptCount: () => promptCount,
  }
}

describe("Telegram worker forwarding", () => {
  test("accepts only healthy workers with a healthy selected instance", () => {
    expect(workerModule.telegramWorkerIsHealthy("healthy", "healthy")).toBe(true)
    expect(workerModule.telegramWorkerIsHealthy("stopped", "healthy")).toBe(false)
    expect(workerModule.telegramWorkerIsHealthy("healthy", "failed")).toBe(false)
  })

  test("classifies worker network, timeout, rate-limit, and server failures as retryable", () => {
    expect(workerModule.isRetryableTelegramWorkerError(
      new workerModule.TelegramWorkerRequestError(502, "network failed"),
    )).toBe(true)
    expect(workerModule.isRetryableTelegramWorkerError(
      new workerModule.TelegramWorkerRequestError(429, "rate limited"),
    )).toBe(true)
    expect(workerModule.isRetryableTelegramWorkerError(
      new workerModule.TelegramWorkerRequestError(503, "unavailable"),
    )).toBe(true)
    expect(workerModule.isRetryableTelegramWorkerError(new workerModule.TelegramWorkerTimeoutError())).toBe(true)
    expect(workerModule.isRetryableTelegramWorkerError(
      new workerModule.TelegramWorkerRequestError(400, "bad request"),
    )).toBe(false)
  })


  test("uses both worker credentials and waits for a new idle assistant response", async () => {
    const fake = fakeWorker()
    const workerId: `wrk_${string}` = "wrk_test"
    const access = {
      candidates: [fake.baseUrl],
      clientToken: "client-token",
      hostToken: "host-token",
      workerId,
    }

    await expect(workerModule.runTelegramWorkerPrompt({
      access,
      pollIntervalMs: 1,
      promptTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
      sessionId: "ses_1",
      text: "Summarize the launch notes",
    })).resolves.toEqual({
      sessionId: "ses_1",
      text: "Fresh answer",
      workspaceId: "ws_main",
    })

    expect(fake.requests.every((request) => request.authorization === "Bearer client-token")).toBe(true)
    expect(fake.requests.every((request) => request.hostToken === "host-token")).toBe(true)
    expect(fake.requests.filter((request) => request.pathname.endsWith("/prompt_async"))).toHaveLength(1)
  })

  test("persists a new session before prompt acceptance and reuses it after an ambiguous crash", async () => {
    const fake = fakeCrashRecoveryWorker()
    const workerId: `wrk_${string}` = "wrk_retry"
    const access = {
      candidates: [fake.baseUrl],
      clientToken: "client-token",
      hostToken: "host-token",
      workerId,
    }
    let persistedSession: { sessionId: string; workspaceId: string } | null = null
    const persist = async (session: { sessionId: string; workspaceId: string }) => {
      persistedSession = session
      fake.events.push("session-persisted")
    }

    await expect(workerModule.runTelegramWorkerPrompt({
      access,
      messageId: "msg_retry_stable",
      onSessionReady: persist,
      pollIntervalMs: 1,
      promptTimeoutMs: 100,
      requestTimeoutMs: 1_000,
      text: "Do the work",
    })).rejects.toThrow("connection dropped after upstream acceptance")

    expect(persistedSession).toEqual({ sessionId: "ses_retry", workspaceId: "ws_retry" })
    expect(fake.events).toEqual(["session-created", "session-persisted", "prompt-accepted"])

    const savedSession = persistedSession
    if (!savedSession) throw new Error("session was not persisted")
    await expect(workerModule.runTelegramWorkerPrompt({
      access,
      messageId: "msg_retry_stable",
      onSessionReady: persist,
      pollIntervalMs: 1,
      promptTimeoutMs: 100,
      requestTimeoutMs: 1_000,
      sessionId: savedSession.sessionId,
      text: "Do the work",
    })).resolves.toEqual({
      sessionId: "ses_retry",
      text: "Recovered answer",
      workspaceId: "ws_retry",
    })
    expect(fake.promptCount()).toBe(1)
  })
})
