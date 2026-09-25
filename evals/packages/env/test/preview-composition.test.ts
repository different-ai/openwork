import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePreviewOptions } from "../../../../worlds/lib/preview.ts";

const ENTERPRISE = { version: "0.18.52", distribution: "enterprise" };

test("published preview inputs stay compatible with script arguments", () => {
  assert.deepEqual(parsePreviewOptions(["--release", "0.18.52", "--distribution", "enterprise", "--scenario", "blank"]).release, ENTERPRISE);
  assert.equal(parsePreviewOptions(["--scenario", "blank"], true).scenario, "blank");
  assert.throws(() => parsePreviewOptions(["--scenario", "blank"]), /blank scenario requires/);
  assert.throws(() => parsePreviewOptions(["--release", "latest", "--distribution", "enterprise"]), /Use --scenario/);
});
