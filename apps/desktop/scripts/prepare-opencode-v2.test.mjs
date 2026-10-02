import { test } from "node:test";
import assert from "node:assert/strict";
import { opencodeV2ArtifactKey } from "./prepare-opencode-v2.mjs";

test("bundles compatible pinned v2 binaries for every desktop target", () => {
  for (const [target, expected] of [
    ["aarch64-apple-darwin", "darwin-arm64"], ["x86_64-apple-darwin", "darwin-x64-baseline"],
    ["aarch64-unknown-linux-gnu", "linux-arm64"], ["x86_64-unknown-linux-gnu", "linux-x64-baseline"],
    ["x86_64-unknown-linux-musl", "linux-x64-baseline-musl"],
    ["aarch64-pc-windows-msvc", "windows-arm64"], ["x86_64-pc-windows-msvc", "windows-x64-baseline"],
  ]) assert.equal(opencodeV2ArtifactKey(target), expected);
  assert.throws(() => opencodeV2ArtifactKey("unknown"));
});
