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

  const planetscaleDb = createDenDb({ mode: "planetscale", planetscale, readReplica, replicaCheckIntervalMs: 0 })
  assert.ok(planetscaleDb.readClient)
  assert.notEqual(planetscaleDb.db.$replicas[0], planetscaleDb.db.$primary)
  assert.equal(planetscaleDb.readClient.config.host, planetscale.host)
  assert.equal(planetscaleDb.readClient.config.username, "reader")
  assert.equal(planetscaleDb.client.config.username, "primary-user")

  const mysqlDb = createDenDb({ mode: "mysql", databaseUrl, readReplica, replicaCheckIntervalMs: 0 })
  assert.ok(mysqlDb.readClient)
  assert.notEqual(mysqlDb.db.$replicas[0], mysqlDb.db.$primary)
  assert.equal(mysqlDb.readClient.pool.config.connectionConfig.user, "reader")
  assert.equal(mysqlDb.readClient.pool.config.connectionConfig.host, "127.0.0.1")
  assert.equal(mysqlDb.client.pool.config.connectionConfig.user, "primary-user")
  await Promise.all([mysqlDb.client.end(), mysqlDb.readClient.end()])
})

/**
 * A PlanetScale Den whose two clients record every statement. Heartbeat reads
 * answer with the beat each side holds, so a test decides how current the
 * replica is; other statements return no rows.
 */
function recordedDb(options: { readFromPrimary?: () => boolean; logged?: string[] } = {}) {
  const den = createDenDb({
    mode: "planetscale",
    planetscale,
    readReplica: { username: "reader", password: "reader-secret" },
    replicaCheckIntervalMs: 0,
    ...(options.readFromPrimary ? { readFromPrimary: options.readFromPrimary } : {}),
    ...(options.logged ? { logger: { logQuery: (query: string) => { options.logged?.push(query) } } } : {}),
  })
  assert.ok(den.readClient)
  assert.ok(den.replicaHealth)
  const beats: { primary: string | null; replica: string | null } = { primary: "2026-11-03 19:00:10.000", replica: "2026-11-03 19:00:10.000" }
  const calls: string[] = []
  const record = (target: "primary" | "replica") => async (query: string) => {
    const heartbeat = query.includes("db_replica_heartbeat")
    if (!heartbeat) calls.push(`${target}:${query.trimStart().split(/\s+/, 1)[0]?.toLowerCase()}`)
    const beat = beats[target]
    const rows = heartbeat && /^\s*select/i.test(query) && beat ? [[beat]] : []
    return { headers: [], types: {}, fields: [], rows, rowsAffected: 0, insertId: "0", size: 0, statement: query, time: 0 }
  }
  Object.assign(den.client, { execute: record("primary") })
  Object.assign(den.readClient, { execute: record("replica") })
  return { ...den, replicaHealth: den.replicaHealth, beats, calls }
}

test("selects run on the replica once it is current; writes and $primary reads run on the primary", async () => {
  const { db, replicaHealth, calls } = recordedDb()
  const { user } = await import("../src/schema.ts")
  await db.select().from(user).limit(1)
  assert.equal(await replicaHealth.check(), true)
  await db.select().from(user).limit(1)
  await db.$primary.select().from(user).limit(1)
  await db.update(user).set({ name: "x" }).where(sql`1 = 0`)

  assert.deepEqual(calls, ["primary:select", "replica:select", "primary:select", "primary:update"])
})

test("readFromPrimary sends replica-routed reads to the primary while it returns true", async () => {
  let pinned = false
  const { db, replicaHealth, calls } = recordedDb({ readFromPrimary: () => pinned })
  await replicaHealth.check()
  const { user } = await import("../src/schema.ts")
  await db.select().from(user).limit(1)
  pinned = true
  await db.select().from(user).limit(1)

  assert.deepEqual(calls, ["replica:select", "primary:select"])
})

test("a replica that lacks this process's beat, or trails it, sends reads back to the primary", async () => {
  const { db, replicaHealth, beats, calls } = recordedDb()
  const { user } = await import("../src/schema.ts")
  await replicaHealth.check()
  beats.replica = null
  assert.equal(await replicaHealth.check(), false, "another database never receives this process's beat")
  await db.select().from(user).limit(1)
  beats.replica = "2026-11-02 21:30:00.000"
  assert.equal(await replicaHealth.check(), false, "a copy frozen a day ago is not current")
  await db.select().from(user).limit(1)
  beats.replica = beats.primary
  assert.equal(await replicaHealth.check(), true)
  await db.select().from(user).limit(1)

  assert.deepEqual(calls, ["primary:select", "primary:select", "replica:select"])
})

test("heartbeats never reach the query logger", async () => {
  const logged: string[] = []
  const { db, replicaHealth } = recordedDb({ logged })
  await replicaHealth.check()
  const { user } = await import("../src/schema.ts")
  await db.select().from(user).limit(1)
  assert.equal(logged.length, 1)
  assert.equal(logged.some((query) => query.includes("db_replica_heartbeat")), false)
})

test("without replica credentials there is no health check", async () => {
  const den = createDenDb({ mode: "planetscale", planetscale })
  assert.equal(den.replicaHealth, null)
})
