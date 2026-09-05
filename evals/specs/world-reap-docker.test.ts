import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { eventually, test, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";
import {
  isProcessAlive,
  main,
  readLedger,
  readScriptWorldSnapshot,
  type WorldCliOptions,
} from "@openwork/world";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const execFileAsync = promisify(execFile);
const requirements: TestNeeds = { commands: ["docker"] };
const missing = unmetNeeds(requirements, process.env);
const title = missing.length > 0
  ? `docker-backed world resources are reaped after a crash skipped — needs: ${missing.join(", ")}`
  : "docker-backed world resources are reaped after a crash and volumes honor retain";

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

async function dockerSucceeds(args: string[]): Promise<boolean> {
  try {
    await execFileAsync("docker", args);
    return true;
  } catch {
    return false;
  }
}

test.skipIf(missing.length > 0)(title, async ({ evidence }) => {
  const root = await mkdtemp(join(tmpdir(), "openwork-world-reap-docker-"));
  const worldsDirectory = join(root, "worlds");
  const scriptsDirectory = join(root, ".worlds", "scripts");
  const fixtureName = "docker-reap-world";
  const stage = "d";
  const stagedName = `${fixtureName}--${stage}`;
  const fixturePath = join(worldsDirectory, `${fixtureName}.ts`);
  const snapshotPath = join(scriptsDirectory, `${stagedName}.json`);
  const ledgerPath = join(scriptsDirectory, `${stagedName}.ledger.jsonl`);
  const trackedName = `openwork-reap-spec-${randomBytes(4).toString("hex")}`;
  const volumeName = `openwork-reap-vol-${randomBytes(4).toString("hex")}`;
  const controlName = `openwork-reap-control-${randomBytes(4).toString("hex")}`;
  const recipeUrl = pathToFileURL(join(REPO_ROOT, "evals", "packages", "env", "src", "recipe.ts")).href;
  const previousSnapshotDirectory = process.env.OPENWORK_WORLD_SNAPSHOT_DIR;
  let worldPid: number | undefined;
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
    await execFileAsync("docker", ["pull", "alpine:3"]);
    await execFileAsync("docker", ["run", "-d", "--name", controlName, "alpine:3", "sleep", "600"]);
    await mkdir(worldsDirectory);
    await writeFile(fixturePath, `
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { recipe, runRecipe } from ${JSON.stringify(recipeUrl)};

const execFileAsync = promisify(execFile);
const container = ${JSON.stringify(trackedName)};
const volume = ${JSON.stringify(volumeName)};
const world = recipe(${JSON.stringify(fixtureName)}, async (tools) => {
  await execFileAsync("docker", ["run", "-d", "--name", container, "alpine:3", "sleep", "600"]);
  await tools.track({ kind: "docker", id: container, label: "sleeper" });
  await execFileAsync("docker", ["volume", "create", volume]);
  await tools.track({ kind: "docker-volume", id: volume, retain: true });
  tools.stack.use({
    async [Symbol.asyncDispose](): Promise<void> {
      await execFileAsync("docker", ["rm", "-f", container]);
    },
  });
  return { container, volume };
});

export default world;
if (import.meta.main) await runRecipe(world);
`, "utf8");

    const up = await run(["up", fixturePath, "--detach", "--stage", stage, "--timeout", "10000"]);
    assert.equal(up.code, 0, up.lines.join("\n"));
    const snapshot = await readScriptWorldSnapshot(snapshotPath);
    assert.ok(snapshot);
    worldPid = snapshot.pid;
    assert.equal(await dockerSucceeds(["inspect", trackedName]), true);
    assert.equal((await readLedger(ledgerPath)).length, 2);
    evidence.recordAssertionEvidence(
      "Docker world startup tracks its container and retained volume",
      "Up succeeded, the tracked container was inspectable, and the ledger contained exactly the container and volume entries.",
      true,
    );

    process.kill(snapshot.pid, "SIGKILL");
    await eventually(() => !isProcessAlive(snapshot.pid), {
      within: 10_000,
      intervalMs: 50,
      label: "docker world crashes",
    });
    assert.equal(await dockerSucceeds(["inspect", trackedName]), true);
    evidence.recordAssertionEvidence(
      "A crashed Docker world leaves a real container leak",
      "After the world process exited from SIGKILL, docker inspect still succeeded for the tracked container.",
      true,
    );

    const down = await run(["down", fixtureName, "--stage", stage]);
    assert.equal(down.code, 0, down.lines.join("\n"));
    assert.deepEqual(down.lines, [
      `World "${stagedName}" torn down.`,
      `Reaped 1 leaked resources from "${stagedName}".`,
      `Retained 1 resources for "${stagedName}"; run pnpm world down ${fixtureName} --stage ${stage} --purge to remove them.`,
    ]);
    assert.equal(await dockerSucceeds(["inspect", trackedName]), false);
    assert.equal(await dockerSucceeds(["volume", "inspect", volumeName]), true);
    assert.equal(await dockerSucceeds(["inspect", controlName]), true);
    evidence.recordAssertionEvidence(
      "Down reaps only the tracked container and retains the volume",
      "The exact teardown, reap, and retain lines were printed; the tracked container disappeared, the retained volume remained, and the untracked control container stayed untouched.",
      true,
    );

    const purge = await run(["down", fixtureName, "--stage", stage, "--purge"]);
    assert.equal(purge.code, 0, purge.lines.join("\n"));
    assert.deepEqual(purge.lines, [
      `Reaped 1 leaked resources from "${stagedName}".`,
      `World "${stagedName}" has no receipt; reaped its ledger.`,
    ]);
    assert.equal(await dockerSucceeds(["volume", "inspect", volumeName]), false);
    assert.equal(await exists(ledgerPath), false);
    evidence.recordAssertionEvidence(
      "Purge reaps the retained Docker volume and deletes its ledger",
      "Ledger-only purge printed the exact reap and no-receipt completion lines, made volume inspect fail, and removed the empty ledger.",
      true,
    );
  } finally {
    try { await execFileAsync("docker", ["rm", "-f", trackedName, controlName]); } catch {}
    try { await execFileAsync("docker", ["volume", "rm", "-f", volumeName]); } catch {}
    const stalePid = worldPid;
    if (stalePid !== undefined && isProcessAlive(stalePid)) {
      try { process.kill(stalePid, "SIGKILL"); } catch {}
      try {
        await eventually(() => !isProcessAlive(stalePid), {
          within: 5_000,
          intervalMs: 25,
          label: "docker world process cleanup",
        });
      } catch {}
    }
    if (previousSnapshotDirectory === undefined) delete process.env.OPENWORK_WORLD_SNAPSHOT_DIR;
    else process.env.OPENWORK_WORLD_SNAPSHOT_DIR = previousSnapshotDirectory;
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);
