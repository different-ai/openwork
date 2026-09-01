import assert from "node:assert/strict";
import test from "node:test";
import {
  formatOutputLines,
  MASK,
  maskOutputs,
  normalizeOutputs,
  output,
  secret,
} from "../src/outputs.ts";

test("outputs normalize structured values and mask secrets", () => {
  const normalized = normalizeOutputs({
    url: "http://localhost",
    email: output("a@b", { group: "Accounts" }),
    token: secret("s3cr3t", { group: "Keys", note: "master" }),
  });
  assert.deepEqual(normalized, {
    values: { url: "http://localhost", email: "a@b", token: "s3cr3t" },
    meta: {
      email: { group: "Accounts" },
      token: { secret: true, group: "Keys", note: "master" },
    },
  });
  assert.deepEqual(maskOutputs(normalized.values, normalized.meta), {
    url: "http://localhost",
    email: "a@b",
    token: MASK,
  });
});

test("legacy output lines retain the exact key, two spaces, value format", () => {
  assert.deepEqual(formatOutputLines(
    { url: "http://localhost", token: "s3cr3t" },
    { token: { secret: true, note: "not rendered without groups" } },
    { reveal: false },
  ), [
    "url  http://localhost",
    `token  ${MASK}`,
  ]);
});

test("grouped output lines preserve group order, align blocks, show notes, and reveal secrets", () => {
  const values = {
    url: "http://localhost",
    adminEmail: "a@b",
    apiKey: "sk-1",
    adminPassword: "pw",
  };
  const meta = {
    adminEmail: { group: "Accounts" },
    apiKey: { secret: true, group: "Keys", note: "master" },
    adminPassword: { secret: true, group: "Accounts" },
  };
  assert.deepEqual(formatOutputLines(values, meta, { reveal: false }), [
    "url  http://localhost",
    "Accounts",
    "  adminEmail     a@b",
    `  adminPassword  ${MASK}`,
    "Keys",
    `  apiKey  ${MASK}  master`,
  ]);
  assert.deepEqual(formatOutputLines(values, meta, { reveal: true }), [
    "url  http://localhost",
    "Accounts",
    "  adminEmail     a@b",
    "  adminPassword  pw",
    "Keys",
    "  apiKey  sk-1  master",
  ]);
});
