import assert from "node:assert/strict"
import { test } from "node:test"
import { evaluateToolPermission, matchesToolPermissionName } from "../src/tool-permissions/evaluate.js"

test("block beats ask, ask beats allow, and no rule uses the provider's read-only status", () => {
  assert.equal(evaluateToolPermission(["allow", "ask", "block"], true), "block")
  assert.equal(evaluateToolPermission(["ask", "allow", null], true), "ask")
  assert.equal(evaluateToolPermission([null, "allow"], false), "allow")
  assert.equal(evaluateToolPermission([null], true), "allow")
  assert.equal(evaluateToolPermission([], false), "ask")
})

test("tool names compare exactly except for the whole-connection wildcard", () => {
  assert.equal(matchesToolPermissionName("List", "List"), true)
  assert.equal(matchesToolPermissionName("List", "list"), false)
  assert.equal(matchesToolPermissionName("List", "List "), false)
  assert.equal(matchesToolPermissionName("*", "list"), true)
})
