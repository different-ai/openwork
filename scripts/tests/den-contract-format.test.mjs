import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatOpenApiSnapshot } from "../../ee/apps/den-api/scripts/openapi-snapshot-format.ts";

function document(paths = {}) {
  return {
    openapi: "3.1.0", info: { title: "Fixture", version: "1" }, paths,
    components: { schemas: { Example: { type: "object", properties: { choices: { enum: ["second", "first"] } } } } },
  };
}

test("formatting preserves all values and array ordering", () => {
  const input = document({ "/b": { get: { summary: "Line one\nLine two", tags: ["b", "a"] } }, "/a": { post: { responses: { 201: { description: "Created" } } } } });
  const formatted = formatOpenApiSnapshot(input);
  assert.deepEqual(JSON.parse(formatted), input);
  assert.ok(formatted.endsWith("\n"));
  assert.ok(formatted.indexOf('"/b":') < formatted.indexOf('"/a":'));
  assert.equal(formatted.split("\n").filter((line) => line.trimStart().startsWith('"/')).length, 2);
});

test("formatting is deterministic and idempotent without changing registration order", () => {
  const input = document({ "/a": {}, "/b": {} });
  const formatted = formatOpenApiSnapshot(input);
  assert.equal(formatOpenApiSnapshot(input), formatted);
  assert.equal(formatOpenApiSnapshot(JSON.parse(formatted)), formatted);
  assert.deepEqual(JSON.parse(formatOpenApiSnapshot({ paths: {}, components: { schemas: {} } })), { paths: {}, components: { schemas: {} } });
});

test("Git merges independent route changes without a generated-file conflict", () => {
  const cwd = mkdtempSync(join(tmpdir(), "openwork-contract-merge-"));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: join(cwd, "empty-global-config"), GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: "pipe" });
  const paths = Object.fromEntries(["/a", "/middle", "/z"].map((path) => [path, { get: { summary: "Original" } }]));
  const save = (input) => writeFileSync(join(cwd, "openapi.json"), formatOpenApiSnapshot(document(input)));
  try {
    git("init", "-q"); git("config", "user.name", "Contract test"); git("config", "user.email", "contract@example.test");
    save(paths); git("add", "."); git("commit", "-qm", "base");
    git("switch", "-qc", "left");
    save({ ...paths, "/a": { get: { summary: "Left change" } } }); git("commit", "-qam", "left");
    git("switch", "-qc", "right", "HEAD~1");
    save({ ...paths, "/z": { get: { summary: "Right change" } } }); git("commit", "-qam", "right");
    git("merge", "--no-edit", "left");
    const merged = JSON.parse(readFileSync(join(cwd, "openapi.json"), "utf8"));
    assert.equal(merged.paths["/a"].get.summary, "Left change");
    assert.equal(merged.paths["/z"].get.summary, "Right change");
    assert.deepEqual(merged.components, document().components);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
