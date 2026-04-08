import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

function runFind(query) {
  return spawnSync("node", ["scripts/i18n-audit.mjs", "--find", query], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
  });
}

function runFindWithForwardedArgs(query) {
  return spawnSync("node", ["scripts/i18n-audit.mjs", "--find", "--", query], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
  });
}

test("find mode locates translation keys and app references from English text", () => {
  const result = runFind("OpenWork server URL");

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /config\.server_url_input_label/);
  assert.match(result.stdout, /apps\/app\/src\/app\/pages\/config\.tsx/);
});

test("find mode also reports direct source matches for literal English text", () => {
  const result = runFind("OpenWork server URL is required");

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Direct source matches/);
  assert.match(result.stdout, /apps\/app\/src\/app\/context\/workspace\.ts/);
});

test("find mode accepts forwarded package-manager args", () => {
  const result = runFindWithForwardedArgs("OpenWork server URL");

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /config\.server_url_input_label/);
});

test("find mode exits non-zero when nothing matches", () => {
  const result = runFind("definitely not a real openwork translation string");

  assert.equal(result.status, 1);
  assert.match(result.stdout, /No direct or translation matches found\./);
});
