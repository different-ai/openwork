import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect } from "vitest"
import { test } from "@openwork/testkit"

const repoRoot = resolve(import.meta.dirname, "../..")

function runBunTests(input: {
  files: string[]
  packageName: string
  reportPath: string
  timeout?: number
}) {
  const result = spawnSync("pnpm", [
    "--filter",
    input.packageName,
    "exec",
    "bun",
    "test",
    "--conditions",
    "development",
    ...input.files,
    "--reporter=junit",
    `--reporter-outfile=${input.reportPath}`,
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    timeout: input.timeout ?? 90_000,
  })
  return {
    error: result.error,
    output: `${result.stdout}${result.stderr}`,
    status: result.status,
  }
}

function expectCleanReport(reportPath: string, expectedTests: number) {
  const junit = readFileSync(reportPath, "utf8")
  const summary = junit.match(/<testsuites?\b[^>]*>/)?.[0] ?? ""
  expect(summary).toContain(`tests="${expectedTests}"`)
  expect(summary).toContain('failures="0"')
  expect(summary).toContain('skipped="0"')
  expect(junit).not.toContain("<failure")
  expect(junit).not.toContain("<skipped")
  return junit
}

test("Agent Plugins import stays portable across current schemas and MCP transport", ({ evidence }) => {
  const reportDir = mkdtempSync(join(tmpdir(), "openwork-agent-plugin-import-"))
  try {
    const databaseBuild = spawnSync("pnpm", [
      "--filter",
      "@openwork-ee/den-db",
      "build",
    ], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      timeout: 120_000,
    })
    const databaseBuildOutput = `${databaseBuild.stdout}${databaseBuild.stderr}`
    expect(databaseBuild.error, databaseBuildOutput).toBeUndefined()
    expect(databaseBuild.status, databaseBuildOutput).toBe(0)

    const apiReportPath = join(reportDir, "api-junit.xml")
    const api = runBunTests({
      files: [
        "test/agent-plugin-v1.test.ts",
        "test/agent-plugin-import-policy.test.ts",
        "test/github-discovery.test.ts",
        "test/github-connector-app.test.ts",
      ],
      packageName: "@openwork-ee/den-api",
      reportPath: apiReportPath,
    })
    expect(api.error, api.output).toBeUndefined()
    expect(api.status, api.output).toBe(0)
    const apiReport = expectCleanReport(apiReportPath, 30)
    expect(apiReport).toContain('name="ships a published 1.0 package with a valid OpenWork Connect MCP configuration"')
    expect(apiReport).toContain('name="accepts the schema-identical 1.1 working draft without weakening 1.0 compatibility"')
    expect(apiReport).toContain('name="rejects mixed manifest and MCP schema versions"')
    expect(apiReport).toContain('name="keeps valid siblings when one server violates the v1 schema"')
    expect(apiReport).toContain('name="accepts valid Agent Skills and isolates a parent-directory name mismatch"')
    expect(apiReport).toContain('name="preserves legacy Claude-compatible MCP parsing behavior"')
    expect(apiReport).toContain('name="preserves Claude-compatible discovery when both manifest formats are present"')

    const webReportPath = join(reportDir, "web-junit.xml")
    const web = runBunTests({
      files: ["tests/plugin-import-flow.test.ts"],
      packageName: "@openwork-ee/den-web",
      reportPath: webReportPath,
    })
    expect(web.error, web.output).toBeUndefined()
    expect(web.status, web.output).toBe(0)
    const webReport = expectCleanReport(webReportPath, 6)
    expect(webReport).toContain('name="preserves Agent Plugin compatibility warnings in the draft"')

    const mcpReportPath = join(reportDir, "mcp-junit.xml")
    const mcp = runBunTests({
      files: ["test/mcp-agent-stateless.test.ts"],
      packageName: "@openwork-ee/den-api",
      reportPath: mcpReportPath,
      timeout: 120_000,
    })
    expect(mcp.error, mcp.output).toBeUndefined()
    expect(mcp.status, mcp.output).toBe(0)
    const mcpReport = expectCleanReport(mcpReportPath, 6)
    expect(mcpReport).toContain('name="serves the 2026 stateless wire with fresh per-request servers"')
    expect(mcpReport).toContain('name="keeps the 2025 stateless fallback for existing clients"')

    evidence.recordAssertionEvidence(
      "Published packages and the current working draft remain interoperable",
      "The shipped OpenWork Connect package targets published Agent Plugins 1.0.0, while discovery and import accept the schema-identical 1.1.0 working draft, preserve the recognized source version, and reject a mixed plugin.json and mcp.json version without disabling independent component types.",
      true,
    )
    evidence.recordAssertionEvidence(
      "Portable component failures stay isolated and visible",
      "The import witness accepts conforming immediate Agent Skills and safe remote MCP entries, skips a directory-name mismatch or invalid server independently, and exposes unsupported stdio, static-header, and malformed configuration states to the administrator-facing preview.",
      true,
    )
    evidence.recordAssertionEvidence(
      "Existing Claude-compatible import behavior remains intact",
      "The regression witness preserves the legacy mcp object parser and its static-header behavior, and an explicit Claude plugin manifest keeps the established Claude interpretation when both package markers exist.",
      true,
    )
    evidence.recordAssertionEvidence(
      "The package endpoint negotiates current MCP without dropping existing clients",
      "The OpenWork Connect package selects Streamable HTTP without pinning a wire revision; the endpoint witness serves stateless MCP 2026-07-28 with fresh request-local servers and retains its 2025 compatibility path.",
      true,
    )
  } finally {
    rmSync(reportDir, { force: true, recursive: true })
  }
})
