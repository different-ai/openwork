import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
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

export function compareBaseline(current, baseline, existingFiles) {
  const errors = [];
  for (const [file, count] of Object.entries(current)) {
    const allowed = baseline[file] ?? 0;
    if (count > allowed) errors.push(`${file}: raw channel escapes increased ${allowed} → ${count}`);
    if (file in baseline && count < allowed) errors.push(`${file}: baseline is stale ${allowed} → ${count}; lower it`);
  }
  for (const file of Object.keys(baseline)) {
    if (!existingFiles.has(file)) errors.push(`${file}: baseline is stale; file no longer exists`);
  }
  return errors;
}

export function scanSpecs(directory = specsDirectory) {
  const files = readdirSync(directory).filter((file) => file.endsWith(".e2e.test.ts")).sort();
  const current = {};
  for (const file of files) {
    const count = countRawEscapes(readFileSync(resolve(directory, file), "utf8"));
    if (count > 0) current[file] = count;
  }
  return { current, files: new Set(files) };
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
  const { current, files } = scanSpecs();
  if (process.argv.includes("--print-baseline")) {
    console.log(JSON.stringify(current, null, 2));
  } else {
    const errors = compareBaseline(current, readBaseline(), files);
    if (errors.length > 0) {
      console.error(`spec-channel-ratchet failed:\n- ${errors.join("\n- ")}`);
      process.exitCode = 1;
    } else {
      console.log(`spec-channel-ratchet: ${files.size} e2e specs checked`);
    }
  }
}
