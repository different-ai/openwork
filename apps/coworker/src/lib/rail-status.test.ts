import assert from "node:assert/strict";
import { test } from "node:test";
import { FREE_REMARKS, FULL_LIST_REMARKS, cleanTitle, describeRailLine, describeUpcoming, pickRemark } from "./rail-status.ts";
import type { CoworkerActivity } from "./threads.ts";

const NOW = new Date(2026, 8, 2, 16, 0).getTime();
const HOUR = 60 * 60_000;

function activity(partial: Partial<CoworkerActivity> & Pick<CoworkerActivity, "state">): CoworkerActivity {
  return { label: "", detail: "", updatedAt: 0, ...partial };
}

test("cleanTitle keeps the opening clause of a prompt-like title and never a numbered brief", () => {
  assert.equal(cleanTitle("Set up your memory for the job. 1) Record your mission focus in memory/working.md 2) List sources"), "Set up your memory for the job");
  assert.equal(cleanTitle("Morning competitor report"), "Morning competitor report");
  assert.equal(cleanTitle("Write the launch note for the September release and send it to the whole company by Friday morning"), "Write the launch note for the September release…");
  assert.equal(cleanTitle("   "), "");
});

test("describeUpcoming speaks in minutes, hours, a time, or a day", () => {
  assert.equal(describeUpcoming(NOW + 30_000, NOW), "any moment");
  assert.equal(describeUpcoming(NOW + 20 * 60_000, NOW), "in 20 min");
  assert.equal(describeUpcoming(NOW + 3 * HOUR, NOW), "in 3 hr");
  assert.match(describeUpcoming(NOW + 24 * HOUR - HOUR * 7, NOW), /^tomorrow 9:00/);
  assert.match(describeUpcoming(NOW + 3 * 24 * HOUR, NOW), /^Saturday 4:00/);
});

test("remarks are stable within a day and vary by coworker", () => {
  const scout = pickRemark(FREE_REMARKS.playful, "scout", NOW);
  assert.equal(pickRemark(FREE_REMARKS.playful, "scout", NOW + HOUR), scout);
  assert.ok(FREE_REMARKS.playful.includes(scout));
  const differs = ["nova", "editor", "ops", "care", "pipeline", "builder"].some((slug) => pickRemark(FREE_REMARKS.playful, slug, NOW) !== scout);
  assert.ok(differs);
  assert.equal(pickRemark([], "x", NOW), "");
});

test("the rail line prefers now, then needs, then what is next, then the list, then a remark", () => {
  const seed = "scout";
  assert.equal(describeRailLine({ activity: undefined, personality: "calm", seed, now: NOW }), "Checking current activity…");
  assert.equal(describeRailLine({ activity: activity({ state: "starting" }), personality: "calm", seed, now: NOW }), "Getting ready…");
  assert.equal(
    describeRailLine({ activity: activity({ state: "working", detail: "Set up your memory for the job. 1) Record your mission focus" }), personality: "calm", seed, now: NOW }),
    "Working on set up your memory for the job",
  );
  // Workers are the coworker working too: named when one is the subject, counted beside the coworker's own turn otherwise.
  assert.equal(
    describeRailLine({ activity: activity({ state: "working", detail: "Market scan", workers: { running: 1, subject: true } }), personality: "calm", seed, now: NOW }),
    "Worker Market scan is working",
  );
  assert.equal(
    describeRailLine({ activity: activity({ state: "working", detail: "Market scan", workers: { running: 2, subject: true } }), personality: "calm", seed, now: NOW }),
    "2 Workers running",
  );
  assert.equal(
    describeRailLine({ activity: activity({ state: "working", detail: "Draft the launch note", workers: { running: 1, subject: false } }), personality: "calm", seed, now: NOW }),
    "Working on draft the launch note · 1 Worker running",
  );
  assert.equal(describeRailLine({ activity: activity({ state: "attention", detail: "Waiting for permission to run a command" }), personality: "calm", seed, now: NOW }), "Waiting for permission to run a command");
  assert.equal(
    describeRailLine({ activity: activity({ state: "ready", next: { name: "Morning competitor report", at: NOW + 2 * HOUR } }), personality: "calm", seed, now: NOW }),
    "Next: Morning competitor report · in 2 hr",
  );
  // Something far off does not crowd out what just happened.
  assert.equal(
    describeRailLine({ activity: activity({ state: "recent", last: { title: "Weekly digest. Include the top three items.", updatedAt: NOW }, recent: [], next: { name: "Quarterly review", at: NOW + 10 * 24 * HOUR } }), personality: "calm", seed, now: NOW }),
    "Finished weekly digest",
  );
  const many = Array.from({ length: 5 }, (_, index) => ({ id: `a${index}`, title: `Task ${index}`, kind: "assignment" as const, outcome: "finished" as const, finishedAt: NOW }));
  const full = describeRailLine({ activity: activity({ state: "recent", last: { title: "Task 4", updatedAt: NOW }, recent: many }), personality: "playful", seed, now: NOW });
  assert.ok(FULL_LIST_REMARKS.playful.map((remark) => remark.replace("{n}", "5")).includes(full), full);
  const free = describeRailLine({ activity: activity({ state: "ready", recent: [] }), personality: "dry", seed, now: NOW });
  assert.ok(FREE_REMARKS.dry.includes(free), free);
  assert.equal(describeRailLine({ activity: activity({ state: "ready" }), personality: "none", seed, now: NOW }), "Ready for an assignment.");
});
