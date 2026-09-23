import { test } from "node:test"
import assert from "node:assert/strict"
import { renderToStaticMarkup } from "react-dom/server"
import { App } from "@modelcontextprotocol/ext-apps"
import {
  workflowRunnerCatalogSchema,
  workflowRunnerErrorSchema,
  workflowRunnerOpenOutputSchema,
  workflowRunnerResultSchema,
} from "@openwork/types/workflow-runner-app"
import { WorkflowView } from "../src/workflow-view"
import { WorkflowResultView, WorkflowValue } from "../src/workflow-result"
import {
  initialWorkflowState, isPreviousResult, runWorkflow, searchWorkflows, selectedWorkflow,
  workflowBlock, workflowKey, workflowReducer,
} from "../src/workflow-state"
import { parseToolResult, toolResultHandlers } from "../src/shared/result"

const catalog = workflowRunnerCatalogSchema.parse({
  schemaVersion: "1", kind: "workflow_catalog", hasMore: false,
  workflows: [{
    pluginId: "plg_fixture", configObjectId: "cob_fixture", configObjectVersionId: "cov_pinned",
    title: "Daily totals", description: "Read the current totals.", blockedReason: null,
  }],
})
const workflow = catalog.workflows[0]!
const result = workflowRunnerResultSchema.parse({
  schemaVersion: "1", kind: "workflow_result", workflow, value: [{ Name: "Items", Total: 12 }],
  receiptId: "receipt_fixture", resultDigest: "digest_fixture", outputSchemaDigest: null,
})
const failure = workflowRunnerErrorSchema.parse({
  schemaVersion: "1", kind: "workflow_error", error: "blocked", message: "Your team has blocked this workflow.",
})
const receivedAt = "2026-09-23T10:00:00.000Z"

function testApp(serverTools = true) {
  const app = new App({ name: "test", version: "1" }, {}, { autoResize: false })
  app.getHostCapabilities = () => serverTools ? { serverTools: {} } : {}
  return app
}

function completedState() {
  const selected = workflowReducer(initialWorkflowState(catalog), { type: "select", workflow })
  return workflowReducer(selected, { type: "result", payload: result, receivedAt })
}

test("launch catalogs and structured launch errors render without running or retrying", () => {
  const app = testApp()
  let calls = 0
  app.callServerTool = async () => { calls++; return { content: [], structuredContent: catalog } }
  let html = ""
  const handlers = toolResultHandlers(workflowRunnerOpenOutputSchema,
    payload => { html = renderToStaticMarkup(<WorkflowView payload={payload} app={app} hostContext={undefined} />) },
    message => { html = message }, payload => payload.kind === "workflow_error",
  )
  for (let mount = 0; mount < 2; mount++) {
    handlers.ontoolresult({ structuredContent: catalog })
    assert.match(html, /<h1>Workflows<\/h1>/)
    assert.match(html, /Daily totals/)
    assert.match(html, /disabled=""[^>]*>Run workflow/)
  }
  handlers.ontoolresult({ isError: true, structuredContent: failure })
  assert.match(html, /Your team has blocked/)
  assert.match(html, /Search again/)
  assert.match(html, /role="alert"/)
  assert.equal(calls, 0)
})

test("catalog queries call only the standard same-server tool and parse direct results", async () => {
  const requests: unknown[] = []
  const app: Pick<App, "callServerTool"> = { callServerTool: async request => {
    requests.push(request)
    return { content: [], structuredContent: catalog }
  } }
  assert.deepEqual(await searchWorkflows(app, " totals "), catalog)
  await searchWorkflows(app, "  ")
  assert.deepEqual(requests, [
    { name: "open_workflows", arguments: { query: "totals" } },
    { name: "open_workflows", arguments: {} },
  ])
  await assert.rejects(searchWorkflows(app, "q".repeat(201)))
  assert.equal(requests.length, 2)
})

test("an explicit run sends the exact selected identity and timezone, consuming the direct result", async () => {
  const requests: unknown[] = []
  const app: Pick<App, "callServerTool"> = { callServerTool: async request => {
    requests.push(request)
    return { content: [], structuredContent: result }
  } }
  assert.deepEqual(await runWorkflow(app, workflow, "Europe/Paris"), result)
  await runWorkflow(app, workflow)
  const ids = { pluginId: "plg_fixture", configObjectId: "cob_fixture", configObjectVersionId: "cov_pinned" }
  assert.deepEqual(requests, [
    { name: "run_workflow_readonly", arguments: { ...ids, timeZone: "Europe/Paris" } },
    { name: "run_workflow_readonly", arguments: ids },
  ])
})

test("run responses must match all three selected identifiers and the output schema", async () => {
  for (const identity of [
    { pluginId: "plg_other" }, { configObjectId: "cob_other" }, { configObjectVersionId: "cov_latest" },
  ]) {
    const app: Pick<App, "callServerTool"> = { callServerTool: async () => ({
      content: [], structuredContent: { ...result, workflow: { ...workflow, ...identity } },
    }) }
    await assert.rejects(runWorkflow(app, workflow), /does not match/)
  }
  for (const invalid of [{}, { ...result, schemaVersion: "2" }, { ...result, receiptId: 123 }]) {
    await assert.rejects(runWorkflow({ callServerTool: async () => ({ content: [], structuredContent: invalid }) }, workflow))
  }
})

test("structured errors survive isError while mismatched success/error envelopes are rejected", async () => {
  const app: Pick<App, "callServerTool"> = { callServerTool: async () => ({ content: [], structuredContent: failure, isError: true }) }
  assert.deepEqual(await runWorkflow(app, workflow), failure)
  assert.deepEqual(await searchWorkflows(app, ""), failure)
  await assert.rejects(runWorkflow({ callServerTool: async () => ({ content: [], structuredContent: result, isError: true }) }, workflow))
  assert.throws(() => parseToolResult(workflowRunnerOpenOutputSchema, { structuredContent: catalog, isError: true }, payload => payload.kind === "workflow_error"))
  const text = await runWorkflow({ callServerTool: async () => ({ content: [{ type: "text", text: JSON.stringify(result) }] }) }, workflow)
  assert.deepEqual(text, result)
})

test("catalog refreshes retain the pinned version rather than silently switching to latest", () => {
  const state = completedState()
  const newer = { ...workflow, configObjectVersionId: "cov_newer" }
  const refreshed = workflowReducer(state, { type: "catalog", payload: { ...catalog, workflows: [newer] } })
  assert.equal(refreshed.selected?.configObjectVersionId, "cov_pinned")
  assert.equal(selectedWorkflow(refreshed), undefined)
  assert.match(workflowBlock(refreshed, true) ?? "", /selected version is not in these results/)
  assert.equal(refreshed.result, result)
  assert.equal(isPreviousResult(refreshed), true)
  const changed = workflowReducer(refreshed, { type: "select", workflow: newer })
  assert.equal(selectedWorkflow(changed), newer)
  assert.equal(isPreviousResult(changed), true)
  assert.notEqual(workflowKey(newer), workflowKey(workflow))
})

test("pending runs and failures keep the last result, mark it previous, and never retry", () => {
  let state = completedState()
  assert.equal(isPreviousResult(state), false)
  for (const operation of ["search", "run"] satisfies ("search" | "run")[]) {
    state = workflowReducer(state, { type: "start", operation })
    assert.equal(state.busy, operation)
    assert.equal(state.result, result)
    assert.equal(state.receivedAt, receivedAt)
    assert.equal(isPreviousResult(state), true)
    state = workflowReducer(state, { type: "error", error: failure, operation })
    assert.equal(state.busy, null)
    assert.equal(state.result, result)
    assert.equal(isPreviousResult(state), true)
  }
  assert.match(state.recovery, /receipt may have been saved/)
  state = workflowReducer(state, { type: "result", payload: { ...result, value: 15 }, receivedAt })
  assert.equal(state.result?.value, 15)
  assert.equal(state.error, null)
  assert.equal(isPreviousResult(state), false)
})

test("host capability and backend restrictions remain visible and give a next action", () => {
  const blocked = { ...catalog, workflows: [{ ...workflow, blockedReason: "Provider writes are not allowed." }] }
  const html = renderToStaticMarkup(<WorkflowView payload={blocked} app={testApp(false)} hostContext={undefined} />)
  assert.match(html, /Daily totals — Blocked/)
  assert.match(html, /This host cannot run workflows/)
  assert.match(html, /host that supports server tools/)
  assert.match(html, /disabled=""[^>]*>Run workflow/)
  let state = workflowReducer(initialWorkflowState(blocked), { type: "select", workflow })
  assert.match(workflowBlock(state, true) ?? "", /Provider writes are not allowed/)
  assert.match(workflowBlock(state, true) ?? "", /workflow owner/)
  state = workflowReducer(state, { type: "catalog", payload: { ...blocked, workflows: [{ ...workflow, blockedReason: "" }] } })
  assert.match(workflowBlock(state, true) ?? "", /workflow is blocked/)
  assert.equal(workflowBlock(completedState(), true), null)
})

test("empty and bounded catalog states invite a search or access request", () => {
  const app = testApp()
  const empty = renderToStaticMarkup(<WorkflowView payload={{ ...catalog, workflows: [] }} app={app} hostContext={undefined} />)
  assert.match(empty, /No workflows found/)
  assert.match(empty, /Change your search or ask a workflow owner/)
  const more = renderToStaticMarkup(<WorkflowView payload={{ ...catalog, hasMore: true }} app={app} hostContext={undefined} />)
  assert.match(more, /Narrow your search/)
  assert.doesNotMatch(more, />[^<]*(cov_pinned|plg_fixture)/)
})

test("result tables and technical disclosures escape untrusted content, name stale results, and retain receipts", () => {
  const unsafe = '<img src=x onerror="alert(1)">'
  const html = renderToStaticMarkup(<WorkflowResultView result={{ ...result, workflow: { ...workflow, title: unsafe }, value: [{ [unsafe]: "<script>alert(1)</script>" }] }} previous receivedAt={receivedAt} />)
  assert.match(html, /Previous result: &lt;img/)
  assert.match(html, /Not updated for the current selection or attempt/)
  assert.match(html, /<table>/)
  assert.match(html, /&lt;script&gt;/)
  assert.match(html, /<details><summary>Technical details<\/summary><pre>/)
  assert.match(html, /receipt_fixture/)
  assert.match(html, /cov_pinned/)
  assert.doesNotMatch(html, /<script|<img|<details open/)
})

test("result previews are bounded and preserve simple scalar values", () => {
  const rows = Array.from({ length: 20 }, (_, index) => ({ row: index, a: "a", b: "b", c: "c", d: "d" }))
  const table = renderToStaticMarkup(<WorkflowValue value={rows} />)
  assert.match(table, /Showing 5 of 20 rows and 4 of 5 fields/)
  assert.equal((table.match(/<td>/g) ?? []).length, 20)
  for (const value of [0, false, "totals"]) {
    assert.match(renderToStaticMarkup(<WorkflowValue value={value} />), new RegExp(String(value)))
  }
  assert.match(renderToStaticMarkup(<WorkflowValue value={[]} />), /No rows returned/)
  assert.match(renderToStaticMarkup(<WorkflowValue value={null} />), /Check the workflow/)
  assert.match(renderToStaticMarkup(<WorkflowValue value={{ count: 2, nested: { count: 3 } }} />), /Structured value/)
  assert.ok(renderToStaticMarkup(<WorkflowValue value={"x".repeat(1000)} />).length < 220)
})
