import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseArgs, validateUpdaterManifest } from "./verify-updater-endpoint.mjs";

const validManifest = {
  version: "0.12.0",
  pub_date: "2026-04-28T00:00:00Z",
  platforms: {
    "darwin-aarch64": {
      signature: "signed",
      url: "https://example.com/openwork.app.tar.gz",
    },
  },
};

const releaseWorkflow = readFileSync(new URL("../../.github/workflows/release-macos-aarch64.yml", import.meta.url), "utf8");

test("accepts a valid updater manifest", () => {
  assert.deepEqual(validateUpdaterManifest(validManifest, { platform: "darwin-aarch64" }), []);
});

test("rejects missing required fields", () => {
  assert.deepEqual(validateUpdaterManifest({}), [
    "version must be a non-empty string",
    "pub_date must be a non-empty string",
    "platforms must be a non-empty object",
  ]);
});

test("rejects invalid dates and empty platforms", () => {
  assert.deepEqual(
    validateUpdaterManifest({
      version: "0.12.0",
      pub_date: "not-a-date",
      platforms: {},
    }),
    ["pub_date must be a valid date string", "platforms must contain at least one platform"],
  );
});

test("rejects missing expected platform", () => {
  assert.deepEqual(validateUpdaterManifest(validManifest, { platform: "windows-x86_64" }), [
    "platforms must include windows-x86_64",
  ]);
});

test("rejects platform entries without signatures", () => {
  const manifest = {
    ...validManifest,
    platforms: {
      "darwin-aarch64": {
        url: "https://example.com/openwork.app.tar.gz",
      },
    },
  };

  assert.deepEqual(validateUpdaterManifest(manifest), [
    "platform darwin-aarch64 must include a non-empty signature",
  ]);
});

test("rejects platform entries without urls", () => {
  const manifest = {
    ...validManifest,
    platforms: {
      "darwin-aarch64": {
        signature: "signed",
      },
    },
  };

  assert.deepEqual(validateUpdaterManifest(manifest), ["platform darwin-aarch64 must include a non-empty url"]);
});

test("rejects platform entries that are not objects", () => {
  const manifest = {
    ...validManifest,
    platforms: {
      "darwin-aarch64": null,
    },
  };

  assert.deepEqual(validateUpdaterManifest(manifest), ["platform darwin-aarch64 must be an object"]);
});

test("rejects invalid source arguments", () => {
  assert.throws(
    () => parseArgs(["node", "verify-updater-endpoint.mjs"]),
    /Missing updater manifest source/,
  );
  assert.throws(
    () => parseArgs(["node", "verify-updater-endpoint.mjs", "--file", "latest.json", "--url", "https://example.com/latest.json"]),
    /Use either --file or --url/,
  );
});

test("rejects invalid retry arguments", () => {
  assert.throws(
    () => parseArgs(["node", "verify-updater-endpoint.mjs", "--file", "latest.json", "--attempts", "0"]),
    /--attempts must be a positive integer/,
  );
  assert.throws(
    () => parseArgs(["node", "verify-updater-endpoint.mjs", "--file", "latest.json", "--delay-ms", "-1"]),
    /--delay-ms must be a non-negative integer/,
  );
});

test("release creation does not claim GitHub Latest before manifests are ready", () => {
  assert.match(releaseWorkflow, /gh release create[\s\S]*--latest=false[\s\S]*\$DRAFT_FLAG \$PRERELEASE_FLAG/);
  assert.doesNotMatch(releaseWorkflow, /needs\.resolve-release\.outputs\.draft == 'true'/);
  assert.match(releaseWorkflow, /payload\.make_latest = "true"/);
});
