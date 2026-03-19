import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MediaStore } from "../dist/media-store.js";
import { createTelegramAdapter } from "../dist/telegram.js";

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

let lastFakeBot = null;

class FakeBot {
  constructor(token) {
    this.token = token;
    this.handlers = new Map();
    this.me = { id: 999, username: "routerbot" };
    this.calls = {
      sendMessage: [],
      sendPhoto: [],
      sendAudio: [],
      sendDocument: [],
      getFile: [],
    };
    this.api = {
      sendMessage: async (chatId, text) => {
        this.calls.sendMessage.push({ chatId, text });
        return { ok: true };
      },
      sendPhoto: async (chatId, file, options) => {
        this.calls.sendPhoto.push({ chatId, file, options });
        return { ok: true };
      },
      sendAudio: async (chatId, file, options) => {
        this.calls.sendAudio.push({ chatId, file, options });
        return { ok: true };
      },
      sendDocument: async (chatId, file, options) => {
        this.calls.sendDocument.push({ chatId, file, options });
        return { ok: true };
      },
      getFile: async (fileId) => {
        this.calls.getFile.push({ fileId });
        return { file_path: `downloads/${fileId}.bin` };
      },
    };
    lastFakeBot = this;
  }

  catch(handler) {
    this.errorHandler = handler;
  }

  on(event, handler) {
    this.handlers.set(event, handler);
  }

  async start() {
    this.started = true;
  }

  stop() {
    this.started = false;
  }

  async emitMessage(message) {
    const handler = this.handlers.get("message");
    if (handler) {
      await handler({ message, me: this.me });
    }
  }
}

test("createTelegramAdapter sends text/images/audio/files", async () => {
  const logger = createLoggerStub();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-router-tg-send-"));
  const imagePath = path.join(tempDir, "sample.jpg");
  const audioPath = path.join(tempDir, "sample.ogg");
  const filePath = path.join(tempDir, "sample.txt");
  fs.writeFileSync(imagePath, "img");
  fs.writeFileSync(audioPath, "aud");
  fs.writeFileSync(filePath, "doc");

  const adapter = createTelegramAdapter(
    {
      id: "default",
      token: "tg-token",
      enabled: true,
    },
    { groupsEnabled: false },
    logger,
    async () => {},
    undefined,
    { Bot: FakeBot },
  );

  const result = await adapter.sendMessage("12345", {
    parts: [
      { type: "text", text: "hello" },
      { type: "image", filePath: imagePath, caption: "image caption" },
      { type: "audio", filePath: audioPath },
      { type: "file", filePath },
    ],
  });

  assert.equal(result.attemptedParts, 4);
  assert.equal(result.sentParts, 4);
  assert.ok(lastFakeBot);
  assert.equal(lastFakeBot.calls.sendMessage.length, 1);
  assert.equal(lastFakeBot.calls.sendPhoto.length, 1);
  assert.equal(lastFakeBot.calls.sendAudio.length, 1);
  assert.equal(lastFakeBot.calls.sendDocument.length, 1);
});

test("createTelegramAdapter downloads inbound media to store", async () => {
  const logger = createLoggerStub();
  const inbound = [];
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-router-tg-inbound-"));
  const mediaStore = new MediaStore(path.join(tempDir, "media"));
  await mediaStore.ensureReady();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("telegram-media", {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    });

  try {
    const adapter = createTelegramAdapter(
      {
        id: "default",
        token: "tg-token",
        enabled: true,
      },
      { groupsEnabled: false },
      logger,
      async (message) => inbound.push(message),
      mediaStore,
      { Bot: FakeBot },
    );

    await lastFakeBot.emitMessage({
      chat: { id: 777, type: "private" },
      caption: "here is photo",
      photo: [{ file_id: "FILE123", file_unique_id: "UNIQ123", file_size: 13 }],
    });

    assert.equal(inbound.length, 1);
    assert.equal(inbound[0].text, "here is photo");
    const mediaPart = inbound[0].parts.find((part) => part.type === "media");
    assert.ok(mediaPart);
    assert.equal(mediaPart.media.status, "ready");
    assert.ok(mediaPart.media.filePath);
    assert.equal(fs.existsSync(mediaPart.media.filePath), true);
    assert.equal(fs.readFileSync(mediaPart.media.filePath, "utf8"), "telegram-media");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createTelegramAdapter ignores bot-originated inbound messages", async () => {
  const logger = createLoggerStub();
  const inbound = [];

  createTelegramAdapter(
    {
      id: "default",
      token: "tg-token",
      enabled: true,
    },
    { groupsEnabled: false },
    logger,
    async (message) => inbound.push(message),
    undefined,
    { Bot: FakeBot },
  );

  await lastFakeBot.emitMessage({
    chat: { id: 777, type: "private" },
    from: { id: 999, is_bot: true },
    text: "bot says hi",
  });

  await lastFakeBot.emitMessage({
    chat: { id: 777, type: "private" },
    from: { id: 123, is_bot: true },
    text: "another bot says hi",
  });

  assert.equal(inbound.length, 0);
});
