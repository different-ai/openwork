// Lints evals/core, evals/proofs and the retired evals/specs, and checks that
// every journey in evals/journeys.ts exists. Exits 1 on any error.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { journeys } from "../../journeys.ts";
import { lintSource, type Violation } from "./lint.ts";

const evalsRoot = fileURLToPath(new URL("../..", import.meta.url));

function filesIn(directory: string): string[] {
  const root = join(evalsRoot, directory);
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== "README.md" && !entry.parentPath.split(sep).includes("node_modules"))
    .map((entry) => relative(evalsRoot, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();
}

const files = ["core", "proofs", "specs"].flatMap(filesIn);
const errors: Violation[] = [];
for (const file of files) errors.push(...lintSource(file, readFileSync(join(evalsRoot, file), "utf8")));
for (const name of Object.keys(journeys)) {
  const file = `core/${name}.e2e.test.ts`;
  if (!files.includes(file)) errors.push({ rule: "allowed-files", file: "journeys.ts", line: 1, message: `${file} is listed in evals/journeys.ts but does not exist. Restore it or remove it from the list in review.` });
}

for (const violation of errors) console.error(`evals/${violation.file}:${violation.line} spec/${violation.rule}: ${violation.message}`);
console.log(`spec-lint: ${files.length} files, ${errors.length} errors.`);
if (errors.length > 0) process.exitCode = 1;
