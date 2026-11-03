import assert from "node:assert/strict";
import { test } from "node:test";
import { parityProofName, parityProofPlan, runParityProof } from "./run-parity-proof.mjs";

test("CI provisions pinned binaries before the v2-only live-provider lifecycle proof", async () => {
  const spec = "evals/proofs/live-provider-sync.proof.test.ts";
  assert.equal(parityProofName(spec), "live-provider-sync.proof.test.ts");
  assert.deepEqual(parityProofPlan(spec), [{ engine: "v2", args: ["evals/bin/evals.mjs", "live-provider-sync.proof.test.ts", "--local", "--engine", "v2"] }]);
  const order = [];
  const result = await runParityProof(spec, {
    prepare: async () => { order.push("verified tools"); return { OPENWORK_OPENCODE_BIN: "/fixture/pinned-v1", OPENWORK_OPENCODE2_BIN: "/fixture/pinned-v2" }; },
    run: async (args, env) => {
      order.push("cold-profile proof");
      assert.ok(args.includes("v2"));
      assert.equal(env.OPENWORK_OPENCODE_BIN, "/fixture/pinned-v1");
      assert.equal(env.OPENWORK_OPENCODE2_BIN, "/fixture/pinned-v2");
      assert.equal(env.OPENWORK_EVAL_ENGINE, "v2");
      return 0;
    },
  });
  assert.equal(result, 0);
  assert.deepEqual(order, ["verified tools", "cold-profile proof"]);
});

test("a failed or incomplete live proof cannot become a passing CI preparation step", async () => {
  for (const code of [1, 2]) {
    assert.equal(await runParityProof("live-provider-sync.proof.test.ts", {
      prepare: async () => ({}), run: async () => code,
    }), 1);
  }
});

test("the v2 Drive upload proof runs on the v2 engine with pinned binaries, not as a skipped legacy proof", () => {
  assert.deepEqual(parityProofPlan("evals/proofs/opencode-v2-drive-upload.proof.test.ts"), [
    { engine: "v2", args: ["evals/bin/evals.mjs", "opencode-v2-drive-upload.proof.test.ts", "--local", "--engine", "v2"] },
  ]);
});

test("the native skill denial proof runs on the v2 engine, not as a legacy proof", () => {
  assert.deepEqual(parityProofPlan("evals/proofs/opencode-v2-skill-jit.proof.test.ts"), [
    { engine: "v2", args: ["evals/bin/evals.mjs", "opencode-v2-skill-jit.proof.test.ts", "--local", "--engine", "v2"] },
  ]);
});

test("existing connector parity retains both v1 and v2 execution", () => {
  assert.deepEqual(parityProofPlan("evals/core/agent-connection-journey.e2e.test.ts").map(item => item.engine), ["v1", "v2"]);
});
