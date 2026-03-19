import assert from "node:assert/strict";

import {
  findFreePort,
  makeClient,
  normalizeEvent,
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

  const events = [];
  const controller = new AbortController();
  const sub = await client.event.subscribe(undefined, { signal: controller.signal });

  const reader = (async () => {
    try {
      for await (const raw of sub.stream) {
        const evt = normalizeEvent(raw);
        if (!evt) continue;
        events.push(evt);
        if (events.length >= 25) break;
      }
    } catch {
      // Ignore abort errors.
    }
  })();

  // Trigger something that should emit events.
  const created = await client.session.create({ title: "OpenWork events test" });

  // Wait briefly to collect events.
  await new Promise((r) => setTimeout(r, 1200));

  controller.abort();
  await Promise.race([reader, new Promise((r) => setTimeout(r, 500))]);

  // We expect to see at least one server or session event.
  assert.ok(events.length > 0, "expected SSE events");
  const types = new Set(events.map((e) => e.type));

  console.log(
    JSON.stringify({
      ok: true,
      baseUrl: server.baseUrl,
      createdSessionId: created.id,
      eventTypes: Array.from(types),
      sample: events.slice(0, 5),
    }),
  );
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  console.error(JSON.stringify({ ok: false, error: message, stderr: server.getStderr() }));
  process.exitCode = 1;
} finally {
  await server.close();
}
