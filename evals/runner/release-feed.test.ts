import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ReleaseFeedLab,
  buildReleaseAssetUrl,
  createReleaseCatalog,
  fetchAssetOrThrow,
  highestAllowedVersion,
  isReleaseLabError,
  normalizeReleaseCatalog,
  resolveAllowedUpdate,
  simulateBrowserRenamedFileName,
} from "./labs/release-feed.ts";
import { resolveBootstrapPrecedence } from "./journeys/update.ts";

describe("release feed catalog resolution", () => {
  test("selects highest allowed instead of latest and treats empty allowlist as unrestricted", () => {
    const catalog = normalizeReleaseCatalog(createReleaseCatalog(["0.17.20", "0.17.30", "0.17.40"]));

    assert.equal(highestAllowedVersion(catalog, ["0.17.30"]), "0.17.30");
    assert.equal(resolveAllowedUpdate({ catalog, currentVersion: "0.17.20", allowedVersions: ["0.17.30"] }), "0.17.30");
    assert.equal(resolveAllowedUpdate({ catalog, currentVersion: "0.17.20", allowedVersions: [] }), "0.17.40");
    assert.equal(resolveAllowedUpdate({ catalog, currentVersion: "0.17.20", allowedVersions: ["0.17.99"] }), null);
  });
});

describe("release feed URL and filename handling", () => {
  test("constructs release asset URLs and resolves browser-renamed filenames", async () => {
    const feed = await new ReleaseFeedLab({
      catalog: createReleaseCatalog(["0.17.40"], { platforms: ["win-x64"], distribution: "enterprise" }),
    }).start();
    try {
      const fileName = "openwork-enterprise-win-x64-0.17.40.exe";
      assert.equal(
        buildReleaseAssetUrl({ baseUrl: feed.baseUrl, version: "0.17.40", fileName }),
        `${feed.baseUrl}/different-ai/openwork/releases/download/v0.17.40/openwork-enterprise-win-x64-0.17.40.exe`,
      );
      const renamed = simulateBrowserRenamedFileName(fileName);
      assert.equal(feed.resolveClientDownloadedAsset("0.17.40", "win-x64", renamed).fileName, fileName);
      assert.equal(feed.resolveClientDownloadedAsset("0.17.40", "win-x64", fileName).fileName, fileName);
    } finally {
      await feed.stop();
    }
  });
});

describe("release feed cache semantics", () => {
  test("honors cache TTL and explicit staleUntil", () => {
    const feed = new ReleaseFeedLab({
      catalog: createReleaseCatalog(["0.17.20"]),
      cacheTtlMs: 1_000,
    });

    assert.equal(feed.snapshot(1_000).metadata.latestAppVersion, "0.17.20");
    feed.updateCatalog(createReleaseCatalog(["0.17.20", "0.17.40"]));
    assert.equal(feed.snapshot(1_500).metadata.latestAppVersion, "0.17.20");
    assert.equal(feed.snapshot(2_001).metadata.latestAppVersion, "0.17.40");

    const stale = new ReleaseFeedLab({
      initialCatalog: createReleaseCatalog(["0.17.20"]),
      catalog: createReleaseCatalog(["0.17.20", "0.17.40"]),
      staleUntil: 5_000,
    });
    assert.equal(stale.snapshot(4_999).metadata.latestAppVersion, "0.17.20");
    assert.equal(stale.snapshot(5_000).metadata.latestAppVersion, "0.17.40");
  });
});

describe("release feed fault knobs", () => {
  test("turns a 504 artifact response into an actionable error", async () => {
    const feed = await new ReleaseFeedLab({
      catalog: [{
        version: "0.17.40",
        assets: [{
          platform: "win-x64",
          distribution: "enterprise",
          fault: { kind: "status", status: 504, message: "GitHub propagation lag" },
        }],
      }],
    }).start();
    try {
      await assert.rejects(
        () => fetchAssetOrThrow(feed.assetUrl("0.17.40", "win-x64")),
        (error) => isReleaseLabError(error) && error.code === "release_asset_propagation_lag" && error.action.includes("Retry"),
      );
    } finally {
      await feed.stop();
    }
  });

  test("serves slow chunked assets without corrupting the artifact body", async () => {
    const feed = await new ReleaseFeedLab({
      catalog: [{
        version: "0.17.40",
        assets: [{
          platform: "win-x64",
          distribution: "enterprise",
          body: "chunk-one\nchunk-two\n",
          fault: { kind: "slow-chunked", chunkSize: 5, delayMs: 1 },
        }],
      }],
    }).start();
    try {
      const body = await fetchAssetOrThrow(feed.assetUrl("0.17.40", "win-x64"));
      assert.equal(new TextDecoder().decode(body), "chunk-one\nchunk-two\n");
    } finally {
      await feed.stop();
    }
  });
});

describe("bootstrap precedence helper", () => {
  test("drives workspace-store precedence so an installed organization URL outranks a newer hosted bundle", async () => {
    const organizationUrl = "https://openwork.organization.internal.example";
    const result = await resolveBootstrapPrecedence({
      before: {
        serverUrl: organizationUrl,
        bundleServerUrl: "https://app.openworklabs.com",
        installedPath: "canonical",
      },
      after: { serverUrl: organizationUrl },
    });

    assert.equal(result.importedBeforeRead, false);
    assert.equal(result.importedAfterRestart, false);
    assert.equal(result.firstBaseUrl, organizationUrl);
    assert.equal(result.restartedBaseUrl, organizationUrl);
    assert.equal(result.persistedBaseUrl, organizationUrl);
  });
});
