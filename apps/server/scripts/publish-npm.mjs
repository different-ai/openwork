import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MIN_NODE_VERSION } from "../bin/platform.mjs";

// Dependencies the Node bundle leaves external (see build:npm-bundle); npm
// installs them next to the package.
export const BUNDLE_EXTERNAL_DEPENDENCIES = ["jsonc-parser"];

// Stages the published openwork-server package:
//   bin/                      launcher
//   dist/openwork-server.mjs  the server, bundled for Node (every OS and CPU)
//   dist/pdfium.wasm          loaded next to the bundle by PDF attachments
//   dist/opencode-plugins/    plugins handed to the OpenCode engine
//   web/                      the web UI served by `openwork-server web`
export async function stageNpmPackage(packageRoot, outputRoot = resolve(packageRoot, "dist/npm")) {
  const sourcePackage = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));

  const bundle = resolve(packageRoot, "dist/npm-bundle/openwork-server.mjs");
  const bundleInfo = await stat(bundle).catch(() => null);
  if (!bundleInfo || !bundleInfo.isFile() || bundleInfo.size < 100_000) {
    throw new Error(`Node bundle missing at ${bundle}. Run: pnpm --filter openwork-server build:npm-bundle`);
  }
  const webDist = resolve(packageRoot, "..", "app", "dist");
  if (!existsSync(resolve(webDist, "index.html"))) {
    throw new Error(`Web UI bundle missing at ${webDist}. Run: pnpm --filter @openwork/app build:selfhost`);
  }
  const pluginDist = resolve(packageRoot, "dist/opencode-plugins");
  if (!existsSync(resolve(pluginDist, "openwork-extensions-preview.js"))) {
    throw new Error(`OpenCode plugin bundle missing at ${pluginDist}. Run: pnpm --filter openwork-server build`);
  }
  const pdfiumWasm = resolve(pluginDist, "pdfium.wasm");
  if (!existsSync(pdfiumWasm)) {
    throw new Error(`pdfium.wasm missing at ${pdfiumWasm}. Run: pnpm --filter openwork-server build`);
  }

  const dependencies = {};
  for (const name of BUNDLE_EXTERNAL_DEPENDENCIES) {
    const range = sourcePackage.dependencies?.[name];
    if (!range) throw new Error(`${name} is external to the bundle but not a dependency of ${sourcePackage.name}`);
    dependencies[name] = range;
  }

  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(resolve(outputRoot, "bin"), { recursive: true });
  await mkdir(resolve(outputRoot, "dist"), { recursive: true });
  await cp(resolve(packageRoot, "bin/openwork-server.mjs"), resolve(outputRoot, "bin/openwork-server.mjs"));
  await cp(resolve(packageRoot, "bin/platform.mjs"), resolve(outputRoot, "bin/platform.mjs"));
  await cp(bundle, resolve(outputRoot, "dist/openwork-server.mjs"));
  await cp(pdfiumWasm, resolve(outputRoot, "dist/pdfium.wasm"));
  await cp(pluginDist, resolve(outputRoot, "dist/opencode-plugins"), {
    recursive: true,
    filter: (source) => !/\.test\.[cm]?js$/.test(source),
  });
  await cp(webDist, resolve(outputRoot, "web"), { recursive: true });
  await cp(resolve(packageRoot, "README.md"), resolve(outputRoot, "README.md"));
  await writeFile(
    resolve(outputRoot, "package.json"),
    `${JSON.stringify(
      {
        name: sourcePackage.name,
        version: sourcePackage.version,
        description: sourcePackage.description,
        type: sourcePackage.type,
        bin: sourcePackage.bin,
        engines: { node: `>=${MIN_NODE_VERSION}` },
        dependencies,
        repository: sourcePackage.repository,
        homepage: sourcePackage.homepage,
        bugs: sourcePackage.bugs,
        keywords: sourcePackage.keywords,
        license: sourcePackage.license,
        publishConfig: sourcePackage.publishConfig,
      },
      null,
      2,
    )}\n`,
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

  const result = spawnSync(process.execPath, [pnpmCli, "--config.git-checks=false", "publish", ...args], {
    cwd: outputRoot,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
