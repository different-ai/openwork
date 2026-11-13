#!/usr/bin/env node
// Release gate: refuse a commit unless the quick check (quick-check.yml)
// passed on it. The alpha build and the release run this before publishing.
// A run still in progress is waited for; a missing, failed or cancelled run,
// or one that does not finish in time, blocks.
import { pathToFileURL } from "node:url";

export const WORKFLOW = "quick-check.yml";
const SHA = /^[a-f0-9]{40}$/;

/** The newest quick-check run for the commit decides; older attempts are superseded. */
export function quickCheckState(runs, sha) {
  const matching = (Array.isArray(runs) ? runs : []).filter((run) => run && run.head_sha === sha);
  if (matching.length === 0) return { state: "missing" };
  const latest = matching.reduce((a, b) => (Date.parse(b.created_at) > Date.parse(a.created_at) || (b.created_at === a.created_at && b.id > a.id) ? b : a));
  if (latest.status !== "completed") return { state: "pending", run: latest };
  return { state: latest.conclusion === "success" ? "passed" : "failed", run: latest };
}

/** Poll until the quick check for `sha` passes, fails, or the wait runs out. */
export async function requireQuickCheck({ sha, listRuns, waitMs = 15 * 60_000, intervalMs = 15_000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now, log = console.log }) {
  if (!SHA.test(String(sha))) throw new Error(`Not a full commit SHA: ${sha}`);
  const deadline = now() + waitMs;
  for (;;) {
    const result = quickCheckState(await listRuns(sha), sha);
    if (result.state === "passed") {
      log(`Quick check passed on ${sha}: ${result.run.html_url}`);
      return result;
    }
    if (result.state === "failed") {
      throw new Error(`Quick check ${result.run.conclusion} on ${sha}: ${result.run.html_url}. Fix dev (or rerun the check) before releasing this commit.`);
    }
    if (now() >= deadline) {
      throw new Error(result.state === "missing"
        ? `No quick check ran on ${sha}. Releases only ship commits the quick check passed on.`
        : `Quick check on ${sha} did not finish in time: ${result.run.html_url}`);
    }
    log(result.state === "missing" ? `Waiting for the quick check to start on ${sha}…` : `Waiting for the quick check on ${sha}: ${result.run.html_url}`);
    await sleep(intervalMs);
  }
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const sha = argument("--sha");
  const repo = argument("--repo") ?? process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  const waitMinutes = Number(argument("--wait-minutes") ?? 15);
  if (!repo || !token || !Number.isFinite(waitMinutes) || waitMinutes < 0) {
    console.error("Usage: GH_TOKEN=… require-quick-check.mjs --sha <sha> [--repo owner/name] [--wait-minutes 15]");
    process.exit(2);
  }
  const listRuns = async (head) => {
    const response = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW}/runs?head_sha=${head}&per_page=100`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "openwork-release-gate" },
    });
    if (!response.ok) throw new Error(`Listing quick check runs failed: HTTP ${response.status}`);
    return (await response.json()).workflow_runs;
  };
  try {
    await requireQuickCheck({ sha, listRuns, waitMs: waitMinutes * 60_000 });
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}
