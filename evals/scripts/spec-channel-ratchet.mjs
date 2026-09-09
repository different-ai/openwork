import { journeyFiles, filesUnder, testName } from "../bin/test-files.mjs";
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const evalsRoot = fileURLToPath(new URL("..", import.meta.url));
const specsDirectory = resolve(evalsRoot, "specs");
const baselinePath = resolve(specsDirectory, "channel-ratchet.baseline.json");

function occurrences(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

export function countRawEscapes(source) {
  const behaviorImports = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']@openwork\/behaviors["']/g)];
  const importsBehaviorsEvalIn = behaviorImports.some((match) => /(?:^|,)\s*evalIn(?:\s+as\s+\w+)?\s*(?:,|$)/.test(match[1]));
  return (importsBehaviorsEvalIn ? occurrences(source, /(?<!\.)\bevalIn\s*\(/g) : 0)
    + occurrences(source, /\bdenFetch\s*\(/g)
    + occurrences(source, /\bclient\.send\s*\(/g)
    + occurrences(source, /\blocalStorage\.setItem\s*\(/g)
    + occurrences(source, /\bseed\.evalIn\s*\(/g)
    + occurrences(source, /\bprobe\.eval\s*\(/g);
}

export function compareBaseline(current, baseline, existingFiles, newLayerFiles) {
  const errors = [];
  const warnings = [];
  for (const file of existingFiles) {
    const count = current[file] ?? 0;
    if (file in baseline) {
      const allowed = baseline[file];
      if (count > allowed) errors.push(`${file}: raw channel escapes increased ${allowed} → ${count}`);
      if (count < allowed) errors.push(`${file}: baseline is stale ${allowed} → ${count}; lower it`);
    } else if (newLayerFiles.has(file)) {
      if (count > 0) errors.push(`${file}: new-layer spec has ${count} raw channel escapes; expected 0`);
    } else {
      warnings.push(`unbaselined legacy spec: ${file} (${count} escapes) — add to baseline when migrating`);
    }
  }
  for (const file of Object.keys(baseline)) {
    if (!existingFiles.has(file)) errors.push(`${file}: baseline is stale; file no longer exists`);
  }
  return { errors, warnings };
}

export function scanSpecs(directory = specsDirectory) {
  const paths = directory === specsDirectory ? journeyFiles() : filesUnder(directory, /(?:^|\.)e2e\.test\.ts$/);
  const files = paths.map((path) => directory === specsDirectory ? testName(path) : relative(directory, path));
  const current = {};
  const newLayerFiles = new Set();
  for (const [index, file] of files.entries()) {
    const source = readFileSync(paths[index], "utf8");
    const count = countRawEscapes(source);
    if (count > 0) current[file] = count;
    if (source.includes("spec.world(")) newLayerFiles.add(file);
  }
  return { current, files: new Set(files), newLayerFiles };
}

function readBaseline() {
  const value = JSON.parse(readFileSync(baselinePath, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Channel ratchet baseline must be an object.");
  for (const [file, count] of Object.entries(value)) {
    if (!file.endsWith(".e2e.test.ts") || !Number.isInteger(count) || count < 1) {
      throw new Error(`Invalid channel ratchet entry ${JSON.stringify(file)}: ${JSON.stringify(count)}.`);
    }
  }
  return value;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const { current, files, newLayerFiles } = scanSpecs();
  if (process.argv.includes("--print-baseline")) {
    console.log(JSON.stringify(current, null, 2));
  } else {
    const { errors, warnings } = compareBaseline(current, readBaseline(), files, newLayerFiles);
    for (const warning of warnings) console.warn(`WARNING: ${warning}`);
    if (errors.length > 0) {
      console.error(`spec-channel-ratchet failed:\n- ${errors.join("\n- ")}\nFix with: pnpm --dir evals exec node scripts/spec-channel-ratchet.mjs --print-baseline > evals/specs/channel-ratchet.baseline.json`);
      process.exitCode = 1;
    } else {
      console.log(`spec-channel-ratchet: ${files.size} e2e specs checked`);
    }
  }
}
