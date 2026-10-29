import assert from "node:assert/strict";
import { test } from "node:test";
import { evidenceRuntimeFingerprint, fastPathDecision, runtimeChanges } from "@openwork/freestyle/evidence-builder";

function tree(path: string, sha: string) {
  return [{ path, sha, type: "blob" }, { path: "apps/app/src/app.tsx", sha: "unchanged", type: "blob" }];
}

for (const path of ["scripts/check-ui-guardrails.mjs", "scripts/check-ui-guardrails.test.mjs", "scripts/ui-guardrails-baseline.json"]) {
  test(`${path} cannot invalidate the guest runtime or force a full world build`, () => {
    const before = tree(path, "before");
    const after = tree(path, "after");
    assert.equal(evidenceRuntimeFingerprint(before), evidenceRuntimeFingerprint(after));
    assert.deepEqual(runtimeChanges(before, after), []);
    assert.equal(fastPathDecision(runtimeChanges(before, after)).fast, true);
  });
}

for (const path of ["scripts/build.mjs", "scripts/build-workspace-dependencies.mjs", "scripts/ui-guardrails-runtime.json", "packages/features/src/registry.ts", "evals/packages/hosts/src/index.ts"]) {
  test(`${path} remains a runtime input and forces a full world build`, () => {
    const before = tree(path, "before");
    const after = tree(path, "after");
    assert.notEqual(evidenceRuntimeFingerprint(before), evidenceRuntimeFingerprint(after));
    assert.deepEqual(runtimeChanges(before, after), [path]);
    assert.equal(fastPathDecision(runtimeChanges(before, after)).fast, false);
  });
}

test("an application change still changes the fingerprint and is applied live", () => {
  const before = tree("apps/app/src/screen.tsx", "before");
  const after = tree("apps/app/src/screen.tsx", "after");
  assert.notEqual(evidenceRuntimeFingerprint(before), evidenceRuntimeFingerprint(after));
  assert.deepEqual(runtimeChanges(before, after), ["apps/app/src/screen.tsx"]);
  assert.equal(fastPathDecision(runtimeChanges(before, after)).fast, true);
});
