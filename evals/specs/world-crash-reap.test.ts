import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { eventually, test } from "@openwork/testkit";
import {
  isProcessAlive,
  main,
  readLedger,
  readScriptWorldSnapshot,
  rewriteLedger,
  type WorldCliOptions,
} from "@openwork/world";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

async function stopPid(pid: number, label: string): Promise<void> {
  if (!isProcessAlive(pid)) return;
  try { process.kill(pid, "SIGKILL"); } catch {}
  await eventually(() => !isProcessAlive(pid), {
    within: 5_000,
    intervalMs: 25,
    label,
  });
}

test("a crashed world is reaped and recreated without leaking or duplicating resources", async ({ evidence }) => {
  const root = await mkdtemp(join(tmpdir(), "openwork-world-crash-reap-"));
  const worldsDirectory = join(root, "worlds");
  const scriptsDirectory = join(root, ".worlds", "scripts");
  const fixtureName = "reap-world";
  const stage = "crash";
  const stagedName = `${fixtureName}--${stage}`;
  const fixturePath = join(worldsDirectory, `${fixtureName}.ts`);
  const snapshotPath = join(scriptsDirectory, `${stagedName}.json`);
  const ledgerPath = join(scriptsDirectory, `${stagedName}.ledger.jsonl`);
  const recipeUrl = pathToFileURL(join(REPO_ROOT, "evals", "packages", "env", "src", "recipe.ts")).href;
  const previousSnapshotDirectory = process.env.OPENWORK_WORLD_SNAPSHOT_DIR;
  const previousStubCrash = process.env.OPENWORK_WORLD_STUB_CRASH;
  const launchedPids = new Set<number>();
  const sleeperPids = new Set<number>();
  let unrelatedPid: number | undefined;
  let printedLines: string[] = [];

  const options: WorldCliOptions = {
    cwd: root,
    worldsDirectory,
    print(line) {
      printedLines.push(line);
    },
  };
  const run = async (argv: string[]): Promise<{ code: number; lines: string[] }> => {
    printedLines = [];
    const code = await main(argv, options);
    return { code, lines: [...printedLines] };
  };
  const up = (): Promise<{ code: number; lines: string[] }> => run([
    "up", fixturePath, "--detach", "--stage", stage, "--timeout", "10000",
  ]);
  const retainedLine = (count: number): string =>
    `Retained ${count} resources for "${stagedName}"; run pnpm world down ${fixtureName} --stage ${stage} --purge to remove them.`;

  try {
    process.env.OPENWORK_WORLD_SNAPSHOT_DIR = scriptsDirectory;
    delete process.env.OPENWORK_WORLD_STUB_CRASH;
    await mkdir(worldsDirectory);
    await writeFile(fixturePath, `
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recipe, runRecipe } from ${JSON.stringify(recipeUrl)};

const world = recipe(${JSON.stringify(fixtureName)}, async (tools) => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  if (child.pid === undefined) throw new Error("Expected sleeper child pid.");
  child.unref();
  await tools.track({ kind: "process", id: String(child.pid), label: "sleeper", match: "setInterval" });
  const dir = await mkdtemp(join(tmpdir(), "openwork-reap-"));
  await tools.track({ kind: "tmpdir", id: dir, label: "scratch" });
  const kept = await mkdtemp(join(tmpdir(), "openwork-reap-kept-"));
  await tools.track({ kind: "tmpdir", id: kept, label: "kept", retain: true });
  if (process.env.OPENWORK_WORLD_STUB_CRASH === "1") process.kill(process.pid, "SIGKILL");
  tools.stack.use({
    async [Symbol.asyncDispose](): Promise<void> {
      try { process.kill(child.pid, "SIGKILL"); } catch {}
      await rm(dir, { recursive: true, force: true });
    },
  });
  return { child: String(child.pid), dir, kept };
});

export default world;
if (import.meta.main) await runRecipe(world);
`, "utf8");

    const initialUp = await up();
    assert.equal(initialUp.code, 0, initialUp.lines.join("\n"));
    const initial = await readScriptWorldSnapshot(snapshotPath);
    assert.ok(initial);
    launchedPids.add(initial.pid);
    assert.equal(isProcessAlive(initial.pid), true, await readFile(join(scriptsDirectory, `${stagedName}.log`), "utf8"));
    const oldChildPid = Number(initial.outputs.child);
    sleeperPids.add(oldChildPid);
    const initialLedger = await readLedger(ledgerPath);
    assert.equal(initialLedger.length, 3);
    assert.deepEqual(initialLedger.map((entry) => entry.kind), ["process", "tmpdir", "tmpdir"]);
    assert.equal(initialLedger[0]?.match, "setInterval");
    assert.equal(initialLedger.find((entry) => entry.id === initial.outputs.kept)?.retain, true);
    assert.equal(isProcessAlive(oldChildPid), true);
    assert.equal(await exists(initial.outputs.dir), true);
    assert.equal(await exists(initial.outputs.kept), true);
    evidence.recordAssertionEvidence(
      "World startup records every reapable and retained resource",
      "Up succeeded with exactly one matched process, one temporary directory, and one retained temporary directory; all three resources were live or present.",
      true,
    );

    process.kill(initial.pid, "SIGKILL");
    await eventually(() => !isProcessAlive(initial.pid), {
      within: 5_000,
      intervalMs: 25,
      label: "crashed world exits",
    });
    assert.equal(isProcessAlive(oldChildPid), true);
    assert.equal(await exists(initial.outputs.dir), true);
    const orphanPlan = await run(["plan", fixturePath, "--stage", stage]);
    assert.equal(orphanPlan.code, 0, orphanPlan.lines.join("\n"));
    assert.deepEqual(orphanPlan.lines, [
      "- orphaned (stale receipt, will recreate)",
      `receipt  ${snapshotPath}`,
      `child  ${initial.outputs.child}`,
      `dir  ${initial.outputs.dir}`,
      `kept  ${initial.outputs.kept}`,
      "leaked  2 resources",
      "retained  1 resources",
    ]);
    assert.equal(isProcessAlive(oldChildPid), true);
    assert.equal((await readLedger(ledgerPath)).length, 3);
    evidence.recordAssertionEvidence(
      "Plan reports orphan leaks without reaping them",
      "After SIGKILL left the sleeper and scratch directory behind, plan printed the exact orphan, outputs, leaked, and retained lines while leaving the child and all three ledger entries untouched.",
      true,
    );

    const recreatedUp = await up();
    assert.equal(recreatedUp.code, 0, recreatedUp.lines.join("\n"));
    assert.equal(recreatedUp.lines[0], `Reaped 2 leaked resources from "${stagedName}".`);
    assert.equal(recreatedUp.lines[1], retainedLine(1));
    assert.equal(recreatedUp.lines[2], `Removed stale world receipt "${stagedName}" (pid ${initial.pid}); recreating.`);
    await eventually(() => !isProcessAlive(oldChildPid), {
      within: 5_000,
      intervalMs: 25,
      label: "old sleeper is reaped",
    });
    assert.equal(await exists(initial.outputs.dir), false);
    assert.equal(await exists(initial.outputs.kept), true);
    const recreated = await readScriptWorldSnapshot(snapshotPath);
    assert.ok(recreated);
    launchedPids.add(recreated.pid);
    const recreatedChildPid = Number(recreated.outputs.child);
    sleeperPids.add(recreatedChildPid);
    assert.notEqual(recreated.pid, initial.pid);
    assert.notEqual(recreated.outputs.child, initial.outputs.child);
    assert.equal(isProcessAlive(recreatedChildPid), true);
    const recreatedLedger = await readLedger(ledgerPath);
    assert.equal(recreatedLedger.length, 4);
    const recreatedProcesses = recreatedLedger.filter((entry) => entry.kind === "process");
    assert.equal(recreatedProcesses.length, 1);
    assert.equal(isProcessAlive(Number(recreatedProcesses[0]?.id)), true);
    evidence.recordAssertionEvidence(
      "Up reaps an orphan before recreating it",
      "Recreation printed reap, retain, and stale-receipt messages in order, removed only old non-retained resources, preserved the kept directory, and left exactly one new live sleeper.",
      true,
    );

    const gracefulDown = await run(["down", fixtureName, "--stage", stage]);
    assert.equal(gracefulDown.code, 0, gracefulDown.lines.join("\n"));
    assert.deepEqual(gracefulDown.lines, [
      `World "${stagedName}" torn down.`,
      retainedLine(2),
    ]);
    await eventually(async () =>
      !isProcessAlive(recreatedChildPid)
      && !await exists(snapshotPath)
      && !await exists(recreated.outputs.dir), {
      within: 10_000,
      intervalMs: 50,
      label: "graceful world disposal",
    });
    assert.equal(await exists(initial.outputs.kept), true);
    assert.equal(await exists(recreated.outputs.kept), true);
    const gracefulLedger = await readLedger(ledgerPath);
    assert.equal(gracefulLedger.length, 2);
    assert.equal(gracefulLedger.every((entry) => entry.kind === "tmpdir" && entry.retain === true), true);
    evidence.recordAssertionEvidence(
      "Graceful down disposes active resources but preserves retained entries",
      "Down printed teardown before the retained count, stopped the new sleeper, removed its receipt and scratch directory, and kept exactly the two retained directories in the ledger.",
      true,
    );

    const crashDownUp = await up();
    assert.equal(crashDownUp.code, 0, crashDownUp.lines.join("\n"));
    const crashDownSnapshot = await readScriptWorldSnapshot(snapshotPath);
    assert.ok(crashDownSnapshot);
    launchedPids.add(crashDownSnapshot.pid);
    const crashDownChildPid = Number(crashDownSnapshot.outputs.child);
    sleeperPids.add(crashDownChildPid);
    assert.equal(isProcessAlive(crashDownChildPid), true);
    process.kill(crashDownSnapshot.pid, "SIGKILL");
    await eventually(() => !isProcessAlive(crashDownSnapshot.pid), {
      within: 5_000,
      intervalMs: 25,
      label: "second crashed world exits",
    });
    const crashDown = await run(["down", fixtureName, "--stage", stage]);
    assert.equal(crashDown.code, 0, crashDown.lines.join("\n"));
    assert.equal(crashDown.lines[0], `World "${stagedName}" torn down.`);
    assert.equal(crashDown.lines[1], `Reaped 2 leaked resources from "${stagedName}".`);
    assert.equal(crashDown.lines[2], retainedLine(3));
    await eventually(() => !isProcessAlive(crashDownChildPid), {
      within: 5_000,
      intervalMs: 25,
      label: "crash-then-down sleeper is reaped",
    });
    assert.equal(await exists(crashDownSnapshot.outputs.dir), false);
    const keptDirectories = [initial.outputs.kept, recreated.outputs.kept, crashDownSnapshot.outputs.kept];
    assert.equal((await Promise.all(keptDirectories.map(exists))).every(Boolean), true);
    assert.equal(await exists(snapshotPath), false);
    const crashDownLedger = await readLedger(ledgerPath);
    assert.equal(crashDownLedger.length, 3);
    assert.equal(crashDownLedger.every((entry) => entry.kind === "tmpdir" && entry.retain === true), true);
    evidence.recordAssertionEvidence(
      "Down reaps resources from a crashed receipt",
      "Crash-then-down printed teardown, reaped two leaks, retained three directories, removed the receipt and latest scratch directory, and left only retained entries.",
      true,
    );

    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    if (unrelated.pid === undefined) throw new Error("Expected unrelated child pid.");
    unrelatedPid = unrelated.pid;
    unrelated.unref();
    await appendFile(ledgerPath, `${JSON.stringify({
      kind: "process",
      id: String(unrelatedPid),
      match: "definitely-not-this-marker",
      at: new Date().toISOString(),
    })}\n`, "utf8");
    const identityDown = await run(["down", fixtureName, "--stage", stage]);
    assert.equal(identityDown.code, 0, identityDown.lines.join("\n"));
    assert.equal(identityDown.lines.includes(`Skipped process ${unrelatedPid}: identity mismatch.`), true);
    assert.equal(identityDown.lines.at(-1), `World "${stagedName}" has no receipt; reaped its ledger.`);
    assert.equal(isProcessAlive(unrelatedPid), true);
    const guardedLedger = await readLedger(ledgerPath);
    assert.equal(guardedLedger.length, 4);
    assert.ok(guardedLedger.find((entry) => entry.kind === "process" && entry.id === String(unrelatedPid)));
    await rewriteLedger(ledgerPath, guardedLedger.filter((entry) => entry.id !== String(unrelatedPid)));
    await stopPid(unrelatedPid, "unrelated identity-guard child cleanup");
    unrelatedPid = undefined;
    evidence.recordAssertionEvidence(
      "Process identity mismatch skips an unrelated child",
      "Ledger-only down reported the exact identity-mismatch skip and completion line, left the unrelated process alive and retry entry present beside three retained entries, then the fixture removed both safely.",
      true,
    );

    const guardPath = `/openwork-reaper-guard-${Math.random().toString(16).slice(2)}-does-not-exist`;
    await appendFile(ledgerPath, `${JSON.stringify({
      kind: "tmpdir",
      id: guardPath,
      at: new Date().toISOString(),
    })}\n`, "utf8");
    const confinementDown = await run(["down", fixtureName, "--stage", stage, "--purge"]);
    assert.equal(confinementDown.code, 0, confinementDown.lines.join("\n"));
    assert.equal(confinementDown.lines.includes(`Skipped tmpdir ${guardPath}: outside allowed roots.`), true);
    assert.equal((await Promise.all(keptDirectories.map(exists))).every((present) => !present), true);
    const confinementLedger = await readLedger(ledgerPath);
    assert.deepEqual(confinementLedger.map((entry) => entry.id), [guardPath]);
    await rewriteLedger(ledgerPath, []);
    assert.equal(await exists(ledgerPath), false);
    evidence.recordAssertionEvidence(
      "Tmpdir confinement blocks paths outside OS temporary roots",
      "Purge removed all three retained temporary directories but printed the exact outside-roots skip and retained only that guard entry until explicit test cleanup deleted the ledger.",
      true,
    );

    process.env.OPENWORK_WORLD_STUB_CRASH = "1";
    const midBootCrash = await up();
    assert.equal(midBootCrash.code, 1, midBootCrash.lines.join("\n"));
    assert.equal(midBootCrash.lines.includes(`Script world "${stagedName}" exited before creating its snapshot.`), true);
    assert.equal(await exists(snapshotPath), false);
    const crashedBootLedger = await readLedger(ledgerPath);
    assert.equal(crashedBootLedger.length, 3);
    const crashedBootProcess = crashedBootLedger.find((entry) => entry.kind === "process");
    assert.ok(crashedBootProcess);
    const crashedBootChildPid = Number(crashedBootProcess.id);
    sleeperPids.add(crashedBootChildPid);
    assert.equal(isProcessAlive(crashedBootChildPid), true);
    delete process.env.OPENWORK_WORLD_STUB_CRASH;
    const postCrashUp = await up();
    assert.equal(postCrashUp.code, 0, postCrashUp.lines.join("\n"));
    assert.equal(postCrashUp.lines[0], `Reaped 2 leaked resources from "${stagedName}".`);
    assert.equal(postCrashUp.lines[1], retainedLine(1));
    await eventually(() => !isProcessAlive(crashedBootChildPid), {
      within: 5_000,
      intervalMs: 25,
      label: "mid-boot leaked sleeper is reaped",
    });
    const finalSnapshot = await readScriptWorldSnapshot(snapshotPath);
    assert.ok(finalSnapshot);
    launchedPids.add(finalSnapshot.pid);
    const finalChildPid = Number(finalSnapshot.outputs.child);
    sleeperPids.add(finalChildPid);
    const finalProcesses = (await readLedger(ledgerPath)).filter((entry) => entry.kind === "process");
    assert.equal(finalProcesses.length, 1);
    assert.equal(finalProcesses[0]?.id, String(finalChildPid));
    assert.equal(isProcessAlive(finalChildPid), true);
    const finalDown = await run(["down", fixtureName, "--stage", stage, "--purge"]);
    assert.equal(finalDown.code, 0, finalDown.lines.join("\n"));
    await eventually(async () =>
      !isProcessAlive(finalSnapshot.pid)
      && !isProcessAlive(finalChildPid)
      && !await exists(snapshotPath)
      && !await exists(finalSnapshot.outputs.dir)
      && !await exists(finalSnapshot.outputs.kept)
      && !await exists(ledgerPath), {
      within: 10_000,
      intervalMs: 50,
      label: "final purged world cleanup",
    });
    evidence.recordAssertionEvidence(
      "A missing receipt with a crash ledger is reaped before boot",
      "Mid-boot SIGKILL left no receipt but three tracked resources; the next up reaped two leaks, retained one, launched exactly one sleeper, and final purge removed every resource and the ledger.",
      true,
    );
  } finally {
    delete process.env.OPENWORK_WORLD_STUB_CRASH;
    try { await main(["down", fixtureName, "--stage", stage, "--purge"], { ...options, print: () => {} }); } catch {}
    for (const pid of launchedPids) {
      try { await stopPid(pid, "crash-reap world cleanup"); } catch {}
    }
    for (const pid of sleeperPids) {
      try { await stopPid(pid, "crash-reap sleeper cleanup"); } catch {}
    }
    if (unrelatedPid !== undefined) {
      try { await stopPid(unrelatedPid, "crash-reap unrelated child cleanup"); } catch {}
    }
    if (previousSnapshotDirectory === undefined) delete process.env.OPENWORK_WORLD_SNAPSHOT_DIR;
    else process.env.OPENWORK_WORLD_SNAPSHOT_DIR = previousSnapshotDirectory;
    if (previousStubCrash === undefined) delete process.env.OPENWORK_WORLD_STUB_CRASH;
    else process.env.OPENWORK_WORLD_STUB_CRASH = previousStubCrash;
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
