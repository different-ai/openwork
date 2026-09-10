import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
