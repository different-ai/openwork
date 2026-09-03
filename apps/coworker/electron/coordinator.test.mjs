import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { listCoworkers } from "./coworkers.mjs";
import { COORDINATOR_DIR, coordinatorConfig, ensureCoordinatorHome, readCoordinator, updateCoordinator } from "./coordinator.mjs";

test("the coordinator home is a locked-down hidden workspace that the coworker list never shows", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "coworker-coordinator-"));
  try {
    assert.equal(await readCoordinator(home), null);
    const created = await ensureCoordinatorHome(home);
    assert.equal(created.path, path.join(home, COORDINATOR_DIR));
    assert.equal(created.workspaceId, "");
    const config = JSON.parse(await readFile(path.join(created.path, "opencode.json"), "utf8"));
    assert.equal(config.permission, "deny");
    assert.equal(config.tools["*"], false);
    assert.equal(config.tools.bash, false);
    assert.equal(config.tools.edit, false);
    assert.deepEqual(config.instructions, []);
    assert.deepEqual(config.mcp, {});
    assert.match(await readFile(path.join(created.path, "AGENTS.md"), "utf8"), /never answer the person yourself/);
    // Not a coworker: no coworker.md, so it stays out of the rail, discussions, and Activity.
    assert.deepEqual(await listCoworkers(home), []);

    const registered = await updateCoordinator(home, { workspaceId: "ws_1" });
    assert.equal(registered.workspaceId, "ws_1");
    // A hand edit that hands the facilitator a tool is undone on the next ensure; the workspace id is kept.
    await writeFile(path.join(created.path, "opencode.json"), JSON.stringify({ tools: { bash: true } }), "utf8");
    const again = await ensureCoordinatorHome(home);
    assert.equal(again.workspaceId, "ws_1");
    assert.deepEqual(JSON.parse(await readFile(path.join(created.path, "opencode.json"), "utf8")), coordinatorConfig());
    assert.equal((await readCoordinator(home))?.workspaceId, "ws_1");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
