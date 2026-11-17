import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CHECKS, selectChecks, skipReason } from "./check.mjs";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const exec = promisify(execFile);

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("every check names a script that exists and says how to fix a failure", () => {
  for (const check of CHECKS) {
    assert.ok(check.fix.length > 20, `${check.name} has no fix`);
    const script = check.command.find((part) => /\.(mjs|ts)$/.test(part));
    if (script) assert.ok(existsSync(resolve(root, script)), `${check.name}: ${script} is missing`);
  }
});

test("the checks CI requires are the commands pnpm check runs", () => {
  const workflow = readFileSync(resolve(root, ".github/workflows/quick-check.yml"), "utf8");
  for (const command of [
    "node scripts/check-outbound-access.mjs",
    "node scripts/check-node-source-imports.mjs",
    "pnpm features:check",
    "node .github/scripts/typecheck-shipped.mjs --all",
    "node scripts/check-app-structure.mjs",
    "node scripts/check-code-habits.mjs",
  ]) {
    assert.ok(workflow.includes(command), `quick-check.yml no longer runs: ${command}`);
    assert.ok(CHECKS.some((check) => check.command.join(" ") === command), `pnpm check does not run: ${command}`);
  }
});

test("a check whose tool is absent is skipped, not failed", () => {
  const features = CHECKS.find((check) => check.name === "features");
  assert.equal(skipReason(features, { has: () => false }), "helm is not installed");
  assert.equal(skipReason(features, { has: () => true }), null);
});

test("an unknown check name is an error that lists the known ones", () => {
  assert.throws(() => selectChecks(["typo"]), /Unknown check: typo\. Known: typecheck/);
  assert.deepEqual(selectChecks(["i18n"]).map((check) => check.name), ["i18n"]);
});

test("check reports real check results, wall time and skipped checks without output", { skip: process.platform === "win32" || !existsSync(resolve(root, "node_modules")) }, async (t) => {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.writeHead(204).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const dir = await mkdtemp(resolve(tmpdir(), "check-timing-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { ...process.env, OPENWORK_PROCESS_TIMING_URL: `http://127.0.0.1:${server.address().port}`, OPENWORK_PROCESS_TIMING_KEY: "private-key" };
  const result = await exec(process.execPath, ["scripts/check.mjs", "outbound-access"], { cwd: root, env });
  assert.match(result.stdout, /ok.*outbound-access/);
  assert.equal(result.stderr, "");
  assert.equal(requests[0].process, "check");
  assert.equal(requests[0].outcome, "ok");
  assert.equal(requests[0].steps[0].step, "outbound-access");
  assert.equal(requests[0].steps[0].outcome, "ok");
  assert.ok(requests[0].totalSeconds >= requests[0].steps[0].seconds);
  await writeFile(resolve(dir, "which"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await exec(process.execPath, ["scripts/check.mjs", "features"], { cwd: root, env: { ...env, PATH: dir } });
  assert.deepEqual(requests[1].steps, [{ step: "features", seconds: 0, outcome: "skipped" }]);
  await writeFile(resolve(dir, "which"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(resolve(dir, "pnpm"), "#!/bin/sh\nexit 7\n", { mode: 0o755 });
  await assert.rejects(exec(process.execPath, ["scripts/check.mjs", "features"], { cwd: root, env: { ...env, PATH: dir } }), { code: 1 });
  assert.equal(requests[2].outcome, "fail");
  assert.equal(requests[2].steps[0].outcome, "fail");
  assert.equal(JSON.stringify(requests).includes("private-key"), false);
});
