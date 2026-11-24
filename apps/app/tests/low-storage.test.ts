import { expect, test } from "bun:test";
import type { OpenworkDiskSpace } from "../src/app/lib/openwork-server.ts";
import { LOW_STORAGE_CLEANED_UP_BYTES, LOW_STORAGE_SAVE_FAILED_REPEAT_MS, lowStorageCleanedUp, lowStorageNotice, parseLowStorageAnnouncement } from "../src/react-app/shell/low-storage.ts";

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const NOW = 1_800_000_000_000;

const disk = (level: OpenworkDiskSpace["level"], freeBytes: number | null): OpenworkDiskSpace => ({ level, freeBytes, totalBytes: 256 * GB });

test("a disk with room, or one the system cannot measure, says nothing", () => {
  expect(lowStorageNotice({ status: disk("ok", 40 * GB), announced: null, now: NOW, saveFailed: false })).toBeNull();
  expect(lowStorageNotice({ status: disk("ok", null), announced: null, now: NOW, saveFailed: true })).toBeNull();
});

test("the warning says how much is left and what to do", () => {
  expect(lowStorageNotice({ status: disk("low", 1.4 * GB), announced: null, now: NOW, saveFailed: false })).toEqual({
    level: "low",
    title: "Your disk is almost full",
    description: "1.4 GB left. Free up space so OpenWork can keep saving your work.",
  });
  expect(lowStorageNotice({ status: disk("critical", 120 * MB), announced: null, now: NOW, saveFailed: false })).toEqual({
    level: "critical",
    title: "Your disk is full",
    description: "120 MB left. OpenWork can't save changes until you free up space.",
  });
});

test("each level is said once, however long the disk stays short", () => {
  const longAgo = NOW - 90 * 24 * 60 * 60 * 1000;
  const toldLow = { level: "low" as const, at: longAgo };
  const toldCritical = { level: "critical" as const, at: longAgo };

  expect(lowStorageNotice({ status: disk("low", 1.2 * GB), announced: toldLow, now: NOW, saveFailed: false })).toBeNull();
  expect(lowStorageNotice({ status: disk("critical", 90 * MB), announced: toldCritical, now: NOW, saveFailed: false })).toBeNull();
  // Having been told it is full covers the milder warning too.
  expect(lowStorageNotice({ status: disk("low", 1.2 * GB), announced: toldCritical, now: NOW, saveFailed: false })).toBeNull();
  // Getting fuller is new.
  expect(lowStorageNotice({ status: disk("critical", 90 * MB), announced: { level: "low", at: NOW - 60_000 }, now: NOW, saveFailed: false })?.level).toBe("critical");
});

test("only a cleaned-up disk makes running low news again", () => {
  expect(lowStorageCleanedUp(disk("ok", LOW_STORAGE_CLEANED_UP_BYTES))).toBe(true);
  expect(lowStorageCleanedUp(disk("ok", 40 * GB))).toBe(true);
  // Back just above the warning limit is hovering, not cleaning up.
  expect(lowStorageCleanedUp(disk("ok", 2.5 * GB))).toBe(false);
  expect(lowStorageCleanedUp(disk("ok", null))).toBe(false);
  expect(lowStorageCleanedUp(disk("low", 1.2 * GB))).toBe(false);
});

test("a failed save brings the warning back at most once an hour, and only while the disk is short", () => {
  const failed = (at: number) => lowStorageNotice({ status: disk("critical", 10 * MB), announced: { level: "critical", at }, now: NOW, saveFailed: true });

  expect(failed(NOW - 60_000)).toBeNull();
  expect(failed(NOW - LOW_STORAGE_SAVE_FAILED_REPEAT_MS)?.title).toBe("Your disk is full");
  expect(lowStorageNotice({ status: disk("ok", 40 * GB), announced: null, now: NOW, saveFailed: true })).toBeNull();
});

test("a stored announcement that is missing or malformed reads as never announced", () => {
  expect(parseLowStorageAnnouncement(JSON.stringify({ level: "low", at: NOW }))).toEqual({ level: "low", at: NOW });
  for (const raw of [null, "", "not json", "null", "[]", JSON.stringify({ level: "ok", at: NOW }), JSON.stringify({ level: "low", at: "yesterday" })]) {
    expect(parseLowStorageAnnouncement(raw)).toBeNull();
  }
});
