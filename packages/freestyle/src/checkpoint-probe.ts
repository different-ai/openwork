import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { Freestyle, Vm } from "freestyle";
import { execChecked } from "./index.ts";

const root = "/opt/openwork-checkpoint-probe";
const partial = "one\ntwo\nthree\n";
const complete = `${partial}four\nfive\nsix\n`;
const kind = "openwork-checkpoint-probe-v1";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseProbeState(value: unknown) {
  if (!record(value) || !record(value.producer) || !record(value.consumer)) throw new Error("Invalid checkpoint probe state");
  const { producer, consumer } = value;
  if (typeof producer.bootId !== "string" || !producer.bootId || typeof consumer.bootId !== "string" || !consumer.bootId
    || typeof producer.connections !== "number" || !Number.isInteger(producer.connections) || !Array.isArray(producer.sessions)
    || !producer.sessions.every((session: unknown) => typeof session === "string")
    || typeof consumer.text !== "string" || typeof consumer.completed !== "boolean" || typeof consumer.failed !== "boolean"
    || typeof value.disk !== "string") throw new Error("Invalid checkpoint probe fields");
  return { producer: { bootId: producer.bootId, connections: producer.connections, sessions: producer.sessions },
    consumer: { bootId: consumer.bootId, text: consumer.text, completed: consumer.completed, failed: consumer.failed }, disk: value.disk };
}

export function assertHeldState(state: ReturnType<typeof parseProbeState>) {
  assert.deepEqual(state.producer.sessions, Array.from({ length: 10 }, (_, i) => `Session ${i + 1}`));
  assert.equal(state.producer.connections, 1, "The stream must not reconnect");
  assert.equal(state.consumer.text, partial);
  assert.equal(state.consumer.completed, false);
  assert.equal(state.consumer.failed, false);
  assert.equal(state.disk, "original");
}

export function assertContinuedState(before: ReturnType<typeof parseProbeState>, after: ReturnType<typeof parseProbeState>) {
  assert.equal(after.producer.bootId, before.producer.bootId, "Producer restarted instead of restoring RAM");
  assert.equal(after.consumer.bootId, before.consumer.bootId, "Consumer restarted instead of restoring RAM");
  assert.deepEqual(after.producer.sessions, before.producer.sessions);
  assert.equal(after.producer.connections, 1, "The stream reconnected instead of continuing");
  assert.equal(after.consumer.text, complete);
  assert.equal(after.consumer.completed, true);
  assert.equal(after.consumer.failed, false);
}

export interface ProbeReport {
  schemaVersion: 1;
  scope: "synthetic-vm-memory-and-loopback-stream";
  sourceSha: string;
  status: "incomplete" | "passed" | "failed";
  stage: string;
  snapshotReadyMs?: number;
  forkReadyMs: number[];
  checks: string[];
  cleanup: "pending" | "passed" | "failed";
}

async function inspect(vm: Vm) {
  return parseProbeState(JSON.parse(await execChecked(vm, `node ${root}/fixture.mjs inspect`, 15_000)));
}

async function waitForState(vm: Vm, ready: (state: ReturnType<typeof parseProbeState>) => boolean) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    // Guest transport/readiness can lag VM creation. A malformed observation is
    // never passed through as success; the eventual assertion remains required.
    try { const state = await inspect(vm); if (ready(state)) return state; } catch { /* bounded startup retry */ }
    await delay(500);
  }
  throw new Error("Checkpoint fixture state did not become ready");
}

/** Live prerequisite only. This does NOT prove Chromium, OpenWork, or review UI. */
export async function runCheckpointProbe(api: Freestyle, report: ProbeReport) {
  if (!/^[a-f0-9]{40}$/.test(report.sourceSha)) throw new Error("A full source SHA is required");
  const run = randomUUID().replaceAll("-", "");
  const owned: Vm[] = [];
  let snapshotId: string | undefined;
  try {
    report.stage = "create-source";
    // A fresh public base avoids snapshots that contact production Den or hold
    // real inference credentials. Controller credentials never enter the guest.
    const { vm: source } = await api.vms.create({
      snapshotId: "freestyle/ubuntu", slug: `ow-checkpoint-probe-${run}`,
      ttlSeconds: 900, metadata: { kind, sourceSha: report.sourceSha },
      firewall: { rules: [] },
    });
    owned.push(source);
    report.stage = "start-fixture";
    await execChecked(source, `mkdir -p ${root} && node --version`);
    await source.fs.writeTextFile(`${root}/fixture.mjs`, await readFile(new URL("../test/fixtures/checkpoint-stream.mjs", import.meta.url), "utf8"));
    await source.fs.writeTextFile(`${root}/disk.txt`, "original");
    await execChecked(source, `systemd-run --unit=ow-checkpoint-producer --property=Restart=no -- $(command -v node) ${root}/fixture.mjs producer`);
    await execChecked(source, `node ${root}/fixture.mjs ready`, 20_000);
    await execChecked(source, `systemd-run --unit=ow-checkpoint-consumer --property=Restart=no -- $(command -v node) ${root}/fixture.mjs consumer`);
    const before = await waitForState(source, (state) => state.consumer.text === partial);
    assertHeldState(before);
    report.checks.push("source holds ten synthetic sessions and one partial loopback stream");
    report.stage = "snapshot";
    const snapshotStart = performance.now();
    const captured = await source.snapshot({ slug: `ow-checkpoint-probe-${run}`, ttlSeconds: 1800, autoDeleteSeconds: 1800 });
    snapshotId = captured.snapshotId;
    report.snapshotReadyMs = Math.round(performance.now() - snapshotStart);
    assert.equal(captured.snapshot.public, false);
    report.checks.push("checkpoint is private");
    // Delete the source BEFORE forking: a successful clone must not rely on it.
    report.stage = "delete-source";
    await source.delete();
    owned.splice(owned.indexOf(source), 1);
    report.checks.push("source deleted before restore");
    for (let index = 0; index < 2; index++) {
      report.stage = `fork-${index + 1}`;
      const start = performance.now();
      const { vm: fork } = await api.vms.create({
        snapshotId, slug: `ow-checkpoint-fork-${run}-${index}`, ttlSeconds: 900,
        metadata: { kind, sourceSha: report.sourceSha }, firewall: { rules: [] },
      });
      owned.push(fork);
      const restored = await waitForState(fork, (state) => state.consumer.text === partial);
      report.forkReadyMs.push(Math.round(performance.now() - start));
      assert.deepEqual(restored, before, "Fork did not restore the captured memory and disk");
      if (index === 0) {
        await execChecked(fork, `node ${root}/fixture.mjs mutate`);
        assert.equal((await inspect(fork)).disk, "fork-only");
      }
      await execChecked(fork, `node ${root}/fixture.mjs continue`);
      const continued = await waitForState(fork, (state) => state.consumer.completed);
      assertContinuedState(before, continued);
      assert.equal(continued.disk, index === 0 ? "fork-only" : "original");
      report.checks.push(`fork ${index + 1} restores RAM, disk and the original TCP stream without reconnecting`);
    }
    assert.equal((await inspect(owned[0])).disk, "fork-only");
    report.checks.push("forks are independent of each other and the deleted source");
    report.stage = "verified";
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    throw error;
  } finally {
    const cleanup = await Promise.allSettled([
      ...owned.map((vm) => vm.delete()),
      ...(snapshotId ? [api.vms.snapshots.delete(snapshotId)] : []),
    ]);
    report.cleanup = cleanup.every((result) => result.status === "fulfilled") ? "passed" : "failed";
    if (report.cleanup === "failed") {
      report.status = "failed";
      throw new Error("Checkpoint probe cleanup failed; provider TTL bounds remaining resources");
    }
  }
}
