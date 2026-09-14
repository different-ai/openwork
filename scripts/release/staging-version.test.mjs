import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  applyStagingVersion,
  parseStagingTag,
  resolveStagingVersion,
} from "./staging-version.mjs";

const temporaryRoots = [];

function createFixture(appVersion = "0.18.5", desktopVersion = appVersion) {
  const root = mkdtempSync(resolve(tmpdir(), "openwork-staging-version-"));
  temporaryRoots.push(root);
  for (const [relativePath, version] of [
    ["apps/app/package.json", appVersion],
    ["apps/desktop/package.json", desktopVersion],
  ]) {
    const path = resolve(root, relativePath);
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ name: relativePath, version }, null, 2)}\n`);
  }
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("parseStagingTag", () => {
  it("resolves a strict staging tag into the Electron version", () => {
    assert.deepEqual(parseStagingTag("v0.18.6-staging.12"), {
      tag: "v0.18.6-staging.12",
      version: "0.18.6-staging.12",
      baseVersion: "0.18.6",
      sequence: "12",
    });
  });

  it("rejects stable, loosely named, and zero-padded tags", () => {
    for (const tag of [
      "v0.18.6",
      "0.18.6-staging.1",
      "v0.18.6-rc.1",
      "v0.18.6-staging.01",
      "v0.18-staging.1",
    ]) {
      assert.throws(() => parseStagingTag(tag), /expected vX\.Y\.Z-staging\.N/);
    }
  });
});

describe("resolveStagingVersion", () => {
  it("accepts a future stable base version", () => {
    const root = createFixture();
    const result = resolveStagingVersion({
      root,
      tag: "v0.19.0-staging.1",
    });
    assert.equal(result.baseVersion, "0.19.0");
    assert.equal(result.sourceVersion, "0.18.5");
  });

  it("rejects current or older staging bases and mismatched source versions", () => {
    const root = createFixture();
    for (const tag of ["v0.18.5-staging.1", "v0.18.4-staging.1"]) {
      assert.throws(
        () => resolveStagingVersion({ root, tag }),
        /must be newer than source version/,
      );
    }

    const mismatchedRoot = createFixture("0.18.5", "0.18.6");
    assert.throws(
      () => resolveStagingVersion({ root: mismatchedRoot, tag: "v0.18.7-staging.1" }),
      /must match and be stable/,
    );
  });
});

describe("applyStagingVersion", () => {
  it("stamps both desktop package versions without touching other metadata", () => {
    const root = createFixture();
    const result = applyStagingVersion({ root, tag: "v0.18.6-staging.3" });

    assert.equal(result.version, "0.18.6-staging.3");
    for (const relativePath of result.files) {
      const value = JSON.parse(readFileSync(resolve(root, relativePath), "utf8"));
      assert.equal(value.version, "0.18.6-staging.3");
      assert.equal(value.name, relativePath);
    }
  });
});
