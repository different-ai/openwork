import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatOpenApiSnapshot } from "../../ee/apps/den-api/scripts/openapi-snapshot-format.ts";

const flags = ["installLinks", "mcpConnections", "workbot", "workbotSideChats", "litellm"];

function document(paths = {}, featureKeys = flags) {
  const featureKey = { type: "string", enum: featureKeys };
  return {
    openapi: "3.1.0", info: { title: "Fixture", version: "1" }, paths,
    // The feature-flag enum is copied into several schemas, as in the real contract.
    components: { schemas: { AdminFeature: { type: "object", properties: { key: featureKey } }, CapabilityDisabledError: { type: "object", properties: { feature: featureKey } } } },
  };
}

test("formatting preserves all values and key order", () => {
  const input = document({ "/b": { get: { summary: "Line one\nLine two", tags: ["b", "a"] } }, "/a": { post: { responses: { 201: { description: "Created" } } } } });
  const formatted = formatOpenApiSnapshot(input);
  assert.deepEqual(JSON.parse(formatted), input);
  assert.ok(formatted.endsWith("\n"));
  assert.ok(formatted.indexOf('"/b":') < formatted.indexOf('"/a":'));
});

test("formatting is deterministic and idempotent", () => {
  const input = document({ "/a": {}, "/b": {} });
  const formatted = formatOpenApiSnapshot(input);
  assert.equal(formatOpenApiSnapshot(input), formatted);
  assert.equal(formatOpenApiSnapshot(JSON.parse(formatted)), formatted);
});

// Commit `base`, then `left` and `right` on two branches from it, and merge.
function merge(base, left, right) {
  const cwd = mkdtempSync(join(tmpdir(), "openwork-contract-merge-"));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: join(cwd, "empty-global-config"), GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: "pipe" });
  const save = (input) => writeFileSync(join(cwd, "openapi.json"), formatOpenApiSnapshot(input));
  try {
    git("init", "-q"); git("config", "user.name", "Contract test"); git("config", "user.email", "contract@example.test");
    save(base); git("add", "."); git("commit", "-qm", "base");
    git("switch", "-qc", "left"); save(left); git("commit", "-qam", "left");
    git("switch", "-qc", "right", "HEAD~1"); save(right); git("commit", "-qam", "right");
    git("merge", "--no-edit", "left");
    return JSON.parse(readFileSync(join(cwd, "openapi.json"), "utf8"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("Git merges edits to neighbouring routes without a conflict", () => {
  const paths = Object.fromEntries(["/a", "/b"].map((path) => [path, { get: { summary: "Original", operationId: path } }]));
  const merged = merge(
    document(paths),
    document({ ...paths, "/a": { get: { summary: "Left change", operationId: "/a" } } }),
    document({ ...paths, "/b": { get: { summary: "Right change", operationId: "/b" } } }),
  );
  assert.equal(merged.paths["/a"].get.summary, "Left change");
  assert.equal(merged.paths["/b"].get.summary, "Right change");
});

test("Git merges two PRs that each add a feature flag without a conflict", () => {
  // Same shape as #5823 against #5820: each side inserts one flag elsewhere in the registry.
  const left = [...flags.slice(0, 2), "driveResumableUploads", ...flags.slice(2)];
  const right = [...flags.slice(0, 4), "workbotNaturalChat", ...flags.slice(4)];
  const merged = merge(document({}), document({}, left), document({}, right));
  const expected = ["installLinks", "mcpConnections", "driveResumableUploads", "workbot", "workbotSideChats", "workbotNaturalChat", "litellm"];
  assert.deepEqual(merged.components.schemas.AdminFeature.properties.key.enum, expected);
  assert.deepEqual(merged.components.schemas.CapabilityDisabledError.properties.feature.enum, expected);
});
