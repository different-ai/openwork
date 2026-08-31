import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { desktopProductionLive, test } from "@openwork/testkit";
import { discoverWorlds, loadWorldFile, main } from "@openwork/world";
import type { LoadedDefinitionWorld, WorldRuntimeAdapter } from "@openwork/world";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const WORLDS_DIRECTORY = join(REPO_ROOT, "worlds");

test("world discovery, list, and help never import world modules", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-world-discovery-"));
  try {
    const worldsDirectory = join(root, "worlds");
    await mkdir(worldsDirectory);
    await writeFile(join(worldsDirectory, "unguarded.ts"), 'throw new Error("world module was imported");\n', "utf8");

    assert.deepEqual(await discoverWorlds(worldsDirectory), [{
      kind: "unknown",
      name: "unguarded",
      path: join(worldsDirectory, "unguarded.ts"),
    }]);
    for (const command of [["list"], ["help"]]) {
      assert.equal(await main(command, {
        cwd: root,
        worldsDirectory,
        adapters: [],
        print: () => {},
      }), 0);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shared world files are discovered, path-loadable, consent-gated, and detached by default", async ({ evidence }) => {
  // Discovery must mirror the worlds/ directory itself. The listing is derived
  // here, not hardcoded, so adding a world file never edits this spec; only a
  // discovery defect (dropped, invented, renamed, or reordered entries) fails.
  const worldFileNames = (await readdir(WORLDS_DIRECTORY))
    .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
    .sort();
  assert.ok(worldFileNames.length > 0, "expected at least one root world file in worlds/");
  const discovered = await discoverWorlds(WORLDS_DIRECTORY);
  assert.deepEqual(
    discovered.map((world) => ({ name: world.name, path: world.path })),
    worldFileNames.map((entry) => ({ name: basename(entry, ".ts"), path: join(WORLDS_DIRECTORY, entry) })),
  );

  // Discovery stays import-free and explicit loads classify each world. Definition
  // worlds additionally satisfy the adapter launch contract.
  const loadedWorlds = new Map<string, LoadedDefinitionWorld>();
  for (const world of discovered) {
    assert.equal(world.kind, "unknown", `world ${world.name} must remain unclassified during discovery`);
    const loaded = await loadWorldFile(world.path);
    if (loaded.kind !== "definition") continue;
    loadedWorlds.set(world.name, loaded);
    assert.equal(loaded.defaultName, world.name);
    assert.equal(typeof loaded.definition.adapter, "string");
    assert.ok(loaded.definition.adapter.length > 0, `world ${world.name} must name its runtime adapter`);
    assert.equal(typeof loaded.definition.detached, "boolean", `world ${world.name} must declare detached`);
    assert.equal(
      typeof loaded.definition.requiresSharedState,
      "boolean",
      `world ${world.name} must declare requiresSharedState`,
    );
    assert.ok("topology" in loaded.definition, `world ${world.name} must carry a topology`);
  }
  const loadedWorld = (name: string): LoadedDefinitionWorld => {
    const loaded = loadedWorlds.get(name);
    assert.ok(loaded, `expected a root world file named ${name}`);
    return loaded;
  };

  // Pinned product decisions for specific worlds. These couple to the named
  // world's own contract, so unrelated additions cannot break them.
  const devHeadless = loadedWorld("dev-headless");
  assert.equal(devHeadless.definition.detached, true);
  assert.deepEqual(devHeadless.definition.topology, {
    surface: { kind: "headless-web", state: "isolated" },
  });
  const desktopProduction = loadedWorld("desktop-prod-live");
  assert.equal(desktopProduction.definition.adapter, "eval");
  assert.deepEqual(desktopProduction.definition.topology, desktopProductionLive.topology);
  const remoteSession = loadedWorld("remote-session");
  assert.equal(remoteSession.definition.adapter, "headless-web");
  assert.deepEqual(remoteSession.definition.topology, {
    surface: { kind: "headless-web", state: "isolated", workspace: "/tmp/openwork-remote-session-world" },
  });
  const cloudModelInfraWorker = loadedWorld("cloud-model-infra-worker");
  assert.equal(cloudModelInfraWorker.definition.adapter, "headless-web");
  assert.deepEqual(cloudModelInfraWorker.definition.topology, {
    surface: { kind: "headless-web", state: "isolated", workspace: "/tmp/openwork-cloud-model-infra-worker" },
  });
  assert.equal(loadedWorld("headless-prod-live").definition.requiresSharedState, true);

  // Every world that touches live shared state must refuse to launch without
  // explicit consent, before any runtime adapter is started.
  const definitionWorlds = discovered.filter((world) => loadedWorlds.has(world.name));
  const sharedStateWorlds = definitionWorlds.filter((world) => loadedWorld(world.name).definition.requiresSharedState);
  assert.ok(sharedStateWorlds.length > 0, "expected at least one shared-state world to exercise the consent gate");
  const refusalAdapters: WorldRuntimeAdapter[] = [...new Set(
    definitionWorlds.map((world) => loadedWorld(world.name).definition.adapter),
  )].map((id) => ({
    id,
    snapshotDirectory: join(REPO_ROOT, "tmp", "spec-worlds"),
    async start() { throw new Error("the consent gate must refuse before any adapter starts"); },
    async rebuild() { throw new Error("unused"); },
    async resume() { throw new Error("unused"); },
    summarize() { throw new Error("unused"); },
  }));
  for (const world of sharedStateWorlds) {
    const refusedLines: string[] = [];
    const refused = await main(["up", world.path], {
      cwd: REPO_ROOT,
      worldsDirectory: WORLDS_DIRECTORY,
      adapters: refusalAdapters,
      print: (line) => refusedLines.push(line),
    });
    assert.equal(refused, 1, `world ${world.name} must refuse to launch without --allow-shared-state`);
    assert.match(refusedLines[0] ?? "", /without explicit --allow-shared-state/);
  }

  let receivedName: string | undefined;
  let receivedAllowSharedState = false;
  let starts = 0;
  let detached = false;
  const adapter: WorldRuntimeAdapter = {
    id: "headless-web",
    snapshotDirectory: join(REPO_ROOT, "tmp", "spec-worlds"),
    async start(received) {
      starts += 1;
      receivedName = received.name;
      receivedAllowSharedState = received.allowSharedState;
      return {
        name: received.name ?? "missing",
        lines: ["fake headless surface"],
        sharedState: true,
        async detach() { detached = true; },
        async dispose() { throw new Error("detached path worlds must not be disposed"); },
      };
    },
    async rebuild() { throw new Error("unused"); },
    async resume() { throw new Error("unused"); },
    summarize() { throw new Error("unused"); },
  };
  const launched = await main([
    "up",
    "./worlds/headless-prod-live.ts",
    "--allow-shared-state",
  ], {
    cwd: REPO_ROOT,
    worldsDirectory: WORLDS_DIRECTORY,
    adapters: [adapter],
    print: () => {},
  });
  assert.equal(launched, 0);
  assert.equal(starts, 1);
  assert.equal(receivedName, "headless-prod-live");
  assert.equal(receivedAllowSharedState, true);
  assert.equal(detached, true);

  evidence.recordAssertionEvidence(
    "Root world files are auto-discovered and path-loadable",
    `Import-free discovery mirrored the worlds/ directory listing (${discovered.length} files), and every explicitly loaded definition had a valid launch contract.`,
    true,
  );
  evidence.recordAssertionEvidence(
    "Path worlds default their name and detached lifecycle",
    "The filename became headless-prod-live and the shell detached without requiring --name or --detach.",
    true,
  );
  evidence.recordAssertionEvidence(
    "Shared production state still requires explicit consent",
    `All ${sharedStateWorlds.length} shared-state world(s) refused to launch before adapter start, and headless-prod-live received the consent bit after opt-in.`,
    true,
  );
});
