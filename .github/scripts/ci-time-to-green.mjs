#!/usr/bin/env node
// Time to green for pull-request CI, from GitHub's own timestamps.
//
// For each PR head commit in the window:
//   start    = earliest workflow run created for that commit (the push reaching GitHub)
//   required = latest completion of the merge-gating checks, when all of them passed
//   full     = latest completion of every GitHub Actions check, when none failed
// Prints p50/p90/p99 of both so before/after comparisons use one number.
//
// Usage: node .github/scripts/ci-time-to-green.mjs [--hours 24] [--branch-prefix perf/] [--repo owner/name] [--json]
import { execFileSync } from "node:child_process"
import { pathToFileURL } from "node:url"

export const REQUIRED_CHECKS = ["openwork-tests-required", "warden-clear"]
// A commit status that never settles; it is a report link, not a test.
const IGNORED_CHECKS = new Set(["Evidence preview"])
const FAILED = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"])

/** Nearest-rank percentile; null for no values. */
export function percentile(values, p) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]
}

/** One commit's timings from its start time and its check runs (GitHub check-run objects). */
export function commitTiming(startMs, checkRuns) {
  const checks = checkRuns.filter((check) => !IGNORED_CHECKS.has(check.name))
  const latest = (name) => checks.filter((check) => check.name === name).sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))[0]
  const required = REQUIRED_CHECKS.map(latest)
  const requiredGreen = required.every((check) => check?.status === "completed" && check.conclusion === "success")
  const actions = checks.filter((check) => check.app?.slug === "github-actions")
  const settled = actions.length > 0 && actions.every((check) => check.status === "completed")
  const failed = actions.some((check) => check.status === "completed" && FAILED.has(check.conclusion))
  const end = (list) => Math.max(...list.map((check) => Date.parse(check.completed_at)))
  return {
    requiredS: requiredGreen ? Math.round((end(required) - startMs) / 1000) : null,
    fullS: settled && !failed ? Math.round((end(actions) - startMs) / 1000) : null,
    state: failed ? "failed" : settled ? "settled" : "running",
  }
}

export function summarize(rows, key) {
  const values = rows.map((row) => row[key]).filter((value) => value !== null)
  return { n: values.length, p50: percentile(values, 50), p90: percentile(values, 90), p99: percentile(values, 99), max: values.length ? Math.max(...values) : null }
}

function gh(path) {
  return JSON.parse(execFileSync("gh", ["api", "-H", "Accept: application/vnd.github+json", path], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }))
}

function parseArgs(argv) {
  const args = new Map()
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--json") args.set("json", "1")
    else if (argv[i].startsWith("--")) args.set(argv[i].slice(2), argv[++i])
  }
  return args
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const repo = args.get("repo") ?? "different-ai/openwork"
  const hours = Number(args.get("hours") ?? 24)
  const prefix = args.get("branch-prefix") ?? ""
  if (!Number.isFinite(hours) || hours <= 0) throw new Error("--hours must be a positive number")
  const since = new Date(Date.now() - hours * 3_600_000).toISOString()

  const starts = new Map()
  for (let page = 1; page <= 10; page += 1) {
    const body = gh(`repos/${repo}/actions/runs?event=pull_request&per_page=100&page=${page}&created=%3E%3D${since}`)
    for (const run of body.workflow_runs) {
      if (prefix && !run.head_branch?.startsWith(prefix)) continue
      const entry = starts.get(run.head_sha) ?? { branch: run.head_branch, start: Infinity }
      entry.start = Math.min(entry.start, Date.parse(run.created_at))
      starts.set(run.head_sha, entry)
    }
    if (body.workflow_runs.length < 100) break
  }

  const rows = [...starts].map(([sha, { branch, start }]) => ({
    sha: sha.slice(0, 9), branch, ...commitTiming(start, gh(`repos/${repo}/commits/${sha}/check-runs?per_page=100`).check_runs),
  }))
  const result = { repo, hours, prefix: prefix || null, commits: rows.length, required: summarize(rows, "requiredS"), full: summarize(rows, "fullS"), rows }
  if (args.has("json")) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  const fmt = (s) => (s === null ? "-" : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`)
  for (const key of ["required", "full"]) {
    const s = result[key]
    console.log(`${key.padEnd(8)} n=${String(s.n).padStart(3)}  p50 ${fmt(s.p50)}  p90 ${fmt(s.p90)}  p99 ${fmt(s.p99)}  max ${fmt(s.max)}`)
  }
  console.log(`commits in window: ${rows.length} (${rows.filter((r) => r.state === "failed").length} failed, ${rows.filter((r) => r.state === "running").length} running)`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main()
