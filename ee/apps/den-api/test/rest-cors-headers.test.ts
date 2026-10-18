import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { AUTOMATION_MODEL_ATTENTION_CAPABILITY_HEADER } from "@openwork/types/automations"
import { denRestCorsHeaders } from "../src/rest-cors-headers.js"

const trusted = "http://127.0.0.1:5173"
function app() {
  const server = new Hono()
  server.use("*", cors({ origin: (origin) => origin === trusted ? origin : null, credentials: true, allowHeaders: [...denRestCorsHeaders], allowMethods: ["GET", "OPTIONS"] }))
  server.get("/v1/automations", (context) => context.json({ items: [], nextCursor: null }))
  return server
}

test("the real REST header policy admits the Automation client's capability preflight", async () => {
  const response = await app().request("http://den.local/v1/automations", { method: "OPTIONS", headers: {
    origin: trusted,
    "access-control-request-method": "GET",
    "access-control-request-headers": `authorization,x-openwork-org-id,${AUTOMATION_MODEL_ATTENTION_CAPABILITY_HEADER}`,
  } })
  assert.equal(response.status, 204)
  assert.equal(response.headers.get("access-control-allow-origin"), trusted)
  assert.equal(response.headers.get("access-control-allow-credentials"), "true")
  const headers = (response.headers.get("access-control-allow-headers") ?? "").toLowerCase().split(",")
  assert.ok(headers.includes(AUTOMATION_MODEL_ATTENTION_CAPABILITY_HEADER))
  assert.ok(headers.includes("authorization"))
  assert.ok(headers.includes("x-openwork-org-id"))
  assert.equal(headers.includes("x-den-internal-mcp-principal"), false)
})

test("accepting a client capability header does not admit an untrusted origin", async () => {
  const response = await app().request("http://den.local/v1/automations", { method: "OPTIONS", headers: {
    origin: "https://outside.example.test",
    "access-control-request-method": "GET",
    "access-control-request-headers": AUTOMATION_MODEL_ATTENTION_CAPABILITY_HEADER,
  } })
  assert.equal(response.headers.get("access-control-allow-origin"), null)
})
