import assert from "node:assert/strict";
import { test } from "node:test";
import { WORLD_GUIDES, guideSeeds } from "../../../../packages/world/src/catalog.ts";
import { PREVIEW_SCENARIOS, freestyleDesktopPlan, parsePreviewOptions } from "../../../../worlds/lib/preview.ts";

test("the discovery catalog offers exactly the scenarios each preview enforces", () => {
  for (const [world, surface] of [["preview-desktop", "desktop"], ["preview-den", "den"], ["preview-full", "full"]] as const) {
    const guide = WORLD_GUIDES[world];
    assert.ok(guide, world);
    assert.deepEqual(new Set(guideSeeds(guide)), new Set(PREVIEW_SCENARIOS[surface]), world);
  }
  // Freestyle maps only the signed-out fresh desktop; the catalog must agree.
  const freestyle = WORLD_GUIDES["preview-desktop"]?.targets.find((target) => target.target === "freestyle/linux");
  assert.deepEqual(freestyle?.seeds, ["fresh"]);
  const sources = { desktop: { kind: "sha" as const, sha: "c".repeat(40) } };
  for (const seed of ["fresh", "blank", "team", "restricted", "workspace"]) {
    const plan = (): unknown => freestyleDesktopPlan({ surface: "desktop", argv: [], sources, seeds: [{ name: seed }] });
    if (freestyle?.seeds.includes(seed)) assert.doesNotThrow(plan, seed);
    else assert.throws(plan, /only --seed fresh\. For a signed-in desktop use preview-full --place daytona --seed workspace\./, seed);
  }
});

const ENTERPRISE = { version: "0.18.52", distribution: "enterprise" };

test("published preview inputs stay compatible with script arguments", () => {
  assert.deepEqual(parsePreviewOptions(["--release", "0.18.52", "--distribution", "enterprise", "--scenario", "blank"]).release, ENTERPRISE);
  assert.equal(parsePreviewOptions(["--scenario", "blank"], true).scenario, "blank");
  assert.throws(() => parsePreviewOptions(["--scenario", "blank"]), /blank scenario requires/);
  assert.throws(() => parsePreviewOptions(["--release", "latest", "--distribution", "enterprise"]), /Use --scenario/);
});
