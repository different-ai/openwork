import { build } from "esbuild";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_PLUGIN_DEPENDENCIES, NATIVE_PLUGIN_VERSION, validateNativePluginManifest } from "./native-plugin.mjs";
import { COLLABORATION_PLUGIN } from "./collaboration-plugin.mjs";
import { BROWSER_PLUGIN } from "./browser-plugin.mjs";
import { COMPUTER_PLUGIN } from "./computer-plugin.mjs";
import { GROUP_DOCUMENT_PLUGIN } from "./group-document-plugin.mjs";
import { PROGRESS_PLUGIN } from "./progress-plugin.mjs";
import { MEMORY_PLUGIN } from "./memory-model.mjs";
import { TURN_ROLES_PLUGIN } from "./turn-roles-plugin.mjs";
import { EVENT_PLUGIN } from "./event-plugin.mjs";
import { ABILITIES_PLUGIN } from "./abilities-plugin.mjs";

/** Build-time only. This module must not be imported by Electron main.
 * Dependencies are installed once in a dedicated build staging directory;
 * runtime installs copy verified self-contained ESM, with no package manager. */
export async function prepareNativePluginBundles({ outputDirectory, dependencyDirectory, installDependencies = true }) {
  if (![outputDirectory, dependencyDirectory].every((value) => typeof value === "string" && path.isAbsolute(value))
    || outputDirectory === dependencyDirectory) throw new Error("Use separate absolute build staging and output directories.");
  if (installDependencies) await mkdir(dependencyDirectory, { recursive: true });
  const packageFile = path.join(dependencyDirectory, "package.json");
  const existing = await readFile(packageFile, "utf8").catch((error) => { if (error.code !== "ENOENT") throw error; return null; });
  if (existing) {
    const pkg = JSON.parse(existing);
    if (Object.entries(NATIVE_PLUGIN_DEPENDENCIES).some(([name, version]) => pkg.dependencies?.[name] !== version)) throw new Error(`Native plugin build dependencies are not pinned to ${NATIVE_PLUGIN_VERSION}. Use a dedicated staging directory.`);
  } else if (installDependencies) await writeFile(packageFile, JSON.stringify({ private: true, type: "module", dependencies: NATIVE_PLUGIN_DEPENDENCIES }, null, 2) + "\n");
  else throw new Error("Native plugin build dependencies are unavailable in read-only staging.");
  const workspaceFile = path.join(dependencyDirectory, "pnpm-workspace.yaml");
  const workspace = await readFile(workspaceFile, "utf8").catch((error) => { if (error.code !== "ENOENT") throw error; return null; });
  if (workspace !== null && workspace.trim() !== "packages: []") throw new Error("Native plugin staging must not reuse another pnpm workspace.");
  if (workspace === null && installDependencies) await writeFile(workspaceFile, "packages: []\n");
  const installed = async () => {
    for (const [name, version] of Object.entries(NATIVE_PLUGIN_DEPENDENCIES)) {
      const pkg = await readFile(path.join(dependencyDirectory, "node_modules", name, "package.json"), "utf8").catch((error) => { if (error.code !== "ENOENT") throw error; return null; });
      if (!pkg || JSON.parse(pkg).version !== version) return false;
    }
    return true;
  };
  if (!await installed()) {
    if (!installDependencies) throw new Error("Native plugin build dependencies are unavailable in read-only staging.");
    const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    await new Promise((resolve, reject) => {
      const child = spawn(command, ["install", "--ignore-scripts", "--config.auto-install-peers=false", "--config.ignore-pnpmfile=true"], { cwd: dependencyDirectory, stdio: "ignore", shell: process.platform === "win32", timeout: 120_000 });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("Native plugin build dependency preparation failed.")));
    });
  }
  if (!await installed()) throw new Error("Native plugin build dependency verification failed.");
  const sources = { "coworker-collaboration.js": COLLABORATION_PLUGIN, "coworker-browser.js": BROWSER_PLUGIN, "coworker-computer.js": COMPUTER_PLUGIN,
    "coworker-group-documents.js": GROUP_DOCUMENT_PLUGIN, "progress-summary.js": PROGRESS_PLUGIN, "auto-memory.js": MEMORY_PLUGIN, "coworker-turn-roles.js": TURN_ROLES_PLUGIN,
    "coworker-events.js": EVENT_PLUGIN, "coworker-abilities.js": ABILITIES_PLUGIN };
  await mkdir(outputDirectory, { recursive: true });
  const entries = {};
  for (const [name, contents] of Object.entries(sources)) {
    const result = await build({ stdin: { contents, sourcefile: name, resolveDir: dependencyDirectory, loader: "js" }, bundle: true,
      platform: "node", format: "esm", target: "node22", write: false, metafile: true, legalComments: "eof", treeShaking: true, logLevel: "silent" });
    if (Object.values(result.metafile.outputs).some((output) => output.imports.some((entry) => entry.external && !isBuiltin(entry.path)))) throw new Error(`Native plugin ${name} retained an external package import.`);
    const bytes = result.outputFiles[0].contents;
    const file = name.replace(/\.js$/, ".mjs");
    await writeFile(path.join(outputDirectory, `${file}.tmp`), bytes);
    await rename(path.join(outputDirectory, `${file}.tmp`), path.join(outputDirectory, file));
    entries[name] = { file, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
  }
  const manifest = validateNativePluginManifest({ format: "coworker-native-plugins/v1", opencodeVersion: NATIVE_PLUGIN_VERSION, dependencies: NATIVE_PLUGIN_DEPENDENCIES, entries });
  await writeFile(path.join(outputDirectory, "manifest.json.tmp"), JSON.stringify(manifest, null, 2) + "\n");
  await rename(path.join(outputDirectory, "manifest.json.tmp"), path.join(outputDirectory, "manifest.json"));
  return { directory: outputDirectory, manifest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const resources = fileURLToPath(new URL("../resources/", import.meta.url));
  const [outputDirectory = path.join(resources, "native-plugins"), dependencyDirectory = path.join(resources, "sidecars", `.native-plugin-sdk-${NATIVE_PLUGIN_VERSION}`)] = process.argv.slice(2);
  const result = await prepareNativePluginBundles({ outputDirectory, dependencyDirectory });
  console.log(JSON.stringify({ directory: result.directory, plugins: Object.keys(result.manifest.entries).length }));
}
