import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parallelSuite, planSuite, suiteWorkerCount } from "./stack-suite.ts";

function fixtures(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "runner-plan-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return (name: string, source: string) => {
    const file = join(root, name);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, `import { spec } from "@openwork/testkit";\n${source}`);
    return file;
  };
}

const app = `const test = spec.world("app", { resources: { surfaces: ["appWeb"], services: ["mock"] } }); test("WEB-01 browser", () => {});`;
const native = `const native = spec.world("native", { resources: { surfaces: ["desktop"], services: ["den"], nativeReason: "OS integration" } }); native("NATIVE-01 native", () => {});`;

test("CI trust guard blocks planner dependencies and install inputs, and fails closed", t => {
  const file = fixtures(t);
  const workflow = readFileSync(new URL("../../.github/workflows/daytona-e2e.yml", import.meta.url), "utf8");
  const guard = workflow.match(/          changed_file_count=[\s\S]*?echo "authorized=true" >> "\$GITHUB_OUTPUT"/);
  assert.ok(guard);
  assert.match(guard[0], /\.previous_filename \/\/ empty/);
  const run = (paths: string[], count = "1", failure = "0") => {
    const output = file("guard-output", "");
    writeFileSync(output, "");
    const result = spawnSync("bash", ["-c", `set -euo pipefail
      gh() {
        if [[ "$*" == *".changed_files"* ]]; then printf '%s\\n' "$GH_COUNT"; return; fi
        if [ "$GH_FAILURE" = "1" ]; then return 42; fi
        printf '%s\\n' "$GH_FILES"
      }
      ${guard[0]}`], {
      encoding: "utf8",
      env: { ...process.env, REPO: "internal/repo", PR: "1", GH_FILES: paths.join("\n"), GH_COUNT: count, GH_FAILURE: failure, GITHUB_OUTPUT: output },
    });
    return { ...result, authorization: readFileSync(output, "utf8") };
  };
  for (const path of [
    "evals/scripts/world-plan.ts", "evals/bin/test-files.mjs", "evals/packages/env/src/world-resources.ts",
    ".github/workflows/daytona-e2e.yml", "warden.toml", ".warden/README.md", ".agents/skills/review/SKILL.md",
    "package.json", "evals/package.json", "evals/scripts/package.json", "evals/packages/env/src/package.json",
    "pnpm-lock.yaml", "evals/pnpm-lock.yaml", "pnpm-workspace.yaml", "evals/pnpm-workspace.yaml",
    ".npmrc", "evals/.npmrc", ".pnpmfile.cjs", "evals/.pnpmfile.cjs", "evals/pnpmfile.cjs",
    "evals/tsconfig.json", "tsconfig.base.json", "patches/dependency.patch", "evals/node_modules", ".gitattributes",
  ]) {
    const result = run([path]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.authorization, "authorized=false\n", path);
    assert.match(result.stdout, /manual workflow_dispatch/);
  }
  const allowed = run(["evals/specs/example.e2e.test.ts", "scenarios/example/e2e.test.ts", "apps/app/src/index.ts"]);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.authorization, "authorized=true\n");
  for (const count of ["3001", "null"]) assert.equal(run([], count).authorization, "authorized=false\n");
  const failed = run([], "1", "1");
  assert.equal(failed.status, 42);
  assert.equal(failed.authorization, "");
});

test("both CI jobs name artifacts with artifactId while retaining spec paths in results", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/daytona-e2e.yml", import.meta.url), "utf8");
  for (const job of ["e2e", "local-journey"]) {
    const body = workflow.split(`\n  ${job}:\n`)[1]?.split(/\n  [a-z-]+:\n/)[0];
    assert.ok(body, job);
    assert.match(body, /name: journey-evidence-\$\{\{ matrix\.journey\.artifactId \}\}/);
    assert.match(body, /name: journey-result-\$\{\{ matrix\.journey\.artifactId \}\}/);
    assert.match(body, /SPEC_SLUG: \$\{\{ matrix\.journey\.spec \}\}/);
    assert.doesNotMatch(body, /name: journey-(?:evidence|result)-\$\{\{ matrix\.journey\.spec/);
  }
});

test("global setup uses Vitest's project paths, effective name pattern and sequencer shard", t => {
  const file = fixtures(t);
  const selected = file("scenarios/example/e2e.test.ts", `${app}\n${native}`);
  const otherProject = file("pr.test.ts", "this should never be planned");
  const otherShard = file("other-shard.e2e.test.ts", app);
  const setupUrl = new URL("./prepare-stack.ts", import.meta.url).href;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
    import setup from ${JSON.stringify(setupUrl)};
    const selected = ${JSON.stringify(selected)};
    const project = {
      config: {},
      vitest: {
        config: {},
        state: { getPaths: () => [selected, ${JSON.stringify(otherProject)}] },
        getModuleSpecifications: file => [{ moduleId: file, project: file === selected ? project : {} }],
        getGlobalTestNamePattern: () => /^WEB-01(?:\\s|$)/,
      },
    };
    console.error = message => console.log(message);
    await setup(project);
    project.vitest.state.getPaths = () => [selected, ${JSON.stringify(otherProject)}, ${JSON.stringify(otherShard)}];
    project.vitest.config = {
      shard: { index: 1, count: 2 },
      sequence: { sequencer: class {
        shard(specs) {
          if (specs.length !== 3) throw new Error("Shard must see every project's selection");
          return specs.filter(spec => spec.moduleId !== ${JSON.stringify(otherShard)});
        }
      } },
    };
    project.vitest.getModuleSpecifications = file => [{ moduleId: file, project: file === ${JSON.stringify(otherProject)} ? {} : project }];
    await setup(project);
  `], { encoding: "utf8", env: { ...process.env, OPENWORK_EVAL_APP_SURFACE: "web" } });
  assert.match(output, /scenarios\/example\/e2e.test.ts/);
  assert.match(output, /surfaces=\[appWeb\]; services=\[mock\]/);
  assert.doesNotMatch(output, /pr.test.ts|other-shard|nativeReason/);
});

test("CI preparation script separates appWeb, Den, native and legacy resources", t => {
  const file = fixtures(t);
  const workflow = readFileSync(new URL("../../.github/workflows/daytona-e2e.yml", import.meta.url), "utf8");
  const script = workflow.match(/node --input-type=module <<'NODE'\n([\s\S]*?)\n\s+NODE/);
  assert.ok(script);
  const cases = [
    { resources: { surfaces: ["appWeb"], services: ["mock"] }, expected: "den=false\nnative=false\n" },
    { resources: { surfaces: ["web"], services: ["den"] }, expected: "den=true\nnative=false\n" },
    { resources: { surfaces: ["desktop"], services: ["mock"] }, expected: "den=false\nnative=true\n" },
    { resources: null, expected: "den=true\nnative=true\n" },
  ];
  for (const [index, entry] of cases.entries()) {
    const output = file(`output-${index}`, "");
    writeFileSync(output, "");
    execFileSync(process.execPath, ["--input-type=module", "-e", script[1]], {
      env: { ...process.env, JOURNEY: JSON.stringify({ worlds: [{ resources: entry.resources }] }), GITHUB_OUTPUT: output },
    });
    assert.equal(readFileSync(output, "utf8"), entry.expected);
  }
});

test("selected multi-file appWeb and scenario plans never prepare Den/native", t => {
  const file = fixtures(t);
  const plan = planSuite([file("specs/a.e2e.test.ts", app), file("scenarios/example/e2e.test.ts", app)]);
  assert.deepEqual(plan.surfaces, ["appWeb"]);
  assert.deepEqual(plan.services, ["mock"]);
  assert.equal(plan.worlds.length, 2);
  assert.equal(plan.preparation, "none");
  assert.match(plan.diagnostic, /lazy per-world allocation/);
  assert.match(plan.diagnostic, /scenarios\/example\/e2e.test.ts/);
});

test("testNamePattern selects worlds before resource aggregation and surface validation", t => {
  const file = fixtures(t);
  const selected = file("mixed.e2e.test.ts", `${app}\n${native}`);
  const plan = planSuite([selected], { pattern: /^WEB-01(?:\s|$)/, surface: "web" });
  assert.deepEqual(plan.surfaces, ["appWeb"]);
  assert.deepEqual(plan.services, ["mock"]);
  assert.throws(() => planSuite([selected], { surface: "web" }), /conflicts/);
  assert.throws(() => planSuite([selected], { surface: "typo" }), /Unknown app surface/);
  assert.throws(() => planSuite([selected], { pattern: /missing/ }), /empty provisioning plan/);
  assert.throws(() => planSuite([selected], { pattern: /web/i }), /regex flags/);
});

test("undeclared legacy stays explicit, unknown and lazy", t => {
  const file = fixtures(t);
  const selected = file("legacy.e2e.test.ts", `const test = spec.world("old"); test("legacy", () => {});`);
  const plan = planSuite([selected]);
  assert.deepEqual(plan.surfaces, []);
  assert.deepEqual(plan.services, []);
  assert.equal(plan.legacy.length, 1);
  assert.equal(plan.preparation, "none");
  assert.match(plan.diagnostic, /resources=unknown; legacy; lazy provision only/);
  assert.throws(() => planSuite([selected], { surface: "web" }), /legacy\/unresolved/);
});

test("mixed native plans remain lazy and print their native reason", t => {
  const file = fixtures(t);
  const plan = planSuite([file("mixed.e2e.test.ts", `${app}\n${native}`)]);
  assert.deepEqual(plan.surfaces, ["appWeb", "desktop"]);
  assert.deepEqual(plan.services, ["mock", "den"]);
  assert.equal(plan.preparation, "none");
  assert.match(plan.diagnostic, /nativeReason=OS integration/);
});

test("worker limits and selection option handling preserve placement concurrency", () => {
  const argv = ["vitest", "specs/a.e2e.test.ts", "--reporter", "verbose", "--config", "vitest.ts", "--project", "e2e", "-t", "pretend.test.ts"];
  assert.equal(parallelSuite(argv), false);
  assert.equal(parallelSuite([...argv, "specs/b.e2e.test.ts"]), true);
  assert.equal(parallelSuite(["vitest", "specs/*.e2e.test.ts"]), true);
  assert.equal(parallelSuite(["vitest"]), true);
  assert.equal(suiteWorkerCount(argv, { OPENWORK_EVAL_DAYTONA: "1" }), 1);
  assert.equal(suiteWorkerCount(["vitest"], { OPENWORK_EVAL_DAYTONA: "1" }), 2);
  assert.equal(suiteWorkerCount(["vitest"], {}), 3);
  assert.equal(suiteWorkerCount(["vitest"], { OPENWORK_EVAL_MAX_WORKERS: "4" }), 4);
});
