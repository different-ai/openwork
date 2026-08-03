#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderCollectionHtml, scanRolls } from "../src/index.ts";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const resultsDir = join(repoRoot, "evals", "results");
const rollsDir = join(resultsDir, "rolls");

const args = process.argv.slice(2);
const shouldOpen = args.includes("--open");
const unknown = args.filter((arg) => arg !== "--open");
if (unknown.length > 0) throw new Error(`Unknown argument: ${unknown[0]}`);

await mkdir(rollsDir, { recursive: true });
const entries = await scanRolls(resultsDir);
const indexPath = join(rollsDir, "index.html");
await writeFile(indexPath, renderCollectionHtml(entries), "utf8");
process.stdout.write(`${indexPath}\n`);

if (shouldOpen) {
  if (process.platform !== "darwin") throw new Error("--open is only supported on darwin.");
  const opened = spawnSync("open", [indexPath], { stdio: "inherit" });
  if (opened.error || opened.status !== 0) throw opened.error ?? new Error(`open exited ${opened.status}`);
}
