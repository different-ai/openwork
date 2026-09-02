import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { EVENTS_ENV, readEvents } from "../src/events.ts";
import { MASK } from "../src/outputs.ts";
import { parseScriptWorldSnapshot } from "../src/script-world.ts";

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
  const eventPath = join(snapshots, "hold-only.events.jsonl");
  const holdUrl = new URL("../src/hold.ts", import.meta.url).href;
  const outputsUrl = new URL("../src/outputs.ts", import.meta.url).href;
  await writeFile(worldPath, [
    `import { hold } from ${JSON.stringify(holdUrl)};`,
    `import { secret } from ${JSON.stringify(outputsUrl)};`,
    'await hold({ outputs: { url: "http://x", token: secret("s3cr3t", { group: "Keys" }) } });',
    "",
  ].join("\n"), "utf8");

  const child = spawn(process.execPath, [worldPath], {
    detached: true,
    env: { ...process.env, OPENWORK_WORLD_SNAPSHOT_DIR: snapshots, [EVENTS_ENV]: eventPath },
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
    const receiptText = await readFile(receiptPath, "utf8");
    const receipt = parseScriptWorldSnapshot(receiptText);
    assert.deepEqual((await readdir(snapshots)).filter((name) => name.endsWith(".tmp")), []);
    assert.equal(receipt.version, 2);
    assert.equal(receipt.outputs.token, "s3cr3t");
    assert.equal(receipt.outputMeta?.token?.secret, true);
    const events = await readEvents(eventPath);
    assert.deepEqual(events, [{
      t: events[0]?.t,
      type: "ready",
      outputs: { url: "http://x", token: MASK },
      outputMeta: { token: { secret: true, group: "Keys" } },
    }]);
    assert.equal((await readFile(eventPath, "utf8")).includes("s3cr3t"), false);

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
