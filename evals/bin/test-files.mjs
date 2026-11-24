import { existsSync, readdirSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const scenariosRoot = join(repoRoot, "scenarios");

/**
 * Journey folders, keyed by basename. A journey can move between them (specs/
 * is unsorted and shrinking, core/ is maintained, proofs/ is one-off agent
 * proofs) without breaking anything that names it by basename.
 */
export const journeyRoots = ["specs", "core", "proofs"].map((folder) => join(repoRoot, "evals", folder));

export function filesUnder(directory, pattern) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        pattern.test(entry.name) &&
        !relative(directory, entry.parentPath)
          .split(sep)
          .includes("node_modules"),
    )
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

function journeyRootOf(file) {
  return journeyRoots.find((root) => !relative(root, file).startsWith(".."));
}

/** Journey files in evals/specs, evals/core and evals/proofs, without scenarios. Throws on duplicate basenames. */
export function evalJourneyFiles(pattern = /(?:^|\.)(?:e2e|proof)\.test\.ts$/) {
  const files = journeyRoots.flatMap((root) => filesUnder(root, pattern));
  const seen = new Map();
  for (const file of files) {
    const name = basename(file);
    const previous = seen.get(name);
    if (previous) {
      throw new Error(
        `Journey ${name} exists in two folders; basenames must be unique across evals/specs, evals/core and evals/proofs:\n`
          + `  ${relative(repoRoot, previous)}\n  ${relative(repoRoot, file)}`,
      );
    }
    seen.set(name, file);
  }
  return files.sort((left, right) => basename(left).localeCompare(basename(right)));
}

export function journeyFiles(pattern = /(?:^|\.)(?:e2e|proof)\.test\.ts$/) {
  return [...evalJourneyFiles(pattern), ...filesUnder(scenariosRoot, pattern)];
}

/** Absolute path of an eval journey by basename (with or without `.e2e.test.ts`), or by a path in any journey folder. */
export function journeyFile(name) {
  const base = basename(name);
  const candidates = /\.(?:e2e|proof)\.test\.ts$/.test(base) ? [base] : [`${base}.e2e.test.ts`, `${base}.proof.test.ts`];
  return evalJourneyFiles().find((file) => candidates.includes(basename(file)));
}

export function testName(file) {
  const fromRoot = relative(repoRoot, file).split(sep).join("/");
  if (fromRoot.startsWith("scenarios/")) return fromRoot;
  const root = journeyRootOf(file);
  return root ? relative(root, file).split(sep).join("/") : fromRoot;
}
