import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SERVER_BINARY_TARGETS, serverBinaryName } from "../bin/platform.mjs";

export async function stageNpmPackage(packageRoot, outputRoot = resolve(packageRoot, "dist/npm")) {
  const sourcePackage = JSON.parse(
    await readFile(resolve(packageRoot, "package.json"), "utf8")
  );

  const publishedPackage = {
    name: sourcePackage.name,
    version: sourcePackage.version,
    description: sourcePackage.description,
    type: sourcePackage.type,
    bin: sourcePackage.bin,
    repository: sourcePackage.repository,
    homepage: sourcePackage.homepage,
    bugs: sourcePackage.bugs,
    keywords: sourcePackage.keywords,
    license: sourcePackage.license,
    publishConfig: sourcePackage.publishConfig
  };

  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(resolve(outputRoot, "bin"), { recursive: true });
  await mkdir(resolve(outputRoot, "dist/bin"), { recursive: true });
  await cp(resolve(packageRoot, "bin/openwork-server.mjs"), resolve(outputRoot, "bin/openwork-server.mjs"));
  await cp(resolve(packageRoot, "bin/platform.mjs"), resolve(outputRoot, "bin/platform.mjs"));
  for (const { platform, arch } of SERVER_BINARY_TARGETS) {
    const binaryName = serverBinaryName(platform, arch);
    const source = resolve(packageRoot, "dist/bin", binaryName);
    const info = await stat(source);
    if (!info.isFile() || info.size < 1_000_000) {
      throw new Error(`Missing or incomplete OpenWork server binary: ${binaryName}`);
    }
    await cp(source, resolve(outputRoot, "dist/bin", binaryName));
  }
  // `openwork-server web` serves this bundle and hands these plugins to the engine.
  const webDist = resolve(packageRoot, "..", "app", "dist");
  if (!existsSync(resolve(webDist, "index.html"))) {
    throw new Error(`Web UI bundle missing at ${webDist}. Run: pnpm --filter @openwork/app build:selfhost`);
  }
  await cp(webDist, resolve(outputRoot, "web"), { recursive: true });
  const pluginDist = resolve(packageRoot, "dist/opencode-plugins");
  if (!existsSync(resolve(pluginDist, "openwork-extensions-preview.js"))) {
    throw new Error(`OpenCode plugin bundle missing at ${pluginDist}. Run: pnpm --filter openwork-server build`);
  }
  await cp(pluginDist, resolve(outputRoot, "dist/opencode-plugins"), {
    recursive: true,
    filter: (source) => !/\.test\.[cm]?js$/.test(source),
  });
  await cp(resolve(packageRoot, "README.md"), resolve(outputRoot, "README.md"));
  await writeFile(
    resolve(outputRoot, "package.json"),
    `${JSON.stringify(publishedPackage, null, 2)}\n`
  );
  return outputRoot;
}

async function main() {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const outputRoot = await stageNpmPackage(packageRoot);
  const args = process.argv.slice(2);
  if (args.includes("--prepare-only")) return;

  const pnpmCli = process.env.npm_execpath;
  if (!pnpmCli) throw new Error("pnpm executable path is unavailable");

  const result = spawnSync(
    process.execPath,
    [pnpmCli, "--config.git-checks=false", "publish", ...args],
    { cwd: outputRoot, stdio: "inherit" }
  );
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
