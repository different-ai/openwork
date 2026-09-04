import assert from "node:assert/strict";
import test from "node:test";
import { server } from "../src/den.ts";
import { resolveEvalEngine } from "../src/eval-engine.ts";
import { resolvePlace } from "../src/place.ts";

test("resolveEvalEngine defaults to v1 and validates case-insensitive lane names", () => {
  assert.equal(resolveEvalEngine({}), "v1");
  assert.equal(resolveEvalEngine({ OPENWORK_EVAL_ENGINE: "v1" }), "v1");
  assert.equal(resolveEvalEngine({ OPENWORK_EVAL_ENGINE: "V2" }), "v2");
  assert.throws(
    () => resolveEvalEngine({ OPENWORK_EVAL_ENGINE: "future" }),
    /Invalid OPENWORK_EVAL_ENGINE value "future"; expected "v1" or "v2"/,
  );
});

test("an attached server refuses the local-only demo seed", async () => {
  await assert.rejects(
    server({
      place: resolvePlace({}),
      reuse: { apiUrl: "https://den.example.test" },
      seedProfile: "demo-org",
    }),
    /seedProfile "demo-org" is local-only and cannot seed an attached Den/,
  );
});
