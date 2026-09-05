import { spawnSync } from "node:child_process";
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
if (process.platform !== "linux") throw new Error("The fast packaged smoke gate currently targets Linux.");
const output = resolve(process.env.OPENWORK_PACKAGED_SMOKE_DIR || join(tmpdir(), `openwork-packaged-smoke-${process.pid}`));
mkdirSync(output, { recursive: true });
const report = { commit: process.env.GITHUB_SHA ?? null, phases: [], passed: false };
const started = performance.now();

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

try {
  if (!process.argv.includes("--artifact-only")) {
    run("prepare", process.execPath, ["apps/desktop/scripts/electron-build.mjs",
      ...(process.argv.includes("--server-built") ? ["--server-built"] : [])], 240_000);
    run("package", "pnpm", ["--dir", "apps/desktop", "exec", "electron-builder",
      "--config", "electron-builder.yml", "--linux", "--dir", "--publish", "never",
      `--config.directories.output=${output}`], 120_000,
    { CSC_IDENTITY_AUTO_DISCOVERY: "false" });
  }
  const binary = join(output, "linux-unpacked/openwork");
  const resources = join(output, "linux-unpacked/resources");
  const archive = join(resources, "app.asar");
  if (!existsSync(archive)) throw new Error(`Missing packaged archive: ${archive}`);
  accessSync(binary, constants.X_OK);
  const sidecar = join(resources, "sidecars/opencode");
  accessSync(sidecar, constants.X_OK);
  run("sidecar", sidecar, ["--version"], 10_000, {}, output);
  const embedded = pathToFileURL(join(archive, "server/dist/embedded.js")).href;
  run("server-import", binary, ["--input-type=module", "-e",
    `const server = await import(${JSON.stringify(embedded)}); if (typeof server.startEmbeddedServer !== "function") throw new Error("Missing embedded server export");`],
  15_000, { ELECTRON_RUN_AS_NODE: "1", NODE_PATH: "", NODE_OPTIONS: "" }, output);
  run("desktop-boot", "xvfb-run", ["-a", "pnpm", "evals:e2e", "app-smoke", "--local"], 90_000, {
    OPENWORK_EVAL_ELECTRON_BINARY: binary,
    OPENWORK_EVAL_ELECTRON_RESOURCES_PREPARED: "1",
    OPENWORK_EVAL_ENGINE: "v1",
    OPENWORK_EVAL_SURFACES_DIR: join(output, "profiles"),
    ELECTRON_RUN_AS_NODE: "",
    NODE_PATH: "", NODE_OPTIONS: "",
  });
  report.passed = true;
} finally {
  report.totalMilliseconds = Math.round(performance.now() - started);
  writeFileSync(join(output, "timing.json"), `${JSON.stringify(report, null, 2)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### Packaged desktop smoke\n\n${report.passed ? "Passed" : "Failed"}; ${Math.round(report.totalMilliseconds / 1000)} seconds after dependency setup${process.argv.includes("--server-built") ? " and server compilation" : ""}. Target: under 120 seconds on a warm runner.\n\n| Phase | Seconds |\n| --- | ---: |\n${report.phases.map(p => `| ${p.name} | ${(p.milliseconds / 1000).toFixed(1)} |`).join("\n")}\n`);
  }
}
