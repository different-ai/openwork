import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { receiptName, resolveStage } from "./stage.ts";
import { assertWorldName } from "./store.ts";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

export function defaultScriptWorldSnapshotDirectory(): string {
  return resolve(
    process.env.OPENWORK_WORLD_SNAPSHOT_DIR
      ?? join(REPO_ROOT, "evals", "results", ".worlds", "scripts"),
  );
}

export interface ScriptWorldSnapshot {
  version: 1 | 2;
  kind: "script";
  name: string;
  createdAt: string;
  pid: number;
  sourcePath: string;
  outputs: Record<string, string>;
  stage?: string;
  recipeHash?: string;
  place?: string;
}

export interface HoldOptions {
  name?: string;
  outputs?: Record<string, string>;
  snapshotDir?: string;
}

function recordedPid(text: string): number | undefined {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || !("pid" in value)) return undefined;
  return typeof value.pid === "number" && Number.isInteger(value.pid) && value.pid > 0
    ? value.pid
    : undefined;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function aliveSnapshotPid(path: string): Promise<number | undefined> {
  try {
    const pid = recordedPid(await readFile(path, "utf8"));
    return pid !== undefined && isAlive(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Keep a script world alive until SIGINT or SIGTERM, then release its resources. */
export async function hold(options: HoldOptions = {}): Promise<void> {
  const sourcePath = process.argv[1];
  const name = options.name ?? basename(sourcePath, extname(sourcePath));
  assertWorldName(name);
  const stage = resolveStage(process.env);
  const recipeHash = process.env.OPENWORK_WORLD_RECIPE_HASH;
  const place = process.env.OPENWORK_WORLD_PLACE;
  const stagedName = receiptName(name, stage);

  const snapshotDirectory = resolve(options.snapshotDir ?? defaultScriptWorldSnapshotDirectory());
  const snapshotPath = join(snapshotDirectory, `${stagedName}.json`);
  const existingPid = await aliveSnapshotPid(snapshotPath);
  if (existingPid !== undefined) {
    throw new Error(
      `Script world ${JSON.stringify(stagedName)} is already running (pid ${existingPid}); run \`pnpm world down ${name}${stage ? ` --stage ${stage}` : ""}\` first.`,
    );
  }

  const outputs = options.outputs ?? {};
  const version = stage !== undefined || recipeHash !== undefined || place !== undefined ? 2 : 1;
  const snapshot: ScriptWorldSnapshot = {
    version,
    kind: "script",
    name: stagedName,
    createdAt: new Date().toISOString(),
    pid: process.pid,
    sourcePath,
    outputs,
    ...(stage === undefined ? {} : { stage }),
    ...(recipeHash === undefined ? {} : { recipeHash }),
    ...(place === undefined ? {} : { place }),
  };
  await mkdir(dirname(snapshotPath), { recursive: true });
  await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(snapshotPath, 0o600);

  for (const [key, value] of Object.entries(outputs)) console.log(`${key}  ${value}`);
  console.log(`World ${JSON.stringify(stagedName)} is up. Ctrl-C (or pnpm world down ${name}${stage ? ` --stage ${stage}` : ""}) tears it down.`);

  const keepAlive = setInterval(() => {}, 2_147_483_647);
  await new Promise<void>((done) => {
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      clearInterval(keepAlive);
      void unlink(snapshotPath).then(done, (error: unknown) => {
        console.error(`Could not remove script world snapshot ${snapshotPath}: ${error instanceof Error ? error.message : String(error)}`);
        done();
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
