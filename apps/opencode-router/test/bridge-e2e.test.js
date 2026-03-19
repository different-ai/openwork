import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startBridge } from "../dist/bridge.js";

function createLoggerStub() {
  const base = {
    child() {
      return base;
    },
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
  return base;
}

test("bridge end-to-end: inbound -> prompt -> outbound", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-e2e-"));
  const dbPath = path.join(dir, "opencode-router.db");

  const sent = [];
  const slackAdapter = {
    key: "slack:default",
    name: "slack",
    identityId: "default",
    maxTextLength: 39_000,
    async start() {},
    async stop() {},
    async sendText(peerId, text) {
      sent.push({ peerId, text });
    },
  };

  const fakeClient = {
    global: {
      health: async () => ({ healthy: true, version: "test" }),
    },
    session: {
      create: async () => ({ id: "session-1" }),
      prompt: async () => ({ parts: [{ type: "text", text: "pong" }] }),
    },
  };

  const bridge = await startBridge(
    {
      configPath: path.join(dir, "opencode-router.json"),
      configFile: { version: 1 },
      opencodeUrl: "http://127.0.0.1:4096",
      opencodeDirectory: dir,
      telegramBots: [],
      slackApps: [],
      dataDir: dir,
      dbPath,
      logFile: path.join(dir, "opencode-router.log"),
      toolUpdatesEnabled: false,
      groupsEnabled: false,
      permissionMode: "allow",
      toolOutputLimit: 1200,
      healthPort: undefined,
      logLevel: "silent",
    },
    createLoggerStub(),
    undefined,
    {
      client: fakeClient,
      adapters: new Map([["slack:default", slackAdapter]]),
      disableEventStream: true,
      disableHealthServer: true,
    },
  );

  await bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: "D123", text: "ping", raw: {} });

  assert.equal(sent.length, 2);
  assert.equal(sent[0].peerId, "D123");
  assert.equal(sent[1].peerId, "D123");
  assert.ok(sent[0].text.includes("Session started."));
  assert.equal(sent[1].text, "pong");

  await bridge.stop();
});

test("bridge recovers from empty prompt replies by clearing stale session", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-e2e-empty-"));
  const dbPath = path.join(dir, "opencode-router.db");

  const sent = [];
  let sessionCounter = 0;
  const slackAdapter = {
    key: "slack:default",
    name: "slack",
    identityId: "default",
    maxTextLength: 39_000,
    async start() {},
    async stop() {},
    async sendText(peerId, text) {
      sent.push({ peerId, text });
    },
  };

  const fakeClient = {
    global: {
      health: async () => ({ healthy: true, version: "test" }),
    },
    session: {
      create: async () => {
        sessionCounter += 1;
        return { id: `session-${sessionCounter}` };
      },
      prompt: async ({ sessionID }) => {
        if (sessionID === "session-1") {
          return { parts: [] };
        }
        return { parts: [{ type: "text", text: "fresh reply" }] };
      },
    },
  };

  const bridge = await startBridge(
    {
      configPath: path.join(dir, "opencode-router.json"),
      configFile: { version: 1 },
      opencodeUrl: "http://127.0.0.1:4096",
      opencodeDirectory: dir,
      telegramBots: [],
      slackApps: [],
      dataDir: dir,
      dbPath,
      logFile: path.join(dir, "opencode-router.log"),
      toolUpdatesEnabled: false,
      groupsEnabled: false,
      permissionMode: "allow",
      toolOutputLimit: 1200,
      healthPort: undefined,
      logLevel: "silent",
    },
    createLoggerStub(),
    undefined,
    {
      client: fakeClient,
      adapters: new Map([["slack:default", slackAdapter]]),
      disableEventStream: true,
      disableHealthServer: true,
    },
  );

  await bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: "D123", text: "first", raw: {} });
  await bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: "D123", text: "second", raw: {} });

  assert.equal(sessionCounter, 2);
  assert.ok(
    sent.some((message) =>
      message.text.includes("No visible response was generated. I reset this chat session in case stale state was blocking replies."),
    ),
  );
  assert.ok(sent.some((message) => message.text === "fresh reply"));

  await bridge.stop();
});
