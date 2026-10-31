#!/usr/bin/env node
// Warden fixer (prototype, off by default): turns Warden's own high-confidence
// suggested fixes into one small fix PR against the reviewed PR's branch.
// It never pushes to the PR branch, never approves and never merges. See
// docs/ci/warden-fixer.md.
//
// Usage (trusted default-branch copy only):
//   node warden-fixer.mjs plan --findings <warden-findings.json> --files <changed-files.json> --pr <n> --head <sha> --out <dir>
// Writes NN.patch per qualifying fix, plan.json and body.md into <dir>.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { machineryFiles } from "./contributor-policy.mjs";

export const LIMITS = { fixes: 5, filesPerFix: 3, changedLinesPerFix: 40, diffBytes: 20_000 };
export const FIX_BRANCH_PREFIX = "warden-fix/";

/** Paths a unified diff touches (both sides), or null when it is not a plain text diff. */
export function diffPaths(diff) {
  if (typeof diff !== "string" || !diff.trim() || diff.length > LIMITS.diffBytes) return null;
  // Renames, mode changes and binary patches are never applied automatically.
  if (/^(rename from|rename to|new file mode|deleted file mode|old mode|new mode|similarity index|GIT binary patch|Binary files)/m.test(diff)) return null;
  const paths = new Set();
  for (const match of diff.matchAll(/^(?:---|\+\+\+) (?:[ab]\/)?(\S+)/gm)) {
    if (match[1] === "/dev/null") return null;
    paths.add(match[1]);
  }
  if (!paths.size) return null;
  for (const path of paths) {
    if (path.startsWith("/") || path.split("/").some((part) => part === ".." || part === "." || !part)) return null;
  }
  return [...paths];
}

/** Changed lines (additions plus deletions) in a unified diff. */
export function changedLines(diff) {
  return diff.split("\n").filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---) /.test(line)).length;
}

/**
 * The fixes Warden may propose: high confidence, a small text diff confined to
 * files the PR already changes, never review machinery, at most LIMITS.fixes.
 * Returns { fixes, skipped } with a reason per skipped finding.
 */
export function qualifyingFixes(report, prFiles) {
  const fixes = [];
  const skipped = [];
  const changed = new Set(prFiles);
  for (const finding of Array.isArray(report?.findings) ? report.findings : []) {
    const reason = (() => {
      if (finding?.confidence !== "high") return "not high confidence";
      const diff = finding.suggested_fix?.diff;
      const paths = diffPaths(diff);
      if (!paths) return "no applicable text diff";
      if (paths.length > LIMITS.filesPerFix) return "touches too many files";
      if (changedLines(diff) > LIMITS.changedLinesPerFix) return "too large";
      if (machineryFiles(paths.map((filename) => ({ filename }))).length) return "touches review or CI machinery";
      if (paths.some((path) => !changed.has(path))) return "touches a file the PR does not change";
      if (fixes.length >= LIMITS.fixes) return "fix limit reached";
      return null;
    })();
    if (reason) skipped.push({ title: finding?.title ?? "(untitled)", reason });
    else fixes.push({ title: finding.title, severity: finding.severity, path: finding.path ?? null, description: finding.suggested_fix.description ?? "", diff: finding.suggested_fix.diff });
  }
  return { fixes, skipped };
}

/** One fix branch per reviewed head: reruns are idempotent and never stack. */
export function fixBranch(pr, headSha) {
  if (!Number.isSafeInteger(pr) || pr < 1 || !/^[a-f0-9]{40}$/.test(headSha ?? "")) throw new Error("Invalid PR or head");
  return `${FIX_BRANCH_PREFIX}${pr}-${headSha.slice(0, 12)}`;
}

/** Whether a PR may receive fixes: same repository, targets dev, not a fix PR, head reviewed. */
export function eligiblePr(pr, { repository, reviewedHead }) {
  if (pr?.state !== "open") return "PR is not open";
  if (pr.base?.ref !== "dev" || pr.base?.repo?.full_name !== repository) return "PR does not target dev here";
  if (pr.head?.repo?.full_name !== repository || pr.head?.repo?.fork) return "fork PRs never receive pushed fixes";
  if (String(pr.head?.ref ?? "").startsWith(FIX_BRANCH_PREFIX)) return "a Warden fix PR is never fixed again";
  if (pr.head?.sha !== reviewedHead) return "PR head moved since the review";
  return null;
}

export function fixPrBody({ pr, headSha, fixes, skipped }) {
  const lines = [
    `Warden's suggested fixes for #${pr} at \`${headSha.slice(0, 12)}\`. Merge this PR into your branch to accept them, or close it to reject them. Warden never merges.`,
    "",
    ...fixes.map((fix) => `- **${fix.severity}**: ${fix.title.slice(0, 200)}${fix.path ? ` (\`${fix.path.slice(0, 200)}\`)` : ""}`),
  ];
  if (skipped.length) lines.push("", `${skipped.length} other finding(s) need a human: ${[...new Set(skipped.map((item) => item.reason))].join(", ")}.`);
  lines.push("", "Release note: none");
  return `${lines.join("\n")}\n`;
}

function cli(argv) {
  const args = new Map();
  for (let index = 1; index < argv.length; index += 2) args.set(argv[index].replace(/^--/, ""), argv[index + 1]);
  if (argv[0] !== "plan") throw new Error("Usage: warden-fixer.mjs plan --findings <file> --files <file> --out <dir>");
  const report = JSON.parse(readFileSync(args.get("findings"), "utf8"));
  const files = JSON.parse(readFileSync(args.get("files"), "utf8"));
  const pr = Number(args.get("pr"));
  const headSha = args.get("head");
  if (report?.schema_version !== 1 || report.complete !== true) throw new Error("Only a complete Warden review can propose fixes.");
  if (report.pr !== pr || report.head_sha !== headSha) throw new Error("The findings are not for this PR head.");
  const { fixes, skipped } = qualifyingFixes(report, files);
  const out = resolve(args.get("out"));
  mkdirSync(out, { recursive: true });
  fixes.forEach((fix, index) => writeFileSync(join(out, `${String(index + 1).padStart(2, "0")}.patch`), fix.diff.endsWith("\n") ? fix.diff : `${fix.diff}\n`));
  writeFileSync(join(out, "plan.json"), `${JSON.stringify({ branch: fixBranch(pr, headSha), fixes: fixes.map(({ diff, ...rest }) => rest), skipped }, null, 2)}\n`);
  writeFileSync(join(out, "body.md"), fixPrBody({ pr, headSha, fixes, skipped }));
  console.log(`${fixes.length} fix(es) qualify; ${skipped.length} finding(s) skipped.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { cli(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
