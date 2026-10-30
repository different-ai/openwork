import assert from "node:assert/strict"
import test from "node:test"
import type { McpAppToolBinding } from "@openwork/types/mcp-app"
import { appStarterPattern } from "../src/mcp/app-authoring-starter.js"

import { bindingAccess, runsWithoutClick } from "../src/mcp/app-tool-access.js"

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
