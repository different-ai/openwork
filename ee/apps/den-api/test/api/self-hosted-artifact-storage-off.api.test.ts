import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, list, summary, text, type Json } from "./harness.js"

/**
 * A self-hosted install that was never given artifact storage: no storage
 * fleet and none of the DEN_ARTIFACT_STORAGE_* settings, with an operator who
 * sets the feature's environment switch anyway. Den has to start, and
 * artifacts have to build, open and delete exactly as they did before the
 * feature existed.
 */
const den = await bootDen({ env: {
  DEN_DEPLOYMENT: "self_hosted",
  OPENWORK_DEV_MODE: "0",
  DEN_FEATURE_ARTIFACT_STORAGE: "true",
  DEN_ARTIFACT_STORAGE_BACKEND: "",
  DEN_ARTIFACT_STORAGE_LOCAL_DIR: "",
  DEN_ARTIFACT_STORAGE_CELLD_URL: "",
  DEN_ARTIFACT_STORAGE_CELLD_TOKEN: "",
} })
after(async () => { await den.close() })

const { env } = await import("../../src/env.js")
const { getMcpAppStorageBackend } = await import("../../src/mcp-app-storage/index.js")
const { retryMcpAppStorageDeletes } = await import("../../src/mcp-app-storage/lifecycle.js")

const { orgId, owner } = await den.createOrg(await den.signUp("Install owner"), "Self-hosted without storage")
const admin = den.as(owner, orgId)
const token = await den.mintMcpToken(owner, orgId)

const REACT = "export default function View() { return <p>Requests</p> }"
const STORAGE = { collections: [{ name: "requests", fields: [{ name: "title", type: "text", required: true }] }] }

async function tools(path: string): Promise<Record<string, Json>[]> {
  const response = await den.request(token, "POST", path, {
    headers: { accept: "application/json, text/event-stream" },
    body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  })
  assert.equal(response.status, 200, summary(response))
  const line = response.text.split("\n").find((entry) => entry.startsWith("data:"))
  const envelope: Json = line ? JSON.parse(line.slice(5)) : response.body
  return list(field(envelope, "result", "tools"))
}

test("Den starts with no storage settings and has no storage backend", async () => {
  assert.equal(env.artifactStorage.backend, null)
  assert.equal(getMcpAppStorageBackend(), null)
  const health = await den.request(null, "GET", "/health")
  assert.equal(health.status, 200, summary(health))
})

test("the feature cannot be turned on, by the operator's switch or for one organization", async () => {
  const change = await den.setFeature(orgId, "artifactStorage", true)
  assert.equal(change.status, 400, summary(change))
  const org = await admin("GET", "/v1/org")
  assert.equal(org.status, 200, summary(org))
  assert.equal(field(org.body, "features", "artifactStorage"), false)
})

test("artifacts build, open and delete as before, with no data tools anywhere", async () => {
  const authoring = await tools("/mcp/agent")
  const names = authoring.map((tool) => text(tool.name, "tool name"))
  assert.ok(!names.includes("read_app_data") && !names.includes("write_app_data"), "no data tools")
  for (const name of ["prepare_app", "create_app", "update_app"]) {
    const tool = authoring.find((entry) => entry.name === name)
    assert.ok(tool, `${name} is listed`)
    assert.ok(!JSON.stringify(tool).toLowerCase().includes("storage"), `${name} does not mention storage`)
  }

  const refused = await den.callMcpTool(token, "create_app", { title: "Saved requests", reactSource: REACT, textFallback: "Requests.", storage: STORAGE })
  assert.equal(refused.isError, true)
  assert.match(refused.text, /Unrecognized key: "storage"/u)

  const created = await den.callMcpTool(token, "create_app", { title: "Requests", reactSource: REACT, textFallback: "Requests." })
  assert.equal(created.isError, false, created.raw.slice(0, 600))
  const appId = text(field(created.structured, "app", "appId"), "app id")
  const own = (await tools(`/mcp/agent/connections/${appId}`)).map((tool) => text(tool.name, "tool name"))
  assert.ok(own.includes("open_app"), `the artifact opens: ${own.join(", ")}`)
  assert.ok(!own.includes("read_app_data") && !own.includes("write_app_data"), "the artifact has no data tools")

  const saved = await admin("GET", `/v1/mcp-apps/${appId}/storage`)
  assert.equal(saved.status, 404, summary(saved))
  assert.equal(field(saved.body, "error"), "feature_disabled")

  const deleted = await admin("POST", `/v1/config-objects/${appId}/delete`)
  assert.equal(deleted.status, 200, summary(deleted))
})

test("the background cleanup has nothing to do and fails nothing", async () => {
  assert.deepEqual(await retryMcpAppStorageDeletes(), { deleted: 0, failed: 0 })
})
