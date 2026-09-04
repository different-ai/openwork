#!/usr/bin/env node
// Lints the Den API OpenAPI document with Spectral and ratchets warnings.
//
//   pnpm api:lint                      lint packages/docs/openapi.json
//   pnpm api:lint --update-baseline    record the current warning counts
//   pnpm api:lint --spec <path>        lint another document (same ruleset)
//   pnpm api:lint --json <path>        also write Spectral's JSON output there
//
// Exit 1 when Spectral reports any error, or when the warning count exceeds
// .spectral-baseline.json. The ruleset lives in .spectral.yaml; both are
// explained in docs/api-style.md.
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const rulesetPath = resolve(repoRoot, ".spectral.yaml")
const baselinePath = resolve(repoRoot, ".spectral-baseline.json")

const args = process.argv.slice(2)
function option(name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const specPath = resolve(repoRoot, option("--spec") ?? "packages/docs/openapi.json")
const jsonOutputPath = resolve(repoRoot, option("--json") ?? "tmp/spectral-report.json")
const updateBaseline = args.includes("--update-baseline")

const spectral = spawnSync(
  "pnpm",
  ["exec", "spectral", "lint", specPath, "--ruleset", rulesetPath, "--format", "json", "--quiet"],
  { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
)
if (spectral.error) {
  console.error(`Could not run Spectral: ${spectral.error.message}`)
  process.exit(2)
}
// Spectral exits 1 when it finds errors; only a non-JSON stdout is a crash.
let results
try {
  results = JSON.parse(spectral.stdout)
} catch {
  console.error(spectral.stdout)
  console.error(spectral.stderr)
  console.error("Spectral did not produce JSON output.")
  process.exit(2)
}
if (!Array.isArray(results)) {
  console.error("Spectral output was not an array of results.")
  process.exit(2)
}

mkdirSync(dirname(jsonOutputPath), { recursive: true })
writeFileSync(jsonOutputPath, JSON.stringify(results, null, 2))

const errors = results.filter((result) => result.severity === 0)
const warnings = results.filter((result) => result.severity === 1)
const warningsByRule = {}
for (const warning of warnings) {
  warningsByRule[warning.code] = (warningsByRule[warning.code] ?? 0) + 1
}
const sortedByRule = Object.fromEntries(Object.entries(warningsByRule).sort(([a], [b]) => a.localeCompare(b)))

const displaySpec = relative(repoRoot, specPath)
console.log(`Spectral: ${displaySpec} -> ${errors.length} error(s), ${warnings.length} warning(s)`)
for (const [rule, count] of Object.entries(sortedByRule)) {
  console.log(`  ${String(count).padStart(5)}  ${rule}`)
}
console.log(`Full report: ${relative(repoRoot, jsonOutputPath)}`)

for (const error of errors) {
  console.error(`ERROR ${error.code} at ${error.path.join("/")}: ${error.message}`)
}

if (updateBaseline) {
  writeFileSync(baselinePath, `${JSON.stringify({ warnings: warnings.length, byRule: sortedByRule }, null, 2)}\n`)
  console.log(`Updated ${relative(repoRoot, baselinePath)} to ${warnings.length} warning(s).`)
}

let failed = false
if (errors.length > 0) {
  console.error(`\n${errors.length} Spectral error(s); the API document must lint with zero errors.`)
  failed = true
}

if (!existsSync(baselinePath)) {
  console.error(`\nMissing ${relative(repoRoot, baselinePath)}; run \`pnpm api:lint --update-baseline\` and commit it.`)
  failed = true
} else {
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"))
  const allowed = typeof baseline.warnings === "number" ? baseline.warnings : 0
  if (warnings.length > allowed) {
    console.error(`\nWarnings increased: ${warnings.length} > baseline ${allowed}. Fix the new findings or, for a deliberate exception, document it in .spectral.yaml overrides.`)
    for (const [rule, count] of Object.entries(sortedByRule)) {
      const before = baseline.byRule?.[rule] ?? 0
      if (count > before) console.error(`  +${count - before}  ${rule} (${before} -> ${count})`)
    }
    failed = true
  } else if (warnings.length < allowed && !updateBaseline) {
    console.log(`\nWarnings decreased (${allowed} -> ${warnings.length}). Ratchet the baseline down with \`pnpm api:lint --update-baseline\`.`)
  }
}

process.exit(failed ? 1 : 0)
