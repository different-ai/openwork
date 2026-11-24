#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Alpha versions are deliberately restricted to our workflow's numeric format.
// Build metadata identifies the source, but does not affect precedence.
function alphaParts(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)-alpha\.(\d+)(?:\.(\d+))?(?:\+[0-9a-f]+)?$/);
  if (!match) throw new Error(`Unsupported alpha version: ${version}`);
  return match.slice(1).map(part => BigInt(part ?? "0"));
}

function compareAlpha(left, right) {
  for (let index = 0; index < left.length; index++) {
    if (left[index] > right[index]) return 1;
    if (left[index] < right[index]) return -1;
  }
  return 0;
}

// Windows never replaces signed installers, so an equal version is skipped.
// macOS reruns of one run republish (clobber) the same versioned assets.
const PLATFORMS = Object.freeze({
  windows: { asset: /^openwork-win-x64-(.+)\.exe$/, allowEqual: false },
  mac: { asset: /^openwork-mac-arm64-(.+)\.zip$/, allowEqual: true },
});

export function shouldPublishAlpha(platform, version, assetNames) {
  const rules = PLATFORMS[platform];
  if (!rules) throw new Error(`Unknown alpha platform: ${platform}`);
  const candidate = alphaParts(version);
  return assetNames.every(name => {
    const match = name.match(rules.asset);
    if (!match) return true;
    const order = compareAlpha(candidate, alphaParts(match[1]));
    return order > 0 || (order === 0 && rules.allowEqual);
  });
}

export const shouldPublishWindowsAlpha = (version, assetNames) => shouldPublishAlpha("windows", version, assetNames);

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [platform, version, assetsPath] = process.argv.slice(2);
  if (!platform || !version || !assetsPath) {
    throw new Error("Usage: check-alpha-version.mjs <windows|mac> <version> <asset-names-file>");
  }
  const assets = readFileSync(assetsPath, "utf8").split(/\r?\n/).filter(Boolean);
  console.log(shouldPublishAlpha(platform, version, assets) ? "publish" : "skip");
}
