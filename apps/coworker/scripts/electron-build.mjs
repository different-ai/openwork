import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { opencodeTargetName } from "../electron/runtime-paths.mjs";

const dirnameHere = dirname(fileURLToPath(import.meta.url));
const coworkerRoot = resolve(dirnameHere, "..");
const repoRoot = resolve(coworkerRoot, "../..");
const sidecarDir = resolve(coworkerRoot, "resources", "sidecars");
const helperDir = resolve(coworkerRoot, "resources", "helpers");
const packagedServerRoot = resolve(coworkerRoot, "server");
const packagedElectronRoot = resolve(coworkerRoot, "electron-dist");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function run(command, args, cwd = repoRoot, env) {
  const result = spawnSync(command, args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(command),
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function buildElectron() {
  run(process.execPath, [
    resolve(repoRoot, "apps", "desktop", "scripts", "prepare-sidecar.mjs"),
    "--force",
    "--outdir",
    sidecarDir,
  ], coworkerRoot);
  run(process.execPath, [
    resolve(repoRoot, "apps", "desktop", "scripts", "prepare-computer-use-helper.mjs"),
    "--force",
    "--outdir",
    helperDir,
  ], coworkerRoot);
  run(pnpmCommand, ["--filter", "@openwork/automations", "build"]);
  run(pnpmCommand, ["--filter", "@openwork/headless-threads", "build"]);
  run(pnpmCommand, ["--filter", "openwork-server", "build"]);
  run(pnpmCommand, ["exec", "vite", "build"], coworkerRoot, { OPENWORK_ELECTRON_BUILD: "1" });

  rmSync(packagedElectronRoot, { recursive: true, force: true });
  mkdirSync(packagedElectronRoot, { recursive: true });
  run(pnpmCommand, [
    "exec",
    "esbuild",
    resolve(coworkerRoot, "electron", "main.mjs"),
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--target=node22",
    "--external:electron",
    "--external:@modelcontextprotocol/sdk",
    "--external:opencode-chrome-devtools",
    `--outfile=${resolve(packagedElectronRoot, "main.mjs")}`,
  ], coworkerRoot);
  run(pnpmCommand, [
    "exec", "esbuild", resolve(coworkerRoot, "electron", "maintenance-helper.mjs"),
    "--bundle", "--platform=node", "--format=esm", "--target=node22",
    `--outfile=${resolve(packagedElectronRoot, "maintenance-helper.mjs")}`,
  ], coworkerRoot);
  copyFileSync(
    resolve(coworkerRoot, "electron", "preload.mjs"),
    resolve(packagedElectronRoot, "preload.mjs"),
  );
  copyFileSync(fileURLToPath(import.meta.resolve("@openwork/browser-tabs/preload")), resolve(packagedElectronRoot, "browser-content-preload.cjs"));

  const serverDistDir = resolve(repoRoot, "apps", "server", "dist");
  const constantsSource = resolve(repoRoot, "constants.json");
  copyFileSync(constantsSource, resolve(serverDistDir, "constants.json"));
  // Every top-level server module resolves the same packaged copy. New server
  // modules (including engine preview selection) must not reach outside the asar.
  for (const name of readdirSync(serverDistDir).filter((name) => name.endsWith(".js"))) {
    const entry = resolve(serverDistDir, name);
    const source = readFileSync(entry, "utf8");
    const packaged = source.replace(/from\s+["']\.\.\/\.\.\/\.\.\/constants\.json["']/g, 'from "./constants.json"');
    if (packaged !== source) writeFileSync(entry, packaged, "utf8");
  }

  rmSync(packagedServerRoot, { recursive: true, force: true });
  cpSync(serverDistDir, resolve(packagedServerRoot, "dist"), { recursive: true });
  copyFileSync(resolve(repoRoot, "apps", "server", "package.json"), resolve(packagedServerRoot, "package.json"));

  for (const fileName of readdirSync(resolve(coworkerRoot, "electron")).filter((name) => name.endsWith(".mjs")).sort()) {
    run(process.execPath, ["--check", resolve(coworkerRoot, "electron", fileName)]);
  }
  run(process.execPath, ["--check", resolve(packagedElectronRoot, "main.mjs")]);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    renderer: "apps/coworker/dist",
    electronMain: "apps/coworker/electron-dist/main.mjs",
    server: "apps/coworker/server/dist/embedded.js",
    sidecars: "apps/coworker/resources/sidecars",
    computerUseHelper: process.platform === "darwin" ? "apps/coworker/resources/helpers/OpenWork Computer Use.app" : null,
  }, null, 2)}\n`);
}

// pnpm 11 makes list recursive in workspaces even with --recursive=false.
// Scope roots before the collector starts; keep the complete dependency depth.
export function beforePack(context) {
  process.env.pnpm_config_filter = "@openwork/coworker";
  const arch = { 1: "x64", 3: "arm64", x64: "x64", arm64: "arm64" }[context.arch];
  const engine = arch && opencodeTargetName(context.electronPlatformName, arch);
  if (!engine) throw new Error(`Unsupported Coworker sidecar target: ${context.electronPlatformName}/${context.arch}`);
  const metadata = `versions.json-${engine.slice("opencode-".length)}`;
  // Select files before copying. Never mutate shared sidecar staging or ship a
  // second generic executable; the runtime already prefers the qualified name.
  const staging = resolve(context.packager.projectDir, "resources/sidecars");
  for (const source of [engine, metadata]) {
    if (!existsSync(resolve(staging, source))) throw new Error(`Missing Coworker target resource: ${source}`);
  }
  const sidecars = [
    // Directory copies retain electron-builder's Windows executable-signing
    // transformer; its single-file copy fast path bypasses that transformer.
    { from: staging, to: "sidecars", filter: [engine] },
    { from: resolve(staging, metadata), to: "sidecars/versions.json" },
  ];
  // A multi-target invocation can reuse config after the preceding target.
  context.packager.config.extraResources = [
    ...context.packager.config.extraResources.filter((resource) => resource.to !== "sidecars" && !resource.to?.startsWith("sidecars/")),
    ...sidecars,
  ];
}

// electron-builder imports this hook without running the build. Desktop's full
// after-pack hook assumes its .electron-runtime tree, which Coworker does not use.
export default function afterPack(context, { runNative = spawnSync } = {}) {
  if (context.electronPlatformName !== "darwin") return;
  const architectures = {
    1: ["x86_64"], 3: ["arm64"], 4: ["x86_64", "arm64"],
    x64: ["x86_64"], arm64: ["arm64"], universal: ["x86_64", "arm64"],
  }[context.arch];
  if (!Array.isArray(architectures)) throw new Error(`Computer Use does not support the macOS package architecture: ${context.arch}`);
  const helperApp = resolve(context.appOutDir, `${context.packager.appInfo.productFilename}.app`,
    "Contents", "Resources", "helpers", "OpenWork Computer Use.app");
  const executable = resolve(helperApp, "Contents", "MacOS", "ComputerUse");
  if (!existsSync(executable)) throw new Error(`Missing packaged Computer Use helper: ${executable}`);
  const plist = readFileSync(resolve(helperApp, "Contents", "Info.plist"), "utf8");
  if (!/<key>CFBundleIdentifier<\/key>\s*<string>com\.differentai\.openwork\.computer-use<\/string>/.test(plist)) {
    throw new Error("The Computer Use helper must retain its shared native bundle identity.");
  }
  // Until #4512's target-aware generator lands, --outdir still builds for the
  // host CPU. Fail closed on the actual builder target, not TARGET or process.arch.
  const cpu = runNative("/usr/bin/lipo", [executable, "-verify_arch", ...architectures], { encoding: "utf8", timeout: 10_000 });
  if (cpu.error || cpu.status !== 0) {
    throw new Error(`The packaged Computer Use helper does not contain ${architectures.join(" and ")}. Build on the target Mac architecture; cross-CPU packaging is not supported by the current helper generator.`);
  }
  // The generator signs the bundle; electron-builder subsequently signs nested
  // apps. Desktop's shared afterSign hook verifies its distribution signature.
  const signature = runNative("/usr/bin/codesign", ["--verify", "--deep", "--strict", helperApp], { encoding: "utf8", timeout: 10_000 });
  if (signature.error || signature.status !== 0) throw new Error("The packaged Computer Use helper signature is invalid.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildElectron();
