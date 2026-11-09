import assert from "node:assert/strict";
import { test } from "node:test";
import constants from "../../../constants.json" with { type: "json" };
import artifacts from "../../server/src/opencode-v2-artifacts.json" with { type: "json" };
import { opencodeV2ArtifactKey } from "../scripts/prepare-opencode-v2.mjs";

const targets = [
  ["x86_64-unknown-linux-gnu", "linux-x64-baseline"],
  ["aarch64-unknown-linux-gnu", "linux-arm64"],
  ["x86_64-unknown-linux-musl", "linux-x64-baseline-musl"],
  ["aarch64-unknown-linux-musl", "linux-arm64-musl"],
  ["x86_64-apple-darwin", "darwin-x64-baseline"],
  ["aarch64-apple-darwin", "darwin-arm64"],
  ["x86_64-pc-windows-msvc", "windows-x64-baseline"],
  ["aarch64-pc-windows-msvc", "windows-arm64"],
];

test("every packaged v2 target uses the authoritative engine pin and a SHA-512 archive", () => {
  assert.equal(artifacts.version, constants.opencodeV2Version);
  assert.deepEqual(Object.keys(artifacts.platforms).sort(), targets.map(([, key]) => key).sort());
  for (const [target, key] of targets) {
    assert.equal(opencodeV2ArtifactKey(target), key);
    const artifact = artifacts.platforms[key];
    assert.equal(artifact.url, `https://registry.npmjs.org/@opencode/cli-${key}/-/cli-${key}-${constants.opencodeV2Version}.tgz`);
    assert.match(artifact.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
  }
  assert.throws(() => opencodeV2ArtifactKey("riscv64-unknown-linux-gnu"), /Unsupported OpenCode v2 target/);
});
