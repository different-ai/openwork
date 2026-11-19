import { ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, test, vi } from "vitest";
import { judgeJourneys } from "./judge-journeys.mjs";

vi.mock(import("node:child_process"), async importOriginal => ({
  ...await importOriginal(), spawn: vi.fn(),
}));

async function record(directory: string, name: string, gitSha = "trusted", fileName = "screen.png") {
  const dir = join(directory, name);
  await mkdir(dir);
  await writeFile(join(dir, "screen.png"), "unit");
  await writeFile(join(dir, "test-run.json"), JSON.stringify({ gitSha, artifacts: [{ fileName }] }));
  return dir;
}

test("journeys use two asynchronous workers and drain all records despite failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "journey-judge-"));
  try {
    await Promise.all(["a", "b", "c", "d"].map(name => record(directory, name)));
    const calls: { name: string; finish: (status: number) => void }[] = [];
    let active = 0;
    let maximum = 0;
    const result = judgeJourneys(directory, "trusted", async (path: string) => {
      active++;
      maximum = Math.max(maximum, active);
      try {
        return await new Promise<number>(resolve => calls.push({ name: basename(path), finish: resolve }));
      } finally {
        active--;
      }
    });
    await expect.poll(() => calls.length).toBe(2);
    // A slow first record must not block the other worker's queue.
    calls[1].finish(2);
    await expect.poll(() => calls.length).toBe(3);
    calls[2].finish(1);
    await expect.poll(() => calls.length).toBe(4);
    calls[3].finish(0);
    calls[0].finish(0);
    await expect(result).resolves.toEqual({ count: 4, result: "failure" });
    expect(maximum).toBe(2);
    expect(calls.map(call => call.name).sort()).toEqual(["a", "b", "c", "d"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent journeys still reject foreign SHAs, missing artifacts, traversal and symlink escapes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "journey-trust-"));
  try {
    await record(directory, "allowed");
    await record(directory, "foreign", "foreign");
    await record(directory, "missing", "trusted", "missing.png");
    await record(directory, "traversal", "trusted", "../outside.png");
    const linked = await record(directory, "symlink", "trusted", "escape.png");
    await writeFile(join(directory, "outside.png"), "outside");
    await symlink(join(directory, "outside.png"), join(linked, "escape.png"));
    const run = vi.fn(async () => 0);
    await expect(judgeJourneys(directory, "trusted", run)).resolves.toEqual({ count: 1, result: "incomplete" });
    expect(run).toHaveBeenCalledExactlyOnceWith(join(directory, "allowed"));
    run.mockClear();
    await expect(judgeJourneys(directory, undefined, run)).resolves.toEqual({ count: 0, result: "incomplete" });
    expect(run).not.toHaveBeenCalled();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([0, 1, 2, null])("journey status %s retains success/failure/incomplete semantics", async status => {
  const directory = await mkdtemp(join(tmpdir(), "journey-status-"));
  try {
    await record(directory, "one");
    await expect(judgeJourneys(directory, "trusted", async () => status)).resolves.toEqual({
      count: 1, result: status === 0 ? "success" : status === 1 ? "failure" : "incomplete",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([0, 1, 2, null, "error"])("default subprocess runner waits for completion and maps status %s", async status => {
  const directory = await mkdtemp(join(tmpdir(), "journey-process-"));
  const child = new ChildProcess();
  const spawnMock = vi.mocked(spawn);
  spawnMock.mockClear();
  spawnMock.mockReturnValueOnce(child);
  try {
    const dir = await record(directory, "one");
    const result = judgeJourneys(directory, "trusted");
    await expect.poll(() => spawnMock).toHaveBeenCalledExactlyOnceWith(
      "pnpm", ["--dir", "evals", "evidence:judge", "--", "--test-run", dir], { stdio: "inherit" },
    );
    if (status === "error") child.emit("error", new Error("spawn unavailable"));
    else child.emit("close", status);
    await expect(result).resolves.toEqual({
      count: 1, result: status === 0 ? "success" : status === 1 ? "failure" : "incomplete",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("no records remains incomplete", async () => {
  const directory = await mkdtemp(join(tmpdir(), "journey-empty-"));
  try {
    const run = vi.fn(async () => 0);
    await expect(judgeJourneys(directory, "trusted", run)).resolves.toEqual({ count: 0, result: "incomplete" });
    await expect(judgeJourneys(join(directory, "absent"), "trusted", run)).resolves.toEqual({ count: 0, result: "incomplete" });
    expect(run).not.toHaveBeenCalled();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
