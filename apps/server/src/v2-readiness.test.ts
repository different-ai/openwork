import { expect, test } from "bun:test";

import { BALANCED_V2_READINESS, createV2ReadinessLog, resolveV2ReadinessPolicy } from "./v2-readiness.js";

test("readiness presets and per-step overrides resolve over the balanced default", () => {
  expect(resolveV2ReadinessPolicy(undefined)).toEqual(BALANCED_V2_READINESS);
  expect(resolveV2ReadinessPolicy("strict")).toEqual({ skills: "block", providers: "block", mcp: "block", instructions: "block" });
  expect(resolveV2ReadinessPolicy("fast")).toEqual({ skills: "background", providers: "background", mcp: "wait", instructions: "wait" });
  expect(resolveV2ReadinessPolicy(" Fast , MCP=block ")).toEqual({ skills: "background", providers: "background", mcp: "block", instructions: "wait" });
});

test("unknown or unsupported readiness tokens never make chat stricter", () => {
  // MCP removals and instructions must complete before a turn, so they have no background mode.
  expect(resolveV2ReadinessPolicy("mcp=background,instructions=background,skills=sometimes,typo")).toEqual(BALANCED_V2_READINESS);
});

test("the readiness log folds repeats and keeps the newest events", () => {
  const log = createV2ReadinessLog(2);
  log.record({ check: "skills", outcome: "degraded", detail: "a" });
  log.record({ check: "skills", outcome: "degraded", detail: "a" });
  expect(log.recent()).toMatchObject([{ check: "skills", detail: "a", count: 2 }]);
  log.record({ check: "mcp", outcome: "degraded", detail: "b" });
  log.record({ check: "providers", outcome: "blocked", detail: "c" });
  expect(log.recent().map((event) => event.detail)).toEqual(["c", "b"]);
});
