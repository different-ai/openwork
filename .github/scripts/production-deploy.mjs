#!/usr/bin/env node
// Production deploys of dev, driven by CI (production-deploy.yml) instead of
// Render's and Vercel's own Git auto-deploys. For one dev commit:
//   gate    wait until the checks every dev push runs have passed on it
//   plan    compare it with what each service runs now and pick what to deploy
//   deploy  deploy one service at exactly that commit and wait until it is live
// Identities are fixed here, not operator input, and every one is checked
// against the provider before anything is read as live or deployed.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { changedFiles, isBuildAffected } from "./build-inputs.mjs";
import { quickCheckState } from "./require-quick-check.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const REPOSITORY = "https://github.com/different-ai/openwork";
export const BRANCH = "dev";
// The workspace celld-runner-deploy.yml and render-build-filters.yml act on.
export const RENDER_OWNER_ID = "tea-cspud29u0jms7384itk0";
export const VERCEL_TEAM_ID = "team_ngwD5Vw2RskH8mkCatHxlmBT";
const RENDER_API = "https://api.render.com/v1";
const VERCEL_API = "https://api.vercel.com";
const VERCEL_CLI = "vercel@48";

// Every dev push runs these; a deploy waits for all of them on its commit.
export const REQUIRED_WORKFLOWS = Object.freeze(["quick-check.yml", "api-contract.yml"]);
// Runs only when migrations change (and on a schedule). Den API waits for it.
export const MIGRATION_WORKFLOW = "den-db-migrate.yml";

// stage "core" deploys first; "edge" deploys once every core deploy is live,
// so clients never reach an API older than they are.
export const TARGETS = Object.freeze({
  "api-private": { provider: "render", stage: "core", id: "srv-da5gkhmk1f9s738jikcg", build: "native-den-api", migrations: true },
  "inference-private": { provider: "render", stage: "core", id: "srv-da5he9jbc2fs73933jkg", build: "native-inference" },
  workbot: { provider: "render", stage: "edge", id: "srv-db1js86gekts73e692g0", build: "native-workbot" },
  "client-web": { provider: "render", stage: "edge", id: "srv-d9js4bnavr4c73a406lg", build: "native-client-web" },
  "openwork-den": { provider: "vercel", stage: "edge", id: "prj_MvpDu3pE2SEfeiPXkdHx6UcU5DVO", rootDirectory: "ee/apps/den-web", build: "vercel-den-web" },
  "openwork-app": { provider: "vercel", stage: "edge", id: "prj_d8oz8fPdzK10RtFVequ3JdXjhxPu", rootDirectory: "apps/app", build: "vercel-app" },
  "openwork-landing": { provider: "vercel", stage: "edge", id: "prj_kSccDt6i07NRESPOQpvk4o7feLAR", rootDirectory: "ee/apps/landing", build: "vercel-landing" },
  "openwork-diagnostics": { provider: "vercel", stage: "edge", id: "prj_b10TW7TtTUWdm2NvKO8TzfSzAv3I", rootDirectory: "ee/apps/diagnostics", build: "vercel-diagnostics" },
});

const SHA = /^[a-f0-9]{40}$/;
const assertSha = (sha) => { if (!SHA.test(String(sha))) throw new Error(`Not a full commit SHA: ${sha}`); };
const target = (name) => {
  if (!Object.hasOwn(TARGETS, name)) throw new Error(`Unknown deploy target: ${name}`);
  return TARGETS[name];
};

// ── Gate ────────────────────────────────────────────────────────────────────

/**
 * Migrations: a run on this commit decides; with none (a push that changed no
 * migration), the newest run on dev does, so a broken migrate still holds the API.
 */
export function migrationState(runsForSha, latestOnDev, sha) {
  const own = quickCheckState(runsForSha, sha);
  if (own.state !== "missing") return own;
  if (!latestOnDev) return { state: "passed" };
  return quickCheckState([{ ...latestOnDev, head_sha: sha }], sha);
}

/** Wait until every required workflow passed on `sha`; report, never throw on, migrations. */
export async function requireChecks({
  sha, listRuns, latestRun, required = REQUIRED_WORKFLOWS, waitMs = 20 * 60_000, intervalMs = 15_000,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)), now = Date.now, log = console.log,
}) {
  assertSha(sha);
  const deadline = now() + waitMs;
  for (;;) {
    const states = {};
    for (const workflow of required) states[workflow] = quickCheckState(await listRuns(workflow, sha), sha);
    const migrations = migrationState(await listRuns(MIGRATION_WORKFLOW, sha), await latestRun(MIGRATION_WORKFLOW), sha);
    const failed = Object.entries(states).find(([, result]) => result.state === "failed");
    if (failed) throw new Error(`${failed[0]} ${failed[1].run.conclusion ?? "did not pass"} on ${sha}: ${failed[1].run.html_url}. Nothing is deployed from a commit its checks did not pass.`);
    const waiting = [...Object.entries(states), [MIGRATION_WORKFLOW, migrations]].filter(([, result]) => result.state === "pending" || result.state === "missing");
    // A missing migration run is never waited for: most pushes do not start one.
    const blocking = waiting.filter(([workflow, result]) => workflow !== MIGRATION_WORKFLOW || result.state === "pending");
    if (blocking.length === 0) {
      for (const [workflow, result] of Object.entries(states)) log(`${workflow} passed on ${sha}: ${result.run.html_url}`);
      return { migrations: migrations.state };
    }
    if (now() >= deadline) {
      throw new Error(`Checks did not finish on ${sha} in time: ${blocking.map(([workflow, result]) => `${workflow} ${result.state}`).join(", ")}`);
    }
    log(`Waiting for ${blocking.map(([workflow, result]) => `${workflow} (${result.state})`).join(", ")} on ${sha}…`);
    await sleep(intervalMs);
  }
}

// ── Plan ────────────────────────────────────────────────────────────────────

/** How `head` relates to `live` in git history. */
export function relation(live, head, { root = ROOT } = {}) {
  if (!live) return "unknown";
  if (live === head) return "same";
  const ancestor = (a, b) => {
    try { execFileSync("git", ["merge-base", "--is-ancestor", a, b], { cwd: root, stdio: "ignore" }); return true; }
    catch (error) { if (error.status === 1) return false; throw error; }
  };
  try {
    if (ancestor(live, head)) return "ahead";
    if (ancestor(head, live)) return "behind";
    return "diverged";
  } catch {
    return "unknown";
  }
}

/**
 * One target's decision. `base` overrides the live commit as the comparison
 * point (the dry run compares with the previous push, which the providers'
 * own auto-deploys have usually already replaced).
 */
export function decide({ name, head, live, base, history, files, affected, migrations }) {
  const spec = target(name);
  const decision = (action, reason) => ({ name, provider: spec.provider, stage: spec.stage, live: live ?? null, action, reason });
  if (!base) {
    if (history === "same") return decision("skip", "already live");
    if (history === "behind") return decision("skip", `a newer dev commit (${live.slice(0, 8)}) is live; never deploy backwards`);
  }
  const from = base ?? live;
  let result;
  if (!from) result = decision("deploy", "the live commit is unknown");
  else if (files === null) result = decision("deploy", `no comparison with ${from.slice(0, 8)} is available`);
  else if (affected) result = decision("deploy", `build inputs changed since ${from.slice(0, 8)}`);
  else return decision("skip", `no build inputs changed since ${from.slice(0, 8)}`);
  if (spec.migrations && migrations === "failed") return { ...result, action: "blocked", reason: `${result.reason}, but ${MIGRATION_WORKFLOW} failed; fix the migration first` };
  return result;
}

export function planTarget({ name, head, live, base, migrations, root = ROOT }) {
  const spec = target(name);
  const history = relation(live, head, { root });
  const from = base ?? live;
  const files = from ? changedFiles({ base: from, head, root }) : null;
  const affected = files === null ? true : isBuildAffected(spec.build, files, { root, ref: head });
  return decide({ name, head, live, base, history, files, affected, migrations });
}

// ── Providers ───────────────────────────────────────────────────────────────

async function request(fetchImpl, url, { token, method = "GET", body } = {}) {
  const response = await fetchImpl(url, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${new URL(url).pathname} returned HTTP ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

/** Refuse a Render service that is not the one this target names. */
export function assertRenderService(service, name) {
  const spec = target(name);
  const fail = (reason) => { throw new Error(`Refusing ${name}: ${reason}.`); };
  if (!service || service.id !== spec.id) fail("service identity does not match");
  if (service.name !== name || service.ownerId !== RENDER_OWNER_ID) fail("name or workspace does not match");
  if (service.repo !== REPOSITORY || service.branch !== BRANCH) fail("repository or dev branch does not match");
  if (service.suspended !== "not_suspended") fail("service is suspended");
  return service;
}

/** Refuse a Vercel project that is not the one this target names. */
export function assertVercelProject(project, name) {
  const spec = target(name);
  const fail = (reason) => { throw new Error(`Refusing ${name}: ${reason}.`); };
  if (!project || project.id !== spec.id || project.name !== name) fail("project identity does not match");
  if ((project.rootDirectory ?? "") !== spec.rootDirectory) fail(`root directory is ${project.rootDirectory ?? "the repository root"}, not ${spec.rootDirectory}`);
  return project;
}

const liveRenderDeploy = (list) => (Array.isArray(list) ? list : []).map((item) => item?.deploy ?? item).find((deploy) => deploy?.status === "live");

export async function renderLive(name, { apiKey, fetchImpl = fetch }) {
  const spec = target(name);
  const service = assertRenderService(await request(fetchImpl, `${RENDER_API}/services/${spec.id}`, { token: apiKey }), name);
  const deploys = await request(fetchImpl, `${RENDER_API}/services/${spec.id}/deploys?limit=20`, { token: apiKey });
  const sha = liveRenderDeploy(deploys)?.commit?.id;
  return { live: SHA.test(String(sha)) ? sha : null, autoDeploy: service.autoDeploy === "yes" };
}

export async function vercelLive(name, { token, fetchImpl = fetch }) {
  const spec = target(name);
  assertVercelProject(await request(fetchImpl, `${VERCEL_API}/v9/projects/${spec.id}?teamId=${VERCEL_TEAM_ID}`, { token }), name);
  const result = await request(fetchImpl, `${VERCEL_API}/v6/deployments?projectId=${spec.id}&target=production&state=READY&limit=1&teamId=${VERCEL_TEAM_ID}`, { token });
  const sha = result?.deployments?.[0]?.meta?.githubCommitSha;
  return { live: SHA.test(String(sha)) ? sha : null, autoDeploy: null };
}

const RENDER_FAILED = new Set(["build_failed", "update_failed", "pre_deploy_failed", "canceled"]);

/** Deploy exactly `sha` (never the branch head) and wait until it is live. */
export async function renderDeploy(name, sha, {
  apiKey, fetchImpl = fetch, waitMs = 25 * 60_000, intervalMs = 15_000,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)), now = Date.now, log = console.log,
}) {
  assertSha(sha);
  const spec = target(name);
  assertRenderService(await request(fetchImpl, `${RENDER_API}/services/${spec.id}`, { token: apiKey }), name);
  const created = await request(fetchImpl, `${RENDER_API}/services/${spec.id}/deploys`, {
    token: apiKey, method: "POST", body: { commitId: sha, clearCache: "do_not_clear" },
  });
  let id = created?.id ?? null;
  log(id ? `Render deploy ${id} of ${sha} started for ${name}.` : `Render queued a deploy of ${sha} for ${name}.`);
  const deadline = now() + waitMs;
  for (;;) {
    let deploy;
    if (id) deploy = await request(fetchImpl, `${RENDER_API}/services/${spec.id}/deploys/${id}`, { token: apiKey });
    else {
      const list = await request(fetchImpl, `${RENDER_API}/services/${spec.id}/deploys?limit=20`, { token: apiKey });
      deploy = (Array.isArray(list) ? list : []).map((item) => item?.deploy ?? item).find((item) => item?.commit?.id === sha);
      id = deploy?.id ?? null;
    }
    const status = deploy?.status;
    if (status === "live") { log(`${name} is live on ${sha}.`); return { id, status }; }
    // Deactivated: it went live and a newer deploy already replaced it.
    if (status === "deactivated") { log(`${name} deployed ${sha}; a newer deploy has since replaced it.`); return { id, status }; }
    if (RENDER_FAILED.has(status)) throw new Error(`Render deploy ${id} of ${name} ended ${status}.`);
    if (now() >= deadline) throw new Error(`Render deploy ${id ?? "(queued)"} of ${name} was not live in time (last status: ${status ?? "unknown"}).`);
    log(`${name}: ${status ?? "waiting for the deploy to appear"}`);
    await sleep(intervalMs);
  }
}

/** Build and deploy the checked-out commit to production with the Vercel CLI. */
export async function vercelDeploy(name, sha, { token, fetchImpl = fetch, run = spawnSync, root = ROOT, log = console.log }) {
  assertSha(sha);
  const spec = target(name);
  assertVercelProject(await request(fetchImpl, `${VERCEL_API}/v9/projects/${spec.id}?teamId=${VERCEL_TEAM_ID}`, { token }), name);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  if (head !== sha) throw new Error(`Checkout is ${head}, not ${sha}; refusing to deploy other source.`);
  const result = run("npx", [
    "--yes", VERCEL_CLI, "deploy", "--prod", "--yes", "--scope", VERCEL_TEAM_ID, "--token", token,
    "--meta", `githubCommitSha=${sha}`, "--meta", `githubCommitRef=${BRANCH}`,
  ], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, VERCEL_ORG_ID: VERCEL_TEAM_ID, VERCEL_PROJECT_ID: spec.id } });
  const url = String(result.stdout ?? "").trim().split("\n").pop();
  if (result.status !== 0 || !url?.startsWith("https://")) throw new Error(`Vercel deploy of ${name} failed (exit ${result.status}).`);
  log(`${name} is live on ${sha}: ${url}`);
  return { url };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function options(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith("--")) throw new Error(`Unexpected argument: ${argv[index]}`);
    args.set(argv[index].slice(2), argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[++index] : "");
  }
  return args;
}

function output(values) {
  const text = Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, text);
  process.stdout.write(text);
}

function summary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

async function gate(args) {
  const sha = args.get("sha");
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!repo || !token) throw new Error("gate needs GITHUB_REPOSITORY and GH_TOKEN");
  const github = async (path) => {
    const response = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "openwork-production-deploy" },
    });
    if (!response.ok) throw new Error(`Listing workflow runs failed: HTTP ${response.status}`);
    return (await response.json()).workflow_runs;
  };
  const { migrations } = await requireChecks({
    sha,
    listRuns: (workflow, head) => github(`${workflow}/runs?head_sha=${head}&per_page=100`),
    latestRun: async (workflow) => (await github(`${workflow}/runs?branch=${BRANCH}&per_page=1`))[0] ?? null,
    waitMs: Number(args.get("wait-minutes") || 20) * 60_000,
  });
  output({ migrations });
}

async function plan(args) {
  const head = args.get("sha");
  assertSha(head);
  const base = args.get("base") || null;
  if (base) assertSha(base);
  const mode = args.get("mode") === "deploy" ? "deploy" : "dry-run";
  const migrations = args.get("migrations") || "passed";
  const { RENDER_API_KEY: renderKey, VERCEL_TOKEN: vercelToken } = process.env;
  const rows = [];
  for (const name of Object.keys(TARGETS)) {
    const spec = TARGETS[name];
    const secret = spec.provider === "render" ? renderKey : vercelToken;
    let state = { live: null, autoDeploy: null };
    let note = "";
    if (!secret) {
      if (mode === "deploy") throw new Error(`Missing ${spec.provider === "render" ? "RENDER_API_KEY" : "VERCEL_TOKEN"} on the production-deploy environment.`);
      note = "no credentials to read what is live";
    } else {
      state = spec.provider === "render"
        ? await renderLive(name, { apiKey: secret })
        : await vercelLive(name, { token: secret });
    }
    const decision = planTarget({ name, head, live: state.live, base, migrations });
    if (mode === "deploy" && decision.action === "deploy" && state.autoDeploy) {
      console.log(`::warning::Render auto-deploy is still on for ${name}; it deploys every dev commit on its own as well.`);
    }
    rows.push({ ...decision, autoDeploy: state.autoDeploy, note });
  }
  const pick = (stage) => JSON.stringify(rows.filter((row) => row.stage === stage && row.action === "deploy").map((row) => row.name));
  const blocked = JSON.stringify(rows.filter((row) => row.action === "blocked").map((row) => row.name));
  const verb = mode === "deploy" ? "Deploy" : "Would deploy";
  summary([
    `### Production deploy (${mode}) of \`${head.slice(0, 8)}\``,
    base ? `Compared with \`${base.slice(0, 8)}\` (the previous push), not with what is live.\n` : "",
    "| Target | Provider | Live | Auto-deploy | Decision | Why |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows.map((row) => `| ${row.name} | ${row.provider} | ${row.live ? `\`${row.live.slice(0, 8)}\`` : "unknown"} | ${row.autoDeploy === null ? "–" : row.autoDeploy ? "on" : "off"} | ${row.action === "deploy" ? verb : row.action === "blocked" ? "**Blocked**" : "Skip"} | ${[row.reason, row.note].filter(Boolean).join("; ")} |`),
  ].join("\n"));
  for (const row of rows) console.log(`${row.name}: ${row.action} (${row.reason}${row.note ? `; ${row.note}` : ""})`);
  output({ core: pick("core"), edge: pick("edge"), blocked });
}

async function deploy(args) {
  const name = args.get("target");
  const sha = args.get("sha");
  const spec = target(name);
  if (spec.provider === "render") {
    if (!process.env.RENDER_API_KEY) throw new Error("Missing RENDER_API_KEY");
    // Re-read: a newer commit may have gone live since the plan.
    const { live } = await renderLive(name, { apiKey: process.env.RENDER_API_KEY });
    if (relation(live, sha) === "behind") { console.log(`::notice::${name} already runs newer ${live}; skipping.`); return; }
    await renderDeploy(name, sha, { apiKey: process.env.RENDER_API_KEY });
  } else {
    if (!process.env.VERCEL_TOKEN) throw new Error("Missing VERCEL_TOKEN");
    const { live } = await vercelLive(name, { token: process.env.VERCEL_TOKEN });
    if (relation(live, sha) === "behind") { console.log(`::notice::${name} already runs newer ${live}; skipping.`); return; }
    await vercelDeploy(name, sha, { token: process.env.VERCEL_TOKEN });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [command, ...rest] = process.argv.slice(2);
  const commands = { gate, plan, deploy };
  try {
    if (!Object.hasOwn(commands, command)) throw new Error("Usage: production-deploy.mjs gate|plan|deploy --sha <sha> [...]");
    await commands[command](options(rest));
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}
