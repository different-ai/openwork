import assert from "node:assert/strict";

import {
  findFreePort,
  makeClient,
  parseArgs,
  spawnOpencodeServe,
  waitForHealthy,
} from "./_util.mjs";

const args = parseArgs(process.argv.slice(2));
const directory = args.get("dir") ?? process.cwd();
const baseUrlOverride = args.get("baseUrl") ?? null;
const count = Number.parseInt(args.get("count") ?? "2", 10);
const sessionIdOverride = args.get("session") ?? null;

const withTiming = async (label, fn) => {
  const start = Date.now();
  try {
    const result = await fn();
    const elapsed = Date.now() - start;
    return { ok: true, label, elapsed, result };
  } catch (error) {
    const elapsed = Date.now() - start;
    return { ok: false, label, elapsed, error: error instanceof Error ? error.message : String(error) };
  }
};

let server = null;

try {
  if (!baseUrlOverride) {
    const port = await findFreePort();
    server = await spawnOpencodeServe({ directory, port });
  }

  const baseUrl = baseUrlOverride ?? server.baseUrl;
  const client = makeClient({ baseUrl, directory: server?.cwd ?? directory });

  await waitForHealthy(client);

  console.log(
    JSON.stringify({
      ok: true,
      baseUrl,
      directory: server?.cwd ?? directory,
      count,
      sessionIdOverride,
    }),
  );

  for (let i = 0; i < count; i += 1) {
    console.log(`\n=== Iteration ${i + 1}/${count} ===`);

    const health = await withTiming("global.health", async () => client.global.health());
    console.log(JSON.stringify(health));

    let sessionId = sessionIdOverride;
    if (!sessionId) {
      const create = await withTiming("session.create", async () =>
        client.session.create({ title: `Debug session ${i + 1}`, directory }),
      );
      console.log(JSON.stringify(create));
      assert.ok(create.ok, "session.create failed");
      sessionId = create.result.id;
    }

    const list = await withTiming("session.list", async () => client.session.list({ limit: 50 }));
    console.log(JSON.stringify(list));

    const messages = await withTiming("session.messages", async () =>
      client.session.messages({ sessionID: sessionId, limit: 50 }),
    );
    console.log(JSON.stringify(messages));

    const todos = await withTiming("session.todo", async () => client.session.todo({ sessionID: sessionId }));
    console.log(JSON.stringify(todos));

    const permissions = await withTiming("permission.list", async () => client.permission.list());
    console.log(JSON.stringify(permissions));
  }
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  console.error(JSON.stringify({ ok: false, error: message, stderr: server?.getStderr?.() ?? null }));
  process.exitCode = 1;
} finally {
  if (server) {
    await server.close();
  }
}
