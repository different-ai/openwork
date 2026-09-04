import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { test } from "@openwork/testkit";

const localSpeechUnitTest = fileURLToPath(
  new URL("../../apps/desktop/electron/local-speech.test.mjs", import.meta.url),
);

test("local voice input keeps recordings bounded and hands text back to the composer", ({ evidence }) => {
  const unit = spawnSync(process.execPath, [
    "--test",
    "--test-reporter=tap",
    localSpeechUnitTest,
  ], { encoding: "utf8" });

  expect(unit.status, unit.stderr || unit.stdout).toBe(0);
  expect(unit.stdout).toContain("audioExtensionForMimeType ignores codec parameters");
  expect(unit.stdout).toContain("normalizeLocalSpeechAudio rejects empty and oversized recordings");
  expect(unit.stdout).toContain("status explains when local speech is unsupported");
  expect(unit.stdout).toContain("transcribe writes a private temporary recording and parses the worker response");
  expect(unit.stdout).not.toContain("not ok");
  expect(unit.stdout).toMatch(/# tests 4\b/);
  expect(unit.stdout).toMatch(/# pass 4\b/);
  expect(unit.stdout).toMatch(/# fail 0\b/);

  evidence.recordAssertionEvidence(
    "Local voice accepts supported recorder output without exposing arbitrary filesystem access",
    "The desktop boundary accepted byte buffers, normalized codec MIME types, rejected empty and oversized recordings, used a private temporary file, parsed the local worker result, and cleaned the temporary directory.",
    true,
  );
});
