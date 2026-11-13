import { expect, test } from "bun:test";
import type { OpenworkDiskSpace } from "../src/app/lib/openwork-server.ts";
import { LOW_STORAGE_REPEAT_MS, lowStorageNotice, parseLowStorageAnnouncement } from "../src/react-app/shell/low-storage.ts";

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

test("a dismissed warning is not repeated until the disk gets fuller or a day passes", () => {
  const toldLow = { level: "low" as const, at: NOW - 60_000 };
  const toldCritical = { level: "critical" as const, at: NOW - 60_000 };

  expect(lowStorageNotice({ status: disk("low", 1.2 * GB), announced: toldLow, now: NOW, saveFailed: false })).toBeNull();
  expect(lowStorageNotice({ status: disk("critical", 90 * MB), announced: toldCritical, now: NOW, saveFailed: false })).toBeNull();
  // Having been told it is full covers the milder warning too.
  expect(lowStorageNotice({ status: disk("low", 1.2 * GB), announced: toldCritical, now: NOW, saveFailed: false })).toBeNull();

  expect(lowStorageNotice({ status: disk("critical", 90 * MB), announced: toldLow, now: NOW, saveFailed: false })?.level).toBe("critical");
  expect(lowStorageNotice({ status: disk("low", 1.2 * GB), announced: { level: "low", at: NOW - LOW_STORAGE_REPEAT_MS }, now: NOW, saveFailed: false })?.level).toBe("low");
});

test("a save that just failed for lack of space is said again, but only while the disk is short", () => {
  const told = { level: "critical" as const, at: NOW - 60_000 };
  expect(lowStorageNotice({ status: disk("critical", 10 * MB), announced: told, now: NOW, saveFailed: true })?.title).toBe("Your disk is full");
  expect(lowStorageNotice({ status: disk("ok", 40 * GB), announced: told, now: NOW, saveFailed: true })).toBeNull();
});

test("a stored announcement that is missing or malformed reads as never announced", () => {
  expect(parseLowStorageAnnouncement(JSON.stringify({ level: "low", at: NOW }))).toEqual({ level: "low", at: NOW });
  for (const raw of [null, "", "not json", "null", "[]", JSON.stringify({ level: "ok", at: NOW }), JSON.stringify({ level: "low", at: "yesterday" })]) {
    expect(parseLowStorageAnnouncement(raw)).toBeNull();
  }
});
