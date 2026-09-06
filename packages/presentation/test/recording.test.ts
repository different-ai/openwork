import test from "node:test";
import assert from "node:assert/strict";
import { frameAt, recordingFromCapture } from "../src/recording.ts";

const capture = {
  format: "cdp-screencast",
  stoppedAt: 13_000,
  frames: [
    { file: "frames/0000000.jpg", timestamp: 10 },
    { file: "frames/0000001.jpg", timestamp: 11 },
  ],
  downloads: [
    {
      event: "Browser.downloadWillBegin",
      guid: "installer",
      receivedAt: 11_000,
    },
    {
      event: "Browser.downloadProgress",
      guid: "installer",
      state: "completed",
      receivedBytes: 42,
      totalBytes: 42,
      receivedAt: 12_000,
    },
  ],
};

test("playback holds painted frames while a static page waits for a download", () => {
  const recording = recordingFromCapture(capture);
  assert.equal(recording.durationSeconds, 3);
  assert.equal(frameAt(recording.frames, -1).file, "frames/0000000.jpg");
  assert.equal(frameAt(recording.frames, 0.99).file, "frames/0000000.jpg");
  assert.equal(frameAt(recording.frames, 1).file, "frames/0000001.jpg");
  assert.equal(frameAt(recording.frames, 20).file, "frames/0000001.jpg");
  assert.deepEqual(recording.downloads, [
    {
      seconds: 2,
      guid: "installer",
      state: "completed",
      receivedBytes: 42,
      totalBytes: 42,
    },
  ]);
});

test("capture parsing rejects missing, unordered, and escaping frame sources", () => {
  assert.throws(
    () => recordingFromCapture({ ...capture, frames: [] }),
    /nonempty/,
  );
  assert.throws(
    () =>
      recordingFromCapture({
        ...capture,
        frames: [...capture.frames].reverse(),
      }),
    /chronological/,
  );
  assert.throws(
    () =>
      recordingFromCapture({
        ...capture,
        frames: [{ file: "../secret.jpg", timestamp: 10 }],
      }),
    /Unsafe/,
  );
  assert.throws(
    () => recordingFromCapture({ ...capture, stoppedAt: NaN }),
    /finite/,
  );
});
