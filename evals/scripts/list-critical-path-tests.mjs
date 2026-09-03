import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const specsDirectory = fileURLToPath(new URL("../specs/", import.meta.url));

function readJson(name) {
  return JSON.parse(readFileSync(join(specsDirectory, name), "utf8"));
}

const manifest = readJson("critical-path-lane.json");
const quarantine = readJson("quarantine.json");
const profile = readJson("daytona-e2e-regression-profile.json");

if (manifest.version !== 1 || manifest.lane !== "critical-path-e2e-required" || !Array.isArray(manifest.specs)) {
  throw new Error("critical-path-lane.json has an unsupported shape.");
}
if (manifest.specs.length < 8 || manifest.specs.length > 12) {
  throw new Error(`The critical-path lane must contain 8-12 specs; found ${manifest.specs.length}.`);
}

const quarantined = new Set(quarantine.entries.map((entry) => entry.spec));
const profileExcluded = new Set(profile.excluded.map((entry) => entry.test));
const selected = new Set();

for (const entry of manifest.specs) {
  const test = entry.test;
  if (typeof test !== "string" || basename(test) !== test || !test.endsWith(".e2e.test.ts")) {
    throw new Error(`Invalid critical-path spec name: ${JSON.stringify(test)}.`);
  }
  if (selected.has(test)) throw new Error(`Duplicate critical-path spec: ${test}.`);
  if (!existsSync(join(specsDirectory, test))) throw new Error(`Critical-path spec does not exist: ${test}.`);
  if (quarantined.has(test)) throw new Error(`Critical-path spec is quarantined: ${test}.`);
  if (profileExcluded.has(test)) throw new Error(`Critical-path spec is excluded from the Daytona profile: ${test}.`);
  if (typeof entry.covers !== "string" || !entry.covers.trim()) throw new Error(`Critical-path spec lacks coverage rationale: ${test}.`);
  if (typeof entry.evidence !== "string" || !entry.evidence.startsWith("https://github.com/different-ai/openwork/")) {
    throw new Error(`Critical-path spec lacks a repository evidence link: ${test}.`);
  }
  selected.add(test);
  process.stdout.write(`${test}\n`);
}
