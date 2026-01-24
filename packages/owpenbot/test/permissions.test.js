import assert from "node:assert/strict";
import test from "node:test";

import { buildPermissionRules } from "../dist/opencode.js";

test("buildPermissionRules for deny returns blanket deny", () => {
  const rules = buildPermissionRules("deny");
  assert.deepEqual(rules, [
    {
      permission: "*",
      pattern: "*",
      action: "deny",
    },
  ]);
});

test("buildPermissionRules for allow returns blanket allow", () => {
  const rules = buildPermissionRules("allow");
  assert.deepEqual(rules, [
    {
      permission: "*",
      pattern: "*",
      action: "allow",
    },
  ]);
});

test("buildPermissionRules for readonly denies risky tools", () => {
  const rules = buildPermissionRules("readonly");

  // Should start with an allow-all baseline.
  assert.deepEqual(rules[0], {
    permission: "*",
    pattern: "*",
    action: "allow",
  });

  const denyMap = new Map(rules.slice(1).map((r) => [r.permission, r.action]));

  for (const perm of ["bash", "edit", "task", "todowrite", "external_directory", "webfetch"]) {
    assert.equal(
      denyMap.get(perm),
      "deny",
      `expected readonly mode to deny permission ${perm}`,
    );
  }
});