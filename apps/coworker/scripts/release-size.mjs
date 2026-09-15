import { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { NATIVE_PLUGIN_DEPENDENCIES, NATIVE_PLUGIN_FILES, NATIVE_PLUGIN_VERSION, validateNativePluginManifest } from "../electron/native-plugin.mjs";
import nativeRuntime from "../native-runtime.json" with { type: "json" };

const MiB = 1024 ** 2;
const topN = 20;
// Historical v1 macOS ARM64 candidate: 489.52 MiB. Native v2 is not yet measured.
const targetBudgetsMiB = { "darwin/arm64": 512 };
const usage = "node apps/coworker/scripts/release-size.mjs <packaged-app-directory> [--check] [--max-mib N] [--json report.json] [--platform darwin|win32|linux] [--arch arm64|x64]";

function main() {
  const options = {};
  let appArgument;
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") return console.log(usage);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--check") options.check = true;
    else if (["--max-mib", "--json", "--platform", "--arch"].includes(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`Missing value for ${arg}`);
      if (Object.hasOwn(options, arg)) throw new Error(`Repeated option: ${arg}`);
      options[arg] = args[++i];
    } else if (arg.startsWith("-") || appArgument) throw new Error(`Unexpected argument: ${arg}`);
    else appArgument = arg;
  }
  if (!appArgument) throw new Error(usage);
  const requestedMaxMiB = options["--max-mib"] === undefined ? null : Number(options["--max-mib"]);
  if (requestedMaxMiB !== null && (!Number.isFinite(requestedMaxMiB) || requestedMaxMiB <= 0)) throw new Error("--max-mib must be a positive finite number");
  if (options["--platform"] && !["darwin", "win32", "linux"].includes(options["--platform"])) throw new Error("Invalid --platform");
  if (options["--arch"] && !["arm64", "x64"].includes(options["--arch"])) throw new Error("Invalid --arch");
  const app = realpathSync(resolve(appArgument));
  if (!lstatSync(app).isDirectory()) throw new Error("Supply the exact packaged app directory, not an installer or ASAR");
  const platform = app.endsWith(".app") ? "darwin" : readdirSync(app).some((name) => name.endsWith(".exe")) ? "win32" : "linux";
  if (options["--platform"] && options["--platform"] !== platform) throw new Error("--platform disagrees with the packaged app layout");
  const resources = platform === "darwin" ? "Contents/Resources/" : "resources/";
  const archiveName = `${resources}app.asar`;
  const unpacked = `${archiveName}.unpacked/`;
  let output;
  if (options["--json"]) {
    const requested = resolve(options["--json"]);
    output = join(realpathSync(dirname(requested)), basename(requested));
    const location = relative(app, output);
    if (!location || (!isAbsolute(location) && location !== ".." && !location.startsWith(`..${sep}`))) {
      throw new Error("--json must be outside the packaged app (including symlinked parents)");
    }
  }
  const archivePath = join(app, archiveName);
  if (!lstatSync(archivePath, { throwIfNoEntry: false })?.isFile()) throw new Error(`Missing ${archiveName}; supply one completed packaged app`);

  // Never follow symlinks: framework aliases must not multiply the disk total.
  const disk = new Map();
  function walk(directory, prefix = "") {
    for (const name of readdirSync(directory).sort()) {
      const path = `${prefix}${name}`;
      const stat = lstatSync(join(directory, name));
      disk.set(path, stat);
      if (stat.isDirectory()) walk(join(directory, name), `${path}/`);
    }
  }
  walk(app);
  if (!disk.get(archiveName)?.isFile() || disk.get(archiveName).size === 0) throw new Error(`Missing nonempty ${archiveName}; supply one completed packaged app`);
  const require = createRequire(import.meta.url);
  const builderRequire = createRequire(require.resolve("electron-builder"));
  const libraryRequire = createRequire(builderRequire.resolve("app-builder-lib"));
  const asar = libraryRequire("@electron/asar");
  const archive = new Map();
  function walkHeader(files, prefix = "", parentUnpacked = false) {
    for (const [name, entry] of Object.entries(files)) {
      const path = `${prefix}${name}`;
      const node = { ...entry, unpacked: parentUnpacked || entry.unpacked === true };
      archive.set(path, node);
      if (node.files) walkHeader(node.files, `${path}/`, node.unpacked);
      else if (!Object.hasOwn(node, "link") && (!Number.isSafeInteger(node.size) || node.size < 0)) throw new Error(`Invalid ASAR file size: ${path}`);
    }
  }
  walkHeader(asar.getRawHeader(archivePath).header.files);

  const buckets = { electronFramework: 0, asar: 0, unpackedDependencies: 0, sidecars: 0, plugins: 0, helperOther: 0 };
  const dependencies = new Map();
  function attribute(path, bytes, storage) {
    // The innermost package owns nested dependency files; aliases own no bytes.
    const name = [...path.matchAll(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/g)].at(-1)?.[1];
    if (!name || name.startsWith(".")) return;
    if (!dependencies.has(name)) dependencies.set(name, { name, bytes: 0, asarBytes: 0, unpackedBytes: 0 });
    const dependency = dependencies.get(name);
    dependency.bytes += bytes;
    dependency[storage] += bytes;
  }
  let totalBytes = 0;
  let fileCount = 0;
  for (const [path, stat] of disk) {
    if (!stat.isFile()) continue;
    let bucket = "helperOther";
    if (path === archiveName) bucket = "asar";
    else if (path.startsWith(unpacked) && /(?:^|\/)node_modules\//.test(path.slice(unpacked.length))) bucket = "unpackedDependencies";
    else if (path.startsWith(`${resources}sidecars/`)) bucket = "sidecars";
    else if (path.startsWith(`${resources}native-plugins/`) || path.startsWith(`${resources}opencode-plugins/`)) bucket = "plugins";
    else if (platform === "darwin" ? /^(Contents\/(Frameworks|MacOS)\/|Contents\/Resources\/[^/]+\.lproj\/)/.test(path) : !path.startsWith(resources)) bucket = "electronFramework";
    buckets[bucket] += stat.size;
    totalBytes += stat.size;
    fileCount++;
    if (path.startsWith(unpacked)) attribute(path.slice(unpacked.length), stat.size, "unpackedBytes");
  }
  for (const [path, entry] of archive) {
    if (!entry.files && !Object.hasOwn(entry, "link") && !entry.unpacked) attribute(path, entry.size, "asarBytes");
  }

  const sidecars = `${resources}sidecars/`;
  const failures = [];
  function resourceBytes(path) {
    const stat = disk.get(`${resources}${path}`);
    if (!stat?.isFile() || stat.size === 0) throw new Error("expected a nonempty regular resource file");
    return readFileSync(join(app, resources, path));
  }
  function archiveBytes(path) {
    const entry = archive.get(path);
    if (!entry || entry.files || Object.hasOwn(entry, "link") || entry.size === 0) throw new Error("expected a nonempty ASAR file");
    if (entry.unpacked && (!disk.get(`${unpacked}${path}`)?.isFile() || disk.get(`${unpacked}${path}`).size !== entry.size)) {
      throw new Error("missing or mismatched unpacked ASAR file");
    }
    return asar.extractFile(archivePath, path);
  }
  function readJson(path, read) {
    try {
      const value = JSON.parse(read().toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected a JSON object");
      return value;
    } catch (error) {
      if (options.check) failures.push(`Invalid or missing JSON ${path}: ${error.message}`);
      return null;
    }
  }
  const metadata = readJson("sidecars/versions.json", () => resourceBytes("sidecars/versions.json"));
  const sidecar = metadata?.opencode2;
  const engineArch = ["arm64", "x64"].includes(sidecar?.arch) ? sidecar.arch : null;
  if (options.check) {
    function reject(label, paths) {
      if (paths.length) failures.push(`${label}: ${paths.length}; ${paths.slice(0, 5).join(", ")}${paths.length > 5 ? ", ..." : ""}`);
    }
    const allPaths = [...archive.keys(), ...disk.keys()];
    // Match executable aliases/target triples, not server modules such as
    // opencode-v2-binary.js or opencode-connection.js.
    const executablePattern = /^(opencode2?)(?:-(?:aarch64|x86_64)-(?:apple-darwin|unknown-linux-(?:gnu|musl)|pc-windows-msvc))?(?:\.exe)?$/;
    const engine = `${sidecars}${platform === "win32" ? "opencode2.exe" : "opencode2"}`;
    const engines = allPaths.filter((path) => basename(path).match(executablePattern)?.[1] === "opencode2");
    if (engines.length !== 1 || engines[0] !== engine || !disk.get(engine)?.isFile() || disk.get(engine).size === 0) {
      failures.push(`Expected exactly one nonempty native engine at ${engine}; found: ${engines.join(", ") || "none"}`);
    }
    const constants = readJson("source constants.json", () => readFileSync(new URL("../../../constants.json", import.meta.url)));
    const packagedConstants = readJson("server/dist/constants.json", () => archiveBytes("server/dist/constants.json"));
    if (!constants || !packagedConstants || packagedConstants.opencodeVersion !== constants.opencodeVersion ||
        packagedConstants.opencodeV2Version !== constants.opencodeV2Version) {
      failures.push("Packaged shared server constants must retain the source Desktop defaults");
    }
    const packagedRuntime = readJson("electron-dist/native-runtime.json", () => archiveBytes("electron-dist/native-runtime.json"));
    const pin = nativeRuntime.opencodeV2Version;
    if (typeof pin !== "string" || !pin || packagedRuntime?.opencodeV2Version !== pin ||
        sidecar?.version !== pin || Object.keys(metadata ?? {}).length !== 1 ||
        sidecar?.platform !== platform || !engineArch || (options["--arch"] && engineArch !== options["--arch"])) {
      failures.push(`Native sidecar metadata and packaged Coworker runtime must match pin ${pin ?? "missing"} and target ${platform}/${options["--arch"] ?? "arm64 or x64"}, with native-only metadata`);
    }
    reject("Unexpected sidecar resources", [...disk.keys()].filter((path) => path.startsWith(sidecars) && path !== engine && path !== `${sidecars}versions.json`));
    reject("Legacy OpenCode executables", allPaths.filter((path) => basename(path).match(executablePattern)?.[1] === "opencode" &&
      !disk.get(path)?.isDirectory() && !archive.get(path)?.files));
    reject("Legacy plugin resources", allPaths.filter((path) => /(?:^|\/)opencode-plugins(?:\/|$)/.test(path)));
    reject("Duplicate ASAR native plugin bundles", [...archive.keys()].filter((path) => /(?:^|\/)native-plugins(?:\/|$)/.test(path)));
    // Native plugin/schema dependencies are bundled at build time. Shipping a
    // legacy runtime closure is a release blocker, not permission to prune imports.
    const forbidden = ["@opencode-ai/sdk", "@opencode-ai/plugin", "opencode-chrome-devtools", "better-sqlite3", "drizzle-orm"];
    reject("Forbidden packaged legacy dependencies", allPaths.filter((path) =>
      [...path.matchAll(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/g)].some((match) => forbidden.includes(match[1]))));
    function checkPackage(path, read) {
      const pkg = readJson(path, read);
      if (!pkg) return;
      const declared = new Set(forbidden.includes(pkg.name) ? [pkg.name] : []);
      for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
        for (const [name, version] of Object.entries(pkg[field] ?? {})) {
          if (forbidden.includes(name) || (typeof version === "string" && forbidden.some((dependency) => version.startsWith(`npm:${dependency}@`)))) declared.add(name);
        }
      }
      if (declared.size) failures.push(`Forbidden packaged legacy dependency declaration in ${path}: ${[...declared].join(", ")}`);
    }
    for (const [path, entry] of archive) {
      if (basename(path) === "package.json" && !entry.files && !Object.hasOwn(entry, "link")) checkPackage(path, () => archiveBytes(path));
    }
    for (const [path, stat] of disk) {
      if (basename(path) === "package.json" && stat.isFile() && !(path.startsWith(unpacked) && archive.has(path.slice(unpacked.length)))) {
        checkPackage(path, () => readFileSync(join(app, path)));
      }
    }
    const pluginRoot = "native-plugins/";
    const manifest = readJson(`${pluginRoot}manifest.json`, () => resourceBytes(`${pluginRoot}manifest.json`));
    // The complete source set emitted by prepareNativePluginBundles. Checking
    // only declared files lets an omitted mandatory plugin disappear unnoticed.
    const requiredPlugins = NATIVE_PLUGIN_FILES;
    try { validateNativePluginManifest(manifest); }
    catch (error) { failures.push(`Native startup preflight: ${error.message}`); }
    function hasExactKeys(value, keys) {
      return value !== null && typeof value === "object" && !Array.isArray(value) &&
        Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
    }
    if (manifest?.format !== "coworker-native-plugins/v1" || manifest.opencodeVersion !== pin || pin !== NATIVE_PLUGIN_VERSION ||
        !hasExactKeys(manifest.dependencies, Object.keys(NATIVE_PLUGIN_DEPENDENCIES)) ||
        Object.entries(NATIVE_PLUGIN_DEPENDENCIES).some(([name, version]) => manifest.dependencies[name] !== version)) {
      failures.push("Native plugin manifest must declare the exact runtime version and dependency set, including the pinned plugin/schema, Effect and Zod versions");
    }
    if (!hasExactKeys(manifest?.entries, requiredPlugins)) {
      failures.push(`Native plugin manifest must declare exactly these ${requiredPlugins.length} source entries: ${requiredPlugins.join(", ")}`);
    }
    const pluginFiles = new Set([`${resources}${pluginRoot}manifest.json`]);
    for (const [name, entry] of Object.entries(manifest?.entries ?? {})) {
      if (!/^[a-z0-9-]+\.js$/.test(name) || entry?.file !== name.replace(/\.js$/, ".mjs") ||
          !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
        failures.push(`Invalid native plugin bundle declaration: ${name}`);
        continue;
      }
      const path = `${pluginRoot}${entry.file}`;
      pluginFiles.add(`${resources}${path}`);
      try {
        const bytes = resourceBytes(path);
        if (bytes.length !== entry.bytes || createHash("sha256").update(bytes).digest("hex") !== entry.sha256) throw new Error("size or SHA-256 mismatch");
      } catch (error) {
        failures.push(`Invalid or missing native plugin bundle ${path}: ${error.message}`);
      }
    }
    reject("Undeclared native plugin resources", [...disk.keys()].filter((path) => path.startsWith(`${resources}${pluginRoot}`) && !pluginFiles.has(path)));
    reject("Renderer source maps", [...archive.keys()].filter((path) => /^dist\/.*\.map$/.test(path)));
    reject("Server test artifacts", [...archive.keys()].filter((path) => /^server\/.*\.test\.js(?:\.map)?$/.test(path)));
    reject("Dependency source maps", [...archive.keys()].filter((path) => /(?:^|\/)node_modules\/.*\.map$/.test(path)));
    reject("Dependency declarations", [...archive.keys()].filter((path) => /(?:^|\/)node_modules\/.*\.d\.[mc]?ts$/.test(path)));
    reject("Packaging-only icon files", [...archive.keys()].filter((path) => /^resources\/icons\/(?!icon(?:-macos)?\.png$)/.test(path)));
    reject("Bundled-only packages", [...archive.keys(), ...disk.keys()].filter((path) => /(?:^|\/)node_modules\/@openwork\/(computer-use|ui)(?:\/|$)/.test(path)));
    reject("Unpacked native build debris", [...disk.keys()].filter((path) => path.startsWith(unpacked) && /(?:^|\/)node_modules\//.test(path.slice(unpacked.length)) && /(?:^|\/)(?:\.build|[^/]+\.dSYM)(?:\/|$)/.test(path)));
    const nativeServerPackage = readJson("server/package.json", () => archiveBytes("server/package.json"));
    if (nativeServerPackage?.name !== "@openwork/coworker-runtime" || nativeServerPackage.exports?.["."] !== "./dist/embedded-native.js" || nativeServerPackage.bin) {
      failures.push("Coworker must package the native-only embedded server entry, not the generic server CLI");
    }
    for (const path of [
      "package.json", "dist/index.html", "electron-dist/main.mjs", "electron-dist/preload.mjs", "electron-dist/native-runtime.json",
      "electron-dist/browser-content-preload.cjs", "electron-dist/maintenance-helper.mjs", "electron-dist/THIRD-PARTY-NOTICES",
      "server/package.json", "server/dist/embedded.js", "server/dist/embedded-native.js", "server/dist/constants.json",
    ]) {
      const entry = archive.get(path);
      const present = entry && !entry.files && !Object.hasOwn(entry, "link") && entry.size > 0 &&
        (!entry.unpacked || (disk.get(`${unpacked}${path}`)?.isFile() && disk.get(`${unpacked}${path}`).size > 0));
      if (!present) failures.push(`Missing nonempty ASAR runtime entry: ${path}`);
    }
    const requiredResources = [];
    if (platform === "darwin") requiredResources.push(
      "helpers/OpenWork Computer Use.app/Contents/MacOS/ComputerUse",
      "helpers/OpenWork Computer Use.app/Contents/Info.plist",
    );
    for (const path of requiredResources) {
      const stat = disk.get(`${resources}${path}`);
      if (!stat?.isFile() || stat.size === 0) failures.push(`Missing nonempty runtime resource: ${path}`);
    }
  }

  const maxMiB = requestedMaxMiB ?? (options.check ? targetBudgetsMiB[`${platform}/${options["--arch"] ?? engineArch}`] ?? null : null);
  const budget = maxMiB === null ? null : { maxMiB, passed: totalBytes / MiB <= maxMiB };
  const report = {
    appDirectory: app,
    platform,
    engineArch,
    engineVersion: sidecar?.version ?? null,
    expectedEngineVersion: nativeRuntime.opencodeV2Version,
    expectedArch: options["--arch"] ?? null,
    totalBytes,
    totalMiB: totalBytes / MiB,
    fileCount,
    skippedSymlinks: [...disk.values()].filter((stat) => stat.isSymbolicLink()).length,
    buckets,
    dependencyAttributionBytes: [...dependencies.values()].reduce((sum, entry) => sum + entry.bytes, 0),
    topDependencies: [...dependencies.values()].sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name)).slice(0, topN),
    checks: { enabled: Boolean(options.check), failures },
    budget,
    ok: failures.length === 0 && budget?.passed !== false,
  };
  // Exclusive creation also prevents an existing symlink/hardlink from modifying the app.
  if (output) writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.log(`Packaged app: ${app}\nLogical files: ${totalBytes} bytes (${report.totalMiB.toFixed(2)} MiB); ${fileCount} files; ${report.skippedSymlinks} symlinks skipped`);
  for (const [name, bytes] of Object.entries(buckets)) console.log(`  ${name}: ${(bytes / MiB).toFixed(2)} MiB (${bytes} bytes)`);
  console.log(`Top ${topN} dependencies (attribution only, already included above):`);
  for (const entry of report.topDependencies) console.log(`  ${entry.name}: ${(entry.bytes / MiB).toFixed(2)} MiB (ASAR ${(entry.asarBytes / MiB).toFixed(2)}, unpacked ${(entry.unpackedBytes / MiB).toFixed(2)})`);
  console.log(`Invariants: ${options.check ? failures.length ? "FAILED" : "PASSED" : "not checked"}`);
  for (const failure of failures) console.error(`  ${failure}`);
  if (budget) console.log(`Budget: ${budget.passed ? "PASSED" : "FAILED"} (maximum ${maxMiB} MiB)`);
  if (output) console.log(`JSON: ${output}`);
  if (!report.ok) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(`release-size: ${error.message}`);
  process.exitCode = 1;
}
