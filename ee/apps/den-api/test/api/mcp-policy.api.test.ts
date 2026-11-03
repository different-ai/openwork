import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen } from "./harness.js"
import { isMcpOperationAllowed, type OpenApiOperation } from "../../src/mcp/policy.ts"

type OpenApiDocument = { paths: Record<string, Record<string, OpenApiOperation>> }

const den = await bootDen()
after(() => den.close())
// Schema-only requests do not await Better Auth's resource-registry startup.
await import("../../src/auth.js").then(({ auth }) => auth.$context)
const response = await den.request(null, "GET", "/openapi.json?public=1")
assert.equal(response.status, 200)
const document: OpenApiDocument = JSON.parse(response.text)

test("the public contract does not alter Den's raw cached specification", async () => {
  const raw = await den.request(null, "GET", "/openapi.json")
  assert.equal(raw.status, 200)
  const full: OpenApiDocument = JSON.parse(raw.text)
  const internal = (input: OpenApiDocument) => Object.values(input.paths).flatMap(Object.values).filter((operation) => operation.tags?.includes("Internal"))
  assert.ok(internal(full).length > 0)
  assert.equal(internal(document).length, 0)
  const repeated = await den.request(null, "GET", "/openapi.json?public=1")
  assert.deepEqual(JSON.parse(repeated.text), document)
})

function mcpAllowed(document: OpenApiDocument, method: string, path: string) {
  const operation = document.paths[path]?.[method]
  assert.ok(operation, `${method.toUpperCase()} ${path} is in the OpenAPI snapshot`)
  return isMcpOperationAllowed({ method, path, operation })
}

test("MCP agents can plan, prepare and follow managed deployments but never remove them or act as the installer", () => {
  assert.equal(mcpAllowed(document, "get", "/v1/managed-deployments/configuration"), true)
  assert.equal(mcpAllowed(document, "get", "/v1/managed-deployments"), true)
  assert.equal(mcpAllowed(document, "post", "/v1/managed-deployments"), true)
  assert.equal(mcpAllowed(document, "post", "/v1/managed-deployments/{deploymentId}/launch"), true)

  assert.equal(mcpAllowed(document, "delete", "/v1/managed-deployments/{deploymentId}"), false)
  assert.equal(mcpAllowed(document, "post", "/v1/managed-deployments/{deploymentId}/runs/{runId}/enroll"), false)
  assert.equal(mcpAllowed(document, "post", "/v1/managed-deployments/{deploymentId}/runs/{runId}/events"), false)
  assert.equal(mcpAllowed(document, "post", "/v1/managed-deployments/{deploymentId}/heartbeat"), false)
})

test("MCP agents can read permission sets but never create, change or delete them", () => {
  assert.equal(mcpAllowed(document, "post", "/v1/permissions/sets"), false)
  assert.equal(mcpAllowed(document, "put", "/v1/permissions/sets/{permissionSetId}/permissions"), false)
  assert.equal(mcpAllowed(document, "delete", "/v1/permissions/sets/{permissionSetId}"), false)

  assert.equal(mcpAllowed(document, "get", "/v1/permissions/catalog"), true)
  assert.equal(mcpAllowed(document, "get", "/v1/permissions/sets"), true)
  assert.equal(mcpAllowed(document, "get", "/v1/permissions/sets/{permissionSetId}"), true)
})

test("MCP agents can only prepare removing a connection, never call the dashboard's DELETE", () => {
  assert.equal(document.paths["/v1/mcp-connections/{connectionId}/removal-request"]?.post?.operationId, "requestMcpConnectionRemoval")
  assert.equal(mcpAllowed(document, "post", "/v1/mcp-connections/{connectionId}/removal-request"), true)
  assert.equal(mcpAllowed(document, "get", "/v1/mcp-connections"), true)

  assert.equal(mcpAllowed(document, "delete", "/v1/mcp-connections/{connectionId}"), false)
  assert.equal(mcpAllowed(document, "delete", "/v1/mcp-connections/by-key/{externalKey}"), false)
})
