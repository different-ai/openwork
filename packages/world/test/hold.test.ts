import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await delay(50);
  }
  return condition();
}

test("hold keeps an otherwise idle world alive until SIGTERM", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-world-hold-"));
  const snapshots = join(root, "snapshots");
  const worldPath = join(root, "hold-only.ts");
  const receiptPath = join(snapshots, "hold-only.json");
  const holdUrl = new URL("../src/hold.ts", import.meta.url).href;
  await writeFile(worldPath, [
    `import { hold } from ${JSON.stringify(holdUrl)};`,
    'await hold({ outputs: { ok: "1" } });',
    "",
  ].join("\n"), "utf8");

  const child = spawn(process.execPath, [worldPath], {
    detached: true,
    env: { ...process.env, OPENWORK_WORLD_SNAPSHOT_DIR: snapshots },
    stdio: "ignore",
  });
  if (child.pid === undefined) throw new Error("child pid unavailable");
  const pid = child.pid;
  try {
    assert.equal(
      await waitFor(() => access(receiptPath).then(() => true, () => false), 5_000),
      true,
      "receipt was not created within 5s",
    );
    await delay(1_000);
    assert.equal(isAlive(pid), true, "world exited while hold was awaiting a signal");

    process.kill(pid, "SIGTERM");
    assert.equal(await waitFor(() => !isAlive(pid), 5_000), true, "world did not exit after SIGTERM");
    assert.equal(await access(receiptPath).then(() => true, () => false), false);
  } finally {
    if (isAlive(pid)) {
      try { process.kill(-pid, "SIGKILL"); } catch {}
      try { process.kill(pid, "SIGKILL"); } catch {}
      await waitFor(() => !isAlive(pid), 2_000);
    }
    await rm(root, { recursive: true, force: true });
  }
});
