import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { WorkerInstanceTable, WorkerTable, WorkerTokenTable } from "@openwork-ee/den-db/schema"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"

// Requires local MySQL plus the current schema:
// DATABASE_URL=mysql://root:password@127.0.0.1:3306/openwork_test_telegram \
//   DEN_DB_ENCRYPTION_KEY=telegram-test-encryption-key-1234567890 \
//   pnpm --filter @openwork-ee/den-db db:push

let db: typeof import("../src/db.js").db
let drizzle: typeof import("@openwork-ee/den-db/drizzle")
let schema: typeof import("@openwork-ee/den-db/schema/telegram")
let store: typeof import("../src/capability-sources/telegram-store.js")

function seedEnv() {
  process.env.DATABASE_URL = "mysql://root:password@127.0.0.1:3306/openwork_test_telegram"
  process.env.DB_MODE = "mysql"
  process.env.DEN_DB_ENCRYPTION_KEY = "telegram-test-encryption-key-1234567890"
  process.env.BETTER_AUTH_SECRET = "telegram-test-better-auth-secret-123456"
  process.env.BETTER_AUTH_URL = "http://127.0.0.1:8790"
}

async function clearTelegramTables() {
  await db.delete(schema.TelegramUpdateTable)
  await db.delete(schema.TelegramPairingTable)
  await db.delete(schema.TelegramChatBindingTable)
  await db.delete(schema.TelegramConnectionTable)
  await db.delete(WorkerTokenTable)
  await db.delete(WorkerInstanceTable)
  await db.delete(WorkerTable)
}

beforeAll(async () => {
  seedEnv()
  const [dbModule, drizzleModule, schemaModule, storeModule] = await Promise.all([
    import("../src/db.js"),
    import("@openwork-ee/den-db/drizzle"),
    import("@openwork-ee/den-db/schema/telegram"),
    import("../src/capability-sources/telegram-store.js"),
  ])
  db = dbModule.db
  drizzle = drizzleModule
  schema = schemaModule
  store = storeModule
  await clearTelegramTables()
})

beforeEach(clearTelegramTables)
afterAll(clearTelegramTables)

async function seedConnection(label: string, overrides: {
  dispatchStartedAt?: Date | null
  dispatchToken?: string | null
  organizationId?: DenTypeId<"organization">
  webhookSecret?: string
  workerId?: DenTypeId<"worker">
} = {}) {
  const id = createDenTypeId("telegramConnection")
  await db.insert(schema.TelegramConnectionTable).values({
    id,
    organizationId: overrides.organizationId ?? createDenTypeId("organization"),
    workerId: overrides.workerId ?? createDenTypeId("worker"),
    createdByOrgMembershipId: createDenTypeId("member"),
    botToken: `bot-token-${label}`,
    webhookSecret: overrides.webhookSecret ?? `generation-${label}`,
    botId: `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`,
    botUsername: `${label}_bot`,
    botDisplayName: `${label} Bot`,
    status: "active",
    webhookRegistered: true,
    dispatchToken: overrides.dispatchToken ?? null,
    dispatchStartedAt: overrides.dispatchStartedAt ?? null,
  })
  return id
}

async function enqueue(connectionId: DenTypeId<"telegramConnection">, updateId: string) {
  return store.claimTelegramUpdate({
    connectionId,
    payload: JSON.stringify({ update_id: Number(updateId) }),
    updateId,
  })
}

function processingToken(row: Awaited<ReturnType<typeof store.claimNextTelegramUpdate>>) {
  if (!row?.processingToken) throw new Error("expected a claimed Telegram update")
  return row.processingToken
}

function backlogUpdate(
  connectionId: DenTypeId<"telegramConnection">,
  index: number,
): typeof schema.TelegramUpdateTable.$inferInsert {
  return {
    id: createDenTypeId("telegramUpdate"),
    connectionId,
    updateId: `backlog-${index}`,
    payload: "{}",
    status: "accepted",
  }
}

function recentCompletedUpdate(
  connectionId: DenTypeId<"telegramConnection">,
  index: number,
  now: Date,
): typeof schema.TelegramUpdateTable.$inferInsert {
  return {
    id: createDenTypeId("telegramUpdate"),
    connectionId,
    updateId: `rate-${index}`,
    payload: "{}",
    status: "completed",
    completedAt: now,
    receivedAt: now,
  }
}

describe("Telegram durable queue (MySQL)", () => {
  test("recognizes duplicate entries wrapped by the database adapter", () => {
    expect(store.isDuplicateDatabaseEntry({
      message: "Failed query",
      cause: { code: "ER_DUP_ENTRY", errno: 1062 },
    })).toBe(true)
    expect(store.isDuplicateDatabaseEntry({ cause: { message: "Duplicate entry for unique constraint" } })).toBe(true)
    expect(store.isDuplicateDatabaseEntry({ cause: { code: "ER_LOCK_DEADLOCK" } })).toBe(false)
  })

  test("pairing rotation and redemption serialize without letting the old token bind", async () => {
    const connectionId = await seedConnection("pairing-race", { dispatchToken: "pairing-dispatch" })
    await store.createTelegramPairing({
      connectionId,
      expiresAt: new Date(Date.now() + 60_000),
      tokenHash: "old-pairing-token",
    })
    const oldPairings = await db.select({ id: schema.TelegramPairingTable.id })
      .from(schema.TelegramPairingTable)
      .where(drizzle.eq(schema.TelegramPairingTable.tokenHash, "old-pairing-token"))
    const oldPairing = oldPairings[0]
    if (!oldPairing) throw new Error("missing old pairing")

    let markLocked = () => undefined
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve
    })
    let releaseLock = () => undefined
    const released = new Promise<void>((resolve) => {
      releaseLock = resolve
    })
    const heldLock = db.transaction(async (tx) => {
      await tx.select({ id: schema.TelegramPairingTable.id })
        .from(schema.TelegramPairingTable)
        .where(drizzle.eq(schema.TelegramPairingTable.id, oldPairing.id))
        .limit(1)
        .for("update")
      markLocked()
      await released
    })
    await locked

    const rotation = store.createTelegramPairing({
      connectionId,
      expiresAt: new Date(Date.now() + 60_000),
      tokenHash: "new-pairing-token",
    })
    await Bun.sleep(25)
    const redemption = store.consumeTelegramPairing({
      chatId: "777",
      connectionId,
      dispatchToken: "pairing-dispatch",
      firstName: "Ada",
      tokenHash: "old-pairing-token",
      userId: "777",
      username: "ada",
    })
    await Bun.sleep(25)
    releaseLock()

    const [, result] = await Promise.all([rotation, redemption, heldLock])
    expect(result).toEqual({ paired: false })
    await expect(store.getTelegramChatBinding(connectionId)).resolves.toBeNull()
    const currentPairings = await db.select({ tokenHash: schema.TelegramPairingTable.tokenHash })
      .from(schema.TelegramPairingTable)
      .where(drizzle.eq(schema.TelegramPairingTable.connectionId, connectionId))
    expect(currentPairings).toEqual([{ tokenHash: "new-pairing-token" }])
  })

  test("connection view requires a healthy latest worker instance and live host/client tokens", async () => {
    const organizationId = createDenTypeId("organization")
    const workerId = createDenTypeId("worker")
    await db.insert(WorkerTable).values({
      id: workerId,
      org_id: organizationId,
      name: "Telegram Worker",
      destination: "cloud",
      status: "healthy",
    })
    const instanceId = createDenTypeId("workerInstance")
    await db.insert(WorkerInstanceTable).values({
      id: instanceId,
      worker_id: workerId,
      provider: "daytona",
      status: "healthy",
      url: "https://worker.example",
    })
    await db.insert(WorkerTokenTable).values([
      { id: createDenTypeId("workerToken"), worker_id: workerId, scope: "host", token: "host-token" },
      { id: createDenTypeId("workerToken"), worker_id: workerId, scope: "client", token: "client-token" },
    ])
    const connectionId = await seedConnection("view-health", { organizationId, workerId })
    const connection = await store.getTelegramConnectionById(connectionId)
    if (!connection) throw new Error("missing Telegram connection")

    await expect(store.telegramConnectionView(connection)).resolves.toMatchObject({
      connected: true,
      worker: { status: "healthy" },
    })

    await db.update(WorkerInstanceTable)
      .set({ status: "failed" })
      .where(drizzle.eq(WorkerInstanceTable.id, instanceId))
    await expect(store.telegramConnectionView(connection)).resolves.toMatchObject({
      connected: false,
      worker: { status: "healthy" },
    })
  })

  test("connection leases exclude concurrent work but allow different connections", async () => {
    const connectionA = await seedConnection("lease-a")
    const connectionB = await seedConnection("lease-b")
    await enqueue(connectionA, "101")
    await enqueue(connectionA, "102")
    await enqueue(connectionB, "201")

    const first = await store.claimNextTelegramUpdate()
    const second = await store.claimNextTelegramUpdate()
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(new Set([first?.connectionId, second?.connectionId])).toEqual(new Set([connectionA, connectionB]))

    const third = await store.claimNextTelegramUpdate()
    expect(third).toBeNull()
  })

  test("a stale lease is taken over with a new processing token", async () => {
    const connectionId = await seedConnection("takeover")
    await enqueue(connectionId, "301")
    const first = await store.claimNextTelegramUpdate()
    const firstToken = processingToken(first)
    const stale = new Date(Date.now() - 10 * 60_000)
    await db.update(schema.TelegramConnectionTable)
      .set({ dispatchStartedAt: stale })
      .where(drizzle.eq(schema.TelegramConnectionTable.id, connectionId))
    if (!first) throw new Error("missing first claim")
    await db.update(schema.TelegramUpdateTable)
      .set({ processingStartedAt: stale })
      .where(drizzle.eq(schema.TelegramUpdateTable.id, first.id))

    const reclaimed = await store.claimNextTelegramUpdate()
    expect(reclaimed?.id).toBe(first.id)
    expect(processingToken(reclaimed)).not.toBe(firstToken)
    expect(reclaimed?.attempts).toBe(2)
  })

  test("processing-token fencing blocks an old processor from completing a reclaimed row", async () => {
    const connectionId = await seedConnection("fence")
    await enqueue(connectionId, "401")
    const claimed = await store.claimNextTelegramUpdate()
    const token = processingToken(claimed)
    if (!claimed) throw new Error("missing claim")

    await store.setTelegramUpdateStatus({
      connectionId,
      id: claimed.id,
      processingToken: "obsolete-token",
      status: "completed",
    })
    let rows = await db.select().from(schema.TelegramUpdateTable)
      .where(drizzle.eq(schema.TelegramUpdateTable.id, claimed.id))
    expect(rows[0]?.status).toBe("processing")
    expect(rows[0]?.processingToken).toBe(token)

    await store.setTelegramUpdateStatus({
      connectionId,
      id: claimed.id,
      processingToken: token,
      status: "completed",
    })
    rows = await db.select().from(schema.TelegramUpdateTable)
      .where(drizzle.eq(schema.TelegramUpdateTable.id, claimed.id))
    expect(rows[0]?.status).toBe("completed")
    expect(rows[0]?.processingToken).toBeNull()
  })

  test("transient failure requeues with backoff and a later attempt can complete", async () => {
    const connectionId = await seedConnection("retry-success")
    await enqueue(connectionId, "451")
    const first = await store.claimNextTelegramUpdate()
    const firstToken = processingToken(first)
    if (!first) throw new Error("missing first retry claim")

    expect(await store.retryTelegramUpdate({
      connectionId,
      error: "worker returned 503",
      id: first.id,
      processingToken: firstToken,
    })).toBe("requeued")
    let rows = await db.select().from(schema.TelegramUpdateTable)
      .where(drizzle.eq(schema.TelegramUpdateTable.id, first.id))
    expect(rows[0]).toMatchObject({ attempts: 1, error: "worker returned 503", status: "accepted" })
    expect(rows[0]?.processingToken).toBeNull()
    expect(rows[0]?.processingStartedAt?.getTime()).toBeGreaterThan(Date.now())
    expect(await store.claimNextTelegramUpdate()).toBeNull()

    await db.update(schema.TelegramUpdateTable)
      .set({ processingStartedAt: new Date(Date.now() - 1_000) })
      .where(drizzle.eq(schema.TelegramUpdateTable.id, first.id))
    const second = await store.claimNextTelegramUpdate()
    const secondToken = processingToken(second)
    expect(second?.id).toBe(first.id)
    expect(second?.attempts).toBe(2)
    expect(secondToken).not.toBe(firstToken)
    expect(await store.retryTelegramUpdate({
      connectionId,
      error: "stale processor",
      id: first.id,
      processingToken: firstToken,
    })).toBe("stale")

    await store.setTelegramUpdateStatus({
      connectionId,
      id: first.id,
      processingToken: secondToken,
      status: "completed",
    })
    rows = await db.select().from(schema.TelegramUpdateTable)
      .where(drizzle.eq(schema.TelegramUpdateTable.id, first.id))
    expect(rows[0]).toMatchObject({ attempts: 2, status: "completed" })
  })

  test("transient failures become terminal on the third attempt", async () => {
    const connectionId = await seedConnection("retry-exhausted")
    const queued = await enqueue(connectionId, "452")

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claimed = await store.claimNextTelegramUpdate()
      const token = processingToken(claimed)
      expect(claimed?.id).toBe(queued.id)
      expect(claimed?.attempts).toBe(attempt)
      expect(await store.retryTelegramUpdate({
        connectionId,
        error: `transient failure ${attempt}`,
        id: queued.id,
        processingToken: token,
      })).toBe(attempt === 3 ? "failed" : "requeued")
      if (attempt < 3) {
        await db.update(schema.TelegramUpdateTable)
          .set({ processingStartedAt: new Date(Date.now() - 1_000) })
          .where(drizzle.eq(schema.TelegramUpdateTable.id, queued.id))
      }
    }

    const rows = await db.select().from(schema.TelegramUpdateTable)
      .where(drizzle.eq(schema.TelegramUpdateTable.id, queued.id))
    const connections = await db.select().from(schema.TelegramConnectionTable)
      .where(drizzle.eq(schema.TelegramConnectionTable.id, connectionId))
    expect(rows[0]).toMatchObject({ attempts: 3, error: "transient failure 3", status: "failed" })
    expect(rows[0]?.completedAt).not.toBeNull()
    expect(rows[0]?.processingToken).toBeNull()
    expect(connections[0]?.dispatchToken).toBeNull()
  })

  test("stale updates at the attempt limit become failed and release their lease", async () => {
    const stale = new Date(Date.now() - 10 * 60_000)
    const connectionId = await seedConnection("exhausted", {
      dispatchStartedAt: stale,
      dispatchToken: "exhausted-token",
    })
    const queued = await enqueue(connectionId, "501")
    await db.update(schema.TelegramUpdateTable)
      .set({
        attempts: 3,
        processingStartedAt: stale,
        processingToken: "exhausted-token",
        status: "processing",
      })
      .where(drizzle.eq(schema.TelegramUpdateTable.id, queued.id))

    expect(await store.claimNextTelegramUpdate()).toBeNull()
    const updates = await db.select().from(schema.TelegramUpdateTable)
      .where(drizzle.eq(schema.TelegramUpdateTable.id, queued.id))
    const connections = await db.select().from(schema.TelegramConnectionTable)
      .where(drizzle.eq(schema.TelegramConnectionTable.id, connectionId))
    expect(updates[0]?.status).toBe("failed")
    expect(updates[0]?.error).toContain("retry limit")
    expect(connections[0]?.dispatchToken).toBeNull()
  })

  test("intake enforces backlog and per-minute limits", async () => {
    const backlogConnection = await seedConnection("backlog")
    await db.insert(schema.TelegramUpdateTable).values(
      Array.from({ length: 20 }, (_, index) => backlogUpdate(backlogConnection, index)),
    )
    expect(await store.telegramUpdateIntakeAllowed(backlogConnection)).toBe(false)

    const rateConnection = await seedConnection("rate")
    const now = new Date()
    await db.insert(schema.TelegramUpdateTable).values(
      Array.from({ length: 30 }, (_, index) => recentCompletedUpdate(rateConnection, index, now)),
    )
    expect(await store.telegramUpdateIntakeAllowed(rateConnection)).toBe(false)
  })

  test("claim-time retention removes terminal updates older than 30 days", async () => {
    const connectionId = await seedConnection("retention")
    const oldId = createDenTypeId("telegramUpdate")
    const old = new Date(Date.now() - 31 * 24 * 60 * 60_000)
    await db.insert(schema.TelegramUpdateTable).values({
      id: oldId,
      connectionId,
      updateId: "old",
      payload: "{}",
      status: "completed",
      receivedAt: old,
      completedAt: old,
    })

    await enqueue(connectionId, "601")
    const rows = await db.select({ id: schema.TelegramUpdateTable.id })
      .from(schema.TelegramUpdateTable)
      .where(drizzle.eq(schema.TelegramUpdateTable.id, oldId))
    expect(rows).toHaveLength(0)
  })

  test("session persistence is fenced by dispatch lease and webhook generation", async () => {
    const connectionId = await seedConnection("session", {
      dispatchToken: "lease-current",
      webhookSecret: "generation-current",
    })
    const bindingId = createDenTypeId("telegramChatBinding")
    await db.insert(schema.TelegramChatBindingTable).values({
      id: bindingId,
      connectionId,
      telegramChatId: "777",
      telegramUserId: "777",
      telegramFirstName: "Ada",
    })

    expect(await store.saveTelegramWorkerSession({
      bindingId,
      connectionId,
      dispatchToken: "lease-current",
      generation: "generation-current",
      sessionId: "ses_current",
      workspaceId: "ws_current",
    })).toBe(true)

    await db.update(schema.TelegramConnectionTable)
      .set({ dispatchToken: "lease-new", webhookSecret: "generation-new" })
      .where(drizzle.eq(schema.TelegramConnectionTable.id, connectionId))
    expect(await store.saveTelegramWorkerSession({
      bindingId,
      connectionId,
      dispatchToken: "lease-current",
      generation: "generation-current",
      sessionId: "ses_stale",
      workspaceId: "ws_stale",
    })).toBe(false)

    const bindings = await db.select().from(schema.TelegramChatBindingTable)
      .where(drizzle.eq(schema.TelegramChatBindingTable.id, bindingId))
    expect(bindings[0]?.workerSessionId).toBe("ses_current")
    expect(bindings[0]?.workerWorkspaceId).toBe("ws_current")
  })
})
