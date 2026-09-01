import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { expect } from "vitest"
import { test } from "@openwork/testkit"

const script = fileURLToPath(new URL("../scripts/spec-impact.mjs", import.meta.url))
const repoRoot = fileURLToPath(new URL("../..", import.meta.url))
const snapshotPath = fileURLToPath(new URL("./contracts.snapshot.json", import.meta.url))

interface ContractSnapshot {
  id: string
  implementation: string[]
  specs: string[]
}

interface UnmappedSnapshot {
  spec: string
  reason: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be a string array`)
  }
  return value
}

function readSnapshot(): { contracts: ContractSnapshot[]; unmapped: UnmappedSnapshot[] } {
  const value: unknown = JSON.parse(readFileSync(snapshotPath, "utf8"))
  if (!isRecord(value) || !Array.isArray(value.contracts)) throw new Error("invalid contracts snapshot")
  const contracts = value.contracts.map((contract, index) => {
    if (!isRecord(contract) || typeof contract.id !== "string") throw new Error(`invalid contract at index ${index}`)
    return {
      id: contract.id,
      implementation: stringArray(contract.implementation, `${contract.id}.implementation`),
      specs: stringArray(contract.specs, `${contract.id}.specs`),
    }
  })
  const rawUnmapped = value.unmapped ?? []
  if (!Array.isArray(rawUnmapped)) throw new Error("snapshot unmapped must be an array")
  const unmapped = rawUnmapped.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.spec !== "string" || typeof entry.reason !== "string") {
      throw new Error(`invalid unmapped entry at index ${index}`)
    }
    return { spec: entry.spec, reason: entry.reason }
  })
  return { contracts, unmapped }
}

function run(...changedFiles: string[]): string {
  return execFileSync(process.execPath, [script, ...changedFiles.flatMap((file) => ["--changed-file", file])], {
    encoding: "utf8",
  })
}

function runMatched(...changedFiles: string[]): string {
  return execFileSync(process.execPath, [script, "--matched-tests", ...changedFiles.flatMap((file) => ["--changed-file", file])], {
    encoding: "utf8",
  })
}

test("the soft spec-impact snapshot identifies uncovered and covered contract changes", ({ evidence }) => {
  const uncovered = run("ee/apps/den-api/src/workflow-runs.ts")
  expect(uncovered).toContain("Needs attention")
  expect(uncovered).toContain("den.workflow-receipts")
  expect(uncovered).toContain("::warning title=Spec impact snapshot::")
  expect(uncovered).toContain("Matched E2E tests:")

  const covered = run(
    "ee/apps/den-api/src/workflow-runs.ts",
    "evals/specs/generated-artifact-views.e2e.test.ts",
  )
  expect(covered).toContain("Covered by a changed E2E test")
  expect(covered).not.toContain("::warning title=Spec impact snapshot::")

  const matched = JSON.parse(runMatched("ee/apps/den-api/src/workflow-runs.ts"))
  expect(matched).toContain("evals/specs/workflows.e2e.test.ts")
  expect(matched).toContain("evals/specs/generated-artifact-views.e2e.test.ts")

  evidence.recordAssertionEvidence(
    "Implementation changes map to their E2E tests",
    "The advisory report warned without a mapped E2E test change and cleared when the generated Artifact view E2E test changed.",
    true,
  )
})

test("the spec-impact report suggests an E2E test for unmapped changes", ({ evidence }) => {
  const report = run("apps/app/src/react-app/unmapped-feature.ts")
  expect(report).toContain("Warden suggestion: add or update an `evals/specs/<feature>.e2e.test.ts`")
  evidence.recordAssertionEvidence(
    "Unmapped app changes receive an E2E test suggestion",
    "Warden reports an actionable E2E test suggestion when no contract matches.",
    true,
  )
})

test("the spec-impact matcher always selects changed E2E tests", ({ evidence }) => {
  const matched = JSON.parse(runMatched("evals/specs/new-unmapped-feature.e2e.test.ts"))
  expect(matched).toEqual(["evals/specs/new-unmapped-feature.e2e.test.ts"])
  evidence.recordAssertionEvidence(
    "New E2E tests enter PR regression without a contract mapping",
    "The matcher selected a changed unmapped E2E test directly.",
    true,
  )
})

test("every E2E spec is mapped to an implementation contract or explicitly allowlisted", ({ evidence }) => {
  const snapshot = readSnapshot()
  const inventory = readdirSync(resolve(repoRoot, "evals/specs"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".e2e.test.ts"))
    .map((entry) => `evals/specs/${entry.name}`)
    .sort()
  const inventorySet = new Set(inventory)
  const mapped = new Set(snapshot.contracts.flatMap((contract) => contract.specs))
  const allowlisted = new Set(snapshot.unmapped.map((entry) => entry.spec))
  const missing = inventory.filter((spec) => !mapped.has(spec) && !allowlisted.has(spec))
  const deadMapped = [...mapped].filter((spec) => spec.endsWith(".e2e.test.ts") && !inventorySet.has(spec)).sort()
  const deadAllowlisted = [...allowlisted].filter((spec) => !inventorySet.has(spec)).sort()
  const duplicated = [...allowlisted].filter((spec) => mapped.has(spec)).sort()

  expect(missing, `E2E specs missing a contract or unmapped reason:\n${missing.join("\n")}`).toEqual([])
  expect(deadMapped, `Mapped E2E specs missing on disk:\n${deadMapped.join("\n")}`).toEqual([])
  expect(deadAllowlisted, `Allowlisted E2E specs missing on disk:\n${deadAllowlisted.join("\n")}`).toEqual([])
  expect(duplicated, `E2E specs are both mapped and allowlisted:\n${duplicated.join("\n")}`).toEqual([])
  evidence.recordAssertionEvidence(
    "Every E2E spec has an implementation-driven selection path or an explicit allowlist entry",
    `All ${inventory.length} E2E specs are covered, with ${snapshot.unmapped.length} explicitly allowlisted and no dead or duplicate references.`,
    true,
  )
})

test("implementation patterns resolve to real paths", ({ evidence }) => {
  const { contracts } = readSnapshot()
  const forbiddenRoots = [
    "apps",
    "apps/app/src",
    "apps/app/src/react-app",
    "ee",
    "ee/apps/den-api/src",
    "packages",
  ]
  const failures: string[] = []

  for (const contract of contracts) {
    for (const pattern of contract.implementation) {
      const isDirectoryPattern = pattern.endsWith("/**")
      const patternRoot = isDirectoryPattern ? pattern.slice(0, -3) : pattern
      if (isDirectoryPattern && forbiddenRoots.some((root) => root === patternRoot || root.startsWith(`${patternRoot}/`))) {
        failures.push(`${contract.id}: forbidden root ${pattern}`)
      }
      const pathname = resolve(repoRoot, patternRoot)
      if (!existsSync(pathname)) {
        failures.push(`${contract.id}: missing ${pattern}`)
      } else if (isDirectoryPattern && (!statSync(pathname).isDirectory() || readdirSync(pathname).length === 0)) {
        failures.push(`${contract.id}: empty or non-directory glob root ${pattern}`)
      } else if (!isDirectoryPattern && !statSync(pathname).isFile()) {
        failures.push(`${contract.id}: exact pattern is not a file ${pattern}`)
      }
    }
  }

  expect(failures, `Invalid implementation patterns:\n${failures.join("\n")}`).toEqual([])
  evidence.recordAssertionEvidence(
    "Implementation contract patterns stay feature-scoped and resolve to live paths",
    `Every implementation pattern across ${contracts.length} contracts resolved to a non-empty feature path without covering a forbidden app root.`,
    true,
  )
})

test("selection stays narrow across domains", ({ evidence }) => {
  const automations = JSON.parse(runMatched("apps/app/src/react-app/domains/automations/automations-page.tsx"))
  expect(automations).toContain("evals/specs/automation-revision-revert.e2e.test.ts")
  expect(automations).not.toContain("evals/specs/sso-domain-verification.e2e.test.ts")

  const sso = JSON.parse(runMatched("ee/apps/den-api/src/sso-domain-verification.ts"))
  expect(sso).toContain("evals/specs/sso-domain-verification.e2e.test.ts")
  expect(sso).not.toContain("evals/specs/automation-revision-revert.e2e.test.ts")
  evidence.recordAssertionEvidence(
    "Domain changes select only their mapped E2E specs",
    "Automation and SSO implementation changes selected their own mapped specs without selecting the unrelated domain sample.",
    true,
  )
})
