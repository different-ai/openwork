import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "@openwork/testkit";
import { discoverWorlds, main } from "@openwork/world";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const WORLDS_DIRECTORY = join(REPO_ROOT, "worlds");

const worldImports: Record<string, () => Promise<unknown>> = {
  "acme-demo.ts": () => import("../../worlds/acme-demo.ts"),
  "acme-docs.ts": () => import("../../worlds/acme-docs.ts"),
  "azure-byok.ts": () => import("../../worlds/azure-byok.ts"),
  "cloud-model-infra-worker.ts": () => import("../../worlds/cloud-model-infra-worker.ts"),
  "cloud-model-infra.ts": () => import("../../worlds/cloud-model-infra.ts"),
  "cross-workspace-split-view.ts": () => import("../../worlds/cross-workspace-split-view.ts"),
  "den-split-origin-kind.ts": () => import("../../worlds/den-split-origin-kind.ts"),
  "desktop-prod-live.ts": () => import("../../worlds/desktop-prod-live.ts"),
  "dev-headless.ts": () => import("../../worlds/dev-headless.ts"),
  "headless-prod-live.ts": () => import("../../worlds/headless-prod-live.ts"),
  "litellm-per-member.ts": () => import("../../worlds/litellm-per-member.ts"),
  "remote-session.ts": () => import("../../worlds/remote-session.ts"),
  "solo.ts": () => import("../../worlds/solo.ts"),
};

async function importPromptly(name: string, load: () => Promise<unknown>): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      load(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Importing ${name} did not finish within 10 seconds.`)), 10_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function ownedResources(): string[] {
  return process.getActiveResourcesInfo()
    .filter((name) => /process|tcp|udp|server/i.test(name))
    .sort();
}

test("world discovery, list, and help label scripts without importing them", async ({ evidence }) => {
  const root = await mkdtemp(join(tmpdir(), "openwork-world-discovery-"));
  try {
    const worldsDirectory = join(root, "worlds");
    const receiptsDirectory = join(root, "receipts");
    await mkdir(worldsDirectory);
    await writeFile(join(worldsDirectory, "unguarded.ts"), 'throw new Error("world module was imported");\n', "utf8");

    assert.deepEqual(await discoverWorlds(worldsDirectory), [{
      kind: "script",
      name: "unguarded",
      path: join(worldsDirectory, "unguarded.ts"),
    }]);
    const previousReceiptsDirectory = process.env.OPENWORK_WORLD_SNAPSHOT_DIR;
    process.env.OPENWORK_WORLD_SNAPSHOT_DIR = receiptsDirectory;
    try {
      for (const command of [["list"], ["help"]]) {
        const lines: string[] = [];
        assert.equal(await main(command, {
          cwd: root,
          worldsDirectory,
          print: (line) => lines.push(line),
        }), 0);
        assert.match(lines.join("\n"), /world scripts/i);
        assert.match(lines.join("\n"), /unguarded/);
      }
    } finally {
      if (previousReceiptsDirectory === undefined) delete process.env.OPENWORK_WORLD_SNAPSHOT_DIR;
      else process.env.OPENWORK_WORLD_SNAPSHOT_DIR = previousReceiptsDirectory;
    }
    await assert.rejects(access(receiptsDirectory));

    evidence.recordAssertionEvidence(
      "Discovery and informational commands are import-free",
      "A throwing world file was discovered and labeled as a script by list/help, while its module never ran and no receipt directory was created.",
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("every root world is an import-safe executable script module", async ({ evidence }) => {
  const worldFileNames = (await readdir(WORLDS_DIRECTORY))
    .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
    .sort();
  assert.ok(worldFileNames.length > 0, "expected at least one root world file");
  assert.deepEqual(Object.keys(worldImports).sort(), worldFileNames);

  const discovered = await discoverWorlds(WORLDS_DIRECTORY);
  assert.deepEqual(
    discovered,
    worldFileNames.map((entry) => ({
      kind: "script",
      name: basename(entry, ".ts"),
      path: join(WORLDS_DIRECTORY, entry),
    })),
  );

  const root = await mkdtemp(join(tmpdir(), "openwork-world-imports-"));
  const previousReceiptsDirectory = process.env.OPENWORK_WORLD_SNAPSHOT_DIR;
  const signalListeners = {
    sigint: process.listenerCount("SIGINT"),
    sigterm: process.listenerCount("SIGTERM"),
  };
  const resources = ownedResources();
  process.env.OPENWORK_WORLD_SNAPSHOT_DIR = root;
  try {
    for (const name of worldFileNames) {
      const load = worldImports[name];
      assert.ok(load, `missing explicit import for ${name}`);
      const loaded = await importPromptly(name, load);
      assert.equal(typeof loaded, "object", `${name} must import as a module`);
    }
    assert.deepEqual(await readdir(root), [], "imports must not create lifecycle receipts");
    assert.equal(process.listenerCount("SIGINT"), signalListeners.sigint, "imports must not acquire SIGINT listeners");
    assert.equal(process.listenerCount("SIGTERM"), signalListeners.sigterm, "imports must not acquire SIGTERM listeners");
    assert.deepEqual(ownedResources(), resources, "imports must not acquire child processes or network resources");

    evidence.recordAssertionEvidence(
      "Every discovered world is an explicit import-safe script module",
      `All ${worldFileNames.length} worlds/*.ts files imported within the deadline without receipts, signal listeners, child processes, or network resources.`,
      true,
    );
  } finally {
    if (previousReceiptsDirectory === undefined) delete process.env.OPENWORK_WORLD_SNAPSHOT_DIR;
    else process.env.OPENWORK_WORLD_SNAPSHOT_DIR = previousReceiptsDirectory;
    await rm(root, { recursive: true, force: true });
  }
});

test("the retired definition, topology, adapter, and preset APIs are absent", async ({ evidence }) => {
  const deletedPaths = [
    "packages/world/src/definition.ts",
    "packages/world/src/headless-definition.ts",
    "packages/world/src/headless-adapter.ts",
    "packages/world/src/compat.ts",
    "evals/packages/env/src/topology.ts",
    "evals/packages/env/src/world.ts",
    "evals/packages/env/src/world-adapter.ts",
    "evals/packages/env/src/presets.ts",
    "packages/world/test/definition.test.ts",
    "packages/world/test/headless-adapter.test.ts",
    "evals/packages/env/test/topology.test.ts",
    "evals/packages/env/test/snapshot.test.ts",
    "evals/packages/env/test/cli.test.ts",
  ];
  for (const path of deletedPaths) await assert.rejects(access(join(REPO_ROOT, path)));

  const [worldModule, envModule, testkitModule] = await Promise.all([
    import("@openwork/world"),
    import("../packages/env/src/index.ts"),
    import("@openwork/testkit"),
  ]);
  for (const name of ["createWorld" + "Definition", "defineHeadless" + "WebWorld", "createHeadless" + "WebAdapter"]) {
    assert.equal(name in worldModule, false, `@openwork/world must not export ${name}`);
  }
  for (const name of ["define" + "World", "createEval" + "WorldAdapter", "parseUntrusted" + "Snapshot", "resume" + "World"]) {
    assert.equal(name in envModule, false, `@openwork/env must not export ${name}`);
  }
  for (const name of ["start" + "World", "define" + "World"]) {
    assert.equal(name in testkitModule, false, `@openwork/testkit must not export ${name}`);
  }

  evidence.recordAssertionEvidence(
    "The old world abstraction has no files or public runtime exports",
    `All ${deletedPaths.length} retired files were absent, and representative definition, topology, adapter, resume, and start APIs were absent from package exports.`,
    true,
  );
});
