import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  coerceJsonValue,
  coerceNestedJsonArgs,
} from "../src/opencode-plugins/openwork-chrome-devtools.js";

const action = z.discriminatedUnion("type", [
  z.object({ type: z.literal("click"), ref: z.string().optional() }),
  z.object({ type: z.literal("fill"), ref: z.string(), text: z.string() }),
  z.object({ type: z.literal("scroll"), x: z.number(), y: z.number(), deltaY: z.number() }),
]);

const browserActSchema = z.object({
  observationId: z.string(),
  action: action.optional(),
  actions: z.array(action).min(1).max(8).optional(),
});

test("coerceJsonValue parses a JSON object string", () => {
  assert.deepEqual(coerceJsonValue('{"type":"click","ref":"e7"}'), {
    type: "click",
    ref: "e7",
  });
});

test("coerceJsonValue leaves non-JSON strings alone", () => {
  assert.equal(coerceJsonValue("e7"), "e7");
  assert.equal(coerceJsonValue("not-json"), "not-json");
});

test("browser_act rejects a stringified action without coerce (repro #5492)", () => {
  const raw = {
    observationId: "obs_1",
    action: '{"type":"click","ref":"e7"}',
  };
  const result = browserActSchema.safeParse(raw);
  assert.equal(result.success, false);
  assert.ok(result.error);
  const issue = result.error.issues.find((entry) => entry.path.join(".") === "action");
  assert.ok(issue);
  assert.match(issue.message, /expected object, received string/i);
});

test("browser_act accepts a stringified action after coerceNestedJsonArgs", () => {
  const raw = {
    observationId: "obs_1",
    action: '{"type":"click","ref":"e7"}',
  };
  const result = browserActSchema.safeParse(coerceNestedJsonArgs(raw));
  assert.equal(result.success, true);
  assert.deepEqual(result.data, {
    observationId: "obs_1",
    action: { type: "click", ref: "e7" },
  });
});

test("coerceNestedJsonArgs parses stringified actions array entries", () => {
  const raw = {
    observationId: "obs_1",
    actions: ['{"type":"fill","ref":"e2","text":"hello"}', { type: "click", ref: "e3" }],
  };
  const result = browserActSchema.safeParse(coerceNestedJsonArgs(raw));
  assert.equal(result.success, true);
  assert.deepEqual(result.data.actions, [
    { type: "fill", ref: "e2", text: "hello" },
    { type: "click", ref: "e3" },
  ]);
});
