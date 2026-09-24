import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { changedFiles, packagedJourney, proofArtifact, proofLanes, selectProof } from "./pr-proof.mjs";

const file = (filename, status = "modified", previous_filename) => ({ filename, status, ...(previous_filename ? { previous_filename } : {}) });

test("added and changed E2E specs are all selected; removed specs and non-specs are not", () => {
  assert.deepEqual(selectProof([
    file("apps/app/src/a.ts"),
    file("evals/specs/new.e2e.test.ts", "added"),
    file("evals/specs/changed.e2e.test.ts"),
    file("evals/specs/moved.e2e.test.ts", "renamed", "evals/specs/old-name.e2e.test.ts"),
    file("evals/specs/gone.e2e.test.ts", "removed"),
    file("evals/specs/unit.test.ts"),
    file("evals/worlds/chat.ts"),
  ]).specs, ["evals/specs/changed.e2e.test.ts", "evals/specs/moved.e2e.test.ts", "evals/specs/new.e2e.test.ts"]);
});

test("a PR without spec changes selects nothing instead of failing", () => {
  assert.deepEqual(selectProof([file("packages/docs/page.mdx")]).specs, []);
  assert.deepEqual(selectProof([]).specs, []);
});

test("normal Git paths are accepted while traversal, controls, backslashes and duplicates fail closed", () => {
  assert.deepEqual(selectProof([
    file("ee/apps/den-web/app/(den)/dashboard/a file.ts"),
    file("packages/docs/café.mdx"),
    file("evals/specs/change.e2e.test.ts", "added"),
  ]).specs, ["evals/specs/change.e2e.test.ts"]);
  for (const files of [
    [file("../escape.ts")], [file("/absolute.ts")], [file("apps\\escape.ts")],
    [file("apps/control\n.ts")], [file("apps/a.ts"), file("apps/a.ts")],
  ]) assert.throws(() => selectProof(files));
});

test("changed-file pagination is complete and bounded", async () => {
  const paths = Array.from({ length: 201 }, (_, index) => file(`apps/a-${index}.ts`));
  const calls = [];
  const result = await changedFiles(async path => {
    calls.push(path);
    const page = Number(new URL(`https://example.test/${path}`).searchParams.get("page"));
    return paths.slice((page - 1) * 100, page * 100);
  }, "o/r", 1, paths.length);
  assert.equal(result.length, 201);
  assert.equal(calls.length, 3);
  await assert.rejects(changedFiles(async () => [], "o/r", 1, 3001), /3000-file limit/);
});

test("artifact names are stable, bounded hashes of validated spec paths", () => {
  const name = proofArtifact("evals/specs/change.e2e.test.ts", 2);
  assert.match(name, /^pr-proof-2-[a-f0-9]{64}$/);
  assert.throws(() => proofArtifact("../change.e2e.test.ts", 1));
});

const liveSpec = "evals/specs/live-stream-continuity.e2e.test.ts";
const normalSpec = "evals/specs/stream-continuity.e2e.test.ts";
const sha = "a".repeat(40);
function trustFixture() {
  const repo = "internal/project";
  const repository = { id: 42, full_name: repo, fork: false };
  const current = {
    number: 7, changed_files: 2, user: { login: "maintainer" },
    head: { sha, repo: { ...repository } }, base: { repo: { ...repository } },
  };
  return {
    repo, actor: "maintainer", triggeringActor: "reviewer", current,
    event: { repository, pull_request: structuredClone(current) },
  };
}

const untrusted = [
  ["fork head", f => { f.current.head.repo = { id: 99, full_name: "external/project", fork: true }; }],
  ["foreign base", f => { f.current.base.repo.id = 99; }],
  ["spoofed repo name", f => { f.current.head.repo.full_name = "external/project"; }],
  ["fork flag", f => { f.current.head.repo.fork = true; }],
  ["missing fork metadata", f => { delete f.current.head.repo.fork; }],
  ["missing head", f => { delete f.current.head; }],
  ["deleted head repo", f => { f.current.head.repo = null; }],
  ["missing base", f => { delete f.current.base; }],
  ["missing repository", f => { delete f.event.repository; }],
  ["missing repository id", f => { delete f.event.repository.id; }],
  ["wrong event repository", f => { f.event.repository.full_name = "external/project"; }],
  ["missing event PR", f => { delete f.event.pull_request; }],
  ["foreign event head", f => { f.event.pull_request.head.repo.id = 99; }],
  ["foreign event base", f => { f.event.pull_request.base.repo.full_name = "external/project"; }],
  ["Dependabot actor", f => { f.actor = "dependabot[bot]"; }],
  ["Dependabot rerun", f => { f.triggeringActor = "dependabot[bot]"; }],
  ["Dependabot author", f => { f.current.user.login = "dependabot[bot]"; }],
  ["Dependabot event author", f => { f.event.pull_request.user.login = "dependabot[bot]"; }],
  ["case-insensitive bot", f => { f.actor = "Dependabot[bot]"; }],
  ["missing actor", f => { delete f.actor; }],
  ["missing rerun actor", f => { delete f.triggeringActor; }],
  ["missing author", f => { delete f.current.user; }],
];

test("only the exact supported live file is routed; the entire changed selection is preserved", () => {
  const files = [
    file(normalSpec), file(liveSpec, "added"),
    file("evals/specs/nested/new.e2e.test.ts", "copied"),
    file("evals/specs/another-live.e2e.test.ts", "changed"),
    file("evals/specs/nested/live-stream-continuity.e2e.test.ts", "renamed", "evals/specs/old.e2e.test.ts"),
  ];
  const { specs } = selectProof(files);
  const lanes = proofLanes(specs, trustFixture());
  assert.deepEqual(lanes.liveSpecs, [liveSpec]);
  assert.deepEqual(lanes.normalSpecs, specs.filter(spec => spec !== liveSpec));
  assert.deepEqual([...lanes.normalSpecs, ...lanes.liveSpecs].sort(), specs);
  assert.deepEqual(proofLanes(selectProof([file(liveSpec, "removed")]).specs, {}), { normalSpecs: [], liveSpecs: [], packagedSpecs: [] });
});

test("untrusted live selection fails closed with an actionable message, even on maintainer reruns", async t => {
  for (const [name, mutate] of untrusted) await t.test(name, () => {
    const trust = trustFixture();
    mutate(trust);
    assert.throws(() => proofLanes([normalSpec, liveSpec], trust), /unsupported.*maintainer.*same-repository PR.*approve the pr-slow-specs/);
    assert.deepEqual(proofLanes([normalSpec], trust), { normalSpecs: [normalSpec], liveSpecs: [], packagedSpecs: [] });
  });
});

async function runController(trust, files, latest = trust.current) {
  const directory = await mkdtemp(fileURLToPath(new URL(".pr-proof-test-", import.meta.url)));
  try {
    const statePath = join(directory, "state.json");
    const eventPath = join(directory, "event.json");
    const outputPath = join(directory, "output.txt");
    const summaryPath = join(directory, "summary.txt");
    await writeFile(statePath, JSON.stringify({ current: trust.current, latest, files, calls: 0 }));
    await writeFile(eventPath, JSON.stringify(trust.event));
    await writeFile(outputPath, "");
    await writeFile(summaryPath, "");
    await writeFile(join(directory, "gh"), `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require("node:fs");
const path = ${JSON.stringify(statePath)};
const state = JSON.parse(readFileSync(path, "utf8"));
const args = process.argv.slice(2);
if (args[0] !== "api") process.exit(1);
let result;
if (args[1] === "repos/internal/project/pulls/7") result = state.calls++ ? state.latest : state.current;
else if (args[1] === "repos/internal/project/pulls/7/files?per_page=100&page=1") result = state.files;
else process.exit(1);
writeFileSync(path, JSON.stringify(state));
process.stdout.write(JSON.stringify(result));
`, { mode: 0o755 });
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("pr-proof-controller.mjs", import.meta.url))], {
      encoding: "utf8", timeout: 10_000,
      env: {
        PATH: `${directory}:${process.env.PATH}`, GITHUB_EVENT_PATH: eventPath,
        GITHUB_REPOSITORY: trust.repo, GITHUB_ACTOR: trust.actor,
        GITHUB_TRIGGERING_ACTOR: trust.triggeringActor, GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: summaryPath,
      },
    });
    assert.ifError(result.error);
    return { ...result, output: await readFile(outputPath, "utf8"), summary: await readFile(summaryPath, "utf8") };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("controller emits disjoint complete matrices with publisher-compatible keys and approval summary", async () => {
  for (const specs of [[], [normalSpec], [liveSpec], [normalSpec, liveSpec]]) {
    const trust = trustFixture();
    trust.current.changed_files = specs.length;
    const result = await runController(trust, specs.map(spec => file(spec)));
    assert.equal(result.status, 0, result.stderr);
    const outputs = Object.fromEntries(result.output.trim().split("\n").map(line => {
      const index = line.indexOf("=");
      return [line.slice(0, index), line.slice(index + 1)];
    }));
    assert.equal(outputs.selected, String(specs.includes(normalSpec)));
    assert.equal(outputs.liveSelected, String(specs.includes(liveSpec)));
    const normal = JSON.parse(outputs.matrix).include;
    const live = JSON.parse(outputs.liveMatrix).include;
    assert.deepEqual(normal.map(row => row.spec), specs.filter(spec => spec !== liveSpec));
    assert.deepEqual(live.map(row => row.spec), specs.filter(spec => spec === liveSpec));
    for (const row of [...normal, ...live]) {
      assert.equal(`pr-proof-2-${row.key}`, proofArtifact(row.spec, 2));
      assert.ok(result.summary.includes(row.spec));
    }
    if (live.length) assert.match(result.summary, /reviewer approval.*pr-slow-specs/);
  }
});

test("controller refuses untrusted live selection without emitting runnable outputs", async () => {
  for (const [, mutate] of untrusted) {
    const trust = trustFixture();
    mutate(trust);
    const result = await runController(trust, [file(normalSpec), file(liveSpec)]);
    assert.notEqual(result.status, 0);
    assert.equal(result.output, "");
  }
});

test("controller preserves selection bounds and head freshness; rechecks live trust after pagination", async () => {
  for (const scenario of ["initial head changed", "head changed during selection", "latest repo changed", "too many specs", "incomplete listing"]) {
    const trust = trustFixture();
    let files = [file(normalSpec), file(liveSpec)];
    const latest = structuredClone(trust.current);
    if (scenario === "initial head changed") trust.current.head.sha = "b".repeat(40);
    if (scenario === "head changed during selection") latest.head.sha = "b".repeat(40);
    if (scenario === "latest repo changed") latest.base.repo.id = 99;
    if (scenario === "too many specs") {
      files = Array.from({ length: 33 }, (_, index) => file(`evals/specs/spec-${index}.e2e.test.ts`));
      trust.current.changed_files = files.length;
    }
    if (scenario === "incomplete listing") trust.current.changed_files = 3;
    const result = await runController(trust, files, latest);
    assert.notEqual(result.status, 0, scenario);
    assert.equal(result.output, "", scenario);
    assert.match(result.stderr, /PR head changed|unsupported|More than 32|pagination is incomplete/, scenario);
  }
});

test("workflow keeps ordinary proof unprotected and gates all live PR code before checkout", async () => {
  const workflow = await readFile(new URL("../workflows/pr-proof.yml", import.meta.url), "utf8");
  const [ordinary, live] = workflow.split("\n  live-proof:\n");
  assert.ok(live);
  assert.doesNotMatch(workflow, /pull_request_target|continue-on-error/);
  assert.doesNotMatch(ordinary, /environment:|secrets\.|OPENAI_API_KEY|OPENWORK_EVAL_LIVE_OPENAI/);
  assert.match(ordinary, /if: needs.select.outputs.selected == 'true'/);
  assert.match(ordinary, /xvfb-run -a node evals\/bin\/evals.mjs "\$\{PROOF_SPEC#evals\/\}" --local\n/);
  assert.match(ordinary, /run-parity-proof.mjs --supports "\$PROOF_SPEC"/);
  assert.match(ordinary, /xvfb-run -a node evals\/scripts\/run-parity-proof.mjs "\$PROOF_SPEC"/);
  assert.match(ordinary, /liveMatrix: \$\{\{ steps.select.outputs.liveMatrix \}\}/);
  assert.match(ordinary, /liveSelected: \$\{\{ steps.select.outputs.liveSelected \}\}/);
  const gate = live.split("    steps:\n")[0];
  assert.match(gate, /needs: select/);
  assert.match(gate, /needs.select.outputs.liveSelected == 'true'/);
  for (const side of ["head", "base"]) {
    assert.ok(gate.includes(`github.event.pull_request.${side}.repo.full_name == github.repository`));
    assert.ok(gate.includes(`github.event.pull_request.${side}.repo.id == github.event.repository.id`));
    assert.ok(gate.includes(`github.event.pull_request.${side}.repo.fork == false`));
  }
  for (const actor of ["github.event.pull_request.user.login", "github.actor", "github.triggering_actor"]) {
    assert.ok(gate.includes(`${actor} != 'dependabot[bot]'`));
  }
  assert.match(gate, /environment: pr-slow-specs/);
  assert.match(gate, /runs-on: blacksmith-4vcpu-ubuntu-2404/);
  assert.match(gate, /matrix: \$\{\{ fromJSON\(needs.select.outputs.liveMatrix\) \}\}/);
  for (const job of [ordinary, live]) {
    assert.match(job, /ref: \$\{\{ github.event.pull_request.head.sha \}\}\n          persist-credentials: false/);
    assert.match(job, /name: pr-proof-\$\{\{ github.run_attempt \}\}-\$\{\{ matrix.key \}\}/);
    assert.match(job, /if: always\(\)/);
    assert.match(job, /evals\/results\/test-runs\//);
    assert.match(job, /evals\/results\/\.testkit\/cli-run-\*\.json/);
    assert.match(job, /include-hidden-files: true/);
    assert.match(job, /if-no-files-found: error/);
  }
  const [preparation, executionAndUpload] = live.split("      - name: Run the whole selected live spec with real inference\n");
  const [execution, upload] = executionAndUpload.split("      - name: Save selected native testkit and Vitest records\n");
  assert.doesNotMatch(preparation + upload, /secrets\.|OPENAI_API_KEY|OPENWORK_EVAL_LIVE_OPENAI/);
  assert.match(execution, /OPENAI_API_KEY: \$\{\{ secrets.OPENAI_API_KEY \}\}/);
  assert.match(execution, /OPENWORK_EVAL_LIVE_OPENAI: "1"/);
  assert.match(execution, /OPENWORK_EVAL_OPENAI_MODEL: gpt-5\.4/);
  assert.ok(execution.includes(`if [ "$PROOF_SPEC" != '${liveSpec}' ] && [ "$PROOF_SPEC" != 'evals/specs/engine-live-chat.e2e.test.ts' ]; then`));
  assert.match(execution, /OPENWORK_LIVE_PROVIDER=OpenAI OPENWORK_LIVE_KEY_ENV=OPENAI_API_KEY/);
  assert.match(execution, /OPENWORK_LIVE_MODELS=gpt-5\.4,gpt-4\.1-mini/);
  assert.match(execution, /xvfb-run -a node evals\/scripts\/run-parity-proof.mjs "\$PROOF_SPEC"/);
  assert.match(execution, /\$\{OPENAI_API_KEY\/\/\[\[:space:\]\]\/\}/);
  assert.match(execution, /this proof cannot be skipped/);
  assert.match(execution, /xvfb-run -a node evals\/bin\/evals.mjs "\$\{PROOF_SPEC#evals\/\}" --local --engine v1 --surface web\n/);
  assert.doesNotMatch(execution, /--testNamePattern|--grep|--test-name|pnpm .*build|pnpm .*install/);
  assert.doesNotMatch(preparation + upload, /OPENWORK_EVAL_CONTAINER_ELECTRON/);
  assert.match(execution, /OPENWORK_EVAL_CONTAINER_ELECTRON=1/);
});

test("both proof jobs share verified Chrome setup, with system OAuth handoff only for desktop proof", async () => {
  const workflow = await readFile(new URL("../workflows/pr-proof.yml", import.meta.url), "utf8");
  const [ordinary, live] = workflow.split("\n  live-proof:\n");
  for (const job of [ordinary, live]) {
    assert.match(job, /uses: \.\/\.github\/actions\/setup-tests\n      - uses: \.\/\.github\/actions\/setup-browser/);
    assert.doesNotMatch(job, /apt-get|google-chrome|--input-type=module/);
  }
  assert.match(ordinary, /oauth-handoff: "true"/);
  assert.match(live, /oauth-handoff: "true"/);
  const action = await readFile(new URL("../actions/setup-browser/action.yml", import.meta.url), "utf8");
  assert.match(action, /default: "false"/);
  assert.match(action, /ACTION_PATH: \$\{\{ github.action_path \}\}/);
  assert.match(action, /OAUTH_HANDOFF: \$\{\{ inputs.oauth-handoff \}\}/);
  assert.match(action, /run: bash "\$ACTION_PATH\/setup.sh"/);
  assert.match(action, /if: inputs.oauth-handoff == 'true'/);
  assert.match(action, /run: xvfb-run -a node "\$ACTION_PATH\/probe-handoff.mjs"/);
  const setup = await readFile(new URL("../actions/setup-browser/setup.sh", import.meta.url), "utf8");
  assert.match(setup, /apt-get install -y xvfb x11-utils libgtk-3-0 libnss3 libasound2t64 libgbm1/);
  assert.equal(setup.match(/command -v google-chrome \|\| command -v chromium \|\| command -v chromium-browser/g)?.length, 2);
  assert.match(setup, /if \[ -z "\$chrome" \]; then[\s\S]*https:\/\/dl\.google\.com\/linux\/linux_signing_key.pub/);
  assert.match(setup, /gpg --batch --yes --dearmor/);
  assert.match(setup, /signed-by=\/usr\/share\/keyrings\/openwork-google-chrome.gpg/);
  assert.match(setup, /https:\/\/dl\.google\.com\/linux\/chrome\/deb\//);
  assert.match(setup, /apt-get install -y google-chrome-stable/);
  assert.match(setup, /Repair the runner browser installation and rerun this job/);
  assert.match(setup, /"\$chrome" --version/);
  assert.match(setup, /CHROME_BIN=%s\\n' "\$chrome" >> "\$GITHUB_ENV"/);
  assert.doesNotMatch(setup, /curl[^\n]*\|[^\n]*(?:sh|bash)|trusted=yes|allow-unauthenticated/);
  const handoff = setup.split('if [ "$OAUTH_HANDOFF" = true ]; then')[1];
  assert.ok(handoff);
  assert.match(handoff, /sudo install -m 0755 "\$ACTION_PATH\/browser.sh" "\$browser"/);
  assert.match(handoff, /\/usr\/share\/applications\/openwork-proof-browser.desktop/);
  assert.match(handoff, /\/etc\/xdg\/mimeapps.list/);
  for (const scheme of ["http", "https"]) assert.ok(handoff.includes(`x-scheme-handler/${scheme}=openwork-proof-browser.desktop`));
  assert.match(handoff, /BROWSER=%s\\n' "\$browser" >> "\$GITHUB_ENV"/);
  const browser = await readFile(new URL("../actions/setup-browser/browser.sh", import.meta.url), "utf8");
  assert.match(browser, /exec "\$CHROME_BIN" --no-sandbox --disable-dev-shm-usage --no-first-run --no-default-browser-check/);
  assert.ok(browser.includes('--user-data-dir="${OPENWORK_PROOF_BROWSER_PROFILE:-$RUNNER_TEMP/pr-proof-browser}" "$@"'));
});

const packagedSpec = "evals/specs/packaged-activated-launch.e2e.test.ts";

test("packaged specs get their own lane named after their smoke journey", () => {
  const lanes = proofLanes([normalSpec, packagedSpec, "evals/specs/nested/packaged-x.e2e.test.ts"], trustFixture());
  assert.deepEqual(lanes.packagedSpecs, [packagedSpec]);
  assert.deepEqual(lanes.normalSpecs, [normalSpec, "evals/specs/nested/packaged-x.e2e.test.ts"]);
  assert.deepEqual(lanes.liveSpecs, []);
  assert.equal(packagedJourney(packagedSpec), "packaged-activated-launch");
  assert.throws(() => packagedJourney(normalSpec), /Invalid packaged proof spec/);
});

test("controller emits a packaged matrix with the journey and a publisher-compatible key", async () => {
  const trust = trustFixture();
  trust.current.changed_files = 2;
  const result = await runController(trust, [file(normalSpec), file(packagedSpec)]);
  assert.equal(result.status, 0, result.stderr);
  const outputs = Object.fromEntries(result.output.trim().split("\n").map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  assert.equal(outputs.packagedSelected, "true");
  assert.deepEqual(JSON.parse(outputs.matrix).include.map(row => row.spec), [normalSpec]);
  const [row] = JSON.parse(outputs.packagedMatrix).include;
  assert.equal(row.spec, packagedSpec);
  assert.equal(row.journey, "packaged-activated-launch");
  assert.equal(`pr-proof-2-${row.key}`, proofArtifact(packagedSpec, 2));
});

test("workflow runs packaged proof through the packaged smoke runner without secrets", async () => {
  const workflow = await readFile(new URL("../workflows/pr-proof.yml", import.meta.url), "utf8");
  const packaged = workflow.split("\n  packaged-proof:\n")[1]?.split("\n  live-proof:\n")[0];
  assert.ok(packaged);
  assert.match(packaged, /if: needs.select.outputs.packagedSelected == 'true'/);
  assert.match(packaged, /matrix: \$\{\{ fromJSON\(needs.select.outputs.packagedMatrix\) \}\}/);
  assert.match(packaged, /node apps\/desktop\/scripts\/packaged-smoke.mjs --server-built --journey "\$PROOF_JOURNEY"/);
  assert.match(packaged, /name: pr-proof-\$\{\{ github.run_attempt \}\}-\$\{\{ matrix.key \}\}/);
  assert.match(packaged, /if-no-files-found: error/);
  assert.doesNotMatch(packaged, /environment:|secrets\.|OPENAI_API_KEY/);
});

test("native real-model parity is protected and cannot leak into ordinary proof", () => {
  const parity = "evals/specs/engine-live-chat.e2e.test.ts";
  assert.deepEqual(proofLanes([normalSpec, parity], trustFixture()), { normalSpecs: [normalSpec], liveSpecs: [parity], packagedSpecs: [] });
  for (const [, mutate] of untrusted) {
    const trust = trustFixture(); mutate(trust);
    assert.throws(() => proofLanes([parity], trust), /unsupported/);
  }
});
