import assert from "node:assert/strict"
import { test } from "node:test"
import { loadProviderCatalogFromFile } from "../src/provider-catalog.js"
import { isAllowedRequestHeader } from "../src/protocols.js"

const catalog = loadProviderCatalogFromFile()

test("OpenCode Zen and Go entries forward the session headers OpenCode sends its own providers", () => {
  for (const id of ["opencode", "opencode-go"]) {
    const entry = catalog.getCatalogProvider(id)
    assert.ok(entry, id)
    for (const name of ["x-opencode-session", "X-OpenCode-Request", "x-opencode-project", "x-opencode-client"]) {
      assert.equal(isAllowedRequestHeader("openai_compatible", name, entry.requestHeaders), true, `${id} ${name}`)
    }
    assert.equal(isAllowedRequestHeader("openai_compatible", "x-opencode-parent-session-id", entry.requestHeaders), false, id)
  }
})

test("providers without their own entry never receive OpenCode's session headers", () => {
  for (const id of ["openrouter", "openai", "anthropic"]) {
    const entry = catalog.getCatalogProvider(id)
    assert.ok(entry, id)
    assert.equal(entry.requestHeaders, undefined, id)
    assert.equal(isAllowedRequestHeader("openai_compatible", "x-opencode-session", entry.requestHeaders), false, id)
  }
  assert.equal(isAllowedRequestHeader("openai_compatible", "openai-beta"), true)
})
