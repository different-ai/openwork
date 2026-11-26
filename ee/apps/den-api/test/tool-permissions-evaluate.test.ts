import assert from "node:assert/strict"
import { test } from "node:test"
import { evaluateToolPermission, matchesToolPermissionName } from "../src/tool-permissions/evaluate.js"

test("ordinary tools are allowed unless an explicit rule restricts them", () => {
  assert.equal(evaluateToolPermission([], { kind: "ordinary" }), "allow")
  assert.equal(evaluateToolPermission([null], { kind: "ordinary" }), "allow")
  assert.equal(evaluateToolPermission(["allow", "ask"], { kind: "ordinary" }), "ask")
  assert.equal(evaluateToolPermission(["allow", "ask", "block"], { kind: "ordinary" }), "block")
})

test("agent tools allow reads and ask for writes when no rule applies", () => {
  assert.equal(evaluateToolPermission([null], { kind: "agent", readOnly: true }), "allow")
  assert.equal(evaluateToolPermission([], { kind: "agent", readOnly: false }), "ask")
  assert.equal(evaluateToolPermission([null, "allow"], { kind: "agent", readOnly: false }), "allow")
  assert.equal(evaluateToolPermission(["ask", "allow", null], { kind: "agent", readOnly: true }), "ask")
  assert.equal(evaluateToolPermission(["allow", "ask", "block"], { kind: "agent", readOnly: true }), "block")
})

test("tool names compare exactly except for the whole-connection wildcard", () => {
  assert.equal(matchesToolPermissionName("List", "List"), true)
  assert.equal(matchesToolPermissionName("List", "list"), false)
  assert.equal(matchesToolPermissionName("List", "List "), false)
  assert.equal(matchesToolPermissionName("*", "list"), true)
})
