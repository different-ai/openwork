import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { prepareParityBinaries } from "./engine-parity-binaries.mjs";

const specs = new Set([
  "evals/specs/engine-parity.e2e.test.ts",
  "evals/specs/engine-gateway-parity.e2e.test.ts",
  "evals/specs/engine-connectors-parity.e2e.test.ts",
  "evals/specs/engine-live-chat.e2e.test.ts",
  "evals/specs/engine-live-desktop.e2e.test.ts",
  "evals/specs/engine-live-launch.e2e.test.ts",
  "evals/specs/engine-live-parity.e2e.test.ts",
]);

export function parityProofPlan(spec) {
  if (!specs.has(spec)) throw new Error(`Unsupported parity proof: ${spec}`);
  return ["v1", "v2"].map(engine => ({ engine, args: ["evals/bin/evals.mjs", spec.slice("evals/".length), "--local", "--engine", engine] }));
}

export async function runParityProof(spec, dependencies = {}) {
  const plan = parityProofPlan(spec);
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const binaries = await (dependencies.prepare ?? prepareParityBinaries)(root);
  const run = dependencies.run ?? (async (args, env) => {
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: "inherit" });
    return new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code ?? 1)); });
  });
  let failed = false;
  for (const { engine, args } of plan) {
    // Each invocation retains its own CLI/testkit evidence. A failed or skipped
    // engine fails the job even when the other engine passes.
    const code = await run(args, { ...process.env, ...binaries, OPENWORK_EVAL_ENGINE: engine });
    if (code !== 0) failed = true;
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === "--supports") process.exitCode = specs.has(args[1]) ? 0 : 1;
  else if (args.length === 1) process.exitCode = await runParityProof(args[0]);
  else throw new Error("Usage: run-parity-proof.mjs [--supports] evals/specs/<spec>.e2e.test.ts");
}
