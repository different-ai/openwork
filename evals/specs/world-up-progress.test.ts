import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

function assertInOrder(lines: string[], predicates: Array<(line: string) => boolean>): void {
  let index = -1;
  for (const predicate of predicates) {
    index = lines.findIndex((line, candidate) => candidate > index && predicate(line));
    assert.notEqual(index, -1, lines.join("\n"));
  }
}

test("world up narrates each step, stalls, failures, and attach replays them", async ({ evidence }) => {
  const root = await mkdtemp(join(tmpdir(), "openwork-world-up-progress-"));
  const worldsDirectory = join(root, "worlds");
  const scriptsDirectory = join(root, ".worlds", "scripts");
  const fixtureName = "progress-world";
  const stage = "ui";
  const stagedName = `${fixtureName}--${stage}`;
  const fixturePath = join(worldsDirectory, `${fixtureName}.ts`);
  const receiptPath = join(scriptsDirectory, `${stagedName}.json`);
  const logPath = join(scriptsDirectory, `${stagedName}.log`);
  const recipeUrl = pathToFileURL(join(REPO_ROOT, "evals", "packages", "env", "src", "recipe.ts")).href;
  const previousSnapshotDirectory = process.env.OPENWORK_WORLD_SNAPSHOT_DIR;
  const previousHeartbeat = process.env.OPENWORK_WORLD_HEARTBEAT_MS;
  const previousStall = process.env.OPENWORK_WORLD_STUB_STALL_MS;
  const previousFail = process.env.OPENWORK_WORLD_STUB_FAIL;
  const launchedPids = new Set<number>();
  let printed: string[] = [];
  let narrated: string[] = [];

  const options: WorldCliOptions = {
    cwd: root,
    worldsDirectory,
    print: (line) => printed.push(line),
    progress: (line) => narrated.push(line),
    preflight: [
      { id: "fake-ok", label: "fake-ok", run: async () => ({ ok: true }) },
      {
        id: "fake-bad",
        label: "fake-bad",
        run: async () => ({ ok: false, detail: "127.0.0.1:1 refused", hint: "start fake" }),
      },
    ],
  };
  const run = async (argv: string[]): Promise<number> => {
    printed.length = 0;
    narrated.length = 0;
    return main(argv, options);
  };

  try {
    process.env.OPENWORK_WORLD_SNAPSHOT_DIR = scriptsDirectory;
    process.env.OPENWORK_WORLD_HEARTBEAT_MS = "300";
    process.env.OPENWORK_WORLD_STUB_STALL_MS = "1200";
    delete process.env.OPENWORK_WORLD_STUB_FAIL;
    await mkdir(worldsDirectory);
    await writeFile(fixturePath, `
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recipe, runRecipe } from ${JSON.stringify(recipeUrl)};

const world = recipe(${JSON.stringify(fixtureName)}, async (tools) => {
  const a = tools.progress.step("alpha", "Alpha");
  await a.ok("fast");
  const dir = await mkdtemp(join(tmpdir(), "openwork-progress-"));
  await tools.track({ kind: "tmpdir", id: dir, label: "scratch" });
  tools.stack.use({
    async [Symbol.asyncDispose](): Promise<void> {
      await rm(dir, { recursive: true, force: true });
    },
  });
  const b = tools.progress.step("beta", "Beta");
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.OPENWORK_WORLD_STUB_STALL_MS ?? "0")));
  if (process.env.OPENWORK_WORLD_STUB_FAIL === "1") {
    await b.fail("beta exploded");
    throw new Error("beta exploded");
  }
  await b.ok("done");
  return { url: "http://127.0.0.1:1" };
});

export default world;
if (import.meta.main) await runRecipe(world);
`, "utf8");

    const upCode = await run(["up", fixturePath, "--detach", "--stage", stage, "--timeout", "10000"]);
    assert.equal(upCode, 0, [...narrated, ...printed].join("\n"));
    assertInOrder(narrated, [
      (line) => line === `world  ${stagedName}  stage ${stage}`,
      (line) => line === "preflight  node ✔  fake-ok ✔  fake-bad ✖",
      (line) => line === "⚠ fake-bad 127.0.0.1:1 refused — start fake",
      (line) => line === "▸ Alpha",
      (line) => line.startsWith("✔ Alpha"),
      (line) => line.startsWith("+ tmpdir  scratch "),
      (line) => line === "▸ Beta",
      (line) => line.startsWith("… still waiting on \"Beta\""),
      (line) => line.startsWith("✔ Beta"),
      (line) => line.startsWith(`✔ ${stagedName} is up`),
      (line) => line === "url  http://127.0.0.1:1",
      (line) => line.includes(`pnpm world down ${fixtureName} --stage ${stage}`),
    ]);
    assert.equal([...narrated, ...printed].some((line) => line.includes("\u001b")), false);
    assert.deepEqual(printed, [
      "url  http://127.0.0.1:1",
      `snapshot  ${receiptPath}`,
      `log  ${logPath}`,
    ]);
    assert.equal(await exists(receiptPath), true);
    const snapshot = await readScriptWorldSnapshot(receiptPath);
    assert.ok(snapshot);
    launchedPids.add(snapshot.pid);
    evidence.recordAssertionEvidence(
      "Detached up narrates preflight, progress, resources, stalls, and readiness",
      "Up exited 0 despite the warning, emitted every exact plain-mode milestone in order without ANSI, created a receipt, and kept stdout to the URL, snapshot, and log lines.",
      true,
    );

    const attachCode = await run(["attach", fixtureName, "--stage", stage]);
    assert.equal(attachCode, 0, [...narrated, ...printed].join("\n"));
    assertInOrder(narrated, [
      (line) => line === "▸ Alpha",
      (line) => line.startsWith("✔ Alpha"),
      (line) => line === "▸ Beta",
      (line) => line.startsWith("✔ Beta"),
      (line) => line.startsWith(`✔ ${stagedName} is up`),
      (line) => line === "url  http://127.0.0.1:1",
    ]);
    assert.equal(printed.length, 0);
    assert.equal(narrated.some((line) => line.includes("\u001b")), false);
    evidence.recordAssertionEvidence(
      "Attach replays completed progress through the ready block",
      "Plain attach exited 0, replayed Alpha and Beta in order through the ready URL, printed nothing to stdout, and emitted no ANSI.",
      true,
    );

    const downCode = await run(["down", fixtureName, "--stage", stage]);
    assert.equal(downCode, 0, printed.join("\n"));
    assert.equal(await exists(receiptPath), false);

    process.env.OPENWORK_WORLD_STUB_FAIL = "1";
    process.env.OPENWORK_WORLD_STUB_STALL_MS = "0";
    const failedCode = await run(["up", fixturePath, "--detach", "--stage", stage, "--timeout", "10000"]);
    assert.equal(failedCode, 1, [...narrated, ...printed].join("\n"));
    const failedStep = narrated.findIndex((line) => line === "✖ Beta — beta exploded");
    const failedWorld = narrated.findIndex((line) => line.startsWith(`✖ ${stagedName} failed`));
    const lastLog = narrated.findIndex((line) => line.startsWith(`last `) && line.endsWith(` lines of ${logPath}:`));
    const indentedError = narrated.findIndex((line, index) => index > lastLog && line.startsWith("  ") && line.includes("beta exploded"));
    assert.ok(failedStep !== -1 && failedWorld > failedStep && lastLog > failedWorld && indentedError > lastLog, narrated.join("\n"));
    assert.equal(narrated.some((line) => line.includes("is up")), false);
    assert.equal(printed.includes(`Script world "${stagedName}" exited before creating its snapshot.`), true);
    assert.equal(await exists(receiptPath), false);
    evidence.recordAssertionEvidence(
      "A failed step narrates failure context without readiness or a receipt",
      "The failed launch exited 1, emitted the exact Beta failure before the world failure and indented beta-exploded log context, never said is up, printed the early-exit line, and created no receipt.",
      true,
    );

    delete process.env.OPENWORK_WORLD_STUB_FAIL;
    const missingAttachCode = await run(["attach", fixtureName, "--stage", stage]);
    assert.equal(missingAttachCode, 1, printed.join("\n"));
    assert.deepEqual(printed, [`World receipt "${stagedName}" does not exist.`]);
    assert.deepEqual(narrated, []);
    evidence.recordAssertionEvidence(
      "Attach reports the missing failed-world receipt",
      "After failure left no receipt, attach exited 1 with only the exact missing-receipt stdout line and no progress narration.",
      true,
    );
  } finally {
    delete process.env.OPENWORK_WORLD_STUB_FAIL;
    try {
      const snapshot = await readScriptWorldSnapshot(receiptPath);
      if (snapshot) {
        launchedPids.add(snapshot.pid);
        await main(["down", fixtureName, "--stage", stage, "--purge"], { ...options, print: () => {}, progress: () => {} });
      }
    } catch {}
    for (const pid of launchedPids) {
      if (!isProcessAlive(pid)) continue;
      try { process.kill(pid, "SIGKILL"); } catch {}
      try {
        await eventually(() => !isProcessAlive(pid), {
          within: 5_000,
          intervalMs: 25,
          label: "progress world cleanup",
        });
      } catch {}
    }
    if (previousSnapshotDirectory === undefined) delete process.env.OPENWORK_WORLD_SNAPSHOT_DIR;
    else process.env.OPENWORK_WORLD_SNAPSHOT_DIR = previousSnapshotDirectory;
    if (previousHeartbeat === undefined) delete process.env.OPENWORK_WORLD_HEARTBEAT_MS;
    else process.env.OPENWORK_WORLD_HEARTBEAT_MS = previousHeartbeat;
    if (previousStall === undefined) delete process.env.OPENWORK_WORLD_STUB_STALL_MS;
    else process.env.OPENWORK_WORLD_STUB_STALL_MS = previousStall;
    if (previousFail === undefined) delete process.env.OPENWORK_WORLD_STUB_FAIL;
    else process.env.OPENWORK_WORLD_STUB_FAIL = previousFail;
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
