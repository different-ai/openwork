import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

interface ProbeResult {
  status: number;
  body: string;
}

async function probe(url: string): Promise<ProbeResult | "rejected"> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return { status: response.status, body: await response.text() };
  } catch {
    return "rejected";
  }
}

async function exitedNodePid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""]);
  if (child.pid === undefined) throw new Error("Expected the dead-pid helper to have a pid.");
  const pid = child.pid;
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => resolve());
  });
  return pid;
}

test("plan classifies and up adopts without duplicating worlds", async ({ evidence }) => {
  const root = await mkdtemp(join(tmpdir(), "openwork-world-plan-idempotent-"));
  const worldsDirectory = join(root, "worlds");
  const scriptsDirectory = join(root, ".worlds", "scripts");
  const fixtureName = "idempotent-world";
  const fixturePath = join(worldsDirectory, `${fixtureName}.ts`);
  const snapshotPath = join(scriptsDirectory, `${fixtureName}.json`);
  const logPath = join(scriptsDirectory, `${fixtureName}.log`);
  const holdUrl = pathToFileURL(join(REPO_ROOT, "packages", "world", "src", "hold.ts")).href;
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
    await mkdir(scriptsDirectory, { recursive: true });
    const fixtureSource = `
import { createServer } from "node:http";
import { hold } from ${JSON.stringify(holdUrl)};

export async function main(): Promise<void> {
  await using stack = new AsyncDisposableStack();
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  stack.use({
    async [Symbol.asyncDispose](): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected an assigned TCP address.");
  await hold({ outputs: { url: \`http://127.0.0.1:\${address.port}\` } });
}

if (import.meta.main) await main();
`;
    await writeFile(fixturePath, fixtureSource, "utf8");

    const initialPlan = await run(["plan", fixturePath]);
    assert.equal(initialPlan.code, 0, initialPlan.lines.join("\n"));
    assert.deepEqual(initialPlan.lines, ["+ create", `receipt  ${snapshotPath}`]);
    assert.equal(await exists(snapshotPath), false);
    assert.deepEqual(await readdir(scriptsDirectory), []);
    evidence.recordAssertionEvidence(
      "Plan reports create without mutating snapshots",
      "Before launch, plan printed the exact create classification and receipt path while leaving the receipt absent and snapshot directory empty.",
      true,
    );

    const firstUp = await run(["up", fixturePath, "--detach", "--timeout", "10000"]);
    assert.equal(firstUp.code, 0, firstUp.lines.join("\n"));
    const first = await readScriptWorldSnapshot(snapshotPath);
    assert.ok(first);
    launchedPids.add(first.pid);
    assert.equal(first.version, 2);
    assert.match(first.recipeHash ?? "", /^sha256:[0-9a-f]{64}$/);
    const firstProbe = await probe(first.outputs.url);
    assert.deepEqual(firstProbe, { status: 200, body: "ok" });
    evidence.recordAssertionEvidence(
      "First up records a hashed live recipe",
      "The first detached launch wrote a version-2 receipt with a sha256 recipe hash and exposed an HTTP 200 endpoint.",
      true,
    );

    const runningPlan = await run(["plan", fixturePath]);
    assert.equal(runningPlan.code, 0, runningPlan.lines.join("\n"));
    assert.deepEqual(runningPlan.lines, [
      "• running (attachable)",
      `receipt  ${snapshotPath}`,
      `url  ${first.outputs.url}`,
    ]);
    evidence.recordAssertionEvidence(
      "Plan identifies an attachable matching runtime",
      "With the hashed process alive, plan printed the exact running classification, receipt path, and URL output line.",
      true,
    );

    const secondUp = await run(["up", fixturePath, "--detach", "--timeout", "10000"]);
    assert.equal(secondUp.code, 0, secondUp.lines.join("\n"));
    assert.match(secondUp.lines.join("\n"), /World ".*" is already running \(pid \d+\); adopted\./);
    const adopted = await readScriptWorldSnapshot(snapshotPath);
    assert.ok(adopted);
    assert.equal(adopted.pid, first.pid);
    assert.equal(adopted.outputs.url, first.outputs.url);
    assert.deepEqual(await probe(adopted.outputs.url), firstProbe);
    assert.deepEqual((await readdir(scriptsDirectory)).sort(), [
      `${fixtureName}.json`,
      `${fixtureName}.log`,
    ]);
    assert.equal(await exists(logPath), true);
    evidence.recordAssertionEvidence(
      "Identical up adopts without duplication",
      "A second identical up printed the adopted message, retained the original pid, URL, body, and port, and left exactly the original receipt/log pair.",
      true,
    );

    await appendFile(fixturePath, "\n// recipe hash change\n", "utf8");
    const stalePlan = await run(["plan", fixturePath]);
    assert.equal(stalePlan.code, 0, stalePlan.lines.join("\n"));
    assert.deepEqual(stalePlan.lines, [
      "~ stale (recipe changed)",
      `receipt  ${snapshotPath}`,
      `url  ${first.outputs.url}`,
    ]);
    const changedUp = await run(["up", fixturePath, "--detach", "--timeout", "10000"]);
    assert.equal(changedUp.code, 1, changedUp.lines.join("\n"));
    assert.deepEqual(changedUp.lines, [
      `World "${fixtureName}" is running but its recipe changed; run pnpm world down ${fixtureName} first.`,
    ]);
    assert.equal(isProcessAlive(first.pid), true);
    assert.deepEqual(await probe(first.outputs.url), { status: 200, body: "ok" });
    evidence.recordAssertionEvidence(
      "Recipe changes are reported without replacing the runtime",
      "Plan printed the exact stale classification and up rejected with the exact recipe-changed message while the original pid and HTTP endpoint remained live.",
      true,
    );

    const firstDown = await run(["down", fixtureName]);
    assert.equal(firstDown.code, 0, firstDown.lines.join("\n"));
    assert.deepEqual(firstDown.lines, [`World "${fixtureName}" torn down.`]);
    await eventually(async () => !isProcessAlive(first.pid) && await probe(first.outputs.url) === "rejected", {
      within: 10_000,
      intervalMs: 50,
      label: "original idempotent fixture stops",
    });
    const deadPid = await exitedNodePid();
    assert.equal(isProcessAlive(deadPid), false);
    await writeFile(snapshotPath, `${JSON.stringify({
      version: 2,
      kind: "script",
      name: fixtureName,
      createdAt: new Date().toISOString(),
      pid: deadPid,
      sourcePath: fixturePath,
      outputs: { url: first.outputs.url },
      recipeHash: first.recipeHash,
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    const orphanPlan = await run(["plan", fixturePath]);
    assert.equal(orphanPlan.code, 0, orphanPlan.lines.join("\n"));
    assert.deepEqual(orphanPlan.lines, [
      "- orphaned (stale receipt, will recreate)",
      `receipt  ${snapshotPath}`,
      `url  ${first.outputs.url}`,
    ]);
    assert.equal(await exists(snapshotPath), true);

    await writeFile(fixturePath, fixtureSource, "utf8");
    const recreatedUp = await run(["up", fixturePath, "--detach", "--timeout", "10000"]);
    assert.equal(recreatedUp.code, 0, recreatedUp.lines.join("\n"));
    assert.equal(recreatedUp.lines[0], `Removed stale world receipt "${fixtureName}" (pid ${deadPid}); recreating.`);
    const recreated = await readScriptWorldSnapshot(snapshotPath);
    assert.ok(recreated);
    launchedPids.add(recreated.pid);
    assert.notEqual(recreated.pid, first.pid);
    assert.notEqual(recreated.pid, deadPid);
    assert.equal(isProcessAlive(recreated.pid), true);
    assert.deepEqual(await probe(recreated.outputs.url), { status: 200, body: "ok" });
    evidence.recordAssertionEvidence(
      "Orphan planning is read-only and up recreates stale state",
      "After teardown, plan classified a hand-written dead-pid receipt as orphaned without removing it; restored-source up printed stale removal and launched a distinct live pid.",
      true,
    );

    const finalDown = await run(["down", fixtureName]);
    assert.equal(finalDown.code, 0, finalDown.lines.join("\n"));
    assert.deepEqual(finalDown.lines, [`World "${fixtureName}" torn down.`]);
    const missingDown = await run(["down", fixtureName]);
    assert.equal(missingDown.code, 1, missingDown.lines.join("\n"));
    assert.deepEqual(missingDown.lines, [`World receipt "${fixtureName}" does not exist.`]);
    evidence.recordAssertionEvidence(
      "Final teardown is idempotently observable",
      "The recreated world tore down successfully, and a second down returned exit 1 with the exact missing-receipt message.",
      true,
    );
  } finally {
    delete process.env.OPENWORK_WORLD_STAGE;
    try {
      const snapshot = await readScriptWorldSnapshot(snapshotPath);
      if (snapshot && isProcessAlive(snapshot.pid)) {
        await main(["down", fixtureName], { ...options, print: () => {} });
      }
    } catch {}
    for (const pid of launchedPids) {
      if (!isProcessAlive(pid)) continue;
      try { process.kill(pid, "SIGKILL"); } catch {}
      try {
        await eventually(() => !isProcessAlive(pid), {
          within: 2_000,
          intervalMs: 25,
          label: "idempotent fixture cleanup",
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
