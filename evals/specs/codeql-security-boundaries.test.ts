import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect } from "vitest"
import { test } from "@openwork/testkit"

const repoRoot = resolve(import.meta.dirname, "../..")

const witnesses = [
  {
    label: "external MCP OAuth identity and callback compatibility",
    packageName: "@openwork-ee/den-api",
    files: ["test/external-mcp-oauth-state-identity.test.ts"],
    tests: 4,
    testNames: [
      "OAuth state identity binding excludes connection credentials",
      "OAuth state identity binding does not expose secret-like URL query values",
      "OAuth state identity binding remains fixed length for maximum-length URLs",
      "signed OAuth callbacks can match pre-hash identity bindings without emitting them for new states",
    ],
  },
  {
    label: "Den Web brand icons and plugin import persistence",
    packageName: "@openwork-ee/den-web",
    files: ["tests/brand-icon-security.test.ts", "tests/plugin-import-flow.test.ts"],
    tests: 9,
    testNames: [
      "rejects executable, cross-origin-relative, insecure, and credential-bearing URLs",
      "persists and migrates selected non-sensitive import metadata across fresh reloads",
    ],
  },
  {
    label: "inference bearer key rollout compatibility",
    packageName: "@openwork-ee/utils",
    files: ["src/inference-bearer-key.test.ts"],
    tests: 4,
    testNames: ["keeps new writes readable by SHA-256-only deployments during rollout"],
  },
  {
    label: "install-config parsing boundaries",
    packageName: "@openwork/install-config",
    files: ["tests/index.test.ts"],
    tests: 5,
    testNames: [
      "preserves punycode and dashes in hosts and tokens",
      "parses tags with delimiters in the installer prefix without treating token segments as hosts",
      "rejects malformed huge input without ambiguous delimiter backtracking",
    ],
  },
]

test("CodeQL security boundary witnesses stay required in the PR lane", ({ evidence }) => {
  const reportDir = mkdtempSync(join(tmpdir(), "openwork-codeql-security-boundaries-"))
  try {
    for (const [index, witness] of witnesses.entries()) {
      const reportPath = join(reportDir, `bun-junit-${index}.xml`)
      const result = spawnSync("pnpm", [
        "--filter",
        witness.packageName,
        "exec",
        "bun",
        "test",
        "--conditions",
        "development",
        ...witness.files,
        "--reporter=junit",
        `--reporter-outfile=${reportPath}`,
      ], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        timeout: 60_000,
      })
      const output = `${result.stdout}${result.stderr}`

      expect(result.error, `${witness.label}\n${output}`).toBeUndefined()
      expect(result.status, `${witness.label}\n${output}`).toBe(0)

      const junit = readFileSync(reportPath, "utf8")
      const summary = junit.match(/<testsuites?\b[^>]*>/)?.[0] ?? ""
      expect(summary, junit).toContain(`tests="${witness.tests}"`)
      expect(summary, junit).toContain('failures="0"')
      expect(summary, junit).toContain('skipped="0"')
      expect(junit).not.toContain("<failure")
      expect(junit).not.toContain("<skipped")
      for (const testName of witness.testNames) {
        expect(junit).toContain(`name="${testName}"`)
      }

      console.info(`[codeql-security-boundaries] ${witness.label}: ${witness.tests} passed`)
    }

    evidence.recordAssertionEvidence(
      "External MCP OAuth state is opaque without breaking in-flight callbacks",
      "The focused Den API witness requires fixed-length identity bindings that exclude credentials and secret-like URL values, while accepting only the matching pre-hash callback identity during rollout.",
      true,
    )
    evidence.recordAssertionEvidence(
      "Den Web rejects unsafe brand images and safely restores plugin import choices",
      "The focused Den Web witnesses reject executable, malformed, insecure, and credential-bearing icon URLs and persist only selected non-sensitive plugin metadata with explicit legacy defaults.",
      true,
    )
    evidence.recordAssertionEvidence(
      "Inference bearer keys remain readable across the digest rollout",
      "The focused utility witness requires legacy-compatible storage plus both HMAC and legacy lookup digests without collapsing the two digests.",
      true,
    )
    evidence.recordAssertionEvidence(
      "Install-config parsing is bounded and delimiter-safe",
      "The focused parser witness preserves valid punycode, host, and token dashes while rejecting ambiguous or huge malformed input without backtracking.",
      true,
    )
  } finally {
    rmSync(reportDir, { force: true, recursive: true })
  }
})
