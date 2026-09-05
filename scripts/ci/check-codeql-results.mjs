import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function missingLanguages(languages, analyses, shas) {
  const canonical = (language) => ["javascript", "typescript"].includes(language) ? "javascript-typescript" : language;
  const expected = [...new Set(languages.map(canonical))];
  const uploaded = new Set(analyses.filter((analysis) =>
    shas.includes(analysis.commit_sha) && analysis.tool.name === "CodeQL" && !analysis.error
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
  const latest = baseline.find((analysis) => !analysis.error && analysis.analysis_key === "dynamic/github-code-scanning/codeql:upload");
  if (!latest) throw new Error("No successful default-setup baseline found; inspect CodeQL on the default branch.");
  const languages = [...new Set(baseline.filter((analysis) =>
    analysis.commit_sha === latest.commit_sha && !analysis.error &&
    analysis.analysis_key === "dynamic/github-code-scanning/codeql:upload"
  ).map((analysis) => analysis.category.replace(/^\/language:/, "")))];
  const number = process.argv[2];
  if (number && !/^\d+$/.test(number)) throw new Error("Usage: node scripts/ci/check-codeql-results.mjs [PR number]");
  const pulls = number ? [api(`${prefix}/pulls/${number}`)] : api(`${prefix}/pulls?state=open&per_page=100`, true);
  const lines = ["# CodeQL result coverage", "", `Default-branch baseline languages: ${languages.join(", ")}`, ""];
  let failures = 0;
  for (const pull of pulls) {
    if (pull.state !== "open" || pull.head.repo?.full_name !== repo) continue;
    const refs = [`refs/pull/${pull.number}/head`, `refs/pull/${pull.number}/merge`];
    const analyses = refs.flatMap((ref) => api(`${prefix}/code-scanning/analyses?ref=${encodeURIComponent(ref)}&tool_name=CodeQL&per_page=100`, true));
    const missing = missingLanguages(languages, analyses, [pull.head.sha, pull.merge_commit_sha].filter(Boolean));
    // Only query workflow state when coverage is incomplete.
    const runs = missing.length ? api(`${prefix}/actions/runs?head_sha=${pull.head.sha}&per_page=100`, true) : [];
    const active = runs.flatMap((page) => page.workflow_runs).some((run) =>
      run.path === "dynamic/github-code-scanning/codeql" && run.status !== "completed"
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
