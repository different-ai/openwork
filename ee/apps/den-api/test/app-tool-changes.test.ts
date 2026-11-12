import assert from "node:assert/strict"
import test from "node:test"

import { appToolChangeMessage } from "../src/mcp/app-tool-access.js"

const tool = { name: "load_issues", readOnly: false }

test("a tool whose inputs changed at its provider needs the App updated, whatever it does", () => {
  assert.match(appToolChangeMessage(tool, "provider_schema_changed") ?? "", /^load_issues now takes different inputs/)
  assert.match(appToolChangeMessage({ ...tool, readOnly: true }, "provider_schema_changed") ?? "", /An editor of this artifact needs to update its tools/)
})

test("a provider's new label needs the App updated only where the App relied on the old one", () => {
  assert.equal(appToolChangeMessage(tool, "provider_destructive"), null)
  assert.match(appToolChangeMessage({ ...tool, loadOnOpen: true }, "provider_destructive") ?? "", /now marked destructive/)
  assert.equal(appToolChangeMessage(tool, "provider_not_read_only"), null)
  assert.match(appToolChangeMessage({ ...tool, readOnly: true }, "provider_not_read_only") ?? "", /no longer marked read-only/)
})

test("any other refusal is not something updating the App fixes", () => {
  assert.equal(appToolChangeMessage({ ...tool, readOnly: true, loadOnOpen: true }, undefined), null)
  assert.equal(appToolChangeMessage({ ...tool, readOnly: true, loadOnOpen: true }, "insufficient_mcp_scope"), null)
})
