import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { createServer } from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createDenDb } from "@openwork-ee/den-db"
import { ENV_PARITY_SNAPSHOTS, type EnvParitySnapshotName } from "../test/fixtures/env-parity/snapshots.js"

const serviceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const builtEntry = path.join(serviceDir, "dist", "main.js")
const deployMigration = path.resolve(serviceDir, "..", "..", "packages", "den-db", "dist", "scripts", "bootstrap.js")
const localMysql = process.env.DEN_ENV_SMOKE_MYSQL_URL?.trim() || "mysql://root:password@127.0.0.1:3306"
const localRedis = process.env.DEN_ENV_SMOKE_REDIS_URL?.trim() || "redis://127.0.0.1:6379/9"
const password = "Smoke-boot-password-9!"
const setupCode = "smoke-boot-setup-code-0123456789"

type Environment = Record<string, string>
type Answer = { path: string; status: number; body: string }

const servicesThisSmokeMustNotCall = [
  "RESEND_API_KEY", "LOOPS_API_KEY", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "LINEAR_API_KEY",
  "LIFECYCLE_EMAILS_ENABLED", "MCP_REGISTRATION_PROBE_ENABLED", "LOOPS_MARKETING_ENABLED",
]
const blockedByLoopbackDatabase = ["GATEWAY_ENABLED"]
const blocksAPasswordSignUpWithoutEmail = { DEN_REQUIRE_EMAIL_VERIFICATION: "false", DEN_BOTID_PROTECTION_ENABLED: "0" }

function onHostsThatNeverResolve(environment: Environment): Environment {
  return Object.fromEntries(Object.entries(environment).map(([name, value]) => [name, value.replaceAll("openworklabs.com", "openwork.example.test")]))
}

function without(environment: Environment, names: readonly string[]): Environment {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !names.includes(name)))
}

const SMOKES: Record<"openwork-cloud" | "minimal-self-hosted", { snapshot: EnvParitySnapshotName; local: (snapshot: Environment) => Environment }> = {
  "openwork-cloud": {
    snapshot: "openwork-cloud",
    local: (snapshot) => ({
      ...without(onHostsThatNeverResolve(snapshot), [...servicesThisSmokeMustNotCall, ...blockedByLoopbackDatabase]),
      ...blocksAPasswordSignUpWithoutEmail,
      DATABASE_REDIS_URL: localRedis,
      DATABASE_REDIS_ALLOW_INSECURE_INTERNAL: "0",
      DEN_OBSERVABILITY_BACKEND: "none",
    }),
  },
  "minimal-self-hosted": {
    snapshot: "minimal-self-hosted",
    local: (snapshot) => ({ ...snapshot, DEN_INITIAL_ADMIN_BOOTSTRAP_CODE: setupCode }),
  },
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (!address || typeof address === "string") throw new Error("No free port")
  return address.port
}

function adminPool() {
  const { client } = createDenDb({ databaseUrl: `${localMysql}/mysql`, mode: "mysql" })
  if (!("getConnection" in client)) throw new Error("The smoke needs a local MySQL")
  return client
}

function childEnvironment(environment: Environment): Environment {
  return { ...environment, PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }
}

function migrateAsADeploymentDoes(environment: Environment) {
  if (!existsSync(deployMigration)) throw new Error("Build the database package first: pnpm --filter @openwork-ee/den-db build")
  const migration = spawnSync(process.execPath, [deployMigration], { cwd: path.dirname(deployMigration), env: childEnvironment(environment), encoding: "utf8" })
  if (migration.status !== 0) throw new Error(`Migrations failed:\n${migration.stdout.slice(-2000)}\n${migration.stderr.slice(-2000)}`)
}

function start(environment: Environment): { child: ChildProcess; output: () => string } {
  const args = existsSync(builtEntry) ? [builtEntry] : ["--conditions=development", "--import", "tsx", path.join("src", "main.ts")]
  const child = spawn(process.execPath, args, { cwd: serviceDir, env: childEnvironment(environment), stdio: ["ignore", "pipe", "pipe"] })
  let output = ""
  child.stdout?.on("data", (chunk) => { output += String(chunk) })
  child.stderr?.on("data", (chunk) => { output += String(chunk) })
  return { child, output: () => output }
}

async function call(base: string, origin: string, pathname: string, init: { method?: string; token?: string; orgId?: string; body?: unknown } = {}): Promise<Answer & { json: unknown }> {
  const headers = new Headers({ origin })
  if (init.token) headers.set("authorization", `Bearer ${init.token}`)
  if (init.orgId) headers.set("x-openwork-org-id", init.orgId)
  if (init.body !== undefined) headers.set("content-type", "application/json")
  const response = await fetch(new URL(pathname, base), { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) })
  const body = await response.text()
  let json: unknown = null
  try { json = JSON.parse(body) } catch { json = null }
  return { path: pathname, status: response.status, body, json }
}

function read(value: unknown, ...keys: string[]): unknown {
  let current = value
  for (const key of keys) current = typeof current === "object" && current !== null ? Reflect.get(current, key) : undefined
  return current
}

function expectStatus(answer: Answer, status: number) {
  if (answer.status !== status) throw new Error(`${answer.path} answered ${answer.status}, expected ${status}: ${answer.body.slice(0, 600)}`)
}

async function untilHealthy(base: string, origin: string, server: { child: ChildProcess; output: () => string }) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) throw new Error(`den-api exited with ${server.child.exitCode} during startup:\n${server.output().slice(-4000)}`)
    const answer = await call(base, origin, "/health").catch(() => null)
    if (answer?.status === 200) return answer
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`den-api did not answer /health in two minutes:\n${server.output().slice(-4000)}`)
}

function secretValues(environment: Environment): { name: string; value: string }[] {
  return Object.entries(environment)
    .filter(([name, value]) => value.length >= 12 && /SECRET|KEY|TOKEN|PASS|CODE|DSN|DATABASE_URL|REDIS_URL/.test(name) && !/PRICE_ID|_ENABLED$/.test(name))
    .map(([name, value]) => ({ name, value }))
}

async function firstAdministrator(base: string, origin: string, environment: Environment) {
  const email = (environment.DEN_BOOTSTRAP_ADMIN_EMAILS ?? "").split(",")[0]?.trim().toLowerCase()
  if (!email) throw new Error("The environment names no first administrator")
  let bootstrapGrant: string | undefined
  if (environment.DEN_INITIAL_ADMIN_BOOTSTRAP_CODE) {
    const verified = await call(base, origin, "/v1/auth/bootstrap/verify", { method: "POST", body: { email, code: environment.DEN_INITIAL_ADMIN_BOOTSTRAP_CODE } })
    expectStatus(verified, 200)
    const grant = read(verified.json, "grant")
    if (typeof grant !== "string") throw new Error("The setup code was accepted without a grant")
    bootstrapGrant = grant
  }
  expectStatus(await call(base, origin, "/api/auth/sign-up/email", { method: "POST", body: { email, name: "First Administrator", password, ...(bootstrapGrant ? { bootstrapGrant } : {}) } }), 200)
  const signedIn = await call(base, origin, "/api/auth/sign-in/email", { method: "POST", body: { email, password } })
  expectStatus(signedIn, 200)
  const token = read(signedIn.json, "token")
  if (typeof token !== "string") throw new Error("Sign-in returned no session token")
  return { email, token }
}

async function smoke(name: keyof typeof SMOKES) {
  const stamp = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`
  const database = `den_env_smoke_${stamp}`
  const pool = adminPool()
  await pool.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`)
  const port = await freePort()
  const environment: Environment = {
    ...SMOKES[name].local({ ...ENV_PARITY_SNAPSHOTS[SMOKES[name].snapshot] }),
    DATABASE_URL: `${localMysql}/${database}`,
    PORT: String(port),
  }
  const base = `http://127.0.0.1:${port}`
  const origin = environment.DEN_BASE_URL ?? base
  let server: ReturnType<typeof start> | null = null
  try {
    migrateAsADeploymentDoes(environment)
    server = start(environment)
    const answers: Answer[] = [await untilHealthy(base, origin, server)]
    const ready = await call(base, origin, "/ready")
    expectStatus(ready, 200)
    answers.push(ready)

    const admin = await firstAdministrator(base, origin, environment)
    let orgId = ""
    if ((environment.DEN_ORG_MODE ?? "single_org") === "multi_org") {
      const created = await call(base, origin, "/v1/org", { method: "POST", token: admin.token, body: { name: "Smoke workspace" } })
      if (created.status >= 300) throw new Error(`Creating an organization answered ${created.status}: ${created.body.slice(0, 600)}`)
      const id = read(created.json, "organization", "id")
      if (typeof id !== "string") throw new Error("The created organization has no id")
      orgId = id
    }
    const org = await call(base, origin, "/v1/org", { token: admin.token, orgId })
    expectStatus(org, 200)
    const diagnostics = await call(base, origin, "/v1/org/diagnostics?include=config", { token: admin.token, orgId })
    expectStatus(diagnostics, 200)
    answers.push(org, diagnostics)

    const leaks = secretValues(environment).flatMap(({ name, value }) => answers.filter((answer) => answer.body.includes(value)).map((answer) => `${name} in ${answer.path}`))
    if (leaks.length > 0) throw new Error(`Secret values in responses: ${leaks.join(", ")}`)

    const installation = read(diagnostics.json, "installation")
    process.stdout.write([
      `${name}: ok (${existsSync(builtEntry) ? "built dist/main.js" : "source"}, ${Object.keys(environment).length} variables)`,
      ...answers.map((answer) => `  ${answer.status} ${answer.path}`),
      `  deployment=${String(read(diagnostics.json, "deployment"))} installation=${JSON.stringify(read(installation, "access"))} config=${JSON.stringify(read(installation, "config") ?? null)}`,
      `  ${secretValues(environment).length} secret values checked against ${answers.length} response bodies: none found`,
      "",
    ].join("\n"))
  } finally {
    server?.child.kill("SIGTERM")
    await pool.query(`DROP DATABASE IF EXISTS \`${database}\``).catch(() => undefined)
    await pool.end().catch(() => undefined)
  }
}

for (const name of ["openwork-cloud", "minimal-self-hosted"] as const) {
  await smoke(name)
}
