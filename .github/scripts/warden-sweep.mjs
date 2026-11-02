#!/usr/bin/env node
// Warden post-merge sweep: every 3 hours (warden-sweep.yml), look at each PR
// merged to dev since the last sweep and list what to fix after the fact:
//
//   security  diff-security-review on the merged diff
//   bugs      diff-bug-review on the merged diff
//   design    design-spec-review (DESIGN.md rules) on the merged diff
//   tests     workflow runs on dev that failed at the merge commit
//
// Each merge commit on dev's first-parent line is one squash-merged PR, so
// every finding is attributed to the PR that introduced it. The result goes to
// a Slack channel (full text) and the job summary (public: security findings
// as counts only). It never comments, approves, reverts or opens PRs.
//
// The last reviewed dev commit is kept in the `warden-sweep-state` artifact of
// the newest earlier run that saved one, so each PR is reviewed once. See
// .warden/README.md.
//
// Local dry run (no Slack, no saved state; CI lookups use your gh login): SINCE=<sha> NO_SLACK=1 node .github/scripts/warden-sweep.mjs
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseWardenJsonl } from "./contributor-screen.mjs";
import { redact, wardenEnvironment } from "./warden-fast.mjs";

export const SKILLS = ["diff-security-review", "diff-bug-review", "design-spec-review"];
export const KIND = { "diff-security-review": "security", "diff-bug-review": "bug", "design-spec-review": "design" };
export const STATE_ARTIFACT = "warden-sweep-state";
// A busy window is finished by the next sweep rather than one very long job.
export const MAX_PRS = 20;
export const CONCURRENCY = 3;
// Stop re-checking CI for a commit after this long; report it as unknown.
export const CI_PENDING_MAX_MS = 24 * 60 * 60 * 1000;
const FAILED = new Set(["failure", "timed_out", "startup_failure"]);
const SEVERITIES = ["high", "medium", "low"];
const SHA = /^[0-9a-f]{40}$/;

// --- Window -------------------------------------------------------------------------

/** `(#1234)` at the end of a squash-merge subject. */
export function prNumber(subject) {
  const match = /\(#(\d+)\)\s*$/.exec(subject ?? "");
  return match ? Number(match[1]) : null;
}

/** Validated state from the previous sweep, or null. */
export function validState(state) {
  if (state?.version !== 1 || !SHA.test(state.reviewedThrough ?? "")) return null;
  const ciPending = Array.isArray(state.ciPending)
    ? state.ciPending.filter((entry) => SHA.test(entry?.sha ?? "") && Number.isFinite(Date.parse(entry.since)))
    : [];
  return { version: 1, reviewedThrough: state.reviewedThrough, ciPending };
}

/**
 * Which merges to review now. `commits` are dev's first-parent commits after
 * the base, oldest first. Over the cap, the oldest are reviewed and the rest
 * wait for the next sweep.
 */
export function planWindow(commits, max = MAX_PRS) {
  const batch = commits.slice(0, max);
  return { batch, deferred: commits.length - batch.length, reviewedThrough: batch.at(-1)?.sha ?? null };
}

// --- Findings -----------------------------------------------------------------------

const clean = (value, limit) => (typeof value === "string" ? redact(value).replace(/\s+/g, " ").trim().slice(0, limit) : "");

/** Warden findings in the sweep's shape, without the PR-only screenshot-evidence note. */
export function sweepFindings(parsed) {
  return parsed.findings
    .filter((finding) => KIND[finding.skill])
    // design-spec-review asks for screenshots in the PR body; after merge that is not actionable.
    .filter((finding) => !(finding.skill === "design-spec-review" && /screenshot evidence/i.test(finding.title ?? "")))
    .map((finding) => ({
      kind: KIND[finding.skill],
      severity: SEVERITIES.includes(finding.severity) ? finding.severity : "low",
      title: clean(finding.title, 200),
      description: clean(finding.description, 600),
      path: typeof finding.location?.path === "string" ? finding.location.path.slice(0, 240) : null,
      line: Number.isSafeInteger(finding.location?.startLine) && finding.location.startLine > 0 ? finding.location.startLine : null,
    }))
    .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
}

// --- CI -----------------------------------------------------------------------------

/**
 * Failed and still-running workflows for one merge commit. `previousConclusion`
 * returns the conclusion of the same workflow's run on dev just before this
 * one, so a failure can be told apart from one that was already red.
 */
export async function ciStatus(runs, previousConclusion) {
  const latest = new Map();
  // Re-runs share a workflow: keep the newest attempt of each.
  for (const run of runs) {
    const seen = latest.get(run.workflow_id);
    if (!seen || Date.parse(run.created_at) > Date.parse(seen.created_at)) latest.set(run.workflow_id, run);
  }
  const failed = [];
  let pending = 0;
  for (const run of latest.values()) {
    if (run.status !== "completed") pending += 1;
    else if (FAILED.has(run.conclusion)) {
      const before = await previousConclusion(run);
      failed.push({ name: clean(run.name, 120), url: run.html_url, newlyFailing: before === "success" });
    }
  }
  failed.sort((a, b) => Number(b.newlyFailing) - Number(a.newlyFailing) || a.name.localeCompare(b.name));
  return { failed, pending };
}

// --- Rendering ----------------------------------------------------------------------

const slackEscape = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/@(?=[A-Za-z0-9])/g, "@\u200b");
const mdEscape = (value) => String(value).replace(/[\\`*_|<>[\]]/g, (char) => `\\${char}`).replace(/@(?=[A-Za-z0-9])/g, "@\u200b");
const where = (finding) => (finding.path ? `${finding.path}${finding.line ? `:${finding.line}` : ""}` : "");

/** True when a PR has something to act on. */
export const needsAttention = (pr) => pr.findings.length > 0 || pr.ci.failed.length > 0 || !pr.complete;

export function counts(prs) {
  const total = { security: 0, bug: 0, design: 0, tests: 0, incomplete: 0 };
  for (const pr of prs) {
    for (const finding of pr.findings) total[finding.kind] += 1;
    total.tests += pr.ci.failed.length;
    if (!pr.complete) total.incomplete += 1;
  }
  return total;
}

function countLine(total) {
  const parts = [
    total.security && `${total.security} security`,
    total.bug && `${total.bug} bug`,
    total.design && `${total.design} design`,
    total.tests && `${total.tests} failing workflow`,
    total.incomplete && `${total.incomplete} incomplete review`,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "nothing to fix";
}

/** Slack message (private channel): full finding text. Null when there is nothing to report. */
export function slackMessage({ repo, prs, runUrl, deferred, lateCi }) {
  const flagged = prs.filter(needsAttention);
  const lateFailures = lateCi.filter((entry) => entry.ci.failed.length);
  if (!flagged.length && !lateFailures.length) return null;
  const lines = [`*Warden post-merge sweep*: ${prs.length} merged PR(s) reviewed — ${countLine(counts([...prs, ...lateFailures.map((entry) => ({ ...entry, findings: [], complete: true }))]))}`];
  for (const pr of flagged) {
    const link = pr.number ? `<https://github.com/${repo}/pull/${pr.number}|#${pr.number}>` : `<https://github.com/${repo}/commit/${pr.sha}|${pr.sha.slice(0, 10)}>`;
    lines.push("", `*${link} ${slackEscape(pr.title)}*`);
    if (!pr.complete) lines.push(`• :warning: review incomplete (${slackEscape(pr.reason)}); findings below may be partial`);
    for (const finding of pr.findings) {
      const at = where(finding) ? ` — \`${slackEscape(where(finding))}\`` : "";
      lines.push(`• [${finding.kind} · ${finding.severity}] ${slackEscape(finding.title)}${at}`);
      if (finding.description) lines.push(`    ${slackEscape(finding.description.slice(0, 300))}`);
    }
    for (const run of pr.ci.failed) lines.push(`• [tests] <${run.url}|${slackEscape(run.name)}> failed${run.newlyFailing ? " (first failure on dev)" : " (already failing before)"}`);
  }
  for (const entry of lateFailures) {
    lines.push("", `*Late CI results for #${entry.number ?? entry.sha.slice(0, 10)}*`);
    for (const run of entry.ci.failed) lines.push(`• [tests] <${run.url}|${slackEscape(run.name)}> failed${run.newlyFailing ? " (first failure on dev)" : " (already failing before)"}`);
  }
  if (deferred) lines.push("", `${deferred} more merged PR(s) will be reviewed in the next sweep.`);
  lines.push("", `<${runUrl}|View run>`);
  let text = lines.join("\n");
  if (text.length > 38_000) text = `${text.slice(0, 37_800)}\n…truncated. <${runUrl}|See the run summary>`;
  return { text, unfurl_links: false, unfurl_media: false };
}

/** Job summary (public repository): security findings appear only as counts. */
export function jobSummary({ repo, prs, deferred, lateCi, base, head, slack }) {
  const lines = ["## Warden post-merge sweep", "", `Reviewed ${prs.length} PR(s) merged to dev: \`${base.slice(0, 10)}..${head.slice(0, 10)}\`. Found ${countLine(counts(prs))}.`, ""];
  if (prs.length) {
    lines.push("| PR | Security | Bugs | Design | Failing workflows | Review |", "| --- | --- | --- | --- | --- | --- |");
    for (const pr of prs) {
      const n = (kind) => pr.findings.filter((finding) => finding.kind === kind).length;
      const ref = pr.number ? `[#${pr.number}](https://github.com/${repo}/pull/${pr.number})` : `\`${pr.sha.slice(0, 10)}\``;
      lines.push(`| ${ref} | ${n("security")} | ${n("bug")} | ${n("design")} | ${pr.ci.failed.length}${pr.ci.pending ? ` (+${pr.ci.pending} running)` : ""} | ${pr.complete ? "complete" : `incomplete: ${mdEscape(pr.reason)}`} |`);
    }
    lines.push("");
  }
  const details = prs.flatMap((pr) => [
    ...pr.findings.filter((finding) => finding.kind !== "security").map((finding) =>
      `- #${pr.number ?? pr.sha.slice(0, 10)} [${finding.kind} · ${finding.severity}] ${mdEscape(finding.title)}${where(finding) ? ` — \`${where(finding).replace(/`/g, "'")}\`` : ""}`),
    ...pr.ci.failed.map((run) => `- #${pr.number ?? pr.sha.slice(0, 10)} [tests] [${mdEscape(run.name)}](${run.url}) failed${run.newlyFailing ? " (first failure on dev)" : ""}`),
  ]);
  for (const entry of lateCi) for (const run of entry.ci.failed) details.push(`- #${entry.number ?? entry.sha.slice(0, 10)} [tests, late result] [${mdEscape(run.name)}](${run.url}) failed`);
  if (details.length) lines.push("<details><summary>Bugs, design and failing workflows</summary>", "", ...details, "", "</details>", "");
  if (counts(prs).security) lines.push("Security finding text is sent to the team's Slack channel only.", "");
  if (deferred) lines.push(`${deferred} more merged PR(s) wait for the next sweep.`, "");
  lines.push(slack);
  return lines.join("\n");
}

// --- Running Warden -----------------------------------------------------------------

/** The environment Warden's agent sees: no GitHub or Slack credentials. */
export function sweepEnvironment(env) {
  const out = wardenEnvironment(env);
  for (const name of Object.keys(out)) if (name.startsWith("SLACK_")) delete out[name];
  return out;
}

function runWarden({ wardenBin, cwd, configPath, sha, outDir, env }) {
  const jsonl = join(outDir, `${sha}.jsonl`);
  rmSync(jsonl, { force: true });
  const command = wardenBin ? ["node", [wardenBin]] : ["pnpm", ["dlx", "@sentry/warden@0.43.0"]];
  return new Promise((resolve) => {
    const child = spawn(command[0], [...command[1], `${sha}^..${sha}`, "-C", cwd, "--config-path", configPath,
      "--runtime", "pi", "--fail-on", "off", "--log", "-o", jsonl], { cwd, env, stdio: ["ignore", "inherit", "inherit"] });
    const timer = setTimeout(() => child.kill("SIGTERM"), 45 * 60 * 1000);
    const done = (started) => {
      clearTimeout(timer);
      if (!started) return resolve({ complete: false, reason: "warden-did-not-start", findings: [] });
      resolve(parseWardenJsonl(existsSync(jsonl) ? readFileSync(jsonl, "utf8") : "", SKILLS));
    };
    child.on("error", () => done(false));
    child.on("close", () => done(true));
  });
}

async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
}

// --- GitHub -------------------------------------------------------------------------

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
const isAncestor = (cwd, ancestor, head) => spawnSync("git", ["merge-base", "--is-ancestor", ancestor, head], { cwd }).status === 0;
const gh = (args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
const api = (path) => JSON.parse(gh(["api", path]));

function loadPreviousState(repo, workflow, runId) {
  try {
    const runs = api(`repos/${repo}/actions/workflows/${workflow}/runs?branch=dev&status=completed&per_page=20`).workflow_runs ?? [];
    for (const run of runs) {
      if (String(run.id) === String(runId)) continue;
      const dir = mkdtempSync(join(tmpdir(), "warden-sweep-state-"));
      try {
        gh(["run", "download", String(run.id), "--repo", repo, "--name", STATE_ARTIFACT, "--dir", dir]);
        const file = readdirSync(dir).find((name) => name === "state.json");
        const state = file ? validState(JSON.parse(readFileSync(join(dir, file), "utf8"))) : null;
        if (state) return state;
      } catch {
        // Expired or missing artifact: try the run before.
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  } catch (error) {
    console.warn(`Could not read the previous sweep's state: ${error.message}`);
  }
  return null;
}

function ciFor(repo, sha) {
  const runs = (api(`repos/${repo}/actions/runs?head_sha=${sha}&branch=dev&event=push&per_page=100`).workflow_runs ?? [])
    // This sweep's own runs are scheduled, never push; skip anything else odd.
    .filter((run) => run.head_sha === sha);
  return ciStatus(runs, async (run) => {
    const earlier = api(`repos/${repo}/actions/workflows/${run.workflow_id}/runs?branch=dev&event=push&status=completed&per_page=30`).workflow_runs ?? [];
    return earlier.find((candidate) => candidate.head_sha !== sha && Date.parse(candidate.created_at) < Date.parse(run.created_at))?.conclusion ?? null;
  });
}

async function postSlack(message, { token, channel }) {
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ channel, ...message }),
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(`Slack delivery failed: ${result.error || response.status}`);
}

// --- Main ---------------------------------------------------------------------------

async function main() {
  const env = process.env;
  const cwd = env.REPO_DIR || process.cwd();
  const repo = env.REPO || env.GITHUB_REPOSITORY || "different-ai/openwork";
  const outDir = env.OUT_DIR || mkdtempSync(join(tmpdir(), "warden-sweep-"));
  const local = env.NO_SLACK === "1";
  mkdirSync(outDir, { recursive: true });
  const head = git(cwd, ["rev-parse", env.HEAD_SHA || "HEAD"]);

  const previous = local ? null : loadPreviousState(repo, "warden-sweep.yml", env.GITHUB_RUN_ID);
  let base = env.SINCE ? git(cwd, ["rev-parse", env.SINCE]) : previous?.reviewedThrough;
  if (base && !isAncestor(cwd, base, head)) {
    console.warn(`${base} is no longer on dev; starting from 3 hours ago instead.`);
    base = null;
  }
  if (!base) {
    // First sweep (or state expired): start from dev as it was 3 hours ago.
    base = git(cwd, ["rev-list", "-1", "--first-parent", "--before=3 hours ago", head]);
    console.log(`No previous sweep state; reviewing merges since ${base}.`);
  }
  const commits = git(cwd, ["log", "--first-parent", "--reverse", "--format=%H%x09%s", `${base}..${head}`])
    .split("\n").filter(Boolean).map((line) => {
      const [sha, ...rest] = line.split("\t");
      const subject = rest.join("\t");
      return { sha, title: subject.replace(/\s*\(#\d+\)\s*$/, ""), number: prNumber(subject) };
    });
  const { batch, deferred, reviewedThrough } = planWindow(commits);
  console.log(`Reviewing ${batch.length} merge(s); ${deferred} deferred.`);

  // Trusted policy, written outside the analyzed checkout.
  const configPath = join(outDir, "sweep.toml");
  writeFileSync(configPath, readFileSync(env.POLICY_PATH || join(cwd, ".warden/sweep.toml"), "utf8"));
  const wardenEnv = sweepEnvironment(env);

  const prs = await pool(batch, CONCURRENCY, async (commit) => {
    const parsed = await runWarden({ wardenBin: env.WARDEN_BIN, cwd, configPath, sha: commit.sha, outDir, env: wardenEnv });
    let ci = { failed: [], pending: 0 };
    if (repo) {
      try { ci = await ciFor(repo, commit.sha); } catch (error) { console.warn(`CI lookup failed for ${commit.sha}: ${error.message}`); }
    }
    return { ...commit, complete: parsed.complete, reason: parsed.reason ?? "", findings: sweepFindings(parsed), ci };
  });

  // Commits whose CI was still running at the last sweep.
  const now = Date.now();
  const lateCi = [];
  const ciPending = [];
  for (const entry of previous?.ciPending ?? []) {
    try {
      const ci = await ciFor(repo, entry.sha);
      if (ci.pending && now - Date.parse(entry.since) < CI_PENDING_MAX_MS) ciPending.push(entry);
      lateCi.push({ ...entry, ci });
    } catch {
      ciPending.push(entry);
    }
  }
  for (const pr of prs) if (pr.ci.pending) ciPending.push({ sha: pr.sha, number: pr.number, since: new Date(now).toISOString() });

  const runUrl = `${env.GITHUB_SERVER_URL || "https://github.com"}/${repo}/actions/runs/${env.GITHUB_RUN_ID || ""}`;
  const message = slackMessage({ repo, prs, runUrl, deferred, lateCi });
  let slack = "Nothing to report to Slack.";
  if (message && local) {
    slack = "Local run: Slack skipped.";
    console.log(message.text);
  } else if (message && env.SLACK_BOT_TOKEN && env.SLACK_WARDEN_SWEEP_CHANNEL_ID) {
    await postSlack(message, { token: env.SLACK_BOT_TOKEN, channel: env.SLACK_WARDEN_SWEEP_CHANNEL_ID });
    slack = "Posted to Slack.";
  } else if (message) {
    slack = "Slack is not configured (SLACK_BOT_TOKEN and the SLACK_WARDEN_SWEEP_CHANNEL_ID variable); findings are only in this summary.";
    console.warn(slack);
  }

  const summary = jobSummary({ repo, prs, deferred, lateCi, base, head: reviewedThrough ?? head, slack });
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  else console.log(summary);

  const state = { version: 1, reviewedThrough: reviewedThrough ?? base, ciPending };
  writeFileSync(join(outDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
  // An unfinished review is reported, not retried: fail the run so it is visible.
  if (prs.some((pr) => !pr.complete)) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
