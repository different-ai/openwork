import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { prepareParityBinaries } from "./engine-parity-binaries.mjs";
import { median, verifyRun } from "./engine-parity.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const cases = ["LIVE-DESKTOP", "LIVE-CHAT", "LIVE-FORK", "LIVE-SIDE", "LIVE-SKILLS", "LIVE-MODELS", "LIVE-MCP", "LIVE-CONNECTORS", "LIVE-LAUNCH"];
const args = process.argv.slice(2);
if (args.some(arg => !/^--iterations=\d+$/.test(arg))) throw new Error("Usage: pnpm evals:parity:live [--iterations=3]");
const iterations = Number(args[0]?.split("=")[1] ?? 3);
if (!Number.isInteger(iterations) || iterations < 1 || iterations > 20) throw new Error("Iterations must be between 1 and 20");
if (process.env.OPENWORK_LIVE_INSTALLED_GATEWAY !== "1") throw new Error("Set OPENWORK_LIVE_INSTALLED_GATEWAY=1 to use an existing configured Gateway credential at its original destination. No synthetic fallback is allowed.");
const binaries = await prepareParityBinaries(root);
const out = join(root, "evals/results/engine-live-parity", new Date().toISOString().replaceAll(/[:.]/g, "-"));
const evidenceRoot = join(root, "evals/results/test-runs");
await mkdir(out, { recursive: true });
const results = [];
const failures = [];
for (let iteration = 0; iteration < iterations; iteration++) {
  for (const engine of iteration % 2 ? ["v2", "v1"] : ["v1", "v2"]) {
    const label = `${engine}-${iteration + 1}`;
    const jsonPath = join(out, `${label}.json`);
    const before = new Set(await readdir(evidenceRoot).catch(() => []));
    const specs = iteration ? ["engine-live-launch"] : ["engine-live-desktop", "engine-live-chat", "engine-live-launch"];
    const cliArgs = ["--dir", "evals", "exec", "vitest", "run", "--project", "e2e", ...specs.map(name => `specs/${name}.e2e.test.ts`),
      "--no-file-parallelism", "--reporter=default", "--reporter=json", `--outputFile.json=${jsonPath}`];
    console.log(`\n${label}: ${iteration ? "fresh native launch" : "real-model native user journeys"}`);
    const cli = process.env.npm_execpath;
    const child = spawn(cli ? process.execPath : "pnpm", cli ? [cli, ...cliArgs] : cliArgs, {
      cwd: root, env: { ...process.env, ...binaries, pnpm_config_verify_deps_before_run: "false", OPENWORK_EVAL_ENGINE: engine, OPENWORK_EVAL_E2E_TESTS: "1" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { log += chunk; process.stdout.write(chunk); });
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    await writeFile(join(out, `${label}.log`), log);
    const report = await readFile(jsonPath, "utf8").then(JSON.parse).catch(() => null);
    const runFailures = report ? verifyRun(report, engine, iteration ? ["LIVE-LAUNCH"] : cases) : [`${label}: no test report`];
    if (code !== 0) runFailures.push(`${label}: command exited ${code}`);
    const evidence = [];
    const timings = [];
    for (const directory of (await readdir(evidenceRoot)).filter(name => !before.has(name))) {
      const path = join(evidenceRoot, directory);
      const record = await readFile(join(path, "test-run.json"), "utf8").then(JSON.parse).catch(() => null);
      if (!record?.name?.includes(` ${engine}:`) || !cases.some(id => record.name.startsWith(id))) continue;
      evidence.push({ name: record.name, outcome: record.outcome, path: relative(out, join(path, "index.html")), failure: record.failure });
      if (record.outcome === "passed") for (const artifact of record.artifacts ?? []) {
        if (artifact.kind === "json" && artifact.label === "Native launch timings") timings.push(JSON.parse(await readFile(join(path, artifact.fileName), "utf8")));
      }
    }
    failures.push(...runFailures);
    results.push({ engine, iteration: iteration + 1, code, failures: runFailures, evidence, timings });
    await writeFile(join(out, "results.json"), JSON.stringify({ status: "RUNNING", results, failures }, null, 2));
  }
}
const lines = ["# Real-model native app parity", "", "", "",
  "Pinned v1 and v2 engines; fresh native Electron app profiles. Real inference through the free starter service or an existing Gateway credential entered in the app's masked provider form. Den capability discovery and execution are real. Only the external report service is a controlled witness. No model responses are scripted.", "",
  "| User journey | Result | Evidence |", "| --- | --- | --- |"];
for (const result of results.filter(result => result.iteration === 1)) for (const item of result.evidence) lines.push(`| ${item.name} | ${item.outcome} | [Steps and screenshots](${item.path}) |`);
lines.push("", "## Native development app launch", "", "Milliseconds from starting the desktop fixture to native bridge ready / editable composer with a selectable model. Includes development build and harness overhead, uses shared caches and a blank app profile. This is not a packaged cold-start benchmark and does not imply inference succeeds.", "", "| Metric | v1 median (min–max), n | v2 median (min–max), n |", "| --- | --- | --- |");
for (const metric of ["interactiveMs", "composerReadyMs"]) {
  const cells = ["v1", "v2"].map(engine => {
    const values = results.filter(result => result.engine === engine).flatMap(result => result.timings).map(sample => sample[metric]);
    if (values.length !== iterations) failures.push(`${engine}: ${values.length}/${iterations} native launch samples`);
    return values.length ? `${Math.round(median(values))} (${Math.round(Math.min(...values))}–${Math.round(Math.max(...values))}), n=${values.length}` : "not measured";
  });
  lines.push(`| ${metric} | ${cells.join(" | ")} |`);
}
lines[2] = failures.length ? "**NOT READY — required flows failed or did not run.**" : "**PASS — all required native journeys passed on both engines.**";
if (failures.length) lines.push("", "## Failures", "", ...failures.map(failure => `- ${failure}`));
await writeFile(join(out, "report.md"), lines.join("\n") + "\n");
await writeFile(join(out, "results.json"), JSON.stringify({ status: failures.length ? "NOT READY" : "PASS", results, failures }, null, 2));
console.log(`\nReview: ${join(out, "report.md")}`);
if (failures.length) process.exitCode = 1;
