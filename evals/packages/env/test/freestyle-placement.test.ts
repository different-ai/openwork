import assert from "node:assert/strict";
import test from "node:test";
import { resolvePlace } from "../src/place.ts";

test("recipes without Freestyle support never fall back to local infrastructure", () => {
  assert.throws(() => resolvePlace({ OPENWORK_WORLD_PLACE: "freestyle" }), /supports app-web/);
});
