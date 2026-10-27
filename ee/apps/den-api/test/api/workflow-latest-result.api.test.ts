import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, list, summary, text } from "./harness.js"

const den = await bootDen()
after(() => den.close())

test("Workflow latest results follow saved execution order, not authoring or example input", async (t) => {
  const { orgId, owner } = await den.createOrg(await den.signUp("Latest result owner"), "Workflow latest result regression")
  const api = den.as(owner, orgId)
  const token = await den.mintMcpToken(owner, orgId)
  // Synthetic native script only: no model inference or external provider calls.
  const inputSchema = { type: "object", properties: { marker: { type: "string" } }, required: ["marker"], additionalProperties: false }
  const authored = await den.callMcpTool(token, "execute_capability_script", {
    code: "return {marker: input.marker}", inputSchema, input: { marker: "authoring-example" },
  })
  assert.equal(authored.isError, false, authored.raw.slice(0, 400))
  const authoringReceiptId = text(field(authored.structured, "metadata", "receiptId"), "authoring receipt")
  const saved = await api("POST", "/v1/workflows", {
    name: "Latest result fixture", receiptId: authoringReceiptId, inputSchema, currentInput: { marker: "authoring-example" },
  })
  assert.equal(saved.status, 201, summary(saved))
  const workflowId = text(field(saved.body, "configObjectId"), "workflow id")
  const pluginId = text(field(saved.body, "pluginId"), "plugin id")
  const versionId = text(field(saved.body, "configObjectVersionId"), "version id")

  async function inspect(expected: Array<{ receiptId: string; marker: string }>) {
    const detail = await api("GET", `/v1/workflows/${workflowId}`)
    const snapshots = await api("GET", `/v1/workflows/${workflowId}/snapshots`)
    assert.equal(detail.status, 200, summary(detail))
    assert.equal(snapshots.status, 200, summary(snapshots))
    const items = list(field(snapshots.body, "items"))
    t.diagnostic(JSON.stringify({ authoringReceiptId, snapshots: items.map(({ receiptId, finishedAt, value, status }) => ({ receiptId, finishedAt, value, status })), latestReceiptId: field(detail.body, "script", "latestSnapshot", "receiptId") }))
    assert.deepEqual(items.map((item) => ({ receiptId: item.receiptId, marker: field(item, "value", "marker") })), expected)
    assert.equal(field(detail.body, "script", "currentVersion", "exampleInput", "marker"), "authoring-example")
    const latest = expected[0]
    if (!latest) {
      assert.equal(field(detail.body, "script", "latestSnapshot"), null)
      return
    }
    assert.equal(field(detail.body, "script", "latestSnapshot", "receiptId"), latest.receiptId)
    assert.equal(field(detail.body, "script", "latestSnapshot", "value", "marker"), latest.marker)
    assert.equal(field(detail.body, "script", "latestSuccessfulSnapshot", "receiptId"), latest.receiptId)
    for (let index = 1; index < items.length; index++) {
      assert.ok(text(items[index - 1]?.finishedAt, "newer finish") >= text(items[index]?.finishedAt, "older finish"))
    }
  }

  // Saving doesn't turn an authoring test into saved-version run history.
  await inspect([])
  const authoringSnapshot = await api("GET", `/v1/workflows/${workflowId}/snapshots/${authoringReceiptId}`)
  assert.equal(authoringSnapshot.status, 404, summary(authoringSnapshot))

  const cold = await api("POST", `/v1/workflows/${workflowId}/run`, {
    pluginId, configObjectVersionId: versionId, input: { marker: "different-rerun" },
  })
  assert.equal(cold.status, 200, summary(cold))
  const differentRun = { receiptId: text(field(cold.body, "receiptId"), "different rerun receipt"), marker: "different-rerun" }
  await inspect([differentRun])

  // Re-running the example AFTER the different input correctly makes the
  // example the latest result. It isn't evidence of stale detail selection.
  const example = await api("POST", `/v1/workflows/${workflowId}/run`, {
    pluginId, configObjectVersionId: versionId, input: { marker: "authoring-example" },
  })
  assert.equal(example.status, 200, summary(example))
  const exampleRun = { receiptId: text(field(example.body, "receiptId"), "saved example receipt"), marker: "authoring-example" }
  await inspect([exampleRun, differentRun])

  // MCP execution of that same saved version must also replace the latest
  // result, independently of the unchanged version's exampleInput.
  const mcp = await den.callMcpTool(token, "execute_capability", {
    name: `plugin:${pluginId}:${workflowId}`, body: { marker: "mcp-latest" },
  })
  assert.equal(mcp.isError, false, mcp.raw.slice(0, 400))
  assert.equal(field(mcp.body, "value", "marker"), "mcp-latest")
  const mcpRun = { receiptId: text(field(mcp.body, "receiptId"), "MCP receipt"), marker: "mcp-latest" }
  await inspect([mcpRun, exampleRun, differentRun])
})
