import assert from "node:assert/strict"
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

// Only disposable exp-o2-* resources are touched. Mac uses the existing Podman
// VM; Linux CI uses Docker directly. Architecture manifests are immutable.
const containerCommand = process.platform === "darwin" ? "podman" : "docker"
const amd64 = process.arch === "x64"
export const images = {
  before: `ghcr.io/different-ai/openwork-den-api@sha256:${amd64 ? "9076534aea522294235c1a9e9132a19e23fc2ea4ed952346bbde73613d64e27b" : "329dc3c2f2124430e19b7a2687f624a2c9680555014335d7eea0d1a010328b65"}`,
  after: `ghcr.io/different-ai/openwork-den-api@sha256:${amd64 ? "e41f91ac17cc6b3b09730c6affb59d6de69d55e470febc2791a03ed89a3158d3" : "d1dc9836d5d006164149358f35d7088f468053d53783866f44fb592d6b1b1b96"}`,
}
const root = fileURLToPath(new URL("../../", import.meta.url))
const api = "http://127.0.0.1:38919"
const origin = "http://127.0.0.1:38920"
const dbUrl = "mysql://root@127.0.0.1:33489/exp_o2"
const password = "Exp-o2-Disposable-123!"
const names = ["api", "web", "migrate", "db", "redis", "mail"]
export const preservedKeys = [
  "organization.update", "branding.update", "web_origins.manage", "members.update",
  "teams.manage_admin", "permissions.manage", "sso.manage", "scim.manage", "api_keys.manage",
  "egress_diagnostics.manage", "desktop_policies.manage", "billing_portal.use",
  "connections.update", "connections.delete",
].sort()

function run(command: string, args: string[], input?: string) {
  try {
    return execFileSync(command === "podman" ? containerCommand : command, args, { cwd: root, encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"], timeout: 240_000 })
  } catch (error) {
    // Child output can contain authentication/configuration data. Never relay it.
    const code = error && typeof error === "object" && "status" in error ? error.status : "unknown"
    throw new Error(`${command} ${args[0]} failed (exit ${code}); child output withheld`)
  }
}
async function until(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  throw new Error(`Timed out waiting for ${label}`)
}
export type Identity = { token: string; email: string }
type Result = { status: number; data: Record<string, unknown> }
function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value))
  return Object.fromEntries(Object.entries(value))
}
export function field(value: unknown, ...keys: string[]): unknown {
  let current = value
  for (const key of keys) current = record(current)[key]
  return current
}
function text(value: unknown): string { assert.equal(typeof value, "string"); return String(value) }
function success(result: Result, label: string) {
  assert.ok(result.status < 400, `${label}: HTTP ${result.status}`)
  return result.data
}

export class UpgradeLab {
  private forward: ChildProcess | undefined
  private branchBuilt = false
  private ip = 1
  readonly engine: "mysql" | "mariadb"
  constructor(engine: "mysql" | "mariadb") { this.engine = engine }
  sql(statement: string) {
    return run("podman", ["exec", "-i", "exp-o2-db", this.engine === "mysql" ? "mysql" : "mariadb", "-uroot", "--batch", "exp_o2"], statement)
  }
  rows(statement: string): Record<string, string>[] {
    const [header, ...lines] = this.sql(statement).trim().split("\n")
    const columns = header.split("\t")
    return lines.filter(Boolean).map(line => Object.fromEntries(line.split("\t").map((value, index) => [columns[index], value])))
  }
  async call(who: Identity | null, path: string, method = "GET", body?: unknown): Promise<Result> {
    const headers: Record<string, string> = { "content-type": "application/json", origin, "x-forwarded-for": `198.18.${Math.floor(this.ip / 250)}.${this.ip++ % 250 + 1}` }
    if (who) headers.authorization = `Bearer ${who.token}`
    const result = await fetch(api + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) })
    const bodyText = await result.text()
    return { status: result.status, data: bodyText ? record(JSON.parse(bodyText)) : {} }
  }
  async signup(label: string): Promise<Identity> {
    const email = `exp-o2-${label}@example.test`
    success(await this.call(null, "/api/auth/sign-up/email", "POST", { email, name: `exp-o2-${label}`, password }), "sign up")
    return this.login(email)
  }
  async login(email: string): Promise<Identity> {
    const body = success(await this.call(null, "/api/auth/sign-in/email", "POST", { email, password }), "sign in")
    return { email, token: text(body.token) }
  }
  stopApi() { run("podman", ["rm", "-f", "-v", "exp-o2-api"]) }
  async start() {
    assert.equal(run("podman", ["ps", "-a", "--filter", "name=exp-o2-", "--format", "{{.Names}}" ]).trim(), "", "owned lab names must be unused")
    assert.equal(run("podman", ["volume", "ls", "--filter", "name=exp-o2-", "--format", "{{.Name}}"] ).trim(), "", "owned volumes must be unused")
    const image = this.engine === "mysql"
      ? `docker.io/library/mysql@sha256:${amd64 ? "6f3a50835c54d61ffdcf78d71381ba268c27804cd96755231d2fd6f180f822f0" : "b3b90af2a6552ae30c266fdb7d5dd55f3afb72404bb78d37fe8a23eb857fd3fb"}`
      : `docker.io/library/mariadb@sha256:${amd64 ? "33a6653ab666774f48818120045f9367a81cd4c54c027412fe294a7d1274e2dc" : "250e1609e93c0e6aecf64bfbab2d84d5e89d2481540fe77447ff6c855c3b1873"}`
    run("podman", ["run", "-d", "--name", "exp-o2-db", "--network", "host", "--volume", "exp-o2-db-data:/var/lib/mysql", "-e", this.engine === "mysql" ? "MYSQL_ALLOW_EMPTY_PASSWORD=1" : "MARIADB_ALLOW_EMPTY_ROOT_PASSWORD=1", "-e", this.engine === "mysql" ? "MYSQL_DATABASE=exp_o2" : "MARIADB_DATABASE=exp_o2", image, "--port=33489", "--bind-address=127.0.0.1", "--performance_schema=OFF", "--innodb-buffer-pool-size=128M"])
    if (process.platform === "darwin") {
      const machine = record(JSON.parse(run("podman", ["machine", "inspect"]))[0])
      const ssh = record(machine.SSHConfig)
      this.forward = spawn("ssh", ["-i", text(ssh.IdentityPath), "-p", String(ssh.Port), "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "ExitOnForwardFailure=yes", "-N", "-L", "33489:127.0.0.1:33489", "-L", "38919:127.0.0.1:38919", "-L", "38920:127.0.0.1:38920", "core@127.0.0.1"], { stdio: "ignore" })
    }
    await until(async () => { try { this.sql("SELECT 1"); return true } catch { return false } }, "database")
    run("podman", ["run", "-d", "--name", "exp-o2-redis", "--network", "host", "--volume", "exp-o2-redis-data:/data", `docker.io/library/redis@sha256:${amd64 ? "8be847644e195abc4c10c8d9936cfa45332eccc6b714fa7b186ff43f1f4d5579" : "12bd99f4555ce357cbe0c950ad42c7a86f76e807244995f0ad0a6b8949c3518a"}`, "redis-server", "--port", "63489", "--bind", "127.0.0.1"])
    run("podman", ["run", "-d", "--name", "exp-o2-mail", "--network", "host", "-e", "MP_SMTP_BIND_ADDR=127.0.0.1:10389", "-e", "MP_UI_BIND_ADDR=127.0.0.1:8099", `docker.io/axllent/mailpit@sha256:${amd64 ? "938ce54b7b946ef3f45a03e119952cf7e67a7969d61f45a3ed055442a77e00f4" : "846fbb9d54be56bc6c1ad0f592239452448fac958545578743a9683277f0082f"}`])
  }
  publishedMigrate(image: string) {
    run("podman", ["run", "--rm", "--name", "exp-o2-migrate", "--network", "host", "-e", `DATABASE_URL=${dbUrl}`, "-e", "DEN_DB_ENCRYPTION_KEY=exp-o2-disposable-key-12345678901234567890", "--entrypoint", "sh", image, "-lc", "cd /app/ee/packages/den-db && node ./dist/scripts/bootstrap.js"])
  }
  snapshot() {
    return run("podman", ["exec", "exp-o2-db", this.engine === "mysql" ? "mysqldump" : "mariadb-dump", "-uroot", "--skip-comments", "--skip-extended-insert", "exp_o2"])
  }
  restore(snapshot: string) {
    this.sql("DROP DATABASE exp_o2; CREATE DATABASE exp_o2;")
    this.sql(snapshot)
    run("podman", ["exec", "exp-o2-redis", "redis-cli", "-p", "63489", "FLUSHALL"])
  }
  branchMigrate() {
    // CI's Den cache restores den-db/dist but not utils/dist; build the actual
    // PR-head bootstrap and its utilities once, including current migration SQL.
    if (!this.branchBuilt) {
      run("pnpm", ["--filter", "@openwork-ee/den-db", "build"])
      this.branchBuilt = true
    }
    // The real branch bootstrap, not extracted SQL or a reimplementation of the migrator.
    run("node", ["--input-type=module", "-e", `process.env.DATABASE_URL=${JSON.stringify(dbUrl)}; process.env.DEN_DB_ENCRYPTION_KEY='exp-o2-disposable-key-12345678901234567890'; const {bootstrapDenDb}=await import('./ee/packages/den-db/dist/scripts/bootstrap.js'); await bootstrapDenDb(); process.exit(0)`])
  }
  async serve(image: string) {
    const env: Record<string, string> = {
      DATABASE_URL: dbUrl, DATABASE_REDIS_URL: "redis://127.0.0.1:63489", SMTP_HOST: "127.0.0.1", SMTP_PORT: "10389", SMTP_SECURE: "false", EMAIL_FROM: "exp-o2@example.test",
      DEN_DB_ENCRYPTION_KEY: "exp-o2-disposable-key-12345678901234567890", BETTER_AUTH_SECRET: "exp-o2-disposable-auth-12345678901234567890",
      BETTER_AUTH_URL: origin, DEN_API_PUBLIC_URL: api, DEN_BASE_URL: origin, DEN_ORG_MODE: "multi_org", DEN_REQUIRE_EMAIL_VERIFICATION: "false",
      DEN_BETTER_AUTH_TRUSTED_ORIGINS: `${origin},${api}`, CORS_ORIGINS: `${origin},${api}`, DEN_TRUSTED_PROXIES: "127.0.0.1/32", DEN_AUDIT_SELF_HOSTED_ENABLED: "true",
      PROVISIONER_MODE: "stub", WORKER_URL_TEMPLATE: "https://workers.invalid/{workerId}", PORT: "38919", OPENWORK_DEV_MODE: "0", NODE_OPTIONS: "",
    }
    run("podman", ["run", "-d", "--name", "exp-o2-api", "--network", "host", ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]), image])
    await until(async () => { try { return (await fetch(`${api}/health`, { signal: AbortSignal.timeout(2000) })).ok } catch { return false } }, "API health")
  }
  async serveWeb() {
    const env = { PORT: "38920", DEN_BASE_URL: origin, DEN_API_BASE: api, DEN_API_PUBLIC_URL: api, DEN_AUTH_ORIGIN: origin, DEN_WEB_PUBLIC_ORIGIN: origin, DEN_WEB_OPENWORK_AUTH_CALLBACK_URL: origin, DEN_ORG_MODE: "multi_org" }
    run("podman", ["run", "-d", "--name", "exp-o2-web", "--network", "host", ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]), "ghcr.io/different-ai/openwork-den-web@sha256:606d4cef46b0863ba0aaac9869eadc1593d71650c66b1c0944a85d561dd704b3"])
    await until(async () => { try { return (await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(2000) })).ok } catch { return false } }, "web health")
  }
  replay0138() {
    const source = readFileSync(new URL("../../ee/packages/den-db/drizzle/0138_deprecate_super_admin.sql", import.meta.url), "utf8")
    this.sql(`START TRANSACTION;\n${source.split("--> statement-breakpoint").join("\n")}\nCOMMIT;`)
  }
  preservationState() {
    // Capture every preservation row, including archived tombstones and removed links.
    return ["team", "team_member", "permission_set", "permission_set_permission", "permission_set_team"].map(table =>
      this.sql(`SELECT * FROM \`${table}\` ORDER BY id`))
  }
  async close() {
    this.sql("DROP DATABASE IF EXISTS exp_o2")
    assert.equal(run("podman", ["exec", "exp-o2-db", this.engine === "mysql" ? "mysql" : "mariadb", "-uroot", "--batch", "--skip-column-names", "-e", "SHOW DATABASES LIKE 'exp_o2'"]).trim(), "", "owned database dropped before removing storage")
    const present = new Set(run("podman", ["ps", "-a", "--format", "{{.Names}}"] ).trim().split("\n"))
    for (const name of names) if (present.has(`exp-o2-${name}`)) run("podman", ["rm", "-f", "-v", `exp-o2-${name}`])
    for (const name of ["exp-o2-db-data", "exp-o2-redis-data"]) {
      run("podman", ["volume", "rm", name])
      assert.equal(run("podman", ["volume", "ls", "--filter", `name=^${name}$`, "--format", "{{.Name}}"] ).trim(), "", "owned volume removed")
    }
    this.forward?.kill("SIGTERM")
    await until(async () => !this.forward || this.forward.exitCode !== null || this.forward.signalCode !== null, "SSH forward exit")
    assert.equal(run("podman", ["ps", "-a", "--filter", "name=exp-o2-", "--format", "{{.Names}}"] ).trim(), "")
    const listeners = process.platform === "darwin" ? run("podman", ["machine", "ssh", "ss", "-ltn"]) : run("ss", ["-ltn"])
    assert.equal(listeners.split("\n").filter(line => /:(33489|38919|38920|63489|10389|8099)\s/.test(line)).length, 0, "owned VM ports closed")
    console.log(`${this.engine}: exp-o2 database, containers, volumes, SSH forward and VM ports removed and verified`)
  }
}

export async function buildCohort(lab: UpgradeLab) {
  const owner = await lab.signup("owner")
  const organization = success(await lab.call(owner, "/v1/org", "POST", { name: "exp-o2-preservation" }), "organization")
  const orgId = text(field(organization, "organization", "id"))
  const identities: Record<string, Identity> = { owner }
  const roles = { promoted: "member", invited: "super-admin", demoted: "super-admin", removed: "super-admin", admin: "admin", member: "member", teamadmin: "member", superteam: "super-admin", multi: "member", wrongcase: "member", substring: "member", ownercombo: "member" }
  for (const [label, role] of Object.entries(roles)) {
    const invite = success(await lab.call(owner, "/v1/invitations", "POST", { email: `exp-o2-${label}@example.test`, role }), `invite ${label}`)
    identities[label] = await lab.signup(label)
    success(await lab.call(identities[label], "/v1/orgs/invitations/accept", "POST", { id: invite.inviteToken }), `accept ${label}`)
  }
  const ids = Object.fromEntries(lab.rows(`SELECT m.id,u.email FROM member m JOIN user u ON u.id=m.user_id WHERE m.organization_id='${orgId}'`).map(row => [row.email.replace("exp-o2-", "").replace("@example.test", ""), row.id]))
  success(await lab.call(owner, `/v1/members/${ids.promoted}/role`, "POST", { role: "super-admin" }), "promote")
  success(await lab.call(owner, `/v1/members/${ids.demoted}/role`, "POST", { role: "admin" }), "demote")
  success(await lab.call(owner, `/v1/members/${ids.removed}`, "DELETE"), "remove")
  success(await lab.call(owner, "/v1/teams", "POST", { name: "Super Admins", grantsOrganizationAdmin: true, memberIds: [ids.teamadmin, ids.superteam, ids.owner] }), "existing same-name Admin team")
  const pending = success(await lab.call(owner, "/v1/invitations", "POST", { email: "exp-o2-pending@example.test", role: "super-admin" }), "pending invitation")
  const multi = await lab.call(owner, `/v1/members/${ids.multi}/role`, "POST", { role: "admin,super-admin" })
  assert.equal(multi.status, 400, "old API does not allow comma-list fixtures")
  // Explicit legacy-storage exceptions after observing API rejection. No history
  // is invented: the migration must read these current roles, never old evidence.
  for (const [label, role] of Object.entries({ multi: "admin, super-admin", wrongcase: "Super-Admin", substring: "not-super-admin", ownercombo: "owner, super-admin" }))
    lab.sql(`UPDATE member SET role='${role}' WHERE id='${ids[label]}'`)
  const second = await lab.signup("second-owner")
  success(await lab.call(second, "/v1/org", "POST", { name: "exp-o2-no-super-admins" }), "second organization")
  return { owner, orgId, identities, ids, pending }
}
