import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultDisplayStage,
  receiptName,
  resolveStage,
  sanitizeStage,
} from "../src/stage.ts";

test("sanitizeStage produces bounded world-name-safe segments", () => {
  assert.equal(sanitizeStage("  feature / one  "), "feature-one");
  assert.equal(sanitizeStage("...alpha!!!beta___"), "alpha-beta");
  assert.equal(sanitizeStage("a---b"), "a-b");
  assert.equal(sanitizeStage("---alpha_beta---"), "alpha_beta");
  assert.equal(sanitizeStage("abcdefghijklmnopqrstuvwxyz0123456789"), "abcdefghijklmnopqrstuvwxyz012345");
  assert.throws(() => sanitizeStage(" ._- "), /at least one letter or number/);
});

test("sanitizeStage trims long separator runs in linear time", () => {
  const startedAt = Date.now();
  assert.equal(sanitizeStage(`${"-".repeat(10_000)}a${"-".repeat(10_000)}`), "a");
  assert.ok(Date.now() - startedAt < 200, "expected stage sanitization to finish within 200ms");
});

test("resolveStage gives an explicit stage precedence over environment configuration", () => {
  assert.equal(resolveStage({ OPENWORK_WORLD_STAGE: "environment" }, "flag stage"), "flag-stage");
  assert.equal(resolveStage({ OPENWORK_WORLD_STAGE: " environment stage " }), "environment-stage");
  assert.equal(resolveStage({ OPENWORK_WORLD_STAGE: "  " }), undefined);
  assert.equal(resolveStage({}), undefined);
});

test("receiptName joins valid world and stage names within SAFE_WORLD_NAME", () => {
  assert.equal(receiptName("demo", undefined), "demo");
  assert.equal(receiptName("demo", "feature-1"), "demo--feature-1");
  assert.match(receiptName("demo", "feature-1"), /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
  assert.throws(() => receiptName("x".repeat(120), "stage-name"), /World names must use/);
});

test("defaultDisplayStage identifies the local OS user", () => {
  assert.match(defaultDisplayStage({}), /^dev_[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/);
});
