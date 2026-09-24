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

test("the native v2 skill contract explicitly selects v2", () => {
  const plan = parityProofPlan("evals/specs/opencode-v2-skill-jit.e2e.test.ts");
  assert.equal(plan.length, 1);
  assert.equal(plan[0].engine, "v2");
  assert.deepEqual(plan[0].args.slice(-2), ["--engine", "v2"]);
});

test("the native model filter regression explicitly selects v2", () => {
  assert.deepEqual(parityProofPlan("evals/specs/engine-provider-filters.e2e.test.ts").map(item => item.engine), ["v2"]);
});

test("session home proof runs the pinned v2 engine", () => {
  assert.deepEqual(parityProofPlan("evals/specs/opencode-v2-session-home.e2e.test.ts"), [{
    engine: "v2", args: ["evals/bin/evals.mjs", "specs/opencode-v2-session-home.e2e.test.ts", "--local", "--engine", "v2"],
  }]);
});
