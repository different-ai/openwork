import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { eventually, test } from "@openwork/testkit";
import {
  isProcessAlive,
  main,
  readScriptWorldSnapshot,
  type WorldCliOptions,
} from "@openwork/world";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

async function probe(url: string): Promise<number | "rejected"> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    await response.text();
    return response.status;
  } catch {
    return "rejected";
  }
}

test("staged worlds run side by side without touching each other", async ({ evidence }) => {
  const root = await mkdtemp(join(tmpdir(), "openwork-world-stage-isolation-"));
  const worldsDirectory = join(root, "worlds");
  const scriptsDirectory = join(root, ".worlds", "scripts");
  const fixtureName = "staged-recipe-world";
  const fixturePath = join(worldsDirectory, `${fixtureName}.ts`);
  const bareSnapshotPath = join(scriptsDirectory, `${fixtureName}.json`);
  const stageAPath = join(scriptsDirectory, `${fixtureName}--a.json`);
  const stageBPath = join(scriptsDirectory, `${fixtureName}--b.json`);
  const stageCPath = join(scriptsDirectory, `${fixtureName}--c.json`);
  const recipeUrl = pathToFileURL(join(REPO_ROOT, "evals", "packages", "env", "src", "recipe.ts")).href;
  const previousSnapshotDirectory = process.env.OPENWORK_WORLD_SNAPSHOT_DIR;
  const previousStage = process.env.OPENWORK_WORLD_STAGE;
  const launchedPids = new Set<number>();
  let printedLines: string[] = [];

  const options: WorldCliOptions = {
    cwd: root,
    worldsDirectory,
    print(line) {
      printedLines.push(line);
    },
  };
  const run = async (argv: string[]): Promise<{ code: number; lines: string[] }> => {
    printedLines = [];
    const code = await main(argv, options);
    return { code, lines: [...printedLines] };
  };

  try {
    process.env.OPENWORK_WORLD_SNAPSHOT_DIR = scriptsDirectory;
    delete process.env.OPENWORK_WORLD_STAGE;
    await mkdir(worldsDirectory);
    await writeFile(fixturePath, `
import { createServer } from "node:http";
import { recipe, runRecipe } from ${JSON.stringify(recipeUrl)};

const world = recipe(${JSON.stringify(fixtureName)}, async (tools) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  tools.stack.use({
    async [Symbol.asyncDispose](): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected an assigned TCP address.");
  return { url: \`http://127.0.0.1:\${address.port}\`, orgLabel: tools.stageName("Org") };
});

export default world;
if (import.meta.main) await runRecipe(world);
`, "utf8");

    const stageAUp = await run(["up", fixturePath, "--detach", "--stage", "a", "--timeout", "10000"]);
    assert.equal(stageAUp.code, 0, stageAUp.lines.join("\n"));
    const stageBUp = await run(["up", fixturePath, "--detach", "--stage", "b", "--timeout", "10000"]);
    assert.equal(stageBUp.code, 0, stageBUp.lines.join("\n"));
    const stageA = await readScriptWorldSnapshot(stageAPath);
    const stageB = await readScriptWorldSnapshot(stageBPath);
    assert.ok(stageA);
    assert.ok(stageB);
    launchedPids.add(stageA.pid);
    launchedPids.add(stageB.pid);
    assert.notEqual(stageAPath, stageBPath);
    assert.equal(stageA.version, 2);
    assert.equal(stageB.version, 2);
    assert.equal(stageA.stage, "a");
    assert.equal(stageB.stage, "b");
    assert.notEqual(stageA.pid, stageB.pid);
    assert.equal(isProcessAlive(stageA.pid), true);
    assert.equal(isProcessAlive(stageB.pid), true);
    assert.notEqual(stageA.outputs.url, stageB.outputs.url);
    assert.equal(await probe(stageA.outputs.url), 200);
    assert.equal(await probe(stageB.outputs.url), 200);
    const stageAAfterBoth = await readScriptWorldSnapshot(stageAPath);
    const stageBAfterBoth = await readScriptWorldSnapshot(stageBPath);
    assert.ok(stageAAfterBoth);
    assert.ok(stageBAfterBoth);
    assert.equal(stageAAfterBoth.pid, stageA.pid);
    assert.equal(stageBAfterBoth.pid, stageB.pid);
    evidence.recordAssertionEvidence(
      "Staged launches have isolated receipts and runtimes",
      "Stages a and b launched with distinct receipt paths, live pids, and responding URLs; parsing both after both launches proved neither receipt overwrote the other.",
      true,
    );

    const downA = await run(["down", fixtureName, "--stage", "a"]);
    assert.equal(downA.code, 0, downA.lines.join("\n"));
    assert.deepEqual(downA.lines, [`World "${fixtureName}--a" torn down.`]);
    await eventually(async () => !isProcessAlive(stageA.pid) && await probe(stageA.outputs.url) === "rejected", {
      within: 10_000,
      intervalMs: 50,
      label: "stage a stops while stage b remains available",
    });
    assert.equal(await probe(stageA.outputs.url), "rejected");
    assert.equal(await probe(stageB.outputs.url), 200);
    assert.equal(await exists(stageAPath), false);
    const stageBAfterDownA = await readScriptWorldSnapshot(stageBPath);
    assert.ok(stageBAfterDownA);
    assert.equal(stageBAfterDownA.pid, stageB.pid);
    assert.equal(isProcessAlive(stageBAfterDownA.pid), true);
    evidence.recordAssertionEvidence(
      "Teardown targets only the selected stage",
      "Down for stage a stopped its URL and removed only its receipt while stage b kept the same live pid, responding URL, and parseable receipt.",
      true,
    );
    const downB = await run(["down", fixtureName, "--stage", "b"]);
    assert.equal(downB.code, 0, downB.lines.join("\n"));

    process.env.OPENWORK_WORLD_STAGE = "c";
    const stageCUp = await run(["up", fixturePath, "--detach", "--timeout", "10000"]);
    assert.equal(stageCUp.code, 0, stageCUp.lines.join("\n"));
    const stageC = await readScriptWorldSnapshot(stageCPath);
    assert.ok(stageC);
    launchedPids.add(stageC.pid);
    assert.equal(stageC.version, 2);
    assert.equal(stageC.stage, "c");
    assert.equal(stageC.outputs.orgLabel, "Org (c)");
    assert.equal(await exists(bareSnapshotPath), false);
    evidence.recordAssertionEvidence(
      "Environment stage reaches receipt and recipe display naming",
      "OPENWORK_WORLD_STAGE=c without a CLI stage produced only the c-suffixed receipt and the recipe output Org (c), with no unstaged receipt.",
      true,
    );
    const downC = await run(["down", fixtureName, "--stage", "c"]);
    assert.equal(downC.code, 0, downC.lines.join("\n"));

    delete process.env.OPENWORK_WORLD_STAGE;
    const bareUp = await run(["up", fixturePath, "--detach", "--timeout", "10000"]);
    assert.equal(bareUp.code, 0, bareUp.lines.join("\n"));
    const bare = await readScriptWorldSnapshot(bareSnapshotPath);
    assert.ok(bare);
    launchedPids.add(bare.pid);
    assert.equal(bare.version, 2);
    assert.equal("stage" in bare, false);
    assert.deepEqual(
      (await readdir(scriptsDirectory)).filter((name) => name.endsWith(".json")),
      [`${fixtureName}.json`],
    );
    const bareDown = await run(["down", fixtureName]);
    assert.equal(bareDown.code, 0, bareDown.lines.join("\n"));
    assert.deepEqual(bareDown.lines, [`World "${fixtureName}" torn down.`]);
    evidence.recordAssertionEvidence(
      "Unstaged launches retain legacy receipt naming",
      "With no stage flag or environment value, up wrote only the unsuffixed version-2 receipt without a stage field and bare-name down succeeded.",
      true,
    );
  } finally {
    delete process.env.OPENWORK_WORLD_STAGE;
    for (const stage of ["a", "b", "c"]) {
      try { await main(["down", fixtureName, "--stage", stage], { ...options, print: () => {} }); } catch {}
    }
    try { await main(["down", fixtureName], { ...options, print: () => {} }); } catch {}
    for (const pid of launchedPids) {
      if (!isProcessAlive(pid)) continue;
      try { process.kill(pid, "SIGKILL"); } catch {}
      try {
        await eventually(() => !isProcessAlive(pid), {
          within: 2_000,
          intervalMs: 25,
          label: "staged recipe fixture cleanup",
        });
      } catch {}
    }
    if (previousSnapshotDirectory === undefined) delete process.env.OPENWORK_WORLD_SNAPSHOT_DIR;
    else process.env.OPENWORK_WORLD_SNAPSHOT_DIR = previousSnapshotDirectory;
    if (previousStage === undefined) delete process.env.OPENWORK_WORLD_STAGE;
    else process.env.OPENWORK_WORLD_STAGE = previousStage;
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
