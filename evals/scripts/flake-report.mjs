// Flake-rate reporting over repeated vitest runs.
//
// collect: run one lane with the vitest JSON reporter and save the receipt.
//   node scripts/flake-report.mjs collect [--project pr|e2e] [-- <extra vitest args>]
// report: aggregate every saved receipt into per-spec pass rates.
//   node scripts/flake-report.mjs report [--project pr|e2e] [--threshold 0.95]
//
// A spec is "flaky" when the same spec file both passed and failed across the
// collected runs. Specs below the pass-rate threshold belong on the quarantine
// list until diagnosed (see diagnose-a-red-run).
import { execFileSync } from "node:child_process"
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const evalsRoot = fileURLToPath(new URL("..", import.meta.url))

export function runsDirectory(project) {
  return resolve(evalsRoot, "results", "flake", project)
}

function parseArguments(argv) {
  const separator = argv.indexOf("--")
  const own = separator === -1 ? argv : argv.slice(0, separator)
  const passthrough = separator === -1 ? [] : argv.slice(separator + 1)
  const mode = own[0]
  if (mode !== "collect" && mode !== "report") {
    throw new Error("usage: flake-report.mjs <collect|report> [--project pr|e2e] [--threshold 0.95] [-- vitest args]")
  }
  let project = "pr"
  let threshold = 0.95
  for (let index = 1; index < own.length; index += 1) {
    if (own[index] === "--project") {
      project = own[index + 1] ?? ""
      index += 1
    } else if (own[index] === "--threshold") {
      threshold = Number(own[index + 1])
      index += 1
    } else {
      throw new Error(`unknown argument: ${own[index]}`)
    }
  }
  if (project !== "pr" && project !== "e2e") throw new Error("--project must be pr or e2e")
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) throw new Error("--threshold must be in (0, 1]")
  return { mode, project, threshold, passthrough }
}

export function normalizeRun(receipt, root) {
  if (typeof receipt !== "object" || receipt === null || !Array.isArray(receipt.testResults)) {
    throw new Error("receipt is not a vitest JSON reporter payload")
  }
  return receipt.testResults.map((file) => {
    const tests = Array.isArray(file.assertionResults) ? file.assertionResults : []
    const durationMs = tests.reduce((total, test) => total + (typeof test.duration === "number" ? test.duration : 0), 0)
    return {
      spec: relative(root, file.name).replaceAll("\\", "/"),
      passed: file.status === "passed",
      skipped: tests.length > 0 && tests.every((test) => test.status === "pending" || test.status === "skipped" || test.status === "todo"),
      durationMs,
    }
  })
}

export function aggregate(runs, threshold) {
  const bySpec = new Map()
  for (const run of runs) {
    for (const entry of run) {
      if (entry.skipped) continue
      const current = bySpec.get(entry.spec) ?? { spec: entry.spec, runs: 0, passes: 0, durationsMs: [] }
      current.runs += 1
      if (entry.passed) current.passes += 1
      current.durationsMs.push(entry.durationMs)
      bySpec.set(entry.spec, current)
    }
  }
  const specs = [...bySpec.values()]
    .map((entry) => {
      const passRate = entry.passes / entry.runs
      const meanDurationMs = entry.durationsMs.reduce((total, value) => total + value, 0) / entry.runs
      return {
        spec: entry.spec,
        runs: entry.runs,
        passes: entry.passes,
        passRate,
        flaky: entry.passes > 0 && entry.passes < entry.runs,
        quarantine: passRate < threshold,
        meanDurationMs: Math.round(meanDurationMs),
        maxDurationMs: Math.round(Math.max(...entry.durationsMs)),
      }
    })
    .sort((left, right) => left.passRate - right.passRate || right.maxDurationMs - left.maxDurationMs)
  return {
    threshold,
    totalRuns: runs.length,
    totalSpecs: specs.length,
    flakySpecs: specs.filter((entry) => entry.flaky).length,
    quarantineSpecs: specs.filter((entry) => entry.quarantine).length,
    specs,
  }
}

export function renderMarkdown(report, project) {
  const lines = [
    `# Flake report — ${project} lane`,
    "",
    `Runs aggregated: ${report.totalRuns} · Specs: ${report.totalSpecs} · Flaky: ${report.flakySpecs} · Below ${Math.round(report.threshold * 100)}% pass rate: ${report.quarantineSpecs}`,
    "",
    "| Spec | Runs | Pass rate | Flaky | Quarantine | Mean ms | Max ms |",
    "| --- | ---: | ---: | :---: | :---: | ---: | ---: |",
  ]
  for (const entry of report.specs) {
    lines.push(
      `| ${entry.spec} | ${entry.runs} | ${(entry.passRate * 100).toFixed(1)}% | ${entry.flaky ? "yes" : ""} | ${entry.quarantine ? "yes" : ""} | ${entry.meanDurationMs} | ${entry.maxDurationMs} |`,
    )
  }
  return `${lines.join("\n")}\n`
}

function collect(project, passthrough) {
  const directory = runsDirectory(project)
  mkdirSync(directory, { recursive: true })
  const outputFile = join(directory, `run-${new Date().toISOString().replaceAll(":", "-")}.json`)
  const vitestBin = resolve(evalsRoot, "node_modules", ".bin", process.platform === "win32" ? "vitest.CMD" : "vitest")
  const args = [
    "run",
    "--config",
    "vitest.config.ts",
    "--project",
    project,
    "--reporter=default",
    "--reporter=json",
    `--outputFile=${outputFile}`,
    ...passthrough,
  ]
  let failed = false
  try {
    execFileSync(vitestBin, args, { cwd: evalsRoot, stdio: "inherit" })
  } catch {
    failed = true
  }
  console.log(`\nflake-report: saved ${relative(evalsRoot, outputFile)} (${failed ? "red" : "green"} run)`)
}

function report(project, threshold) {
  const directory = runsDirectory(project)
  let files = []
  try {
    files = readdirSync(directory).filter((name) => name.startsWith("run-") && name.endsWith(".json"))
  } catch {
    throw new Error(`no collected runs in ${relative(evalsRoot, directory)}; run flake:collect first`)
  }
  if (files.length === 0) throw new Error(`no collected runs in ${relative(evalsRoot, directory)}; run flake:collect first`)
  const runs = files.map((name) => normalizeRun(JSON.parse(readFileSync(join(directory, name), "utf8")), evalsRoot))
  const result = aggregate(runs, threshold)
  const markdown = renderMarkdown(result, project)
  writeFileSync(join(directory, "flake-report.md"), markdown)
  writeFileSync(join(directory, "flake-report.json"), `${JSON.stringify(result, null, 2)}\n`)
  console.log(markdown)
  console.log(`flake-report: wrote ${relative(evalsRoot, join(directory, "flake-report.md"))}`)
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  const { mode, project, threshold, passthrough } = parseArguments(process.argv.slice(2))
  if (mode === "collect") collect(project, passthrough)
  else report(project, threshold)
}
