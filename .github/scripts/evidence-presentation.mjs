import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const checkName = "Evidence preview";
const validId = value => Number.isSafeInteger(value) && value > 0;
export function githubApi(path, method = "GET", body) {
  const result = spawnSync("gh", ["api", path, "--method", method, ...(body ? ["--input", "-"] : [])], {
    encoding: "utf8", input: body ? JSON.stringify(body) : undefined, timeout: 30_000,
  });
  if (result.status !== 0) throw new Error("GitHub evidence presentation failed");
  return JSON.parse(result.stdout);
}

/** The producer and live PR are authority. Artifact text never controls GitHub writes. */
export async function presentEvidence({ repo, runId, runAttempt, phase, receipt, reviewUrl }, api = githubApi) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? "") || !/^[1-9]\d*$/.test(String(runId))) throw new Error("Invalid evidence identity");
  const root = `repos/${repo}`;
  const source = await api(`${root}/actions/runs/${runId}`);
  const workflow = await api(`${root}/actions/workflows/pr-proof.yml`);
  if (source.id !== Number(runId) || source.workflow_id !== workflow.id || workflow.path !== ".github/workflows/pr-proof.yml"
    || source.path !== workflow.path || source.name !== "PR change proof" || source.event !== "pull_request"
    || source.repository?.full_name !== repo || source.head_repository?.full_name !== repo
    || !validId(source.repository?.id) || source.head_repository.id !== source.repository.id
    || !validId(source.run_attempt) || (runAttempt && source.run_attempt !== Number(runAttempt))
    || source.pull_requests?.length !== 1) return { skipped: true };
  const stub = source.pull_requests[0];
  const sha = stub.head?.sha;
  if (!validId(stub.number) || !/^[a-f0-9]{40}$/.test(sha ?? "") || source.head_sha !== sha
    || stub.head.repo?.id !== source.repository.id || stub.base?.repo?.id !== source.repository.id) return { skipped: true };
  const externalId = `evidence:${source.id}:${source.run_attempt}`;
  const logUrl = `https://github.com/${repo}/actions/runs/${source.id}/attempts/${source.run_attempt}`;
  const environment = `Evidence / PR ${stub.number}`;
  async function current() {
    const pr = await api(`${root}/pulls/${stub.number}`);
    const fresh = await api(`${root}/actions/runs/${source.id}`);
    if (pr.state !== "open" || pr.head?.sha !== sha || pr.head?.repo?.id !== source.repository.id || pr.base?.repo?.id !== source.repository.id
      || fresh.run_attempt !== source.run_attempt) return false;
    const latest = await api(`${root}/actions/workflows/${workflow.id}/runs?event=pull_request&head_sha=${sha}&per_page=100`);
    if (!Array.isArray(latest.workflow_runs) || latest.total_count > 100) throw new Error("Incomplete evidence producer history");
    return !latest.workflow_runs.some(run => run.id > source.id && run.pull_requests?.some(pr => pr.number === stub.number));
  }
  if (!await current()) return { skipped: true };
  const deployments = await api(`${root}/deployments?environment=${encodeURIComponent(environment)}&per_page=100`);
  if (!Array.isArray(deployments)) throw new Error("Invalid deployment history");
  for (const deployment of deployments) {
    const previous = deployment.payload;
    if (deployment.creator?.login !== "github-actions[bot]" || previous?.kind !== "openwork-evidence-v1"
      || previous.pr !== stub.number || !validId(previous.runId) || !validId(previous.runAttempt)
      || !(previous.runId < source.id || (previous.runId === source.id && previous.runAttempt < source.run_attempt))) continue;
    if (!await current()) return { skipped: true };
    await api(`${root}/deployments/${deployment.id}/statuses`, "POST", { state: "inactive", auto_inactive: false,
      description: "Superseded; evidence is being prepared for a newer run" });
  }
  const checks = await api(`${root}/commits/${sha}/check-runs?check_name=${encodeURIComponent(checkName)}&filter=all&per_page=100`);
  if (!Array.isArray(checks.check_runs) || checks.total_count > 100) throw new Error("Incomplete evidence checks");
  let check = checks.check_runs.find(item => item.external_id === externalId && item.app?.slug === "github-actions");
  // Delayed requested/in_progress events cannot downgrade a completed check.
  if (phase !== "complete" && check?.status === "completed") return { unchanged: true };
  let status = "in_progress", conclusion, title = source.status === "completed" ? "Publishing evidence" : "Recording evidence";
  let detailsUrl = logUrl;
  let summary = `Commit [\`${sha}\`](https://github.com/${repo}/commit/${sha}) · [Run ${source.id}, attempt ${source.run_attempt}](${logUrl})\n\nEvidence is being prepared for this commit. Earlier reports do not verify this revision.`;
  let reportUrl;
  if (phase === "complete") {
    if (source.status !== "completed") throw new Error("Producer is not complete");
    status = "completed";
    conclusion = "failure";
    title = "Evidence publication failed";
    summary += "\n\nNo new report was confirmed. Previous evidence does not count as success for this commit.";
    if (receipt?.state === "published") {
      const parsed = new URL(receipt.reportUrl);
      const evidence = receipt.evidence;
      if (parsed.origin !== new URL(reviewUrl).origin || parsed.protocol !== "https:" || parsed.username || parsed.password
        || !/^\/r\/[a-f0-9]{32}$/.test(parsed.pathname) || parsed.search || parsed.hash
        || evidence?.gitSha !== sha || !["Passed", "Failed", "Incomplete", "Reference"].includes(evidence.verdict)
        || ![evidence.tests, evidence.passedTests, evidence.assertions, evidence.passedAssertions].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error("Invalid evidence publication receipt");
      reportUrl = parsed.href;
      detailsUrl = reportUrl;
      conclusion = evidence.verdict === "Passed" && source.conclusion === "success" ? "success" : "failure";
      title = `Published · ${sha.slice(0, 7)} · ${source.conclusion === "success" ? evidence.verdict : "Source run failed"}`;
      summary = `Commit [\`${sha}\`](https://github.com/${repo}/commit/${sha}) · Published ${new Date().toISOString()}\n\n${evidence.passedTests}/${evidence.tests} selected tests · ${evidence.passedAssertions}/${evidence.assertions} assertions passed.\n\n[Open evidence and launch your own sandbox](${reportUrl}) · [Source run](${logUrl})\n\nSelected evidence only; this is not human approval or a claim that all required verification passed.`;
    } else if (receipt?.state === "skipped" && receipt.noEvidence === true && source.conclusion === "success") {
      conclusion = "neutral";
      title = "No change-specific evidence selected";
      summary = `Commit \`${sha}\` has no added or changed E2E specs. No report was published and no test pass is inferred. [Source run](${logUrl})`;
    } else if (["cancelled", "timed_out"].includes(source.conclusion)) {
      conclusion = source.conclusion;
      title = "Evidence run interrupted";
    } else if (receipt?.state === "unchanged") {
      conclusion = "neutral";
      title = "Existing manual evidence selection preserved";
    }
  } else if (source.status === "queued" || source.status === "requested") {
    status = "queued";
    title = "Evidence queued";
  }
  const output = { title, summary };
  if (!await current()) return { skipped: true };
  if (!check) check = await api(`${root}/check-runs`, "POST", { name: checkName, head_sha: sha, external_id: externalId, status, ...(conclusion ? { conclusion, completed_at: new Date().toISOString() } : {}), details_url: detailsUrl, output });
  else await api(`${root}/check-runs/${check.id}`, "PATCH", { status, ...(conclusion ? { conclusion, completed_at: new Date().toISOString() } : {}), details_url: detailsUrl, output });
  if (!reportUrl || !await current()) return { checkId: check.id };
  // Each publication is immutable and tied to the tested SHA. Do not let a
  // late deployment automatically deactivate a newer commit's preview.
  const deployment = await api(`${root}/deployments`, "POST", {
    ref: sha, auto_merge: false, required_contexts: [], environment,
    transient_environment: true, production_environment: false,
    description: `Evidence for ${sha.slice(0, 7)} (run ${source.id}, attempt ${source.run_attempt})`,
    payload: { kind: "openwork-evidence-v1", runId: source.id, runAttempt: source.run_attempt, sha, pr: stub.number },
  });
  if (!validId(deployment.id)) throw new Error("Invalid evidence deployment");
  const active = await current();
  await api(`${root}/deployments/${deployment.id}/statuses`, "POST", {
    state: active ? "success" : "inactive", environment_url: reportUrl, log_url: logUrl,
    auto_inactive: false, description: active ? "Report published; see Evidence preview for the test verdict" : "Superseded by a newer revision or run",
  });
  // A push during the status write can only retire this deployment, never another run.
  if (active && !await current()) await api(`${root}/deployments/${deployment.id}/statuses`, "POST", { state: "inactive", auto_inactive: false });
  return { checkId: check.id, deploymentId: deployment.id };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let receipt;
  if (process.argv[2] === "complete" && process.env.EVIDENCE_RECEIPT_PATH) {
    try { receipt = JSON.parse(await readFile(process.env.EVIDENCE_RECEIPT_PATH, "utf8")); } catch { /* Missing publication is a failure, never a pass. */ }
  }
  const input = { repo: process.env.GITHUB_REPOSITORY, runId: process.env.REVIEW_RUN_ID,
    runAttempt: process.env.REVIEW_RUN_ATTEMPT, phase: process.argv[2], receipt, reviewUrl: process.env.OPENWORK_REVIEW_URL };
  try { await presentEvidence(input); }
  catch {
    // A malformed receipt or failed deployment must not leave a green result.
    if (input.phase === "complete" && receipt) await presentEvidence({ ...input, receipt: undefined }).catch(() => {});
    console.error("Native evidence presentation failed. No fresh passing evidence is confirmed.");
    process.exitCode = 1;
  }
}
