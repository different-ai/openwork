import assert from "node:assert/strict";

import { findFreePort, makeClient, parseArgs, spawnOpencodeServe, waitForHealthy } from "./_util.mjs";

const args = parseArgs(process.argv.slice(2));
const directory = args.get("dir") ?? process.cwd();

const port = await findFreePort();
const server = await spawnOpencodeServe({
  directory,
  port,
});

try {
  const client = makeClient({ baseUrl: server.baseUrl, directory: server.cwd });
  const health = await waitForHealthy(client);
  console.log(JSON.stringify({ ok: true, baseUrl: server.baseUrl, directory: server.cwd, health }));
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  console.error(JSON.stringify({ ok: false, error: message, stderr: server.getStderr() }));
  process.exitCode = 1;
} finally {
  await server.close();
}
