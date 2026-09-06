import assert from "node:assert/strict";
import { test } from "node:test";
import { missingLanguages } from "./check-codeql-results.mjs";

const result = (language, overrides = {}) => ({
  category: `/language:${language}`, commit_sha: "head", tool: { name: "CodeQL" }, error: "", ...overrides,
});

test("a green two-language scan is incomplete after Python is enabled", () => {
  assert.deepEqual(missingLanguages(["actions", "javascript", "typescript", "javascript-typescript", "python"],
    [result("actions"), result("javascript-typescript")], ["head", "merge"]), ["python"]);
});

test("accepts current head and merge results and deduplicates language aliases", () => {
  assert.deepEqual(missingLanguages(["javascript", "typescript", "python"],
    [result("javascript-typescript"), result("python", { commit_sha: "merge" })], ["head", "merge"]), []);
});

test("old commits, failed uploads, and other tools cannot satisfy coverage", () => {
  assert.deepEqual(missingLanguages(["python"], [
    result("python", { commit_sha: "old" }),
    result("python", { error: "extraction failed" }),
    result("python", { tool: { name: "another scanner" } }),
  ], ["head", "merge"]), ["python"]);
});
