/**
 * Launch ONLY after the parent has built/signed the branch's macOS arm64 .app.
 * Run sequentially (one native window at a time):
 *
 * infisical run --silent --env dev -- node --conditions=development \
 *   evals/scripts/packaged-sandbox-check.ts --app '/owned/build/OpenWork.app' \
 *   --model both --evidence-dir '/owned/evidence'
 *
 * No build, signing, production flag, /Applications install, or user history is touched.
 * Upstream provider keys stay in the fixture process's memory; the app receives
 * only a scoped loopback token. This is not the old source-engine model check.
 */
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { packagedSandboxWorld } from "../worlds/packaged-sandbox.ts";
import { profiles, redact, type ModelKey } from "../worlds/packaged-sandbox-fixtures.ts";

const { values } = parseArgs({ options: {
  app: { type: "string" }, binary: { type: "string" }, model: { type: "string", default: "both" },
  "evidence-dir": { type: "string" }, "keep-root": { type: "boolean", default: false },
  "expected-git-sha": { type: "string" }, "expected-bundle-sha256": { type: "string" },
} });
if (!values["evidence-dir"] || (!values.app && !values.binary && !process.env.OPENWORK_EVAL_ELECTRON_BINARY)) {
  throw new Error("Usage: packaged-sandbox-check.ts --app <branch-built .app> --model fable|sol|both --evidence-dir <owned output directory>");
}
const selection = values.model;
if (selection !== "both" && selection !== "fable" && selection !== "sol") throw new Error("--model must be fable, sol, or both");
const models: ModelKey[] = selection === "both" ? ["fable", "sol"] : [selection];
let binary = values.binary ?? process.env.OPENWORK_EVAL_ELECTRON_BINARY ?? "";
if (values.app) {
  const directory = join(resolve(values.app), "Contents/MacOS");
  const executables = await readdir(directory);
  if (executables.length !== 1 || !executables[0]) throw new Error("--app must have exactly one main executable under Contents/MacOS; otherwise pass --binary explicitly");
  binary = join(directory, executables[0]);
}
// Copy only requested keys into closures before deleting ALL provider/env secrets.
const keys = models.map(model => ({ model, key: process.env[profiles[model].keyEnv]?.trim() ?? "" }));
for (const { model, key } of keys) if (!key) throw new Error(`${profiles[model].keyEnv} is required for ${model}`);
for (const name of Object.keys(process.env)) if (/KEY|TOKEN|SECRET|PASSWORD|^OPENCODE_|^OPENWORK_/i.test(name)) delete process.env[name];
for (const { model, key } of keys) {
  const world = await packagedSandboxWorld({ binary, model, realKey: key, evidenceDir: resolve(values["evidence-dir"]), keepRoot: values["keep-root"], expectedGitSha: values["expected-git-sha"], expectedBundleSha256: values["expected-bundle-sha256"] });
  let failure: unknown;
  try { await world.launch(); await world.exercise(); }
  catch (error) { failure = error; console.error(redact(error instanceof Error ? error.stack ?? error.message : String(error), keys.map(entry => entry.key))); process.exitCode = 1; }
  finally { await world.dispose(failure); }
  if (failure) break;
}
