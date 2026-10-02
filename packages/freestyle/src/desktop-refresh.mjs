import { readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { inspectDesktop } from "./desktop-state.mjs";

export async function refreshDesktop(sha, {
  head = () => execFileSync("git", ["-C", "/workspace", "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  inspect = inspectDesktop, read = readFile, write = writeFile,
} = {}) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? "") || head() !== sha) throw new Error("Desktop refresh requires the exact checked-out commit");
  await inspect({ reload: true });
  const root = "/opt/openwork-preview";
  const marker = JSON.parse(await read(`${root}/ready-world`, "utf8"));
  await write(`${root}/ready-world`, JSON.stringify({ ...marker, warmedAt: new Date().toISOString() }));
  await write(`${root}/source-sha`, sha);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await refreshDesktop(process.argv[2]);
