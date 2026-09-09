const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const { runInNewContext } = require("node:vm");

const { installWebMcpRuntime } = require("./browser-content-preload.cjs");

function createRealm(policy = null) {
  class TestDocument {
    constructor() {
      this.defaultView = null;
    }
  }
  class TestWindow extends EventTarget {
    constructor(origin) {
      super();
      this.location = { origin };
      this.frames = [];
      this.document = new TestDocument();
      this.document.defaultView = this;
    }
  }

  const previous = {
    Document: globalThis.Document,
    document: globalThis.document,
    isSecureContext: globalThis.isSecureContext,
    window: globalThis.window,
  };
  const window = new TestWindow("https://example.test");
  if (policy) window.__openworkWebMcpPolicyV1 = { check: async (...args) => {
    assert.deepEqual(args, []);
    return policy;
  } };
  globalThis.Document = TestDocument;
  globalThis.document = window.document;
  globalThis.window = window;
  globalThis.isSecureContext = true;
  assert.equal(installWebMcpRuntime(), true);

  return {
    window,
    restore() {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
      }
    },
  };
}

test("imperative WebMCP registration, discovery, execution, and abort unregistration", async () => {
  const realm = createRealm();
  try {
    const registration = new AbortController();
    let observedInput = null;
    let toolChanges = 0;
    realm.window.document.modelContext.ontoolchange = () => { toolChanges += 1; };

    await realm.window.document.modelContext.registerTool({
      name: "read_profile",
      title: "Read profile",
      description: "Read the current signed-in profile.",
      inputSchema: {
        type: "object",
        properties: { detail: { type: "string" } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      async execute(input, { signal }) {
        assert.equal(signal.aborted, false);
        observedInput = input;
        return { user: "Jalil", detail: input.detail };
      },
    }, { signal: registration.signal });

    const [tool] = await realm.window.document.modelContext.getTools();
    assert.equal(tool.name, "read_profile");
    assert.equal(tool.window, realm.window);
    assert.equal(tool.origin, "https://example.test");
    assert.deepEqual(tool.annotations, { readOnlyHint: true, untrustedContentHint: true });
    assert.equal(
      await realm.window.document.modelContext.executeTool(tool, { detail: "full" }),
      JSON.stringify({ user: "Jalil", detail: "full" }),
    );
    assert.deepEqual(observedInput, { detail: "full" });
    assert.ok(toolChanges >= 1);

    registration.abort();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(await realm.window.document.modelContext.getTools(), []);
  } finally {
    realm.restore();
  }
});

test("registration rejects duplicate, malformed, and already-aborted tools", async () => {
  const realm = createRealm();
  try {
    const tool = {
      name: "lookup",
      description: "Look up a record.",
      execute: async () => ({}),
    };
    await realm.window.document.modelContext.registerTool(tool);
    await assert.rejects(
      realm.window.document.modelContext.registerTool(tool),
      (error) => error instanceof DOMException && error.name === "InvalidStateError",
    );
    await assert.rejects(
      realm.window.document.modelContext.registerTool({ ...tool, name: "not allowed!" }),
      (error) => error instanceof DOMException && error.name === "InvalidStateError",
    );
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(
      realm.window.document.modelContext.registerTool({ ...tool, name: "other" }, { signal: aborted.signal }),
      (error) => error?.name === "AbortError",
    );
  } finally {
    realm.restore();
  }
});

test("executeTool propagates cancellation to the website callback", async () => {
  const realm = createRealm();
  try {
    let callbackSignal;
    await realm.window.document.modelContext.registerTool({
      name: "wait",
      description: "Wait until canceled.",
      async execute(_input, { signal }) {
        callbackSignal = signal;
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        return { canceled: signal.aborted };
      },
    });
    const [tool] = await realm.window.document.modelContext.getTools();
    const controller = new AbortController();
    const execution = realm.window.document.modelContext.executeTool(tool, {}, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await assert.rejects(execution, (error) => error?.name === "AbortError");
    assert.equal(callbackSignal.aborted, true);
  } finally {
    realm.restore();
  }
});

test("the page API enforces native frame policy before registering tools", async () => {
  const denied = createRealm({ allowed: false, originKeyed: true });
  try {
    await assert.rejects(
      denied.window.document.modelContext.registerTool({
        name: "blocked",
        description: "Must not register.",
        execute: async () => ({}),
      }),
      (error) => error instanceof DOMException && error.name === "NotAllowedError",
    );
  } finally {
    denied.restore();
  }

  const nonOriginKeyed = createRealm({ allowed: true, originKeyed: false });
  try {
    Object.defineProperty(nonOriginKeyed.window, "originAgentCluster", { get: () => assert.fail("Do not read page-controlled OAC.") });
    Object.defineProperty(nonOriginKeyed.window.document, "domain", { get: () => assert.fail("Do not read page-controlled domain.") });
    await assert.rejects(
      nonOriginKeyed.window.document.modelContext.getTools(),
      (error) => error instanceof DOMException && error.name === "SecurityError",
    );
  } finally {
    nonOriginKeyed.restore();
  }
});

test("the isolated preload exposes only a payload-free check, not a policy-reporting capability", async () => {
  const listeners = new Map();
  const sent = [];
  const invoked = [];
  const exposed = {};
  const child = {};
  const isolatedWindow = { originAgentCluster: false, frames: [child], addEventListener() {} };
  const isolatedDocument = {
    domain: "relaxed.example", baseURI: "https://app.example/", readyState: "loading", addEventListener() {},
    querySelectorAll: () => [
      { contentWindow: {}, src: "https://attacker.example/", getAttribute: () => "tools *" },
      { contentWindow: child, src: "https://child.example/", getAttribute: () => "tools 'src'" },
    ],
  };
  runInNewContext(readFileSync(require.resolve("./browser-content-preload.cjs"), "utf8"), {
    require: () => ({
      ipcRenderer: {
        on: (channel, handler) => listeners.set(channel, handler),
        send: (...args) => sent.push(args),
        invoke: async (...args) => { invoked.push(args); return { originKeyed: false }; },
      },
      contextBridge: {
        exposeInMainWorld: (name, api) => { exposed[name] = api; },
        executeInMainWorld() {},
      },
    }),
    window: isolatedWindow, document: isolatedDocument, location: { hostname: "app.example" }, URL,
  });
  const bridge = exposed.__openworkWebMcpPolicyV1;
  assert.deepEqual(Object.keys(bridge), ["check"]);
  assert.equal((await bridge.check({ originAgentCluster: true, domainMatchesHost: true })).originKeyed, false);
  assert.deepEqual(invoked, [["openwork:webmcp:frame-policy"]]);
  const readPolicy = listeners.get("openwork:webmcp:read-policy");
  readPolicy({}, "native-request", 0);
  assert.equal(sent[0][0], "native-request");
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0][1])), {
    originAgentCluster: false, domainMatchesHost: false,
    embedding: { allow: "tools 'src'", sourceOrigin: "https://child.example" },
  });
  isolatedWindow.originAgentCluster = true;
  isolatedDocument.domain = "app.example";
  readPolicy({}, "fresh-native-request", null);
  assert.deepEqual(JSON.parse(JSON.stringify(sent[1][1])), {
    originAgentCluster: true, domainMatchesHost: true, embedding: null,
  });
});

test("aborting while registration is pending rejects and unregisters atomically", async () => {
  const realm = createRealm();
  try {
    const controller = new AbortController();
    const registration = realm.window.document.modelContext.registerTool({
      name: "pending",
      description: "Pending registration.",
      execute: async () => ({}),
    }, { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await assert.rejects(registration, (error) => error?.name === "AbortError");
    assert.deepEqual(await realm.window.document.modelContext.getTools(), []);
  } finally {
    realm.restore();
  }
});
