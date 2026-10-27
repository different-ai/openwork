/**
 * In-process harness for den-api security tests.
 *
 * Boots the real den-api Hono app against a real, throwaway MySQL database and
 * talks to it only through the public HTTP API (better-auth sign-up/sign-in,
 * /v1/*, /mcp/*). Nothing in OpenWork is mocked. Outside services the tests
 * need (an MCP server, an OAuth authorization server) are small HTTP servers
 * the test starts itself; see `startFakeHttpServer`.
 *
 * Usage: `const den = await bootDen()` once per test file (node:test runs each
 * file in its own process, so each file gets its own database and app), then
 * `after(() => den.close())`.
 */
import { execFile } from "node:child_process"
import { randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { createDenDb, ensureSchemaRepairs } from "@openwork-ee/den-db"
import { inlineIndexes } from "./schema-statements.js"

const execFileAsync = promisify(execFile)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEN_DB_DIR = path.resolve(HERE, "../../../../packages/den-db")
const DEFAULT_MYSQL_URL = "mysql://root:password@127.0.0.1:3306"
const WEB_ORIGIN = "http://localhost:3005"
const API_ORIGIN = "http://127.0.0.1:8790"
const PASSWORD = "Correct-Horse-Battery-Staple-42!"

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type Call = { status: number; body: Json; text: string; headers: Headers }
export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
/** A signed-in person: the bearer token clients send, and the session cookie Den Web's browser holds. */
export type Session = { token: string; cookie: string; email: string; name: string; userId: string }
export type Member = Session & { memberId: string }
export type RequestOptions = { orgId?: string | null; headers?: Record<string, string>; body?: unknown; rawBody?: string }

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Read a nested field: `field(body, "team", "id")`. */
export function field(value: unknown, ...keys: string[]): unknown {
  let current = value
  for (const key of keys) current = isRecord(current) ? current[key] : undefined
  return current
}

export function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} missing`)
  return value
}

export function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

export function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
}

export function summary(call: Call): string {
  return `${call.status} ${call.text.slice(0, 400)}`
}

function parseJson(raw: string): Json {
  if (!raw.trim()) return null
  try {
    const parsed: Json = JSON.parse(raw)
    return parsed
  } catch {
    return raw
  }
}

function mysqlBaseUrl(): URL {
  const raw = process.env.DEN_API_TEST_MYSQL_URL?.trim() || DEFAULT_MYSQL_URL
  const url = new URL(raw)
  url.pathname = ""
  return url
}

function withDatabase(base: URL, database: string): string {
  const url = new URL(base.toString())
  url.pathname = `/${database}`
  return url.toString()
}

/** The schema as drizzle-kit sees it (`export` is offline: no credentials needed). */
async function schemaStatements(): Promise<string[]> {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--conditions=development", "--import", "tsx", "./node_modules/drizzle-kit/bin.cjs", "export", "--config", "drizzle.config.ts"],
    { cwd: DEN_DB_DIR, env: { ...process.env, DATABASE_URL: "" }, maxBuffer: 64 * 1024 * 1024 },
  )
  const start = stdout.indexOf("CREATE ")
  if (start < 0) throw new Error(`drizzle-kit export produced no schema:\n${stdout.slice(0, 500)}`)
  return inlineIndexes(stdout.slice(start).split(/;\s*\n/).map((statement) => statement.trim()).filter(Boolean))
}

/** A MySQL connection pool (never PlanetScale's HTTP client) for one database URL. */
function mysqlPool(databaseUrl: string) {
  const { client } = createDenDb({ databaseUrl, mode: "mysql" })
  if (!("getConnection" in client)) throw new Error("expected a MySQL pool")
  return client
}

async function createDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  const base = mysqlBaseUrl()
  const prefix = process.env.DEN_API_TEST_DATABASE_PREFIX || "den_api_test_"
  if (!/^[a-z0-9_-]{1,24}$/.test(prefix)) throw new Error("Invalid API test database prefix")
  const defaults = process.env.DEN_API_TEST_DATABASE_DEFAULTS || "utf8mb4"
  if (defaults !== "server" && defaults !== "utf8mb4") throw new Error("Invalid API test database defaults")
  const collation = process.env.DEN_API_TEST_DATABASE_COLLATION
  const collations: Record<string, string> = {
    latin1_swedish_ci: "latin1", utf8mb3_general_ci: "utf8mb3",
    utf8mb4_general_ci: "utf8mb4", utf8mb4_unicode_ci: "utf8mb4",
    utf8mb4_0900_ai_ci: "utf8mb4", utf8mb4_uca1400_ai_ci: "utf8mb4",
  }
  if (collation && !Object.hasOwn(collations, collation)) throw new Error("Invalid API test database collation")
  const charsetClause = collation ? ` CHARACTER SET ${collations[collation]} COLLATE ${collation}` : defaults === "server" ? "" : " CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
  const name = `${prefix}${process.pid}_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`
  const root = mysqlPool(withDatabase(base, "mysql"))
  const [statements] = await Promise.all([
    schemaStatements(),
    // Bootstrap's current schema has no table charset clauses: server defaults
    // must be testable without converting an already-created customer schema.
    root.query(`CREATE DATABASE \`${name}\`${charsetClause}`),
  ])
  const url = withDatabase(base, name)
  const target = mysqlPool(url)
  try {
    // Tables first, then indexes and foreign keys, a few at a time.
    const tables = statements.filter((statement) => statement.startsWith("CREATE TABLE"))
    const rest = statements.filter((statement) => !statement.startsWith("CREATE TABLE"))
    for (const group of [tables, rest]) {
      for (let index = 0; index < group.length; index += 8) {
        await Promise.all(group.slice(index, index + 8).map((statement) => target.query(statement)))
      }
    }
    await ensureSchemaRepairs({
      async query(sql, args) {
        const [rows] = await target.query(sql, args ?? [])
        const records: Record<string, unknown>[] = []
        const values: unknown[] = Array.isArray(rows) ? rows : []
        for (const row of values) if (isRecord(row)) records.push(row)
        return records
      },
    })
  } finally {
    await target.end()
  }
  return {
    url,
    async drop() {
      try {
        await root.query(`DROP DATABASE IF EXISTS \`${name}\``)
      } finally {
        await root.end()
      }
    },
  }
}

export type FakeHandler = (request: IncomingMessage, body: string, response: ServerResponse) => void | Promise<void>

/** A small outside service (an MCP server, an OAuth provider) for one test file. */
export async function startFakeHttpServer(handler: FakeHandler): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const chunks: Uint8Array[] = []
    request.on("data", (chunk: Uint8Array) => chunks.push(chunk))
    request.on("end", () => {
      Promise.resolve(handler(request, Buffer.concat(chunks).toString("utf8"), response)).catch((error: unknown) => {
        response.statusCode = 500
        response.end(String(error))
      })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address: AddressInfo | string | null = server.address()
  if (!address || typeof address === "string") throw new Error("fake server has no port")
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}

export type FakeMcpTool = { name: string; description: string; text: string }
export type WireEntry = { path: string; rpcMethod: string; authorization: string; status: number; sessionId?: string }
/**
 * What the fake MCP server answers for one request. `reply` = speak MCP;
 * otherwise a bare status (with optional headers/body), as a real service might.
 */
export type FakeMcpDecision = { reply: true } | { reply: false; status: number; headers?: Record<string, string>; body?: string }

/**
 * A small streamable-HTTP MCP server (JSON responses) that records every
 * request it receives: path, JSON-RPC method and the Authorization header.
 */
export async function startFakeMcpServer(options: {
  tools: FakeMcpTool[]
  decide?: (entry: { path: string; rpcMethod: string; authorization: string; rpcId: Json }) => FakeMcpDecision
  toolResult?: (entry: { path: string; authorization: string; tool: string }) => { isError: boolean; text: string }
}) {
  const wire: WireEntry[] = []
  const server = await startFakeHttpServer((request, raw, response) => {
    let rpcMethod = request.method ?? ""
    let rpcId: Json = null
    let params: Json = null
    const parsed = parseJson(raw)
    if (isRecord(parsed) && typeof parsed.method === "string") {
      rpcMethod = parsed.method
      rpcId = parsed.id ?? null
      params = parsed.params ?? null
    }
    const path = request.url ?? "/"
    const authorization = request.headers.authorization ?? ""
    const sessionHeader = request.headers["mcp-session-id"]
    const sessionId = rpcMethod === "initialize"
      ? randomBytes(16).toString("hex")
      : typeof sessionHeader === "string" ? sessionHeader : undefined
    const decision = options.decide?.({ path, rpcMethod, authorization, rpcId }) ?? { reply: true }
    if (!decision.reply) {
      wire.push({ path, rpcMethod, authorization, status: decision.status, sessionId })
      response.writeHead(decision.status, decision.headers ?? {}).end(decision.body ?? "")
      return
    }
    if (request.method !== "POST") {
      wire.push({ path, rpcMethod, authorization, status: 405, sessionId })
      response.writeHead(405).end()
      return
    }
    if (rpcId === null) {
      wire.push({ path, rpcMethod, authorization, status: 202, sessionId })
      response.writeHead(202).end()
      return
    }
    let result: Json
    if (rpcMethod === "initialize") {
      const requested = field(params, "protocolVersion")
      result = { protocolVersion: typeof requested === "string" ? requested : "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-mcp", version: "1.0.0" } }
    } else if (rpcMethod === "tools/list") {
      result = { tools: options.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: { type: "object", properties: {} } })) }
    } else if (rpcMethod === "tools/call") {
      const tool = String(field(params, "name"))
      const found = options.tools.find((entry) => entry.name === tool)
      const outcome = options.toolResult?.({ path, authorization, tool }) ?? { isError: !found, text: found?.text ?? "unknown tool" }
      result = { isError: outcome.isError, content: [{ type: "text", text: outcome.text }] }
    } else {
      result = {}
    }
    wire.push({ path, rpcMethod, authorization, status: 200, sessionId })
    response.writeHead(200, {
      "content-type": "application/json",
      ...(rpcMethod === "initialize" && sessionId ? { "mcp-session-id": sessionId } : {}),
    }).end(JSON.stringify({ jsonrpc: "2.0", id: rpcId, result }))
  })
  return { ...server, wire }
}

/**
 * An MCP server that signs people in as its own OAuth authorization server
 * (RFC 9728 discovery, dynamic client registration, PKCE code flow).
 * `responseIssuer` adds RFC 9207 `iss` to the authorization reply;
 * `protectedResource` makes it declare a resource other than its own /mcp.
 */
export async function startFakeOAuthMcpServer(options: { responseIssuer?: boolean; protectedResource?: string } = {}) {
  const requests: { method: string; path: string }[] = []
  const issued = new Set<string>()
  const codes = new Set<string>()
  let counter = 0
  let issuer = ""
  const json = (response: ServerResponse, status: number, body: Json, headers: Record<string, string> = {}): void => {
    response.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body))
  }
  const server = await startFakeHttpServer((request, raw, response) => {
    const url = new URL(request.url ?? "/", issuer)
    requests.push({ method: request.method ?? "", path: url.pathname })
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource") || url.pathname === "/mcp/.well-known/oauth-protected-resource") {
      json(response, 200, { resource: options.protectedResource ?? `${issuer}/mcp`, authorization_servers: [issuer], scopes_supported: ["mcp:read"], bearer_methods_supported: ["header"] })
      return
    }
    if (url.pathname.startsWith("/.well-known/oauth-authorization-server") || url.pathname.startsWith("/.well-known/openid-configuration")) {
      json(response, 200, {
        issuer,
        ...(options.responseIssuer ? { authorization_response_iss_parameter_supported: true } : {}),
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: ["mcp:read"],
      })
      return
    }
    if (url.pathname === "/register" && request.method === "POST") {
      const body = parseJson(raw)
      counter += 1
      json(response, 201, { client_id: `fake-client-${counter}`, client_id_issued_at: Math.floor(Date.now() / 1000), redirect_uris: field(body, "redirect_uris") === undefined ? [] : parseJson(JSON.stringify(field(body, "redirect_uris"))), token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] })
      return
    }
    if (url.pathname === "/authorize" && request.method === "GET") {
      const redirectUri = url.searchParams.get("redirect_uri")
      if (!redirectUri) return json(response, 400, { error: "invalid_request" })
      counter += 1
      const code = `fake-code-${counter}`
      codes.add(code)
      const callback = new URL(redirectUri)
      callback.searchParams.set("code", code)
      const state = url.searchParams.get("state")
      if (state) callback.searchParams.set("state", state)
      if (options.responseIssuer) callback.searchParams.set("iss", issuer)
      response.writeHead(302, { location: callback.toString() }).end()
      return
    }
    if (url.pathname === "/token" && request.method === "POST") {
      const form = new URLSearchParams(raw)
      const code = form.get("code") ?? ""
      if (form.get("grant_type") === "authorization_code" && !codes.delete(code)) return json(response, 400, { error: "invalid_grant" })
      counter += 1
      const token = `fake-access-${counter}`
      issued.add(token)
      json(response, 200, { access_token: token, token_type: "Bearer", expires_in: 3600, refresh_token: `fake-refresh-${counter}`, scope: "mcp:read" })
      return
    }
    if (url.pathname === "/mcp") {
      const bearer = (request.headers.authorization ?? "").replace(/^Bearer /, "")
      if (!issued.has(bearer)) {
        response.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource"` }).end()
        return
      }
      const parsed = parseJson(raw)
      const rpcId = field(parsed, "id")
      const method = field(parsed, "method")
      if (request.method !== "POST") return void response.writeHead(405).end()
      if (rpcId === undefined) return void response.writeHead(202).end()
      const result: Json = method === "initialize"
        ? { protocolVersion: String(field(parsed, "params", "protocolVersion") ?? "2025-06-18"), capabilities: { tools: {} }, serverInfo: { name: "fake-oauth-mcp", version: "1.0.0" } }
        : method === "tools/list" ? { tools: [{ name: "read_notes", description: "Read notes", inputSchema: { type: "object", properties: {} } }] }
        : { content: [{ type: "text", text: "notes" }] }
      json(response, 200, { jsonrpc: "2.0", id: parseJson(JSON.stringify(rpcId)), result })
      return
    }
    json(response, 404, { error: "not_found" })
  })
  issuer = server.url
  return {
    ...server,
    mcpUrl: `${server.url}/mcp`,
    tokenRequests: () => requests.filter((entry) => entry.path === "/token").length,
    requests,
  }
}

export type McpToolResult = { status: number; isError: boolean; rpcError: Json; text: string; body: Json; structured: Json; raw: string }

export type Den = Awaited<ReturnType<typeof bootDen>>

/**
 * Create the database, set the environment, import the app.
 * `platformAdminEmail` is seeded into the deployment's platform-admin allowlist
 * (the same DEN_BOOTSTRAP_ADMIN_EMAILS a self-hosted operator sets) so the test
 * can turn organization features on from /v1/admin.
 */
export async function bootDen(options: { env?: Record<string, string> } = {}) {
  const stamp = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`
  const platformAdminEmail = `platform-admin+${stamp}@example.test`
  const database = await createDatabase()
  Object.assign(process.env, {
    DATABASE_URL: database.url,
    DB_MODE: "mysql",
    DATABASE_REDIS_URL: "",
    DEN_DB_ENCRYPTION_KEY: "den-api-test-db-encryption-key-not-for-production-1234567890",
    BETTER_AUTH_SECRET: "den-api-test-better-auth-secret-not-for-production!!",
    BETTER_AUTH_URL: WEB_ORIGIN,
    DEN_BASE_URL: WEB_ORIGIN,
    DEN_API_PUBLIC_URL: API_ORIGIN,
    DEN_BETTER_AUTH_TRUSTED_ORIGINS: `${WEB_ORIGIN},${API_ORIGIN}`,
    CORS_ORIGINS: `${WEB_ORIGIN},${API_ORIGIN}`,
    DEN_ORG_MODE: "multi_org",
    DEN_REQUIRE_EMAIL_VERIFICATION: "false",
    DEN_PASSWORD_BREACH_SCREENING_ENABLED: "false",
    DEN_PLAN_GATING_ENABLED: "false",
    DEN_BOOTSTRAP_ADMIN_EMAILS: platformAdminEmail,
    DEN_ALLOW_PRIVATE_MCP_URLS: "true",
    OPENWORK_DEV_MODE: "1",
    PROVISIONER_MODE: "stub",
    RESEND_API_KEY: "",
    STRIPE_SECRET_KEY: "",
    LOOPS_API_KEY: "",
    OTEL_SDK_DISABLED: "true",
    ...options.env,
  })
  const app = await import("../../src/app.js").then((module) => module.default, async (error: unknown) => {
    await database.drop().catch(() => undefined)
    throw error
  })

  async function request(token: string | null, method: Method, pathname: string, options: RequestOptions = {}): Promise<Call> {
    const headers = new Headers({ origin: WEB_ORIGIN, ...options.headers })
    if (token) headers.set("authorization", `Bearer ${token}`)
    if (options.orgId) headers.set("x-openwork-org-id", options.orgId)
    let body: string | undefined = options.rawBody
    if (options.body !== undefined) {
      body = JSON.stringify(options.body)
      if (!headers.has("content-type")) headers.set("content-type", "application/json")
    }
    const response = await app.request(new URL(pathname, API_ORIGIN).toString(), { method, headers, body })
    const raw = await response.text()
    return { status: response.status, body: parseJson(raw), text: raw, headers: response.headers }
  }

  async function signIn(email: string, password = PASSWORD): Promise<Call> {
    return request(null, "POST", "/api/auth/sign-in/email", { body: { email, password } })
  }

  /** A new person signs up through the public endpoint and signs in. */
  async function signUp(name: string, email = `${name.toLowerCase().replace(/[^a-z]+/g, "-")}+${stamp}@example.test`): Promise<Session> {
    const created = await request(null, "POST", "/api/auth/sign-up/email", { body: { email, name, password: PASSWORD } })
    if (created.status !== 200) throw new Error(`sign-up ${email}: ${summary(created)}`)
    const signedIn = await signIn(email)
    if (signedIn.status !== 200) throw new Error(`sign-in ${email}: ${summary(signedIn)}`)
    const cookie = signedIn.headers.get("set-cookie")?.split(";")[0]?.trim() ?? ""
    return { token: text(field(signedIn.body, "token"), "session token"), cookie, email, name, userId: text(field(signedIn.body, "user", "id"), "user id") }
  }

  /** The person creates an organization and becomes its owner. */
  async function createOrg(owner: Session, name: string): Promise<{ orgId: string; owner: Member }> {
    const created = await request(owner.token, "POST", "/v1/org", { body: { name } })
    if (created.status >= 300) throw new Error(`create org ${name}: ${summary(created)}`)
    const orgId = text(field(created.body, "organization", "id"), "organization id")
    return { orgId, owner: { ...owner, memberId: await memberIdOf(owner, orgId, owner.email) } }
  }

  async function memberIdOf(viewer: Session, orgId: string, email: string): Promise<string> {
    const roster = await request(viewer.token, "GET", "/v1/org", { orgId })
    const member = list(field(roster.body, "members")).find((entry) => field(entry, "user", "email") === email)
    return text(member?.id, `member id for ${email}`)
  }

  /** An inviter invites the person and they accept through the public API. */
  async function join(inviter: Session, orgId: string, person: Session, role: "member" | "admin" = "member"): Promise<Member> {
    const invited = await request(inviter.token, "POST", "/v1/invitations", { orgId, body: { email: person.email, role } })
    const inviteToken = field(invited.body, "inviteToken")
    if (invited.status >= 300 || typeof inviteToken !== "string") throw new Error(`invite ${person.email}: ${summary(invited)}`)
    const accepted = await request(person.token, "POST", "/v1/orgs/invitations/accept", { body: { id: inviteToken } })
    if (accepted.status >= 300) throw new Error(`accept ${person.email}: ${summary(accepted)}`)
    return { ...person, memberId: await memberIdOf(inviter, orgId, person.email) }
  }

  /** Sign up a fresh person and add them to the organization. */
  async function newMember(inviter: Session, orgId: string, name: string, role: "member" | "admin" = "member"): Promise<Member> {
    return join(inviter, orgId, await signUp(name), role)
  }

  async function createTeam(owner: Session, orgId: string, name: string, memberIds: string[], extra: Record<string, unknown> = {}): Promise<string> {
    const created = await request(owner.token, "POST", "/v1/teams", { orgId, body: { name, memberIds, ...extra } })
    if (created.status !== 201) throw new Error(`create team ${name}: ${summary(created)}`)
    return text(field(created.body, "team", "id"), "team id")
  }

  let platformAdmin: Session | null = null
  /** A platform administrator turns an organization feature on or off from /admin. */
  async function setFeature(orgId: string, key: string, enabled: boolean): Promise<Call> {
    platformAdmin ??= await signUp("Platform Admin", platformAdminEmail)
    return request(platformAdmin.token, "PUT", `/v1/admin/organizations/${encodeURIComponent(orgId)}/capabilities`, {
      body: { capabilities: { [key]: enabled } },
    })
  }

  /** Request helper bound to one person and one organization, sending what Den Web sends: bearer and session cookie. */
  function as(session: Session, orgId: string) {
    return (method: Method, pathname: string, body?: unknown, headers?: Record<string, string>) =>
      request(session.token, method, pathname, { orgId, body, headers: { ...(session.cookie ? { cookie: session.cookie } : {}), ...headers } })
  }

  /** An MCP token for this person, as OpenWork's clients mint one. */
  async function mintMcpToken(session: Session, orgId: string): Promise<string> {
    const issued = await request(session.token, "POST", "/v1/mcp/token", { orgId, body: { scopes: ["mcp:read", "mcp:write"] } })
    return text(field(issued.body, "token"), `MCP token for ${session.email} (${summary(issued)})`)
  }

  /** One tools/call on OpenWork's MCP gateway, exactly as an MCP client sends it. */
  async function callMcpTool(token: string, name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const response = await request(token, "POST", "/mcp/agent", {
      headers: { accept: "application/json, text/event-stream" },
      body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    })
    const line = response.text.split("\n").find((entry) => entry.startsWith("data:"))
    const envelope = line ? parseJson(line.slice(5)) : response.body
    const result = field(envelope, "result")
    const content = list(field(result, "content"))
    const first = content.find((part) => part.type === "text")
    const firstText = typeof first?.text === "string" ? first.text : ""
    const rpcError = field(envelope, "error")
    const structured = field(result, "structuredContent")
    return {
      status: response.status,
      isError: field(result, "isError") === true,
      rpcError: rpcError === undefined ? null : parseJson(JSON.stringify(rpcError)),
      text: firstText,
      body: parseJson(firstText),
      structured: structured === undefined ? null : parseJson(JSON.stringify(structured)),
      raw: response.text,
    }
  }

  /**
   * ARRANGE ONLY: mark the organization's saved SSO connection enabled, as if
   * its owner had completed the interactive IdP test (a separate journey that
   * needs a real IdP). SCIM token issuance requires an enabled connection.
   * Never use this to observe an outcome.
   */
  async function arrangeSsoConnectionEnabled(orgId: string): Promise<void> {
    const { client } = await import("../../src/db.js")
    if (!("getConnection" in client)) throw new Error("arrangeSsoConnectionEnabled needs MySQL mode")
    await client.execute("UPDATE sso_connection SET status = 'enabled' WHERE organization_id = ?", [orgId])
  }

  /**
   * READ ONLY: everything the audit tables hold, as one string, so a test can
   * prove a secret was never stored (not just never returned by the API).
   */
  async function auditStorageText(): Promise<string> {
    const { client } = await import("../../src/db.js")
    if (!("getConnection" in client)) throw new Error("auditStorageText needs MySQL mode")
    const parts: string[] = []
    for (const table of ["audit_event", "audit_event_resource", "audit_operation", "audit_operation_step"]) {
      const [rows] = await client.query(`SELECT * FROM \`${table}\``)
      parts.push(JSON.stringify(rows))
    }
    return parts.join("\n")
  }

  return {
    app,
    stamp,
    auditStorageText,
    arrangeSsoConnectionEnabled,
    mintMcpToken,
    callMcpTool,
    password: PASSWORD,
    request,
    signIn,
    signUp,
    createOrg,
    join,
    newMember,
    memberIdOf,
    createTeam,
    setFeature,
    as,
    async close() {
      const { client } = await import("../../src/db.js")
      if ("getConnection" in client) await client.end().catch(() => undefined)
      await database.drop()
    },
  }
}
