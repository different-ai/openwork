import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const sourceRoot = join(import.meta.dir, "..", "src");
const allowedRelativePath = "react-app/domains/connections/managed-engine-config.ts";

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(path));
    } else if ((entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) && !entry.name.endsWith(".d.ts")) {
      files.push(path);
    }
  }
  return files;
}

describe("managed engine config guard", () => {
  test("keeps engine config.update writes behind the managed choke point", () => {
    const offenders = sourceFiles(sourceRoot)
      .map((path) => ({ path, relativePath: relative(sourceRoot, path) }))
      .filter((file) => file.relativePath !== allowedRelativePath)
      .filter((file) => readFileSync(file.path, "utf8").includes("config.update("))
      .map((file) => file.relativePath);

    expect(offenders).toEqual([]);
  });
});
