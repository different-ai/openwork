import { existsSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const specsRoot = join(repoRoot, "evals/specs");
const scenariosRoot = join(repoRoot, "scenarios");

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

export function journeyFiles(pattern = /(?:^|\.)e2e\.test\.ts$/) {
  return [
    ...filesUnder(specsRoot, pattern),
    ...filesUnder(scenariosRoot, pattern),
  ];
}

export function testName(file) {
  const fromRoot = relative(repoRoot, file).split(sep).join("/");
  return fromRoot.startsWith("scenarios/")
    ? fromRoot
    : relative(specsRoot, file).split(sep).join("/");
}
