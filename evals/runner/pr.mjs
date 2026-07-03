/**
 * fraimz on the PR: render the frame-by-frame proof as a PR comment and post
 * it with `gh`. The comment is the reviewable demo (verdict + per-frame claim,
 * voiceover, assertions); `fraimz.html` in the run directory stays the full
 * artifact with validated screenshots.
 */
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export function renderPrComment(report) {
  const verdict = report.summary.failed > 0 ? "❌ FAILED" : "✅ PASSED";
  const lines = [
    `## fraimz — ${verdict}`,
    "",
    `${report.summary.passed} passed · ${report.summary.failed} failed · ${report.summary.skipped} skipped — run \`${report.runId}\``,
    "",
    `Full frame proof with validated screenshots: \`evals/results/${report.runId}/fraimz.html\` (re-run: \`pnpm fraimz ${report.flows.map((flow) => `--flow ${flow.id}`).join(" ")}\`)`,
    "",
  ];
  for (const flow of report.flows) {
    const icon = flow.status === "passed" ? "✅" : flow.status === "skipped" ? "⏭️" : "❌";
    lines.push(`### ${icon} ${flow.id} — ${flow.title}`);
    if (flow.kind) lines.push(`_${flow.kind === "user-facing" ? "User-facing flow demo" : "Internal demo"}_`);
    if (flow.skipReason) lines.push(`Skipped: ${flow.skipReason}`);
    lines.push("");
    let frame = 0;
    for (const step of flow.steps ?? []) {
      for (const evidence of step.evidence ?? []) {
        if (evidence.type === "claim" && evidence.status === "passed") {
          frame += 1;
          lines.push(`${frame}. **${evidence.claim ?? evidence.name}**`);
          if (evidence.voiceover) lines.push(`   > 🎙 ${evidence.voiceover}`);
        }
        if (evidence.type === "assertion") {
          lines.push(`   - ${evidence.status === "passed" ? "✅" : "❌"} ${evidence.assertion}`);
        }
        if (evidence.type === "frame") {
          const failed = (evidence.validations ?? []).filter((validation) => !validation.passed);
          lines.push(
            `   - 📸 \`${evidence.file}\` — ${failed.length === 0 ? `${(evidence.validations ?? []).length} validations passed` : `FAILED: ${failed.map((validation) => validation.label).join(", ")}`}`,
          );
        }
      }
      if (step.status === "failed") lines.push(`   - ❌ **${step.name}** — ${step.error}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Post the comment with `gh pr comment`. `prNumber` may be null: gh then
 * targets the PR of the current branch. Returns { posted, detail }.
 */
export async function postPrComment(report, { outDir, prNumber = null } = {}) {
  const body = renderPrComment(report);
  const bodyPath = join(outDir, "pr-comment.md");
  await writeFile(bodyPath, body);
  const args = ["pr", "comment", ...(prNumber ? [String(prNumber)] : []), "--body-file", bodyPath];
  const result = spawnSync("gh", args, { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr?.trim() ?? `gh exited ${result.status}`;
    return { posted: false, bodyPath, detail };
  }
  return { posted: true, bodyPath, detail: result.stdout.trim() };
}
