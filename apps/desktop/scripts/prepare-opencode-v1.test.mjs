import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import manifest from "./opencode-v1-artifacts.json" with { type: "json" };
import { opencodeV1Pin, prepareOpencodeV1 } from "./prepare-opencode-v1.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function setup(t) {
  const root = mkdtempSync(join(tmpdir(), "openwork-sidecar-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const asset = "opencode-linux-arm64.tar.gz";
  const binary = Buffer.from("harmless fixture bytes");
  writeFileSync(join(root, "opencode"), binary);
  execFileSync("tar", ["-czf", asset, "opencode"], { cwd: root });
  return {
    sidecarDir: join(root, "sidecars"), cacheDir: join(root, "cache"), targets: ["opencode-target", "opencode"], asset,
    fetchArchive: (_url, dest) => copyFileSync(join(root, asset), dest),
    pin: { sha256: digest(readFileSync(join(root, asset))), binarySha256: digest(binary) },
  };
}

test("both names must have the pinned bytes to reuse an installed binary", (t) => {
  const input = setup(t);
  prepareOpencodeV1(input);
  const original = readFileSync(join(input.sidecarDir, "opencode"));
  prepareOpencodeV1({ ...input, fetchArchive: () => assert.fail("cache hit should be offline") });
  writeFileSync(join(input.sidecarDir, "opencode"), "stale alias");
  prepareOpencodeV1(input);
  for (const name of input.targets) assert.deepEqual(readFileSync(join(input.sidecarDir, name)), original);
});

test("an invalid archive or binary leaves the previous outputs intact", (t) => {
  const input = setup(t);
  mkdirSync(input.sidecarDir);
  writeFileSync(join(input.sidecarDir, "opencode"), "previous");
  for (const [key, error] of [["sha256", /archive integrity/], ["binarySha256", /binary integrity/]]) {
    assert.throws(() => prepareOpencodeV1({ ...input, pin: { ...input.pin, [key]: "0".repeat(64) } }), error);
    assert.equal(readFileSync(join(input.sidecarDir, "opencode"), "utf8"), "previous");
    assert.equal(existsSync(join(input.sidecarDir, "opencode-target")), false);
  }
});

test("signed copies are derived from an independently checked archive on warm starts", (t) => {
  const input = { ...setup(t), sign: (file) => appendFileSync(file, " signed") };
  prepareOpencodeV1(input);
  writeFileSync(join(input.sidecarDir, "opencode-target"), "stale signed binary");
  prepareOpencodeV1({ ...input, fetchArchive: () => assert.fail("good cached archive should be offline") });
  assert.equal(readFileSync(join(input.sidecarDir, "opencode-target"), "utf8"), "harmless fixture bytes signed");
  writeFileSync(join(input.cacheDir, input.asset), "corrupt cache");
  prepareOpencodeV1(input);
  assert.equal(digest(readFileSync(join(input.cacheDir, input.asset))), input.pin.sha256);
});

test("release pins require a matching version and asset, and mirrors retain the official digest", () => {
  const asset = "opencode-darwin-arm64.zip";
  const official = opencodeV1Pin(manifest.version, asset, "anomalyco/opencode");
  assert.deepEqual(opencodeV1Pin(manifest.version, asset, "custom/build", {}), official);
  const overrides = { OPENCODE_ARCHIVE_SHA256: "a".repeat(64), OPENCODE_BINARY_SHA256: "b".repeat(64) };
  assert.deepEqual(opencodeV1Pin(manifest.version, asset, "anomalyco/opencode", overrides), official);
  assert.deepEqual(opencodeV1Pin("v0", asset, "custom/build", overrides), {
    sha256: overrides.OPENCODE_ARCHIVE_SHA256, binarySha256: overrides.OPENCODE_BINARY_SHA256,
  });
  assert.throws(() => opencodeV1Pin("v0", asset, "anomalyco/opencode"), /Missing/);
  assert.throws(() => opencodeV1Pin("v0", "../asset.zip", "custom/build"), /Invalid/);
  assert.throws(() => opencodeV1Pin("v0", asset, "custom/build", { OPENCODE_ARCHIVE_SHA256: "a".repeat(64) }), /both/);
});
