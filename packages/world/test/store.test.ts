import assert from "node:assert/strict";
import { mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { parseScriptWorldSnapshot, readScriptWorldSnapshot } from "../src/script-world.ts";
import { WorldStateStore } from "../src/store.ts";

test("local world state is owner-only and addressable by world name", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-world-store-"));
  try {
    const store = new WorldStateStore(join(root, "worlds"));
    const path = await store.save("demo", '{"name":"demo"}');
    await writeFile(`${path}.tmp`, "partial", "utf8");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(await store.read("demo"), '{"name":"demo"}\n');
    assert.deepEqual(await store.list(), [path]);
    assert.equal(await store.forget("demo"), true);
    assert.equal(await store.forget("demo"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("script world snapshots parse v1 and strict v2 receipts", () => {
  const base = {
    kind: "script",
    name: "demo",
    createdAt: "2026-09-01T00:00:00.000Z",
    pid: 123,
    sourcePath: "/tmp/demo.ts",
    outputs: { url: "http://127.0.0.1:1234" },
  };
  assert.deepEqual(parseScriptWorldSnapshot(JSON.stringify({ version: 1, ...base })), {
    version: 1,
    ...base,
  });
  assert.deepEqual(parseScriptWorldSnapshot(JSON.stringify({
    version: 2,
    ...base,
    name: "demo--preview",
    stage: "preview",
    recipeHash: "sha256:abc",
    place: "local",
    outputMeta: { url: { secret: true, group: "Services", note: "primary" } },
  })), {
    version: 2,
    ...base,
    name: "demo--preview",
    stage: "preview",
    recipeHash: "sha256:abc",
    place: "local",
    outputMeta: { url: { secret: true, group: "Services", note: "primary" } },
  });
  assert.throws(
    () => parseScriptWorldSnapshot(JSON.stringify({ version: 2, ...base, stage: 1 })),
    /not a valid script world snapshot/,
  );
  for (const outputMeta of [
    { url: { secret: "yes" } },
    { url: { group: 1 } },
    { url: { note: false } },
    { url: { label: "extra" } },
  ]) {
    assert.throws(
      () => parseScriptWorldSnapshot(JSON.stringify({ version: 2, ...base, outputMeta })),
      /not a valid script world snapshot/,
    );
  }
  assert.throws(() => parseScriptWorldSnapshot("{}"), /not a valid script world snapshot/);
});

test("script world snapshot reads tolerate a receipt being written byte by byte", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-world-receipt-race-"));
  const path = join(root, "demo.json");
  const expected = {
    version: 2 as const,
    kind: "script" as const,
    name: "demo",
    createdAt: "2026-09-01T00:00:00.000Z",
    pid: 123,
    sourcePath: "/tmp/demo.ts",
    outputs: { ready: "yes" },
    stage: "test",
  };
  const results: Array<Awaited<ReturnType<typeof readScriptWorldSnapshot>>> = [];
  const errors: unknown[] = [];
  let polling = true;
  const poller = (async () => {
    while (polling) {
      try {
        results.push(await readScriptWorldSnapshot(path));
      } catch (error) {
        errors.push(error);
      }
      await delay(5);
    }
  })();
  try {
    const file = await open(path, "w", 0o600);
    try {
      for (const byte of Buffer.from(`${JSON.stringify(expected)}\n`)) {
        await file.write(Buffer.from([byte]));
        await delay(1);
      }
    } finally {
      await file.close();
    }
    polling = false;
    await poller;
    assert.deepEqual(errors, []);
    for (const result of results) {
      if (result !== undefined) assert.deepEqual(result, expected);
    }
    assert.deepEqual(await readScriptWorldSnapshot(path), expected);
  } finally {
    polling = false;
    await poller;
    await rm(root, { recursive: true, force: true });
  }
});
