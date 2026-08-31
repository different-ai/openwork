import assert from "node:assert/strict";
import test from "node:test";
import { server } from "../src/den.ts";
import { resolvePlace } from "../src/place.ts";

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
