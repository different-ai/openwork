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
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CASES, packagedSandboxWorld } from "../worlds/packaged-sandbox.ts";
import { packagedBundle, profiles, redact, type ModelKey } from "../worlds/packaged-sandbox-fixtures.ts";

const { values } = parseArgs({ options: {
  app: { type: "string" }, binary: { type: "string" }, model: { type: "string", default: "both" },
  "evidence-dir": { type: "string" }, "keep-root": { type: "boolean", default: false },
  "expected-git-sha": { type: "string" }, "expected-bundle-sha256": { type: "string" }, cases: { type: "string" },
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
const cases = [...new Set((values.cases ?? CASES.join(",")).split(",").flatMap(name => name === "f" ? ["f1", "f2", "f3"] : name === "j" ? ["j-use", "j-force"] : [name]))];
for (const caseName of cases) if (!CASES.includes(caseName)) throw new Error(`Unknown --cases value: ${caseName}`);
const stamp = values.app ? await readFile(join(resolve(values.app), "..", "BUILD_SHA"), "utf8").catch(() => "") : "";
if (values.app && resolve(values.app) === "/tmp/owafter/OpenWork.app" && !stamp.trim()) throw new Error("The artifact is not ready: /tmp/owafter/BUILD_SHA is absent or empty");
const artifact = await packagedBundle(binary);
console.log(`Artifact ${artifact.bundle}, BUILD_SHA=${stamp.trim() || "not supplied"}, bundle sha256=${artifact.identity.sha256}`);
// Copy only requested keys into closures before deleting ALL provider/env secrets.
const keys = models.map(model => ({ model, key: process.env[profiles[model].keyEnv]?.trim() ?? "" }));
for (const name of Object.keys(process.env)) if (/KEY|TOKEN|SECRET|PASSWORD|^OPENCODE_|^OPENWORK_/i.test(name)) delete process.env[name];
const cancel = new AbortController();
process.once("SIGINT", () => cancel.abort(new Error("Matrix interrupted (SIGINT)")));
process.once("SIGTERM", () => cancel.abort(new Error("Matrix interrupted (SIGTERM)")));
function logError(error: unknown) {
  console.error(redact(error instanceof Error ? error.stack ?? error.message : String(error), keys.map(entry => entry.key)));
  process.exitCode = 1;
}
for (const caseName of cases) for (const { model, key } of keys) {
  if (cancel.signal.aborted) break;
  if (caseName === "c-ro" && model !== "fable") continue;
  if (!key) { console.error(`BLOCKED ${model}/${caseName}: missing ${profiles[model].keyEnv}`); process.exitCode = 1; continue; }
  const evidenceDir = resolve(values["evidence-dir"], model, caseName);
  try {
    const world = await packagedSandboxWorld({ binary, artifact, model, caseName, realKey: key, evidenceDir, signal: cancel.signal, keepRoot: values["keep-root"], expectedGitSha: values["expected-git-sha"], expectedBundleSha256: values["expected-bundle-sha256"] });
    let failure: unknown;
    try { await world.launch(); await world.exercise(); }
    catch (error) { failure = error; logError(error); }
    finally { await world.dispose(failure); }
  } catch (error) { logError(error); }
}
