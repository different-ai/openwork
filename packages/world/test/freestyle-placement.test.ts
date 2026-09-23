import assert from "node:assert/strict";
import test from "node:test";
import { parseWorldArgs } from "../src/cli.ts";
import { parseAppWebOptions } from "../../../worlds/lib/app-web-options.ts";

test("Freestyle placement passes the exact source ref to app-web", () => {
  const sha = "a".repeat(40);
  assert.deepEqual(parseWorldArgs(["up", "app-web", "--place", "freestyle", "--", "--ref", sha]), {
    kind: "up", source: "app-web", place: "freestyle", args: ["--ref", sha],
  });
  assert.deepEqual(parseAppWebOptions(["--ref", sha], { OPENWORK_WORLD_PLACE: "freestyle" }), {
    place: "freestyle", ref: sha, lifetimeMinutes: 120,
  });
  assert.throws(() => parseAppWebOptions([], { OPENWORK_WORLD_PLACE: "freestyle" }), /requires/);
});
