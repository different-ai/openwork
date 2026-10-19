import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describeEngineFindings, diagnoseEngine } from "./engine-diagnosis.mjs";
import { runCommand } from "./packaged-smoke-runner.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
if (process.platform !== "linux") throw new Error("The fast packaged smoke gate currently targets Linux.");
const output = resolve(process.env.OPENWORK_PACKAGED_SMOKE_DIR || join(tmpdir(), `openwork-packaged-smoke-${process.pid}`));
mkdirSync(output, { recursive: true });
const report = { commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(), phases: [], passed: false };
const started = performance.now();

// `--journey app-smoke` is accepted so PR proof can name the journey it runs;
// app-smoke is the only journey this Linux gate boots. The macOS-only
// packaged-update-install runs in packaged-smoke-macos.mjs.
const JOURNEY = "app-smoke";
const unknown = process.argv.flatMap((arg, index, all) => arg === "--journey" && all[index + 1] && all[index + 1] !== JOURNEY ? [all[index + 1]] : []);
if (unknown.length) throw new Error(`No packaged smoke check runs journey ${unknown.join(", ")}.`);

function run(name, command, args, timeout, extraEnv = {}, cwd = repo) {
  const phaseStarted = performance.now();
  const result = spawnSync(command, args, {
    cwd, stdio: "inherit", timeout,
    env: { ...process.env, ...extraEnv },
  });
  const phase = { name, milliseconds: Math.round(performance.now() - phaseStarted), exitCode: result.status };
  report.phases.push(phase);
  console.log(`[packaged-smoke] ${JSON.stringify(phase)}`);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${name} failed (${result.signal || result.status})`);
}

function packageDesktop() {
  run("package", "pnpm", ["--dir", "apps/desktop", "exec", "electron-builder",
    "--config", "electron-builder.yml", "--linux", "--dir", "--publish", "never",
    `--config.directories.output=${output}`], 120_000,
  { CSC_IDENTITY_AUTO_DISCOVERY: "false" });
}

async function bootPackagedDesktop(name, binary, timeout) {
  const phaseStarted = performance.now();
  const result = await runCommand("xvfb-run", ["-a", "pnpm", "evals:e2e", JOURNEY, "--local"], {
    cwd: repo, stdio: "inherit", timeout,
    env: {
      ...process.env,
      OPENWORK_EVAL_ELECTRON_BINARY: binary,
      OPENWORK_EVAL_ELECTRON_RESOURCES_PREPARED: "1",
      OPENWORK_EVAL_SURFACES_DIR: join(output, "profiles", name),
      // Profiles are removed when a journey ends; keep each main-process log
      // outside them so CI can upload it.
      OPENWORK_EVAL_SURFACE_LOGS_DIR: join(output, "logs", name),
      ELECTRON_RUN_AS_NODE: "",
      NODE_PATH: "", NODE_OPTIONS: "",
    },
  });
  const phase = { name, milliseconds: Math.round(performance.now() - phaseStarted), exitCode: result.status, timedOut: result.timedOut };
  report.phases.push(phase);
  console.log(`[packaged-smoke] ${JSON.stringify(phase)}`);
  if (result.status !== 0 || result.timedOut) throw new Error(`${name} failed (${result.timedOut ? "timeout" : result.signal || result.status})`);
}

try {
  if (!process.argv.includes("--artifact-only")) {
    run("prepare", process.execPath, ["apps/desktop/scripts/electron-build.mjs",
      ...(process.argv.includes("--server-built") ? ["--server-built"] : [])], 240_000);
    packageDesktop();
  }
  const binary = join(output, "linux-unpacked/openwork");
  const resources = join(output, "linux-unpacked/resources");
  const archive = join(resources, "app.asar");
  if (!existsSync(archive)) throw new Error(`Missing packaged archive: ${archive}`);
  accessSync(binary, constants.X_OK);
  const sidecar = join(resources, "sidecars/opencode2");
  accessSync(sidecar, constants.X_OK);
  run("sidecar", sidecar, ["--version"], 10_000, {}, output);
  const embedded = pathToFileURL(join(archive, "server/dist/embedded.js")).href;
  run("server-import", binary, ["--input-type=module", "-e",
    `const server = await import(${JSON.stringify(embedded)}); if (typeof server.startEmbeddedServer !== "function") throw new Error("Missing embedded server export");`],
  15_000, { ELECTRON_RUN_AS_NODE: "1", NODE_PATH: "", NODE_OPTIONS: "" }, output);
  await bootPackagedDesktop("desktop-boot", binary, 90_000);
  report.passed = true;
} finally {
  report.totalMilliseconds = Math.round(performance.now() - started);
  // A journey that fails because the AI engine never answered otherwise reports
  // only a later browser timeout. Say so first, with the engine's own errors.
  const engine = report.passed ? "" : describeEngineFindings(diagnoseEngine(join(output, "logs")));
  if (engine) {
    report.engineNeverAnswered = true;
    console.error(`\n[packaged-smoke] ${engine}\n`);
    if (process.env.GITHUB_ACTIONS) console.log(`::error title=AI engine did not answer::${engine.split("\n")[0]}`);
  }
  writeFileSync(join(output, "timing.json"), `${JSON.stringify(report, null, 2)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### Packaged desktop smoke\n\n${report.passed ? "Passed" : "Failed"}; ${Math.round(report.totalMilliseconds / 1000)} seconds after dependency setup${process.argv.includes("--server-built") ? " and server compilation" : ""}. Target: under 120 seconds on a warm runner.\n\n${engine ? `**The app's AI engine (OpenCode) did not answer.**\n\n\`\`\`\n${engine}\n\`\`\`\n\n` : ""}| Phase | Seconds |\n| --- | ---: |\n${report.phases.map(p => `| ${p.name} | ${(p.milliseconds / 1000).toFixed(1)} |`).join("\n")}\n`);
  }
}
