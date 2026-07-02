#!/usr/bin/env node
import { spawnSync } from "node:child_process"

const workflow = "update-models.yml"

function readOption(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  return process.argv[index + 1] ?? fallback
}

function runGh(args, options = {}) {
  const stdio = options.stdio ?? "pipe"
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    stdio,
  })

  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n").trim()
    throw new Error(`gh ${args.join(" ")} failed${details ? `:\n${details}` : ""}`)
  }

  return typeof result.stdout === "string" ? result.stdout.trim() : ""
}

function readGhJson(args) {
  const output = runGh(args)
  return output ? JSON.parse(output) : null
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parsePositiveInteger(value, name) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

async function findRun(input) {
  const startedAfterMs = input.startedAt.getTime() - 10_000

  for (let attempt = 0; attempt < input.maxPolls; attempt += 1) {
    const runs = readGhJson([
      "run",
      "list",
      "--workflow",
      workflow,
      "--branch",
      input.ref,
      "--event",
      "workflow_dispatch",
      "--limit",
      "20",
      "--json",
      "databaseId,status,conclusion,createdAt,url",
    ])

    const match = runs
      .filter((run) => new Date(run.createdAt).getTime() >= startedAfterMs)
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())[0]

    if (match) return match
    await sleep(input.intervalMs)
  }

  throw new Error(`Timed out waiting for ${workflow} run to appear`)
}

async function findPullRequest(branch, intervalMs) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const prs = readGhJson([
      "pr",
      "list",
      "--state",
      "all",
      "--head",
      branch,
      "--limit",
      "5",
      "--json",
      "number,url,state,mergedAt,title",
    ])

    if (prs.length > 0) return prs[0]
    await sleep(intervalMs)
  }

  return null
}

async function waitForMerge(pr, input) {
  for (let attempt = 0; attempt < input.maxPolls; attempt += 1) {
    const current = readGhJson([
      "pr",
      "view",
      String(pr.number),
      "--json",
      "number,url,state,mergedAt,title",
    ])

    if (current.mergedAt) return current
    if (current.state === "CLOSED") {
      throw new Error(`PR closed without merging: ${current.url}`)
    }

    console.log(`waiting for PR #${current.number} to merge: ${current.url}`)
    await sleep(input.intervalMs)
  }

  throw new Error(`Timed out waiting for PR to merge: ${pr.url}`)
}

const base = readOption("--base", "dev")
const ref = readOption("--ref", base)
const intervalSeconds = parsePositiveInteger(readOption("--interval-seconds", "20"), "interval-seconds")
const timeoutMinutes = parsePositiveInteger(readOption("--timeout-minutes", "90"), "timeout-minutes")
const intervalMs = intervalSeconds * 1000
const maxPolls = Math.ceil((timeoutMinutes * 60) / intervalSeconds)
const startedAt = new Date()

console.log(`dispatching ${workflow} on ref ${ref} with base_branch=${base}`)
runGh(["workflow", "run", workflow, "--ref", ref, "-f", `base_branch=${base}`])

const run = await findRun({ ref, startedAt, intervalMs, maxPolls })
console.log(`watching workflow run: ${run.url}`)
runGh(["run", "watch", String(run.databaseId), "--exit-status"], { stdio: "inherit" })

const completedRun = readGhJson([
  "run",
  "view",
  String(run.databaseId),
  "--json",
  "databaseId,status,conclusion,url",
])

if (completedRun.conclusion !== "success") {
  throw new Error(`Workflow completed with conclusion=${completedRun.conclusion}: ${completedRun.url}`)
}

const branch = `automation/update-models-${run.databaseId}-1`
const pr = await findPullRequest(branch, intervalMs)

if (!pr) {
  console.log(`workflow completed with no model changes and no PR: ${completedRun.url}`)
  process.exit(0)
}

if (pr.mergedAt) {
  console.log(`PR already merged: ${pr.url}`)
  process.exit(0)
}

console.log(`waiting for auto-merge on PR #${pr.number}: ${pr.url}`)
const merged = await waitForMerge(pr, { intervalMs, maxPolls })
console.log(`merged PR #${merged.number}: ${merged.url}`)
