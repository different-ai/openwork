#!/usr/bin/env node
// Run only from a trusted immutable checkout. PR commits are Git data, never code.
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyCleanRevert } from "./verify-clean-revert.mjs";

const sha = /^[0-9a-f]{40}$/;
const guarded = /^(?:\.github\/|scripts\/ci\/|\.warden\/|warden\.toml$|\.agents\/skills\/|\.claude\/skills\/|\.opencode\/|AGENTS\.md$)/;
export const exemptionStep = "Record verified revert exemption";

export function eligiblePull(pr, repository) {
  return !!pr && pr.state === "open" && pr.draft === false && pr.merged === false
    && pr.merged_at === null && Number.isSafeInteger(pr.number) && pr.number > 0
    && pr.base?.ref === "dev" && pr.base?.repo?.full_name === repository
    && pr.head?.repo?.full_name === repository
    && sha.test(pr.base?.sha ?? "") && sha.test(pr.head?.sha ?? "")
    && (pr.title?.startsWith('Revert "') || /This reverts commit [0-9a-f]{40}/i.test(pr.body ?? ""));
}

export function samePull(expected, current, repository) {
  return eligiblePull(expected, repository) && eligiblePull(current, repository)
    && expected.number === current.number && expected.base.sha === current.base.sha
    && expected.head.sha === current.head.sha;
}

export function unguardedFiles(files) {
  return files.length > 0 && files.every((file) => file && !guarded.test(file));
}

// The marker is routing information, not proof. Clearance must independently
// verify the current PR and exact inverse after this producer binding check.
export function exemptionProducer(run, jobs, repository) {
  return run?.name === "Warden" && run.path === ".github/workflows/warden.yml"
    && run.event === "pull_request" && run.status === "completed" && run.conclusion === "success"
    && run.repository?.full_name === repository && run.head_repository?.full_name === repository
    && sha.test(run.head_sha ?? "") && Number.isSafeInteger(run.id) && run.id > 0
    && Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0
    && jobs.some((job) => job.name === "warden" && job.run_id === run.id
      && job.head_sha === run.head_sha && job.conclusion === "success"
      && job.steps?.some((step) => step.name === exemptionStep && step.conclusion === "success")
      && job.steps?.some((step) => step.name === "Analyze" && step.conclusion === "skipped"));
}

function command(binary, args) {
  const result = spawnSync(binary, args, { encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${binary} boundary failed`);
  return result.stdout;
}

export function preflight({ event, repository, clearance = false, api, git, verify }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Invalid repository");
  let expected = event.pull_request;
  if (clearance) {
    const producer = event.workflow_run;
    if (!Number.isSafeInteger(producer?.id) || !Number.isSafeInteger(producer?.run_attempt)) return false;
    const run = api(`repos/${repository}/actions/runs/${producer.id}`);
    const pages = api(`repos/${repository}/actions/runs/${producer.id}/attempts/${producer.run_attempt}/jobs?per_page=100`, true);
    if (run.id !== producer.id || run.run_attempt !== producer.run_attempt || run.head_sha !== producer.head_sha
      || !exemptionProducer(run, pages.flatMap((page) => page.jobs ?? []), repository)) return false;
    // Same-repository PR runs have one bound PR. Missing/ambiguous binding fails closed.
    if (run.pull_requests?.length !== 1) return false;
    const binding = run.pull_requests[0];
    if (!Number.isSafeInteger(binding.number) || binding.head?.sha !== run.head_sha) return false;
    expected = api(`repos/${repository}/pulls/${binding.number}`);
    if (expected.head?.sha !== binding.head.sha || expected.base?.sha !== binding.base?.sha) return false;
  }
  if (!eligiblePull(expected, repository)) return false;
  const endpoint = `repos/${repository}/pulls/${expected.number}`;
  const current = api(endpoint);
  if (!samePull(expected, current, repository)) return false;
  if (api(`repos/${repository}/git/ref/heads/dev`).object?.sha !== current.base.sha) return false;
  git(["fetch", "--no-tags", "origin", current.base.sha, current.head.sha]);
  const files = git(["diff", "--name-only", "--no-renames", "-z", current.base.sha, current.head.sha]).split("\0").filter(Boolean);
  if (!unguardedFiles(files)) return false;
  const candidates = [...(current.body ?? "").matchAll(/This reverts commit ([0-9a-f]{40})/gi)].map((match) => match[1].toLowerCase());
  if (new Set(candidates).size > 1) return false;
  const reverted = verify({ base: current.base.sha, head: current.head.sha, reverted: candidates[0] });
  if (!sha.test(reverted ?? "")) return false;
  // Do not exempt a stale event after verification or a concurrent base update.
  if (!samePull(current, api(endpoint), repository)
    || api(`repos/${repository}/git/ref/heads/dev`).object?.sha !== current.base.sha) return false;
  return { base: current.base.sha, head: current.head.sha, reverted };
}

function main() {
  let result = false;
  try {
    result = preflight({
      event: JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")),
      repository: process.env.GITHUB_REPOSITORY,
      clearance: process.argv.includes("--clearance"),
      api: (endpoint, paginate = false) => JSON.parse(command("gh", ["api", ...(paginate ? ["--paginate", "--slurp"] : []), endpoint])),
      git: (args) => command("git", args),
      verify: verifyCleanRevert,
    });
  } catch {
    // Unavailable/malformed helpers, Git/API failures, conflicts: normal checks.
    console.log("Revert preflight unavailable or ineligible; normal checks required.");
  }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `verified=${!!result}\n`);
  if (result && process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `## Verified clean-revert exemption\n\nHead \`${result.head}\`, base \`${result.base}\`, reverted \`${result.reverted}\`.\n\nNot reviewed by Warden; exact inverse verified. No Warden approval is granted.\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
