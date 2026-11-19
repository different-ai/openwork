import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Default setup keys, plus the advanced-setup workflow that replaced it.
const advancedSetupAnalysisKey = ".github/workflows/codeql.yml:analyze";
const defaultSetupAnalysisKeys = new Set([
  "dynamic/github-code-scanning/codeql:upload",
  "dynamic/github-code-scanning/codeql:analyze",
  advancedSetupAnalysisKey,
]);
const codeqlWorkflowPaths = new Set(["dynamic/github-code-scanning/codeql", ".github/workflows/codeql.yml"]);

function isCodeqlBaselineKey(key) {
  return typeof key === "string" && (key.startsWith("dynamic/github-code-scanning/codeql:") || key === advancedSetupAnalysisKey);
}

function successfulDefaultSetupAnalysis(analysis) {
  return analysis.tool?.name === "CodeQL" && !analysis.error &&
    defaultSetupAnalysisKeys.has(analysis.analysis_key) &&
    typeof analysis.category === "string" && /^\/language:[a-z][a-z-]*$/.test(analysis.category);
}

export function defaultSetupBaseline(analyses) {
  const latest = analyses.find((analysis) => analysis.tool?.name === "CodeQL" && !analysis.error &&
    isCodeqlBaselineKey(analysis.analysis_key));
  if (!latest) throw new Error("No successful default-setup baseline found; inspect CodeQL on the default branch.");
  if (!successfulDefaultSetupAnalysis(latest) || typeof latest.commit_sha !== "string" || !latest.commit_sha) {
    throw new Error("Unsupported CodeQL default-setup baseline; inspect the latest uploaded analysis.");
  }
  const languages = [...new Set(analyses.filter((analysis) =>
    successfulDefaultSetupAnalysis(analysis) && analysis.commit_sha === latest.commit_sha &&
    analysis.analysis_key === latest.analysis_key
  ).map((analysis) => analysis.category.slice("/language:".length)))];
  return { commitSha: latest.commit_sha, analysisKey: latest.analysis_key, languages };
}

export function missingLanguages(languages, analyses, shas) {
  const canonical = (language) => ["javascript", "typescript"].includes(language) ? "javascript-typescript" : language;
  const expected = [...new Set(languages.map(canonical))];
  const uploaded = new Set(analyses.filter((analysis) =>
    shas.includes(analysis.commit_sha) && successfulDefaultSetupAnalysis(analysis)
  ).map((analysis) => analysis.category));
  return expected.filter((language) => !uploaded.has(`/language:${language}`));
}

function api(path, paginate = false) {
  const args = ["api", path];
  if (paginate) args.push("--paginate", "--slurp");
  const value = JSON.parse(execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  return paginate ? value.flat() : value;
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY ?? "different-ai/openwork";
  const prefix = `repos/${repo}`;
  // Reading default-setup settings needs Administration permission, unavailable
  // to GITHUB_TOKEN. Use the successful baseline uploads that PRs must match.
  const repository = api(prefix);
  const baseline = api(`${prefix}/code-scanning/analyses?ref=${encodeURIComponent(`refs/heads/${repository.default_branch}`)}&tool_name=CodeQL&per_page=100`);
  const { languages } = defaultSetupBaseline(baseline);
  const number = process.argv[2];
  if (number && !/^\d+$/.test(number)) throw new Error("Usage: node scripts/ci/check-codeql-results.mjs [PR number]");
  const pulls = number ? [api(`${prefix}/pulls/${number}`)] : api(`${prefix}/pulls?state=open&per_page=100`, true);
  const lines = ["# CodeQL result coverage", "", `Default-branch baseline languages: ${languages.join(", ")}`, ""];
  let failures = 0;
  for (const pull of pulls) {
    if (pull.state !== "open" || pull.head.repo?.full_name !== repo || pull.base.ref !== repository.default_branch) continue;
    const refs = [`refs/pull/${pull.number}/head`, `refs/pull/${pull.number}/merge`];
    const analyses = refs.flatMap((ref) => api(`${prefix}/code-scanning/analyses?ref=${encodeURIComponent(ref)}&tool_name=CodeQL&per_page=100`, true));
    const missing = missingLanguages(languages, analyses, [pull.head.sha, pull.merge_commit_sha].filter(Boolean));
    // Only query workflow state when coverage is incomplete.
    const runs = missing.length ? api(`${prefix}/actions/runs?head_sha=${pull.head.sha}&per_page=100`, true) : [];
    const active = runs.flatMap((page) => page.workflow_runs).some((run) =>
      codeqlWorkflowPaths.has(run.path?.split("@")[0]) && run.status !== "completed"
    );
    if (!missing.length) {
      lines.push(`- #${pull.number} (${pull.head.sha.slice(0, 7)}): all language results uploaded.`);
    } else if (active) {
      lines.push(`- #${pull.number}: scan in progress; pending ${missing.join(", ")}.`);
    } else {
      failures++;
      lines.push(`- #${pull.number} (${pull.head.sha.slice(0, 7)}): **missing ${missing.join(", ")}**. See docs/codeql-results.md for recovery.`);
    }
  }
  lines.push("", "Coverage only: existing security alerts and merge requirements still apply.");
  const report = `${lines.join("\n")}\n`;
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
  process.exitCode = failures ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
