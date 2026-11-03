import assert from "node:assert/strict"
import { test } from "node:test"
import { officeDraftHasUnsavedEdits } from "../src/office-server"

test("only edits after the last confirmed save, or an unconfirmed save, keep a session from being replaced", () => {
  assert.equal(officeDraftHasUnsavedEdits({ draftVersion: 0 }), false, "opened, never edited")
  assert.equal(officeDraftHasUnsavedEdits({ draftVersion: 3 }), true, "edited, never saved")
  assert.equal(officeDraftHasUnsavedEdits({ draftVersion: 3, savedDraftVersion: 3 }), false, "everything saved")
  assert.equal(officeDraftHasUnsavedEdits({ draftVersion: 4, savedDraftVersion: 3 }), true, "edited after the save")
  assert.equal(officeDraftHasUnsavedEdits({ draftVersion: 3, savedDraftVersion: 3, uncertain: true }), true, "save outcome unknown")
})
