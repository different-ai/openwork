import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { buildInputPatterns, isBuildAffected } from "./build-inputs.mjs";
import {
  MIGRATION_WORKFLOW, REQUIRED_WORKFLOWS, TARGETS, assertRenderService, assertVercelProject,
  decide, migrationState, renderDeploy, requireChecks,
} from "./production-deploy.mjs";

const sha = "a".repeat(40);
const live = "b".repeat(40);
const run = (fields = {}) => ({ id: 1, head_sha: sha, status: "completed", conclusion: "success", created_at: "2026-01-01T00:00:00Z", html_url: "https://example.test/run", ...fields });
const quiet = { sleep: async () => {}, log: () => {} };

test("every target names a build input target and the Vercel ones their app's vercel.json", () => {
  for (const [name, spec] of Object.entries(TARGETS)) {
    assert.ok(buildInputPatterns(spec.build).length > 0, name);
    assert.ok(["core", "edge"].includes(spec.stage), name);
    if (spec.provider === "vercel") {
      assert.match(spec.id, /^prj_/, name);
      assert.ok(existsSync(new URL(`../../${spec.rootDirectory}/vercel.json`, import.meta.url)), name);
    } else {
      assert.equal(spec.provider, "render", name);
      assert.match(spec.id, /^srv-/, name);
    }
  }
  // Clients go live after the API they call; the API waits for migrations.
  assert.equal(TARGETS["api-private"].stage, "core");
  assert.equal(TARGETS["api-private"].migrations, true);
});

test("each Vercel app deploys for its own source and not for another app's", () => {
  assert.equal(isBuildAffected("vercel-landing", ["ee/apps/landing/app/page.tsx"]), true);
  assert.equal(isBuildAffected("vercel-landing", ["packages/email/src/index.ts"]), true);
  assert.equal(isBuildAffected("vercel-den-web", ["ee/apps/landing/app/page.tsx"]), false);
  assert.equal(isBuildAffected("vercel-diagnostics", ["ee/apps/den-web/app/page.tsx"]), false);
  assert.equal(isBuildAffected("vercel-app", ["apps/server/src/mcp-app-sandbox.ts"]), true);
  for (const build of ["vercel-den-web", "vercel-app", "vercel-landing", "vercel-diagnostics"]) {
    assert.equal(isBuildAffected(build, ["pnpm-lock.yaml"]), true, build);
    assert.equal(isBuildAffected(build, null), true, build);
  }
});

test("the plan never deploys backwards and deploys only changed services", () => {
  const base = { name: "workbot", head: sha, live, migrations: "passed" };
  assert.equal(decide({ ...base, live: sha, history: "same", files: [], affected: false }).action, "skip");
  assert.equal(decide({ ...base, history: "behind", files: ["x"], affected: true }).action, "skip");
  assert.equal(decide({ ...base, history: "ahead", files: ["x"], affected: true }).action, "deploy");
  assert.equal(decide({ ...base, history: "ahead", files: ["docs/x.md"], affected: false }).action, "skip");
  // Unknown live state or comparison: deploy, never silently skip.
  assert.equal(decide({ ...base, live: null, history: "unknown", files: null, affected: true }).action, "deploy");
  assert.equal(decide({ ...base, history: "diverged", files: null, affected: true }).action, "deploy");
  // The dry run's base replaces the live commit as the comparison point.
  assert.equal(decide({ ...base, live: sha, base: live, history: "same", files: ["x"], affected: true }).action, "deploy");
});

test("Den API is held back, not deployed, while migrations fail", () => {
  const changed = { head: sha, live, history: "ahead", files: ["x"], affected: true };
  assert.equal(decide({ ...changed, name: "api-private", migrations: "failed" }).action, "blocked");
  assert.equal(decide({ ...changed, name: "api-private", migrations: "passed" }).action, "deploy");
  assert.equal(decide({ ...changed, name: "workbot", migrations: "failed" }).action, "deploy");
});

test("migrations: this commit's run decides, else the newest run on dev", () => {
  assert.equal(migrationState([], null, sha).state, "passed");
  assert.equal(migrationState([run({ conclusion: "failure" })], run(), sha).state, "failed");
  assert.equal(migrationState([], run({ head_sha: live, conclusion: "failure" }), sha).state, "failed");
  assert.equal(migrationState([], run({ head_sha: live, status: "in_progress", conclusion: null }), sha).state, "pending");
});

test("the gate waits for every required check on the commit and stops on a failure", async () => {
  const answers = { "quick-check.yml": [[], [run({ status: "in_progress", conclusion: null })], [run()]], "api-contract.yml": [[run()], [run()], [run()]] };
  const result = await requireChecks({
    sha, ...quiet,
    listRuns: async (workflow) => workflow === MIGRATION_WORKFLOW ? [] : answers[workflow].shift(),
    latestRun: async () => null,
  });
  assert.deepEqual(result, { migrations: "passed" });
  assert.deepEqual(REQUIRED_WORKFLOWS, ["quick-check.yml", "api-contract.yml"]);

  await assert.rejects(requireChecks({
    sha, ...quiet,
    listRuns: async (workflow) => workflow === "api-contract.yml" ? [run({ conclusion: "failure" })] : [run()],
    latestRun: async () => null,
  }), /api-contract\.yml failure/);

  let clock = 0;
  await assert.rejects(requireChecks({
    sha, ...quiet, now: () => (clock += 60_000), waitMs: 120_000,
    listRuns: async () => [], latestRun: async () => null,
  }), /did not finish/);

  // A failed migration does not stop the gate: the plan holds back Den API only.
  const failing = await requireChecks({ sha, ...quiet, listRuns: async (workflow) => workflow === MIGRATION_WORKFLOW ? [run({ conclusion: "failure" })] : [run()], latestRun: async () => null });
  assert.deepEqual(failing, { migrations: "failed" });
});

test("only the exact Render service and Vercel project are accepted", () => {
  const service = { id: TARGETS.workbot.id, name: "workbot", ownerId: "tea-cspud29u0jms7384itk0", repo: "https://github.com/different-ai/openwork", branch: "dev", suspended: "not_suspended" };
  assert.equal(assertRenderService(service, "workbot"), service);
  for (const change of [{ id: "srv-other" }, { name: "other" }, { ownerId: "tea-other" }, { branch: "main" }, { suspended: "suspended" }]) {
    assert.throws(() => assertRenderService({ ...service, ...change }, "workbot"), /Refusing workbot/);
  }
  const project = { id: TARGETS["openwork-den"].id, name: "openwork-den", rootDirectory: "ee/apps/den-web" };
  assert.equal(assertVercelProject(project, "openwork-den"), project);
  assert.throws(() => assertVercelProject({ ...project, rootDirectory: "apps/app" }, "openwork-den"), /root directory/);
  assert.throws(() => assertVercelProject({ ...project, name: "openwork-app" }, "openwork-den"), /identity/);
});

function fakeRender(statuses, { created = { id: "dep-1" } } = {}) {
  const calls = [];
  const service = { id: TARGETS["api-private"].id, name: "api-private", ownerId: "tea-cspud29u0jms7384itk0", repo: "https://github.com/different-ai/openwork", branch: "dev", suspended: "not_suspended" };
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined });
    const path = new URL(url).pathname;
    let body;
    if (path.endsWith("/deploys") && init.method === "POST") body = created;
    else if (path.includes("/deploys/")) body = { id: "dep-1", status: statuses.shift() };
    else if (path.endsWith("/deploys")) body = [{ deploy: { id: "dep-1", status: statuses.shift(), commit: { id: sha } } }];
    else body = service;
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  return { calls, fetchImpl };
}

test("a Render deploy pins the commit and waits until it is live", async () => {
  const { calls, fetchImpl } = fakeRender(["build_in_progress", "update_in_progress", "live"]);
  const result = await renderDeploy("api-private", sha, { apiKey: "k", fetchImpl, ...quiet });
  assert.equal(result.status, "live");
  const post = calls.find((call) => call.method === "POST");
  assert.deepEqual(post.body, { commitId: sha, clearCache: "do_not_clear" });
});

test("a failed or queued Render deploy is reported, not mistaken for success", async () => {
  await assert.rejects(renderDeploy("api-private", sha, { apiKey: "k", ...quiet, fetchImpl: fakeRender(["build_failed"]).fetchImpl }), /ended build_failed/);
  const queued = fakeRender(["queued", "live"], { created: null });
  assert.equal((await renderDeploy("api-private", sha, { apiKey: "k", ...quiet, fetchImpl: queued.fetchImpl })).status, "live");
  await assert.rejects(renderDeploy("api-private", "dev", { apiKey: "k", ...quiet, fetchImpl: queued.fetchImpl }), /Not a full commit SHA/);
});

const workflow = readFileSync(new URL("../workflows/production-deploy.yml", import.meta.url), "utf8");

test("the workflow deploys one run at a time, defaults to a dry run and gates before deploying", () => {
  assert.match(workflow, /on:\n  push:\n    branches:\n      - dev\n/);
  assert.match(workflow, /concurrency:\n  group: production-deploy\n  cancel-in-progress: false\n/);
  assert.match(workflow, /mode="\$\{INPUT_MODE:-\$\{VAR_MODE:-dry-run\}\}"/);
  assert.ok(workflow.indexOf("production-deploy.mjs gate") < workflow.indexOf("production-deploy.mjs plan"));
  assert.match(workflow, /deploy-core:[\s\S]*?if: needs\.plan\.outputs\.mode == 'deploy'/);
  assert.match(workflow, /deploy-edge:\n[\s\S]*?needs: \[plan, deploy-core\]/);
  assert.match(workflow, /needs\.deploy-core\.result == 'success' \|\| needs\.deploy-core\.result == 'skipped'/);
});

test("manual Render deploys redeploy what is live, never the dev head", () => {
  for (const name of ["den-api-env.yml", "dev-daytona-snapshot.yml"]) {
    const text = readFileSync(new URL(`../workflows/${name}`, import.meta.url), "utf8");
    assert.match(text, /\{commitId: \$commit\}/, name);
    assert.doesNotMatch(text, /-d '\{\}'/, name);
  }
});
