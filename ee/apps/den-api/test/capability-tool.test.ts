import assert from "node:assert/strict"
import { test } from "node:test"
import { capabilityCallInput, capabilityToolMatch, splitCapabilityArguments } from "../src/mcp/capability-tool.js"
import type { CapabilityMatch } from "../src/mcp/search.js"

const apiMatch: CapabilityMatch = {
  name: "getOrgWorkers",
  method: "GET",
  path: "/v1/orgs/{orgId}/workers",
  score: 12,
  summary: "List the organization's workers.",
  pathParams: ["orgId"],
  queryParams: ["limit"],
  hasBody: false,
  querySchema: { type: "object", properties: { limit: { type: "integer" } } },
  scriptPath: "den.getOrgWorkers",
}

const externalMatch: CapabilityMatch = {
  name: "mcp:emc_linear:list_issues",
  method: "MCP",
  path: "https://mcp.example.test/sse?api_key=secret",
  score: 9,
  summary: "[Linear] List issues in the workspace.",
  pathParams: [],
  queryParams: [],
  hasBody: true,
  argumentsSchema: { type: "object", properties: { assignee: { type: "string" } } },
  schemaDigest: `sha256:${"0".repeat(64)}`,
  invocation: { argumentsField: "body" },
  readOnly: true,
  annotations: { readOnlyHint: true, openWorldHint: true },
}

test("an API operation match becomes an MCP tool whose arguments hold path, query, and body", () => {
  const tool = capabilityToolMatch(apiMatch, true)
  assert.deepEqual(tool, {
    ...apiMatch,
    name: "getOrgWorkers",
    description: "List the organization's workers.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "object", properties: { orgId: { type: "string" } }, required: ["orgId"] },
        query: { type: "object", properties: { limit: { type: "integer" } } },
      },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    scriptPath: "den.getOrgWorkers",
  })
})

test("a connection tool keeps its provider schema and annotations, and the older fields for released desktops", () => {
  const tool = capabilityToolMatch(externalMatch, false)
  assert.deepEqual(tool.inputSchema, externalMatch.argumentsSchema)
  assert.deepEqual(tool.annotations, { readOnlyHint: true, openWorldHint: true })
  assert.equal(tool.description, "[Linear] List issues in the workspace.")
  assert.equal(tool.schemaDigest, externalMatch.schemaDigest)
  assert.equal("path" in tool, false, "a connection's server URL can carry credentials")
  for (const field of ["method", "summary", "argumentsSchema", "invocation", "readOnly", "hasBody", "pathParams", "queryParams"] as const) {
    assert.deepEqual(tool[field], externalMatch[field], field)
  }
  assert.deepEqual(capabilityToolMatch({ ...externalMatch, argumentsSchema: undefined, hasBody: false }, false).inputSchema,
    { type: "object", additionalProperties: false })
})

test("arguments split into path, query, and body only for API operations", () => {
  assert.deepEqual(splitCapabilityArguments({ path: { orgId: "o" }, body: { a: 1 } }, true), { ok: true, path: { orgId: "o" }, query: undefined, body: { a: 1 } })
  assert.deepEqual(splitCapabilityArguments({ assignee: "me" }, false), { ok: true, body: { assignee: "me" } })
  const misplaced = splitCapabilityArguments({ orgId: "o" }, true)
  assert.equal(misplaced.ok, false)
  assert.deepEqual(!misplaced.ok && misplaced.issues.map((issue) => issue.path), ["/orgId"])
})

test("arguments replace the older inputs, and misplaced ones become a correctable error", () => {
  assert.deepEqual(capabilityCallInput({ name: "getOrgWorkers", arguments: { path: { orgId: "o" } }, body: { ignored: true } }, true),
    { ok: true, input: { name: "getOrgWorkers", arguments: { path: { orgId: "o" } }, path: { orgId: "o" }, query: undefined, body: undefined } })
  const legacy = { name: "mcp:emc_linear:list_issues", body: { assignee: "legacy" } }
  assert.deepEqual(capabilityCallInput(legacy, false), { ok: true, input: legacy })
  const invalid = capabilityCallInput({ name: "getOrgWorkers", arguments: { orgId: "o" } }, true)
  assert.equal(invalid.ok, false)
  assert.deepEqual(!invalid.ok && invalid.error, {
    error: "invalid_capability_arguments",
    capability: "getOrgWorkers",
    message: "arguments do not match this capability's inputSchema.",
    issues: [{ path: "/orgId", keyword: "additionalProperties", message: "Put orgId under path, query, or body as described by inputSchema." }],
    retry: { action: "correct_arguments", searchRequired: false },
  })
})
