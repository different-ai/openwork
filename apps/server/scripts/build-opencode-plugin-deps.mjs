// Pre-resolves the dependency OpenCode installs into its global config folder
// the first time it loads a folder with plugins configured
// (`npm install @opencode-ai/plugin@<engine version>`), and packs the result
// as dist/opencode-plugin-deps-<version>.tgz. `openwork-server web` extracts
// it on a fresh profile so the first folder load skips that install
// (10-15 s on Windows, measured on a 2 vCPU Defender-enabled machine).
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const OPENCODE_PLUGIN_PACKAGE = "@opencode-ai/plugin";

export function opencodePluginDepsArchiveName(opencodeVersion) {
  return `opencode-plugin-deps-${opencodeVersion.replace(/^v/, "")}.tgz`;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(command),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
}

// Code hidden inside a tarball is not signed by electron-builder's nested-code
// walk. Keep this install portable and fail closed if a dependency adds native code.
export async function assertPortablePluginDeps(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await assertPortablePluginDeps(path);
    } else if (entry.isFile()) {
      const file = await open(path, "r");
      const magic = Buffer.alloc(4);
      try {
        await file.read(magic, 0, 4, 0);
      } finally {
        await file.close();
      }
      const nativeMagic = [
        "7f454c46", // ELF
        "feedface", "cefaedfe", "feedfacf", "cffaedfe", // Mach-O
        "cafebabe", "bebafeca", "cafebabf", "bfbafeca", // universal Mach-O
      ].includes(magic.toString("hex"));
      if (entry.name.endsWith(".node") || nativeMagic || magic.subarray(0, 2).toString() === "MZ") {
        throw new Error(`Native code cannot be bundled in the portable plugin dependency archive: ${path}`);
      }
    }
  }
}

export async function buildOpencodePluginDeps(packageRoot, { runCommand = run } = {}) {
  const constants = JSON.parse(await readFile(resolve(packageRoot, "..", "..", "constants.json"), "utf8"));
  const version = String(constants.opencodeVersion).replace(/^v/, "");
  const staging = await mkdtemp(join(tmpdir(), "openwork-opencode-plugin-deps-"));
  try {
    // The same manifest OpenCode's installer saves (exact version, no prefix).
    await writeFile(
      join(staging, "package.json"),
      `${JSON.stringify({ dependencies: { [OPENCODE_PLUGIN_PACKAGE]: version } }, null, 2)}\n`,
    );
    // Match OpenCode's ignored scripts, but omit optional native accelerators
    // (msgpackr-extract). The archive must work across platforms, and nested
    // Mach-O files inside it cannot receive our Developer ID signature.
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    runCommand(npm, ["install", "--ignore-scripts", "--omit=optional", "--no-audit", "--no-fund", "--loglevel=error"], staging);
    await assertPortablePluginDeps(join(staging, "node_modules"));
    const outDir = resolve(packageRoot, "dist");
    await mkdir(outDir, { recursive: true });
    const archive = join(outDir, opencodePluginDepsArchiveName(version));
    await rm(archive, { force: true });
    // Git Bash puts GNU tar first on Windows. Its archive operand must not
    // contain a drive letter: C:\... is parsed as a remote host, not a file.
    runCommand("tar", ["-czf", basename(archive), "-C", staging, "package.json", "package-lock.json", "node_modules"], outDir);
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
