import { createHmac } from "node:crypto"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { WorkerInstanceTable, WorkerTable, WorkerTokenTable } from "@openwork-ee/den-db/schema"
import { Hono } from "hono"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

let db: typeof import("../src/db.js").db
let drizzle: typeof import("@openwork-ee/den-db/drizzle")
let schema: typeof import("@openwork-ee/den-db/schema/tag")
let store: typeof import("../src/capability-sources/tag-store.js")
let app: Hono
let stopSlack: (() => void) | null = null
let stopWorker: (() => void) | null = null

const signingSecret = "end-to-end-slack-signing-secret"
const botToken = "xoxb-end-to-end"
const slackUpdates: string[] = []
const workerPrompts: Array<Record<string, unknown>> = []
let sessionCreates = 0
let abortRequests = 0

function seedEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_tag"
  process.env.DB_MODE = "mysql"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "tag-e2e-encryption-key-12345678901234"
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "tag-e2e-better-auth-secret-123456789"
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.OPENWORK_DEV_MODE = "1"
  process.env.DEN_TAG_SLACK_ENABLED = "true"
  process.env.DEN_TAG_SLACK_CLIENT_ID = "tag-e2e-client"
  process.env.DEN_TAG_SLACK_CLIENT_SECRET = "tag-e2e-client-secret"
  process.env.DEN_TAG_SLACK_SIGNING_SECRET = signingSecret
}

async function clearTables() {
  await db.delete(schema.TagRunTable)
  await db.delete(schema.TagThreadTable)
  await db.delete(schema.TagEventTable)
  await db.delete(schema.TagChannelTable)
  await db.delete(schema.TagConnectionTable)
  await db.delete(schema.TagOAuthStateTable)
  await db.delete(WorkerTokenTable)
  await db.delete(WorkerInstanceTable)
  await db.delete(WorkerTable)
}

function signature(timestamp: string, body: string) {
  return `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${body}`).digest("hex")}`
}

async function waitForEvent(connectionId: string, eventId: string) {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    const rows = await db.select().from(schema.TagEventTable).where(drizzle.and(
      drizzle.eq(schema.TagEventTable.connectionId, connectionId),
      drizzle.eq(schema.TagEventTable.slackEventId, eventId),
    )).limit(1)
    if (rows[0] && ["completed", "failed", "ignored"].includes(rows[0].status)) return rows[0]
    await Bun.sleep(25)
  }
  throw new Error(`Timed out waiting for ${eventId}`)
}

beforeAll(async () => {
  seedEnv()
  const slackServer = Bun.serve({
    port: 0,
    async fetch(request) {
      const method = new URL(request.url).pathname.split("/").pop() ?? ""
      const body = await request.json() as Record<string, unknown>
      if (request.headers.get("authorization") !== `Bearer ${botToken}`) {
        return Response.json({ ok: false, error: "invalid_auth" })
      }
      if (method === "conversations.info") {
        return Response.json({ ok: true, channel: { id: "C_ENGINEERING", name: "engineering", is_ext_shared: false } })
      }
      if (method === "users.info") {
        return Response.json({ ok: true, user: { id: "U_MEMBER", name: "member", profile: { display_name: "Team Member" } } })
      }
      if (method === "chat.postMessage") {
        return Response.json({ ok: true, ts: `status-${Date.now()}` })
      }
      if (method === "chat.update") {
        slackUpdates.push(String(body.text ?? ""))
        return Response.json({ ok: true })
      }
      return Response.json({ ok: false, error: "unknown_method" })
    },
  })
  stopSlack = () => slackServer.stop(true)
  process.env.DEN_SLACK_API_ROOT = slackServer.url.origin

  const completedMessages: Array<Record<string, unknown>> = []
  let currentMessageId = ""
  let pollsAfterPrompt = 0
  let longRunning = false
  const workerServer = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (request.headers.get("authorization") !== "Bearer client-token" || request.headers.get("x-openwork-host-token") !== "host-token") {
        return Response.json({ message: "unauthorized" }, { status: 401 })
      }
      if (url.pathname === "/workspaces") {
        return Response.json({ activeId: "ws_engineering", items: [{ id: "ws_engineering" }] })
      }
      if (url.pathname === "/workspace/ws_engineering/opencode/session" && request.method === "POST") {
        sessionCreates += 1
        return Response.json({ id: "ses_slack_thread" })
      }
      if (url.pathname === "/workspace/ws_engineering/opencode/session/ses_slack_thread/prompt_async") {
        const body = await request.json() as Record<string, unknown>
        workerPrompts.push(body)
        currentMessageId = String(body.messageID ?? "")
        pollsAfterPrompt = 0
        longRunning = JSON.stringify(body).includes("keep working until cancelled")
        return new Response(null, { status: 204 })
      }
      if (url.pathname === "/workspace/ws_engineering/sessions/ses_slack_thread/snapshot") {
        if (!currentMessageId) return Response.json({ item: { status: { type: "idle" }, todos: [], messages: completedMessages } })
        pollsAfterPrompt += 1
        if (pollsAfterPrompt === 1 || longRunning) {
          return Response.json({
            item: {
              status: { type: "busy" },
              todos: [{ content: "Verify the requested change", status: "in_progress", priority: "high" }],
              messages: completedMessages,
            },
          })
        }
        const requestNumber = workerPrompts.length
        completedMessages.push(
          { info: { id: currentMessageId, role: "user" }, parts: [{ type: "text", text: "request" }] },
          { info: { id: `assistant-${requestNumber}`, role: "assistant", parentID: currentMessageId }, parts: [{ type: "text", text: `Verified result ${requestNumber}` }] },
        )
        currentMessageId = ""
        return Response.json({ item: { status: { type: "idle" }, todos: [], messages: completedMessages } })
      }
      if (url.pathname === "/workspace/ws_engineering/opencode/session/ses_slack_thread/abort") {
        abortRequests += 1
        currentMessageId = ""
        longRunning = false
        return Response.json(true)
      }
      return Response.json({ message: "not found" }, { status: 404 })
    },
  })
  stopWorker = () => workerServer.stop(true)

  const [dbModule, drizzleModule, schemaModule, storeModule, routeModule] = await Promise.all([
    import("../src/db.js"),
    import("@openwork-ee/den-db/drizzle"),
    import("@openwork-ee/den-db/schema/tag"),
    import("../src/capability-sources/tag-store.js"),
    import("../src/routes/webhooks/tag-slack.js"),
  ])
  db = dbModule.db
  drizzle = drizzleModule
  schema = schemaModule
  store = storeModule
  await clearTables()

  const organizationId = createDenTypeId("organization")
  const workerId = createDenTypeId("worker")
  await db.insert(WorkerTable).values({
    id: workerId,
    org_id: organizationId,
    name: "Engineering worker",
    destination: "cloud",
    status: "healthy",
  })
  await db.insert(WorkerInstanceTable).values({
    id: createDenTypeId("workerInstance"),
    worker_id: workerId,
    provider: "daytona",
    status: "healthy",
    url: workerServer.url.origin,
  })
  await db.insert(WorkerTokenTable).values([
    { id: createDenTypeId("workerToken"), worker_id: workerId, scope: "host", token: "host-token" },
    { id: createDenTypeId("workerToken"), worker_id: workerId, scope: "client", token: "client-token" },
  ])
  await db.insert(schema.TagConnectionTable).values({
    id: createDenTypeId("tagConnection"),
    organizationId,
    workerId,
    createdByOrgMembershipId: createDenTypeId("member"),
    botToken,
    signingSecret,
    slackTeamId: "T_ACME",
    slackTeamName: "Acme",
    botUserId: "U_BOT",
    botName: "openwork",
    serviceName: "Builder",
    defaultInstructions: "Verify the change before reporting completion.",
    allowedUserIds: JSON.stringify(["U_MEMBER"]),
    status: "active",
  })
  const connection = await store.getTagConnectionByOrganization(organizationId)
  if (!connection) throw new Error("missing end-to-end Tag connection")
  await db.insert(schema.TagChannelTable).values({
    id: createDenTypeId("tagChannel"),
    connectionId: connection.id,
    slackChannelId: "C_ENGINEERING",
    slackChannelName: "engineering",
  })

  app = new Hono()
  routeModule.registerTagSlackWebhookRoutes(app)
})

afterAll(async () => {
  await clearTables()
  stopSlack?.()
  stopWorker?.()
})

describe("OpenWork Tag end-to-end", () => {
  test("executes a signed mention and reuses the OpenCode session for an unmentioned thread reply", async () => {
    const connection = await db.select().from(schema.TagConnectionTable).limit(1)
    const connectionId = connection[0]?.id
    if (!connectionId) throw new Error("missing Tag connection")

    async function sendEvent(eventId: string, event: Record<string, unknown>) {
      const body = JSON.stringify({
        type: "event_callback",
        event_id: eventId,
        team_id: "T_ACME",
        event,
      })
      const timestamp = String(Math.floor(Date.now() / 1_000))
      return app.request(`/v1/webhooks/tag/slack/${connectionId}`, {
        body,
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": signature(timestamp, body),
        },
        method: "POST",
      })
    }

    const firstResponse = await sendEvent("Ev_first", {
      type: "app_mention",
      channel: "C_ENGINEERING",
      channel_type: "channel",
      user: "U_MEMBER",
      text: "<@U_BOT> verify checkout and fix it",
      ts: "1700.100",
    })
    expect(firstResponse.status).toBe(200)
    expect(await firstResponse.json()).toEqual({ ok: true, accepted: true })
    expect((await waitForEvent(connectionId, "Ev_first")).status).toBe("completed")

    const secondResponse = await sendEvent("Ev_second", {
      type: "message",
      channel: "C_ENGINEERING",
      channel_type: "channel",
      user: "U_MEMBER",
      text: "now summarize the evidence",
      thread_ts: "1700.100",
      ts: "1700.200",
    })
    expect(secondResponse.status).toBe(200)
    expect(await secondResponse.json()).toEqual({ ok: true, accepted: true })
    expect((await waitForEvent(connectionId, "Ev_second")).status).toBe("completed")

    const threads = await db.select().from(schema.TagThreadTable)
    const runs = await db.select().from(schema.TagRunTable)
    expect(threads).toHaveLength(1)
    expect(threads[0]).toMatchObject({ workerSessionId: "ses_slack_thread", workerWorkspaceId: "ws_engineering" })
    expect(runs.map((run) => run.status)).toEqual(["completed", "completed"])
    expect(sessionCreates).toBe(1)
    expect(workerPrompts).toHaveLength(2)
    expect(JSON.stringify(workerPrompts[0])).toContain("<openwork_tag_context>")
    expect(JSON.stringify(workerPrompts[1])).toContain("now summarize the evidence")
    expect(slackUpdates.some((text) => text.includes("Verified result 1"))).toBe(true)
    expect(slackUpdates.some((text) => text.includes("Verified result 2"))).toBe(true)

    const longResponse = await sendEvent("Ev_long", {
      type: "message",
      channel: "C_ENGINEERING",
      channel_type: "channel",
      user: "U_MEMBER",
      text: "keep working until cancelled",
      thread_ts: "1700.100",
      ts: "1700.300",
    })
    expect(await longResponse.json()).toEqual({ ok: true, accepted: true })
    const runningDeadline = Date.now() + 5_000
    while (Date.now() < runningDeadline) {
      const currentRuns = await db.select().from(schema.TagRunTable)
      if (currentRuns.some((run) => run.status === "running")) break
      await Bun.sleep(25)
    }
    expect((await db.select().from(schema.TagRunTable)).some((run) => run.status === "running")).toBe(true)

    const cancelStartedAt = Date.now()
    const cancelResponse = await sendEvent("Ev_cancel", {
      type: "message",
      channel: "C_ENGINEERING",
      channel_type: "channel",
      user: "U_MEMBER",
      text: "cancel",
      thread_ts: "1700.100",
      ts: "1700.400",
    })
    expect(await cancelResponse.json()).toEqual({ ok: true, accepted: true })
    expect((await waitForEvent(connectionId, "Ev_cancel")).status).toBe("completed")
    expect(Date.now() - cancelStartedAt).toBeLessThan(2_000)
    expect((await waitForEvent(connectionId, "Ev_long")).status).toBe("completed")

    const finalRuns = await db.select().from(schema.TagRunTable)
    const finalThreads = await db.select().from(schema.TagThreadTable)
    expect(finalRuns.map((run) => run.status)).toEqual(["completed", "completed", "cancelled"])
    expect(finalThreads[0]?.status).toBe("cancelled")
    expect(slackUpdates.some((text) => text.includes("stopped this OpenCode run"))).toBe(true)
    expect(abortRequests).toBe(1)

    await db.update(schema.TagConnectionTable).set({
      installSource: "oauth",
      slackAppId: "A_OPENWORK",
    }).where(drizzle.eq(schema.TagConnectionTable.id, connectionId))
    const revokeLongResponse = await sendEvent("Ev_revoke_long", {
      type: "app_mention",
      channel: "C_ENGINEERING",
      channel_type: "channel",
      user: "U_MEMBER",
      text: "<@U_BOT> keep working until cancelled",
      ts: "1700.500",
    })
    expect(await revokeLongResponse.json()).toEqual({ ok: true, accepted: true })
    const revokeRunningDeadline = Date.now() + 5_000
    while (Date.now() < revokeRunningDeadline) {
      const currentThreads = await db.select().from(schema.TagThreadTable)
      const revokeThread = currentThreads.find((thread) => thread.slackThreadTs === "1700.500")
      const currentRuns = await db.select().from(schema.TagRunTable)
      if (revokeThread && currentRuns.some((run) => run.threadId === revokeThread.id && run.status === "running")) break
      await Bun.sleep(25)
    }
    const revokeThreadBeforeUninstall = (await db.select().from(schema.TagThreadTable))
      .find((thread) => thread.slackThreadTs === "1700.500")
    expect(revokeThreadBeforeUninstall).toBeDefined()
    expect((await db.select().from(schema.TagRunTable)).some(
      (run) => run.threadId === revokeThreadBeforeUninstall?.id && run.status === "running",
    )).toBe(true)

    const uninstallBody = JSON.stringify({
      type: "event_callback",
      api_app_id: "A_OPENWORK",
      event_id: "Ev_uninstall",
      team_id: "T_ACME",
      event: { type: "app_uninstalled" },
    })
    const uninstallTimestamp = String(Math.floor(Date.now() / 1_000))
    const uninstallResponse = await app.request("/v1/webhooks/tag/slack/oauth", {
      body: uninstallBody,
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": uninstallTimestamp,
        "x-slack-signature": signature(uninstallTimestamp, uninstallBody),
      },
      method: "POST",
    })
    expect(await uninstallResponse.json()).toEqual({ ok: true, accepted: true })
    expect((await waitForEvent(connectionId, "Ev_uninstall")).status).toBe("completed")
    const revoked = await store.getTagConnectionById(connectionId)
    expect(revoked).toMatchObject({ status: "error", botToken: "revoked", revokedAt: expect.any(Date) })
    const runsAfterRevocation = await db.select().from(schema.TagRunTable)
    const threadsAfterRevocation = await db.select().from(schema.TagThreadTable)
    const revokeThreadAfterUninstall = threadsAfterRevocation.find((thread) => thread.slackThreadTs === "1700.500")
    expect(runsAfterRevocation.find((run) => run.threadId === revokeThreadAfterUninstall?.id)?.status).toBe("cancelled")
    expect(revokeThreadAfterUninstall?.status).toBe("cancelled")
    expect(abortRequests).toBe(2)
  }, 15_000)
})
