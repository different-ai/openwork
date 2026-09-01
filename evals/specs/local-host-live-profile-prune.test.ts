import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  pruneStaleSurfaceProfiles,
  registerLiveProfileRoot,
  unregisterLiveProfileRoot,
} from "@openwork/hosts";
import { eventually, test } from "@openwork/testkit";

test("pruning stale desktop profiles never touches a live sibling desktop", async ({ evidence }) => {
  const rootDir = await mkdtemp(join(tmpdir(), "openwork-live-profile-prune-"));
  const livePath = resolve(rootDir, "live-sibling");
  const stalePath = resolve(rootDir, "stale-sibling");
  const markerPath = join(livePath, "marker.bin");
  const marker = Buffer.from([0, 1, 2, 127, 128, 254, 255]);
  const killed: string[] = [];
  let livePid: number | undefined;
  let stalePid: number | undefined;

  try {
    await mkdir(livePath);
    await mkdir(stalePath);
    await writeFile(markerPath, marker);
    await writeFile(join(stalePath, "marker.txt"), "stale", "utf8");
    registerLiveProfileRoot(livePath);

    const firstPrune = await pruneStaleSurfaceProfiles(rootDir, {
      kill: async (path) => { killed.push(path); },
    });
    assert.deepEqual(firstPrune, { removed: [stalePath], kept: [livePath] });
    assert.deepEqual(await readFile(markerPath), marker);
    await assert.rejects(access(stalePath));
    assert.deepEqual(killed, [stalePath]);
    assert.equal(killed.includes(rootDir), false);
    assert.equal(killed.includes(livePath), false);
    evidence.recordAssertionEvidence(
      "Live sibling profile survives stale-profile pruning",
      "The registered live profile stayed byte-identical, the stale profile was removed, and kill received only the stale absolute path—not the root or live path.",
      true,
    );

    await mkdir(stalePath);
    const liveChild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", livePath], {
      detached: true,
      stdio: "ignore",
    });
    const staleChild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", stalePath], {
      detached: true,
      stdio: "ignore",
    });
    if (liveChild.pid === undefined || staleChild.pid === undefined) throw new Error("Desktop process fixtures did not start.");
    livePid = liveChild.pid;
    stalePid = staleChild.pid;
    await new Promise((done) => setTimeout(done, 100));

    await pruneStaleSurfaceProfiles(rootDir, {});
    await eventually(() => staleChild.exitCode !== null || staleChild.signalCode !== null, {
      within: 5_000,
      intervalMs: 50,
      label: "stale profile process exits",
    });
    assert.doesNotThrow(() => process.kill(livePid, 0));
    assert.equal(liveChild.exitCode, null);
    assert.equal(liveChild.signalCode, null);
    evidence.recordAssertionEvidence(
      "Default pruning kills only the stale profile process",
      "A detached process whose argv named the stale profile exited within five seconds, while the registered live sibling process remained alive.",
      true,
    );

    unregisterLiveProfileRoot(livePath);
    const finalPrune = await pruneStaleSurfaceProfiles(rootDir, { kill: async () => undefined });
    assert.deepEqual(finalPrune, { removed: [livePath], kept: [] });
    await assert.rejects(access(livePath));
    evidence.recordAssertionEvidence(
      "Unregistered profiles become pruneable",
      "After unregistering the formerly live profile, the next prune removed its directory and kept no live entries.",
      true,
    );
  } finally {
    unregisterLiveProfileRoot(livePath);
    if (livePid !== undefined) {
      try { process.kill(livePid, "SIGKILL"); } catch {}
    }
    if (stalePid !== undefined) {
      try { process.kill(stalePid, "SIGKILL"); } catch {}
    }
    await rm(rootDir, { recursive: true, force: true });
  }
}, 30_000);
