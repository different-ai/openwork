import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { decodePng, diffPixels, diffText } from "../src/screen-change.ts";
import { describeChange, createTestEvidence } from "../src/test-evidence.ts";
import type { ScreenshotArtifact } from "../src/screenshot.ts";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc(buffer: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, tail]);
}

/** An RGB PNG painted by `paint`; its rows cycle through all five filters, as encoders mix them. */
function png(width: number, height: number, paint: (x: number, y: number) => [number, number, number]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows: Buffer[] = [];
  let previous = Buffer.alloc(width * 3);
  for (let y = 0; y < height; y += 1) {
    const line = Buffer.alloc(width * 3);
    for (let x = 0; x < width; x += 1) line.set(paint(x, y), x * 3);
    const filter = y % 5;
    const out = Buffer.alloc(width * 3);
    for (let i = 0; i < line.length; i += 1) {
      const a = i >= 3 ? line[i - 3] : 0;
      const b = previous[i];
      const c = i >= 3 ? previous[i - 3] : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      out[i] = (line[i] - [0, a, b, (a + b) >> 1, paeth][filter]) & 255;
    }
    rows.push(Buffer.from([filter]), out);
    previous = line;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

const blank = png(200, 120, () => [255, 255, 255]);
const panel = png(200, 120, (x, y) => (x >= 40 && x < 120 && y >= 60 && y < 90 ? [30, 30, 30] : [255, 255, 255]));

test("PNG rows decode through every filter", () => {
  const image = decodePng(png(13, 11, (x, y) => [x * 19, y * 23, (x * y) % 256]));
  assert.ok(image);
  for (const [x, y] of [[0, 0], [12, 10], [5, 7]]) {
    assert.deepEqual([...image.rgb.subarray((y * 13 + x) * 3, (y * 13 + x) * 3 + 3)], [x * 19, y * 23, (x * y) % 256]);
  }
  assert.equal(decodePng(Buffer.from("not an image")), null);
});

test("a changed panel is one region; a blinking caret and anti-aliasing are not changes", () => {
  const before = decodePng(blank);
  const after = decodePng(panel);
  assert.ok(before && after);
  assert.deepEqual(diffPixels(before, after), { ratio: (80 * 30) / (200 * 120), boxes: [{ x: 0.2, y: 0.5, width: 0.4, height: 0.25 }] });
  const caret = decodePng(png(200, 120, (x, y) => (x === 10 && y >= 5 && y < 22 ? [0, 0, 0] : [250, 250, 250])));
  assert.ok(caret);
  assert.deepEqual(diffPixels(before, caret), { ratio: 0, boxes: [] });
});

test("visible text that appeared and went away, capped and redactable", () => {
  const change = diffText("Search models\nAuto\nAdvanced options\n3s\nLP", "Search models\nAdvanced options\nAuto manages its model settings.\njo@example.com\n1m\n2 min ago", (line) => line.replace(/\S+@\S+/, "<email>"));
  assert.deepEqual(change, { added: ["Auto manages its model settings.", "<email>"], addedCount: 2, removed: ["Auto"], removedCount: 1 });
});

function frame(body: Buffer, visibleText: string, at: string): ScreenshotArtifact {
  return { png: body, hash: createHash("sha256").update(body).digest("hex"), route: "#/", visibleText, at };
}

test("each screenshot records its step, what the person did since the last one, and what changed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwork-screen-change-"));
  try {
    const evidence = createTestEvidence({ name: "panel", outDir: dir });
    evidence.setActiveStep("before: the panel is closed");
    evidence.recordScreenshot(frame(blank, "Open panel", "2026-10-02T10:00:01.000Z"), { caption: "before: the panel is closed" });
    evidence.recordAssertionEvidence("No panel", "0 panels", true);
    evidence.recordTrace({ stage: "body", channel: "user", verb: "click", detail: "click(text=Open panel)", ok: true, at: "2026-10-02T10:00:02.000Z" });
    evidence.recordTrace({ stage: "body", channel: "user", verb: "see", detail: "see(text=Saved)", ok: true, at: "2026-10-02T10:00:03.000Z" });
    evidence.setActiveStep("after: the panel opens");
    evidence.recordScreenshot(frame(panel, "Open panel\nSaved", "2026-10-02T10:00:04.000Z"), {
      caption: "after: the panel opens",
      focus: [{ label: "Saved", box: { x: 0.2, y: 0.5, width: 0.4, height: 0.25 } }],
    });
    evidence.recordScreenshot(frame(panel, "Open panel\nSaved", "2026-10-02T10:00:05.000Z"), { caption: "failed: the panel survives reload", failure: true });
    evidence.setActiveStep(undefined);
    await evidence.close();
    const record: unknown = JSON.parse(await readFile(join(dir, "test-run.json"), "utf8"));
    assert.ok(typeof record === "object" && record !== null && "artifacts" in record && Array.isArray(record.artifacts));
    const [before, check, after, failure] = record.artifacts;
    assert.equal(before.step, "before: the panel is closed");
    assert.equal(before.change.since, null);
    assert.equal(check.step, "before: the panel is closed");
    assert.equal(after.step, "after: the panel opens");
    assert.deepEqual(after.change, {
      since: "01-before-the-panel-is-closed.png",
      actions: ["click(text=Open panel)"],
      ratio: (80 * 30) / (200 * 120),
      boxes: [{ x: 0.2, y: 0.5, width: 0.4, height: 0.25 }],
      added: ["Saved"],
      addedCount: 1,
      removed: [],
      removedCount: 0,
    });
    assert.deepEqual(after.focus, [{ label: "Saved", box: { x: 0.2, y: 0.5, width: 0.4, height: 0.25 } }]);
    assert.equal(failure.failure, true);
    assert.equal(failure.change.ratio, 0);
    assert.equal(describeChange(after.change), "After click(text=Open panel): shows “Saved”.");
    assert.equal(describeChange(failure.change), "Same screen as the previous screenshot.");
    assert.match(await readFile(join(dir, "index.html"), "utf8"), /After click\(text=Open panel\): shows “Saved”\./);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a screenshot only says it shows lines inside the captured window, with secrets redacted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwork-screen-change-"));
  try {
    const evidence = createTestEvidence({ name: "scrolled list", outDir: dir });
    evidence.recordScreenshot(frame(blank, "Inbox", "2026-10-02T10:00:01.000Z"), { caption: "before: the inbox" });
    evidence.recordScreenshot({
      ...frame(panel, "Inbox\nNew draft\napi_token=abc123\nOlder message below the fold", "2026-10-02T10:00:02.000Z"),
      viewportText: "Inbox\nNew draft\napi_token=abc123",
    }, { caption: "after: a draft appears" });
    await evidence.close();
    const record: unknown = JSON.parse(await readFile(join(dir, "test-run.json"), "utf8"));
    assert.ok(typeof record === "object" && record !== null && "artifacts" in record && Array.isArray(record.artifacts));
    const after = record.artifacts[1];
    assert.deepEqual(after.change.added, ["New draft", "api_token=<redacted>"]);
    assert.equal(after.viewportText, undefined, "the window's text is used to compare, not stored");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
