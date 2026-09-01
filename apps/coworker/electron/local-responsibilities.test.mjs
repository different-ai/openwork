import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createCoworker } from "./coworkers.mjs";
import {
  INTERRUPTED_RUN_MESSAGE,
  beginLocalResponsibilityRun,
  createLocalResponsibility,
  deleteLocalResponsibility,
  finishLocalResponsibilityRun,
  listLocalResponsibilities,
  reconcileInterruptedLocalRuns,
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

test("interrupted runs are reconciled once, without replaying the advanced schedule", async () => {
  const coworkersDir = await fixture();
  const created = await createLocalResponsibility(coworkersDir, "scout", {
    name: "Daily brief",
    instructions: "Prepare a brief.",
    schedule: { kind: "daily", timezone: "UTC", hour: 16, minute: 30 },
  }, Date.UTC(2026, 8, 1, 15, 0));
  const other = await createLocalResponsibility(coworkersDir, "scout", {
    name: "Still running here",
    instructions: "Keep going.",
    schedule: { kind: "daily", timezone: "UTC", hour: 18, minute: 0 },
  }, Date.UTC(2026, 8, 1, 15, 0));
  const started = await beginLocalResponsibilityRun(coworkersDir, "scout", created.id, {
    trigger: "scheduled",
    now: Date.UTC(2026, 8, 1, 16, 30),
  });
  const live = await beginLocalResponsibilityRun(coworkersDir, "scout", other.id, {
    trigger: "manual",
    now: Date.UTC(2026, 8, 1, 16, 31),
  });

  const reconciled = await reconcileInterruptedLocalRuns(coworkersDir, "scout", {
    activeRunIds: new Set([other.id]),
    now: Date.UTC(2026, 8, 1, 17, 0),
  });
  const interrupted = reconciled.find((item) => item.id === created.id);
  assert.equal(interrupted.latestRun.status, "failed");
  assert.equal(interrupted.latestRun.error, INTERRUPTED_RUN_MESSAGE);
  assert.equal(interrupted.latestRun.finishedAt, Date.UTC(2026, 8, 1, 17, 0));
  assert.equal(interrupted.nextDueAt, started.nextDueAt, "reconciliation must not touch the advanced schedule");
  const untouched = reconciled.find((item) => item.id === other.id);
  assert.equal(untouched.latestRun.status, "running");
  assert.equal(untouched.latestRun.id, live.latestRun.id);

  const persisted = await listLocalResponsibilities(coworkersDir, "scout");
  assert.deepEqual(persisted, reconciled);
  const again = await reconcileInterruptedLocalRuns(coworkersDir, "scout", {
    activeRunIds: new Set([other.id]),
    now: Date.UTC(2026, 8, 1, 17, 5),
  });
  assert.deepEqual(again, reconciled, "a second pass is a no-op");
});
