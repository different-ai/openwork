import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { Buffer } from "node:buffer"

let db: typeof import("../src/db.js").db
let drizzle: typeof import("@openwork-ee/den-db/drizzle")
let schema: typeof import("@openwork-ee/den-db/schema/tag")
let store: typeof import("../src/capability-sources/tag-store.js")
let oauth: typeof import("../src/capability-sources/tag-slack-oauth.js")

function seedEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_tag"
  process.env.DB_MODE = "mysql"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "tag-test-encryption-key-1234567890123"
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "tag-test-better-auth-secret-123456789"
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
}

async function clearTagTables() {
  await db.delete(schema.TagRunTable)
  await db.delete(schema.TagThreadTable)
  await db.delete(schema.TagEventTable)
  await db.delete(schema.TagChannelTable)
  await db.delete(schema.TagConnectionTable)
  await db.delete(schema.TagOAuthStateTable)
}

beforeAll(async () => {
  seedEnv()
  const [dbModule, drizzleModule, schemaModule, storeModule, oauthModule] = await Promise.all([
    import("../src/db.js"),
    import("@openwork-ee/den-db/drizzle"),
    import("@openwork-ee/den-db/schema/tag"),
    import("../src/capability-sources/tag-store.js"),
    import("../src/capability-sources/tag-slack-oauth.js"),
  ])
  db = dbModule.db
  drizzle = drizzleModule
  schema = schemaModule
  store = storeModule
  oauth = oauthModule
  await clearTagTables()
})

beforeEach(clearTagTables)
afterAll(clearTagTables)

async function seedConnection() {
  const id = createDenTypeId("tagConnection")
  await db.insert(schema.TagConnectionTable).values({
    id,
    organizationId: createDenTypeId("organization"),
    workerId: createDenTypeId("worker"),
    createdByOrgMembershipId: createDenTypeId("member"),
    botToken: "xoxb-encrypted-at-column-boundary",
    signingSecret: "signing-generation-1",
    slackTeamId: `T${Date.now()}`,
    slackTeamName: "Acme",
    botUserId: "U_BOT",
    botName: "openwork",
    serviceName: "Builder",
    defaultInstructions: "Run focused tests.",
    allowedUserIds: JSON.stringify(["U1", "U2"]),
    allowGuests: false,
    allowSharedChannels: false,
    status: "active",
  })
  await db.insert(schema.TagChannelTable).values({
    id: createDenTypeId("tagChannel"),
    connectionId: id,
    slackChannelId: "C1",
    slackChannelName: "engineering",
  })
  return id
}

describe("OpenWork Tag durable state (MySQL)", () => {
  test("consumes OAuth setup once and fences rotating-token persistence with a lease", async () => {
    const connectionId = await seedConnection()
    const connection = await store.getTagConnectionById(connectionId)
    if (!connection) throw new Error("missing Tag connection")
    const state = "signed.oauth.state"
    await store.saveTagOAuthState({
      organizationId: connection.organizationId,
      orgMembershipId: connection.createdByOrgMembershipId,
      payload: JSON.stringify({ channels: ["C1"] }),
      state,
    })
    const consumed = await store.consumeTagOAuthState({
      organizationId: connection.organizationId,
      orgMembershipId: connection.createdByOrgMembershipId,
      state,
    })
    expect(consumed?.payload).toContain("C1")
    await expect(store.consumeTagOAuthState({
      organizationId: connection.organizationId,
      orgMembershipId: connection.createdByOrgMembershipId,
      state,
    })).resolves.toBeNull()

    await db.update(schema.TagConnectionTable).set({
      installSource: "oauth",
      refreshToken: "refresh-1",
      tokenExpiresAt: new Date(Date.now() - 1_000),
    }).where(drizzle.eq(schema.TagConnectionTable.id, connectionId))
    const lease = await store.claimTagTokenRefresh(connectionId)
    expect(lease?.connection.refreshToken).toBe("refresh-1")
    await expect(store.claimTagTokenRefresh(connectionId)).resolves.toBeNull()
    if (!lease) throw new Error("missing OAuth refresh lease")
    expect(await store.completeTagTokenRefresh({
      accessToken: "access-2",
      connectionId,
      expiresAt: new Date(Date.now() + 60_000),
      lease: lease.lease,
      refreshToken: "refresh-2",
      scopes: ["chat:write", "app_mentions:read"],
    })).toBe(true)
    const refreshed = await store.getTagConnectionById(connectionId)
    expect(refreshed).toMatchObject({
      botToken: "access-2",
      refreshToken: "refresh-2",
      tokenRefreshLease: null,
    })

    await db.update(schema.TagConnectionTable).set({
      tokenExpiresAt: new Date(Date.now() - 1_000),
    }).where(drizzle.eq(schema.TagConnectionTable.id, connectionId))
    let refreshAuthorization = ""
    let refreshBody = ""
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        refreshAuthorization = request.headers.get("authorization") ?? ""
        refreshBody = await request.text()
        return Response.json({
          ok: true,
          access_token: "access-3",
          refresh_token: "refresh-3",
          expires_in: 43_200,
          scope: "app_mentions:read,chat:write",
          token_type: "bot",
        })
      },
    })
    const expiring = await store.getTagConnectionById(connectionId)
    if (!expiring) throw new Error("missing expiring OAuth connection")
    const rotated = await oauth.ensureFreshTagConnection(expiring, {
      config: {
        accessUrl: server.url.toString(),
        authorizeUrl: "https://slack.com/oauth/v2/authorize",
        clientId: "client-id",
        clientSecret: "client-secret",
        signingSecret: "signing-secret",
      },
    })
    server.stop(true)
    expect(rotated).toMatchObject({ botToken: "access-3", refreshToken: "refresh-3", status: "active" })
    expect(refreshAuthorization).toBe(`Basic ${Buffer.from("client-id:client-secret").toString("base64")}`)
    expect(refreshBody).toContain("grant_type=refresh_token")
    expect(refreshBody).toContain("refresh_token=refresh-2")
  })

  test("dedupes Slack events before work and fences completion with the processing token", async () => {
    const connectionId = await seedConnection()
    const first = await store.claimTagEvent({ connectionId, payload: "{}", slackEventId: "Ev1" })
    const duplicate = await store.claimTagEvent({ connectionId, payload: "{}", slackEventId: "Ev1" })
    expect(first.claimed).toBe(true)
    expect(duplicate).toEqual({ claimed: false, id: first.id })

    const claimed = await store.claimNextTagEvent()
    expect(claimed?.id).toBe(first.id)
    expect(claimed?.attempts).toBe(1)
    if (!claimed?.processingToken) throw new Error("expected a processing token")

    await store.setTagEventStatus({
      connectionId,
      id: first.id,
      processingToken: "obsolete-token",
      status: "completed",
    })
    let rows = await db.select().from(schema.TagEventTable).where(drizzle.eq(schema.TagEventTable.id, first.id))
    expect(rows[0]?.status).toBe("processing")

    await store.setTagEventStatus({
      connectionId,
      id: first.id,
      processingToken: claimed.processingToken,
      status: "completed",
    })
    rows = await db.select().from(schema.TagEventTable).where(drizzle.eq(schema.TagEventTable.id, first.id))
    expect(rows[0]).toMatchObject({ status: "completed", processingToken: null })
  })

  test("maps one Slack thread to one session and freezes a verifiable policy snapshot", async () => {
    const connectionId = await seedConnection()
    const connection = await store.getTagConnectionById(connectionId)
    if (!connection) throw new Error("missing Tag connection")
    const snapshot = {
      allowGuests: false,
      allowSharedChannels: false,
      channelId: "C1",
      channelName: "engineering",
      instructions: "Run focused tests.",
      serviceName: "Builder",
      version: 1 as const,
      workerId: connection.workerId,
    }
    const first = await store.getOrCreateTagThread({
      connectionId,
      enterpriseId: null,
      slackChannelId: "C1",
      slackTeamId: connection.slackTeamId,
      slackThreadTs: "1700.1",
      snapshot,
      startedBySlackUserId: "U1",
    })
    const second = await store.getOrCreateTagThread({
      connectionId,
      enterpriseId: null,
      slackChannelId: "C1",
      slackTeamId: connection.slackTeamId,
      slackThreadTs: "1700.1",
      snapshot: { ...snapshot, instructions: "A later policy that must not replace the snapshot." },
      startedBySlackUserId: "U2",
    })
    expect(second.id).toBe(first.id)
    expect(second.configSnapshot).toBe(first.configSnapshot)
    expect(second.configSnapshotHash).toHaveLength(64)
    expect(store.parseTagConfigSnapshot(second.configSnapshot)).toEqual(snapshot)

    const event = await store.claimTagEvent({ connectionId, payload: "{}", slackEventId: "Ev2" })
    const claimed = await store.claimNextTagEvent()
    if (!claimed?.processingToken) throw new Error("expected a processing token")
    expect(await store.saveTagWorkerSession({
      connectionId,
      dispatchToken: claimed.processingToken,
      generation: connection.signingSecret,
      sessionId: "ses_real",
      threadId: first.id,
      workspaceId: "ws_real",
    })).toBe(true)
    const bound = await store.findTagThread({ channelId: "C1", connectionId, threadTs: "1700.1" })
    expect(bound).toMatchObject({ workerSessionId: "ses_real", workerWorkspaceId: "ws_real" })

    const run = await store.createTagRun({ eventId: event.id, prompt: "Fix checkout", slackUserId: "U1", threadId: first.id })
    await store.updateTagRun({ id: run.id, response: "Fixed and tested", status: "completed" })
    const runs = await store.listTagRuns(connection.organizationId)
    expect(runs[0]).toMatchObject({
      prompt: "Fix checkout",
      response: "Fixed and tested",
      sessionId: "ses_real",
      snapshotHash: first.configSnapshotHash,
      status: "completed",
    })
  })
})
