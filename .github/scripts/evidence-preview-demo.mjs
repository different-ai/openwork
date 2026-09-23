import { appendFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { githubApi, presentEvidence } from "./evidence-presentation.mjs";

// Temporary rollout proof requested for this PR only. This script is executed
// from an immutable, reviewed checkout, never the tested PR's working tree.
const repo = process.env.GITHUB_REPOSITORY;
const sha = process.env.PREVIEW_SHA;
if (repo !== "different-ai/openwork" || !/^[a-f0-9]{40}$/.test(sha ?? "")) throw new Error("Unsupported preview identity");
const workflow = githubApi(`repos/${repo}/actions/workflows/pr-proof.yml`);
const deadline = Date.now() + 25 * 60_000;
let observed;
while (Date.now() < deadline) {
  const pr = githubApi(`repos/${repo}/pulls/5275`);
  if (pr.state !== "open" || pr.head.sha !== sha || pr.head.ref !== "codex/native-evidence"
    || pr.head.repo?.full_name !== repo || pr.head.repo.id !== pr.base.repo.id) throw new Error("Preview PR changed or is not eligible");
  const result = githubApi(`repos/${repo}/actions/workflows/${workflow.id}/runs?event=pull_request&head_sha=${sha}&per_page=100`);
  if (!Array.isArray(result.workflow_runs) || result.total_count > 100) throw new Error("Incomplete proof history");
  const run = result.workflow_runs.filter(run => run.pull_requests?.some(pr => pr.number === 5275)).sort((a, b) => b.id - a.id)[0];
  if (run) {
    const identity = { repo, runId: run.id, runAttempt: run.run_attempt };
    const state = `${run.id}:${run.run_attempt}:${run.status}`;
    if (state !== observed) {
      await presentEvidence({ ...identity, phase: "progress" });
      console.log(`Proof run ${run.id}, attempt ${run.run_attempt}: ${run.status}`);
      observed = state;
    }
    if (run.status === "completed") {
      await appendFile(process.env.GITHUB_ENV, `REVIEW_RUN_ID=${run.id}\nREVIEW_RUN_ATTEMPT=${run.run_attempt}\n`);
      break;
    }
  }
  await delay(10_000);
}
if (Date.now() >= deadline) throw new Error("Timed out waiting for PR proof");
