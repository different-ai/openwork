import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import net from "node:net";
import assert from "node:assert/strict";

import { startBridge } from "../dist/bridge.js";
import { BridgeStore } from "../dist/db.js";

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

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("health /send delivers to directory bindings", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owpenbot-health-send-"));
  const dbPath = path.join(dir, "owpenbot.db");
  const store = new BridgeStore(dbPath);
  const healthPort = await freePort();

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

  store.upsertBinding("slack", "default", "D123", dir.replace(/\\/g, "/").replace(/\/+$/, "") || "/");

  const bridge = await startBridge(
    {
      configPath: path.join(dir, "owpenbot.json"),
      configFile: { version: 1 },
      opencodeUrl: "http://127.0.0.1:4096",
      opencodeDirectory: dir,
      telegramBots: [],
      slackApps: [],
      dataDir: dir,
      dbPath,
      logFile: path.join(dir, "owpenbot.log"),
      toolUpdatesEnabled: false,
      groupsEnabled: false,
      permissionMode: "allow",
      toolOutputLimit: 1200,
      healthPort,
      logLevel: "silent",
    },
    createLoggerStub(),
    undefined,
    {
      client: {
        global: {
          health: async () => ({ healthy: true, version: "test" }),
        },
      },
      store,
      adapters: new Map([["slack:default", slackAdapter]]),
      disableEventStream: true,
    },
  );

  const response = await fetch(`http://127.0.0.1:${healthPort}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel: "slack", directory: dir, text: "hello" }),
  });
  assert.equal(response.status, 200);
  const json = await response.json();
  assert.equal(json.ok, true);
  assert.equal(json.sent, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].peerId, "D123");
  assert.equal(sent[0].text, "hello");

  await bridge.stop();
  store.close();
});

test("health /send returns 404 when no bindings exist", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owpenbot-health-send-"));
  const dbPath = path.join(dir, "owpenbot.db");
  const store = new BridgeStore(dbPath);
  const healthPort = await freePort();

  const bridge = await startBridge(
    {
      configPath: path.join(dir, "owpenbot.json"),
      configFile: { version: 1 },
      opencodeUrl: "http://127.0.0.1:4096",
      opencodeDirectory: dir,
      telegramBots: [],
      slackApps: [],
      dataDir: dir,
      dbPath,
      logFile: path.join(dir, "owpenbot.log"),
      toolUpdatesEnabled: false,
      groupsEnabled: false,
      permissionMode: "allow",
      toolOutputLimit: 1200,
      healthPort,
      logLevel: "silent",
    },
    createLoggerStub(),
    undefined,
    {
      client: {
        global: {
          health: async () => ({ healthy: true, version: "test" }),
        },
      },
      store,
      adapters: new Map(),
      disableEventStream: true,
    },
  );

  const response = await fetch(`http://127.0.0.1:${healthPort}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel: "slack", directory: dir, text: "hello" }),
  });
  assert.equal(response.status, 404);
  const json = await response.json();
  assert.equal(json.ok, false);

  await bridge.stop();
  store.close();
});
