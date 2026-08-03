import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { updateAurContents, verifyAurContents } from "./aur-packaging.mjs";
import { AUR_HOST_FINGERPRINTS, validateHostFingerprints } from "./pin-host-keys.mjs";

const root = resolve(import.meta.dirname, "../..");
const digest = (value) => createHash("sha256").update(value).digest("hex");

test("AUR files use checksums from exact staged public Linux bytes", () => {
  const original = {
    pkgbuild: readFileSync(resolve(root, "packaging/aur/PKGBUILD"), "utf8"),
    srcinfo: readFileSync(resolve(root, "packaging/aur/.SRCINFO"), "utf8"),
  };
  const input = {
    ...original,
    version: "9.8.7",
    shaX64: digest("staged x64 bytes"),
    shaArm64: digest("staged arm64 bytes"),
    repository: "different-ai/openwork",
  };
  const updated = updateAurContents(input);
  assert.doesNotThrow(() => verifyAurContents({ ...input, ...updated }));
  assert.match(updated.srcinfo, /openwork-linux-x64-9\.8\.7\.tar\.gz/);
  assert.match(updated.srcinfo, /openwork-linux-arm64-9\.8\.7\.tar\.gz/);

  assert.deepEqual(updateAurContents({ ...input, ...updated }), updated);
  assert.throws(() => verifyAurContents({
    ...input,
    ...updated,
    srcinfo: updated.srcinfo.replace(input.shaArm64, "0".repeat(64)),
  }), /\.SRCINFO/);
  assert.throws(() => verifyAurContents({
    ...input,
    ...updated,
    srcinfo: updated.srcinfo.replace("different-ai/openwork", "attacker/fork"),
  }), /\.SRCINFO/);
});

test("AUR host trust requires every official pinned fingerprint", () => {
  const records = Object.entries(AUR_HOST_FINGERPRINTS).map(([type, fingerprint]) => ({ type, fingerprint }));
  assert.doesNotThrow(() => validateHostFingerprints(records));
  assert.throws(() => validateHostFingerprints(records.slice(1)), /Missing pinned/);
  assert.throws(() => validateHostFingerprints([
    { ...records[0], fingerprint: "SHA256:wrong" },
    ...records.slice(1),
  ]), /mismatch/);
});
