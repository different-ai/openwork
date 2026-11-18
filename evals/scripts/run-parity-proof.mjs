import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { basename, resolve } from "node:path";
import { journeyFile, testName } from "../bin/test-files.mjs";
import { prepareParityBinaries } from "./engine-parity-binaries.mjs";

// Keyed by basename: a journey can live in evals/specs, evals/core or evals/proofs.
const specs = new Set([
  "agent-connection-journey.e2e.test.ts",
  "secure-keys-in-chat.e2e.test.ts",
  "agent-permissions.e2e.test.ts",
]);

const v2Only = new Set([
  // Agent permissions are enforced by OpenCode v2 only.
  "agent-permissions.e2e.test.ts",
]);

/** Basename of a supported parity spec given its basename or a path in any journey folder; undefined when unsupported. */
export function parityProofName(spec) {
  const name = basename(spec);
  if (!specs.has(name)) return undefined;
  if (spec !== name && !/^(?:evals\/)?(?:specs|core|proofs)\/[^/]+$/.test(spec)) return undefined;
  return name;
}

export function parityProofPlan(spec) {
  const name = parityProofName(spec);
  if (!name) throw new Error(`Unsupported parity proof: ${spec}`);
  const file = journeyFile(name);
  if (!file) throw new Error(`Parity proof spec is missing from evals/specs, evals/core and evals/proofs: ${name}`);
  const engines = v2Only.has(name) ? ["v2"] : ["v1", "v2"];
  return engines.map(engine => ({ engine, args: ["evals/bin/evals.mjs", testName(file), "--local", "--engine", engine] }));
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
  if (args.length === 2 && args[0] === "--supports") process.exitCode = parityProofName(args[1]) ? 0 : 1;
  else if (args.length === 1) process.exitCode = await runParityProof(args[0]);
  else throw new Error("Usage: run-parity-proof.mjs [--supports] evals/(specs|core|proofs)/<spec>.e2e.test.ts");
}
