import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPublishedDesktopVersions,
  renderDesktopVersionsFile,
} from "./generate-desktop-versions.mjs";

test("builds a deduplicated newest-first inventory from stable v tags", () => {
  assert.deepEqual(buildPublishedDesktopVersions({
    tags: [
      "v0.17.2",
      "v0.17.0",
      "v0.17.1",
      "v0.17.2",
      "0.17.3",
      "v0.17.3-alpha.1",
      "alpha-macos-v0.17.3",
      "v0.16.9",
      "v0.18.0",
    ],
    currentVersion: "0.17.3",
  }), ["0.17.3", "0.17.2", "0.17.1", "0.17.0"]);
});

test("renders a TypeScript constant with the minimum version", () => {
  const source = renderDesktopVersionsFile(["0.17.1", "0.17.0"]);
  assert.match(source, /MIN_SUPPORTED_DESKTOP_VERSION = "0\.17\.0"/);
  assert.match(source, /PUBLISHED_DESKTOP_VERSIONS = \[/);
  assert.match(source, /"0\.17\.1"/);
});
