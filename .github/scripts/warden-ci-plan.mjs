// CI suggestions and repair plans: read-only GitHub evidence, no execution of logs or proposed code.
import { spawnSync, execFileSync } from "node:child_process";
import { diagnoseCiFailures } from "./warden-ci.mjs";
import { generateFixes } from "./warden-generate.mjs";
import { diffPaths } from "./warden-fixer.mjs";

export const CI_REPAIR_LIMITS = { runs: 3, attempts: 3, history: 60 };
const SHA = /^[a-f0-9]{40}$/;
const positive = (n) => Number.isSafeInteger(n) && n > 0;
const failed = (run) => ["failure", "timed_out", "startup_failure"].includes(run.conclusion);
export function ciFixBranch(runId, sha) {
  if (!positive(runId) || !SHA.test(sha ?? "")) throw new Error("Invalid CI repair identity");
  return `warden-fix/ci-${runId}-${sha.slice(0, 12)}`;
}
export function ciRepairState(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.filter((item) => {
    const key = `${item?.id}:${item?.runAttempt}`;
    if (!positive(item?.id) || !positive(item.runAttempt) || !SHA.test(item.sha ?? "") || !Number.isSafeInteger(item.attempts) || item.attempts < 0 || item.attempts > CI_REPAIR_LIMITS.attempts || typeof item.done !== "boolean" || seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(-CI_REPAIR_LIMITS.history).map(({ id, runAttempt, sha, attempts, done }) => ({ id, runAttempt, sha, attempts, done }));
}
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 500_000, stdio: ["ignore", "pipe", "pipe"] }).trim();

/** Both fresh and late failures are eligible; prior attempts survive the review cursor. */
export async function planCiRepairs({ cwd, repo, head, sources, previous, budget, model, apiKey, api, loadLog, makePlan, diagnose = diagnoseCiFailures, generate = generateFixes }) {
  const history = ciRepairState(previous);
  const candidates = new Map();
  for (const source of sources) for (const run of source.ci.failed) {
    if (positive(run.id) && SHA.test(source.sha)) candidates.set(`${run.id}:${run.runAttempt || 1}`, { id: run.id, runAttempt: run.runAttempt || 1, sha: source.sha, number: source.number ?? null });
  }
  // Retry older failures even if the merge-review cursor moved on. Metadata only.
  for (const item of history) if (!item.done && item.attempts < CI_REPAIR_LIMITS.attempts) {
    const key = `${item.id}:${item.runAttempt}`;
    if (!candidates.has(key)) candidates.set(key, { ...item, number: null });
  }
  const plans = [], reports = [];
  const diagnosisBudget = { remaining: CI_REPAIR_LIMITS.runs };
  let queueOverflow = 0, inspected = 0;
  for (const source of candidates.values()) {
    let record = history.find((entry) => entry.id === source.id && entry.runAttempt === source.runAttempt);
    if (record?.done || record?.attempts >= CI_REPAIR_LIMITS.attempts) continue;
    if (!record) {
      if (history.length === CI_REPAIR_LIMITS.history) {
        const completed = history.findIndex((entry) => entry.done);
        if (completed < 0) { queueOverflow++; continue; }
        history.splice(completed, 1);
      }
      record = { id: source.id, runAttempt: source.runAttempt, sha: source.sha, attempts: 0, done: false };
      history.push(record);
    }
    if (!diagnosisBudget.remaining || inspected >= CI_REPAIR_LIMITS.runs) continue;
    inspected++;
    let charged = false;
    const report = { id: source.id, url: `https://github.com/${repo}/actions/runs/${source.id}`, outcomes: [], suggestions: [], generation: [], planned: false, disposition: "pending" };
    reports.push(report);
    try {
      const run = api(`repos/${repo}/actions/runs/${source.id}`);
      if (run.id !== source.id || run.head_sha !== source.sha || run.head_branch !== "dev" || !["push", "schedule", "workflow_dispatch"].includes(run.event) || !positive(run.run_attempt)) throw new Error("CI identity mismatch");
      if (run.run_attempt !== source.runAttempt) { record.done = true; report.disposition = "new run attempt; reconsider current result next sweep"; continue; }
      if (run.status !== "completed") { report.disposition = "CI still running"; continue; }
      if (!failed(run)) { record.done = true; report.disposition = "CI recovered; no fix needed"; continue; }
      if (spawnSync("git", ["merge-base", "--is-ancestor", run.head_sha, head], { cwd }).status !== 0) throw new Error("CI source not on reviewed dev history");
      const branch = ciFixBranch(run.id, source.sha);
      const existing = api(`repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${repo.split("/")[0]}:${branch}`)}&per_page=1`);
      if (existing.length) { record.done = true; report.disposition = "existing CI repair PR"; report.prUrl = existing[0].html_url; continue; }
      const files = git(cwd, ["diff-tree", "--no-commit-id", "--name-only", "-r", "--no-renames", source.sha]).split("\n").filter(Boolean);
      record.attempts++; charged = true;
      const diagnosis = await diagnose({ cwd, files, runs: [{ ...run, headSha: run.head_sha, runAttempt: run.run_attempt }], budget: diagnosisBudget, model, apiKey,
        loadJobs: () => (api(`repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`).jobs ?? []).filter((job) => job.run_id === run.id),
        loadLog: (job) => loadLog(job, run),
      });
      report.outcomes = diagnosis.outcomes;
      report.suggestions = diagnosis.suggestions;
      // One small root-cause fix per failed run; other recommendations remain in Slack.
      const candidate = diagnosis.findings.slice(0, 1);
      if (!candidate.length) { report.disposition = "suggestions only; no validated source fix"; continue; }
      const generated = await generate({ cwd, findings: candidate, files: diagnosis.files, budget, model, apiKey });
      report.generation = generated.outcomes;
      const plan = makePlan({ sha: source.sha, number: source.number, complete: true, findings: generated.findings }, diagnosis.files);
      if (!plan) { report.disposition = "no verified patch; see diagnosis and generation outcomes"; continue; }
      plan.branch = branch;
      plan.title = `fix(ci): address failed workflow run ${run.id}`;
      plan.ci = { id: run.id, runAttempt: run.run_attempt, files: [...new Set(plan.patches.flatMap((patch) => diffPaths(patch)))] };
      plan.body += `\nCI evidence: https://github.com/${repo}/actions/runs/${run.id}\n\nBased on failed-job logs and current source; not reproduced locally. Model review and patch applicability are not a passing test run. Normal CI must validate this draft.\n`;
      plans.push(plan); report.planned = true; report.disposition = "draft CI repair prepared; writer reports actual URL";
    } catch {
      if (!charged) record.attempts++;
      report.disposition = "CI evidence lookup or repair planning failed; operator action may be required";
    } finally {
      if (record.attempts >= CI_REPAIR_LIMITS.attempts) report.retry = "CI investigation attempt cap reached; manual follow-up required";
    }
  }
  return { plans, reports, state: ciRepairState(history), queueOverflow };
}
