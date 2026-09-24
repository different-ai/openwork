import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SERVER_BINARY_TARGETS, serverBinaryName, serverPlatformPackageName } from "../bin/platform.mjs";

export const MAIN_PACKAGE_DIR = "openwork-server";

// Stages every npm package into its own directory under outputRoot:
//   <outputRoot>/openwork-server/                launcher, web UI, plugins
//   <outputRoot>/openwork-server-<os>-<arch>/     one host binary each
// Platform packages are published before the main package, which pins them
// as optionalDependencies at the same version.
export async function stageNpmPackages(packageRoot, outputRoot = resolve(packageRoot, "dist/npm")) {
  const sourcePackage = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
  const shared = {
    version: sourcePackage.version,
    repository: sourcePackage.repository,
    homepage: sourcePackage.homepage,
    bugs: sourcePackage.bugs,
    license: sourcePackage.license,
    publishConfig: sourcePackage.publishConfig,
  };

  await rm(outputRoot, { recursive: true, force: true });

  const platforms = [];
  for (const { platform, arch } of SERVER_BINARY_TARGETS) {
    const name = serverPlatformPackageName(platform, arch);
    const binaryName = serverBinaryName(platform, arch);
    const source = resolve(packageRoot, "dist/bin", binaryName);
    const info = await stat(source).catch(() => null);
    if (!info || !info.isFile() || info.size < 1_000_000) {
      throw new Error(`Missing or incomplete OpenWork server binary: ${binaryName}`);
    }
    const dir = resolve(outputRoot, name);
    await mkdir(resolve(dir, "bin"), { recursive: true });
    await cp(source, resolve(dir, "bin", binaryName));
    await chmod(resolve(dir, "bin", binaryName), 0o755);
    await writeFile(
      resolve(dir, "README.md"),
      `# ${name}\n\nThe ${platform}/${arch} binary for [openwork-server](https://www.npmjs.com/package/openwork-server). Install \`openwork-server\` instead; npm selects this package automatically.\n`,
    );
    await writeFile(
      resolve(dir, "package.json"),
      `${JSON.stringify(
        {
          name,
          ...shared,
          description: `The ${platform}/${arch} binary for openwork-server.`,
          os: [platform],
          cpu: [arch],
          files: ["bin", "README.md"],
        },
        null,
        2,
      )}\n`,
    );
    platforms.push({ name, platform, arch, binaryName, dir });
  }

  const mainDir = resolve(outputRoot, MAIN_PACKAGE_DIR);
  await mkdir(resolve(mainDir, "bin"), { recursive: true });
  await cp(resolve(packageRoot, "bin/openwork-server.mjs"), resolve(mainDir, "bin/openwork-server.mjs"));
  await cp(resolve(packageRoot, "bin/platform.mjs"), resolve(mainDir, "bin/platform.mjs"));
  // `openwork-server web` serves this bundle and hands these plugins to the engine.
  const webDist = resolve(packageRoot, "..", "app", "dist");
  if (!existsSync(resolve(webDist, "index.html"))) {
    throw new Error(`Web UI bundle missing at ${webDist}. Run: pnpm --filter @openwork/app build:selfhost`);
  }
  await cp(webDist, resolve(mainDir, "web"), { recursive: true });
  const pluginDist = resolve(packageRoot, "dist/opencode-plugins");
  if (!existsSync(resolve(pluginDist, "openwork-extensions-preview.js"))) {
    throw new Error(`OpenCode plugin bundle missing at ${pluginDist}. Run: pnpm --filter openwork-server build`);
  }
  await cp(pluginDist, resolve(mainDir, "dist/opencode-plugins"), {
    recursive: true,
    filter: (source) => !/\.test\.[cm]?js$/.test(source),
  });
  await cp(resolve(packageRoot, "README.md"), resolve(mainDir, "README.md"));
  await writeFile(
    resolve(mainDir, "package.json"),
    `${JSON.stringify(
      {
        name: sourcePackage.name,
        ...shared,
        description: sourcePackage.description,
        type: sourcePackage.type,
        bin: sourcePackage.bin,
        keywords: sourcePackage.keywords,
        optionalDependencies: Object.fromEntries(platforms.map(({ name }) => [name, sourcePackage.version])),
      },
      null,
      2,
    )}\n`,
  );

  return { main: mainDir, platforms };
}

async function main() {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const staged = await stageNpmPackages(packageRoot);
  const args = process.argv.slice(2);
  if (args.includes("--prepare-only")) return;

  const pnpmCli = process.env.npm_execpath;
  if (!pnpmCli) throw new Error("pnpm executable path is unavailable");

  for (const cwd of [...staged.platforms.map(({ dir }) => dir), staged.main]) {
    const result = spawnSync(process.execPath, [pnpmCli, "--config.git-checks=false", "publish", ...args], {
      cwd,
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
