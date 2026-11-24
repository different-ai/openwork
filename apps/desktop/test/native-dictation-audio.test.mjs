import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("native speech conversion preserves duration and final audio samples", { skip: process.platform !== "darwin" }, () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "openwork-dictation-audio-"));
  const root = fileURLToPath(new URL("../", import.meta.url));
  try {
    const executable = path.join(directory, "test-audio");
    const built = spawnSync("swiftc", [path.join(root, "native/dictation/audio-input.swift"), path.join(root, "native/dictation/transcript.swift"),
      path.join(root, "test/native/dictation-audio.swift"), "-o", executable], { encoding: "utf8", timeout: 60_000 });
    assert.equal(built.status, 0, built.error?.message ?? built.stderr);
    const ran = spawnSync(executable, [], { encoding: "utf8", timeout: 10_000 });
    assert.equal(ran.status, 0, ran.error?.message ?? ran.stderr);
    assert.match(ran.stdout, /PASS: 24\/44\.1\/48 kHz/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
