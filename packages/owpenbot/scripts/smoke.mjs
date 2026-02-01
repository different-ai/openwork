import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

const args = new Set(process.argv.slice(2));
const requireReply = args.has("--reply");

const baseUrl = process.env.OPENCODE_URL ?? "http://127.0.0.1:4096";
const directory = process.env.OPENCODE_DIRECTORY ?? process.cwd();

const headers = {};
if (process.env.OPENCODE_SERVER_USERNAME && process.env.OPENCODE_SERVER_PASSWORD) {
  const token = Buffer.from(
    `${process.env.OPENCODE_SERVER_USERNAME}:${process.env.OPENCODE_SERVER_PASSWORD}`,
  ).toString("base64");
  headers.Authorization = `Basic ${token}`;
}

const client = createOpencodeClient({
  baseUrl,
  directory,
  headers: Object.keys(headers).length ? headers : undefined,
  responseStyle: "data",
  throwOnError: true,
});

const health = await client.global.health();
assert.equal(health.healthy, true);

const session = await client.session.create({ title: "owpenbot smoke" });
assert.ok(session?.id);

await client.session.prompt({
  sessionID: session.id,
  noReply: !requireReply,
  parts: [{ type: "text", text: "ping" }],
});

const messages = await client.session.messages({ sessionID: session.id, limit: 20 });
assert.ok(Array.isArray(messages));

console.log(
  JSON.stringify({
    ok: true,
    baseUrl,
    directory,
    sessionID: session.id,
    messageCount: messages.length,
  }),
);
