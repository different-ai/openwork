// Run with --write-baseline to replace the baseline with every currently violating spec.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const evalsRoot = fileURLToPath(new URL("..", import.meta.url));
const specsDirectory = resolve(evalsRoot, "specs");
const baselinePath = resolve(specsDirectory, "boundary-ratchet.baseline.json");

function importedSpecifiers(source) {
  return [...source.matchAll(/(?:\bimport\s+(?:[^"'`;]*?\s+from\s+)?|\bexport\s+[^"'`;]*?\s+from\s+)["']([^"']+)["']/g)]
    .map((match) => match[1]);
}

export function classifySpec(source) {
  const imports = importedSpecifiers(source);
  const productSource = /^\.\.\/\.\.\/(?:apps|packages|ee)\//;
  return {
    importsProductSource: imports.some((specifier) => productSource.test(specifier))
      || /\bnew\s+URL\(\s*["']\.\.\/\.\.\/(?:apps|packages|ee)\/[^"']*["']\s*,\s*import\.meta\.url\s*\)/.test(source),
    importsNodeFs: imports.some((specifier) => /^(?:node:)?fs(?:\/promises)?$/.test(specifier)),
    importsChildProcess: imports.some((specifier) => /^(?:node:)?child_process$/.test(specifier)),
    crossesBoundary: imports.some((specifier) => /^(?:\.\.\/)?\.\.\/worlds\/|^@openwork\/world$/.test(specifier))
      || /(?<!\.)\b(?:app|coworker|chrome|server|inviteMember|faultProxy)\s*\(|\bspec\.world\s*\(/.test(source),
  };
}

export function violations(file, classification) {
  const reasons = [];
  if (classification.importsProductSource) reasons.push(`${file}: imports product source (../../apps/...) — unit tests belong next to the module they test, not in evals/specs`);
  if (classification.importsNodeFs && !classification.crossesBoundary) reasons.push(`${file}: reads the filesystem (node:fs) — a spec observes the product, not the repository`);
  if (classification.importsChildProcess && !classification.crossesBoundary) reasons.push(`${file}: spawns processes (node:child_process) — wrapping another test runner is not evidence`);
  if (!classification.crossesBoundary) reasons.push(`${file}: never crosses a product boundary (app()/coworker()/chrome()/server()/spec.world()) — see write-a-spec`);
  return reasons;
}

export function compareBaseline(files, baseline) {
  const errors = [];
  const warnings = [];
  const grandfathered = new Set(baseline);
  for (const [file, classification] of Object.entries(files)) {
    const reasons = violations(file, classification);
    if (grandfathered.has(file)) {
      if (reasons.length === 0) warnings.push(`${file}: is clean; remove it from boundary-ratchet.baseline.json`);
    } else {
      errors.push(...reasons);
    }
  }
  for (const file of baseline) {
    if (!(file in files)) errors.push(`${file}: baseline is stale; file no longer exists — remove it`);
  }
  return { errors, warnings };
}

export function scanSpecs(directory = specsDirectory) {
  const files = {};
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".test.ts")).sort()) {
    files[file] = classifySpec(readFileSync(resolve(directory, file), "utf8"));
  }
  return files;
}

function readBaseline() {
  const value = JSON.parse(readFileSync(baselinePath, "utf8"));
  if (!Array.isArray(value) || value.some((file) => typeof file !== "string" || !file.endsWith(".test.ts"))) {
    throw new Error("Boundary ratchet baseline must be an array of spec filenames.");
  }
  return value;
}

export function main() {
  const files = scanSpecs();
  if (process.argv.includes("--write-baseline")) {
    const baseline = Object.entries(files)
      .filter(([file, classification]) => violations(file, classification).length > 0)
      .map(([file]) => file);
    writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`spec-boundary-ratchet: wrote ${baseline.length} baseline entries`);
    return;
  }
  const { errors, warnings } = compareBaseline(files, readBaseline());
  for (const warning of warnings) console.warn(`WARNING: ${warning}`);
  if (errors.length > 0) {
    console.error(`spec-boundary-ratchet failed:\n- ${errors.join("\n- ")}\nFix existing debt only by shrinking evals/specs/boundary-ratchet.baseline.json; new specs must cross a real product boundary.`);
    process.exitCode = 1;
  } else {
    console.log(`spec-boundary-ratchet: ${Object.keys(files).length} specs checked`);
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
