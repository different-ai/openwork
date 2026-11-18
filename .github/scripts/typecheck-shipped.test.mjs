import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { isTestFile, selectPackages, typecheckPlan, workspacePackages } from "./typecheck-shipped.mjs";

const packages = workspacePackages();

test("test sources are left out; shipped sources are not", () => {
  for (const path of [
    "apps/desktop/electron/computer-control.test.mjs", "ee/apps/den-web/components/a.test.tsx", "packages/x/src/a.spec.ts",
    "apps/app/tests/boot.test.ts", "ee/apps/den-api/test/api/harness.ts", "packages/x/src/__tests__/a.ts",
    "apps/server/test/a.vitest.test.ts", "packages/x/src/types.test-d.ts", "packages/x/src/fixtures/data.ts",
  ]) assert.equal(isTestFile(path), true, path);
  for (const path of [
    "apps/desktop/electron/main.mjs", "ee/apps/den-web/components/test-connection.tsx", "packages/x/src/latest.ts",
    "ee/apps/den-api/src/routes/model-test.ts", "packages/x/src/testing/index.ts",
  ]) assert.equal(isTestFile(path), false, path);
});

test("the Electron typecheck covers shipped code only", () => {
  const config = readFileSync(new URL("../../apps/desktop/tsconfig.electron.json", import.meta.url), "utf8");
  assert.match(config, /"exclude": \[\s*"electron\/\*\*\/\*\.test\.mjs"\s*\]/);
});

test("a typecheck script becomes its prerequisites and tsc projects", () => {
  assert.deepEqual(typecheckPlan("tsc -p tsconfig.json --noEmit"), { prerequisites: [], projects: ["tsconfig.json"] });
  assert.deepEqual(typecheckPlan("tsc --noEmit"), { prerequisites: [], projects: ["tsconfig.json"] });
  assert.deepEqual(typecheckPlan("tsc -p tsconfig.json --noEmit && tsc -p collabora/tsconfig.json --noEmit"), { prerequisites: [], projects: ["tsconfig.json", "collabora/tsconfig.json"] });
  assert.deepEqual(typecheckPlan("pnpm --filter @openwork/mcp-apps build && tsc -p tsconfig.json --noEmit"), { prerequisites: ["pnpm --filter @openwork/mcp-apps build"], projects: ["tsconfig.json"] });
  assert.deepEqual(typecheckPlan("vitest run"), { prerequisites: [], projects: [] });
  assert.throws(() => typecheckPlan("tsc --noEmit && node check.mjs"), /Unsupported/);
});

test("every package typecheck script is supported", () => {
  for (const pkg of packages.values()) {
    if (pkg.scripts.typecheck && pkg.name !== "@openwork/sdk") assert.doesNotThrow(() => typecheckPlan(pkg.scripts.typecheck), pkg.name);
  }
  // The Den API is typechecked (its types come from a built dependency).
  assert.deepEqual(typecheckPlan(packages.get("@openwork-ee/den-api").scripts.typecheck).projects, ["tsconfig.json"]);
});

test("a change typechecks its package and every package that depends on it", () => {
  const app = selectPackages(["apps/app/src/index.ts"], packages);
  assert.ok(app.has("@openwork/app"));
  assert.equal(app.has("@openwork-ee/den-api"), false);
  assert.equal(app.has("@openwork/desktop"), false, "Electron main does not import the app UI");
  const types = selectPackages(["packages/types/src/index.ts"], packages);
  for (const name of ["@openwork/types", "@openwork/app", "openwork-server", "@openwork-ee/den-api", "@openwork/desktop"]) assert.ok(types.has(name), name);
  const denApi = selectPackages(["ee/apps/den-api/src/app.ts"], packages);
  assert.ok(denApi.has("@openwork-ee/den-api"));
  assert.equal(denApi.has("@openwork/app"), false);
  assert.ok(selectPackages(["apps/desktop/electron/main.mjs"], packages).has("@openwork/desktop"));
});

test("docs, evals and CI-only changes typecheck nothing; shared or unknown inputs typecheck everything", () => {
  for (const files of [["docs/guide.md"], ["evals/specs/a.e2e.test.ts"], [".github/workflows/codeql.yml"], []]) {
    assert.equal(selectPackages(files, packages).size, 0, JSON.stringify(files));
  }
  const all = packages.size;
  for (const files of [null, ["pnpm-lock.yaml"], ["package.json"], ["patches/x.patch"], ["tsconfig.declarations.json"], [".github/scripts/typecheck-shipped.mjs"], [".github/workflows/quick-check.yml"]]) {
    assert.equal(selectPackages(files, packages).size, all, JSON.stringify(files));
  }
});
