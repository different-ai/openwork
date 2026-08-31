import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect } from "vitest"
import { localMysqlIsRunning, needs, test } from "@openwork/testkit"

const repoRoot = resolve(import.meta.dirname, "../..")
const mysqlOpen = await localMysqlIsRunning()

test.skipIf(!mysqlOpen)("Google Workspace retrieval enforces Drive access and bounds model-visible output", ({ evidence }) => {
  needs({})
  const reportDir = mkdtempSync(join(tmpdir(), "google-workspace-retrieval-"))
  const reportPath = join(reportDir, "junit.xml")
  try {
    const result = spawnSync("pnpm", [
      "--filter",
      "@openwork-ee/den-api",
      "exec",
      "bun",
      "test",
      "test/mcp-tool-content.test.ts",
      "test/google-workspace-capabilities.test.ts",
      "--reporter=junit",
      `--reporter-outfile=${reportPath}`,
    ], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 180_000,
      maxBuffer: 20 * 1024 * 1024,
    })
    const output = `${result.stdout}${result.stderr}`

    expect(result.error, output).toBeUndefined()
    expect(result.status, output).toBe(0)
    const report = readFileSync(reportPath, "utf8")
    expect(report).toContain('name="drive.file alone cannot execute general Drive search"')
    expect(report).toContain('name="drive.file alone cannot execute general Drive read"')
    expect(report).toContain('name="missing or empty recorded scopes fail closed for general Drive search and read"')
    expect(report).toContain('name="a file created directly in My Drive requires read-all scope for the same file id"')
    expect(report).toContain('name="Drive 404 remains an ambiguous item error when full read access is recorded"')
    expect(report).toContain('name="Drive file read rejects folders after metadata without attempting content download"')
    expect(report).toContain('name="Google Drive authorization failures become an actionable connector response"')
    expect(report).toContain('name="gmail list overlaps metadata requests with bounded concurrency and preserves list order"')
    expect(report).toContain('name="gmail metadata failure stops new work and returns the existing upstream error shape"')
    expect(report).toContain('name="existing MCP search and execute path enforces Drive scope and bounds model-visible content"')
    expect(report).toContain('name="drive text retains the existing retrieval limit before MCP serialization"')
    expect(report).toContain('name="gmail message body retains the existing retrieval limit before MCP serialization"')
    expect(report).not.toContain("<failure")
    expect(report).not.toContain("<skipped")
  } finally {
    rmSync(reportDir, { recursive: true, force: true })
  }

  evidence.recordAssertionEvidence(
    "General Drive retrieval requires a verified read grant",
    "The focused connector suite proves selected-file access cannot call general Drive search or read, missing grants fail closed, and the same file created directly in My Drive succeeds with read-only or full Drive access. Provider authorization failures remain actionable, file-read 404s remain bounded and ambiguous, folders stop after metadata without traversal, and Shared Drive flags are sent as a separate compatibility correction.",
    true,
  )
  evidence.recordAssertionEvidence(
    "Gmail metadata retrieval overlaps bounded requests without reordering results",
    "Six delayed metadata requests overlap with a maximum concurrency of four while the response remains in the original Gmail list order.",
    true,
  )
  evidence.recordAssertionEvidence(
    "The existing MCP path keeps model-visible connector output bounded",
    "A real search_capabilities and execute_capability journey omits oversized non-image base64 before download where metadata permits, preserves existing small attachment bytes, compacts large JSON, and applies model-visible text limits to Drive and Gmail content without reducing their retrieval-layer limits.",
    true,
  )
})
