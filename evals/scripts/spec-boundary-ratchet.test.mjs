import assert from "node:assert/strict";
import test from "node:test";
import { classifySpec, compareBaseline, violations } from "./spec-boundary-ratchet.mjs";

const clean = classifySpec('import { spec } from "@openwork/testkit"; spec.world("demo", () => {});');

test("classifySpec detects product-source imports and URL reads", () => {
  assert.equal(classifySpec('import thing from "../../apps/app/src/thing"; app();').importsProductSource, true);
  assert.equal(classifySpec('export { thing } from "../../packages/thing"; app();').importsProductSource, true);
  assert.equal(classifySpec('new URL("../../ee/apps/den-api", import.meta.url); app();').importsProductSource, true);
  assert.equal(classifySpec('import thing from "../apps/app/src/thing"; app();').importsProductSource, false);
});

test("classifySpec detects filesystem and child-process imports", () => {
  for (const specifier of ["node:fs", "node:fs/promises", "fs", "fs/promises"]) {
    assert.equal(classifySpec(`import "${specifier}"; app();`).importsNodeFs, true);
  }
  for (const specifier of ["node:child_process", "child_process"]) {
    assert.equal(classifySpec(`import { spawn } from "${specifier}"; app();`).importsChildProcess, true);
  }
  const classification = classifySpec('import "node:path"; app();');
  assert.equal(classification.importsNodeFs, false);
  assert.equal(classification.importsChildProcess, false);
});

test("classifySpec recognizes only boundary calls", () => {
  for (const call of ["app()", "chrome()", "server()", "inviteMember()", "faultProxy()", "spec.world()"]) {
    assert.equal(classifySpec(call).crossesBoundary, true);
  }
  assert.equal(classifySpec("helper.app(); const app = true;").crossesBoundary, false);
});

test("classifySpec recognizes world imports as boundaries", () => {
  for (const specifier of ["../../worlds/example.ts", "../worlds/example.ts", "@openwork/world"]) {
    assert.equal(classifySpec(`import "${specifier}";`).crossesBoundary, true);
  }
  assert.equal(classifySpec('import "@openwork/world-extra";').crossesBoundary, false);
});

test("violations returns human-readable reasons", () => {
  assert.deepEqual(violations("bad.test.ts", classifySpec('import "node:fs"; import "node:child_process"; import "../../apps/x";')), [
    "bad.test.ts: imports product source (../../apps/...) — unit tests belong next to the module they test, not in evals/specs",
    "bad.test.ts: reads the filesystem (node:fs) — a spec observes the product, not the repository",
    "bad.test.ts: spawns processes (node:child_process) — wrapping another test runner is not evidence",
    "bad.test.ts: never crosses a product boundary (app()/chrome()/server()/spec.world()) — see write-a-spec",
  ]);
});

test("violations permits filesystem use only when a boundary is crossed", () => {
  assert.deepEqual(violations("e2e.test.ts", classifySpec('import "node:fs/promises"; app();')), []);
  assert.deepEqual(violations("unit.test.ts", classifySpec('import "node:fs/promises";')), [
    "unit.test.ts: reads the filesystem (node:fs) — a spec observes the product, not the repository",
    "unit.test.ts: never crosses a product boundary (app()/chrome()/server()/spec.world()) — see write-a-spec",
  ]);
});

test("compareBaseline accepts a new clean spec", () => {
  assert.deepEqual(compareBaseline({ "clean.test.ts": clean }, []), { errors: [], warnings: [] });
});

test("compareBaseline rejects new product imports and missing boundaries", () => {
  assert.deepEqual(compareBaseline({ "import.test.ts": classifySpec('import "../../apps/x"; app();') }, []).errors, [
    "import.test.ts: imports product source (../../apps/...) — unit tests belong next to the module they test, not in evals/specs",
  ]);
  assert.deepEqual(compareBaseline({ "unit.test.ts": classifySpec("test();") }, []).errors, [
    "unit.test.ts: never crosses a product boundary (app()/chrome()/server()/spec.world()) — see write-a-spec",
  ]);
});

test("compareBaseline grandfathers violations and rejects stale entries", () => {
  const files = { "legacy.test.ts": classifySpec("test();") };
  assert.deepEqual(compareBaseline(files, ["legacy.test.ts"]), { errors: [], warnings: [] });
  assert.deepEqual(compareBaseline({}, ["gone.test.ts"]).errors, [
    "gone.test.ts: baseline is stale; file no longer exists — remove it",
  ]);
});

test("compareBaseline warns when a grandfathered spec becomes clean", () => {
  assert.deepEqual(compareBaseline({ "legacy.test.ts": clean }, ["legacy.test.ts"]), {
    errors: [],
    warnings: ["legacy.test.ts: is clean; remove it from boundary-ratchet.baseline.json"],
  });
});
