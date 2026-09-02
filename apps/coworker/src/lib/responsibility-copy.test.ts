import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describeDurationForPeople,
  describeMoment,
  describeRowStatus,
  describeRunTrend,
  describeScheduleForPeople,
  describeWhere,
  describeZone,
  outcomeForPrompt,
  sentenceCase,
} from "./responsibility-copy.ts";

const locale = "en-US";
const localZone = "America/Los_Angeles";
// A fixed Wednesday noon so "today", "tomorrow", and "yesterday" are stable.
const now = new Date(2026, 8, 2, 12, 0).getTime();

test("schedules read as everyday sentences and only mention a zone when it differs from the person's", () => {
  assert.equal(describeScheduleForPeople({ kind: "daily", hour: 9, minute: 0, timezone: localZone }, { localZone, locale }), "Every day at 9:00 AM");
  assert.equal(describeScheduleForPeople({ kind: "daily", hour: 9, minute: 0, timezone: "UTC" }, { localZone, locale }), "Every day at 9:00 AM (UTC)");
  assert.equal(describeScheduleForPeople({ kind: "daily", hour: 18, minute: 30, timezone: "Europe/Paris" }, { localZone, locale }), "Every day at 6:30 PM (Paris time)");
  assert.equal(describeScheduleForPeople({ kind: "weekly", daysOfWeek: [1, 4], hour: 9, minute: 0, timezone: localZone }, { localZone, locale }), "Every Monday and Thursday at 9:00 AM");
  assert.equal(describeScheduleForPeople({ kind: "weekly", daysOfWeek: [1, 2, 3, 4, 5], hour: 8, minute: 30, timezone: localZone }, { localZone, locale }), "Every weekday at 8:30 AM");
  assert.equal(describeScheduleForPeople({ kind: "weekly", daysOfWeek: [0, 6, 3], hour: 7, minute: 5, timezone: localZone }, { localZone, locale }), "Every Sunday, Wednesday, and Saturday at 7:05 AM");
  assert.equal(describeScheduleForPeople({ kind: "once", at: new Date(2026, 8, 5, 9, 0).getTime(), timezone: localZone }, { localZone, locale, now }), "Once, Sep 5 at 9:00 AM");
  assert.equal(describeZone("America/New_York", { localZone }), "(New York time)");
  assert.equal(describeZone(localZone, { localZone }), "");
});

test("moments are relative to the person's day and never show a raw timestamp", () => {
  assert.equal(describeMoment(new Date(2026, 8, 2, 12, 5).getTime(), { now, locale }), "today at 12:05 PM");
  assert.equal(describeMoment(new Date(2026, 8, 3, 9, 0).getTime(), { now, locale }), "tomorrow at 9:00 AM");
  assert.equal(describeMoment(new Date(2026, 8, 1, 15, 10).getTime(), { now, locale }), "yesterday at 3:10 PM");
  assert.equal(describeMoment(new Date(2026, 8, 20, 9, 0).getTime(), { now, locale }), "Sep 20 at 9:00 AM");
  assert.equal(describeMoment(new Date(2025, 11, 24, 9, 0).getTime(), { now, locale }), "Dec 24, 2025 at 9:00 AM");
  assert.equal(describeMoment(null, { now, locale }), "");
  assert.equal(sentenceCase("today at noon"), "Today at noon");
});

test("durations and outcomes are words, not units and status codes", () => {
  assert.equal(describeDurationForPeople(7_000), "7 seconds");
  assert.equal(describeDurationForPeople(1_000), "1 second");
  assert.equal(describeDurationForPeople(60_000), "1 minute");
  assert.equal(describeDurationForPeople(130_000), "2 minutes");
  assert.equal(describeDurationForPeople(3_900_000), "1 hour 5 minutes");
  assert.equal(outcomeForPrompt("succeeded"), "succeeded");
  assert.equal(outcomeForPrompt("missed"), "was missed");
  assert.equal(describeWhere("local"), "On this Mac — only while Open Coworker is open");
  assert.equal(describeWhere("cloud"), "In OpenWork Cloud — even when this Mac is off");
});

test("the trend line counts runs the way a person would say it", () => {
  assert.equal(describeRunTrend([]), "");
  assert.equal(describeRunTrend([{ outcome: "running" }]), "");
  assert.equal(describeRunTrend([{ outcome: "succeeded" }]), "Ran once · done");
  assert.equal(describeRunTrend([{ outcome: "failed" }]), "Ran once · didn't finish");
  assert.equal(describeRunTrend([{ outcome: "succeeded" }, { outcome: "failed" }]), "Ran twice · 1 done · 1 didn't finish");
  assert.equal(
    describeRunTrend([{ outcome: "succeeded" }, { outcome: "succeeded" }, { outcome: "missed" }, { outcome: "queued" }]),
    "Ran 3 times · 2 done · 1 missed",
  );
});

test("a row's status says what is happening, what happened, or what comes next", () => {
  const base = { latest: undefined, finished: undefined, paused: false, needsAttention: false, nextDueAt: new Date(2026, 8, 3, 9, 0).getTime() };
  assert.equal(describeRowStatus(base, { now, locale }), "Next: tomorrow at 9:00 AM");
  assert.equal(describeRowStatus({ ...base, nextDueAt: null }, { now, locale }), "Not scheduled");
  assert.equal(describeRowStatus({ ...base, paused: true }, { now, locale }), "Paused");
  assert.equal(describeRowStatus({ ...base, needsAttention: true }, { now, locale }), "Needs you");
  assert.equal(describeRowStatus({ ...base, latest: { outcome: "running", at: now } }, { now, locale }), "Working on it now");
  assert.equal(describeRowStatus({ ...base, latest: { outcome: "queued", at: now } }, { now, locale }), "Waiting its turn");
  const done = { outcome: "succeeded" as const, at: new Date(2026, 8, 2, 12, 5).getTime() };
  assert.equal(describeRowStatus({ ...base, latest: done, finished: done }, { now, locale }), "Done today at 12:05 PM");
  const failed = { outcome: "failed" as const, at: new Date(2026, 8, 1, 9, 0).getTime() };
  assert.equal(describeRowStatus({ ...base, latest: failed, finished: failed }, { now, locale }), "Didn't finish yesterday at 9:00 AM");
});
