import { spawnSync } from "node:child_process";
import { appendFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { publishReviewPr } from "../packages/test-artifacts/src/publish-pr.ts";
import { readTestRunDirectory } from "../packages/test-artifacts/src/scan.ts";
import { readBinding, requiredStatus } from "../../.github/scripts/required-verification-controller.mjs";
import { changedFiles, proofArtifact, selectProof } from "../../.github/scripts/pr-proof.mjs";

const producers = [
  { file: "pr-proof.yml", name: "PR change proof", events: ["pull_request"], proof: true },
  { file: "daytona-e2e.yml", name: "Product journeys", events: ["workflow_run"] },
];
const validSha = (sha) => typeof sha === "string" && /^[a-f0-9]{40}$/.test(sha);
const validId = (id) => Number.isSafeInteger(id) && id > 0;
function sameRepo(value, repo) {
  const [owner, name] = repo.split("/");
  return value?.full_name === repo && value?.owner?.login === owner && value?.name === name;
}

// All identity comes from GitHub's API, never artifact contents or the event's first PR.
export function association(run, repo, workflows) {
  const producer = workflows.find((workflow) => workflow.id === run.workflow_id);
  if (!producer || run.path !== `.github/workflows/${producer.file}` || run.name !== producer.name)
    return { reason: "unrecognized producer workflow" };
  if (!sameRepo(run.repository, repo) || !sameRepo(run.head_repository, repo))
    return { reason: "producer repository identity mismatch" };
  if (run.status !== "completed" || !["success", "failure"].includes(run.conclusion) || !producer.events.includes(run.event))
    return { reason: "producer event or completion is not eligible" };
  if (run.event === "workflow_run") return { reason: "chained producer requires authenticated upstream binding" };
  if (!Array.isArray(run.pull_requests) || run.pull_requests.length !== 1)
    return { reason: "missing or ambiguous PR association" };
  const pr = run.pull_requests[0];
  // Run PR stubs expose repo IDs, not necessarily full repository objects.
  if (!validId(run.repository.id) || run.head_repository.id !== run.repository.id || pr.base?.repo?.id !== run.repository.id || pr.head?.repo?.id !== run.head_repository.id)
    return { reason: "PR base or head repository identity mismatch" };
  if (!validId(pr.number) || !validSha(pr.head?.sha))
    return { reason: "missing PR identity" };
  if (run.head_sha !== pr.head.sha)
    return { reason: "producer SHA differs from PR association" };
  return { pr: pr.number, sha: pr.head.sha };
}

function gh(args) {
  const result = spawnSync("gh", args, { encoding: "utf8", timeout: 90_000 });
  if (result.status !== 0 || result.error) throw new Error("GitHub evidence operation failed; existing report unchanged.");
  return result.stdout;
}

export async function publishCompletedEvidence({ repo, runId, runAttempt }, dependencies = {}) {
  const api = dependencies.api ?? ((path) => JSON.parse(gh(["api", path])));
  const download = dependencies.download ?? ((id, directory, name) => gh(["run", "download", String(id), "--repo", repo, ...(name ? ["--name", name] : []), "--dir", directory]));
  const publish = dependencies.publish ?? publishReviewPr;
  const log = dependencies.log ?? console.log;
  const binding = dependencies.binding ?? readBinding;
  const required = dependencies.required ?? requiredStatus;
  const skip = (reason) => { log(`Evidence review skipped: ${reason}; existing report unchanged.`); return { skipped: reason }; };
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? "") || !/^[1-9]\d*$/.test(String(runId)))
    return skip("missing repository or run identity");
  const workflows = [];
  for (const producer of producers) {
    const workflow = await api(`repos/${repo}/actions/workflows/${producer.file}`);
    if (!validId(workflow.id) || workflow.path !== `.github/workflows/${producer.file}` || workflow.name !== producer.name)
      return skip("workflow identity mismatch");
    workflows.push({ ...producer, id: workflow.id });
  }
  const source = await api(`repos/${repo}/actions/runs/${runId}`);
  if (!validId(source.id) || String(source.id) !== String(runId)) return skip("source run identity mismatch");
  if (runAttempt && (!validId(Number(runAttempt)) || source.run_attempt !== Number(runAttempt))) return skip("source run attempt is stale");
  async function resolve(run) {
    if (run.event !== "workflow_run") return association(run, repo, workflows);
    try {
      const bound = await binding(repo, run.id);
      if (bound.producer.id !== run.id || bound.producer.run_attempt !== run.run_attempt || bound.producer.status !== "completed")
        return { reason: "chained producer attempt changed" };
      return { pr: bound.receipt.pr, sha: bound.receipt.sha };
    } catch { return { reason: "chained producer has no authenticated current-head upstream binding" }; }
  }
  const identity = await resolve(source);
  if (identity.reason) return skip(identity.reason);
  const current = await api(`repos/${repo}/pulls/${identity.pr}`);
  if (current.number !== identity.pr || current.state !== "open" || !sameRepo(current.base?.repo, repo) || !sameRepo(current.head?.repo, repo))
    return skip("current PR repository identity mismatch or closed PR");
  if (current.head.sha !== identity.sha) return skip("source PR SHA is stale");
  if (!Number.isFinite(Date.parse(current.created_at))) return skip("missing PR creation date");

  const sourceWorkflow = workflows.find(workflow => workflow.id === source.workflow_id);
  if (sourceWorkflow?.proof) {
    let files;
    try {
      files = await changedFiles(api, repo, identity.pr, current.changed_files);
    } catch {
      return skip("current PR changed-file listing is incomplete");
    }
    let selection;
    try {
      selection = selectProof(files);
    } catch {
      return skip("current PR changed-file listing is unsafe");
    }
    if (selection.specs.length === 0) return { ...skip(selection.excluded.length
      ? `PR changes only E2E specs this lane cannot run (${selection.excluded.map(entry => `${entry.spec} needs: ${entry.reason}`).join("; ")}); no proof evidence to publish`
      : "PR adds or changes no E2E spec; no proof evidence to publish"), noEvidence: true };
    if (selection.specs.length > 32) return skip("source run has no bounded PR proof selection");
    const artifacts = await api(`repos/${repo}/actions/runs/${source.id}/artifacts?per_page=100`);
    if (!Array.isArray(artifacts.artifacts) || artifacts.total_count !== artifacts.artifacts.length)
      return skip("proof artifact listing is incomplete");
    const expected = new Map(selection.specs.map(spec => [proofArtifact(spec, source.run_attempt), spec]));
    if (artifacts.artifacts.some(artifact => artifact.expired)) return skip("proof artifacts expired");
    if (artifacts.artifacts.some(artifact => artifact.name?.startsWith("pr-proof-") && !expected.has(artifact.name)))
      return skip("unexpected proof artifact is present");
    for (const name of expected.keys())
      if (artifacts.artifacts.filter(artifact => artifact.name === name).length !== 1)
        return skip("required proof artifact is missing or duplicated");
    const directory = await mkdtemp(join(tmpdir(), "openwork-pr-proof-"));
    try {
      const testRunDirs = [];
      for (const [name, spec] of expected) {
        const destination = join(directory, name);
        await download(source.id, destination, name);
        const entries = await readdir(destination, { withFileTypes: true, recursive: true });
        const records = entries.filter(entry => entry.isFile() && entry.name === "test-run.json");
        if (records.length === 0) return skip(`proof ${spec} produced no test records`);
        for (const entry of records) {
          const recordDir = entry.parentPath;
          const stored = await readTestRunDirectory(recordDir);
          if (!stored || stored.testRun.gitSha !== identity.sha || stored.testRun.specFile !== spec)
            return skip("proof record source or commit does not match the live PR selection");
          testRunDirs.push(recordDir);
        }
      }
      if ((await api(`repos/${repo}/pulls/${identity.pr}`)).head.sha !== identity.sha)
        return skip("PR identity changed before proof publication");
      const result = await publish({ pr: identity.pr, testRunDirs, gaps: [], automatic: true, replaceAutomatic: true,
        presentation: "native", title: `PR #${identity.pr} change proof` });
      log(result.posted ? result.urls.report : "PR proof review unchanged.");
      return result;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  const runs = new Map([[source.id, source]]);
  for (const workflow of workflows) {
    // Direct producers belong to the tested head. Chained producers instead run
    // on default-branch code and still require authenticated upstream binding.
    const headFilter = workflow.events.includes("workflow_run") ? "" : `&head_sha=${identity.sha}`;
    const query = `status=completed&per_page=100${headFilter}&created=${encodeURIComponent(`>=${current.created_at}`)}`;
    for (let page = 1; page <= 5; page++) {
      const result = await api(`repos/${repo}/actions/workflows/${workflow.id}/runs?${query}&page=${page}`);
      if (!Array.isArray(result.workflow_runs) || !Number.isSafeInteger(result.total_count)) return skip("invalid producer listing");
      if (result.total_count > 500) return skip("producer history exceeds 500-run bound");
      for (const candidate of result.workflow_runs) {
        const match = await resolve(candidate);
        if (match.pr === identity.pr && match.sha === identity.sha) {
          if (!validId(candidate.id)) return skip("invalid producer run ID");
          if (runs.has(candidate.id) && runs.get(candidate.id).run_attempt !== candidate.run_attempt) return skip("producer attempt changed during discovery");
          runs.set(candidate.id, candidate);
        }
      }
      if (page * 100 >= result.total_count) break;
    }
  }
  const directory = await mkdtemp(join(tmpdir(), "openwork-review-"));
  try {
    const testRunDirs = [];
    async function visit(path, depth = 0) {
      if (depth > 12) throw new Error("Evidence directory nesting exceeds the limit.");
      const entries = await readdir(path, { withFileTypes: true });
      if (entries.some((entry) => entry.isFile() && entry.name === "test-run.json")) {
        const stored = await readTestRunDirectory(path);
        if (!stored) throw new Error("Malformed recorded evidence.");
        if (stored.testRun.gitSha === identity.sha) testRunDirs.push(path);
      }
      for (const entry of entries)
        if (entry.isDirectory()) await visit(join(path, entry.name), depth + 1);
    }
    for (const id of [...runs.keys()].sort((a, b) => a - b)) {
      // Re-read each run before downloading: list entries and artifacts are not authority.
      const verified = await api(`repos/${repo}/actions/runs/${id}`);
      const match = await resolve(verified);
      if (verified.id !== id || verified.run_attempt !== runs.get(id).run_attempt || match.pr !== identity.pr || match.sha !== identity.sha) return skip("producer identity or attempt changed");
      const artifacts = await api(`repos/${repo}/actions/runs/${id}/artifacts?per_page=100`);
      if (!Array.isArray(artifacts.artifacts) || artifacts.total_count !== artifacts.artifacts.length) return skip("artifact listing incomplete");
      if (artifacts.artifacts.some((artifact) => artifact.expired)) return skip("producer artifacts expired");
      if (artifacts.artifacts.length === 0) continue;
      const destination = join(directory, String(id));
      await download(id, destination);
      await visit(destination);
    }
    if (!testRunDirs.length) return skip("no records for current PR SHA");
    const latest = await api(`repos/${repo}/pulls/${identity.pr}`);
    if (latest.number !== identity.pr || latest.state !== "open" || latest.head?.sha !== identity.sha || !sameRepo(latest.base?.repo, repo) || !sameRepo(latest.head?.repo, repo)) return skip("PR identity changed before publishing");
    // Ordinary PR evidence is a selected demonstration, not a claim that the
    // separate required-journey plan passed. Keep that plan's gap reporting only
    // for its authenticated chained producer; never change its check verdict.
    const status = source.event === "workflow_run" ? await required(repo, identity.pr, identity.sha) : undefined;
    const gaps = !status || status.state === "passed" ? [] : [`Required verification: ${status.state}. Selected evidence does not satisfy all required specs.${status.url ? ` Jobs: ${status.url}` : " No authenticated current-head required plan is available."}`];
    const result = await publish({ pr: identity.pr, testRunDirs, gaps, automatic: true, preserveCurrentReport: true });
    log(result.posted ? result.urls.report : "Evidence review unchanged: protected selection or cumulative records unavailable.");
    return result;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// A green workflow is not proof that a report was published. Always leave a
// compact, explicit outcome in Actions, including when no PR can be associated.
// Never put provider errors, downloaded evidence, or credentials in this summary.
export async function publicationJob(env, dependencies = {}) {
  const publish = dependencies.publish ?? publishCompletedEvidence;
  const receipt = async value => { if (env.EVIDENCE_RECEIPT_PATH) await writeFile(env.EVIDENCE_RECEIPT_PATH, JSON.stringify(value), { mode: 0o600 }); };
  const summary = dependencies.summary ?? (text => env.GITHUB_STEP_SUMMARY
    ? appendFile(env.GITHUB_STEP_SUMMARY, text) : Promise.resolve());
  try {
    if (!env.OPENWORK_REVIEW_URL || !env.BLOB_READ_WRITE_TOKEN) {
      await summary("## Evidence publication: unavailable\n\nConfigure repository variable `OPENWORK_REVIEW_URL` and secret `OPENWORK_REVIEW_BLOB_TOKEN`. No report was published.\n");
      return { state: "unavailable", exitCode: 1 };
    }
    const result = await publish({ repo: env.GITHUB_REPOSITORY, runId: env.REVIEW_RUN_ID, runAttempt: env.REVIEW_RUN_ATTEMPT });
    if (result.skipped) {
      await summary(`## Evidence publication: skipped\n\n${result.skipped}. No new report was published; any existing report is unchanged.\n`);
      await receipt({ state: "skipped", noEvidence: result.noEvidence === true });
      return { state: "skipped", exitCode: 0 };
    }
    if (!result.posted) {
      await summary("## Evidence publication: unchanged\n\nAn existing selected report was preserved. No new report was published.\n");
      await receipt({ state: "unchanged" });
      return { state: "unchanged", exitCode: 0 };
    }
    // Only link to this deployment's report route, never an artifact-supplied URL.
    const reportUrl = new URL(result.urls.report);
    if (reportUrl.origin !== new URL(env.OPENWORK_REVIEW_URL).origin ||
        !/^\/r\/[a-f0-9]{32}$/.test(reportUrl.pathname) || reportUrl.search || reportUrl.hash || reportUrl.username || reportUrl.password)
      throw new Error("Invalid published report URL");
    await summary(`## Evidence publication: published\n\n[Open private review report](${reportUrl.href})\n\nPublication succeeded; this is not a test verdict or human approval. The report shows the selected evidence and its limitations.\n`);
    await receipt({ state: "published", reportUrl: reportUrl.href, evidence: result.evidence });
    return { state: "published", exitCode: 0 };
  } catch {
    await summary("## Evidence publication: failed\n\nNo new report link was confirmed. Existing evidence is not replaced by raw logs or public attachments. Check publisher configuration and the source run, then replay publication. No test pass is inferred.\n");
    return { state: "failed", exitCode: 1 };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Pin all publisher gh calls (including its head checks and comment writes).
  process.env.GH_REPO = process.env.GITHUB_REPOSITORY;
  const result = await publicationJob(process.env);
  process.exitCode = result.exitCode;
}
