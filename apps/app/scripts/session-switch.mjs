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

function getMessageSessionId(message) {
  if (message && typeof message.sessionID === "string") return message.sessionID;
  if (message && message.info && typeof message.info.sessionID === "string") return message.info.sessionID;
  return null;
}

function extractLastText(messages) {
  const list = Array.isArray(messages) ? messages.slice() : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const msg = list[i];
    const parts = Array.isArray(msg?.parts) ? msg.parts : [];
    for (let p = parts.length - 1; p >= 0; p -= 1) {
      const part = parts[p];
      if (part && part.type === "text" && typeof part.text === "string") {
        return part.text;
      }
    }
  }
  return null;
}

try {
  const client = makeClient({ baseUrl: server.baseUrl, directory: server.cwd });
  await waitForHealthy(client);

  let sessionA;
  let sessionB;

  await step("session.create A", async () => {
    sessionA = await client.session.create({ title: "OpenWork session A" });
    assert.ok(sessionA?.id);
    return { id: sessionA.id };
  });

  await step("session.create B", async () => {
    sessionB = await client.session.create({ title: "OpenWork session B" });
    assert.ok(sessionB?.id);
    return { id: sessionB.id };
  });

  await step("session.prompt A", async () => {
    await client.session.prompt({
      sessionID: sessionA.id,
      noReply: true,
      parts: [{ type: "text", text: "Hello from session A" }],
    });
    return { sessionID: sessionA.id };
  });

  await step("session.prompt B", async () => {
    await client.session.prompt({
      sessionID: sessionB.id,
      noReply: true,
      parts: [{ type: "text", text: "Hello from session B" }],
    });
    return { sessionID: sessionB.id };
  });

  await step("session.messages A", async () => {
    const messages = await client.session.messages({ sessionID: sessionA.id, limit: 50 });
    assert.ok(Array.isArray(messages));
    for (const msg of messages) {
      const msgSessionId = getMessageSessionId(msg);
      assert.equal(msgSessionId, sessionA.id);
    }
    const text = extractLastText(messages);
    assert.ok(text && text.includes("session A"));
    return { count: messages.length };
  });

  await step("session.messages B", async () => {
    const messages = await client.session.messages({ sessionID: sessionB.id, limit: 50 });
    assert.ok(Array.isArray(messages));
    for (const msg of messages) {
      const msgSessionId = getMessageSessionId(msg);
      assert.equal(msgSessionId, sessionB.id);
    }
    const text = extractLastText(messages);
    assert.ok(text && text.includes("session B"));
    return { count: messages.length };
  });

  await step("session.messages switch", async () => {
    const [messagesA, messagesB] = await Promise.all([
      client.session.messages({ sessionID: sessionA.id, limit: 50 }),
      client.session.messages({ sessionID: sessionB.id, limit: 50 }),
    ]);

    const textA = extractLastText(messagesA);
    const textB = extractLastText(messagesB);

    assert.ok(textA && textA.includes("session A"));
    assert.ok(textB && textB.includes("session B"));

    return { aCount: messagesA.length, bCount: messagesB.length };
  });

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
