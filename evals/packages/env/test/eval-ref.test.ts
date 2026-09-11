import assert from "node:assert/strict";
import test from "node:test";
import { daytonaPlacement, resolveEvalRef, resolveSandboxRef } from "../src/eval-ref.ts";

test("resolveEvalRef prefers OPENWORK_EVAL_REF, then GITHUB_SHA, then dev", () => {
  assert.equal(resolveEvalRef({ OPENWORK_EVAL_REF: " feature-ref ", GITHUB_SHA: "abc" }), "feature-ref");
  assert.equal(resolveEvalRef({ GITHUB_SHA: "abc" }), "abc");
  assert.equal(resolveEvalRef({}), "dev");
});

test("resolveSandboxRef names the built ref only under Daytona placement", () => {
  assert.equal(daytonaPlacement({ OPENWORK_WORLD_PLACE: "daytona" }), true);
  assert.equal(daytonaPlacement({ OPENWORK_EVAL_DAYTONA: "1" }), true);
  assert.equal(daytonaPlacement({ OPENWORK_WORLD_PLACE: "local", OPENWORK_EVAL_DAYTONA: "1" }), false);
  assert.equal(daytonaPlacement({}), false);
  assert.equal(resolveSandboxRef({ OPENWORK_WORLD_PLACE: "daytona", OPENWORK_EVAL_REF: "abc1234" }), "abc1234");
  assert.equal(resolveSandboxRef({ OPENWORK_WORLD_PLACE: "daytona" }), "dev");
  assert.equal(resolveSandboxRef({ OPENWORK_EVAL_REF: "abc1234" }), undefined);
});
