import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const bunRuntime = (globalThis as typeof globalThis & {
  Bun?: {
    argv?: string[];
  };
}).Bun;

if (!bunRuntime?.argv) {
  console.error("This script must be run with Bun.");
  process.exit(1);
}

type BuildOptions = {
  bundleDir: string | null;
  embedRuntime: boolean;
  filename: string;
  outdir: string;
  targets: string[];
};

type RuntimeAssetPaths = {
  manifestPath: string;
  opencodePath: string;
  routerPath: string;
};

const TARGET_TRIPLES: Record<string, string> = {
  "bun-darwin-arm64": "aarch64-apple-darwin",
  "bun-darwin-x64": "x86_64-apple-darwin",
  "bun-darwin-x64-baseline": "x86_64-apple-darwin",
  "bun-linux-arm64": "aarch64-unknown-linux-gnu",
  "bun-linux-x64": "x86_64-unknown-linux-gnu",
  "bun-linux-x64-baseline": "x86_64-unknown-linux-gnu",
  "bun-windows-arm64": "aarch64-pc-windows-msvc",
  "bun-windows-x64": "x86_64-pc-windows-msvc",
  "bun-windows-x64-baseline": "x86_64-pc-windows-msvc",
};

function readPackageVersion() {
  const packageJsonPath = resolve("package.json");
  const contents = readFileSync(packageJsonPath, "utf8");
  const parsed = JSON.parse(contents) as { version?: unknown };
  const version = typeof parsed.version === "string" ? parsed.version.trim() : "";
  if (!version) {
    throw new Error(`Missing package version in ${packageJsonPath}`);
  }
  return version;
}

function fileExists(filePath: string) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function readArgs(argv: string[]): BuildOptions {
  const options: BuildOptions = {
    bundleDir: process.env.OPENWORK_SERVER_V2_BUNDLE_DIR?.trim() ? resolve(process.env.OPENWORK_SERVER_V2_BUNDLE_DIR.trim()) : null,
    embedRuntime: false,
    filename: "openwork-server-v2",
    outdir: resolve("dist", "bin"),
    targets: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value) continue;

    if (value === "--embed-runtime") {
      options.embedRuntime = true;
      continue;
    }

    if (value === "--bundle-dir") {
      const next = argv[index + 1];
      if (next) {
        options.bundleDir = resolve(next);
        index += 1;
      }
      continue;
    }

    if (value.startsWith("--bundle-dir=")) {
      const next = value.slice("--bundle-dir=".length).trim();
      if (next) options.bundleDir = resolve(next);
      continue;
    }

    if (value === "--target") {
      const next = argv[index + 1];
      if (next) {
        options.targets.push(next);
        index += 1;
      }
      continue;
    }

    if (value.startsWith("--target=")) {
      const next = value.slice("--target=".length).trim();
      if (next) options.targets.push(next);
      continue;
    }

    if (value === "--outdir") {
      const next = argv[index + 1];
      if (next) {
        options.outdir = resolve(next);
        index += 1;
      }
      continue;
    }

    if (value.startsWith("--outdir=")) {
      const next = value.slice("--outdir=".length).trim();
      if (next) options.outdir = resolve(next);
      continue;
    }

    if (value === "--filename") {
      const next = argv[index + 1];
      if (next) {
        options.filename = next;
        index += 1;
      }
      continue;
    }

    if (value.startsWith("--filename=")) {
      const next = value.slice("--filename=".length).trim();
      if (next) options.filename = next;
    }
  }

  return options;
}

function outputName(filename: string, target?: string) {
  const needsExe = target ? target.includes("windows") : process.platform === "win32";
  const suffix = target ? `-${target}` : "";
  const ext = needsExe ? ".exe" : "";
  return `${filename}${suffix}${ext}`;
}

function runtimeAssetCandidates(bundleDir: string, target?: string): RuntimeAssetPaths {
  const triple = target ? TARGET_TRIPLES[target] ?? null : null;
  const canonicalManifest = join(bundleDir, "manifest.json");
  const targetManifest = triple ? join(bundleDir, `manifest.json-${triple}`) : null;
  const manifestPath = [targetManifest, canonicalManifest].find((candidate) => candidate && fileExists(candidate)) ?? null;

  const opencodeCandidates = [
    triple ? join(bundleDir, `opencode-${triple}${triple.includes("windows") ? ".exe" : ""}`) : null,
    join(bundleDir, process.platform === "win32" || target?.includes("windows") ? "opencode.exe" : "opencode"),
  ];
  const routerCandidates = [
    triple ? join(bundleDir, `opencode-router-${triple}${triple.includes("windows") ? ".exe" : ""}`) : null,
    join(bundleDir, process.platform === "win32" || target?.includes("windows") ? "opencode-router.exe" : "opencode-router"),
  ];

  const opencodePath = opencodeCandidates.find((candidate) => candidate && fileExists(candidate)) ?? null;
  const routerPath = routerCandidates.find((candidate) => candidate && fileExists(candidate)) ?? null;

  if (!manifestPath || !opencodePath || !routerPath) {
    throw new Error(
      `Missing runtime assets for embedded build in ${bundleDir} (target=${target ?? "current"}, manifest=${manifestPath ?? "missing"}, opencode=${opencodePath ?? "missing"}, router=${routerPath ?? "missing"}).`,
    );
  }

  return {
    manifestPath,
    opencodePath,
    routerPath,
  };
}

function createEmbeddedEntrypoint(assets: RuntimeAssetPaths) {
  const buildDir = mkdtempSync(join(os.tmpdir(), "openwork-server-v2-build-"));
  const embeddedModulePath = join(buildDir, "embedded-runtime.ts");
  const entrypointPath = join(buildDir, "entry.ts");

  writeFileSync(
    embeddedModulePath,
    [
      `import manifestPath from ${JSON.stringify(assets.manifestPath)} with { type: "file" };`,
      `import opencodePath from ${JSON.stringify(assets.opencodePath)} with { type: "file" };`,
      `import routerPath from ${JSON.stringify(assets.routerPath)} with { type: "file" };`,
      "",
      "export const embeddedRuntimeBundle = {",
      "  manifestPath,",
      "  opencodePath,",
      "  routerPath,",
      "};",
      "",
    ].join("\n"),
    "utf8",
  );

  writeFileSync(
    entrypointPath,
    [
      `import { registerEmbeddedRuntimeBundle } from ${JSON.stringify(resolve("src", "runtime", "embedded.ts"))};`,
      `import { embeddedRuntimeBundle } from ${JSON.stringify(embeddedModulePath)};`,
      "",
      "registerEmbeddedRuntimeBundle(embeddedRuntimeBundle);",
      "void (async () => {",
      `  await import(${JSON.stringify(resolve("src", "cli.ts"))});`,
      "})();",
      "",
    ].join("\n"),
    "utf8",
  );

  return {
    cleanup() {
      rmSync(buildDir, { force: true, recursive: true });
    },
    entrypointPath,
  };
}

function buildOnce(options: BuildOptions, target?: string) {
  mkdirSync(options.outdir, { recursive: true });
  const outfile = join(options.outdir, outputName(options.filename, target));
  const version = readPackageVersion();
  const embedded = options.embedRuntime
    ? createEmbeddedEntrypoint(runtimeAssetCandidates(
        options.bundleDir ?? resolve("..", "desktop", "src-tauri", "sidecars"),
        target,
      ))
    : null;
  const entrypoint = embedded?.entrypointPath ?? resolve("src", "cli.ts");

  const args = [
    "build",
    entrypoint,
    "--compile",
    "--minify",
    "--bytecode",
    "--sourcemap",
    "--outfile",
    outfile,
    "--define",
    `__OPENWORK_SERVER_V2_VERSION__=${JSON.stringify(version)}`,
  ];
  if (target) {
    args.push("--target", target);
  }

  const result = spawnSync("bun", args, { stdio: "inherit" });
  embedded?.cleanup();
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const options = readArgs(bunRuntime.argv.slice(2));
const targets = options.targets.length ? options.targets : [undefined];

for (const target of targets) {
  buildOnce(options, target);
}
