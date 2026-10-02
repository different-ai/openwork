import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runCommand, runConcurrent } from "./packaged-smoke-runner.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
if (process.platform !== "linux") throw new Error("The fast packaged smoke gate currently targets Linux.");
const output = resolve(process.env.OPENWORK_PACKAGED_SMOKE_DIR || join(tmpdir(), `openwork-packaged-smoke-${process.pid}`));
mkdirSync(output, { recursive: true });
const report = { commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(), phases: [], passed: false };
const started = performance.now();

// `--journey <name>` (repeatable) runs only the checks for those journeys
// against the same packaged artifacts. PR proof uses it for packaged specs,
// which need a packaged binary and cannot run against a dev build.
const journeys = new Set(process.argv.flatMap((arg, index, all) => arg === "--journey" && all[index + 1] ? [all[index + 1]] : []));
const selected = (journey) => journeys.size === 0 || journeys.has(journey);

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

// The cloud and enterprise flavors render a gate above the routes on first
// launch. Only these artifacts contain that code path, so each one is packaged
// and booted on a fresh profile; the public flavor is covered by app-smoke.
const gatedFlavors = [
  { flavor: "enterprise", config: "electron-builder.enterprise.yml", executable: "openwork-enterprise" },
  { flavor: "cloud", config: "electron-builder.cloud.yml", executable: "openwork-cloud" },
];
const flavorOutput = (flavor) => join(output, flavor);

function packageFlavor(name, config, directory) {
  run(name, "pnpm", ["--dir", "apps/desktop", "exec", "electron-builder",
    "--config", config, "--linux", "--dir", "--publish", "never",
    `--config.directories.output=${directory}`], 120_000,
  { CSC_IDENTITY_AUTO_DISCOVERY: "false" });
}

async function bootPackagedDesktop(name, journey, binary, timeout, display) {
  const phaseStarted = performance.now();
  const result = await runCommand("xvfb-run", ["-a", "--server-num", String(display), "pnpm", "evals:e2e", journey, "--local"], {
    cwd: repo, stdio: "inherit", timeout,
    env: {
      ...process.env,
      OPENWORK_EVAL_ELECTRON_BINARY: binary,
      OPENWORK_EVAL_ELECTRON_RESOURCES_PREPARED: "1",
      OPENWORK_EVAL_ELECTRON_LOGS_DIR: join(output, "profiles", "retained"),
      OPENWORK_EVAL_ENGINE: "v1",
      OPENWORK_EVAL_SURFACES_DIR: join(output, "profiles", name),
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
    packageFlavor("package", "electron-builder.yml", output);
    for (const { flavor, config } of gatedFlavors) {
      packageFlavor(`package-${flavor}`, config, flavorOutput(flavor));
    }
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
  const checks = [];
  const matched = new Set();
  const check = (name, journey, executable, timeout) => {
    if (!selected(journey)) return;
    matched.add(journey);
    // Distinct starting displays avoid xvfb-run's concurrent auto-number race.
    const display = 100 + checks.length * 10;
    checks.push(() => bootPackagedDesktop(name, journey, executable, timeout, display));
  };
  check("desktop-boot", "app-smoke", binary, 90_000);
  for (const { flavor, executable } of gatedFlavors) {
    const flavorBinary = join(flavorOutput(flavor), "linux-unpacked", executable);
    accessSync(flavorBinary, constants.X_OK);
    check(`desktop-boot-${flavor}`, "packaged-first-launch", flavorBinary, 150_000);
    // Only the enterprise flavor has an activation gate that must hold the updater back.
    if (flavor === "enterprise") {
      check("desktop-updater-gate-enterprise", "packaged-preactivation-updater", flavorBinary, 300_000);
      // ...and must make no request outside loopback until a workspace address is submitted.
      check("desktop-egress-gate-enterprise", "packaged-preactivation-egress", flavorBinary, 300_000);
    }
  }
  // The same enterprise artifact, booted as an already-activated install (the update path for existing customers).
  check("desktop-boot-enterprise-activated", "packaged-activated-launch", join(flavorOutput("enterprise"), "linux-unpacked", "openwork-enterprise"), 150_000);
  if (selected("desktop-quit-path")) matched.add("desktop-quit-path");
  const unknown = [...journeys].filter((journey) => !matched.has(journey));
  if (unknown.length) throw new Error(`No packaged smoke check runs journey ${unknown.join(", ")}.`);
  await runConcurrent(checks);
  // Browser.close is intentionally isolated from the other packaged Electron
  // instances. Running the quit contract beside the long egress observation can
  // make an unrelated attached surface disappear before its quiet window ends.
  // Linux has no crash reports to read, so the journey names that half skipped
  // and the exit signal is the witness.
  if (selected("desktop-quit-path")) await bootPackagedDesktop(
    "desktop-quit-enterprise",
    "desktop-quit-path",
    join(flavorOutput("enterprise"), "linux-unpacked", "openwork-enterprise"),
    300_000,
    190,
  );
  report.passed = true;
} finally {
  report.totalMilliseconds = Math.round(performance.now() - started);
  writeFileSync(join(output, "timing.json"), `${JSON.stringify(report, null, 2)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### Packaged desktop smoke\n\n${report.passed ? "Passed" : "Failed"}; ${Math.round(report.totalMilliseconds / 1000)} seconds after dependency setup${process.argv.includes("--server-built") ? " and server compilation" : ""}. Target: under 120 seconds on a warm runner.\n\n| Phase | Seconds |\n| --- | ---: |\n${report.phases.map(p => `| ${p.name} | ${(p.milliseconds / 1000).toFixed(1)} |`).join("\n")}\n`);
  }
}
