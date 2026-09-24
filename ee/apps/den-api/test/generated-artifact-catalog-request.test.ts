import { expect, test } from "bun:test"
import { needsGeneratedArtifactCatalog } from "../src/mcp/generated-artifact-catalog-request.js"

test("only listings and generated render/run/preview aliases need the catalog", () => {
  expect(needsGeneratedArtifactCatalog("tools/list", {})).toBe(true)
  expect(needsGeneratedArtifactCatalog("resources/list", {})).toBe(true)
  for (const method of [null, "server/discover", "initialize", "ping", "notifications/initialized", "resources/templates/list", "resources/read"]) {
    expect(needsGeneratedArtifactCatalog(method, { uri: "ui://openwork/artifact" })).toBe(false)
  }
  for (const name of ["search_capabilities", "execute_capability_script", "read_artifact_view", "save_artifact_view", "activate_artifact_view_revision", "retire_artifact_view", "render_workflow_artifact", "render_dynamic_artifact"]) {
    expect(needsGeneratedArtifactCatalog("tools/call", { name })).toBe(false)
    expect(needsGeneratedArtifactCatalog("tools/call", { name: "execute_capability", arguments: { name } })).toBe(false)
  }
  for (const prefix of ["render", "run", "preview"]) {
    const name = `${prefix}_artifact_arv_${"0".repeat(26)}`
    expect(needsGeneratedArtifactCatalog("tools/call", { name })).toBe(true)
    expect(needsGeneratedArtifactCatalog("tools/call", { name: "execute_capability", arguments: { name } })).toBe(true)
  }
  for (const params of [null, [], {}, { name: 42 }, { name: "execute_capability", arguments: null }, { name: "execute_capability", arguments: { name: "mcp:connection:read" } }]) {
    expect(needsGeneratedArtifactCatalog("tools/call", params)).toBe(false)
  }
})
