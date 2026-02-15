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

test("bridge: routes sessions per peer directory binding within workspace", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-multiws-"));
  const wsA = path.join(dir, "ws-a");
  const wsB = path.join(wsA, "project-b");
  fs.mkdirSync(wsA, { recursive: true });
  fs.mkdirSync(wsB, { recursive: true });

  const dbPath = path.join(dir, "opencode-router.db");
  const sent = [];
  const created = [];
  const prompted = [];

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

  const clientFactory = (directory) => {
    const dirLabel = directory;
    return {
      global: {
        health: async () => ({ healthy: true, version: "test" }),
      },
      session: {
        create: async () => {
          created.push(dirLabel);
          return { id: `session-${created.length}` };
        },
        prompt: async () => {
          prompted.push(dirLabel);
          return { parts: [{ type: "text", text: `pong:${path.basename(dirLabel)}` }] };
        },
      },
    };
  };

  const bridge = await startBridge(
    {
      configPath: path.join(dir, "opencode-router.json"),
      configFile: { version: 1 },
      opencodeUrl: "http://127.0.0.1:4096",
      opencodeDirectory: wsA,
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
      clientFactory,
      adapters: new Map([["slack:default", slackAdapter]]),
      disableEventStream: true,
      disableHealthServer: true,
    },
  );

  // Bind peer A to ws-a
  await bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: "D-A", text: `/dir ${wsA}`, raw: {} });
  await bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: "D-A", text: "ping", raw: {} });

  // Bind peer B to ws-b
  await bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: "D-B", text: `/dir ${wsB}`, raw: {} });
  await bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: "D-B", text: "ping", raw: {} });

  // Ensure prompts were routed to different workspace subdirectories
  assert.ok(prompted.includes(wsA));
  assert.ok(prompted.includes(wsB));

  // Ensure output includes per-directory pong
  const output = sent.map((m) => `${m.peerId}:${m.text}`).join("\n");
  assert.ok(output.includes("D-A:pong:ws-a"));
  assert.ok(output.includes("D-B:pong:project-b"));

  await bridge.stop();
});

test("bridge: rejects /dir outside workspace root", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodeRouter-multiws-"));
  const wsA = path.join(dir, "ws-a");
  const outside = path.join(dir, "outside");
  fs.mkdirSync(wsA, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });

  const dbPath = path.join(dir, "opencode-router.db");
  const prompted = [];
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

  const clientFactory = (directory) => ({
    global: { health: async () => ({ healthy: true, version: "test" }) },
    session: {
      create: async () => ({ id: "session-1" }),
      prompt: async () => {
        prompted.push(directory);
        return { parts: [{ type: "text", text: "pong" }] };
      },
    },
  });

  const bridge = await startBridge(
    {
      configPath: path.join(dir, "opencode-router.json"),
      configFile: { version: 1 },
      opencodeUrl: "http://127.0.0.1:4096",
      opencodeDirectory: wsA,
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
      clientFactory,
      adapters: new Map([["slack:default", slackAdapter]]),
      disableEventStream: true,
      disableHealthServer: true,
    },
  );

  await bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: "D-OUT", text: `/dir ${outside}`, raw: {} });
  await bridge.dispatchInbound({ channel: "slack", identityId: "default", peerId: "D-OUT", text: "ping", raw: {} });

  assert.ok(sent.some((m) => m.text.includes("Directory must stay within workspace root")));
  assert.ok(prompted.every((dirPath) => dirPath === wsA));

  await bridge.stop();
});
