import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  SESSION_GROUP_ID_MAX_LENGTH,
  SESSION_GROUP_LABEL_MAX_LENGTH,
  SESSION_GROUP_SESSION_ID_MAX_LENGTH,
  applySessionGroupCommand,
  normalizeSessionGroupState,
  type SessionGroupState,
} from "../src/index.js"

const initial: SessionGroupState = {
  groups: [
    { id: "grp_a", label: "Alpha" },
    { id: "grp_b", label: "Beta" },
    { id: "grp_c", label: "Gamma" },
  ],
  assignments: { ses_a: "grp_a", ses_b: "grp_b" },
}

describe("normalizeSessionGroupState", () => {
  it("normalizes, bounds, deduplicates, and drops dangling assignments", () => {
    const value = normalizeSessionGroupState({
      groups: [
        { id: `  ${"g".repeat(SESSION_GROUP_ID_MAX_LENGTH + 10)}  `, label: `  ${"L".repeat(SESSION_GROUP_LABEL_MAX_LENGTH + 10)}  ` },
        { id: "grp_ok", label: "  Keep me  " },
        { id: "grp_ok", label: "Duplicate" },
        { id: "", label: "Missing ID" },
        null,
      ],
      assignments: {
        [`${"s".repeat(SESSION_GROUP_SESSION_ID_MAX_LENGTH + 10)}`]: "grp_ok",
        ses_ok: "grp_ok",
        ses_missing: "grp_missing",
      },
    })

    assert.equal(value.groups.length, 2)
    assert.equal(value.groups[0]?.id.length, SESSION_GROUP_ID_MAX_LENGTH)
    assert.equal(value.groups[0]?.label.length, SESSION_GROUP_LABEL_MAX_LENGTH)
    assert.equal(value.groups[1]?.label, "Keep me")
    assert.deepEqual(value.assignments, {
      ["s".repeat(SESSION_GROUP_SESSION_ID_MAX_LENGTH)]: "grp_ok",
      ses_ok: "grp_ok",
    })
  })

  it("returns an independent empty value for invalid input", () => {
    const left = normalizeSessionGroupState(null)
    const right = normalizeSessionGroupState(null)
    assert.notEqual(left, right)
    assert.deepEqual(left, { groups: [], assignments: {} })
  })
})

describe("applySessionGroupCommand", () => {
  it("creates a normalized group without mutating the input", () => {
    const before = structuredClone(initial)
    const result = applySessionGroupCommand(initial, {
      type: "create",
      id: "  grp_d  ",
      label: "  Delta  ",
    })
    assert.deepEqual(initial, before)
    assert.equal(result.changed, true)
    assert.deepEqual(result.change, { action: "created", groupId: "grp_d" })
    assert.equal(result.state.groups.at(-1)?.label, "Delta")
  })

  it("does not create a duplicate group", () => {
    const result = applySessionGroupCommand(initial, {
      type: "create",
      id: "grp_a",
      label: "Duplicate",
    })
    assert.equal(result.changed, false)
    assert.deepEqual(result.state, initial)
  })

  it("renames only the requested group", () => {
    const result = applySessionGroupCommand(initial, {
      type: "rename",
      groupId: "grp_b",
      label: "  Focus  ",
    })
    assert.equal(result.changed, true)
    assert.equal(result.state.groups[1]?.label, "Focus")
    assert.equal(initial.groups[1]?.label, "Beta")
  })

  it("removes a group and its assignments", () => {
    const result = applySessionGroupCommand(initial, { type: "remove", groupId: "grp_a" })
    assert.deepEqual(result.state.groups.map((group) => group.id), ["grp_b", "grp_c"])
    assert.deepEqual(result.state.assignments, { ses_b: "grp_b" })
  })

  it("supports partial reorder and ignores duplicates or unknown IDs", () => {
    const result = applySessionGroupCommand(initial, {
      type: "reorder",
      groupIds: ["grp_c", "grp_c", "missing", "grp_a"],
    })
    assert.deepEqual(result.state.groups.map((group) => group.id), ["grp_c", "grp_a", "grp_b"])
  })

  it("assigns only existing groups and unassigns invalid or null groups", () => {
    const assigned = applySessionGroupCommand(initial, {
      type: "assign",
      sessionId: "ses_c",
      groupId: "grp_c",
    })
    assert.equal(assigned.state.assignments.ses_c, "grp_c")

    const missing = applySessionGroupCommand(assigned.state, {
      type: "assign",
      sessionId: "ses_c",
      groupId: "missing",
    })
    assert.equal(missing.state.assignments.ses_c, undefined)

    const cleared = applySessionGroupCommand(initial, {
      type: "assign",
      sessionId: "ses_a",
      groupId: null,
    })
    assert.equal(cleared.state.assignments.ses_a, undefined)
  })

  it("normalizes imported state", () => {
    const result = applySessionGroupCommand(initial, {
      type: "replace",
      state: { groups: [{ id: " grp_x ", label: " X " }], assignments: { ses_x: "grp_x" } },
    })
    assert.deepEqual(result.state, {
      groups: [{ id: "grp_x", label: "X" }],
      assignments: { ses_x: "grp_x" },
    })
    assert.deepEqual(result.change, { action: "imported" })
  })
})
