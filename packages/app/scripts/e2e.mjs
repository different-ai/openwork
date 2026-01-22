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
const requireAi = args.get("require-ai") === "true";

const port = await findFreePort();
const server = await spawnOpencodeServe({ directory, port });

const results = {
  ok: true,
  baseUrl: server.baseUrl,
  directory: server.cwd,
  steps: [],
};

function step(name, fn) {
  results.steps.push({ name, status: "running" });
  const idx = results.steps.length - 1;

  return Promise.resolve()
    .then(fn)
    .then((data) => {
      results.steps[idx] = { name, status: "ok", data };
    })
    .catch((e) => {
      results.ok = false;
      results.steps[idx] = {
        name,
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      };
      throw e;
    });
}

try {
  const client = makeClient({ baseUrl: server.baseUrl, directory: server.cwd });

  await step("health", async () => {
    const health = await waitForHealthy(client);
    return health;
  });

  await step("path.get", async () => {
    const path = await client.path.get();
    assert.ok(typeof path.directory === "string");
    return path;
  });

  let sessionId;

  await step("session.create", async () => {
    const session = await client.session.create({ title: "OpenWork e2e" });
    sessionId = session.id;
    assert.ok(sessionId);
    return { id: session.id, title: session.title };
  });

  await step("session.list", async () => {
    const sessions = await client.session.list({ limit: 50 });
    assert.ok(Array.isArray(sessions));
    assert.ok(sessions.some((s) => s.id === sessionId));
    return { count: sessions.length };
  });

  await step("session.messages (initial)", async () => {
    const msgs = await client.session.messages({ sessionID: sessionId, limit: 50 });
    assert.ok(Array.isArray(msgs));
    return { count: msgs.length };
  });

  await step("session.prompt noReply", async () => {
    await client.session.prompt({
      sessionID: sessionId,
      noReply: true,
      parts: [{ type: "text", text: "OpenWork e2e context injection" }],
    });
    const msgs = await client.session.messages({ sessionID: sessionId, limit: 50 });
    assert.ok(Array.isArray(msgs));
    return { count: msgs.length };
  });

  await step("session.todo", async () => {
    const todos = await client.session.todo({ sessionID: sessionId });
    assert.ok(Array.isArray(todos));
    return { count: todos.length };
  });

  await step("event.subscribe", async () => {
    const controller = new AbortController();
    const sub = await client.event.subscribe(undefined, { signal: controller.signal });
    const events = [];

    const reader = (async () => {
      try {
        for await (const raw of sub.stream) {
          const evt = normalizeEvent(raw);
          if (!evt) continue;
          events.push(evt);
          if (events.length >= 10) break;
        }
      } catch {
        // Ignore abort errors.
      }
    })();

    // Trigger events.
    await client.session.update({ sessionID: sessionId, title: "OpenWork e2e (updated)" });

    await new Promise((r) => setTimeout(r, 1200));

    controller.abort();
    await Promise.race([reader, new Promise((r) => setTimeout(r, 500))]);

    assert.ok(events.length > 0, "expected at least one SSE event");

    return {
      types: Array.from(new Set(events.map((e) => e.type))),
      sample: events.slice(0, 3),
    };
  });

  if (requireAi) {
    await step("AI run (optional)", async () => {
      // This requires provider credentials configured for the opencode server.
      await client.session.prompt({
        sessionID: sessionId,
        parts: [{ type: "text", text: "Say hello in one sentence." }],
      });
      const msgs = await client.session.messages({ sessionID: sessionId, limit: 50 });
      return { messagesCount: msgs.length };
    });
  } else {
    results.steps.push({
      name: "AI run (optional)",
      status: "skipped",
      note: "Run with --require-ai true to force an actual model call.",
    });
  }

  console.log(JSON.stringify(results, null, 2));
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  results.ok = false;
  results.error = message;
  results.stderr = server.getStderr();
  console.error(JSON.stringify(results, null, 2));
  process.exitCode = 1;
} finally {
  await server.close();
}
