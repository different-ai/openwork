import { spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { eq, sql } from "drizzle-orm"
import mysql, { type Connection } from "mysql2/promise"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { createDenDb } from "./client"
import { readLicenseSnapshot, writeLicenseSnapshot } from "./license-snapshot"
import {
  compareAndSetOrganizationModules,
  emptyOrganizationModules,
  OrganizationModulesCorruptError,
  OrganizationModulesTooLargeError,
  readOrganizationModules,
  repairOrganizationModules,
  updateOrganizationModules,
} from "./organization-modules"
import { OrganizationTable } from "./schema/org"
import { LicenseSnapshotTable } from "./schema/system"

const serverUrl = (process.env.DEN_DB_TEST_MYSQL_URL?.trim() || "mysql://root:password@127.0.0.1:3306").replace(/\/+$/, "")
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

async function mysqlReachable() {
  try {
    const connection = await mysql.createConnection(serverUrl)
    await connection.end()
    return true
  } catch {
    return false
  }
}

const available = await mysqlReachable()
if (!available) console.warn("Skipping organization.modules MySQL tests: no MySQL at DEN_DB_TEST_MYSQL_URL (default 127.0.0.1:3306). Start one with `pnpm dev:den:mysql`.")

/** The current-schema DDL for the two tables under test, straight from the Drizzle schema. */
function currentTableDdl(tables: string[]) {
  const result = spawnSync(process.execPath, ["--conditions=development", "--import", "tsx", path.join(packageDir, "node_modules", "drizzle-kit", "bin.cjs"), "export", "--config", "drizzle.config.ts"], {
    cwd: packageDir,
    encoding: "utf8",
  })
  if (result.status !== 0) throw new Error(`drizzle-kit export failed: ${result.stderr.slice(0, 2000)}`)
  const statements = result.stdout.replace(/\r\n/g, "\n").split(/\n\s*\n/).map((statement) => statement.trim())
  return tables.map((table) => {
    const statement = statements.find((candidate) => candidate.startsWith(`CREATE TABLE \`${table}\` (`))
    if (!statement) throw new Error(`No CREATE TABLE for ${table} in drizzle-kit export`)
    return statement
  })
}

describe.skipIf(!available)("organization.modules storage (MySQL)", () => {
  const databaseName = `openwork_den_modules_test_${randomBytes(4).toString("hex")}`
  const now = new Date("2026-10-05T12:00:00.000Z")
  let admin: Connection
  let handle: ReturnType<typeof createDenDb>

  beforeAll(async () => {
    admin = await mysql.createConnection(serverUrl)
    await admin.query(`CREATE DATABASE \`${databaseName}\``)
    await admin.query(`USE \`${databaseName}\``)
    for (const ddl of currentTableDdl(["organization", "license_snapshot"])) await admin.query(ddl)
    handle = createDenDb({ databaseUrl: `${serverUrl}/${databaseName}`, mode: "mysql" })
  })

  afterAll(async () => {
    if ("end" in handle.client) await handle.client.end()
    await admin.query(`DROP DATABASE IF EXISTS \`${databaseName}\``)
    await admin.end()
  })

  async function createOrganization() {
    const id = createDenTypeId("organization")
    await handle.db.insert(OrganizationTable).values({ id, name: "Synthetic", slug: id })
    return id
  }

  async function rawRow(id: typeof OrganizationTable.$inferSelect.id) {
    const [row] = await handle.db.select({ modules: OrganizationTable.modules, updatedAt: OrganizationTable.updatedAt }).from(OrganizationTable).where(eq(OrganizationTable.id, id))
    return row
  }

  test("the first write replaces NULL with revision 1 and a stale revision conflicts", async () => {
    const id = await createOrganization()
    expect(await readOrganizationModules(handle.db, id)).toEqual({ status: "absent", doc: null, revision: 0 })
    const first = await compareAndSetOrganizationModules(handle.db, { organizationId: id, expectedRevision: 0, kind: "toggle", next: { ...emptyOrganizationModules(now), revision: 1, disabled: ["installLinks", "connect", "connect"] } })
    expect(first).toEqual({ ok: true, doc: { ...emptyOrganizationModules(now), revision: 1, disabled: ["connect", "installLinks"] } })
    expect((await readOrganizationModules(handle.db, id))?.revision).toBe(1)

    const stale = await compareAndSetOrganizationModules(handle.db, { organizationId: id, expectedRevision: 0, kind: "toggle", next: { ...emptyOrganizationModules(now), revision: 1 } })
    expect(stale).toEqual({ ok: false, reason: "conflict", currentRevision: 1 })
    await expect(compareAndSetOrganizationModules(handle.db, { organizationId: id, expectedRevision: 1, kind: "toggle", next: { ...emptyOrganizationModules(now), revision: 3 } }))
      .rejects.toThrow("revision must be 2")
  })

  test("unknown orgs report not_found and oversized documents throw a typed error", async () => {
    expect(await compareAndSetOrganizationModules(handle.db, { organizationId: createDenTypeId("organization"), expectedRevision: 0, kind: "toggle", next: { ...emptyOrganizationModules(now), revision: 1 } }))
      .toEqual({ ok: false, reason: "not_found" })
    expect(await updateOrganizationModules(handle.db, { organizationId: createDenTypeId("organization"), kind: "toggle", actorMemberId: null, mutate: (doc) => doc }))
      .toEqual({ ok: false, reason: "not_found", attempts: 1 })
    const id = await createOrganization()
    await expect(compareAndSetOrganizationModules(handle.db, { organizationId: id, expectedRevision: 0, kind: "toggle", next: { ...emptyOrganizationModules(now), revision: 1, entitlement: { blob: "x".repeat(70_000) } } }))
      .rejects.toBeInstanceOf(OrganizationModulesTooLargeError)
    expect((await rawRow(id))?.modules).toBeNull()
  })

  test("toggle writes stamp updatedAt/updatedBy and organization.updated_at; system writes keep them", async () => {
    const id = await createOrganization()
    await handle.db.execute(sql`UPDATE organization SET updated_at = '2020-01-01 00:00:00.000' WHERE id = ${id}`)
    const legacy = await updateOrganizationModules(handle.db, { organizationId: id, kind: "legacy", actorMemberId: "om_ignored", now, mutate: (doc) => ({ ...doc, disabled: ["installLinks"] }) })
    expect(legacy).toMatchObject({ ok: true, unchanged: false, doc: { revision: 1, updatedBy: null, updatedAt: now.toISOString() } })
    const entitlement = await updateOrganizationModules(handle.db, { organizationId: id, kind: "entitlement", actorMemberId: null, now: new Date("2026-10-06T00:00:00.000Z"), mutate: (doc) => ({ ...doc, entitlement: { schemaVersion: 1 } }) })
    expect(entitlement).toMatchObject({ ok: true, doc: { revision: 2, updatedAt: now.toISOString(), updatedBy: null, entitlement: { schemaVersion: 1 } } })
    expect((await rawRow(id))?.updatedAt.toISOString()).toBe("2020-01-01T00:00:00.000Z")

    const later = new Date("2026-10-07T00:00:00.000Z")
    const toggle = await updateOrganizationModules(handle.db, { organizationId: id, kind: "toggle", actorMemberId: "om_owner", now: later, mutate: (doc) => ({ ...doc, disabled: [...doc.disabled, "teams"] }) })
    expect(toggle).toMatchObject({ ok: true, doc: { revision: 3, disabled: ["installLinks", "teams"], updatedAt: later.toISOString(), updatedBy: "om_owner", entitlement: { schemaVersion: 1 } } })
    expect((await rawRow(id))?.updatedAt.toISOString()).not.toBe("2020-01-01T00:00:00.000Z")

    expect(await updateOrganizationModules(handle.db, { organizationId: id, kind: "toggle", actorMemberId: "om_owner", mutate: (doc) => ({ ...doc, disabled: ["teams", "installLinks"] }) }))
      .toMatchObject({ ok: true, unchanged: true, doc: { revision: 3 } })
    expect(await updateOrganizationModules(handle.db, { organizationId: id, kind: "toggle", actorMemberId: "om_owner", mutate: () => null }))
      .toMatchObject({ ok: true, unchanged: true })
  })

  test("a write interleaved between read and compare-and-set is retried and both changes survive", async () => {
    const id = await createOrganization()
    let competed = false
    const result = await updateOrganizationModules(handle.db, {
      organizationId: id, kind: "toggle", actorMemberId: "om_owner", now,
      mutate: async (doc) => {
        if (!competed) {
          competed = true
          const competing = await updateOrganizationModules(handle.db, { organizationId: id, kind: "toggle", actorMemberId: "om_other", now, mutate: (current) => ({ ...current, disabled: [...current.disabled, "branding"] }) })
          expect(competing.ok).toBe(true)
        }
        return { ...doc, disabled: [...doc.disabled, "diagnostics"] }
      },
    })
    expect(result).toMatchObject({ ok: true, attempts: 2, doc: { revision: 2, disabled: ["branding", "diagnostics"], updatedBy: "om_owner" } })

    let attempts = 0
    const exhausted = await updateOrganizationModules(handle.db, {
      organizationId: id, kind: "toggle", actorMemberId: "om_owner", now, maxAttempts: 2,
      mutate: async (doc) => {
        attempts++
        await updateOrganizationModules(handle.db, { organizationId: id, kind: "toggle", actorMemberId: "om_other", now, mutate: (current) => ({ ...current, disabled: [...current.disabled, `m${attempts}`] }) })
        return { ...doc, disabled: [...doc.disabled, "never"] }
      },
    })
    expect(exhausted).toEqual({ ok: false, reason: "conflict", currentRevision: 4, attempts: 2 })
  })

  test("writes join the caller's transaction and roll back with it", async () => {
    const id = await createOrganization()
    await expect(handle.db.transaction(async (tx) => {
      const inside = await updateOrganizationModules(tx, { organizationId: id, kind: "toggle", actorMemberId: "om_owner", now, mutate: (doc) => ({ ...doc, disabled: ["teams"] }) })
      expect(inside.ok).toBe(true)
      throw new Error("rollback")
    })).rejects.toThrow("rollback")
    expect((await rawRow(id))?.modules).toBeNull()
  })

  test("a corrupt document refuses normal writes until repaired", async () => {
    const id = await createOrganization()
    await handle.db.execute(sql`UPDATE organization SET modules = JSON_OBJECT('schemaVersion', 1, 'revision', 'corrupt') WHERE id = ${id}`)
    const parsed = await readOrganizationModules(handle.db, id)
    expect(parsed?.status).toBe("invalid")
    await expect(updateOrganizationModules(handle.db, { organizationId: id, kind: "toggle", actorMemberId: "om_owner", mutate: (doc) => doc }))
      .rejects.toBeInstanceOf(OrganizationModulesCorruptError)

    const observed = (await rawRow(id))?.modules
    expect(await repairOrganizationModules(handle.db, { organizationId: id, observed: { schemaVersion: 1, revision: "other" }, next: { ...emptyOrganizationModules(now), revision: 1 } }))
      .toEqual({ ok: false, reason: "conflict", currentRevision: null })
    expect(await repairOrganizationModules(handle.db, { organizationId: id, observed, next: { ...emptyOrganizationModules(now), revision: 1, disabled: ["connect"] } }))
      .toEqual({ ok: true, doc: { ...emptyOrganizationModules(now), revision: 1, disabled: ["connect"] } })
    expect((await readOrganizationModules(handle.db, id))?.status).toBe("valid")
  })

  test("license_snapshot keeps exactly one row for the current fingerprint", async () => {
    const first = "a".repeat(64)
    const second = "b".repeat(64)
    expect(await readLicenseSnapshot(handle.db, first)).toEqual({ status: "absent" })
    await writeLicenseSnapshot(handle.db, first, { schemaVersion: 1, note: "first" })
    await writeLicenseSnapshot(handle.db, first, { schemaVersion: 1, note: "updated" })
    expect(await readLicenseSnapshot(handle.db, first)).toEqual({ status: "valid", snapshot: { schemaVersion: 1, note: "updated" } })
    await writeLicenseSnapshot(handle.db, second, { schemaVersion: 1 })
    expect(await handle.db.select({ fingerprint: LicenseSnapshotTable.fingerprint }).from(LicenseSnapshotTable)).toEqual([{ fingerprint: second }])
    await handle.db.update(LicenseSnapshotTable).set({ snapshot: ["not", "an", "object"] })
    expect((await readLicenseSnapshot(handle.db, second)).status).toBe("invalid")
    await expect(readLicenseSnapshot(handle.db, "license-key-in-plain-text")).rejects.toThrow("fingerprint")
  })
})
