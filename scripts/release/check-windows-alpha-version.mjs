#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Windows alpha versions are deliberately restricted to our workflow's numeric
// format. Build metadata identifies the source, but does not affect precedence.
function alphaParts(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)-alpha\.(\d+)(?:\.(\d+))?(?:\+[0-9a-f]+)?$/);
  if (!match) throw new Error(`Unsupported Windows alpha version: ${version}`);
  return match.slice(1).map(part => BigInt(part ?? "0"));
}

export function shouldPublishWindowsAlpha(version, assetNames) {
  const candidate = alphaParts(version);
  return assetNames.every(name => {
    const match = name.match(/^openwork-win-x64-(.+)\.exe$/);
    if (!match) return true;
    const published = alphaParts(match[1]);
    for (let index = 0; index < candidate.length; index++) {
      if (candidate[index] > published[index]) return true;
      if (candidate[index] < published[index]) return false;
    }
    return false;
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [version, assetsPath] = process.argv.slice(2);
  if (!version || !assetsPath) {
    throw new Error("Usage: check-windows-alpha-version.mjs <version> <asset-names-file>");
  }
  const assets = readFileSync(assetsPath, "utf8").split(/\r?\n/).filter(Boolean);
  console.log(shouldPublishWindowsAlpha(version, assets) ? "publish" : "skip");
}
