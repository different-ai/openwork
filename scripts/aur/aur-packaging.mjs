#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^\d+\.\d+\.\d+$/;

export function fileSha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function replaceRequired(source, pattern, replacement, label) {
  if (!pattern.test(source)) throw new Error(`Missing ${label}.`);
  return source.replace(pattern, replacement);
}

export function updateAurContents({ pkgbuild, srcinfo, version, shaX64, shaArm64, repository }) {
  if (!VERSION.test(version)) throw new Error(`Invalid AUR version: ${version}`);
  if (!SHA256.test(shaX64) || !SHA256.test(shaArm64)) throw new Error("Invalid AUR SHA-256.");
  const releaseBase = `https://github.com/${repository}/releases/download/v${version}`;
  const x64Url = `${releaseBase}/openwork-linux-x64-${version}.tar.gz`;
  const arm64Url = `${releaseBase}/openwork-linux-arm64-${version}.tar.gz`;

  let nextPkgbuild = replaceRequired(pkgbuild, /^pkgver=.*$/m, `pkgver=${version}`, "PKGBUILD pkgver");
  nextPkgbuild = replaceRequired(nextPkgbuild, /^pkgrel=\d+.*$/m, "pkgrel=1 # pkgrel should change when PKGBUILD does. Standard is to change back to 1 next time. Any interger is valid.", "PKGBUILD pkgrel");
  nextPkgbuild = replaceRequired(nextPkgbuild, /^sha256sums_x86_64=.*$/m, `sha256sums_x86_64=('${shaX64}')`, "PKGBUILD x86_64 checksum");
  nextPkgbuild = replaceRequired(nextPkgbuild, /^sha256sums_aarch64=.*$/m, `sha256sums_aarch64=('${shaArm64}')`, "PKGBUILD aarch64 checksum");

  let nextSrcinfo = replaceRequired(srcinfo, /^\s*pkgver = .*$/m, `\tpkgver = ${version}`, ".SRCINFO pkgver");
  nextSrcinfo = replaceRequired(nextSrcinfo, /^\s*pkgrel = .*$/m, "\tpkgrel = 1", ".SRCINFO pkgrel");
  nextSrcinfo = replaceRequired(nextSrcinfo, /^\s*source_x86_64 = .*$/m, `\tsource_x86_64 = openwork-${version}-x64.tar.gz::${x64Url}`, ".SRCINFO x86_64 source");
  nextSrcinfo = replaceRequired(nextSrcinfo, /^\s*sha256sums_x86_64 = .*$/m, `\tsha256sums_x86_64 = ${shaX64}`, ".SRCINFO x86_64 checksum");
  nextSrcinfo = replaceRequired(nextSrcinfo, /^\s*source_aarch64 = .*$/m, `\tsource_aarch64 = openwork-${version}-arm64.tar.gz::${arm64Url}`, ".SRCINFO aarch64 source");
  nextSrcinfo = replaceRequired(nextSrcinfo, /^\s*sha256sums_aarch64 = .*$/m, `\tsha256sums_aarch64 = ${shaArm64}`, ".SRCINFO aarch64 checksum");

  return { pkgbuild: nextPkgbuild, srcinfo: nextSrcinfo };
}

export function readAurMetadata(pkgbuild) {
  const read = (pattern, label) => {
    const match = pkgbuild.match(pattern);
    if (!match) throw new Error(`Missing ${label}.`);
    return match[1];
  };
  return {
    version: read(/^pkgver=(.+)$/m, "PKGBUILD pkgver"),
    baseUrl: read(/^url="(.+)"$/m, "PKGBUILD URL"),
    sourceX64: read(/^source_x86_64=\("(.+)"\)$/m, "PKGBUILD x86_64 source"),
    shaX64: read(/^sha256sums_x86_64=\('([0-9a-f]{64})'\)$/m, "PKGBUILD x86_64 checksum"),
    sourceArm64: read(/^source_aarch64=\("(.+)"\)$/m, "PKGBUILD aarch64 source"),
    shaArm64: read(/^sha256sums_aarch64=\('([0-9a-f]{64})'\)$/m, "PKGBUILD aarch64 checksum"),
  };
}

export function readSrcinfoMetadata(srcinfo) {
  const read = (pattern, label) => {
    const match = srcinfo.match(pattern);
    if (!match) throw new Error(`Missing ${label}.`);
    return match[1];
  };
  return {
    version: read(/^\s*pkgver = (.+)$/m, ".SRCINFO pkgver"),
    baseUrl: read(/^\s*url = (.+)$/m, ".SRCINFO URL"),
    sourceX64: read(/^\s*source_x86_64 = (.+)$/m, ".SRCINFO x86_64 source"),
    shaX64: read(/^\s*sha256sums_x86_64 = ([0-9a-f]{64})$/m, ".SRCINFO x86_64 checksum"),
    sourceArm64: read(/^\s*source_aarch64 = (.+)$/m, ".SRCINFO aarch64 source"),
    shaArm64: read(/^\s*sha256sums_aarch64 = ([0-9a-f]{64})$/m, ".SRCINFO aarch64 checksum"),
  };
}

export function verifyAurContents({ pkgbuild, srcinfo, version, shaX64, shaArm64, repository }) {
  const pkg = readAurMetadata(pkgbuild);
  const info = readSrcinfoMetadata(srcinfo);
  const base = `https://github.com/${repository}/releases/download/v${version}`;
  const expected = {
    version,
    baseUrl: `https://github.com/${repository}`,
    sourceX64: `openwork-${version}-x64.tar.gz::${base}/openwork-linux-x64-${version}.tar.gz`,
    shaX64,
    sourceArm64: `openwork-${version}-arm64.tar.gz::${base}/openwork-linux-arm64-${version}.tar.gz`,
    shaArm64,
  };
  const expectedPkg = {
    version,
    baseUrl: `https://github.com/${repository}`,
    sourceX64: "${pkgname}-${pkgver}-x64.tar.gz::${url}/releases/download/v${pkgver}/openwork-linux-x64-${pkgver}.tar.gz",
    shaX64,
    sourceArm64: "${pkgname}-${pkgver}-arm64.tar.gz::${url}/releases/download/v${pkgver}/openwork-linux-arm64-${pkgver}.tar.gz",
    shaArm64,
  };
  if (JSON.stringify(pkg) !== JSON.stringify(expectedPkg)) throw new Error("PKGBUILD release version, sources, or checksums do not match immutable assets.");
  if (JSON.stringify(info) !== JSON.stringify(expected)) throw new Error(".SRCINFO release version, sources, or checksums do not match immutable assets.");
}

function flag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function main() {
  const command = process.argv[2];
  const root = resolve(import.meta.dirname, "../..");
  const pkgbuildPath = resolve(root, "packaging/aur/PKGBUILD");
  const srcinfoPath = resolve(root, "packaging/aur/.SRCINFO");
  const tag = flag("--tag");
  const version = tag.startsWith("v") ? tag.slice(1) : tag;
  const x64Path = resolve(flag("--x64"));
  const arm64Path = resolve(flag("--arm64"));
  const actual = {
    version,
    shaX64: fileSha256(x64Path),
    shaArm64: fileSha256(arm64Path),
  };

  if (basename(x64Path) !== `openwork-linux-x64-${version}.tar.gz`) {
    throw new Error(`Unexpected x86_64 staged asset: ${basename(x64Path)}`);
  }
  if (basename(arm64Path) !== `openwork-linux-arm64-${version}.tar.gz`) {
    throw new Error(`Unexpected aarch64 staged asset: ${basename(arm64Path)}`);
  }

  if (command === "update") {
    const updated = updateAurContents({
      pkgbuild: readFileSync(pkgbuildPath, "utf8"),
      srcinfo: readFileSync(srcinfoPath, "utf8"),
      ...actual,
      repository: process.env.GITHUB_REPOSITORY ?? "different-ai/openwork",
    });
    writeFileSync(pkgbuildPath, updated.pkgbuild);
    writeFileSync(srcinfoPath, updated.srcinfo);
  } else if (command === "verify") {
    verifyAurContents({
      pkgbuild: readFileSync(pkgbuildPath, "utf8"),
      srcinfo: readFileSync(srcinfoPath, "utf8"),
      ...actual,
      repository: process.env.GITHUB_REPOSITORY ?? "different-ai/openwork",
    });
  } else {
    throw new Error("Usage: aur-packaging.mjs update|verify --tag vX.Y.Z --x64 <path> --arm64 <path>");
  }

  console.log(JSON.stringify(actual));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
