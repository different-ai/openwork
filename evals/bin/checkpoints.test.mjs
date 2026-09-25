import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs, resolveRunEnvironment } from "./evals.mjs";

test("checkpoint option is explicit, bounded to the web proof, and keeps the controller local", () => {
  const options = parseArgs(["web-checkpoint-fork", "--local", "--engine", "v1", "--surface", "web", "--checkpoints"]);
  const result = resolveRunEnvironment(options, {}, () => { throw new Error("Must not use Daytona"); });
  assert.equal(result.placement, "local");
  assert.equal(result.env.OPENWORK_EVIDENCE_CHECKPOINTS, "1");
  assert.equal(resolveRunEnvironment(parseArgs(["ordinary", "--local"]), {}).env.OPENWORK_EVIDENCE_CHECKPOINTS, undefined);
  for (const args of [
    ["--checkpoints"], ["ordinary", "--local", "--checkpoints"], ["web-checkpoint-fork", "--daytona", "--checkpoints"],
    ["web-checkpoint-fork", "--local", "--engine", "v2", "--checkpoints"],
    ["web-checkpoint-fork", "--local", "--surface", "electron", "--checkpoints"],
    ["--publish", "--local", "--checkpoints"],
  ]) assert.throws(() => parseArgs(args), /--checkpoints/);
});
