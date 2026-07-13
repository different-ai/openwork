#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SERVER_NPM_META_PACKAGE,
  SERVER_NPM_TARGETS,
  serverBuildBinaryName,
  serverOptionalDependencies,
  serverPlatformBinaryName,
  serverPlatformPackageName,
} from "./npm-package-contract.mjs";

const serverRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourcePackage = JSON.parse(readFileSync(join(serverRoot, "package.json"), "utf8"));
const version = String(sourcePackage.version ?? "").trim();
if (!version) {
  throw new Error("openwork-server version missing in apps/server/package.json");
}

const dryRun =
  process.argv.includes("--dry-run") ||
  ["1", "true"].includes(String(process.env.DRY_RUN ?? "").trim().toLowerCase());
const npmTag = String(process.env.NPM_TAG ?? "").trim();
const outroot = resolve(
  process.env.OPENWORK_SERVER_NPM_OUTDIR?.trim() || join(serverRoot, "dist", "npm"),
);
const tarballDir = join(outroot, "tarballs");

function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: options.capture ? "utf8" : undefined,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0 && !options.allowFailure) {
    const detail = options.capture
      ? `\n${String(result.stderr || result.stdout || "").trim()}`
      : "";
    throw new Error(`${command} ${args.join(" ")} failed${detail}`);
  }
  return result;
}

function writeJson(filepath, value) {
  writeFileSync(filepath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function commonManifest(name, description) {
  return {
    name,
    version,
    description,
    license: sourcePackage.license ?? "MIT",
    repository: sourcePackage.repository,
    homepage: sourcePackage.homepage,
    bugs: sourcePackage.bugs,
  };
}

function publishedMetadata(name) {
  const result = run(
    "npm",
    [
      "view",
      `${name}@${version}`,
      "version",
      "os",
      "cpu",
      "bin",
      "optionalDependencies",
      "--json",
    ],
    serverRoot,
    { allowFailure: true, capture: true },
  );
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    if (/\bE404\b|404 Not Found|is not in this registry|No match found/i.test(detail)) {
      return null;
    }
    throw new Error(
      `Unable to check npm metadata for ${name}@${version}; refusing to publish blindly.\n${detail}`,
    );
  }
  try {
    const value = JSON.parse(result.stdout);
    return value && typeof value === "object" ? value : null;
  } catch {
    throw new Error(`npm returned invalid metadata for ${name}@${version}`);
  }
}

function sameStringRecord(actual, expected) {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  const actualEntries = Object.entries(actual).sort(([left], [right]) => left.localeCompare(right));
  const expectedEntries = Object.entries(expected).sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(actualEntries) === JSON.stringify(expectedEntries);
}

function validateExistingPackage(item, metadata) {
  if (metadata.version !== version) {
    throw new Error(`npm metadata mismatch for ${item.name}@${version}`);
  }
  if (item.kind === "meta") {
    if (!sameStringRecord(metadata.optionalDependencies, item.manifest.optionalDependencies)) {
      throw new Error(
        `${item.name}@${version} already exists without the expected platform package contract. ` +
          "npm versions are immutable; bump the server version before publishing this package shape.",
      );
    }
    return;
  }

  const actualOs = Array.isArray(metadata.os) ? metadata.os : [metadata.os].filter(Boolean);
  const actualCpu = Array.isArray(metadata.cpu) ? metadata.cpu : [metadata.cpu].filter(Boolean);
  if (
    JSON.stringify(actualOs) !== JSON.stringify(item.manifest.os) ||
    JSON.stringify(actualCpu) !== JSON.stringify(item.manifest.cpu) ||
    !sameStringRecord(metadata.bin, item.manifest.bin)
  ) {
    throw new Error(
      `${item.name}@${version} already exists with incompatible platform metadata. ` +
        "npm versions are immutable; bump the server version before publishing.",
    );
  }
}

rmSync(outroot, { recursive: true, force: true });
mkdirSync(tarballDir, { recursive: true });

const publishItems = [];
for (const target of SERVER_NPM_TARGETS) {
  const name = serverPlatformPackageName(target);
  const sourceBinary = join(serverRoot, "dist", "bin", serverBuildBinaryName(target));
  if (!existsSync(sourceBinary)) {
    throw new Error(
      `Missing ${target.id} server binary at ${sourceBinary}. ` +
        "Run: pnpm --filter openwork-server build:bin:all",
    );
  }

  const packageDir = join(outroot, name);
  const binDir = join(packageDir, "bin");
  mkdirSync(binDir, { recursive: true });
  const binaryName = serverPlatformBinaryName(target);
  const packagedBinary = join(binDir, binaryName);
  copyFileSync(sourceBinary, packagedBinary);
  if (target.os !== "win32") chmodSync(packagedBinary, 0o755);

  const manifest = {
    ...commonManifest(name, `Platform binary for openwork-server (${target.id})`),
    os: [target.os],
    cpu: [target.cpu],
    bin: {
      "openwork-server": `./bin/${binaryName}`,
    },
    exports: {
      "./package.json": "./package.json",
    },
    files: ["bin"],
  };
  writeJson(join(packageDir, "package.json"), manifest);
  publishItems.push({ kind: "platform", name, dir: packageDir, manifest });
}

const metaDir = join(outroot, SERVER_NPM_META_PACKAGE);
const metaBinDir = join(metaDir, "bin");
mkdirSync(metaBinDir, { recursive: true });
const metaWrapper = join(metaBinDir, "openwork-server.mjs");
copyFileSync(join(serverRoot, "bin", "openwork-server.mjs"), metaWrapper);
chmodSync(metaWrapper, 0o755);
const metaManifest = {
  ...commonManifest(SERVER_NPM_META_PACKAGE, sourcePackage.description),
  type: "module",
  bin: {
    "openwork-server": "./bin/openwork-server.mjs",
  },
  exports: {
    "./package.json": "./package.json",
  },
  optionalDependencies: serverOptionalDependencies(version),
  files: ["bin"],
};
writeJson(join(metaDir, "package.json"), metaManifest);
publishItems.push({
  kind: "meta",
  name: SERVER_NPM_META_PACKAGE,
  dir: metaDir,
  manifest: metaManifest,
});

for (const item of publishItems) {
  run("pnpm", ["pack", "--pack-destination", tarballDir], item.dir);
  const tarball = join(tarballDir, `${item.name}-${version}.tgz`);
  if (!existsSync(tarball)) {
    throw new Error(`pnpm pack did not produce the expected artifact for ${item.name}: ${tarball}`);
  }
  item.tarball = tarball;
}

run(
  process.execPath,
  [join(serverRoot, "scripts", "verify-npm-packages.mjs"), "--outdir", outroot],
  serverRoot,
);

if (dryRun) {
  console.log(`Verified npm dry run for ${publishItems.length} openwork-server packages in ${outroot}`);
  process.exit(0);
}

const registryState = new Map(
  publishItems.map((item) => [item.name, publishedMetadata(item.name)]),
);
for (const item of publishItems) {
  const existing = registryState.get(item.name);
  if (existing) validateExistingPackage(item, existing);
}

for (const item of publishItems) {
  if (registryState.get(item.name)) {
    console.log(`Skipping ${item.name}@${version}; already published`);
    continue;
  }
  const args = ["publish", item.tarball, "--access", "public"];
  if (npmTag) args.push("--tag", npmTag);
  console.log(`Publishing verified artifact ${item.name}@${version}`);
  run("npm", args, serverRoot);
}
