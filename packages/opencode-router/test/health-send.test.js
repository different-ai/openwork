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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-health-send-"));
  const dbPath = path.join(dir, "opencode-router.db");
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

test("health /send reports no-op when no bindings exist", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-health-send-"));
  const dbPath = path.join(dir, "opencode-router.db");
  const store = new BridgeStore(dbPath);
  const healthPort = await freePort();

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
  assert.equal(response.status, 200);
  const json = await response.json();
  assert.equal(json.ok, true);
  assert.equal(json.attempted, 0);
  assert.equal(json.sent, 0);
  assert.equal(typeof json.reason, "string");

  await bridge.stop();
  store.close();
});

test("health /send can deliver directly with peerId", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-health-send-"));
  const dbPath = path.join(dir, "opencode-router.db");
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
    body: JSON.stringify({ channel: "slack", peerId: "D555", text: "hello-direct" }),
  });
  assert.equal(response.status, 200);
  const json = await response.json();
  assert.equal(json.ok, true);
  assert.equal(json.peerId, "D555");
  assert.equal(json.sent, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].peerId, "D555");
  assert.equal(sent[0].text, "hello-direct");

  await bridge.stop();
  store.close();
});

test("health /send rejects invalid telegram direct peerId", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-health-send-"));
  const dbPath = path.join(dir, "opencode-router.db");
  const store = new BridgeStore(dbPath);
  const healthPort = await freePort();

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
    body: JSON.stringify({ channel: "telegram", peerId: "@hotkartoffel", text: "hello-direct" }),
  });
  assert.equal(response.status, 400);
  const json = await response.json();
  assert.equal(json.ok, false);
  assert.match(String(json.error || ""), /numeric chat_id/i);

  await bridge.stop();
  store.close();
});

test("health /send removes invalid telegram bindings and still sends valid ones", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-health-send-"));
  const dbPath = path.join(dir, "opencode-router.db");
  const store = new BridgeStore(dbPath);
  const healthPort = await freePort();

  const sent = [];
  const telegramAdapter = {
    key: "telegram:default",
    name: "telegram",
    identityId: "default",
    maxTextLength: 39_000,
    async start() {},
    async stop() {},
    async sendText(peerId, text) {
      sent.push({ peerId, text });
    },
  };

  const normalizedDir = dir.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  store.upsertBinding("telegram", "default", "@bad-target", normalizedDir);
  store.upsertBinding("telegram", "default", "351743020", normalizedDir);

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
      adapters: new Map([["telegram:default", telegramAdapter]]),
      disableEventStream: true,
    },
  );

  const response = await fetch(`http://127.0.0.1:${healthPort}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel: "telegram", directory: dir, text: "hello" }),
  });
  assert.equal(response.status, 200);
  const json = await response.json();
  assert.equal(json.ok, true);
  assert.equal(json.attempted, 2);
  assert.equal(json.sent, 1);
  assert.equal(Array.isArray(json.failures), true);
  assert.equal(json.failures.length, 1);
  assert.match(String(json.failures[0].error || ""), /invalid telegram peerid binding removed/i);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].peerId, "351743020");
  assert.equal(sent[0].text, "hello");

  assert.equal(store.getBinding("telegram", "default", "@bad-target"), null);
  assert.notEqual(store.getBinding("telegram", "default", "351743020"), null);

  await bridge.stop();
  store.close();
});
