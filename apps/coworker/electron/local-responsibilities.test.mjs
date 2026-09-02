import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createCoworker } from "./coworkers.mjs";
import {
  INTERRUPTED_RUN_MESSAGE,
  RUN_HISTORY_LIMIT,
  attachLocalResponsibilityThread,
  beginLocalResponsibilityRun,
  cancelQueuedLocalRun,
  createLocalResponsibility,
  deleteLocalResponsibility,
  finishLocalResponsibilityRun,
  listLocalResponsibilities,
  queueLocalResponsibilityRun,
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

test("queued runs wait their turn, advance the schedule once, and can be cancelled", async () => {
  const coworkersDir = await fixture();
  const now = Date.UTC(2026, 8, 1, 15, 0);
  const created = await createLocalResponsibility(coworkersDir, "scout", {
    name: "Inbox sweep",
    instructions: "Sweep the inbox.",
    schedule: { kind: "daily", timezone: "UTC", hour: 16, minute: 0 },
  }, now);
  const queued = await queueLocalResponsibilityRun(coworkersDir, "scout", created.id, {
    trigger: "scheduled",
    now: Date.UTC(2026, 8, 1, 16, 0),
  });
  assert.equal(queued.latestRun.status, "queued");
  assert.equal(queued.latestRun.queuedAt, Date.UTC(2026, 8, 1, 16, 0));
  assert.equal(queued.nextDueAt, Date.UTC(2026, 8, 2, 16, 0), "queuing counts the occurrence");

  const started = await beginLocalResponsibilityRun(coworkersDir, "scout", created.id, {
    runId: queued.latestRun.id,
    now: Date.UTC(2026, 8, 1, 16, 4),
  });
  assert.equal(started.latestRun.id, queued.latestRun.id, "the queued run itself starts");
  assert.equal(started.latestRun.status, "running");
  assert.equal(started.latestRun.trigger, "scheduled");
  assert.equal(started.latestRun.startedAt, Date.UTC(2026, 8, 1, 16, 4));
  assert.equal(started.nextDueAt, Date.UTC(2026, 8, 2, 16, 0), "starting a queued run does not advance again");
  assert.equal(started.runs.length, 1);

  const second = await queueLocalResponsibilityRun(coworkersDir, "scout", created.id, { now: Date.UTC(2026, 8, 1, 16, 5) });
  assert.equal(second.runs.length, 2);
  assert.equal(second.latestRun.status, "queued");
  const cancelled = await cancelQueuedLocalRun(coworkersDir, "scout", created.id, second.latestRun.id, Date.UTC(2026, 8, 1, 16, 6));
  assert.equal(cancelled.runs.length, 1);
  assert.equal(cancelled.latestRun.status, "running", "cancelling a queued run never touches the running one");
  const untouched = await cancelQueuedLocalRun(coworkersDir, "scout", created.id, cancelled.latestRun.id);
  assert.equal(untouched.latestRun.status, "running");
});

test("finished runs keep a bounded history with the coworker's summary and can be resumed in their thread", async () => {
  const coworkersDir = await fixture();
  const now = Date.UTC(2026, 8, 1, 15, 0);
  const created = await createLocalResponsibility(coworkersDir, "scout", {
    name: "Weekly digest",
    instructions: "Write the digest.",
    schedule: { kind: "weekly", timezone: "UTC", daysOfWeek: [1], hour: 9, minute: 0 },
  }, now);
  for (let index = 0; index < RUN_HISTORY_LIMIT + 3; index += 1) {
    const at = now + index * 60_000;
    const started = await beginLocalResponsibilityRun(coworkersDir, "scout", created.id, { now: at });
    await attachLocalResponsibilityThread(coworkersDir, "scout", created.id, started.latestRun.id, `ses_${index}`);
    await finishLocalResponsibilityRun(coworkersDir, "scout", created.id, started.latestRun.id, {
      status: index % 5 === 4 ? "failed" : "succeeded",
      error: index % 5 === 4 ? "Model unavailable" : "",
      summary: `Digest ${index} is ready.`,
      now: at + 30_000,
    });
  }
  const [record] = await listLocalResponsibilities(coworkersDir, "scout");
  assert.equal(record.runs.length, RUN_HISTORY_LIMIT, "history is bounded");
  assert.equal(record.latestRun.id, record.runs[0].id);
  assert.equal(record.runs[0].summary, `Digest ${RUN_HISTORY_LIMIT + 2} is ready.`);
  assert.equal(record.runs[0].threadId, `ses_${RUN_HISTORY_LIMIT + 2}`);
  assert.ok(record.runs.every((run, index) => index === 0 || run.startedAt <= record.runs[index - 1].startedAt), "newest first");
  assert.ok(record.runs.some((run) => run.status === "failed" && run.error === "Model unavailable"));
  assert.equal(record.nextDueAt, created.nextDueAt, "manual runs never move the schedule");

  const resumed = await beginLocalResponsibilityRun(coworkersDir, "scout", created.id, {
    trigger: "resume",
    threadId: record.latestRun.threadId,
    now: now + 60 * 60_000,
  });
  assert.equal(resumed.latestRun.trigger, "resume");
  assert.equal(resumed.latestRun.threadId, `ses_${RUN_HISTORY_LIMIT + 2}`, "a resumed run continues the same native thread");
  assert.equal(resumed.nextDueAt, created.nextDueAt);
});

test("older records without a history still load with latestRun as their only run", async () => {
  const coworkersDir = await fixture();
  const created = await createLocalResponsibility(coworkersDir, "scout", {
    name: "Legacy",
    instructions: "Legacy record.",
    schedule: { kind: "daily", timezone: "UTC", hour: 8, minute: 0 },
  });
  const { writeFile, readFile } = await import("node:fs/promises");
  const { resolveCoworkerFile } = await import("./coworkers.mjs");
  const file = resolveCoworkerFile(coworkersDir, "scout", "local-responsibilities.json");
  const stored = JSON.parse(await readFile(file, "utf8"));
  const legacy = { ...stored.items[0], latestRun: { id: "run_legacy", status: "succeeded", trigger: "manual", startedAt: 5, finishedAt: 9, threadId: "ses_legacy", error: "" } };
  delete legacy.runs;
  await writeFile(file, JSON.stringify({ version: 1, items: [legacy] }), "utf8");
  const [record] = await listLocalResponsibilities(coworkersDir, "scout");
  assert.equal(record.id, created.id);
  assert.deepEqual(record.runs.map((run) => run.id), ["run_legacy"]);
  assert.equal(record.latestRun.summary, "");
  assert.equal(record.latestRun.queuedAt, null);
});

test("concurrent changes to one coworker's store never lose each other", async () => {
  const coworkersDir = await fixture();
  const now = Date.UTC(2026, 8, 1, 15, 0);
  const [first, second] = await Promise.all([
    createLocalResponsibility(coworkersDir, "scout", {
      name: "First",
      instructions: "First.",
      schedule: { kind: "daily", timezone: "UTC", hour: 9, minute: 0 },
    }, now),
    createLocalResponsibility(coworkersDir, "scout", {
      name: "Second",
      instructions: "Second.",
      schedule: { kind: "daily", timezone: "UTC", hour: 9, minute: 0 },
    }, now),
  ]);
  // A run starting while another is queued, plus a third being created, all at once.
  const [started, queued, third] = await Promise.all([
    beginLocalResponsibilityRun(coworkersDir, "scout", first.id, { now: now + 1_000 }),
    queueLocalResponsibilityRun(coworkersDir, "scout", second.id, { now: now + 1_000 }),
    createLocalResponsibility(coworkersDir, "scout", {
      name: "Third",
      instructions: "Third.",
      schedule: { kind: "daily", timezone: "UTC", hour: 9, minute: 0 },
    }, now + 1_000),
  ]);
  assert.equal(started.latestRun.status, "running");
  assert.equal(queued.latestRun.status, "queued");
  await Promise.all([
    finishLocalResponsibilityRun(coworkersDir, "scout", first.id, started.latestRun.id, { status: "succeeded", summary: "Done.", now: now + 5_000 }),
    beginLocalResponsibilityRun(coworkersDir, "scout", second.id, { runId: queued.latestRun.id, now: now + 5_000 }),
  ]);
  const items = await listLocalResponsibilities(coworkersDir, "scout");
  assert.deepEqual(items.map((item) => item.name).sort(), ["First", "Second", "Third"]);
  assert.equal(items.find((item) => item.id === first.id).latestRun.status, "succeeded");
  assert.equal(items.find((item) => item.id === first.id).latestRun.summary, "Done.");
  assert.equal(items.find((item) => item.id === second.id).latestRun.status, "running");
  assert.equal(items.find((item) => item.id === second.id).latestRun.id, queued.latestRun.id);
  assert.equal(items.find((item) => item.id === third.id).runs.length, 0);
});
