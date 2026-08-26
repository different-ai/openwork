const assert = require("node:assert/strict");
const test = require("node:test");

const { installWebMcpRuntime } = require("./browser-content-preload.cjs");

function createRealm() {
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
