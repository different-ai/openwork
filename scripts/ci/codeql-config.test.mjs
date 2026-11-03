import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const config = readFileSync(new URL("../../.github/codeql/codeql-config.yml", import.meta.url), "utf8");
// Read the config's single list of quoted globs. Model only its literal/*/**
// subset, case-sensitively: Node's matchesGlob is case-insensitive on macOS,
// unlike the Linux scan (where *Test.* must not hide model-test.ts).
const ignoredPaths = [...config.matchAll(/^  - '([^']+)'$/gm)].map((match) => match[1]);
const ignoredPatterns = ignoredPaths.map((pattern) => {
  assert.match(pattern, /^[a-zA-Z0-9_./*\-]+$/);
  const segments = pattern.split("/");
  const source = segments.map((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === "**") return last ? ".*" : "(?:[^/]+/)*";
    return segment.replaceAll(".", "\\.").replaceAll("*", "[^/]*") + (last ? "" : "/");
  }).join("");
  return new RegExp(`^${source}$`);
});
const excluded = (path) => ignoredPatterns.some((pattern) => pattern.test(path));

for (const path of [
  "scripts/docs-pdf.mjs",
  "scripts/release/cut.mjs",
  "evals/core/chat.proof.ts",
  "packages/evals/src/helpers.ts",
  "apps/app/src/chat.test.tsx",
  "ee/apps/den-api/src/routes.api.test.ts",
  "apps/app/tests/support.ts",
  "packages/sdk/test/client.ts",
  "fixtures/example.py",
  "packages/sdk/src/fixtures/example.ts",
]) {
  test(`excludes non-production source ${path}`, () => {
    assert.equal(excluded(path), true);
  });
}

for (const path of [
  "apps/app/src/main.tsx",
  "apps/app/src/latest-assistant-tool-parts.ts",
  "apps/app/src/model-test.ts",
  "ee/apps/den-api/src/index.ts",
  "ee/apps/den-web/app/sso/test/route.ts",
  "packages/sdk/src/client.ts",
  "packages/computer-use/native/Sources/ComputerUse/main.swift",
  "apps/desktop/scripts/build.mjs",
  ".github/scripts/warden-check.mjs",
  ".github/workflows/codeql.yml",
]) {
  test(`keeps production and CI source in scope: ${path}`, () => {
    assert.equal(excluded(path), false);
  });
}

test("the workflow loads the config without skipping tooling-only PRs", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/codeql.yml", import.meta.url), "utf8");
  assert.match(workflow, /config-file: \.\/\.github\/codeql\/codeql-config\.yml/);
  assert.doesNotMatch(workflow, /^\s+paths(?:-ignore)?:/m);
});
