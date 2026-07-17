import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  assertEnterpriseMcpSchema,
  ENTERPRISE_MCP_TOOL_SCHEMA_COMPOSITION_BRANCH_LIMIT,
  EnterpriseMcpCatalogError,
  extractEnterpriseMcpHeaderParameterBindings,
} from "../src/index.js"

describe("bounded JSON Schema 2020-12", () => {
  it("preserves bounded composition, conditionals, definitions, and local references", () => {
    assert.doesNotThrow(() => assertEnterpriseMcpSchema({
      type: "object",
      $defs: {
        query: {
          type: "object",
          properties: { text: { type: "string", minLength: 1, maxLength: 200 } },
          required: ["text"],
        },
      },
      properties: {
        query: { $ref: "#/$defs/query" },
        mode: { oneOf: [{ const: "fast" }, { const: "complete" }] },
      },
      if: { properties: { mode: { const: "complete" } } },
      then: { required: ["query"] },
    }))
  })

  it("rejects external, unresolved, and cyclic references", () => {
    for (const [schema, code] of [
      [{ $ref: "https://schemas.example.test/tool.json" }, "MCP_CATALOG_SCHEMA_EXTERNAL_REFERENCE"],
      [{ $ref: "#/$defs/missing", $defs: {} }, "MCP_CATALOG_SCHEMA_REFERENCE_UNRESOLVED"],
      [{ $ref: "#/$defs/node", $defs: { node: { $ref: "#/$defs/node" } } }, "MCP_CATALOG_SCHEMA_REFERENCE_CYCLE"],
    ]) {
      assert.throws(
        () => assertEnterpriseMcpSchema(schema),
        (error: unknown) => error instanceof EnterpriseMcpCatalogError && error.code === code,
      )
    }
  })

  it("rejects excessive composition fan-out", () => {
    assert.throws(
      () => assertEnterpriseMcpSchema({
        oneOf: Array.from(
          { length: ENTERPRISE_MCP_TOOL_SCHEMA_COMPOSITION_BRANCH_LIMIT + 1 },
          (_value, index) => ({ const: index }),
        ),
      }),
      (error: unknown) => error instanceof EnterpriseMcpCatalogError
        && error.code === "MCP_CATALOG_SCHEMA_COMPOSITION_LIMIT",
    )
  })

  it("extracts nested and referenced x-mcp-header annotations without rewriting the schema", () => {
    const schema = {
      type: "object",
      $defs: {
        routing: {
          type: "object",
          properties: {
            region: { type: "string", "x-mcp-header": "Region" },
          },
        },
      },
      properties: {
        tenant: { type: "string", "x-mcp-header": "Tenant" },
        routing: { $ref: "#/$defs/routing" },
      },
    }
    const before = JSON.stringify(schema)
    assert.deepEqual(extractEnterpriseMcpHeaderParameterBindings(schema), [
      { parameterPath: ["tenant"], headerName: "Tenant" },
      { parameterPath: ["routing", "region"], headerName: "Region" },
    ])
    assert.equal(JSON.stringify(schema), before)
  })

  it("rejects invalid, non-primitive, floating-point, and duplicate routing headers", () => {
    for (const schema of [
      {
        type: "object",
        properties: { value: { type: "string", "x-mcp-header": "bad header" } },
      },
      {
        type: "object",
        properties: { value: { type: "number", "x-mcp-header": "Value" } },
      },
      {
        type: "object",
        properties: { value: { type: "object", "x-mcp-header": "Value" } },
      },
      {
        type: "object",
        properties: {
          left: { type: "string", "x-mcp-header": "Region" },
          right: { type: "string", "x-mcp-header": "REGION" },
        },
      },
    ]) {
      assert.throws(
        () => extractEnterpriseMcpHeaderParameterBindings(schema),
        (error: unknown) => error instanceof EnterpriseMcpCatalogError
          && error.code === "MCP_CATALOG_TOOL_ROUTING_HEADER_INVALID",
      )
    }
  })
})
