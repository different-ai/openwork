import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

test("detached script worlds own one runtime through launch, isolation, and graceful teardown", async ({ evidence }) => {
  const root = await mkdtemp(join(tmpdir(), "openwork-script-world-lifecycle-"));
  const worldsDirectory = join(root, "worlds");
  const scriptsDirectory = join(root, ".worlds", "scripts");
  const fixtureName = "healthy-world";
  const fixturePath = join(root, `${fixtureName}.ts`);
  const failingName = "fails-before-hold";
  const failingPath = join(root, `${failingName}.ts`);
  const snapshotPath = join(scriptsDirectory, `${fixtureName}.json`);
  const failingSnapshotPath = join(scriptsDirectory, `${failingName}.json`);
  const sentinelPath = join(root, "disposed.txt");
  const markerPath = join(scriptsDirectory, "unrelated.marker");
  const sentinelText = "gracefully disposed\n";
  const markerText = "keep this file\n";
  const holdUrl = pathToFileURL(join(REPO_ROOT, "packages", "world", "src", "hold.ts")).href;
  const previousSnapshotDirectory = process.env.OPENWORK_WORLD_SNAPSHOT_DIR;
  let launchedPid: number | undefined;
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
    await mkdir(worldsDirectory);
    await writeFile(fixturePath, `
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
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
      await writeFile(${JSON.stringify(sentinelPath)}, ${JSON.stringify(sentinelText)}, "utf8");
    },
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected an assigned TCP address.");
  await hold({ outputs: { url: \`http://127.0.0.1:\${address.port}\` } });
}

if (import.meta.main) await main();
`, "utf8");
    await writeFile(failingPath, `
import { hold } from ${JSON.stringify(holdUrl)};

export async function main(): Promise<void> {
  if (typeof hold !== "function") throw new Error("hold import failed");
  throw new Error("fixture failed before hold");
}

if (import.meta.main) await main();
`, "utf8");

    const upCommand = ["up", fixturePath, "--detach", "--timeout", "10000"];
    const launched = await run(upCommand);
    assert.equal(launched.code, 0, launched.lines.join("\n"));
    const jsonSnapshots = (await readdir(scriptsDirectory)).filter((name) => name.endsWith(".json"));
    assert.deepEqual(jsonSnapshots, [`${fixtureName}.json`]);
    const snapshot = await readScriptWorldSnapshot(snapshotPath);
    assert.ok(snapshot);
    launchedPid = snapshot.pid;
    assert.equal(snapshot.kind, "script");
    assert.equal(snapshot.name, fixtureName);
    assert.equal(isProcessAlive(snapshot.pid), true);
    assert.equal(typeof snapshot.outputs.url, "string");
    assert.equal(await exists(sentinelPath), false);
    assert.equal(await probe(snapshot.outputs.url), 200);

    const duplicate = await run(upCommand);
    assert.equal(duplicate.code, 1);
    assert.match(duplicate.lines.join("\n"), /already running.*world down healthy-world.*first/is);
    const afterDuplicate = await readScriptWorldSnapshot(snapshotPath);
    assert.ok(afterDuplicate);
    assert.equal(afterDuplicate.pid, launchedPid);
    assert.equal(await probe(snapshot.outputs.url), 200);
    assert.equal(await exists(sentinelPath), false);

    const listed = await run(["list"]);
    assert.equal(listed.code, 0, listed.lines.join("\n"));
    assert.match(listed.lines.join("\n"), /healthy-world\s+.*\s+script\s+alive/);
    assert.deepEqual(
      (await readdir(scriptsDirectory)).filter((name) => name.endsWith(".json")),
      [`${fixtureName}.json`],
    );

    const unknownDown = await run(["down", "unknown-name"]);
    assert.equal(unknownDown.code, 1);
    assert.match(unknownDown.lines.join("\n"), /World receipt "unknown-name" does not exist/);
    assert.equal(await exists(snapshotPath), true);
    assert.equal(await probe(snapshot.outputs.url), 200);
    assert.equal(await exists(sentinelPath), false);

    await writeFile(markerPath, markerText, "utf8");
    const down = await run(["down", fixtureName]);
    assert.equal(down.code, 0, down.lines.join("\n"));
    assert.match(down.lines.join("\n"), /World "healthy-world" torn down/);
    await eventually(async () => {
      return !isProcessAlive(snapshot.pid)
        && await probe(snapshot.outputs.url) !== 200
        && await exists(sentinelPath)
        && !await exists(snapshotPath);
    }, { within: 10_000, intervalMs: 50, label: "script process and HTTP server stop after graceful disposal" });
    assert.equal(isProcessAlive(snapshot.pid), false);
    assert.notEqual(await probe(snapshot.outputs.url), 200);
    assert.equal(await readFile(sentinelPath, "utf8"), sentinelText);
    assert.equal(await exists(snapshotPath), false);
    assert.equal(await readFile(markerPath, "utf8"), markerText);

    const failed = await run(["up", failingPath, "--detach", "--timeout", "10000"]);
    assert.equal(failed.code, 1);
    assert.match(failed.lines.join("\n"), /exited before creating its snapshot/);
    assert.match(failed.lines.join("\n"), /fixture failed before hold/);
    assert.equal(await exists(failingSnapshotPath), false);
    assert.equal(await readFile(sentinelPath, "utf8"), sentinelText);
    assert.equal(await readFile(markerPath, "utf8"), markerText);

    evidence.recordAssertionEvidence(
      "Detached script launch has singular ownership",
      `The ${fixtureName} snapshot was the only JSON snapshot, named the live pid, exposed a responding URL, and had not disposed its stack while running.`,
      true,
    );
    evidence.recordAssertionEvidence(
      "Duplicate launch and unknown teardown are isolated",
      "Both operations failed without replacing the pid, duplicating snapshots, stopping the original probe, or running disposal.",
      true,
    );
    evidence.recordAssertionEvidence(
      "Script teardown gracefully disposes the resource stack",
      "Down waited for process and HTTP shutdown, the disposal sentinel appeared, only the owned snapshot disappeared, and a pre-hold failure left sentinel and marker contents unchanged.",
      true,
    );
  } finally {
    try {
      const snapshot = await readScriptWorldSnapshot(snapshotPath);
      if (snapshot && isProcessAlive(snapshot.pid)) {
        await main(["down", fixtureName], { ...options, print: () => {} });
      }
    } catch {}
    if (launchedPid !== undefined && isProcessAlive(launchedPid)) {
      const pid = launchedPid;
      try { process.kill(pid, "SIGKILL"); } catch {}
      try {
        await eventually(() => !isProcessAlive(pid), {
          within: 2_000,
          intervalMs: 25,
          label: "detached fixture cleanup",
        });
      } catch {}
    }
    if (previousSnapshotDirectory === undefined) delete process.env.OPENWORK_WORLD_SNAPSHOT_DIR;
    else process.env.OPENWORK_WORLD_SNAPSHOT_DIR = previousSnapshotDirectory;
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
