import assert from "node:assert/strict"
import test from "node:test"
import type { McpAppToolBinding } from "@openwork/types/mcp-app"
import { appStarterPattern } from "../src/mcp/app-authoring-starter.js"

import { bindingAccess, runsWithoutClick, stillRunsWithoutClick, workflowBindingAccess } from "../src/mcp/app-tool-access.js"

const binding = (overrides: Partial<McpAppToolBinding>): McpAppToolBinding => ({
  name: "load_mrr",
  description: "Reads live revenue.",
  capability: "plugin:plg_1:cob_1",
  kind: "workflow",
  mode: "live",
  inputSchema: { type: "object" },
  readOnly: false,
  ...overrides,
})

test("a tool that only reaches reads, including provider-marked connection reads, is read-only", () => {
  assert.deepEqual(bindingAccess(["read", "read"], undefined), { readOnly: true })
  assert.deepEqual(bindingAccess(["read", "unlabeled"], undefined), { readOnly: false })
})

test("an author may load an unlabeled read on open, never a tool that writes", () => {
  assert.deepEqual(bindingAccess(["read", "unlabeled"], true), { readOnly: false, loadOnOpen: true })
  assert.ok("refused" in bindingAccess(["unlabeled", "writes"], true))
  assert.deepEqual(bindingAccess(["writes"], false), { readOnly: false })
})

test("a tool chosen to load on open runs without a click like a read-only one", () => {
  assert.equal(runsWithoutClick(binding({})), false)
  assert.equal(runsWithoutClick(binding({ loadOnOpen: true })), true)
  assert.equal(runsWithoutClick(binding({ readOnly: true })), true)
})

test("a tool chosen to load on open gets the lookup starter that loads it on open", () => {
  assert.equal(appStarterPattern([binding({})]), "action")
  assert.equal(appStarterPattern([binding({ loadOnOpen: true })]), "lookup")
})

test("a Workflow reading through a tool marked destructive loads on open for everyone", () => {
  const access = workflowBindingAccess("live", ["read", "destructive"], true)
  assert.deepEqual(access, { readOnly: false, loadOnOpen: true })
  const bound = binding(access as Partial<McpAppToolBinding>)
  assert.equal(runsWithoutClick(bound), true)
  assert.equal(appStarterPattern([bound]), "lookup")
})

test("a Workflow reaching a tool marked destructive still asks unless its author loads it on open", () => {
  assert.deepEqual(workflowBindingAccess("live", ["destructive"], undefined), { readOnly: false })
})

test("a connection tool bound directly and marked destructive never loads on open", () => {
  assert.ok("refused" in bindingAccess(["destructive"], true))
  assert.deepEqual(bindingAccess(["destructive"], false), { readOnly: false })
})

test("a Workflow is judged by what it reaches in either mode, and only a live one is read-only", () => {
  assert.deepEqual(workflowBindingAccess("input", ["read"], true), { readOnly: false, loadOnOpen: true })
  assert.deepEqual(workflowBindingAccess("live", ["read"], true), { readOnly: true, loadOnOpen: true })
  assert.deepEqual(workflowBindingAccess("input", [], undefined), { readOnly: false })
  assert.ok("refused" in workflowBindingAccess("input", ["read", "writes"], true))
})

test("a known write stays refused even beside a tool marked destructive", () => {
  assert.ok("refused" in workflowBindingAccess("live", ["destructive", "writes"], true))
})

test("a connection OpenWork could not check is not reported as changing data", () => {
  const access = workflowBindingAccess("live", ["unknown"], true)
  assert.ok("refused" in access)
  assert.doesNotMatch(access.refused, /changes data/)
  assert.deepEqual(workflowBindingAccess("live", ["unknown"], false), { readOnly: false })
})

test("each call blocks a no-click Workflow that now reaches more than it was bound to", () => {
  const readOnly = binding({ readOnly: true })
  assert.equal(stillRunsWithoutClick(readOnly, ["read"]), true)
  assert.equal(stillRunsWithoutClick(readOnly, ["unlabeled"]), false)
  assert.equal(stillRunsWithoutClick(readOnly, ["destructive"]), false)

  const loadsOnOpen = binding({ loadOnOpen: true })
  assert.equal(stillRunsWithoutClick(loadsOnOpen, ["read", "unlabeled"]), true)
  assert.equal(stillRunsWithoutClick(loadsOnOpen, ["destructive"]), true)
  assert.equal(stillRunsWithoutClick(loadsOnOpen, ["destructive", "writes"]), false)
})
