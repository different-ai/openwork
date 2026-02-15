import assert from "node:assert/strict";
import test from "node:test";

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

  assert.equal(webInstance.posts.length, 2);
  assert.deepEqual(webInstance.posts[0], { channel: "D123", text: "ok" });
  assert.deepEqual(webInstance.posts[1], { channel: "C123", text: "ok-thread", thread_ts: "1700000000.000100" });

  await adapter.stop();
  assert.equal(socketInstance.started, false);
});
