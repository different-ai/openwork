import assert from "node:assert/strict"
import { test } from "node:test"
import { supportsConnectMcpAppHost, supportsConnectNativeSkills } from "../src/mcp/connect-mcp-server-index.js"

test("client capabilities are read from one comma-separated header, each on its own", () => {
  assert.equal(supportsConnectNativeSkills("native-skills-v1"), true)
  assert.equal(supportsConnectNativeSkills(" mcp-app-host-v1 , native-skills-v1 "), true)
  assert.equal(supportsConnectNativeSkills("mcp-app-host-v1"), false)
  assert.equal(supportsConnectNativeSkills("native-skills-v10"), false)
  assert.equal(supportsConnectNativeSkills(undefined), false)
  assert.equal(supportsConnectMcpAppHost("native-skills-v1,mcp-app-host-v1"), true)
  assert.equal(supportsConnectMcpAppHost("native-skills-v1"), false)
})
