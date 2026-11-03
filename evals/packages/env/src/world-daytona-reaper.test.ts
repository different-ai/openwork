import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { reapLedger, type ExecFn } from "../../../../packages/world/src/reaper.ts";

async function ledger(lines: object[]) {
  const dir = await mkdtemp(join(tmpdir(), "reaper-"));
  const path = join(dir, "ledger.jsonl");
  await writeFile(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return { dir, path };
}

it("world down deletes a leftover Daytona sandbox, and treats an already deleted one as gone", async () => {
  const calls: string[][] = [];
  const exec: ExecFn = async (command, args) => {
    calls.push([command, ...args]);
    if (args[1] === "gone-id") return { code: 1, stdout: "", stderr: "level=fatal msg=\"Not Found: Sandbox with ID or name gone-id not found\"" };
    if (args[1] === "denied-id") return { code: 1, stdout: "", stderr: "level=warning msg=\"Version mismatch\"\nlevel=fatal msg=\"Unauthorized\"" };
    return { code: 0, stdout: "Sandbox deleted", stderr: "" };
  };
  const { dir, path } = await ledger([
    { kind: "daytona", id: "live-id", label: "den", at: "2026-11-03T00:00:00.000Z" },
    { kind: "daytona", id: "gone-id", label: "desktop", at: "2026-11-03T00:00:00.000Z" },
    { kind: "daytona", id: "denied-id", label: "other", at: "2026-11-03T00:00:00.000Z" },
    { kind: "daytona", id: "--force", label: "bad", at: "2026-11-03T00:00:00.000Z" },
  ]);
  const report = await reapLedger(path, { cwd: dir, exec, purge: true });
  expect(report.reaped.map((entry) => entry.id)).toEqual(["live-id"]);
  expect(report.missing.map((entry) => entry.id)).toEqual(["gone-id"]);
  expect(report.skipped.map(({ entry, reason }) => [entry.id, reason])).toEqual([
    ["denied-id", "daytona delete failed: level=fatal msg=\"Unauthorized\""],
    ["--force", "invalid sandbox id"],
  ]);
  // An id that looks like a flag is never passed to the CLI.
  expect(calls.map((call) => call.slice(0, 3))).toEqual([["daytona", "delete", "live-id"], ["daytona", "delete", "gone-id"], ["daytona", "delete", "denied-id"]]);
  expect(await readFile(path, "utf8")).toContain("denied-id");
});
