import assert from "node:assert/strict";
import { test } from "node:test";
import { selectAlphaAssetsToPrune } from "./prune-alpha-assets.mjs";

const asset = (id, name) => ({ id, name });

test("keeps manifests and unparseable asset names", () => {
  const assets = [
    asset(1, "latest-mac.yml"),
    asset(2, "openwork-mac-arm64.zip"),
    asset(3, "openwork-mac-arm64-0.18.14-alpha.12.zip"),
  ];
  assert.deepEqual(selectAlphaAssetsToPrune(assets, 1), []);
});

test("groups zip, dmg, and blockmap assets from the same run", () => {
  const assets = [
    asset(1, "openwork-mac-arm64-0.18.14-alpha.10.zip"),
    asset(2, "openwork-mac-arm64-0.18.14-alpha.10.zip.blockmap"),
    asset(3, "openwork-mac-arm64-0.18.14-alpha.10.dmg"),
    asset(4, "openwork-mac-arm64-0.18.14-alpha.11.zip"),
  ];
  assert.deepEqual(selectAlphaAssetsToPrune(assets, 1), assets.slice(0, 3));
});

test("orders build run numbers numerically", () => {
  const oldAsset = asset(1, "openwork-mac-arm64-0.18.14-alpha.999.zip");
  const newAsset = asset(2, "openwork-mac-arm64-0.18.14-alpha.2109.zip");
  assert.deepEqual(selectAlphaAssetsToPrune([oldAsset, newAsset], 1), [oldAsset]);
});

test("returns no assets when retention covers every distinct build", () => {
  const assets = [
    asset(1, "openwork-mac-arm64-0.18.14-alpha.1.zip"),
    asset(2, "openwork-mac-arm64-0.18.14-alpha.2.dmg"),
  ];
  assert.deepEqual(selectAlphaAssetsToPrune(assets, 2), []);
  assert.deepEqual(selectAlphaAssetsToPrune(assets, 3), []);
});

test("selects the exact old build assets from a mixed fixture", () => {
  const assets = [
    asset(1, "latest-mac.yml"),
    asset(2, "openwork-mac-arm64-0.18.14-alpha.998.zip"),
    asset(3, "openwork-mac-arm64-0.18.14-alpha.2109.zip"),
    asset(4, "openwork-mac-arm64-0.18.14-alpha.998.zip.blockmap"),
    asset(5, "openwork-mac-arm64-0.18.14-alpha.1500.dmg"),
    asset(6, "README.txt"),
    asset(7, "openwork-mac-arm64-0.18.14-alpha.2109.dmg.blockmap"),
  ];
  assert.deepEqual(selectAlphaAssetsToPrune(assets, 2), [assets[1], assets[3]]);
});
