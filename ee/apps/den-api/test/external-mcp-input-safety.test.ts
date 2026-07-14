import { describe, expect, test } from "bun:test"
import {
  EXTERNAL_MCP_MANIFEST_INSPECTION_LIMITS,
  containsExternalMcpManifestCredentialValue,
  externalMcpUrlContainsCredential,
  inspectExternalMcpManifest,
  isSensitiveExternalMcpCredentialKey,
} from "../src/capability-sources/external-mcp-input-safety.js"

describe("external MCP input safety", () => {
  test.each([
    "apiKey",
    "github_token",
    "customSessionToken",
    "database-password",
    "signing_key_id",
    "x-amz-signature",
    "proxyAuthorization",
  ])("recognizes broad credential key spelling: %s", (key) => {
    expect(isSensitiveExternalMcpCredentialKey(key)).toBe(true)
  })

  test("applies the same broad policy to URL query keys", () => {
    for (const key of ["githubToken", "accessKeyId", "custom_session_token", "databasePassword", "signingKey"]) {
      expect(externalMcpUrlContainsCredential(`https://mcp.example.test/mcp?${key}=literal`), key).toBe(true)
    }
    expect(externalMcpUrlContainsCredential("https://mcp.example.test/mcp?region=us-east-1")).toBe(false)
  })

  test("rejects provider-specific manifest credentials while retaining placeholders", () => {
    expect(containsExternalMcpManifestCredentialValue({
      config: {
        githubToken: "literal-token",
      },
    })).toBe(true)
    expect(containsExternalMcpManifestCredentialValue({
      config: {
        signing_key: "literal-signing-key",
      },
    })).toBe(true)
    expect(containsExternalMcpManifestCredentialValue({
      endpoint: "https://mcp.example.test/mcp?customSessionToken=literal",
    })).toBe(true)
    expect(containsExternalMcpManifestCredentialValue({
      args: ["--github-token=${GITHUB_TOKEN}", "--signing-key", "{{ SIGNING_KEY }}"],
      config: {
        databasePassword: "${DATABASE_PASSWORD:-ask-me}",
        githubToken: "$GITHUB_TOKEN",
      },
    })).toBe(false)
  })

  test("rejects excessive nesting without recursive traversal", () => {
    const root: Record<string, unknown> = {}
    let cursor = root
    for (let depth = 0; depth < 10_000; depth += 1) {
      const next: Record<string, unknown> = {}
      cursor.next = next
      cursor = next
    }
    expect(inspectExternalMcpManifest(root)).toEqual({ status: "limit_exceeded", limit: "depth" })
  })

  test("bounds visited manifest nodes", () => {
    const manifest: Record<string, unknown> = {}
    for (let index = 0; index < EXTERNAL_MCP_MANIFEST_INSPECTION_LIMITS.nodes; index += 1) {
      manifest[`field_${index}`] = index
    }
    expect(inspectExternalMcpManifest(manifest)).toEqual({ status: "limit_exceeded", limit: "nodes" })
  })

  test("bounds argument-array scanning before inspecting every entry", () => {
    const args = Array.from(
      { length: EXTERNAL_MCP_MANIFEST_INSPECTION_LIMITS.nodes + 100 },
      (_value, index) => `--region-${index}`,
    )
    expect(inspectExternalMcpManifest({ args })).toEqual({ status: "limit_exceeded", limit: "nodes" })
  })

  test("bounds inspected manifest bytes", () => {
    expect(inspectExternalMcpManifest({
      description: "x".repeat(EXTERNAL_MCP_MANIFEST_INSPECTION_LIMITS.bytes + 1),
    })).toEqual({ status: "limit_exceeded", limit: "bytes" })
  })

  test("handles repeated object references without looping", () => {
    const manifest: Record<string, unknown> = {}
    manifest.self = manifest
    expect(inspectExternalMcpManifest(manifest)).toEqual({ status: "safe" })
  })
})
