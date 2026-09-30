import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs, resolveRunEnvironment } from "./evals.mjs";

test("checkpoints are an explicit local opt-in for any spec; the world decides whether it can capture", () => {
  const proof = parseArgs(["web-checkpoint-fork", "--local", "--engine", "v1", "--surface", "web", "--checkpoints"]);
  const result = resolveRunEnvironment(proof, {}, () => { throw new Error("Must not use Daytona"); });
  assert.equal(result.placement, "local");
  assert.equal(result.env.OPENWORK_EVIDENCE_CHECKPOINTS, "1");
  // Any tagged spec may ask; worlds that cannot capture warn at run time instead.
  assert.equal(resolveRunEnvironment(parseArgs(["ordinary", "--local", "--checkpoints"]), {}).env.OPENWORK_EVIDENCE_CHECKPOINTS, "1");
  assert.equal(resolveRunEnvironment(parseArgs(["ordinary", "--local"]), {}).env.OPENWORK_EVIDENCE_CHECKPOINTS, undefined);
  for (const args of [
    ["--checkpoints"], ["web-checkpoint-fork", "--daytona", "--checkpoints"], ["--publish", "--local", "--checkpoints"],
  ]) assert.throws(() => parseArgs(args), /--checkpoints/);
});
