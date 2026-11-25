import assert from "node:assert/strict";
import { test } from "node:test";
import { parityProofName, parityProofPlan, runParityProof } from "./run-parity-proof.mjs";

test("CI provisions pinned binaries before a v2-only journey", async () => {
  const spec = "evals/core/agent-permissions.e2e.test.ts";
  assert.equal(parityProofName(spec), "agent-permissions.e2e.test.ts");
  assert.deepEqual(parityProofPlan(spec), [{ engine: "v2", args: ["evals/bin/evals.mjs", "agent-permissions.e2e.test.ts", "--local", "--engine", "v2"] }]);
  const order = [];
  const result = await runParityProof(spec, {
    prepare: async () => { order.push("verified tools"); return { OPENWORK_OPENCODE_BIN: "/fixture/pinned-v1", OPENWORK_OPENCODE2_BIN: "/fixture/pinned-v2" }; },
    run: async (args, env) => {
      order.push("journey");
      assert.ok(args.includes("v2"));
      assert.equal(env.OPENWORK_OPENCODE_BIN, "/fixture/pinned-v1");
      assert.equal(env.OPENWORK_OPENCODE2_BIN, "/fixture/pinned-v2");
      assert.equal(env.OPENWORK_EVAL_ENGINE, "v2");
      return 0;
    },
  });
  assert.equal(result, 0);
  assert.deepEqual(order, ["verified tools", "journey"]);
});

test("a failed or incomplete run cannot become a passing CI step", async () => {
  for (const code of [1, 2]) {
    assert.equal(await runParityProof("agent-permissions.e2e.test.ts", {
      prepare: async () => ({}), run: async () => code,
    }), 1);
  }
});

test("existing connector parity retains both v1 and v2 execution", () => {
  assert.deepEqual(parityProofPlan("evals/core/agent-connection-journey.e2e.test.ts").map(item => item.engine), ["v1", "v2"]);
});
