import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main } from "../src/cli.ts";
import { readScriptWorldSnapshot } from "../src/script-world.ts";

test("CLI handoff replaces inherited selection markers and fingerprints selected values before adoption", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-selected-env-"));
  const selected = ["OPENWORK_WORLD_SELECTED_ENV_KEYS", "OPENWORK_WORLD_SNAPSHOT_DIR", "WORLD_TEST_CONFIG"];
  const previous = new Map(selected.map((key) => [key, process.env[key]]));
  const worlds = join(root, "worlds");
  const snapshots = join(root, "receipts");
  const options = { cwd: root, worldsDirectory: worlds, print: () => undefined };
  try {
    await mkdir(worlds);
    const hold = new URL("../src/hold.ts", import.meta.url).href;
    await writeFile(join(worlds, "probe.ts"), `import { hold } from ${JSON.stringify(hold)};
await hold({ outputs: { selected: process.env.OPENWORK_WORLD_SELECTED_ENV_KEYS ?? "missing" } });`);
    process.env.OPENWORK_WORLD_SNAPSHOT_DIR = snapshots;
    process.env.OPENWORK_WORLD_SELECTED_ENV_KEYS = '["FORGED_KEY"]';
    process.env.WORLD_TEST_CONFIG = "first";
    const up = (keys: string[]) => main(["up", "probe", "--place", "local", "--stage", "selection", "--detach", "--timeout", "10000", ...keys], options);
    const down = () => main(["down", "probe", "--stage", "selection"], options);
    const receipt = () => readScriptWorldSnapshot(join(snapshots, "probe--selection.json"));
    assert.equal(await up([]), 0);
    assert.equal((await receipt())?.outputs.selected, "[]");
    assert.equal(await down(), 0);
    assert.equal(await up(["--env", "WORLD_TEST_CONFIG"]), 0);
    const first = await receipt();
    assert(first);
    assert.equal(first.outputs.selected, '["WORLD_TEST_CONFIG"]');
    process.env.WORLD_TEST_CONFIG = "second";
    assert.equal(await up(["--env", "WORLD_TEST_CONFIG"]), 1);
    assert.equal((await receipt())?.pid, first.pid);
    assert.equal(await down(), 0);
  } finally {
    await main(["down", "probe", "--stage", "selection"], options);
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
