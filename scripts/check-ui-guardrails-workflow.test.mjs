import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const read = (file) => {
  const url = new URL(`../${file}`, import.meta.url);
  return existsSync(url) ? readFileSync(url, "utf8") : "";
};
const ui = read(".github/workflows/ui-guardrails.yml");
const features = read(".github/workflows/features-check.yml");

test("UI guardrails run independently of Helm and feature-registry work", () => {
  assert.match(ui, /^jobs:\n  ui-guardrails:/m, "Keep a dedicated UI guardrails job.");
  assert.doesNotMatch(ui, /^\s*needs:|helm|features:check|@openwork\/features/m,
    "The UI scanner has no Helm or feature-registry prerequisite.");
  assert.match(ui, /run: pnpm test:ui-guardrails/);
  assert.match(ui, /run: pnpm check:ui-guardrails/);
  assert.doesNotMatch(ui, /continue-on-error:/, "Guardrail failures must still fail CI.");
  assert.match(ui, /run: node --test scripts\/check-ui-guardrails-workflow\.test\.mjs/,
    "Exercise this boundary in the UI workflow itself.");
});

test("the feature-registry workflow does not own UI scanning or its dependencies", () => {
  assert.doesNotMatch(features, /ui-guardrails|@different-ai\/openwork-workspace/);
  assert.match(features, /uses: azure\/setup-helm@/);
  assert.match(features, /run: pnpm features:check/);
  assert.match(features, /run: pnpm --filter @openwork\/features test/);
});

test("UI workflow triggers cover every scanner root and its own inputs", () => {
  const scanner = read("scripts/check-ui-guardrails.mjs");
  const roots = scanner.match(/export const scanRoots = (\[[^\n]+\]);/)?.[1];
  assert.ok(roots, "Read scan roots from the scanner, not a second maintained list.");
  for (const root of JSON.parse(roots)) {
    assert.ok(ui.includes(`- "${root}/**"`), `Missing UI path trigger for ${root}.`);
  }
  for (const file of [
    "scripts/check-ui-guardrails*",
    "scripts/ui-guardrails-baseline.json",
    ".github/workflows/ui-guardrails.yml",
    ".github/workflows/features-check.yml",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
  ]) {
    assert.ok(ui.includes(`- "${file}"`), `Missing workflow input trigger for ${file}.`);
  }
});
