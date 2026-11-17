import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createClientFailureOutbox } from "./client-failure-outbox.mjs";
import { openworkTelemetryDisabled } from "./sentry.mjs";

const context = { enabled: true, principalId: "member", organizationId: "organization", denBaseUrl: "https://den.example.test", token: "session-token" };
const failure = { component: "engine", phase: "start", reason: "unknown" };
async function fixture(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "client-failure-test-"));
  let now = Date.now();
  const options = { directory: path.join(directory, "outbox"), appVersion: "1.2.3", platform: "linux", arch: "x64", now: () => now };
  try { await run({ options, advance: (ms) => { now += ms; } }); } finally { await rm(directory, { recursive: true, force: true }); }
}
test("the shared telemetry opt-out parser honors all managed-install spellings", () => {
  const previous = process.env.OPENWORK_DESKTOP_SENTRY_DISABLED;
  try {
    for (const value of ["1", "true", "yes", "on", " ON "]) {
      process.env.OPENWORK_DESKTOP_SENTRY_DISABLED = value;
      assert.equal(openworkTelemetryDisabled(), true);
    }
    process.env.OPENWORK_DESKTOP_SENTRY_DISABLED = "false";
    assert.equal(openworkTelemetryDisabled(), false);
  } finally {
    if (previous === undefined) delete process.env.OPENWORK_DESKTOP_SENTRY_DISABLED;
    else process.env.OPENWORK_DESKTOP_SENTRY_DISABLED = previous;
  }
});
test("flag off does not create a store, record or send", () => fixture(async ({ options }) => {
  const box = createClientFailureOutbox(options);
  await box.configure({ ...context, enabled: false });
  await box.record(failure);
  assert.deepEqual(await box.batch(), []);
  await assert.rejects(stat(options.directory), { code: "ENOENT" });
}));
test("consecutive folding, bounded size and persistence across reload", () => fixture(async ({ options, advance }) => {
  const box = createClientFailureOutbox(options);
  await box.configure(context);
  await box.record(failure);
  await box.record(failure);
  let disk = JSON.parse(await readFile(path.join(options.directory, "outbox.json"), "utf8"));
  assert.equal(disk.reports[0].count, 2);
  for (let index = 0; index < 201; index += 1) { advance(61_000); await box.record(failure); }
  disk = JSON.parse(await readFile(path.join(options.directory, "outbox.json"), "utf8"));
  assert.equal(disk.reports.length, 200);
  const reload = createClientFailureOutbox(options);
  await reload.configure(context);
  assert.equal((await reload.batch()).length, 50);
}));
test("delivery removes only acknowledged reports, freezes in-flight folding", () => fixture(async ({ options }) => {
  const box = createClientFailureOutbox(options);
  await box.configure(context);
  await box.record(failure);
  const batch = await box.batch();
  await box.record(failure);
  await box.settle(batch.map((report) => report.reportId), true);
  const next = await box.batch();
  assert.equal(next.length, 1);
  assert.notEqual(next[0].reportId, batch[0].reportId);
}));
test("an uncertain delivery stays immutable across restart so new failures are not lost to idempotence", () => fixture(async ({ options, advance }) => {
  const box = createClientFailureOutbox(options);
  await box.configure(context);
  await box.record(failure);
  const sent = await box.batch();
  const reload = createClientFailureOutbox(options);
  await reload.configure(context);
  await reload.record(failure);
  assert.deepEqual(await reload.batch(), []);
  advance(30_000);
  const next = await reload.batch();
  assert.equal(next.length, 2);
  assert.deepEqual(next[0], sent[0]);
  assert.notEqual(next[1].reportId, sent[0].reportId);
}));
test("failure is retained with backoff; a lost renderer lease is retried", () => fixture(async ({ options, advance }) => {
  const box = createClientFailureOutbox(options);
  await box.configure(context);
  await box.record(failure);
  const first = await box.batch();
  await box.settle(first.map((report) => report.reportId), false);
  assert.deepEqual(await box.batch(), []);
  advance(30_000);
  assert.deepEqual(await box.batch(), first);
  assert.deepEqual(await box.batch(), []);
  advance(30_000);
  assert.deepEqual(await box.batch(), first);
}));
test("expiry drops undelivered reports and account switching cannot misattribute", () => fixture(async ({ options, advance }) => {
  const box = createClientFailureOutbox(options);
  await box.configure(context);
  await box.record(failure);
  await box.configure({ ...context, principalId: "another-member" });
  assert.deepEqual(await box.batch(), []);
  await box.configure(context);
  advance(15 * 86_400_000);
  assert.deepEqual(await box.batch(), []);
}));
test("cached resolved policy records startup and offline transport after restart without leaking credentials", () => fixture(async ({ options }) => {
  const box = createClientFailureOutbox(options);
  await box.configure(context);
  const reload = createClientFailureOutbox(options);
  await reload.record(failure);
  const target = { token: context.token, organizationId: context.organizationId, baseUrl: context.denBaseUrl };
  await reload.record({ component: "den_transport", phase: "request", reason: "dns" }, target);
  await reload.record({ component: "den_transport", phase: "request", reason: "certificate" }, { ...target, token: "different-session" });
  const batch = await reload.batch();
  assert.deepEqual(batch.map((report) => report.component), ["engine", "den_transport"]);
  const disk = await readFile(path.join(options.directory, "outbox.json"), "utf8");
  assert.equal(disk.includes(context.token), false);
  assert.equal(disk.includes(context.denBaseUrl), false);
}));
test("resolved flag off erases cached authorization and the opt-out switch overrides it", () => fixture(async ({ options }) => {
  const box = createClientFailureOutbox(options);
  await box.configure(context);
  const disabled = createClientFailureOutbox({ ...options, disabled: true });
  await disabled.configure(context);
  await disabled.record(failure);
  assert.deepEqual(await disabled.batch(), []);
  await box.configure({ enabled: false });
  await assert.rejects(stat(path.join(options.directory, "outbox.json")), { code: "ENOENT" });
  const reload = createClientFailureOutbox(options);
  await reload.record(failure);
  assert.deepEqual(await reload.batch(), []);
}));
test("storage and delivery failures never throw", () => fixture(async ({ options }) => {
  await writeFile(options.directory, "not a directory");
  const box = createClientFailureOutbox({ ...options, directory: path.join(options.directory, "queue") });
  await box.configure(context);
  await box.record(failure);
  const batch = await box.batch();
  await box.settle(batch.map((report) => report.reportId), false);
}));
