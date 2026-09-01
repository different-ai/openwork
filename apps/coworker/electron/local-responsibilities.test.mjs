import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createCoworker } from "./coworkers.mjs";
import {
  beginLocalResponsibilityRun,
  createLocalResponsibility,
  deleteLocalResponsibility,
  finishLocalResponsibilityRun,
  listLocalResponsibilities,
  setLocalResponsibilityActive,
} from "./local-responsibilities.mjs";

const roots = [];
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "coworker-local-responsibilities-"));
  roots.push(root);
  const coworkersDir = path.join(root, "coworkers");
  await createCoworker(coworkersDir, { name: "Scout" });
  return coworkersDir;
}

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

test("local responsibilities reuse OpenWork schedules and persist next occurrence", async () => {
  const coworkersDir = await fixture();
  const now = Date.UTC(2026, 8, 1, 15, 0);
  const created = await createLocalResponsibility(coworkersDir, "scout", {
    name: "Daily brief",
    instructions: "Review the workspace and prepare a brief.",
    schedule: { kind: "daily", timezone: "UTC", hour: 16, minute: 30 },
  }, now);
  assert.equal(created.state, "active");
  assert.equal(created.nextDueAt, Date.UTC(2026, 8, 1, 16, 30));
  assert.deepEqual(await listLocalResponsibilities(coworkersDir, "scout"), [created]);
});

test("scheduled runs advance before execution and retain native thread outcome", async () => {
  const coworkersDir = await fixture();
  const now = Date.UTC(2026, 8, 1, 15, 0);
  const created = await createLocalResponsibility(coworkersDir, "scout", {
    name: "Daily brief",
    instructions: "Prepare a brief.",
    schedule: { kind: "daily", timezone: "UTC", hour: 16, minute: 30 },
  }, now);
  const started = await beginLocalResponsibilityRun(coworkersDir, "scout", created.id, {
    trigger: "scheduled",
    now: Date.UTC(2026, 8, 1, 16, 30),
  });
  assert.equal(started.latestRun.status, "running");
  assert.equal(started.nextDueAt, Date.UTC(2026, 8, 2, 16, 30));
  const finished = await finishLocalResponsibilityRun(coworkersDir, "scout", created.id, started.latestRun.id, {
    status: "succeeded",
    now: Date.UTC(2026, 8, 1, 16, 35),
  });
  assert.equal(finished.latestRun.status, "succeeded");
  assert.equal(finished.latestRun.finishedAt, Date.UTC(2026, 8, 1, 16, 35));
});

test("local responsibilities pause, resume, and delete", async () => {
  const coworkersDir = await fixture();
  const created = await createLocalResponsibility(coworkersDir, "scout", {
    name: "Weekly review",
    instructions: "Review open work.",
    schedule: { kind: "weekly", timezone: "UTC", daysOfWeek: [1], hour: 9, minute: 0 },
  }, Date.UTC(2026, 8, 1));
  const paused = await setLocalResponsibilityActive(coworkersDir, "scout", created.id, false);
  assert.equal(paused.state, "paused");
  const resumed = await setLocalResponsibilityActive(coworkersDir, "scout", created.id, true);
  assert.equal(resumed.state, "active");
  await deleteLocalResponsibility(coworkersDir, "scout", created.id);
  assert.deepEqual(await listLocalResponsibilities(coworkersDir, "scout"), []);
});
