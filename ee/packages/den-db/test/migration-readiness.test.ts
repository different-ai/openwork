import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import { generateMySQLDrizzleJson } from "drizzle-kit/api"
import * as schema from "../src/schema.ts"
import { localConnectionConfig, matrixPreflightQueries, migrateLocalDatabase, preflightMatrix } from "../scripts/dev-migrate.ts"
import { foundationSql, historyPrefix, journalTable, loadMigrationPlan, planAuthLookupIndexRepairs, recognizeBaseline, schemaDifferences, snapshotShape, stateTable } from "../scripts/migration-baseline.ts"

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = path.resolve(packageDir, "..", "..", "..")
const forbiddenDeployTools = ["pnpm", "tsx", "tsup", "drizzle-kit"]
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm"

describe("local startup migration safety (offline)", () => {
  const plan = loadMigrationPlan(path.join(packageDir, "drizzle"))
  test("rebased final snapshot matches the source serializer and retains upstream fields", async () => {
    const saved = plan.at(-1)?.snapshot
    assert.ok(saved)
    const generated = JSON.parse(JSON.stringify(await generateMySQLDrizzleJson(schema, saved.prevId)))
    generated.id = saved.id
    assert.deepEqual(generated, saved)
    assert.ok(saved.tables.team.columns.grants_organization_admin)
    assert.ok(saved.tables.inference_usage_ledger_entries.columns.provider_usage)
  })
  function shapeAt(tag: string) {
    const snapshot = plan.find((entry) => entry.tag.startsWith(tag))?.snapshot
    assert.ok(snapshot)
    return snapshotShape(snapshot)
  }
  function fixture(shape: Map<string, string>, options: {
    receipts?: Record<string, unknown>[]; dirty?: boolean; locked?: boolean; otherSessions?: boolean; invalid?: string; failOnSql?: RegExp; applyLookupIndexes?: boolean
  } = {}) {
    const queries: string[] = []
    const tables: Record<string, unknown>[] = []
    const columns: Record<string, unknown>[] = []
    const indexes: Record<string, unknown>[] = []
    const constraints: Record<string, unknown>[] = []
    for (const [key, value] of shape) {
      const [kind, name] = key.split(":")
      const [tbl, field] = name.split(".")
      if (kind === "table") tables.push({ name, kind: "BASE TABLE", engine: "InnoDB" })
      if (kind === "column") {
        const [type, nullable, def, auto, update] = JSON.parse(value)
        columns.push({ tbl, name: field, type, nullable: nullable ? "YES" : "NO", def,
          extra: `${auto ? "auto_increment" : ""} ${update ? "on update CURRENT_TIMESTAMP(3)" : ""}`, generated: "" })
      }
      if (kind === "index") {
        const [parts, unique, type]: [string[], boolean, string] = JSON.parse(value)
        for (const part of parts) {
          const prefix = /\((\d+)\)$/.exec(part)
          indexes.push({ tbl, name: field, col: part.replace(/\(\d+\)$/, ""), prefix: prefix ? Number(prefix[1]) : null,
            non_unique: unique ? 0 : 1, type, direction: "A", visible: "YES" })
        }
      }
      if (kind === "check") constraints.push({ tbl, name: field, kind: "CHECK", clause: value, enforced: "YES" })
    }
    if (options.receipts) tables.push({ name: journalTable, kind: "BASE TABLE", engine: "InnoDB" })
    if (options.dirty) tables.push({ name: stateTable, kind: "BASE TABLE", engine: "InnoDB" })
    const executor = { query: async (sql: string): Promise<Record<string, unknown>[]> => {
      queries.push(sql)
      if (options.failOnSql?.test(sql)) throw new Error("synthetic DDL failure")
      const createIndex = /^CREATE INDEX `([^`]+)` ON `([^`]+)`/.exec(sql)
      if (createIndex && options.applyLookupIndexes) {
        const definition = shapeAt("0096_").get(`index:${createIndex[2]}.${createIndex[1]}`)
        assert.ok(definition)
        const [parts, unique, type]: [string[], boolean, string] = JSON.parse(definition)
        for (const part of parts) indexes.push({ tbl: createIndex[2], name: createIndex[1], col: part.replace(/\(191\)$/, ""), prefix: 191,
          non_unique: unique ? 0 : 1, type, direction: "A", visible: "YES" })
      }
      if (sql.includes("VERSION() AS version")) return [{ version: "8.0.40", mode: "STRICT_TRANS_TABLES", db: "synthetic_local" }]
      if (sql.includes("GET_LOCK")) return [{ acquired: options.locked ? 0 : 1 }]
      if (sql.includes("information_schema.PROCESSLIST")) return options.otherSessions ? [{ present: 1 }] : []
      if (sql.startsWith("SELECT table_name AS `name`")) return tables
      if (sql.startsWith("SELECT table_name AS `tbl`, column_name")) return columns
      if (sql.startsWith("SELECT table_name AS `tbl`, index_name")) return indexes
      if (sql.startsWith("SELECT t.table_name")) return constraints
      if (sql.startsWith(`SELECT hash, created_at FROM \`${journalTable}\``)) return options.receipts ?? []
      if (sql.startsWith(`SELECT 1 FROM \`${stateTable}\``)) return options.dirty ? [{ present: 1 }] : []
      if (options.invalid && sql.startsWith(`SELECT '${options.invalid}'`)) return [{ invalid: 1 }]
      if (sql.startsWith("SELECT JSON_EXTRACT")) {
        return [{ preflight: options.invalid && sql.includes(`'${options.invalid}'`) ? { invalid: true } : {} }]
      }
      return []
    } }
    return { executor, queries }
  }

  test("known snapshots baseline only their prefix, never 0097", () => {
    assert.equal(recognizeBaseline(plan, shapeAt("0096_")), 96)
    assert.equal(recognizeBaseline(plan, shapeAt("0095_")), 95)
    assert.throws(() => recognizeBaseline(plan, shapeAt("0097_")), /Historical groups\/sets cannot be reconstructed/)
    const partial = shapeAt("0096_")
    partial.delete("column:inference_providers.credential_mode")
    assert.throws(() => recognizeBaseline(plan, partial), /does not match/)
    const indexDrift = shapeAt("0096_")
    indexDrift.set("index:inference_provider_models.inference_provider_models_provider_model", '[[],false,"BTREE"]')
    assert.throws(() => recognizeBaseline(plan, indexDrift), /does not match/)
  })

  test("history requires exact hashes, order and timestamps, not just MAX(created_at)", () => {
    const receipts = plan.slice(0, 96).map((entry) => ({ hash: entry.hash, created_at: String(entry.folderMillis) }))
    assert.equal(historyPrefix(plan, receipts), 96)
    assert.throws(() => historyPrefix(plan, receipts.slice(1)), /exact hash\/timestamp prefix/)
    assert.throws(() => historyPrefix(plan, [{ ...receipts[0], hash: "dirty" }]), /exact hash\/timestamp prefix/)
    assert.throws(() => historyPrefix(plan, [...receipts, receipts[95]]), /exact hash\/timestamp prefix/)
  })

  test("0097 current and known original receipts retain the same applied prefix without restamping", () => {
    const current = plan[96]
    assert.equal(current.tag, "0097_gateway_access_matrix")
    assert.equal(current.folderMillis, 1788895934602)
    assert.equal(current.hash, "2882d271052bd27a6281e5a1b161056546c817d27e218ba69fecd5f00cb4db9a")
    for (const hash of [current.hash, "dec021c8b3bb9fb139b3e0737ac5618ab1ed74d64d82fe36e1fcfe71306f378d"]) {
      for (const created_at of [1788895934602, "1788895934602"]) {
        const receipts = plan.slice(0, 97).map((entry) => ({ hash: entry.hash, created_at: entry.folderMillis }))
        const recorded = [...receipts.slice(0, 96), { hash, created_at }]
        const before = structuredClone(recorded)
        assert.equal(historyPrefix(plan, recorded), 97)
        assert.deepEqual(recorded, before)
        assert.deepEqual(plan.slice(historyPrefix(plan, recorded)).map((entry) => entry.tag), [
          "0098_gateway_provider_model_universe", "0099_gateway_credential_set_creator",
        ])
      }
    }
  })

  test("0097 receipt alias rejects unknown hashes, tags, timestamps, source changes and older drift", () => {
    const receipts = plan.slice(0, 97).map((entry) => ({ hash: entry.hash, created_at: entry.folderMillis }))
    receipts[96].hash = "dec021c8b3bb9fb139b3e0737ac5618ab1ed74d64d82fe36e1fcfe71306f378d"
    const changedSql = [...plan[96].sql, "SELECT 1;"]
    for (const replacement of [
      { ...plan[96], tag: "0097_unreviewed_migration" },
      { ...plan[96], folderMillis: 1788895934603 },
      { ...plan[96], sql: changedSql, hash: createHash("sha256").update(changedSql.join("--> statement-breakpoint")).digest("hex") },
    ]) {
      const alteredPlan = plan.map((entry, index) => index === 96 ? replacement : entry)
      const matchingTime = receipts.map((row, index) => index === 96 ? { ...row, created_at: replacement.folderMillis } : row)
      assert.throws(() => historyPrefix(alteredPlan, matchingTime), /exact hash\/timestamp prefix at receipt 97/)
    }
    for (const row of [
      { ...receipts[96], hash: "unknown" },
      { ...receipts[96], created_at: 1788895934603 },
      { hash: plan[96].hash, created_at: 1788895934603 },
    ]) {
      assert.throws(() => historyPrefix(plan, [...receipts.slice(0, 96), row]), /exact hash\/timestamp prefix at receipt 97/)
    }
    for (const index of [2, 9, 14, 94, 95, 97, 98]) {
      const olderDrift = plan.map((entry) => ({ hash: entry.hash, created_at: entry.folderMillis }))
      olderDrift[96] = { ...receipts[96] }
      olderDrift[index].hash = receipts[96].hash
      assert.throws(() => historyPrefix(plan, olderDrift), new RegExp(`exact hash/timestamp prefix at receipt ${index + 1}\\.`))
    }
  })

  test("original 0097 receipts still require schema parity and do not rerun matrix guards", async () => {
    for (const applied of [97, 99]) {
      const receipts = plan.slice(0, applied).map((entry) => ({ hash: entry.hash, created_at: entry.folderMillis }))
      receipts[96].hash = "dec021c8b3bb9fb139b3e0737ac5618ab1ed74d64d82fe36e1fcfe71306f378d"
      const before = structuredClone(receipts)
      const shape = shapeAt(`00${applied}_`)
      const healthy = fixture(shape, { receipts })
      await migrateLocalDatabase(healthy.executor, plan, true)
      assert.ok(healthy.queries.every((sql) => sql.startsWith("SELECT")))
      assert.ok(matrixPreflightQueries(plan).every((guard) => !healthy.queries.includes(guard.sql)))
      const drifted = new Map(shape)
      drifted.delete("column:gateway_provider_access.model_group_id")
      const invalid = fixture(drifted, { receipts })
      await assert.rejects(migrateLocalDatabase(invalid.executor, plan, true), /Schema differs from its recorded migration/)
      assert.ok(invalid.queries.every((sql) => sql.startsWith("SELECT")))
      assert.deepEqual(receipts, before)
    }
  })

  test("matrix extraction preserves exactly five JSON assertions and seven INSERT-derived guards", () => {
    const queries = matrixPreflightQueries(plan)
    assert.deepEqual(queries.map(({ name, json }) => [name, json]), [
      ["0097_requires_mysql_8_0_16_or_later", false],
      ["0097_requires_strict_sql_mode", false],
      ["0097_requires_complete_0096_schema", true],
      ["0097_requires_complete_0096_schema", true],
      ["0097_requires_complete_0096_schema", true],
      ["0097_gateway_tables_already_exist", true],
      ["0097_missing_legacy_indexes", true],
      ["0097_invalid_typeid", false],
      ["0097_orphan_or_cross_org_resource", false],
      ["0097_invalid_credential_subject", false],
      ["0097_invalid_audience", false],
      ["0097_duplicate_audience_grants", false],
    ])
    assert.ok(queries.every((query) => query.sql.startsWith("SELECT")))
  })

  test("matrix extraction rejects missing, duplicate, unknown or altered guard layouts", () => {
    const mutations: ((sql: string[]) => string[])[] = [
      (sql) => sql.filter((packet) => !packet.includes("COUNT(*) = 11")),
      (sql) => [...sql.slice(0, 4), sql[4], ...sql.slice(4)],
      (sql) => [...sql.slice(0, 4), "SELECT 1;", ...sql.slice(4)],
      (sql) => sql.map((packet) => packet.replace("COUNT(*) = 8", "COUNT(*) = 7")),
      (sql) => sql.map((packet) => packet.replace("AND TABLE_TYPE = 'BASE TABLE'", "")),
      (sql) => sql.map((packet) => packet.replace("AS preflight", "AS ignored")),
      (sql) => sql.map((packet) => packet.replace("'0097_invalid_typeid'", "'0097_unknown_guard'")),
      (sql) => sql.map((packet) => packet.replace("  ('0097_invalid_audience'),", "")),
      (sql) => sql.filter((packet) => !packet.includes("DROP TEMPORARY TABLE")),
      (sql) => sql.map((packet) => packet.replace("RENAME TABLE", "SELECT")),
    ]
    for (const mutate of mutations) {
      const altered = plan.map((entry) => entry.tag === "0097_gateway_access_matrix" ? { ...entry, sql: mutate([...entry.sql]) } : entry)
      // The original plan hash is deliberately retained: layout checks must
      // inspect SQL bytes, not trust a stale hash alongside changed packets.
      assert.throws(() => matrixPreflightQueries(altered), /0097 preflight layout changed/)
    }
  })

  test("matrix JSON guards accept only one empty-object row while INSERT guards require no rows", async () => {
    const queries = matrixPreflightQueries(plan)
    for (const value of [{}, "{}", " \n{ }\t"]) {
      const called: string[] = []
      await preflightMatrix({ query: async (sql) => {
        called.push(sql)
        return sql.startsWith("SELECT JSON_EXTRACT") ? [{ preflight: value }] : []
      } }, plan)
      assert.deepEqual(called, queries.map((query) => query.sql))
    }
    const invalidRows: Record<string, unknown>[][] = [
      [], [{}], [{ preflight: {} }, { preflight: {} }], [{ preflight: undefined }],
      ...[null, false, 0, [], { unexpected: true }, new Date(0), "", "invalid", "null", "[]", "false", "0", '"{}"', '{"unexpected":true}', "{} trailing"]
        .map((preflight) => [{ preflight }]),
    ]
    for (const target of queries) {
      for (const rows of target.json ? invalidRows : [[{ failure: target.name }]]) {
        const called: string[] = []
        await assert.rejects(preflightMatrix({ query: async (sql) => {
          called.push(sql)
          return sql === target.sql ? rows : sql.startsWith("SELECT JSON_EXTRACT") ? [{ preflight: {} }] : []
        } }, plan), /Preflight rejected/)
        assert.deepEqual(called, queries.slice(0, queries.indexOf(target) + 1).map((query) => query.sql))
      }
    }
  })

  test("pre-0096 inspection skips all three schema assertions only and query errors abort", async () => {
    const all = matrixPreflightQueries(plan)
    const required = all.filter((query) => query.name !== "0097_requires_complete_0096_schema")
    assert.equal(all.length - required.length, 3)
    const called: string[] = []
    await preflightMatrix({ query: async (sql) => {
      called.push(sql)
      return sql.startsWith("SELECT JSON_EXTRACT") ? [{ preflight: {} }] : []
    } }, plan, false)
    assert.deepEqual(called, required.map((query) => query.sql))
    for (const completeSchema of [false, true]) {
      const expected = completeSchema ? all : required
      for (const target of expected) {
        const failure = new Error("synthetic query failure")
        const attempted: string[] = []
        await assert.rejects(preflightMatrix({ query: async (sql) => {
          attempted.push(sql)
          if (sql === target.sql) throw failure
          return sql.startsWith("SELECT JSON_EXTRACT") ? [{ preflight: {} }] : []
        } }, plan, completeSchema), (error: unknown) => error === failure)
        assert.deepEqual(attempted, expected.slice(0, expected.indexOf(target) + 1).map((query) => query.sql))
      }
    }
  })

  const lookupKeys = [
    "index:account.account_account_id_provider_id",
    "index:oauthAccessToken.oauth_access_token_token",
    "index:oauthRefreshToken.oauth_refresh_token_token",
  ]
  function missingLookups() {
    const shape = shapeAt("0096_")
    for (const key of lookupKeys) shape.delete(key)
    return shape
  }

  test("auth reconciliation permits only missing subsets of the three canonical nonunique indexes", () => {
    for (let mask = 0; mask < 8; mask++) {
      const shape = shapeAt("0096_")
      const missing = lookupKeys.filter((_, index) => mask & (1 << index))
      for (const key of missing) shape.delete(key)
      const repairs = planAuthLookupIndexRepairs(plan, shape)
      assert.deepEqual(repairs.map((repair) => repair.key), missing)
      for (const repair of repairs) {
        assert.match(repair.sql, /^CREATE INDEX /)
        assert.doesNotMatch(repair.sql, /UPDATE|DROP|UNIQUE|INSERT/)
        shape.set(repair.key, repair.definition)
      }
      assert.equal(recognizeBaseline(plan, shape), 96)
    }
    for (const key of ["column:account.provider_id", "table:inference_providers", "index:account.account_user_id"]) {
      const mixed = missingLookups()
      mixed.delete(key)
      assert.deepEqual(planAuthLookupIndexRepairs(plan, mixed), [])
      assert.throws(() => recognizeBaseline(plan, mixed), /does not match/)
    }
    for (const definition of ['[["token(100)"],false,"BTREE"]', '[["token(191)"],true,"BTREE"]']) {
      const wrong = missingLookups()
      wrong.set(lookupKeys[1], definition)
      assert.deepEqual(planAuthLookupIndexRepairs(plan, wrong), [])
      assert.throws(() => recognizeBaseline(plan, wrong), /does not match/)
    }
    assert.deepEqual(planAuthLookupIndexRepairs(plan, shapeAt("0097_")), [])
    assert.deepEqual(planAuthLookupIndexRepairs(plan, shapeAt("0095_")), [])
  })

  test("planned auth repair check allows active connections but performs only reads", async () => {
    const { executor, queries } = fixture(missingLookups(), { otherSessions: true })
    await migrateLocalDatabase(executor, plan, true)
    assert.ok(queries.every((sql) => sql.startsWith("SELECT")))
    for (const guard of matrixPreflightQueries(plan)) assert.ok(queries.includes(guard.sql))
  })

  test("all data guards, connection and interruption checks precede any auth index writes", async () => {
    const scenarios = [
      { options: { otherSessions: true }, error: /Other connections/ },
      { options: { dirty: true }, error: /interrupted/ },
      ...matrixPreflightQueries(plan).map((guard) => ({ options: { invalid: guard.name }, error: /Preflight rejected/ })),
    ]
    for (const scenario of scenarios) {
      const { executor, queries } = fixture(missingLookups(), scenario.options)
      await assert.rejects(migrateLocalDatabase(executor, plan), scenario.error)
      assert.ok(queries.every((sql) => sql.startsWith("SELECT")))
    }
  })

  test("additive failure or failed reinspection retains marker with no baseline receipts", async () => {
    for (const scenario of [
      { options: { failOnSql: /^CREATE INDEX `oauth_access_token_token`/ }, error: /synthetic DDL failure/ },
      { options: {}, error: /did not reach exact 0096/ },
    ]) {
      const { executor, queries } = fixture(missingLookups(), scenario.options)
      await assert.rejects(migrateLocalDatabase(executor, plan), scenario.error)
      const marker = queries.findIndex((sql) => sql.startsWith(`INSERT INTO \`${stateTable}\``))
      const index = queries.findIndex((sql) => sql.startsWith("CREATE INDEX"))
      assert.ok(marker >= 0 && marker < index)
      assert.equal(queries.some((sql) => sql.startsWith(`INSERT INTO \`${journalTable}\``)), false)
      assert.equal(queries.some((sql) => sql.startsWith(`DELETE FROM \`${stateTable}\``)), false)
      assert.ok(queries.at(-1)?.includes("RELEASE_LOCK"))
    }
  })

  test("auth repair verifies exact 0096 before receipts, then advances to 0097 without replaying 0073", async () => {
    const { executor, queries } = fixture(missingLookups(), { applyLookupIndexes: true, failOnSql: /RENAME TABLE/ })
    await assert.rejects(migrateLocalDatabase(executor, plan), /synthetic DDL failure/)
    const firstIndex = queries.findIndex((sql) => sql.startsWith("CREATE INDEX"))
    const lastIndex = queries.reduce((last, sql, index) => sql.startsWith("CREATE INDEX") ? index : last, -1)
    const inspection = queries.findIndex((sql, index) => index > lastIndex && sql.startsWith("SELECT table_name AS `name`"))
    const receipt = queries.findIndex((sql) => sql.startsWith(`INSERT INTO \`${journalTable}\``))
    assert.equal(queries.filter((sql) => sql.startsWith("CREATE INDEX")).length, 3)
    assert.ok(firstIndex >= 0 && inspection > lastIndex && receipt > inspection)
    for (const guard of matrixPreflightQueries(plan)) assert.ok(queries.indexOf(guard.sql) < firstIndex)
    assert.equal(queries.filter((sql) => sql.startsWith(`INSERT INTO \`${journalTable}\``)).length, 96)
    assert.equal(queries.some((sql) => /UPDATE `user`/.test(sql)), false)
    assert.ok(queries.some((sql) => /RENAME TABLE/.test(sql)))
  })

  test("launcher awaits build and local migration before starting application services", () => {
    const launcher = readFileSync(path.join(repoRoot, "scripts/dev-local.mjs"), "utf8")
    const build = launcher.indexOf('await run("pnpm", ["--filter", "@openwork-ee/den-db", "build"]')
    const migrate = launcher.indexOf('await run("pnpm", ["--filter", "@openwork-ee/den-db", "db:migrate:local"]')
    const start = launcher.indexOf("turboChild = spawn(")
    assert.ok(build >= 0 && build < migrate && migrate < start)
    assert.doesNotMatch(launcher, /drizzle-kit|--force|db:push|db:baseline/)
  })

  test("loopback restriction does not disclose URLs or passwords", () => {
    assert.equal(localConnectionConfig("mysql://root:synthetic@127.0.0.1:3306/example").host, "127.0.0.1")
    assert.equal(localConnectionConfig("mysql://root:synthetic@[::1]:3306/example").host, "::1")
    for (const url of ["mysql://root:synthetic@remote.example.test/db", "malformed:synthetic"]) {
      assert.throws(() => localConnectionConfig(url), (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal(error.message.includes("synthetic"), false)
        assert.equal(error.message.includes(url), false)
        return true
      })
    }
  })

  test("empty and recognized pre-matrix read-only checks never create a journal", async () => {
    for (const shape of [new Map<string, string>(), shapeAt("0096_"), shapeAt("0095_")]) {
      const { executor, queries } = fixture(shape)
      await migrateLocalDatabase(executor, plan, true)
      assert.ok(queries.every((sql) => sql.startsWith("SELECT")))
      assert.ok(queries.at(-1)?.includes("RELEASE_LOCK"))
    }
  })

  test("dirty, mixed, already-pushed, competing and invalid-data states fail before writes", async () => {
    const cases = [
      { shape: shapeAt("0096_"), options: { dirty: true }, error: /interrupted/ },
      { shape: shapeAt("0096_"), options: { locked: true }, error: /holds this database/ },
      { shape: shapeAt("0096_"), options: { otherSessions: true }, error: /Other connections/ },
      { shape: shapeAt("0097_"), options: {}, error: /Historical groups/ },
      { shape: new Map([["table:unrecognized", "BASE TABLE:InnoDB"]]), options: {}, error: /does not match/ },
      { shape: shapeAt("0096_"), options: { receipts: [{ hash: "dirty", created_at: 1 }] }, error: /exact hash/ },
      ...matrixPreflightQueries(plan).map((check) => ({ shape: shapeAt("0096_"), options: { invalid: check.name }, error: /Preflight rejected/ })),
    ]
    for (const scenario of cases) {
      const { executor, queries } = fixture(scenario.shape, scenario.options)
      await assert.rejects(migrateLocalDatabase(executor, plan), scenario.error)
      assert.ok(queries.every((sql) => sql.startsWith("SELECT")))
    }
  })

  test("known repairs and fulltext differences do not hide unrelated drift", () => {
    const expected = shapeAt("0096_")
    const repaired = new Map(expected)
    repaired.delete("column:config_object_version.organization_id")
    repaired.delete("index:config_object_version.config_object_version_organization_id")
    repaired.set("index:memory.memory_content_fulltext", '[["content"],false,"FULLTEXT"]')
    assert.deepEqual(schemaDifferences(expected, repaired), [])
    repaired.set("column:config_object_version.organization_id", '["varchar(255)",false,null,false,false]')
    assert.deepEqual(schemaDifferences(expected, repaired), ["column:config_object_version.organization_id"])
  })

  test("DDL failure retains the interruption marker and never records 0097", async () => {
    const { executor, queries } = fixture(shapeAt("0096_"), { failOnSql: /RENAME TABLE/ })
    await assert.rejects(migrateLocalDatabase(executor, plan), /synthetic DDL failure/)
    const marker = queries.findIndex((sql) => sql.startsWith(`INSERT INTO \`${stateTable}\``))
    const baseline = queries.findIndex((sql) => sql.startsWith(`INSERT INTO \`${journalTable}\``))
    const rename = queries.findIndex((sql) => /RENAME TABLE/.test(sql))
    assert.ok(marker >= 0 && marker < baseline && baseline < rename)
    assert.equal(queries.filter((sql) => sql.startsWith(`INSERT INTO \`${journalTable}\``)).length, 96)
    assert.equal(queries.some((sql) => sql.startsWith(`DELETE FROM \`${stateTable}\``)), false)
    assert.ok(queries.at(-1)?.includes("RELEASE_LOCK"))
  })

  test("matrix CHECK normalization preserves logical grouping", () => {
    const snapshot = structuredClone(plan.at(-1)?.snapshot)
    assert.ok(snapshot)
    const expected = snapshotShape(snapshot)
    snapshot.tables.gateway_provider_access.checkConstraint.gateway_provider_access_audience.value =
      "(((`org_membership_id` is null) or (`team_id` is null)) and (`audience_key` = (case when (`org_membership_id` is not null) then concat(_utf8mb4'member:',`org_membership_id`) when (`team_id` is not null) then concat(_utf8mb4'team:',`team_id`) else _utf8mb4'organization' end)))"
    assert.deepEqual(schemaDifferences(expected, snapshotShape(snapshot)), [])
    snapshot.tables.gateway_provider_access.checkConstraint.gateway_provider_access_audience.value =
      snapshot.tables.gateway_provider_access.checkConstraint.gateway_provider_access_audience.value.replace("or (`team_id` is null)) and", "or ((`team_id` is null) and")
    assert.notDeepEqual(schemaDifferences(expected, snapshotShape(snapshot)), [])
  })

  test("foundation seeds only original tables and leaves later additions to replay", async () => {
    const sql = (await foundationSql(plan)).join("\n")
    assert.match(sql, /CREATE TABLE `worker`/)
    assert.match(sql, /CREATE TABLE `oauthClient`/)
    assert.doesNotMatch(sql, /CREATE TABLE `(?:inference_|gateway_|organization`|member`|memory`)/)
    assert.doesNotMatch(sql, /`(?:last_heartbeat_at|last_active_at|cloud_failure_code|authorization_code_id|dpop_bound_access_tokens)`/)
    assert.doesNotMatch(sql, /\b(?:DROP|RENAME|TRUNCATE|DELETE|INSERT)\b/)
  })
})

function readRepoFile(relativePath: string) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8")
}

function readDenDbMigrations() {
  return readdirSync(path.join(packageDir, "drizzle"))
    .filter((entry) => entry.endsWith(".sql"))
    .map((entry) => readFileSync(path.join(packageDir, "drizzle", entry), "utf8"))
    .join("\n")
}

function requireSlice(contents: string, start: string, end: string) {
  const startIndex = contents.indexOf(start)
  assert.notEqual(startIndex, -1, `Missing ${start}`)

  const endIndex = contents.indexOf(end, startIndex + start.length)
  assert.notEqual(endIndex, -1, `Missing ${end}`)

  return contents.slice(startIndex, endIndex)
}

function assertNoForbiddenDeployTools(contents: string) {
  for (const tool of forbiddenDeployTools) {
    assert.equal(contents.includes(tool), false, `deploy path must not reference ${tool}`)
  }
}

function shortOutput(output: string) {
  return output.slice(Math.max(0, output.length - 4_000))
}

describe("Den DB migration readiness wiring", () => {
  test("Drizzle tooling resolves workspace sources without a prerequisite production build", () => {
    const { scripts } = JSON.parse(readRepoFile("ee/packages/den-db/package.json"))
    const node = "node --conditions=development --import tsx"
    for (const command of ["generate", "migrate", "push"]) {
      const repair = command === "generate" ? "" : ` && ${node} scripts/ensure-schema-repairs.ts`
      assert.equal(scripts[`db:${command}`], `${node} ./node_modules/drizzle-kit/bin.cjs ${command} --config drizzle.config.ts${repair}`)
    }

    const buildAssets = readRepoFile("ee/packages/den-db/scripts/build-assets.mjs")
    assert.match(buildAssets, /spawnSync\(process\.execPath, \["--conditions=development", "--import", "tsx"/)
    assert.match(buildAssets, /throw new Error\(`drizzle-kit export did not emit SQL/)
  })

  test("oauth access token lookup has a token prefix index", () => {
    const authSchema = readRepoFile("ee/packages/den-db/src/schema/auth.ts")
    const migrations = readDenDbMigrations()

    assert.equal(authSchema.includes('index("oauth_access_token_token").on(sql`${table.token}(191)`)'), true)
    assert.match(migrations, /CREATE INDEX `oauth_access_token_token` ON `oauthAccessToken` \(`token`\(191\)\);/)
  })

  test("Helm migration defaults execute the precompiled dist runner", () => {
    const values = readRepoFile("packaging/helm/openwork-ee/values.yaml")
    const migrationsBlock = requireSlice(values, "migrations:\n", "\ningress:")

    assert.match(migrationsBlock, /command:\n\s+- node/)
    assert.match(migrationsBlock, /args:\n\s+- \/app\/ee\/packages\/den-db\/dist\/scripts\/bootstrap\.js/)
    assertNoForbiddenDeployTools(migrationsBlock)
  })

  test("Dockerfile.den uses the Den API's graph-aware production build", () => {
    const dockerfile = readRepoFile("packaging/docker/Dockerfile.den")

    assert.match(dockerfile, /pnpm --dir \/app\/ee\/apps\/den-api run build/)
    assert.equal(dockerfile.includes("/app/ee/packages/den-db run build"), false)
    assert.equal(dockerfile.includes("/app/ee/packages/telemetry run build"), false)
  })

  test("hosted Den API build includes den-db assets but start does not run migrations", () => {
    const denApiPackage = readRepoFile("ee/apps/den-api/package.json")
    const denApiBuild = readRepoFile("ee/apps/den-api/scripts/build.mjs")
    const startLine = denApiPackage.split("\n").find((line) => line.includes('"start"')) ?? ""

    assert.match(denApiPackage, /"build:workspace-dependencies": "pnpm --filter '@openwork-ee\/den-api\^\.\.\.' --if-present run build"/)
    assert.match(denApiBuild, /run\(pnpmCommand, \["run", "build:workspace-dependencies"\]\)/)
    assert.match(denApiBuild, /verifyProductionWorkspaceExports\(\)/)
    assert.match(startLine, /"start": "node dist\/main\.js"/)
    assert.equal(startLine.includes("db:migrate"), false, "hosted start alone does not migrate")
    assert.equal(startLine.includes("db:bootstrap"), false, "hosted start alone does not bootstrap")
    assert.equal(startLine.includes("bootstrap.js"), false, "hosted start alone does not invoke the migration runner")
  })

  test("hosted migration workflow remains the explicit PlanetScale migration owner", () => {
    const workflow = readRepoFile(".github/workflows/den-db-migrate.yml")

    assert.match(workflow, /name: Den DB Migrate/)
    assert.match(workflow, /branches:\n\s+- dev/)
    assert.match(workflow, /paths:\n\s+- "ee\/packages\/den-db\/drizzle\/\*\*"/)
    assert.match(workflow, /pscale branch safe-migrations disable/)
    assert.match(workflow, /run_with_ddl_retry pnpm --filter @openwork-ee\/den-db db:migrate/)
    assert.match(workflow, /pscale branch safe-migrations enable/)
  })

  test("PR guardrails run readiness tests and smoke Den DB assets in the Den API image", () => {
    const checkWorkflow = readRepoFile(".github/workflows/den-db-check.yml")
    const publishWorkflow = readRepoFile(".github/workflows/publish-ee-images.yml")

    assert.match(checkWorkflow, /pnpm --filter @openwork-ee\/den-db test/)
    assert.match(checkWorkflow, /"ee\/apps\/den-api\/package\.json"/)
    assert.match(checkWorkflow, /"ee\/apps\/den-api\/scripts\/build\.mjs"/)
    assert.match(checkWorkflow, /"packaging\/docker\/Dockerfile\.den"/)
    assert.match(checkWorkflow, /"packaging\/helm\/openwork-ee\/templates\/migration-job\.yaml"/)
    assert.match(checkWorkflow, /"\.github\/workflows\/publish-ee-images\.yml"/)
    assert.match(publishWorkflow, /Assert Den DB migration assets/)
    assert.match(publishWorkflow, /test -s \/app\/ee\/packages\/den-db\/dist\/scripts\/bootstrap\.js/)
    assert.match(publishWorkflow, /test -s \/app\/ee\/packages\/den-db\/dist\/current-schema\.sql/)
    assert.match(publishWorkflow, /test -s \/app\/ee\/packages\/den-db\/dist\/drizzle\/meta\/_journal\.json/)
  })

  test("production bootstrap source uses the mysql2 ORM migrator and no deploy-time toolchain", () => {
    const bootstrap = readFileSync(path.join(packageDir, "scripts", "bootstrap.ts"), "utf8")

    assert.match(bootstrap, /drizzle-orm\/mysql2\/migrator/)
    assert.match(bootstrap, /await migrate\(db, \{ migrationsFolder \}\)/)
    assert.match(bootstrap, /current-schema\.sql/)
    assert.match(bootstrap, /await ensureSchemaRepairs\(repairExecutor\)/)
    assertNoForbiddenDeployTools(bootstrap)
  })

  test("package build emits the precompiled runner, schema snapshot, and migration assets", { timeout: 120_000 }, () => {
    const build = spawnSync(pnpmCommand, ["run", "build"], {
      cwd: packageDir,
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_HOST: "",
        DATABASE_NAME: "",
        DATABASE_PASSWORD: "",
        DATABASE_URL: "",
        DATABASE_USERNAME: "",
      },
    })

    assert.equal(
      build.status,
      0,
      `pnpm run build failed\nstdout:\n${shortOutput(build.stdout)}\nstderr:\n${shortOutput(build.stderr)}`,
    )

    const runner = readFileSync(path.join(packageDir, "dist", "scripts", "bootstrap.js"), "utf8")
    const snapshot = readFileSync(path.join(packageDir, "dist", "current-schema.sql"), "utf8")
    const journal = readFileSync(path.join(packageDir, "dist", "drizzle", "meta", "_journal.json"), "utf8")

    assert.match(runner, /drizzle-orm\/mysql2\/migrator/)
    assert.match(snapshot, /^CREATE TABLE `account`/)
    assert.equal(snapshot.includes("Reading schema files"), false, "schema snapshot contains SQL only")
    assert.match(journal, /"entries"/)
    assert.match(journal, /"0040_rapid_lady_bullseye"/)
  })
})
