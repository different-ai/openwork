import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWindowsShortcutScheduler, readWindowsShortcutMarker, repairWindowsShortcutTarget, updateWindowsShortcut } from "../electron/windows-shortcut.mjs";

const details = { target: "app.exe", cwd: ".", description: "desktop", icon: "app.ico", iconIndex: 0, appUserModelId: "app.id" };
const turn = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "condition reached within deadline");
    await turn();
  }
}

test("a timed-out repair kills its real child and resolves false without blocking heartbeats", async () => {
  let child;
  let ticks = 0;
  const heartbeat = setInterval(() => ticks++, 10);
  try {
    const result = await repairWindowsShortcutTarget("shortcut.lnk", details, {
      timeoutMs: 150,
      execute: (_file, _args, options, callback) => {
        assert.equal(options.windowsHide, true);
        assert.equal(options.killSignal, "SIGKILL");
        child = execFile(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options, callback);
        return child;
      },
    });
    assert.equal(result, false);
    assert.equal(child.killed, true);
    assert.notEqual(child.signalCode, null);
    assert.ok(ticks > 0);
  } finally { clearInterval(heartbeat); }
});

test("fast repair preserves target, working directory and icon script and launch errors never throw", async () => {
  assert.equal(await repairWindowsShortcutTarget("shortcut.lnk", details, {
    execute: (file, args, options, callback) => {
      assert.equal(file, "powershell.exe");
      assert.match(args.at(-1), /\$link.TargetPath = \$value.target/);
      assert.match(args.at(-1), /\$link.Save\(\)/);
      assert.equal(options.timeout, 15000);
      callback(null);
    },
  }), true);
  assert.equal(await repairWindowsShortcutTarget("shortcut.lnk", details, { execute: () => { throw Error("spawn failed"); } }), false);
});

test("requests wait for readiness, coalesce, never overlap, and never retry a failed configuration this launch", async () => {
  let releaseReady;
  let finish;
  let calls = 0;
  let active = 0;
  let maximum = 0;
  const logs = [];
  const readiness = new Promise(resolve => { releaseReady = resolve; });
  const schedule = createWindowsShortcutScheduler({
    ready: () => readiness,
    update: async () => {
      calls++;
      maximum = Math.max(maximum, ++active);
      await new Promise(resolve => { finish = resolve; });
      active--;
      throw Error("policy denied with private path");
    },
    logger: { info: line => logs.push(line), warn: line => logs.push(line) },
  });
  const request = { shortcutPath: "shortcut.lnk", details };
  assert.equal(schedule(request), undefined);
  schedule(request);
  await turn();
  assert.equal(calls, 0);
  releaseReady();
  await until(() => calls === 1);
  schedule(request);
  schedule({ ...request, details: { ...details, icon: "new.ico" } });
  assert.equal(calls, 1);
  finish();
  await until(() => calls === 2);
  finish();
  await until(() => logs.length === 2);
  schedule(request);
  await turn();
  assert.equal(calls, 2);
  assert.equal(maximum, 1);
  assert.ok(logs.every(line => /failed or timed out \(\d+ ms\)/.test(line)));
  assert.ok(logs.every(line => !line.includes("private path")));
});

test("successful markers skip all native calls; changed details or missing link repair once, legacy markers upgrade", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "exp-sc-unit-"));
  const shortcutPath = path.join(dir, "shortcut.lnk");
  const markerPath = path.join(dir, "marker.txt");
  let writes = 0;
  let reads = 0;
  let repairs = 0;
  const shell = {
    writeShortcutLink: (file, operation, value) => {
      assert.equal(operation, "create");
      assert.deepEqual(value, details);
      writes++;
      // The native API writes synchronously; a fixture file is staged below.
      return true;
    },
    readShortcutLink: () => { reads++; return { target: "wrong.exe" }; },
  };
  try {
    await writeFile(shortcutPath, "fixture");
    await writeFile(markerPath, JSON.stringify({ shortcutPath, signature: JSON.stringify(details) }));
    const request = { shell, shortcutPath, markerPath, installedShortcutPath: shortcutPath, details };
    assert.equal(await updateWindowsShortcut(request), "unchanged");
    assert.deepEqual([writes, reads, repairs], [0, 0, 0]);
    // Real sync fixture write for the Electron Shell stand-in.
    const { writeFileSync } = await import("node:fs");
    shell.writeShortcutLink = (file, operation, value) => {
      assert.equal(operation, "create"); assert.deepEqual(value, details);
      writes++; writeFileSync(file, "fixture"); return true;
    };
    await writeFile(markerPath, shortcutPath);
    assert.equal((await readWindowsShortcutMarker(markerPath)).shortcutPath, shortcutPath);
    const repair = async () => { repairs++; return true; };
    assert.equal(await updateWindowsShortcut(request, { repair }), "updated");
    assert.deepEqual([writes, reads, repairs], [1, 1, 1]);
    assert.equal(await updateWindowsShortcut(request, { repair }), "unchanged");
    await rm(shortcutPath);
    assert.equal(await updateWindowsShortcut(request, { repair }), "updated");
    assert.deepEqual([writes, reads, repairs], [2, 2, 2]);
    await writeFile(markerPath, JSON.stringify({ shortcutPath, signature: "old" }));
    assert.equal(await updateWindowsShortcut(request, { repair }), "updated");
    assert.deepEqual([writes, reads, repairs], [3, 3, 3]);
    await rm(shortcutPath);
    await assert.rejects(updateWindowsShortcut(request, { repair: async () => false }), /shortcut-repair/);
    await assert.rejects(readFile(markerPath), { code: "ENOENT" });
    assert.deepEqual(await readFile(shortcutPath, "utf8"), "fixture");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
