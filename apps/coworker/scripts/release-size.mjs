import { lstatSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";

const MiB = 1024 ** 2;
const topN = 20;
// Measured macOS ARM64 candidate: 489.52 MiB. Other targets need their own baseline.
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
    else if (path.startsWith(`${resources}opencode-plugins/`)) bucket = "plugins";
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
  const engines = [...disk.keys()].filter((path) => path.startsWith(sidecars) && /^opencode(?:-[^/]+|\.exe)?$/.test(path.slice(sidecars.length)));
  const targetPattern = /^opencode-(aarch64|x86_64)-(apple-darwin|unknown-linux-gnu|pc-windows-msvc)(\.exe)?$/;
  const qualified = engines.map((path) => basename(path).match(targetPattern)).filter(Boolean);
  const match = qualified.length === 1 ? qualified[0] : null;
  const enginePlatform = match ? { "apple-darwin": "darwin", "unknown-linux-gnu": "linux", "pc-windows-msvc": "win32" }[match[2]] : null;
  const engineArch = match ? { aarch64: "arm64", x86_64: "x64" }[match[1]] : null;
  const failures = [];
  if (options.check) {
    if (engines.length !== 1 || !match || enginePlatform !== platform || Boolean(match[3]) !== (platform === "win32") ||
        (options["--arch"] && engineArch !== options["--arch"]) || !disk.get(engines[0]).isFile() || disk.get(engines[0]).size === 0) {
      failures.push(`Expected one nonempty target-qualified engine for ${platform}/${options["--arch"] ?? "inferred arch"}, with no generic duplicate; found: ${engines.join(", ") || "none"}`);
    }
    function reject(label, paths) {
      if (paths.length) failures.push(`${label}: ${paths.length}; ${paths.slice(0, 5).join(", ")}${paths.length > 5 ? ", ..." : ""}`);
    }
    reject("Renderer source maps", [...archive.keys()].filter((path) => /^dist\/.*\.map$/.test(path)));
    reject("Server test artifacts", [...archive.keys()].filter((path) => /^server\/.*\.test\.js(?:\.map)?$/.test(path)));
    reject("Dependency source maps", [...archive.keys()].filter((path) => /(?:^|\/)node_modules\/.*\.map$/.test(path)));
    reject("Dependency declarations", [...archive.keys()].filter((path) => /(?:^|\/)node_modules\/.*\.d\.[mc]?ts$/.test(path)));
    reject("Packaging-only icon files", [...archive.keys()].filter((path) => /^resources\/icons\/(?!icon(?:-macos)?\.png$)/.test(path)));
    reject("Bundled-only packages", [...archive.keys(), ...disk.keys()].filter((path) => /(?:^|\/)node_modules\/@openwork\/(computer-use|ui)(?:\/|$)/.test(path)));
    reject("Unpacked native build debris", [...disk.keys()].filter((path) => path.startsWith(unpacked) && /(?:^|\/)node_modules\//.test(path.slice(unpacked.length)) && /(?:^|\/)(?:\.build|[^/]+\.dSYM)(?:\/|$)/.test(path)));
    for (const path of [
      "package.json", "dist/index.html", "electron-dist/main.mjs", "electron-dist/preload.mjs",
      "electron-dist/browser-content-preload.cjs", "electron-dist/maintenance-helper.mjs",
      "server/package.json", "server/dist/embedded.js", "server/dist/constants.json",
    ]) {
      const entry = archive.get(path);
      const present = entry && !entry.files && !Object.hasOwn(entry, "link") && entry.size > 0 &&
        (!entry.unpacked || (disk.get(`${unpacked}${path}`)?.isFile() && disk.get(`${unpacked}${path}`).size > 0));
      if (!present) failures.push(`Missing nonempty ASAR runtime entry: ${path}`);
    }
    reject("Duplicate ASAR plugin bundles", [...archive.keys()].filter((path) => path.startsWith("server/dist/opencode-plugins/")));
    const requiredResources = ["sidecars/versions.json", "opencode-plugins/pdfium.wasm", ...[
      "managed-policy", "managed-policy-next", "openwork-chrome-devtools", "openwork-extensions-preview",
      "openwork-capabilities-knowledge", "openwork-office-attachments", "openwork-spreadsheets",
      "openwork-pdf-attachments", "openwork-anthropic-adaptive-thinking", "openwork-anthropic-tool-schema", "openwork-title-recovery",
    ].map((name) => `opencode-plugins/${name}.js`)];
    if (platform === "darwin") requiredResources.push(
      "helpers/OpenWork Computer Use.app/Contents/MacOS/ComputerUse",
      "helpers/OpenWork Computer Use.app/Contents/Info.plist",
    );
    for (const path of requiredResources) {
      const stat = disk.get(`${resources}${path}`);
      if (!stat?.isFile() || stat.size === 0) failures.push(`Missing nonempty runtime resource: ${path}`);
    }
  }

  const maxMiB = requestedMaxMiB ?? (options.check ? targetBudgetsMiB[`${platform}/${engineArch}`] ?? null : null);
  const budget = maxMiB === null ? null : { maxMiB, passed: totalBytes / MiB <= maxMiB };
  const report = {
    appDirectory: app,
    platform,
    engineArch,
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
