import { execFile } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { performance } from "node:perf_hooks"
import { resolve } from "node:path"
import { promisify } from "node:util"
import { createConnection, type Connection } from "mysql2/promise"

const USER_COUNT = 50_000
const ORGANIZATION_COUNT = 60_000
const TARGET_USER_INDEX = USER_COUNT - 7
const TARGET_ORGANIZATION_INDEX = ORGANIZATION_COUNT - 11
const SESSION_COUNT = USER_COUNT
const WORKER_COUNT = Math.ceil(USER_COUNT / 3)
const INVITATION_COUNT = Math.ceil(USER_COUNT / 5)
const TELEMETRY_EVENT_COUNT = Math.ceil(USER_COUNT / 4) * 2
const INITIAL_BUDGET_MS = 500
const SEARCH_BUDGET_MS = 300
const DEFAULT_DATABASE_URL = "mysql://root:password@127.0.0.1:3306/openwork_admin_scale_benchmark"
const execFileAsync = promisify(execFile)

type BenchmarkResult = {
  name: string
  durationMs: number
  rows: number
  total: number
  organizationTotal?: number
}

async function currentCleanGitCommitSha() {
  const [{ stdout: commitStdout }, { stdout: statusStdout }] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }),
    execFileAsync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }),
  ])
  const status = String(statusStdout).trim()
  if (status) {
    throw new Error(`Refusing to write admin scale benchmark artifact from a dirty tracked git tree. Commit or stash changes and rerun. Dirty paths:\n${status}`)
  }

  return String(commitStdout).trim()
}

function databaseName(url: URL) {
  return decodeURIComponent(url.pathname.replace(/^\//, ""))
}

function benchmarkDatabaseUrl() {
  const explicitUrl = process.env.ADMIN_SCALE_BENCHMARK_DATABASE_URL
  if (explicitUrl) {
    return explicitUrl
  }

  const baseUrl = process.env.DATABASE_URL
  if (!baseUrl) {
    return DEFAULT_DATABASE_URL
  }

  const url = new URL(baseUrl)
  const baseName = databaseName(url) || "openwork_den"
  const benchmarkName = baseName.includes("admin_scale_benchmark") ? baseName : `${baseName}_admin_scale_benchmark`
  url.pathname = `/${benchmarkName}`
  return url.toString()
}

function assertDisposableDatabase(name: string) {
  if (!/^[a-zA-Z0-9_]+$/.test(name) || !name.includes("admin_scale_benchmark")) {
    throw new Error(`Refusing to benchmark against non-disposable database ${JSON.stringify(name)}. Use a database name containing admin_scale_benchmark.`)
  }
}

async function connect(url: string) {
  return createConnection(url)
}

async function resetDatabase(databaseUrl: string) {
  const url = new URL(databaseUrl)
  const dbName = databaseName(url)
  assertDisposableDatabase(dbName)

  const serverUrl = new URL(databaseUrl)
  serverUrl.pathname = "/"
  const root = await connect(serverUrl.toString())
  await root.query(`DROP DATABASE IF EXISTS \`${dbName}\``)
  await root.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
  await root.end()
}

async function createTables(connection: Connection) {
  await connection.query("CREATE TABLE `user` (`id` varchar(64) NOT NULL, `name` varchar(255) NOT NULL, `email` varchar(255) NOT NULL, `email_verified` boolean NOT NULL DEFAULT false, `image` text, `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), PRIMARY KEY (`id`), UNIQUE KEY `user_email` (`email`), KEY `user_created_at_id` (`created_at`,`id`))")
  await connection.query("CREATE TABLE `organization` (`id` varchar(64) NOT NULL, `name` varchar(255) NOT NULL, `slug` varchar(255) NOT NULL, `logo` varchar(2048), `allowed_email_domains` json, `desktop_app_restrictions` json NOT NULL DEFAULT (json_object()), `metadata` json, `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), PRIMARY KEY (`id`), UNIQUE KEY `organization_slug` (`slug`), KEY `organization_created_at_id` (`created_at`,`id`))")
  await connection.query("CREATE TABLE `member` (`id` varchar(64) NOT NULL, `organization_id` varchar(64) NOT NULL, `user_id` varchar(64), `invite_id` varchar(64), `invited_by_org_member` varchar(64), `role` varchar(255) NOT NULL DEFAULT 'member', `joined_at` timestamp(3) DEFAULT CURRENT_TIMESTAMP(3), `removed_at` timestamp(3), `removed_by_org_member` varchar(64), `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY (`id`), KEY `member_organization_id` (`organization_id`), KEY `member_user_id` (`user_id`), KEY `member_invite_id` (`invite_id`), KEY `member_invited_by_org_member` (`invited_by_org_member`), KEY `member_removed_at` (`removed_at`), KEY `member_removed_by_org_member` (`removed_by_org_member`), UNIQUE KEY `member_organization_user` (`organization_id`,`user_id`))")
  await connection.query("CREATE TABLE `account` (`id` varchar(64) NOT NULL, `user_id` varchar(64) NOT NULL, `account_id` text NOT NULL, `provider_id` text NOT NULL, `access_token` text, `refresh_token` text, `access_token_expires_at` timestamp(3), `refresh_token_expires_at` timestamp(3), `scope` text, `id_token` text, `password` text, `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), PRIMARY KEY (`id`), KEY `account_user_id` (`user_id`))")
  await connection.query("CREATE TABLE `session` (`id` varchar(64) NOT NULL, `user_id` varchar(64) NOT NULL, `active_organization_id` varchar(64), `active_team_id` varchar(64), `token` varchar(255) NOT NULL, `expires_at` timestamp(3) NOT NULL, `ip_address` text, `user_agent` text, `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), PRIMARY KEY (`id`), UNIQUE KEY `session_token` (`token`), KEY `session_user_id` (`user_id`))")
  await connection.query("CREATE TABLE `worker` (`id` varchar(64) NOT NULL, `org_id` varchar(64) NOT NULL, `created_by_user_id` varchar(64), `name` varchar(255) NOT NULL, `description` varchar(1024), `destination` enum('local','cloud') NOT NULL, `status` enum('provisioning','healthy','failed','stopped') NOT NULL, `image_version` varchar(128), `workspace_path` varchar(1024), `sandbox_backend` varchar(64), `last_heartbeat_at` timestamp(3), `last_active_at` timestamp(3), `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), PRIMARY KEY (`id`), KEY `worker_org_id` (`org_id`), KEY `worker_created_by_user_id` (`created_by_user_id`), KEY `worker_status` (`status`), KEY `worker_last_heartbeat_at` (`last_heartbeat_at`), KEY `worker_last_active_at` (`last_active_at`))")
  await connection.query("CREATE TABLE `telemetry_event` (`id` varchar(64) NOT NULL, `org_id` varchar(64) NOT NULL, `member_id` varchar(64) NOT NULL, `event_type` varchar(64) NOT NULL, `event_timestamp` timestamp(3) NOT NULL, `source` varchar(32), `session_id` varchar(128), `duration_ms` int, `success` boolean, `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY (`id`), KEY `telemetry_event_org_id_type_ts` (`org_id`,`event_type`,`event_timestamp`), KEY `telemetry_event_org_id_member_id` (`org_id`,`member_id`), KEY `telemetry_event_member_ts` (`member_id`,`event_timestamp`), KEY `telemetry_event_org_session_ts` (`org_id`,`session_id`,`event_timestamp`))")
  await connection.query("CREATE TABLE `invitation` (`id` varchar(64) NOT NULL, `organization_id` varchar(64) NOT NULL, `email` varchar(255) NOT NULL, `role` varchar(255) NOT NULL, `status` varchar(32) NOT NULL DEFAULT 'pending', `team_id` varchar(64), `inviter_id` varchar(64) NOT NULL, `org_member_id` varchar(64), `invite_token` varchar(64), `expires_at` timestamp(3) NOT NULL, `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY (`id`), KEY `invitation_organization_id` (`organization_id`), KEY `invitation_email` (`email`), KEY `invitation_status` (`status`), KEY `invitation_team_id` (`team_id`), KEY `invitation_inviter_id` (`inviter_id`), KEY `invitation_org_member_id` (`org_member_id`), UNIQUE KEY `invitation_invite_token` (`invite_token`))")
  await connection.query("CREATE TABLE `org_subscriptions` (`id` varchar(64) NOT NULL, `organization_id` varchar(64) NOT NULL, `created_by_org_membership_id` varchar(64), `type` enum('inference','seat') NOT NULL, `status` enum('incomplete','incomplete_expired','trialing','active','past_due','canceled','unpaid','paused','expired') NOT NULL DEFAULT 'incomplete', `stripe_customer_id` varchar(255) NOT NULL, `stripe_subscription_id` varchar(255) NOT NULL, `stripe_price_id` varchar(255), `stripe_subscription_item_id` varchar(255), `quantity` int NOT NULL DEFAULT 0, `current_period_start` timestamp(3), `current_period_end` timestamp(3), `cancel_at_period_end` boolean NOT NULL DEFAULT false, `canceled_at` timestamp(3), `ended_at` timestamp(3), `last_event_id` varchar(255), `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), PRIMARY KEY (`id`), KEY `org_subscriptions_organization_id` (`organization_id`), KEY `org_subscriptions_customer_id` (`stripe_customer_id`), UNIQUE KEY `org_subscriptions_subscription_id` (`stripe_subscription_id`), UNIQUE KEY `org_subscriptions_org_type` (`organization_id`,`type`), KEY `org_subscriptions_status` (`status`))")
  await connection.query("CREATE TABLE `admin_allowlist` (`id` varchar(64) NOT NULL, `email` varchar(255) NOT NULL, `note` varchar(255), `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), PRIMARY KEY (`id`), UNIQUE KEY `admin_allowlist_email` (`email`))")
}

function typeId(prefix: string, index: number) {
  return `${prefix}_${String(index).padStart(26, "0")}`
}

function userId(index: number): `usr_${string}` {
  return `usr_${String(index).padStart(26, "0")}`
}

function organizationId(index: number) {
  return typeId("org", index)
}

function memberId(index: number) {
  return typeId("om", index)
}

function userRow(index: number) {
  const target = index === TARGET_USER_INDEX
  const createdAt = target ? "2026-06-01 12:00:00.000" : "2026-07-01 12:00:00.000"
  return [
    userId(index),
    target ? "Scale Search Target" : `User ${index}`,
    target ? "scale-search-target@example.com" : `user${index}@company${index % 997}.example`,
    index % 3 === 0 ? 0 : 1,
    createdAt,
    "2026-07-10 12:00:00.000",
  ]
}

function organizationRow(index: number) {
  const target = index === TARGET_ORGANIZATION_INDEX
  const createdAt = target ? "2026-06-01 12:00:00.000" : "2026-07-01 12:00:00.000"
  return [
    organizationId(index),
    target ? "Scale Performance Target Organization" : `Organization ${index}`,
    target ? "scale-performance-target" : `organization-${index}`,
    null,
    createdAt,
    "2026-07-10 12:00:00.000",
  ]
}

function accountRow(index: number) {
  const target = index === TARGET_USER_INDEX
  return [
    typeId("acc", index),
    userId(index),
    target ? "scale-search-target@example.com" : `acct-${index}`,
    target ? "scale-provider" : index % 2 === 0 ? "google" : "github",
    "2026-07-10 12:00:00.000",
    "2026-07-10 12:00:00.000",
  ]
}

function memberRow(index: number) {
  const target = index === TARGET_USER_INDEX
  const orgIndex = target ? TARGET_ORGANIZATION_INDEX : index
  return [
    memberId(index),
    organizationId(orgIndex),
    userId(index),
    target ? "owner" : index % 17 === 0 ? "admin" : "member",
    "2026-07-01 12:00:00.000",
    "2026-07-01 12:00:00.000",
  ]
}

function sessionRow(index: number) {
  const orgIndex = index === TARGET_USER_INDEX ? TARGET_ORGANIZATION_INDEX : index
  return [
    typeId("ses", index),
    userId(index),
    organizationId(orgIndex),
    `scale-session-token-${index}`,
    "2026-12-31 00:00:00.000",
    "2026-07-10 12:00:00.000",
    "2026-07-10 12:00:00.000",
  ]
}

function workerUserIndex(index: number) {
  return index === WORKER_COUNT - 1 ? TARGET_USER_INDEX : Math.min(index * 3, USER_COUNT - 1)
}

function workerRow(index: number) {
  const ownerIndex = workerUserIndex(index)
  const orgIndex = ownerIndex === TARGET_USER_INDEX ? TARGET_ORGANIZATION_INDEX : ownerIndex
  return [
    typeId("wrk", index),
    organizationId(orgIndex),
    userId(ownerIndex),
    `Worker ${index}`,
    index % 2 === 0 ? "cloud" : "local",
    "healthy",
    "2026-07-10 12:00:00.000",
    "2026-07-10 12:00:00.000",
    "2026-07-10 12:00:00.000",
    "2026-07-10 12:00:00.000",
  ]
}

function invitationUserIndex(index: number) {
  return index === INVITATION_COUNT - 1 ? TARGET_USER_INDEX : Math.min(index * 5, USER_COUNT - 1)
}

function invitationRow(index: number) {
  const inviterIndex = invitationUserIndex(index)
  const orgIndex = inviterIndex === TARGET_USER_INDEX ? TARGET_ORGANIZATION_INDEX : inviterIndex
  return [
    typeId("inv", index),
    organizationId(orgIndex),
    `invitee-${index}@example.com`,
    "member",
    index % 3 === 0 ? "accepted" : "pending",
    userId(inviterIndex),
    memberId(inviterIndex),
    `scale-invite-token-${index}`,
    "2026-08-01 00:00:00.000",
    "2026-07-02 12:00:00.000",
  ]
}

function telemetryUserIndex(index: number) {
  if (index >= TELEMETRY_EVENT_COUNT - 2) {
    return TARGET_USER_INDEX
  }

  return Math.min(Math.floor(index / 2) * 4, USER_COUNT - 1)
}

function telemetryRow(index: number) {
  const userIndex = telemetryUserIndex(index)
  const orgIndex = userIndex === TARGET_USER_INDEX ? TARGET_ORGANIZATION_INDEX : userIndex
  const taskEvent = index % 2 === 1
  return [
    typeId("tev", index),
    organizationId(orgIndex),
    memberId(userIndex),
    taskEvent ? "task.completed" : "session.active",
    taskEvent ? "2026-07-10 12:00:00.000" : "2026-07-09 12:00:00.000",
    "app",
    taskEvent ? `scale-session-${userIndex}` : null,
    taskEvent ? 1200 : null,
    taskEvent ? 1 : null,
    "2026-07-10 12:00:00.000",
  ]
}

async function insertBatches(connection: Connection, sql: string, count: number, buildRow: (index: number) => unknown[]) {
  const batchSize = 1000
  for (let start = 0; start < count; start += batchSize) {
    const rows: unknown[][] = []
    for (let index = start; index < Math.min(start + batchSize, count); index += 1) {
      rows.push(buildRow(index))
    }
    await connection.query(sql, [rows])
  }
}

async function seed(connection: Connection) {
  await insertBatches(
    connection,
    "INSERT INTO `user` (`id`,`name`,`email`,`email_verified`,`created_at`,`updated_at`) VALUES ?",
    USER_COUNT,
    userRow,
  )
  await insertBatches(
    connection,
    "INSERT INTO `organization` (`id`,`name`,`slug`,`metadata`,`created_at`,`updated_at`) VALUES ?",
    ORGANIZATION_COUNT,
    organizationRow,
  )
  await insertBatches(
    connection,
    "INSERT INTO `account` (`id`,`user_id`,`account_id`,`provider_id`,`created_at`,`updated_at`) VALUES ?",
    USER_COUNT,
    accountRow,
  )
  await insertBatches(
    connection,
    "INSERT INTO `member` (`id`,`organization_id`,`user_id`,`role`,`joined_at`,`created_at`) VALUES ?",
    USER_COUNT,
    memberRow,
  )
  await insertBatches(
    connection,
    "INSERT INTO `session` (`id`,`user_id`,`active_organization_id`,`token`,`expires_at`,`created_at`,`updated_at`) VALUES ?",
    SESSION_COUNT,
    sessionRow,
  )
  await insertBatches(
    connection,
    "INSERT INTO `worker` (`id`,`org_id`,`created_by_user_id`,`name`,`destination`,`status`,`last_heartbeat_at`,`last_active_at`,`created_at`,`updated_at`) VALUES ?",
    WORKER_COUNT,
    workerRow,
  )
  await insertBatches(
    connection,
    "INSERT INTO `invitation` (`id`,`organization_id`,`email`,`role`,`status`,`inviter_id`,`org_member_id`,`invite_token`,`expires_at`,`created_at`) VALUES ?",
    INVITATION_COUNT,
    invitationRow,
  )
  await insertBatches(
    connection,
    "INSERT INTO `telemetry_event` (`id`,`org_id`,`member_id`,`event_type`,`event_timestamp`,`source`,`session_id`,`duration_ms`,`success`,`created_at`) VALUES ?",
    TELEMETRY_EVENT_COUNT,
    telemetryRow,
  )
  await connection.query("INSERT INTO `admin_allowlist` (`id`,`email`,`note`,`created_at`,`updated_at`) VALUES ('aal_00000000000000000000000000','admin@example.com','Scale benchmark admin','2026-07-01 12:00:00.000','2026-07-01 12:00:00.000')")
}

async function printExplain(connection: Connection) {
  const userSearchEmail = "scale-search-target@example.com"
  const organizationSearchPattern = "%scale-performance-target%"
  const [userPlan] = await connection.query("EXPLAIN SELECT `id` FROM `user` ORDER BY `created_at` DESC, `id` DESC LIMIT 50")
  const [organizationPlan] = await connection.query("EXPLAIN SELECT `id` FROM `organization` ORDER BY `created_at` DESC, `id` DESC LIMIT 50")
  const [userSearchPlan] = await connection.query(
    "EXPLAIN SELECT `id` FROM `user` WHERE `email` = ? ORDER BY `created_at` DESC, `id` DESC LIMIT 50",
    [userSearchEmail],
  )
  const [organizationSearchPlan] = await connection.query(
    "EXPLAIN SELECT `id` FROM `organization` WHERE (lower(`name`) like ? escape '|' or lower(`slug`) like ? escape '|' or lower(`id`) like ? escape '|') ORDER BY `created_at` DESC, `id` DESC LIMIT 50",
    [organizationSearchPattern, organizationSearchPattern, organizationSearchPattern],
  )
  console.info(`explain initial users: ${JSON.stringify(userPlan)}`)
  console.info(`explain initial organizations: ${JSON.stringify(organizationPlan)}`)
  console.info(`explain user search: ${JSON.stringify(userSearchPlan)}`)
  console.info(`explain organization search: ${JSON.stringify(organizationSearchPlan)}`)
}

function toNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function readTotal(rows: unknown) {
  if (!Array.isArray(rows)) {
    return 0
  }

  const first = rows[0]
  return isRecord(first) ? toNumber(first.total) : 0
}

async function assertSeedCounts(connection: Connection) {
  const [userRows] = await connection.query("SELECT COUNT(*) AS total FROM `user`")
  const [organizationRows] = await connection.query("SELECT COUNT(*) AS total FROM `organization`")
  const [accountRows] = await connection.query("SELECT COUNT(*) AS total FROM `account`")
  const [memberRows] = await connection.query("SELECT COUNT(*) AS total FROM `member`")
  const [sessionRows] = await connection.query("SELECT COUNT(*) AS total FROM `session`")
  const [workerRows] = await connection.query("SELECT COUNT(*) AS total FROM `worker`")
  const [invitationRows] = await connection.query("SELECT COUNT(*) AS total FROM `invitation`")
  const [telemetryRows] = await connection.query("SELECT COUNT(*) AS total FROM `telemetry_event`")
  const userTotal = readTotal(userRows)
  const organizationTotal = readTotal(organizationRows)
  const accountTotal = readTotal(accountRows)
  const memberTotal = readTotal(memberRows)
  const sessionTotal = readTotal(sessionRows)
  const workerTotal = readTotal(workerRows)
  const invitationTotal = readTotal(invitationRows)
  const telemetryTotal = readTotal(telemetryRows)

  if (userTotal !== USER_COUNT || organizationTotal !== ORGANIZATION_COUNT) {
    throw new Error(`Seed count mismatch: users=${userTotal}, organizations=${organizationTotal}`)
  }
  if (accountTotal !== USER_COUNT || memberTotal !== USER_COUNT) {
    throw new Error(`Related seed count mismatch: accounts=${accountTotal}, members=${memberTotal}`)
  }
  if (sessionTotal !== SESSION_COUNT || workerTotal !== WORKER_COUNT || invitationTotal !== INVITATION_COUNT || telemetryTotal !== TELEMETRY_EVENT_COUNT) {
    throw new Error(`Enrichment seed count mismatch: sessions=${sessionTotal}, workers=${workerTotal}, invitations=${invitationTotal}, telemetry=${telemetryTotal}`)
  }
}

async function timed(name: string, task: () => Promise<{ rows: number; total: number; organizationTotal?: number }>): Promise<BenchmarkResult> {
  const startedAt = performance.now()
  const result = await task()
  return { name, durationMs: Math.round((performance.now() - startedAt) * 10) / 10, rows: result.rows, total: result.total, organizationTotal: result.organizationTotal }
}

async function main() {
  const gitCommitSha = await currentCleanGitCommitSha()
  const databaseUrl = benchmarkDatabaseUrl()
  const dbName = databaseName(new URL(databaseUrl))
  assertDisposableDatabase(dbName)

  console.info(`Resetting disposable benchmark database ${dbName}`)
  await resetDatabase(databaseUrl)
  const connection = await connect(databaseUrl)
  try {
    await createTables(connection)
    await seed(connection)
    await assertSeedCounts(connection)
    await printExplain(connection)
  } finally {
    await connection.end()
  }

  process.env.DATABASE_URL = databaseUrl
  process.env.DB_MODE = "mysql"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "local-dev-db-encryption-key-please-change-1234567890"
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "local-dev-secret-not-for-production-use!!"
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://localhost:3005"

  const adminRoutes = await import("../../../apps/den-api/src/routes/admin/index.js")
  const scale = await import("../../../apps/den-api/src/routes/admin/scale-performance.js")
  const viewer = { id: userId(0), email: "admin@example.com", name: "Scale Admin" }

  const initial = await timed("initial", async () => {
    const payload = await adminRoutes.loadAdminInitialOverviewPayload(viewer, scale.normalizeAdminPageRequest({ limit: "50" }))
    return { rows: payload.users.length, total: payload.summary.totalUsers, organizationTotal: payload.summary.totalOrganizations }
  })
  const userSearch = await timed("user-search", async () => {
    const result = await adminRoutes.loadAdminUsersPage(scale.normalizeAdminPageRequest({ limit: "50", search: "scale-search-target@example.com" }), false)
    return { rows: result.users.length, total: result.page.total }
  })
  const orgSearch = await timed("organization-search", async () => {
    const result = await adminRoutes.loadAdminOrganizationsPage(scale.normalizeAdminPageRequest({ limit: "50", search: "scale-performance-target" }))
    return { rows: result.organizations.length, total: result.page.total }
  })

  const results = [initial, userSearch, orgSearch]
  for (const result of results) {
    const organizationTotal = result.organizationTotal === undefined ? "" : `, organizations=${result.organizationTotal}`
    console.info(`${result.name}: ${result.durationMs} ms, rows=${result.rows}, total=${result.total}${organizationTotal}`)
  }

  if (initial.durationMs > INITIAL_BUDGET_MS || initial.rows > 50 || initial.total !== USER_COUNT || initial.organizationTotal !== ORGANIZATION_COUNT) {
    throw new Error(`Initial admin load failed budget/contract: ${JSON.stringify(initial)}`)
  }
  if (userSearch.durationMs > SEARCH_BUDGET_MS || userSearch.rows !== 1 || userSearch.total !== 1) {
    throw new Error(`User search failed budget/contract: ${JSON.stringify(userSearch)}`)
  }
  if (orgSearch.durationMs > SEARCH_BUDGET_MS || orgSearch.rows !== 1 || orgSearch.total !== 1) {
    throw new Error(`Organization search failed budget/contract: ${JSON.stringify(orgSearch)}`)
  }

  const outDir = resolve(process.cwd(), "../../../evals/results/admin-scale-performance-benchmark")
  await mkdir(outDir, { recursive: true })
  await writeFile(resolve(outDir, "latest.json"), JSON.stringify({
    users: USER_COUNT,
    organizations: ORGANIZATION_COUNT,
    gitCommitSha,
    gitDirty: false,
    generatedAt: new Date().toISOString(),
    results,
  }, null, 2))
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
