import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative, resolve } from "node:path";
import { prepareParityBinaries } from "./engine-parity-binaries.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const cases = ["PARITY-BOOT", "PARITY-STREAM", "PARITY-SKILLS", "PARITY-GATEWAY", "PARITY-CONNECTORS"];
const specs = ["engine-parity", "engine-gateway-parity", "engine-connectors-parity"].map(name => `specs/${name}.e2e.test.ts`);

export function verifyRun(report, engine, required = cases) {
  const assertions = (report.testResults ?? []).flatMap(file => file.assertionResults ?? []);
  return required.flatMap(id => {
    const matches = assertions.filter(test => test.title.startsWith(`${id} ${engine}:`));
    if (matches.length !== 1) return [`${engine} ${id}: expected exactly one result, got ${matches.length}`];
    return matches[0].status === "passed" ? [] : [`${engine} ${id}: ${matches[0].status} (skipped is not parity)`];
  });
}
export function median(values) {
  if (!values.length || values.some(value => !Number.isFinite(value))) throw new Error("Missing or invalid timing samples");
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function main() {
  const iterationsArg = process.argv.slice(2).find(arg => arg.startsWith("--iterations="));
  if (process.argv.slice(2).some(arg => arg !== iterationsArg)) throw new Error("Usage: pnpm evals:parity [--iterations=3]");
  const iterations = Number(iterationsArg?.split("=")[1] ?? 3);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 20) throw new Error("Iterations must be between 1 and 20");
  console.log("Checking repository-pinned native engine binaries...");
  const binaries = await prepareParityBinaries(root);
  const out = join(root, "evals/results/engine-parity", new Date().toISOString().replaceAll(/[:.]/g, "-"));
  await mkdir(out, { recursive: true });
  const results = [];
  const failures = [];
  const evidenceRoot = join(root, "evals/results/test-runs");
  for (let iteration = 0; iteration < iterations; iteration++) {
    // Alternate order so one engine does not always pay first-compile cost.
    for (const engine of iteration % 2 ? ["v2", "v1"] : ["v1", "v2"]) {
      const label = `${engine}-${iteration + 1}`;
      const jsonPath = join(out, `${label}.json`);
      const before = new Set(await readdir(evidenceRoot).catch(() => []));
      const args = ["--dir", "evals", "exec", "vitest", "run", "--config", "vitest.config.ts", "--project", "e2e",
        ...(iteration === 0 ? specs : [specs[0], "-t", "PARITY-BOOT"]), "--no-file-parallelism", "--reporter=default", "--reporter=json", `--outputFile.json=${jsonPath}`];
      console.log(`\n${label}: ${iteration === 0 ? "all five user journeys" : "fresh-profile app launch sample"}`);
      let log = "";
      const cli = process.env.npm_execpath;
      const child = spawn(cli ? process.execPath : "pnpm", cli ? [cli, ...args] : args, {
        cwd: root, env: { ...process.env, ...binaries, pnpm_config_verify_deps_before_run: "false", OPENWORK_EVAL_ENGINE: engine, OPENWORK_EVAL_E2E_TESTS: "1" }, stdio: ["ignore", "pipe", "pipe"],
      });
      for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { log += chunk; process.stdout.write(chunk); });
      const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code)); });
      await writeFile(join(out, `${label}.log`), log);
      const report = await readFile(jsonPath, "utf8").then(JSON.parse).catch(() => null);
      const runFailures = report ? verifyRun(report, engine, iteration === 0 ? cases : ["PARITY-BOOT"]) : [`${label}: no test report produced`];
      if (code !== 0) runFailures.push(`${label}: test command exited ${code}`);
      failures.push(...runFailures);
      const evidence = [];
      const timings = [];
      for (const directory of (await readdir(evidenceRoot)).filter(name => !before.has(name))) {
        const path = join(evidenceRoot, directory);
        const record = await readFile(join(path, "test-run.json"), "utf8").then(JSON.parse).catch(() => null);
        if (!record?.name?.includes(` ${engine}:`) || !cases.some(id => record.name.startsWith(id))) continue;
        evidence.push({ name: record.name, outcome: record.outcome, path: relative(out, join(path, "index.html")) });
        if (record.outcome === "passed") for (const artifact of record.artifacts ?? []) {
          if (artifact.kind === "json" && artifact.label === "App launch and first answer timings") timings.push(JSON.parse(await readFile(join(path, artifact.fileName), "utf8")));
        }
      }
      results.push({ engine, iteration: iteration + 1, code, failures: runFailures, evidence, timings });
      await writeFile(join(out, "results.json"), JSON.stringify({ status: failures.length ? "NOT READY" : "RUNNING", results, failures }, null, 2));
    }
  }
  const lines = ["# OpenCode app parity", "", failures.length ? "**NOT READY — required checks failed or did not run.**" : "**PASS — all five journeys passed on both engines.**", "",
    "Real development web app, OpenWork server, pinned engines, Den and Gateway. Model responses and the external connector are local witnesses. Fresh profiles; shared build/package caches. These are not packaged desktop startup measurements.", "",
    "V1 verifies installed-skill consumption and uses its explicit legacy engine reload and app refresh for Gateway changes. V2 additionally verifies five skill lifecycle turns and Gateway updates in one document and conversation, with the same engine PID and no reload or rollover activity. This result covers these journeys, not the entire historical E2E suite.", "",
    "| Journey | Result | Evidence |", "| --- | --- | --- |"];
  for (const result of results.filter(result => result.iteration === 1)) for (const item of result.evidence) lines.push(`| ${item.name} | ${item.outcome} | [Steps and screenshots](${item.path}) |`);
  lines.push("", "## Launch timing (milliseconds)", "", "Boundary starts before launching the real app-web stack and ends at the visible composer. Model/connector/Den fixture setup is excluded. First-answer timing starts at Send. Figures include browser and development-server overhead.", "", "| Metric | v1 median (min–max), n | v2 median (min–max), n |", "| --- | --- | --- |");
  for (const [metric, label] of [["interactiveMs", "App interactive"], ["composerReadyMs", "Ready to send"], ["userRenderedMs", "Send → user message visible"], ["completedMs", "Send → complete answer"]]) {
    const cells = ["v1", "v2"].map(engine => {
      const values = results.filter(result => result.engine === engine).flatMap(result => result.timings).map(sample => sample[metric]);
      if (values.length !== iterations) failures.push(`${engine}: ${values.length}/${iterations} timing samples for ${metric}`);
      return values.length ? `${Math.round(median(values))} (${Math.round(Math.min(...values))}–${Math.round(Math.max(...values))}), n=${values.length}` : "not measured";
    });
    lines.push(`| ${label} | ${cells.join(" | ")} |`);
  }
  lines.push("", "Versions: " + ["v1", "v2"].map(engine => {
    const versions = [...new Set(results.filter(result => result.engine === engine).flatMap(result => result.timings).map(sample => sample.engineVersion))];
    return `${engine} ${versions.join(", ") || "not measured"}`;
  }).join("; ") + ".");
  if (failures.length) { lines[2] = "**NOT READY — required checks failed or did not run.**"; lines.push("", "## Failures", "", ...failures.map(failure => `- ${failure}`)); }
  await writeFile(join(out, "report.md"), lines.join("\n") + "\n");
  await writeFile(join(out, "results.json"), JSON.stringify({ status: failures.length ? "NOT READY" : "PASS", results, failures }, null, 2));
  console.log(`\nReview: ${join(out, "report.md")}`);
  if (failures.length) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
