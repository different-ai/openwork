import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import { ADVISORY_TIMEOUT_MS, runAdvisory } from "../../../scripts/run-advisory-design-review.mjs";

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test("advisory has a two-minute cap, errors remain advisory, and normal completion is retained", async () => {
  expect(ADVISORY_TIMEOUT_MS).toBe(120_000);
  expect(await runAdvisory(process.execPath, ["-e", "process.exit(0)"], { timeoutMs: 2_000 })).toMatchObject({ status: "complete" });
  expect(await runAdvisory(process.execPath, ["-e", "process.exit(7)"], { timeoutMs: 2_000 })).toMatchObject({ status: "error", code: 7 });
  expect(await runAdvisory("/nonexistent-advisory-command", [], { timeoutMs: 2_000 })).toMatchObject({ status: "error" });
});

test("a stuck worker and TERM-resistant subprocess are killed without losing completed notes or mandatory failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "advisory-cap-"));
  const proof = JSON.stringify({ outcome: "failed", judgments: [{ passed: false, reason: "mandatory screenshot assertion" }] });
  await writeFile(join(directory, "test-run.json"), proof);
  const worker = `
    import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    process.on('SIGTERM', () => {});
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'inherit' });
    writeFileSync('pids.json', JSON.stringify([process.pid, child.pid]));
    writeFileSync('design-review.json', JSON.stringify({ notes: { 'first.png': [{ rule: 'OW-LIST-HEADER' }] } }));
    setInterval(() => {}, 1000);
  `;
  await writeFile(join(directory, "worker.mjs"), worker);
  try {
    const start = performance.now();
    expect(await runAdvisory(process.execPath, ["worker.mjs"], { cwd: directory, timeoutMs: 1_000 })).toEqual({ status: "timeout" });
    expect(performance.now() - start).toBeLessThan(3_000);
    const pids: number[] = JSON.parse(await readFile(join(directory, "pids.json"), "utf8"));
    // Give the OS a moment to reap killed processes.
    for (let attempt = 0; attempt < 40 && pids.some(alive); attempt++) await delay(50);
    expect(pids.map(alive)).toEqual([false, false]);
    expect(JSON.parse(await readFile(join(directory, "design-review.json"), "utf8")).notes["first.png"]).toHaveLength(1);
    expect(await readFile(join(directory, "test-run.json"), "utf8")).toBe(proof);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a worker that exits early cannot leave a model subprocess running", async () => {
  const directory = await mkdtemp(join(tmpdir(), "advisory-orphan-"));
  await writeFile(join(directory, "worker.mjs"), `
    import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
    writeFileSync('pid', String(child.pid));
    process.exit(0);
  `);
  try {
    expect(await runAdvisory(process.execPath, ["worker.mjs"], { cwd: directory, timeoutMs: 2_000 })).toMatchObject({ status: "complete" });
    const pid = Number(await readFile(join(directory, "pid"), "utf8"));
    for (let attempt = 0; attempt < 40 && alive(pid); attempt++) await delay(50);
    expect(alive(pid)).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
