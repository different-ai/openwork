import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../../../", import.meta.url);

test("the packaged server resolves allowance helpers to compiled JavaScript", () => {
  const manifest = JSON.parse(readFileSync(new URL("packages/types/package.json", root), "utf8"));
  const inference = manifest.exports["./den/inference"];
  assert.equal(inference.default, "./dist/den/inference.js");
  assert.equal(inference.development, "./src/den/inference.ts");
  assert.equal(inference.bun, "./src/den/inference.ts");
  assert.equal(inference.browser, "./src/den/inference.ts");
  const build = readFileSync(new URL("packages/types/tsup.config.ts", root), "utf8");
  assert.match(build, /"den\/inference": "src\/den\/inference\.ts"/);
});
