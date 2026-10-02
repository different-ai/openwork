import { writeFile } from "node:fs/promises"
import { Hono } from "hono"
import { generateSpecs } from "hono-openapi"
import type { RequestIdVariables } from "hono/request-id"
import type { OrgRouteVariables } from "../src/routes/org/shared.js"

const output = process.env.DEN_AUDIT_API_SPEC_PATH
if (!output) throw new Error("Set DEN_AUDIT_API_SPEC_PATH to a temporary OpenAPI output file")
const databaseUrl = process.env.DEN_AUDIT_TEST_DATABASE_URL
if (!databaseUrl) throw new Error("Set DEN_AUDIT_TEST_DATABASE_URL to a prepared disposable audit_logs_test database")
const parsed = new URL(databaseUrl)
if (parsed.protocol !== "mysql:" || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) || !/^\/audit_logs_test(?:_[a-z0-9_]+)?$/.test(parsed.pathname)) throw new Error("Disposable loopback audit_logs_test database required; connection withheld.")
Object.assign(process.env, {
  DATABASE_URL: databaseUrl,
  DB_MODE: "mysql", NODE_ENV: "test", OPENWORK_DEV_MODE: "1",
  DEN_DB_ENCRYPTION_KEY: "synthetic-audit-contract-key-1234567890",
  BETTER_AUTH_SECRET: "synthetic-audit-contract-secret-1234567890",
  BETTER_AUTH_URL: "http://127.0.0.1:8790", DEN_BASE_URL: "http://127.0.0.1:8790",
})
const { registerOrgAuditRoutes } = await import("../src/routes/org/audit.js")
const app = new Hono<{ Variables: OrgRouteVariables & RequestIdVariables }>()
registerOrgAuditRoutes(app)
const document = await generateSpecs(app, {
  documentation: {
    info: { title: "Audit read API", version: "1.0.0", description: "Bounded organization-scoped administrator audit history.", contact: { name: "OpenWork", email: "team@openworklabs.com" } },
    tags: [{ name: "Organizations", description: "Organization administration and retained audit history." }],
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "session-token" }, denApiKey: { type: "apiKey", in: "header", name: "x-api-key" } } },
    servers: [{ url: "http://127.0.0.1:8790", description: "Disposable contract test" }],
  },
})
await writeFile(output, JSON.stringify(document, null, 2))
const { auth } = await import("../src/auth.js")
await auth.$context
const { client } = await import("../src/db.js")
if ("end" in client) await client.end()
