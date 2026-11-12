import { spawnSync } from "node:child_process";
import { appendFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { publishReviewPr } from "../packages/test-artifacts/src/publish-pr.ts";
import { readTestRunDirectory } from "../packages/test-artifacts/src/scan.ts";
import { designDigest } from "../packages/test-artifacts/src/review.ts";
import { changedFiles, proofArtifactsForAttempt, selectProof } from "../../.github/scripts/pr-proof.mjs";
import { association, authorEvidenceNotice, producers, sameRepo, validId } from "../../.github/scripts/evidence-association.mjs";

function gh(args) {
  const result = spawnSync("gh", args, { encoding: "utf8", timeout: 90_000, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0 || result.error) throw new Error("GitHub evidence operation failed; existing report unchanged.");
  return result.stdout;
}

export async function publishCompletedEvidence({ repo, runId, runAttempt }, dependencies = {}) {
  const api = dependencies.api ?? ((path) => JSON.parse(gh(["api", path])));
  const download = dependencies.download ?? ((id, directory, name) => gh(["run", "download", String(id), "--repo", repo, ...(name ? ["--name", name] : []), "--dir", directory]));
  const publish = dependencies.publish ?? publishReviewPr;
  const log = dependencies.log ?? console.log;
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
  const identity = await association(source, repo, workflows, api);
  if (identity.reason) return skip(identity.reason);
  const current = await api(`repos/${repo}/pulls/${identity.pr}`);
  if (current.number !== identity.pr || current.state !== "open" || !sameRepo(current.base?.repo, repo) || !sameRepo(current.head?.repo, repo))
    return skip("current PR repository identity mismatch or closed PR");
  if (current.head.sha !== identity.sha) return skip("source PR SHA is stale");

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
  if (selection.specs.length === 0) return skip("PR adds or changes no E2E spec; no proof evidence to publish");
  if (selection.specs.length > 32) return skip("source run has no bounded PR proof selection");
  const artifacts = await api(`repos/${repo}/actions/runs/${source.id}/artifacts?per_page=100`);
  if (!Array.isArray(artifacts.artifacts) || artifacts.total_count !== artifacts.artifacts.length)
    return skip("proof artifact listing is incomplete");
  if (artifacts.artifacts.some(artifact => artifact.expired)) return skip("proof artifacts expired");
  // After "Re-run failed jobs", specs that passed keep their earlier attempt's records.
  const chosen = proofArtifactsForAttempt(artifacts.artifacts, selection.specs, source.run_attempt);
  if (chosen.reason) return skip(chosen.reason);
  const expected = chosen.expected;
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
      presentation: "native", title: `PR #${identity.pr} change proof`, notice: authorEvidenceNotice(source) });
    log(result.posted ? result.urls.report : "PR proof review unchanged.");
    // Advisory design notes for the Evidence preview check; never a reason to fail publication.
    const design = await designDigest(testRunDirs).catch(() => undefined);
    return design ? { ...result, design } : result;
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
      await receipt({ state: "skipped", noEvidence: result.skipped === "PR adds or changes no E2E spec; no proof evidence to publish" });
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
    await receipt({ state: "published", reportUrl: reportUrl.href, evidence: result.evidence, ...(result.design ? { design: result.design } : {}) });
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
