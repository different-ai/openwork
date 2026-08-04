import assert from "node:assert/strict";
import { test } from "node:test";
import { selectReleasesToPurge } from "./purge-legacy-releases.mjs";

const release = (tag_name) => ({ tag_name });

test("matches every legacy release group", () => {
  const releases = [
    release("alpha-macos-v0.18.14-alpha.2109-892b12a"),
    release("v856076c-dev"),
    release("knoppers-4-experimental"),
    release("kitkat-1-canary"),
    release("canary-macos-v0.18.13-pre.19.canary-ecfcf98"),
    release("experimental-macos-v0.18.13-pre.21.experimental-93356e8"),
  ];
  assert.deepEqual(selectReleasesToPurge(releases, {
    includeSidecarBundles: false,
    protectedTags: [],
  }), [
    { tag: releases[0].tag_name, group: "alpha" },
    { tag: releases[1].tag_name, group: "dev" },
    { tag: releases[2].tag_name, group: "channel-alias" },
    { tag: releases[3].tag_name, group: "channel-alias" },
    { tag: releases[4].tag_name, group: "channel-build" },
    { tag: releases[5].tag_name, group: "channel-build" },
  ]);
});

test("never selects stable tags or the rolling alpha tag", () => {
  assert.deepEqual(selectReleasesToPurge([
    release("v0.18.14"),
    release("v0.18.14-alpha.1"),
    release("alpha-macos-latest"),
  ], {
    includeSidecarBundles: true,
    protectedTags: [],
  }), []);
});

test("excludes a release tag protected by the live manifest", () => {
  const protectedTag = "alpha-macos-v0.18.14-alpha.2109-892b12a";
  assert.deepEqual(selectReleasesToPurge([
    release(protectedTag),
    release("alpha-macos-v0.18.14-alpha.2108-1234567"),
  ], {
    includeSidecarBundles: false,
    protectedTags: new Set([protectedTag]),
  }), [
    { tag: "alpha-macos-v0.18.14-alpha.2108-1234567", group: "alpha" },
  ]);
});

test("includes sidecar bundles only when explicitly requested", () => {
  const releases = [
    release("openwork-orchestrator-v0.18.6"),
    release("openwrk-v0.11.74"),
  ];
  assert.deepEqual(selectReleasesToPurge(releases, {
    includeSidecarBundles: false,
    protectedTags: [],
  }), []);
  assert.deepEqual(selectReleasesToPurge(releases, {
    includeSidecarBundles: true,
    protectedTags: [],
  }), [
    { tag: "openwork-orchestrator-v0.18.6", group: "sidecar-orchestrator" },
    { tag: "openwrk-v0.11.74", group: "sidecar-openwrk" },
  ]);
});
