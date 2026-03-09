import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MediaStore } from "../dist/media-store.js";
import {
  createSlackAdapter,
  formatSlackPeerId,
  parseSlackPeerId,
  stripSlackMention,
} from "../dist/slack.js";

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

test("slack peerId encoding", () => {
  assert.deepEqual(parseSlackPeerId("D123"), { channelId: "D123" });
  assert.deepEqual(parseSlackPeerId("C123|1700000000.000100"), {
    channelId: "C123",
    threadTs: "1700000000.000100",
  });
  assert.equal(formatSlackPeerId({ channelId: "D123" }), "D123");
  assert.equal(
    formatSlackPeerId({ channelId: "C123", threadTs: "1700000000.000100" }),
    "C123|1700000000.000100",
  );
});

test("stripSlackMention removes bot mention and punctuation", () => {
  assert.equal(stripSlackMention("<@UBOT> hello", "UBOT"), "hello");
  assert.equal(stripSlackMention("<@UBOT>: hello", "UBOT"), "hello");
  assert.equal(stripSlackMention("<@UBOT> - hello", "UBOT"), "hello");
  assert.equal(stripSlackMention("hello", "UBOT"), "hello");
});

test("createSlackAdapter routes DM + app mentions", async () => {
  const logger = createLoggerStub();
  const inbound = [];
  let socketInstance;
  let webInstance;

  class FakeWebClient {
    constructor(token) {
      this.token = token;
      this.posts = [];
      this.uploads = [];
      webInstance = this;
      this.auth = {
        test: async () => ({ ok: true, user_id: "UBOT" }),
      };
      this.chat = {
        postMessage: async (payload) => {
          this.posts.push(payload);
          return { ok: true };
        },
      };
      this.files = {
        uploadV2: async (payload) => {
          this.uploads.push(payload);
          return { ok: true };
        },
      };
    }
  }

  class FakeSocketModeClient {
    constructor(opts) {
      this.opts = opts;
      this.handlers = new Map();
      this.acks = [];
      socketInstance = this;
    }
    on(event, handler) {
      this.handlers.set(event, handler);
    }
    async start() {
      this.started = true;
    }
    async ack(envelopeId) {
      this.acks.push(envelopeId);
    }
    async disconnect() {
      this.started = false;
    }
    async emit(event, args) {
      const handler = this.handlers.get(event);
      if (handler) {
        await handler(args);
      }
    }
  }

  const adapter = createSlackAdapter(
    {
      id: "default",
      botToken: "xoxb-test",
      appToken: "xapp-test",
      enabled: true,
    },
    { groupsEnabled: false },
    logger,
    async (msg) => inbound.push(msg),
    { WebClient: FakeWebClient, SocketModeClient: FakeSocketModeClient },
  );

  await adapter.start();
  assert.equal(socketInstance.started, true);

  await socketInstance.emit("message", {
    ack: async () => socketInstance.acks.push("a1"),
    event: {
      type: "message",
      channel: "D123",
      user: "U1",
      text: "hi",
      ts: "1700000000.000001",
    },
  });

  await socketInstance.emit("app_mention", {
    ack: async () => socketInstance.acks.push("a2"),
    event: {
      type: "app_mention",
      channel: "C123",
      user: "U2",
      text: "<@UBOT> run tests",
      ts: "1700000000.000100",
    },
  });

  assert.deepEqual(socketInstance.acks, ["a1", "a2"]);
  assert.equal(inbound.length, 2);
  assert.equal(inbound[0].channel, "slack");
  assert.equal(inbound[0].identityId, "default");
  assert.equal(inbound[0].peerId, "D123");
  assert.equal(inbound[0].text, "hi");
  assert.equal(inbound[1].identityId, "default");
  assert.equal(inbound[1].peerId, "C123|1700000000.000100");
  assert.equal(inbound[1].text, "run tests");

  await adapter.sendText("D123", "ok");
  await adapter.sendText("C123|1700000000.000100", "ok-thread");

  const mediaFile = path.join(os.tmpdir(), `opencode-router-slack-${Date.now()}.txt`);
  fs.writeFileSync(mediaFile, "hello from file");
  const mediaResult = await adapter.sendMessage("D123", {
    parts: [{ type: "file", filePath: mediaFile }],
  });

  assert.equal(webInstance.posts.length, 2);
  assert.deepEqual(webInstance.posts[0], { channel: "D123", text: "ok" });
  assert.deepEqual(webInstance.posts[1], { channel: "C123", text: "ok-thread", thread_ts: "1700000000.000100" });
  assert.equal(mediaResult.sentParts, 1);
  assert.equal(webInstance.uploads.length, 1);
  assert.equal(webInstance.uploads[0].channel_id, "D123");
  assert.equal(Buffer.isBuffer(webInstance.uploads[0].file), true);
  assert.equal(webInstance.uploads[0].filename, path.basename(mediaFile));

  await adapter.stop();
  assert.equal(socketInstance.started, false);
});

test("createSlackAdapter downloads inbound files into media store", async () => {
  const logger = createLoggerStub();
  const inbound = [];
  let socketInstance;

  class FakeWebClient {
    constructor(token) {
      this.token = token;
      this.auth = {
        test: async () => ({ ok: true, user_id: "UBOT" }),
      };
      this.chat = {
        postMessage: async () => ({ ok: true }),
      };
      this.files = {
        uploadV2: async () => ({ ok: true }),
      };
    }
  }

  class FakeSocketModeClient {
    constructor() {
      this.handlers = new Map();
      socketInstance = this;
    }
    on(event, handler) {
      this.handlers.set(event, handler);
    }
    async start() {}
    async disconnect() {}
    async emit(event, args) {
      const handler = this.handlers.get(event);
      if (handler) {
        await handler(args);
      }
    }
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-router-slack-media-"));
  const mediaStore = new MediaStore(path.join(tempDir, "media"));
  await mediaStore.ensureReady();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("downloaded-slack-file", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });

  try {
    const adapter = createSlackAdapter(
      {
        id: "default",
        botToken: "xoxb-test",
        appToken: "xapp-test",
        enabled: true,
      },
      { groupsEnabled: false },
      logger,
      async (msg) => inbound.push(msg),
      { WebClient: FakeWebClient, SocketModeClient: FakeSocketModeClient },
      mediaStore,
    );

    await adapter.start();

    await socketInstance.emit("message", {
      ack: async () => {},
      event: {
        type: "message",
        subtype: "file_share",
        channel: "D123",
        user: "U1",
        files: [
          {
            id: "F1",
            url_private_download: "https://files.example.com/download/F1",
            name: "report.txt",
            mimetype: "text/plain",
            size: 22,
          },
        ],
      },
    });

    assert.equal(inbound.length, 1);
    const mediaPart = inbound[0].parts.find((part) => part.type === "media");
    assert.ok(mediaPart);
    assert.equal(mediaPart.media.status, "ready");
    const downloadedPath = mediaPart.media.filePath;
    assert.ok(downloadedPath);
    assert.equal(fs.existsSync(downloadedPath), true);
    assert.equal(fs.readFileSync(downloadedPath, "utf8"), "downloaded-slack-file");

    await adapter.stop();
  } finally {
    globalThis.fetch = originalFetch;
  }
});
