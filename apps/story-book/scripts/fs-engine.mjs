import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  findFreePort,
  makeClient,
  parseArgs,
  spawnOpencodeServe,
  waitForHealthy,
} from "./_util.mjs";

const args = parseArgs(process.argv.slice(2));
const directory = args.get("dir") ?? process.cwd();

const port = await findFreePort();
const server = await spawnOpencodeServe({ directory, port });

try {
  const client = makeClient({ baseUrl: server.baseUrl, directory: server.cwd });
  await waitForHealthy(client);

  const root = ".openwork/test-engine";
  const nestedDir = path.join(root, "nested");
  const filePath = path.join(root, "hello.txt");

  await mkdir(path.join(directory, nestedDir), { recursive: true });
  await writeFile(path.join(directory, filePath), "openwork engine test\n", "utf8");

  const entries = await client.file.list({ directory, path: root });
  assert.ok(entries.some((entry) => entry.name === "nested" && entry.type === "directory"));
  assert.ok(entries.some((entry) => entry.name === "hello.txt" && entry.type === "file"));

  const read = await client.file.read({ directory, path: filePath });
  assert.equal(read.type, "text");
  assert.ok(read.content.includes("openwork engine test"));

  await rm(path.join(directory, root), { recursive: true, force: true });

  console.log(
    JSON.stringify({
      ok: true,
      baseUrl: server.baseUrl,
      directory: server.cwd,
      root,
    }),
  );
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  console.error(JSON.stringify({ ok: false, error: message, stderr: server.getStderr() }));
  process.exitCode = 1;
} finally {
  await server.close();
}
