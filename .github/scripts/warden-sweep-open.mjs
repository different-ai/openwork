// Write-token boundary: no model or repository code execution, only validated text patches.
import { execFileSync } from "node:child_process";
import { appendFileSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { validatePatch, safeFile, GENERATION_LIMITS } from "./warden-generate.mjs";
import { LIMITS } from "./warden-fixer.mjs";
import { machineryFiles } from "./contributor-policy.mjs";
const SHA = /^[a-f0-9]{40}$/;
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 500_000 }).trim();
const gh = (args, token) => execFileSync("gh", args, { encoding: "utf8", env: { ...process.env, GH_TOKEN: token }, stdio: ["ignore", "pipe", "pipe"] }).trim();
function artifactText(path, max) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw new Error("invalid artifact file");
  return readFileSync(path, "utf8");
}
export function readPlan(cwd, dir) {
  if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) throw new Error("invalid plan directory");
  const plan = JSON.parse(artifactText(join(dir, "plan.json"), 10_000));
  if (!SHA.test(plan.sha ?? "") || !(plan.number === null || Number.isSafeInteger(plan.number) && plan.number > 0) || plan.branch !== `warden-fix/merged-${plan.number ?? "commit"}-${plan.sha.slice(0, 12)}`) throw new Error("invalid plan identity");
  git(cwd, ["merge-base", "--is-ancestor", plan.sha, "HEAD"]);
  const files = git(cwd, ["diff-tree", "--no-commit-id", "--name-only", "-r", "--no-renames", plan.sha]).split("\n").filter(Boolean);
  const names = readdirSync(dir).filter((name) => /^\d{2}\.patch$/.test(name)).sort();
  if (!names.length || names.length > LIMITS.fixes) throw new Error("invalid patch count");
  const patches = names.map((name) => artifactText(join(dir, name), LIMITS.diffBytes));
  for (const patch of patches) validatePatch(cwd, patch, files);
  // Do not trust the artifact's title. The body is bounded, and never executed.
  const title = `fix: apply Warden's post-merge fixes for ${plan.number ? `#${plan.number}` : plan.sha.slice(0, 12)}`;
  const body = artifactText(join(dir, "body.md"), 20_000);
  return { ...plan, title, body, patches, files };
}
export async function main(env = process.env) {
  const cwd = process.cwd();
  const outcomes = [];
  let failed = false;
  try {
    if (!SHA.test(env.BASE ?? "")) throw new Error("invalid reviewed base");
    if (!env.PR_TOKEN || env.HAS_AUTOMATION_APP !== "true") throw new Error("automation App required for normal PR CI");
    git(cwd, ["config", "core.hooksPath", "/dev/null"]);
    git(cwd, ["config", "user.name", "github-actions[bot]"]);
    git(cwd, ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
    const directories = readdirSync(env.FIXES_DIR).sort();
    if (!directories.length || directories.length > GENERATION_LIMITS.attempts) throw new Error("invalid plan count");
    for (const name of directories) {
      let branch;
      let phase = "plan and source validation";
      try {
        git(cwd, ["reset", "--hard", env.BASE]);
        const plan = readPlan(cwd, join(env.FIXES_DIR, name));
        branch = plan.branch;
        phase = "existing PR lookup";
        const existing = JSON.parse(gh(["pr", "list", "--repo", env.GITHUB_REPOSITORY, "--head", branch, "--state", "all", "--json", "url"], env.PR_TOKEN));
        if (existing.length) { outcomes.push(`Existing fix PR: ${existing[0].url}`); continue; }
        // A previous push may have succeeded while PR creation failed: reuse only an identical branch.
        phase = "patch applicability and application";
        git(cwd, ["switch", "--detach", env.BASE]);
        for (const patch of plan.patches) {
          validatePatch(cwd, patch, plan.files);
          execFileSync("git", ["apply", "--whitespace=error", "-"], { cwd, input: patch, stdio: ["pipe", "pipe", "pipe"] });
        }
        phase = "actual changed-file validation";
        const changed = git(cwd, ["diff", "--name-only"]).split("\n").filter(Boolean);
        if (!changed.length || changed.length > LIMITS.fixes * LIMITS.filesPerFix || machineryFiles(changed.map((filename) => ({ filename }))).length) throw new Error("invalid actual changed files");
        for (const path of changed) { if (!plan.files.includes(path)) throw new Error("unexpected changed file"); safeFile(cwd, path); }
        // Inspect the actual aggregate diff at the token boundary too.
        const combined = git(cwd, ["diff", "--no-ext-diff", "--no-textconv"]);
        phase = "remote branch comparison";
        const remote = git(cwd, ["ls-remote", "--heads", "origin", branch]);
        if (remote) {
          git(cwd, ["fetch", "--no-tags", "origin", branch]);
          if (git(cwd, ["diff", "--no-ext-diff", "--no-textconv", env.BASE, "FETCH_HEAD"]) !== combined) throw new Error("existing branch differs; needs human review");
        } else {
          phase = "commit and push";
          git(cwd, ["commit", "-am", plan.title, "-m", "Release note: none"]);
          git(cwd, ["push", "origin", `HEAD:refs/heads/${branch}`]);
        }
        phase = "draft PR creation";
        const url = gh(["pr", "create", "--repo", env.GITHUB_REPOSITORY, "--draft", "--base", "dev", "--head", branch, "--title", plan.title, "--body", `${plan.body}\nVerification: model review and git apply only. Tests not run here; normal CI must pass. Draft; human review required.`], env.PR_TOKEN);
        if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/.test(url)) throw new Error("unexpected PR receipt");
        outcomes.push(`Opened draft fix PR: ${url}`);
      } catch { failed = true; outcomes.push(`${branch ?? "Plan"}: failed ${phase}; no success claimed. Retry queue retained.`); }
    }
  } catch { failed = true; outcomes.push("Fix job failed setup; no PR success claimed. Retry queue retained."); }
  const text = `Warden fix job: ${outcomes.filter((o) => o.startsWith("Opened")).length} PR(s) opened, ${outcomes.filter((o) => o.startsWith("Existing")).length} existing, ${outcomes.filter((o) => o.includes("failed")).length} failures.\n${outcomes.join("\n")}`;
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `## Fix PR outcomes\n\n${text}\n`);
  console.log(text);
  if (env.SLACK_BOT_TOKEN && env.SLACK_WARDEN_SWEEP_CHANNEL_ID) {
    const response = await fetch("https://slack.com/api/chat.postMessage", { method: "POST", signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ channel: env.SLACK_WARDEN_SWEEP_CHANNEL_ID, text, unfurl_links: false, unfurl_media: false }) });
    if (!response.ok || !(await response.json()).ok) { console.error("Fix outcome Slack delivery failed"); failed = true; }
  } else { console.warn("Fix outcome Slack delivery not configured"); }
  if (failed) process.exitCode = 1;
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main().catch(() => { console.error("Fix outcome reporting failed"); process.exitCode = 1; });
