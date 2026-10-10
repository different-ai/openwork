// Pre-resolves the dependency OpenCode installs into its global config folder
// the first time it loads a folder with plugins configured
// (`npm install @opencode-ai/plugin@<engine version>`), and packs the result
// as dist/opencode-plugin-deps-<version>.tgz. `openwork-server web` extracts
// it on a fresh profile so the first folder load skips that install
// (10-15 s on Windows, measured on a 2 vCPU Defender-enabled machine).
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const OPENCODE_PLUGIN_PACKAGE = "@opencode-ai/plugin";

export function opencodePluginDepsArchiveName(opencodeVersion) {
  return `opencode-plugin-deps-${opencodeVersion.replace(/^v/, "")}.tgz`;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
}

export async function buildOpencodePluginDeps(packageRoot) {
  const constants = JSON.parse(await readFile(resolve(packageRoot, "..", "..", "constants.json"), "utf8"));
  const version = String(constants.opencodeVersion).replace(/^v/, "");
  const staging = await mkdtemp(join(tmpdir(), "openwork-opencode-plugin-deps-"));
  try {
    // The same manifest OpenCode's installer saves (exact version, no prefix).
    await writeFile(
      join(staging, "package.json"),
      `${JSON.stringify({ dependencies: { [OPENCODE_PLUGIN_PACKAGE]: version } }, null, 2)}\n`,
    );
    // OpenCode installs with scripts ignored; match it.
    run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"], staging);
    const outDir = resolve(packageRoot, "dist");
    await mkdir(outDir, { recursive: true });
    const archive = join(outDir, opencodePluginDepsArchiveName(version));
    await rm(archive, { force: true });
    run("tar", ["-czf", archive, "-C", staging, "package.json", "package-lock.json", "node_modules"], staging);
    return archive;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  buildOpencodePluginDeps(packageRoot)
    .then((archive) => console.log(`Wrote ${archive}`))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
