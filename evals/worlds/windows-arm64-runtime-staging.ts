import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { Seed } from "@openwork/env";

const run = promisify(execFile);
const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const desktopRoot = join(repoRoot, "apps/desktop");
const stagingScript = "apps/desktop/scripts/prepare-runtime-node-modules.mjs";
const windowsNatives = ["win32-x64-msvc", "win32-arm64-msvc"].map((triple) => `@superradcompany/microsandbox-${triple}`);

export interface StagingResult {
  /** The TARGET the release job sets for this matrix entry. */
  target: string;
  /** The microsandbox native packages copied into the packaged runtime. */
  natives: string[];
  /** Which staging script ran: the checkout's own file or a git ref. */
  script: string;
}

/**
 * The Windows release jobs run on x64 runners and package both x64 and ARM64
 * with TARGET set to the packaged triple. This world runs the real staging CLI
 * (the one `build:electron` runs) on this checkout's installed workspace, as
 * that x64 Windows runner: process.platform/arch are win32/x64 before the
 * script loads, and both Windows CPU variants of microsandbox's native package
 * sit beside the SDK, as pnpm-workspace.yaml installs them on Windows.
 *
 * OPENWORK_STAGING_SCRIPT_REF runs the script from a git ref instead (the
 * control, e.g. origin/dev), against the same workspace and runner identity.
 */
export async function windowsArm64RuntimeStaging(seed: Seed) {
  const ref = process.env.OPENWORK_STAGING_SCRIPT_REF?.trim();
  const owned: string[] = [];
  const work = seed.tmpPath("windows-arm64-runtime-staging");
  owned.push(work);
  await mkdir(work, { recursive: true });

  // The script resolves the workspace from its own location, so a control copy
  // sits beside the real one.
  let script = join(repoRoot, stagingScript);
  if (ref) {
    const { stdout } = await run("git", ["show", `${ref}:${stagingScript}`], { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 });
    script = join(desktopRoot, "scripts", `.staging-control-${process.pid}.mjs`);
    await writeFile(script, stdout);
    owned.push(script);
  }

  const runner = join(work, "windows-x64-runner.mjs");
  await writeFile(runner, [
    'Object.defineProperty(process, "platform", { value: "win32" });',
    'Object.defineProperty(process, "arch", { value: "x64" });',
    "",
  ].join("\n"));

  // pnpm only installs optional natives for the current OS; add the Windows
  // pair the Windows runner has (manifests only: staging copies, never loads).
  const sdkRoot = await realpath(join(repoRoot, "packages/sandbox-microsandbox/node_modules/microsandbox"));
  const sdk = JSON.parse(await readFile(join(sdkRoot, "package.json"), "utf8")) as { version: string };
  for (const name of windowsNatives) {
    const root = join(dirname(sdkRoot), name);
    if (existsSync(root)) continue;
    owned.push(root);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name, version: sdk.version, main: "index.js" }));
    await writeFile(join(root, "index.js"), "");
  }

  let runs = 0;
  async function stage(target: string): Promise<StagingResult> {
    const outdir = join(work, `out-${runs += 1}`);
    await run(process.execPath, ["--import", pathToFileURL(runner).href, script, "--outdir", outdir], {
      cwd: desktopRoot,
      env: { ...process.env, TARGET: target, NODE_OPTIONS: "" },
      maxBuffer: 16 * 1024 * 1024,
    });
    const scoped = join(outdir, "@superradcompany");
    const natives = existsSync(scoped) ? (await readdir(scoped)).map((name) => `@superradcompany/${name}`).sort() : [];
    return { target, natives, script: ref ? `${stagingScript} at ${ref}` : `${stagingScript} (checkout)` };
  }

  return {
    stage,
    [Symbol.asyncDispose]: async () => {
      for (const path of owned.reverse()) await rm(path, { recursive: true, force: true });
    },
  };
}
