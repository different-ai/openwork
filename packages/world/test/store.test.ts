import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseScriptWorldSnapshot } from "../src/script-world.ts";
import { WorldStateStore } from "../src/store.ts";

test("local world state is owner-only and addressable by world name", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-world-store-"));
  try {
    const store = new WorldStateStore(join(root, "worlds"));
    const path = await store.save("demo", '{"name":"demo"}');
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
  })), {
    version: 2,
    ...base,
    name: "demo--preview",
    stage: "preview",
    recipeHash: "sha256:abc",
    place: "local",
  });
  assert.throws(
    () => parseScriptWorldSnapshot(JSON.stringify({ version: 2, ...base, stage: 1 })),
    /not a valid script world snapshot/,
  );
  assert.throws(() => parseScriptWorldSnapshot("{}"), /not a valid script world snapshot/);
});
