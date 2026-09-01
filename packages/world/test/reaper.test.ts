import assert from "node:assert/strict";
import { once } from "node:events";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { readLedger, rewriteLedger, type LedgerEntry } from "../src/ledger.ts";
import { reapLedger, type ExecFn } from "../src/reaper.ts";

function resource(kind: string, id: string, options: { match?: string; retain?: boolean } = {}): LedgerEntry {
  return { kind, id, ...options, at: "2026-01-01T00:00:00.000Z" };
}

function present(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("docker reaping uses force/volumes and recognizes missing containers", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-world-reaper-docker-"));
  try {
    const path = join(root, "world.ledger.jsonl");
    const calls: Array<{ command: string; args: string[]; timeoutMs: number }> = [];
    const exec: ExecFn = async (command, args, timeoutMs) => {
      calls.push({ command, args, timeoutMs });
      return { code: 0, stdout: "", stderr: "" };
    };
    await rewriteLedger(path, [resource("docker", "container-id")]);
    const reaped = await reapLedger(path, { cwd: root, exec });
    assert.deepEqual(reaped.reaped, [resource("docker", "container-id")]);
    assert.deepEqual(calls, [{
      command: "docker",
      args: ["rm", "--force", "--volumes", "container-id"],
      timeoutMs: 20_000,
    }]);
    assert.equal(await present(path), false);

    await rewriteLedger(path, [resource("docker", "gone")]);
    const missing = await reapLedger(path, {
      cwd: root,
      exec: async () => ({ code: 1, stdout: "", stderr: "Error: No such container: gone\n" }),
    });
    assert.deepEqual(missing.missing, [resource("docker", "gone")]);
    assert.equal(await present(path), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("docker-volume reaping uses volume rm and recognizes missing volumes", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-world-reaper-volume-"));
  try {
    const path = join(root, "world.ledger.jsonl");
    const calls: string[][] = [];
    await rewriteLedger(path, [resource("docker-volume", "volume-id")]);
    const report = await reapLedger(path, {
      cwd: root,
      exec: async (_command, args) => {
        calls.push(args);
        return { code: 1, stdout: "", stderr: "No such volume: volume-id" };
      },
    });
    assert.deepEqual(calls, [["volume", "rm", "--force", "volume-id"]]);
    assert.deepEqual(report.missing, [resource("docker-volume", "volume-id")]);
    assert.equal(await present(path), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unknown resources are skipped and remain retryable", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-world-reaper-unknown-"));
  try {
    const path = join(root, "world.ledger.jsonl");
    const entry = resource("unknown", "thing");
    await rewriteLedger(path, [entry]);
    const report = await reapLedger(path, { cwd: root });
    assert.deepEqual(report.skipped, [{ entry, reason: "no reaper for kind" }]);
    assert.deepEqual(await readLedger(path), [entry]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("process reaping refuses a live pid without an identity marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-world-reaper-process-marker-"));
  try {
    const path = join(root, "world.ledger.jsonl");
    const entry = resource("process", String(process.pid));
    await rewriteLedger(path, [entry]);
    const report = await reapLedger(path, { cwd: root });
    assert.deepEqual(report.skipped, [{ entry, reason: "no identity marker" }]);
    assert.equal(alive(process.pid), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("process reaping leaves a mismatched real child alive", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-world-reaper-process-mismatch-"));
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  try {
    await once(child, "spawn");
    if (child.pid === undefined) throw new Error("child pid unavailable");
    const path = join(root, "world.ledger.jsonl");
    const entry = resource("process", String(child.pid), { match: "marker-not-in-command" });
    await rewriteLedger(path, [entry]);
    const report = await reapLedger(path, { cwd: root });
    assert.deepEqual(report.skipped, [{ entry, reason: "identity mismatch" }]);
    assert.equal(alive(child.pid), true);
  } finally {
    if (child.pid !== undefined && alive(child.pid)) process.kill(child.pid, "SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

test("process reaping terminates a real child with a matching command", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-world-reaper-process-match-"));
  const marker = "openwork_reaper_identity_marker";
  const child = spawn(process.execPath, ["-e", `setInterval(() => {}, 1000); // ${marker}`]);
  try {
    await once(child, "spawn");
    if (child.pid === undefined) throw new Error("child pid unavailable");
    const path = join(root, "world.ledger.jsonl");
    const entry = resource("process", String(child.pid), { match: marker });
    await rewriteLedger(path, [entry]);
    const report = await reapLedger(path, { cwd: root });
    assert.deepEqual(report.reaped, [entry]);
    assert.equal(alive(child.pid), false);
    assert.equal(await present(path), false);
  } finally {
    if (child.pid !== undefined && alive(child.pid)) process.kill(child.pid, "SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

test("tmpdir reaping refuses paths outside configured roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-world-reaper-outside-"));
  try {
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "kept"), "kept", "utf8");
    const path = join(root, "world.ledger.jsonl");
    const entry = resource("tmpdir", outside);
    await rewriteLedger(path, [entry]);
    const report = await reapLedger(path, {
      cwd: root,
      allowedTmpRoots: [join(root, "allowed")],
    });
    assert.deepEqual(report.skipped, [{ entry, reason: "outside allowed roots" }]);
    assert.equal(await present(join(outside, "kept")), true);
    assert.deepEqual(await readLedger(path), [entry]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tmpdir reaping removes paths below the OS temp directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-world-reaper-tmpdir-"));
  const ledgerRoot = await mkdtemp(join(tmpdir(), "openwork-world-reaper-ledger-"));
  try {
    await writeFile(join(root, "removed"), "removed", "utf8");
    const path = join(ledgerRoot, "world.ledger.jsonl");
    const entry = resource("tmpdir", root);
    await rewriteLedger(path, [entry]);
    const report = await reapLedger(path, { cwd: ledgerRoot });
    assert.deepEqual(report.reaped, [entry]);
    assert.equal(await present(root), false);
    assert.equal(await present(path), false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(ledgerRoot, { recursive: true, force: true });
  }
});

test("retained resources stay by default and are removed by purge", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-world-reaper-retain-"));
  const ledgerRoot = await mkdtemp(join(tmpdir(), "openwork-world-reaper-retain-ledger-"));
  try {
    const path = join(ledgerRoot, "world.ledger.jsonl");
    const entry = resource("tmpdir", root, { retain: true });
    await rewriteLedger(path, [entry]);
    const retained = await reapLedger(path, { cwd: ledgerRoot });
    assert.deepEqual(retained.retained, [entry]);
    assert.equal(await present(root), true);
    assert.deepEqual(await readLedger(path), [entry]);

    const purged = await reapLedger(path, { cwd: ledgerRoot, purge: true });
    assert.deepEqual(purged.reaped, [entry]);
    assert.equal(await present(root), false);
    assert.equal(await present(path), false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(ledgerRoot, { recursive: true, force: true });
  }
});
