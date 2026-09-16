import assert from "node:assert/strict"
import { execFile, spawnSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { readMigrationFiles } from "drizzle-orm/migrator"
import mysql from "mysql2/promise"

const db = fileURLToPath(new URL("..", import.meta.url))
const repo = fileURLToPath(new URL("../../../..", import.meta.url))
const mysqlUrl = process.env.DEN_DB_MYSQL_TEST_URL
const isolated = process.env.DEN_DB_MYSQL_ISOLATED === "1"
const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NODE_ENV: "test", pnpm_config_verify_deps_before_run: "false" }
const exec = promisify(execFile)
const originals = [
  { tag: "v0.18.35", sha: "13504969eeafb4657e555b52e49587c6a7d21072" },
  { tag: "v0.18.48", sha: "c67ba51eda99ae6cfba1ff75b31e84f915c47be5" },
]
const sourceNames = ["inference_request_logs", "inference_rollup_lock", "inference_usage_rollups", "inference_provider_access", "inference_provider_credentials", "inference_provider_models", "inference_provider_oauth_states", "inference_providers"]
const targetNames = sourceNames.map(name => name.replace("inference_", "gateway_"))
const migrations = readMigrationFiles({ migrationsFolder: join(db, "drizzle") })

async function command(bin: string, args: string[], cwd: string) {
  try { return await exec(bin, args, { cwd, env, timeout: 300_000, maxBuffer: 32 * 1024 * 1024 }) }
  catch (error) {
    if (error instanceof Error && "stdout" in error && "stderr" in error) throw new Error(`${bin} ${args.join(" ")}\n${error.stdout}\n${error.stderr}`, { cause: error })
    throw error
  }
}

async function prepareRelease(root: string, release: typeof originals[number]) {
  assert.equal((await command("git", ["rev-parse", `${release.tag}^{commit}`], repo)).stdout.trim(), release.sha)
  const destination = join(root, release.tag)
  await mkdir(destination)
  const packages = ["packages/types", "ee/packages/utils", "ee/packages/den-db"]
  const archive = join(root, `${release.tag}.tar`)
  await command("git", ["archive", "--format=tar", `--output=${archive}`, release.sha, ...packages], repo)
  await command("tar", ["-xf", archive, "-C", destination], repo)
  for (const pkg of packages) {
    const installed = join(repo, pkg, "node_modules")
    const target = join(destination, pkg, "node_modules")
    await mkdir(target)
    for (const entry of await readdir(installed)) {
      if (entry === ".bin") continue
      if (!entry.startsWith("@")) { await symlink(join(installed, entry), join(target, entry)); continue }
      await mkdir(join(target, entry))
      for (const name of await readdir(join(installed, entry))) {
        const internal = entry === "@openwork" && name === "types" ? "packages/types" : entry === "@openwork-ee" && name === "utils" ? "ee/packages/utils" : undefined
        await symlink(internal ? join(destination, internal) : join(installed, entry, name), join(target, entry, name))
      }
    }
  }
  for (const pkg of packages) {
    const cwd = join(destination, pkg)
    await command(process.execPath, [join(cwd, "node_modules/tsup/dist/cli-default.js")], cwd)
  }
  const releaseDb = join(destination, "ee/packages/den-db")
  await mkdir(join(releaseDb, "node_modules/.bin"))
  await symlink(join(releaseDb, "node_modules/drizzle-kit/bin.cjs"), join(releaseDb, "node_modules/.bin/drizzle-kit"))
  await command(process.execPath, [join(releaseDb, "node_modules/tsup/dist/cli-default.js"), "--config", "tsup.scripts.config.ts"], releaseDb)
  await command(process.execPath, ["scripts/build-assets.mjs"], releaseDb)
  console.log(`[mysql-0097] exact release source ${release.tag} ${release.sha}; installed workspace dependencies; schema sha256=${createHash("sha256").update(await readFile(join(releaseDb, "dist/current-schema.sql"))).digest("hex")}`)
  return releaseDb
}

async function productionCopy(root: string) {
  const destination = join(root, "production-only")
  await mkdir(destination)
  await writeFile(join(destination, "package.json"), JSON.stringify({ type: "module" }))
  await cp(join(db, "dist"), join(destination, "dist"), { recursive: true })
  const installed = new Map<string, string>()
  const copyDependency = async (name: string, from: string) => {
    const require = createRequire(join(from, "package.json"))
    let source = dirname(await realpath(require.resolve(name)))
    let metadata: { name?: string; version?: string; dependencies?: Record<string, string> }
    for (;;) {
      metadata = JSON.parse(await readFile(join(source, "package.json"), "utf8").catch(() => "{}"))
      if (metadata.name === name) break
      assert.notEqual(dirname(source), source, `Cannot locate production dependency ${name}`)
      source = dirname(source)
    }
    assert.ok(metadata.version)
    if (installed.has(name)) { assert.equal(installed.get(name), metadata.version); return }
    installed.set(name, metadata.version)
    const target = join(destination, "node_modules", name)
    await mkdir(dirname(target), { recursive: true })
    await cp(source, target, { recursive: true, filter: entry => !entry.slice(source.length).split("/").includes("node_modules") })
    for (const dependency of Object.keys(metadata.dependencies ?? {})) await copyDependency(dependency, source)
  }
  for (const name of ["mysql2", "drizzle-orm"]) await copyDependency(name, db)
  const require = createRequire(join(destination, "package.json"))
  for (const tool of ["tsx", "drizzle-kit", "typescript", "tsup"]) assert.throws(() => require.resolve(tool), { code: "MODULE_NOT_FOUND" })
  console.log(`[mysql-0097] copied production runtime only: ${JSON.stringify(Object.fromEntries(installed))}; no tsx/drizzle-kit/typescript/tsup`)
  return destination
}

function bootstrap(packageDir: string, url: string, acknowledgement: string | null = null) {
  const result = spawnSync(process.execPath, ["dist/scripts/bootstrap.js"], { cwd: packageDir, env: { ...env, ...(acknowledgement === null ? {} : { DEN_DB_0097_WRITERS_STOPPED: acknowledgement }), DATABASE_URL: url, DB_MODE: "mysql", DEN_DB_ENCRYPTION_KEY: "isolated-native-mysql-test-key-000000000000" }, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })
  if (result.error) throw result.error
  return { code: result.status, output: result.stdout + result.stderr }
}

async function rows(connection: mysql.Connection, sql: string, args: (string | number)[] = []): Promise<Record<string, unknown>[]> {
  const [result] = await connection.query<mysql.RowDataPacket[]>(sql, args)
  return Array.isArray(result) ? result.map(row => ({ ...row })) : []
}

async function receipts(connection: mysql.Connection) {
  return rows(connection, "SELECT id, hash, created_at FROM __drizzle_migrations ORDER BY id")
}

async function state(connection: mysql.Connection) {
  const tables = await rows(connection, "SHOW TABLES")
  const result = []
  for (const row of tables) {
    const name = Object.values(row)[0]
    assert.equal(typeof name, "string")
    const identifier = `\`${String(name).replace(/`/g, "``")}\``
    const ddl = await rows(connection, `SHOW CREATE TABLE ${identifier}`)
    const data = (await rows(connection, `SELECT * FROM ${identifier}`)).map(row => JSON.stringify(row)).sort()
    result.push({ name, ddl, data })
  }
  return result
}

async function schema(connection: mysql.Connection) {
  return {
    columns: await rows(connection, "SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME<>'__drizzle_migrations' ORDER BY TABLE_NAME,COLUMN_NAME"),
    indexes: await rows(connection, "SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME, NON_UNIQUE, SEQ_IN_INDEX, SUB_PART, COLLATION, IS_VISIBLE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME<>'__drizzle_migrations' ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX"),
    checks: await rows(connection, "SELECT t.TABLE_NAME,t.CONSTRAINT_NAME,t.ENFORCED,c.CHECK_CLAUSE FROM information_schema.TABLE_CONSTRAINTS t JOIN information_schema.CHECK_CONSTRAINTS c USING(CONSTRAINT_SCHEMA,CONSTRAINT_NAME) WHERE t.CONSTRAINT_SCHEMA=DATABASE() ORDER BY t.TABLE_NAME,t.CONSTRAINT_NAME"),
  }
}

async function assertKeys(connection: mysql.Connection, names: string[]) {
  const keys = await rows(connection, `SELECT TABLE_NAME AS tbl,COLUMN_NAME AS col FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND INDEX_NAME='PRIMARY' AND TABLE_NAME IN (${names.map(() => "?").join(",")}) ORDER BY TABLE_NAME,SEQ_IN_INDEX`, names)
  assert.deepEqual(keys, [...names].sort().map(tbl => ({ tbl, col: "id" })))
}

async function assertHistory(connection: mysql.Connection, count = migrations.length) {
  assert.deepEqual((await receipts(connection)).map(row => ({ hash: row.hash, created_at: Number(row.created_at) })), migrations.slice(0, count).map(migration => ({ hash: migration.hash, created_at: migration.folderMillis })))
}

async function advance(connection: mysql.Connection, from: number, to: number) {
  for (const migration of migrations.slice(from, to)) {
    for (const sql of migration.sql) await connection.query(sql)
    await connection.query("INSERT INTO __drizzle_migrations (hash,created_at) VALUES (?,?)", [migration.hash, migration.folderMillis])
  }
}

test("production bootstrap native MySQL 0097 prevention matrix", { skip: !mysqlUrl || !isolated ? "needs: isolated mysql-0097-native world (DEN_DB_MYSQL_TEST_URL and DEN_DB_MYSQL_ISOLATED=1)" : false, timeout: 900_000 }, async t => {
  assert.ok(mysqlUrl)
  assert.equal(new URL(mysqlUrl).hostname, "127.0.0.1")
  const root = await mkdtemp(join(tmpdir(), "bootstrap-regression-"))
  const admin = await mysql.createConnection(mysqlUrl)
  const setting = await rows(admin, "SELECT @@GLOBAL.sql_require_primary_key AS pk")
  const databases: string[] = []
  const connections: mysql.Connection[] = []
  try {
    const old = await prepareRelease(root, originals[0])
    const original = await prepareRelease(root, originals[1])
    const originalMigrations = readMigrationFiles({ migrationsFolder: join(original, "drizzle") })
    assert.deepEqual(originalMigrations, migrations.slice(0, originalMigrations.length))
    assert.equal((await readFile(join(original, "drizzle/0097_gateway_access_matrix.sql"), "utf8")).split("\n")[85].trim(), "ALTER TABLE `gateway_request_logs` DROP PRIMARY KEY;--> statement-breakpoint")
    const packaged = await productionCopy(root)
    let baselineState: Awaited<ReturnType<typeof state>> | undefined
    const fixture = async (pk: boolean, baseline = old) => {
      await admin.query(`SET GLOBAL sql_require_primary_key=${pk ? "ON" : "OFF"}`)
      const name = `ow0097_${randomUUID().replace(/-/g, "")}`
      await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`)
      databases.push(name)
      const url = new URL(mysqlUrl)
      url.pathname = `/${name}`
      const connection = await mysql.createConnection(url.toString())
      connections.push(connection)
      if (baseline) {
        const result = bootstrap(baseline, url.toString())
        assert.equal(result.code, 0, result.output)
        await connection.query("INSERT INTO organization (id,name,slug,created_at,updated_at) VALUES ('org_upgrade_fixture','Upgrade fixture','upgrade-fixture','2026-01-01 00:00:00','2026-01-01 00:00:00')")
        if (baseline === old) {
          const actual = await state(connection)
          if (baselineState) assert.deepEqual(actual, baselineState, "fresh .35 fixture must match the identical original state")
          else baselineState = actual
        }
      }
      return { connection, url: url.toString() }
    }
    const traced = async (url: string, packageDir = db, acknowledgement: string | null = null) => {
      const before = await rows(admin, "SELECT @@GLOBAL.sql_require_primary_key AS pk")
      await admin.query("SET GLOBAL general_log=OFF")
      await admin.query("TRUNCATE TABLE mysql.general_log")
      await admin.query("SET GLOBAL log_output='TABLE'")
      await admin.query("SET GLOBAL general_log=ON")
      let result
      try { result = bootstrap(packageDir, url, acknowledgement) } finally { await admin.query("SET GLOBAL general_log=OFF") }
      const queries = (await rows(admin, "SELECT argument FROM mysql.general_log WHERE command_type='Query' ORDER BY event_time")).map(row => String(row.argument))
      assert.doesNotMatch(queries.join("\n"), /sql_require_primary_key|(?:DROP|ADD) PRIMARY KEY/i)
      assert.deepEqual(await rows(admin, "SELECT @@GLOBAL.sql_require_primary_key AS pk"), before)
      return { ...result, queries }
    }
    const unchanged = async (connection: mysql.Connection, action: () => void | Promise<void>) => {
      const before = await state(connection)
      try { await action() } finally { assert.deepEqual(await state(connection), before, "refusal/rerun changed DDL, data, or receipt IDs/order") }
    }
    const refused = async (connection: mysql.Connection, url: string, pattern: RegExp, acknowledgement: string | null = "1") => unchanged(connection, async () => {
      const result = await traced(url, packaged, acknowledgement)
      assert.ok(result.queries.every(query => !/^\s*(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(query)), "refusal executed writes")
      assert.equal(result.code, 1, result.output)
      assert.match(result.output, pattern)
      assert.match(result.output, /recovery/i)
      console.log(`[mysql-0097] expected refusal: ${result.output.trim()}`)
    })
    const reference = await fixture(false, original)
    const finalSchema = await schema(reference.connection)
    for (const pk of [true, false]) {
      await t.test(`clean .35 to patched; PK ${pk ? "ON" : "OFF"}`, async () => {
        const { connection, url } = await fixture(pk)
        await assertHistory(connection, 76)
        const before = await receipts(connection)
        const marker = await rows(connection, "SELECT * FROM organization")
        const result = await traced(url, packaged, "1")
        assert.equal(result.code, 0, result.output)
        assert.match(result.output, /preserving eight PRIMARY\(id\) keys/)
        await assertHistory(connection)
        assert.deepEqual((await receipts(connection)).slice(0, 76), before)
        assert.deepEqual(await rows(connection, "SELECT * FROM organization"), marker)
        await assertKeys(connection, targetNames)
        assert.deepEqual(await schema(connection), finalSchema)
        assert.equal(Number((await rows(connection, "SELECT @@sql_require_primary_key AS pk"))[0].pk), Number(pk))
        await unchanged(connection, () => { const rerun = bootstrap(db, url); assert.equal(rerun.code, 0, rerun.output); assert.doesNotMatch(rerun.output, /compatibility:|recorded original/) })
      })
      await t.test(`empty patched snapshot; PK ${pk ? "ON" : "OFF"}`, async () => {
        const { connection, url } = await fixture(pk, "")
        const result = await traced(url, packaged)
        assert.equal(result.code, 0, result.output)
        await assertHistory(connection)
        assert.deepEqual(await schema(connection), finalSchema)
        await unchanged(connection, () => assert.equal(bootstrap(db, url).code, 0))
        assert.equal(Number((await rows(connection, "SELECT @@sql_require_primary_key AS pk"))[0].pk), Number(pk))
      })
    }
    await t.test("original .48 red control executes through line 85; patched refuses without writes", async () => {
      const { connection, url } = await fixture(true)
      const result = bootstrap(original, url)
      assert.equal(result.code, 1, result.output)
      assert.match(result.output, /ALTER TABLE `gateway_request_logs` DROP PRIMARY KEY/)
      console.log(`[mysql-0097] original .48 expected failure: ${result.output.trim()}`)
      await assertHistory(connection, 96)
      await assertKeys(connection, targetNames)
      await refused(connection, url, /partial 0097/)
    })
    await t.test("already upgraded .48 OFF then ON is a data-preserving no-op", async () => {
      const { connection, url } = await fixture(false)
      assert.equal(bootstrap(original, url).code, 0)
      await admin.query("SET GLOBAL sql_require_primary_key=ON")
      await unchanged(connection, async () => {
        const result = await traced(url, packaged)
        assert.equal(result.code, 0, result.output)
        assert.doesNotMatch(result.output, /compatibility:|recorded original/)
        assert.doesNotMatch(result.queries.join("\n"), /generation_expression|GET_LOCK|seq_in_index AS seq|INSERT INTO.*__drizzle_migrations/i)
      })
      await assertKeys(connection, targetNames)
    })
    await t.test("already receipted 0097 runs later migrations normally with PK ON", async () => {
      const { connection, url } = await fixture(false)
      await advance(connection, 76, 97)
      const before = await receipts(connection)
      await admin.query("SET GLOBAL sql_require_primary_key=ON")
      const result = bootstrap(db, url)
      assert.equal(result.code, 0, result.output)
      assert.doesNotMatch(result.output, /compatibility:|recorded original/)
      await assertHistory(connection)
      assert.deepEqual((await receipts(connection)).slice(0, 97), before)
      assert.deepEqual(await schema(connection), finalSchema)
    })
    await t.test("clean 0096 preserves all original receipts (diagnostic error chain)", async () => {
      const { connection, url } = await fixture(true)
      await advance(connection, 76, 96)
      const before = await receipts(connection)
      const timestampMetadata = await rows(connection,
        "SELECT COLUMN_NAME, COLUMN_TYPE, COLUMN_DEFAULT, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='inference_providers' AND COLUMN_NAME IN ('created_at','updated_at') ORDER BY COLUMN_NAME",
      )
      console.log(`[mysql-0097] synthetic clean0096 inference_providers raw timestamp metadata: ${JSON.stringify(timestampMetadata)}`)
      const file = join(root, "diagnostic.mjs")
      await writeFile(file, `import { bootstrapDenDb } from ${JSON.stringify(join(db, "dist/scripts/bootstrap.js"))};\ntry { await bootstrapDenDb(); } catch (error) { console.error(error); process.exitCode=1; }\n`)
      const result = spawnSync(process.execPath, [file], { cwd: root, env: { ...env, DB_MODE: "mysql", DATABASE_URL: url, DEN_DB_0097_WRITERS_STOPPED: "1" }, encoding: "utf8", timeout: 120_000 })
      assert.equal(result.status, 0, result.stdout + result.stderr)
      assert.deepEqual((await receipts(connection)).slice(0, 96), before)
      await assertHistory(connection)
      await assertKeys(connection, targetNames)
    })
    for (const mutation of [
      { name: "nonempty source", sql: "INSERT INTO inference_rollup_lock (id) VALUES (1)", pattern: /nonempty intermediate/ },
      { name: "column drift", sql: "ALTER TABLE inference_providers ADD unexpected int", pattern: /affected schema differs|unsupported CHECK syntax/ },
      { name: "key drift", sql: "ALTER TABLE inference_providers ADD INDEX unexpected (id)", pattern: /affected schema differs|unsupported CHECK syntax/ },
      { name: "default drift", sql: "ALTER TABLE inference_providers ALTER COLUMN name SET DEFAULT 'unexpected'", pattern: /affected schema differs|unsupported CHECK syntax/ },
      { name: "CHECK drift", sql: "ALTER TABLE inference_providers ADD CONSTRAINT unexpected CHECK (id <> 'forbidden')", pattern: /affected schema differs|unsupported CHECK syntax/ },
      { name: "unknown 0097 receipt", sql: `INSERT INTO __drizzle_migrations (hash,created_at) VALUES ('unknown',${migrations[96].folderMillis})`, pattern: /history/ },
    ]) await t.test(`clean 0096 rejects ${mutation.name} before CREATE`, async () => {
      const { connection, url } = await fixture(true)
      await advance(connection, 76, 96)
      await assertKeys(connection, sourceNames)
      await connection.query(mutation.sql)
      await refused(connection, url, mutation.pattern)
    })
    for (const prefix of [76, 96]) {
      for (const acknowledgement of [null, "true"]) await t.test(`pending ${prefix} rejects ${acknowledgement === null ? "missing" : "invalid"} acknowledgement without writes`, async () => {
        const { connection, url } = await fixture(true)
        if (prefix === 96) await advance(connection, 76, 96)
        await refused(connection, url, /pending 0097 requires explicit external quiescence acknowledgement/, acknowledgement)
        await assertHistory(connection, prefix)
      })
    }
    await t.test("pending 0096 rejects non-InnoDB session default without changing it", async () => {
      const { connection, url } = await fixture(true)
      await advance(connection, 76, 96)
      const [before] = await rows(admin, "SELECT @@GLOBAL.default_storage_engine AS engine")
      assert.ok(typeof before.engine === "string")
      try {
        await admin.query("SET GLOBAL default_storage_engine='MyISAM'")
        await refused(connection, url, /SESSION default_storage_engine must be InnoDB/)
        assert.equal((await rows(admin, "SELECT @@GLOBAL.default_storage_engine AS engine"))[0].engine, "MyISAM")
      } finally { await admin.query("SET GLOBAL default_storage_engine=?", [before.engine]) }
    })
    await t.test("limited direct grants cannot conceal an affected trigger", async () => {
      const { connection, url } = await fixture(true)
      await advance(connection, 76, 96)
      await connection.query("CREATE TRIGGER ow0097_hidden BEFORE INSERT ON inference_providers FOR EACH ROW SET NEW.name = NEW.name")
      const triggerSql = "SELECT TRIGGER_NAME,ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() ORDER BY TRIGGER_NAME"
      const triggerBefore = await rows(connection, triggerSql)
      assert.equal(triggerBefore.length, 1)
      const name = `ow0097_${randomUUID().replace(/-/g, "").slice(0, 16)}`
      const password = randomUUID()
      await admin.query("CREATE USER ?@'localhost' IDENTIFIED BY ?", [name, password])
      let limited: mysql.Connection | undefined
      try {
        const database = new URL(url).pathname.slice(1)
        assert.match(database, /^ow0097_[a-f0-9]+$/)
        await admin.query(`GRANT SELECT, SHOW VIEW, REFERENCES, CREATE, ALTER, DROP, INSERT, UPDATE, DELETE, INDEX ON \`${database}\`.* TO ?@'localhost'`, [name])
        const limitedUrl = new URL(url)
        limitedUrl.username = name
        limitedUrl.password = password
        limited = await mysql.createConnection(limitedUrl.toString())
        assert.deepEqual(await rows(limited, triggerSql), [], "fixture must actually hide the trigger from the limited user")
        await refused(connection, limitedUrl.toString(), /insufficient direct database\/global SELECT, SHOW VIEW, TRIGGER or REFERENCES privileges/)
        assert.deepEqual(await rows(connection, triggerSql), triggerBefore)
      } finally {
        await limited?.end()
        await admin.query("DROP USER ?@'localhost'", [name])
      }
    })
    await t.test("acknowledged pending upgrade refuses an active same-database session", async () => {
      const { connection, url } = await fixture(true)
      await advance(connection, 76, 96)
      const active = await mysql.createConnection(url)
      const id = Number((await rows(active, "SELECT CONNECTION_ID() AS id"))[0].id)
      assert.ok(Number.isSafeInteger(id) && id > 0)
      const sleeping = active.query("SELECT SLEEP(60)").then(() => undefined, () => undefined)
      try {
        let visible = false
        for (let attempt = 0; attempt < 100; attempt++) {
          visible = (await rows(admin, "SELECT 1 FROM information_schema.PROCESSLIST WHERE ID=? AND COMMAND <> 'Sleep'", [id])).length === 1
          if (visible) break
          await delay(10)
        }
        assert.ok(visible, "active fixture query must be visible before bootstrap")
        await refused(connection, url, /another visible database session is active/)
      } finally {
        await admin.query(`KILL QUERY ${id}`)
        await sleeping
        await active.end()
      }
    })
    await t.test("real DDL interruption midway has no receipt; new process refuses", async () => {
      const { connection, url } = await fixture(true)
      await advance(connection, 76, 96)
      const before = await receipts(connection)
      const source = `import mysql from ${JSON.stringify(fileURLToPath(new URL("../node_modules/mysql2/promise.js", import.meta.url)))};\nimport { migrateWith0097Compatibility } from ${JSON.stringify(join(db, "dist/scripts/bootstrap.js"))};\nconst c = await mysql.createConnection(process.env.DATABASE_URL); let writes=0;\ntry { await migrateWith0097Compatibility({ async query(sql,args=[]) { if (/^(CREATE|ALTER|DROP|RENAME)/.test(sql.trim()) && ++writes===40) throw new Error('injected interruption'); const [rows]=await c.query(sql,args); return Array.isArray(rows)?rows:[]; } }, ${JSON.stringify(join(db, "dist/drizzle"))}, async()=>{throw new Error('unexpected ordinary migrator')}, console.log, {writersStoppedFor0097:true}); process.exitCode=2; } catch(e) { console.error(e); process.exitCode=1; } finally { await c.end(); }\n`
      const file = join(root, "interrupt.mjs")
      await writeFile(file, source)
      const result = spawnSync(process.execPath, [file], { env: { ...env, DATABASE_URL: url }, encoding: "utf8", timeout: 120_000 })
      assert.equal(result.status, 1, result.stdout + result.stderr)
      assert.match(result.stderr, /injected interruption/, "fixture must reach its injected DDL failure, not fail preflight")
      assert.match(result.stderr, /compatibility upgrade stopped/)
      assert.equal((await rows(connection, "SHOW TABLES LIKE 'gateway_credential_sets'")).length, 1)
      assert.deepEqual(await receipts(connection), before)
      await refused(connection, url, /partial 0097/)
    })
  } finally {
    for (const connection of connections) await connection.end()
    for (const name of databases) await admin.query(`DROP DATABASE \`${name}\``)
    await admin.query(`SET GLOBAL sql_require_primary_key=${Number(setting[0].pk) ? "ON" : "OFF"}`)
    await admin.end()
    await rm(root, { recursive: true, force: true })
  }
})
