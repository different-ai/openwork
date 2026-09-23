import test from "node:test";
import assert from "node:assert/strict";
import { parityProofPlan, runParityProof } from "./run-parity-proof.mjs";

test("parity proof explicitly selects both engines for complete specs", () => {
  const plan = parityProofPlan("evals/specs/engine-live-chat.e2e.test.ts");
  assert.deepEqual(plan.map(item => item.engine), ["v1", "v2"]);
  for (const item of plan) {
    assert.deepEqual(item.args, ["evals/bin/evals.mjs", "specs/engine-live-chat.e2e.test.ts", "--local", "--engine", item.engine]);
  }
  assert.throws(() => parityProofPlan("evals/specs/unreviewed.e2e.test.ts"), /Unsupported/);
});

test("either engine failing or skipping keeps proof red; both always run", async () => {
  for (const codes of [[0, 0], [1, 0], [0, 1], [2, 0], [0, 2]]) {
    const calls = [];
    const result = await runParityProof("evals/specs/engine-gateway-parity.e2e.test.ts", {
      prepare: async () => ({ OPENWORK_OPENCODE_BIN: "/pinned/v1", OPENWORK_OPENCODE2_BIN: "/pinned/v2" }),
      run: async (args, env) => {
        assert.equal(env.OPENWORK_OPENCODE_BIN, "/pinned/v1");
        assert.equal(env.OPENWORK_OPENCODE2_BIN, "/pinned/v2");
        assert.equal(env.OPENWORK_EVAL_ENGINE, args.at(-1));
        calls.push(args); return codes[calls.length - 1];
      },
    });
    assert.equal(calls.length, 2);
    assert.equal(result, codes.every(code => code === 0) ? 0 : 1);
  }
});
