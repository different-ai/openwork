// Self-test for the Den module boundary tooling (W0-08). Run: pnpm boundaries:selftest
//
// 0. Checks fixture-graph.json is generated from fixture-registry.yaml, and that the generator
//    rejects registries that break the D44 id rules (registries-bad/*.yaml).
// 1. Cruises the fixture tree with the fixture graph in report mode and in enforced mode and
//    asserts the exact { rule, from, to, severity } set. The fixture has groups (D44): `kit`
//    (top level, like `org`) and `alpha.ns` (inside a module, like `library.connectors.native`).
// 2. Runs the folder <-> registry check against a good and a bad folder tree.
// 3. Runs the ratchet comparison against a synthetic growth, shrink and Core flip.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkModuleFolders } from "../check-module-folders.mjs";
import { compareBaselines } from "../check-boundary-ratchet.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const prefix = "scripts/modules/selftest/fixture/";
const depcruiseBin = resolve(repoRoot, "node_modules/dependency-cruiser/bin/dependency-cruiser.mjs");
const tsxBin = resolve(repoRoot, "node_modules/tsx/dist/cli.mjs");
const generator = resolve(here, "../generate-module-graph.mts");
const graph = JSON.parse(readFileSync(resolve(here, "fixture-graph.json"), "utf8"));

const API = "ee/apps/den-api/src";
const WEB = "ee/apps/den-web/app/(den)/dashboard";
const DB = "ee/packages/den-db/src";
const FEATURES = "packages/features/src";

// [rule, from, to, severity in report mode]. Enforced mode turns every severity to "error"
// except module-db-barrel, which is report-only by design.
const EXPECTED = [
  // Core -> module internals (den-api) and Core -> module public (den-web, non-route file).
  ["core-imports-module", `${API}/core.ts`, `${API}/modules/alpha/internal.ts`, "warn"],
  ["core-imports-module", `${API}/core.ts`, `${API}/modules/kit/one/internal.ts`, "warn"],
  ["core-imports-module", `${WEB}/_lib/nav.ts`, `${WEB}/_modules/alpha/public.tsx`, "warn"],
  // Route file -> module internals. (Route file -> public.tsx is allowed.)
  ["core-route-imports-module-internals", `${WEB}/alpha/page.tsx`, `${WEB}/_modules/alpha/screen.tsx`, "warn"],
  // Framework -> module internals. Always an error.
  ["framework-imports-manifest-only", `${API}/modules/registry.ts`, `${API}/modules/beta/internal.ts`, "error"],
  // Parent -> sub-module (D6).
  ["module:alpha", `${API}/modules/alpha/service.ts`, `${API}/modules/alpha/child/internal.ts`, "warn"],
  // Parent -> sub-module behind a group folder (alpha/ns/ is the group alpha.ns, D44).
  ["module:alpha", `${API}/modules/alpha/service.ts`, `${API}/modules/alpha/ns/leaf/internal.ts`, "warn"],
  // Sub-module -> parent internals. (Sub-module -> parent public.ts is allowed.)
  ["module:alpha.child", `${API}/modules/alpha/child/uses-parent.ts`, `${API}/modules/alpha/internal.ts`, "warn"],
  // The nearest module ancestor is the parent (alpha), not the group: alpha/public.ts is allowed,
  // alpha internals are not.
  ["module:alpha.ns.leaf", `${API}/modules/alpha/ns/leaf/uses-parent.ts`, `${API}/modules/alpha/internal.ts`, "warn"],
  // Same group, no declared dependency: kit.one -> kit.two public is a violation (groups imply
  // nothing). kit.two hard-depends on kit.one: public is allowed, internals are not.
  ["module:kit.one", `${API}/modules/kit/one/uses-sibling.ts`, `${API}/modules/kit/two/public.ts`, "warn"],
  ["module:kit.two", `${API}/modules/kit/two/uses-one.ts`, `${API}/modules/kit/one/internal.ts`, "warn"],
  // beta soft-depends on alpha: alpha internals via a .js specifier, a type-only import of
  // alpha internals, alpha's sub-module (not declared) and delta (not declared).
  ["module:beta", `${API}/modules/beta/uses-alpha.ts`, `${API}/modules/alpha/internal.ts`, "warn"],
  ["module:beta", `${API}/modules/beta/uses-alpha.ts`, `${API}/modules/alpha/types.ts`, "warn"],
  ["module:beta", `${API}/modules/beta/uses-alpha.ts`, `${API}/modules/alpha/child/public.ts`, "warn"],
  ["module:beta", `${API}/modules/beta/uses-alpha.ts`, `${API}/modules/delta/public.ts`, "warn"],
  // den-db schema sibling internals. (beta -> alpha/index.ts is allowed.)
  ["module:beta", `${DB}/schema/beta/table.ts`, `${DB}/schema/alpha/table.ts`, "warn"],
  // den-api module -> undeclared den-db module folder; tests inside a module are covered too.
  ["module-db-boundary:beta", `${API}/modules/beta/db.ts`, `${DB}/schema/delta/index.ts`, "warn"],
  ["module-db-boundary:beta", `${API}/modules/beta/db.test.ts`, `${DB}/schema/delta/index.ts`, "warn"],
  ["module-db-barrel", `${API}/modules/beta/db.ts`, `${DB}/schema.ts`, "warn"],
  // Core/shared package (@openwork/features) -> any module folder, public entry included.
  // Always an error. (Core -> shared and module -> shared are allowed.)
  ["shared-imports-module", `${FEATURES}/leaks.ts`, `${API}/modules/alpha/public.ts`, "error"],
  ["shared-imports-module", `${FEATURES}/leaks.ts`, `${API}/modules/alpha/internal.ts`, "error"],
];

const failures = [];

function runGenerator(args) {
  return spawnSync(process.execPath, [tsxBin, generator, ...args], { cwd: repoRoot, encoding: "utf8" });
}

const fixtureGraph = runGenerator([
  "--bootstrap", "scripts/modules/selftest/fixture-registry.yaml",
  "--output", "scripts/modules/selftest/fixture-graph.json",
  "--check",
]);
if (fixtureGraph.status !== 0) failures.push(`fixture-graph.json is not generated from fixture-registry.yaml:\n  ${fixtureGraph.stderr.trim()}`);

// Each bad registry must fail with this message fragment.
const BAD_REGISTRIES = {
  "depends-on-group.yaml": "depends on group kit",
  "group-as-parent.yaml": "kit.one: parent must be the nearest module ancestor null, got kit",
  "group-is-module.yaml": "kit is both a group and a module",
  "missing-group.yaml": "kit.one: prefix kit is neither a module nor a group",
  "skips-module-parent.yaml": "alpha.ns.leaf: parent must be the nearest module ancestor alpha, got null",
  "too-deep.yaml": "more than 4 segments",
};
const badDirectory = resolve(here, "registries-bad");
for (const file of readdirSync(badDirectory)) {
  if (!(file in BAD_REGISTRIES)) failures.push(`registries-bad/${file} has no expected error in run.mjs`);
}
for (const [file, fragment] of Object.entries(BAD_REGISTRIES)) {
  const result = runGenerator(["--bootstrap", resolve(badDirectory, file), "--output", resolve(badDirectory, "unused.json"), "--check"]);
  if (result.status === 0 || !result.stderr.includes(fragment)) {
    failures.push(`generator on registries-bad/${file}: expected a failure containing "${fragment}", got status ${result.status}:\n  ${result.stderr.trim()}`);
  }
}

function key([rule, from, to, severity]) {
  return `${severity} ${rule}: ${from} -> ${to}`;
}

function cruise(mode) {
  const result = spawnSync(
    process.execPath,
    [depcruiseBin, "--config", "scripts/modules/selftest/depcruise.config.mjs", "--output-type", "json", "scripts/modules/selftest/fixture"],
    { cwd: repoRoot, encoding: "utf8", env: { ...process.env, BOUNDARY_SELFTEST_MODE: mode }, maxBuffer: 64 * 1024 * 1024 },
  );
  if (!result.stdout) throw new Error(`depcruise produced no output (${mode}):\n${result.stderr}`);
  const output = JSON.parse(result.stdout);
  const unresolved = output.modules.flatMap((module) =>
    module.dependencies.filter((dependency) => dependency.couldNotResolve).map((dependency) => `${module.source} -> ${dependency.module}`));
  if (unresolved.length > 0) failures.push(`${mode}: unresolved imports in the fixture:\n  ${unresolved.join("\n  ")}`);
  return output.summary.violations.map((violation) => [
    violation.rule.name,
    violation.from.slice(prefix.length),
    violation.to.slice(prefix.length),
    violation.rule.severity,
  ]);
}

function assertSameSet(label, actual, expected) {
  const actualKeys = new Set(actual.map(key));
  const expectedKeys = new Set(expected.map(key));
  const missing = [...expectedKeys].filter((item) => !actualKeys.has(item));
  const unexpected = [...actualKeys].filter((item) => !expectedKeys.has(item));
  if (missing.length > 0 || unexpected.length > 0) {
    failures.push(`${label}:\n  missing:\n    ${missing.join("\n    ") || "(none)"}\n  unexpected:\n    ${unexpected.join("\n    ") || "(none)"}`);
  }
}

assertSameSet("report mode", cruise("warn"), EXPECTED);
assertSameSet(
  "enforced mode",
  cruise("enforced"),
  EXPECTED.map(([rule, from, to]) => [rule, from, to, rule === "module-db-barrel" ? "warn" : "error"]),
);

function assertErrors(label, errors, expectedFragments) {
  const missing = expectedFragments.filter((fragment) => !errors.some((error) => error.includes(fragment)));
  if (missing.length > 0 || errors.length !== expectedFragments.length) {
    failures.push(`${label}: expected ${expectedFragments.length} errors matching ${JSON.stringify(expectedFragments)}, got:\n  ${errors.join("\n  ") || "(none)"}`);
  }
}

const enforcedNone = { core: false, modules: [] };
assertErrors("folder check (good tree)", checkModuleFolders({ repoRoot, prefix, graph, enforced: enforcedNone, baseline: [] }), []);
assertErrors(
  "folder check (bad tree)",
  checkModuleFolders({
    repoRoot,
    prefix: "scripts/modules/selftest/folders-bad/",
    graph,
    enforced: { core: false, modules: ["beta", "alpha", "unknownModule"] },
    baseline: [{ type: "dependency", from: `${prefix}${API}/modules/beta/uses-alpha.ts`, to: `${prefix}${API}/modules/delta/public.ts`, rule: { name: "module:beta", severity: "error" } }],
  }),
  [
    "modules/child",
    "retired module id analytics",
    "_modules/unknown",
    "modules/kit: is the folder of group kit",
    "modules/kit/helper.ts: is inside group kit",
    "modules/kit/three: has a module.ts",
    "_modules/kit/stray: is inside group kit",
    "schema/alpha/ns/index.ts: is inside group alpha.ns",
    "not sorted",
    "unknownModule",
    "beta is enforced",
  ],
);

const entry = (rule, from, to) => ({ type: "dependency", from, to, rule: { name: rule, severity: "error" } });
const known = entry("module:beta", "a.ts", "b.ts");
const coreEntry = entry("core-imports-module", "c.ts", "d.ts");
const noFlip = { baseEnforced: enforcedNone, headEnforced: enforcedNone };
assertErrors("ratchet (unchanged)", compareBaselines({ base: [known], head: [known], ...noFlip }).errors, []);
assertErrors("ratchet (shrink)", compareBaselines({ base: [known], head: [], ...noFlip }).errors, []);
assertErrors("ratchet (growth)", compareBaselines({ base: [], head: [known], ...noFlip }).errors, ["module:beta: a.ts -> b.ts"]);
assertErrors(
  "ratchet (core flip may add only Core entries)",
  compareBaselines({ base: [], head: [known, coreEntry], baseEnforced: enforcedNone, headEnforced: { core: true, modules: [] } }).errors,
  ["module:beta: a.ts -> b.ts"],
);
const shrinkHint = compareBaselines({ base: [known], head: [known], current: [], ...noFlip }).warnings;
assertErrors("ratchet (clean entries hint)", shrinkHint, ["now clean"]);

if (failures.length > 0) {
  console.error(`boundaries selftest failed:\n- ${failures.join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.log(`boundaries selftest: fixture graph generated, ${Object.keys(BAD_REGISTRIES).length} bad registries rejected, ${EXPECTED.length} expected violations matched in report and enforced mode; folder and ratchet checks behave`);
}
