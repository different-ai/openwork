import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const quarantineUrl = new URL("../specs/quarantine.json", import.meta.url);
const manifest = JSON.parse(readFileSync(quarantineUrl, "utf8"));

if (manifest?.version !== 1 || !Array.isArray(manifest.entries)) {
  throw new Error(`invalid quarantine manifest: ${fileURLToPath(quarantineUrl)}`);
}

const entries = manifest.entries;
const entriesBySpec = new Map(entries.map((entry) => [entry.spec, entry]));

export function listQuarantined() {
  return entries.map((entry) => entry.spec);
}

export function isQuarantined(name) {
  return entriesBySpec.has(basename(name));
}

export function quarantineReason(name) {
  return entriesBySpec.get(basename(name))?.reason;
}

function main() {
  process.stdout.write(`${listQuarantined().join("\n")}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
