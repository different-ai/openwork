import assert from "node:assert/strict"
import test from "node:test"
import { sql } from "drizzle-orm"
import { createDenDb, readReplicaCredentialsFromEnv } from "../src/client.ts"

const planetscale = { host: "db.example.internal", username: "primary-user", password: "primary-secret" }
const databaseUrl = "mysql://primary-user:primary-secret@127.0.0.1:3306/openwork_den"

test("read replica credentials need both the username and the password", () => {
  assert.deepEqual(readReplicaCredentialsFromEnv({ DATABASE_READ_USERNAME: " reader ", DATABASE_READ_PASSWORD: "secret" }), {
    username: "reader",
    password: "secret",
  })
  assert.equal(readReplicaCredentialsFromEnv({}), null)
  assert.equal(readReplicaCredentialsFromEnv({ DATABASE_READ_USERNAME: "reader", DATABASE_READ_PASSWORD: "" }), null)
  assert.equal(readReplicaCredentialsFromEnv({ DATABASE_READ_PASSWORD: "secret" }), null)
})

test("without replica credentials, reads and writes share the primary", async () => {
  const planetscaleDb = createDenDb({ mode: "planetscale", planetscale })
  assert.equal(planetscaleDb.readClient, null)
  assert.equal(planetscaleDb.db.$replicas[0], planetscaleDb.db.$primary)

  const mysqlDb = createDenDb({ mode: "mysql", databaseUrl })
  assert.equal(mysqlDb.readClient, null)
  assert.equal(mysqlDb.db.$replicas[0], mysqlDb.db.$primary)
  await mysqlDb.client.end()
})

test("with replica credentials, reads get their own client on the same host", async () => {
  const readReplica = { username: "reader", password: "reader-secret" }

  const planetscaleDb = createDenDb({ mode: "planetscale", planetscale, readReplica })
  assert.ok(planetscaleDb.readClient)
  assert.notEqual(planetscaleDb.db.$replicas[0], planetscaleDb.db.$primary)
  assert.equal(planetscaleDb.readClient.config.host, planetscale.host)
  assert.equal(planetscaleDb.readClient.config.username, "reader")
  assert.equal(planetscaleDb.client.config.username, "primary-user")

  const mysqlDb = createDenDb({ mode: "mysql", databaseUrl, readReplica })
  assert.ok(mysqlDb.readClient)
  assert.notEqual(mysqlDb.db.$replicas[0], mysqlDb.db.$primary)
  assert.equal(mysqlDb.readClient.pool.config.connectionConfig.user, "reader")
  assert.equal(mysqlDb.readClient.pool.config.connectionConfig.host, "127.0.0.1")
  assert.equal(mysqlDb.client.pool.config.connectionConfig.user, "primary-user")
  await Promise.all([mysqlDb.client.end(), mysqlDb.readClient.end()])
})

test("selects run on the replica; writes and $primary reads run on the primary", async () => {
  const { client, readClient, db } = createDenDb({
    mode: "planetscale",
    planetscale,
    readReplica: { username: "reader", password: "reader-secret" },
  })
  assert.ok(readClient)
  const calls: string[] = []
  const record = (target: string) => async (query: string) => {
    calls.push(`${target}:${query.trimStart().split(/\s+/, 1)[0]?.toLowerCase()}`)
    return { headers: [], types: {}, fields: [], rows: [], rowsAffected: 0, insertId: "0", size: 0, statement: query, time: 0 }
  }
  Object.assign(client, { execute: record("primary") })
  Object.assign(readClient, { execute: record("replica") })

  const { user } = await import("../src/schema.ts")
  await db.select().from(user).limit(1)
  await db.$primary.select().from(user).limit(1)
  await db.update(user).set({ name: "x" }).where(sql`1 = 0`)

  assert.deepEqual(calls, ["replica:select", "primary:select", "primary:update"])
})

test("readFromPrimary sends replica-routed reads to the primary while it returns true", async () => {
  let pinned = false
  const { client, readClient, db } = createDenDb({
    mode: "planetscale",
    planetscale,
    readReplica: { username: "reader", password: "reader-secret" },
    readFromPrimary: () => pinned,
  })
  assert.ok(readClient)
  const calls: string[] = []
  const record = (target: string) => async (query: string) => {
    calls.push(`${target}:${query.trimStart().split(/\s+/, 1)[0]?.toLowerCase()}`)
    return { headers: [], types: {}, fields: [], rows: [], rowsAffected: 0, insertId: "0", size: 0, statement: query, time: 0 }
  }
  Object.assign(client, { execute: record("primary") })
  Object.assign(readClient, { execute: record("replica") })

  const { user } = await import("../src/schema.ts")
  await db.select().from(user).limit(1)
  pinned = true
  await db.select().from(user).limit(1)

  assert.deepEqual(calls, ["replica:select", "primary:select"])
})
