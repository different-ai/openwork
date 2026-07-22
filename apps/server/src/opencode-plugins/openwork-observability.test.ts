import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { pushSystemBlock, systemBlockSources } from "./lib/system-provenance.js";
import { OpenWorkObservability } from "./openwork-observability.js";

const originalFetch = globalThis.fetch;
const originalEnv = {
  serverUrl: process.env.OPENWORK_SERVER_URL,
  serverToken: process.env.OPENWORK_SERVER_TOKEN,
  observabilityToken: process.env.OPENWORK_OBSERVABILITY_TOKEN,
  agentPromptHash: process.env.OPENWORK_AGENT_PROMPT_SHA256,
  agentPromptLength: process.env.OPENWORK_AGENT_PROMPT_LENGTH,
  instanceId: process.env.OPENWORK_OPENCODE_INSTANCE_ID,
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  restore("OPENWORK_SERVER_URL", originalEnv.serverUrl);
  restore("OPENWORK_SERVER_TOKEN", originalEnv.serverToken);
  restore("OPENWORK_OBSERVABILITY_TOKEN", originalEnv.observabilityToken);
  restore("OPENWORK_AGENT_PROMPT_SHA256", originalEnv.agentPromptHash);
  restore("OPENWORK_AGENT_PROMPT_LENGTH", originalEnv.agentPromptLength);
  restore("OPENWORK_OPENCODE_INSTANCE_ID", originalEnv.instanceId);
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("OpenWork observability plugin", () => {
  test("keeps duplicate block provenance aligned with pre-existing core blocks", () => {
    const system = ["duplicate"];
    pushSystemBlock(system, "duplicate", "openwork.extensions-preview.connect-steering");
    pushSystemBlock(system, "duplicate", "openwork.capabilities-knowledge");
    expect(systemBlockSources(system)).toEqual([
      "opencode-core-or-runtime-plugin",
      "openwork.extensions-preview.connect-steering",
      "openwork.capabilities-knowledge",
    ]);
  });

  test("exposes only the factory export for the OpenCode plugin loader", async () => {
    const pluginModule = await import("./openwork-observability.js");
    expect(Object.keys(pluginModule)).toEqual(["OpenWorkObservability"]);
  });

  test("uses the internal token and records final prompt hashes, provenance, and per-session changes", async () => {
    process.env.OPENWORK_SERVER_URL = "http://127.0.0.1:8787";
    process.env.OPENWORK_SERVER_TOKEN = "collaborator";
    process.env.OPENWORK_OBSERVABILITY_TOKEN = "observer-only";
    process.env.OPENWORK_OPENCODE_INSTANCE_ID = "managed-process-1";
    const basePrompt = "runtime agent prompt";
    process.env.OPENWORK_AGENT_PROMPT_SHA256 = sha256(basePrompt);
    process.env.OPENWORK_AGENT_PROMPT_LENGTH = String(basePrompt.length);

    const posts: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
    const requestHeaders: Headers[] = [];
    globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestHeaders.push(new Headers(init?.headers));
      if ((init?.method ?? "GET") === "GET") {
        return Response.json({
          config: { enabled: true, scopes: ["lifecycle", "prompt"], content: "full" },
        });
      }
      posts.push({
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return Response.json({ ok: true, accepted: 1, rejected: 0 });
    }, { preconnect: originalFetch.preconnect });

    const hooks = await OpenWorkObservability({ context: { directory: "/workspace" } });
    const transform = hooks["experimental.chat.system.transform"];
    const firstSystem = [`${basePrompt}\nopenCode environment and instructions`];
    pushSystemBlock(firstSystem, "capabilities", "openwork.capabilities-knowledge");
    await transform({ context: { sessionID: "session-1", messageID: "message-1" } }, { system: firstSystem });

    const secondSystem = [`${basePrompt}\nopenCode environment and instructions`];
    pushSystemBlock(secondSystem, "capabilities changed", "openwork.capabilities-knowledge");
    await transform({ context: { sessionID: "session-1", messageID: "message-2" } }, { system: secondSystem });

    expect(posts.length).toBeGreaterThanOrEqual(3);
    expect(requestHeaders.every((headers) => (
      headers.get("x-openwork-observability-token") === "observer-only"
    ))).toBe(true);
    const events = posts.flatMap((post) => (
      Array.isArray(post.body.events) ? post.body.events as Array<Record<string, unknown>> : []
    ));
    expect(events.some((event) => event.action === "plugin.factory.instantiated")).toBe(true);
    expect(events.every((event) => (
      (event.source as { instanceId?: string }).instanceId === "managed-process-1"
    ))).toBe(true);
    const initial = events.find((event) => event.action === "system-prompt.snapshot");
    const changed = events.find((event) => event.action === "system-prompt.changed");
    expect(initial?.context).toMatchObject({ sessionId: "session-1", directory: "/workspace" });
    expect(initial?.data).toMatchObject({
      status: "initial",
      blockCount: 2,
      changedIndices: [0, 1],
      blocks: [
        {
          index: 0,
          source: "opencode-core-composed-header",
          parts: [
            { source: "openwork.runtime-config.agent.openwork.prompt", length: basePrompt.length },
            { source: "opencode-core-session-context" },
          ],
        },
        { index: 1, source: "openwork.capabilities-knowledge" },
      ],
    });
    expect(initial?.content).toMatchObject({ value: firstSystem });
    expect(changed?.data).toMatchObject({ status: "changed", changedIndices: [1] });
    expect(changed?.cause).toMatchObject({ previousPromptHash: sha256(JSON.stringify(firstSystem)) });
  });

  test("does not transmit prompt bodies unless full content mode is enabled", async () => {
    process.env.OPENWORK_SERVER_URL = "http://127.0.0.1:8787";
    process.env.OPENWORK_SERVER_TOKEN = "collaborator";
    process.env.OPENWORK_OBSERVABILITY_TOKEN = "observer-only";
    const postBodies: string[] = [];
    globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        return Response.json({
          config: { enabled: true, scopes: ["prompt"], content: "metadata" },
        });
      }
      postBodies.push(String(init?.body));
      return Response.json({ ok: true, accepted: 1, rejected: 0 });
    }, { preconnect: originalFetch.preconnect });

    const hooks = await OpenWorkObservability();
    await hooks["experimental.chat.system.transform"](
      { context: { sessionID: "session-metadata" } },
      { system: ["never-send-this-prompt-body"] },
    );

    expect(postBodies.length).toBe(1);
    expect(postBodies[0]).not.toContain("never-send-this-prompt-body");
    expect(postBodies[0]).toContain('"kind":"system-prompt"');
    expect(postBodies[0]).not.toContain('"value"');
    expect(postBodies[0]).not.toContain('"promptHash"');
    expect(postBodies[0]).not.toContain('"previousPromptHash"');
    expect(postBodies[0]).not.toContain('"hash"');
  });

  test("announces an idle factory after observability is enabled without requiring a prompt", async () => {
    process.env.OPENWORK_SERVER_URL = "http://127.0.0.1:8787";
    process.env.OPENWORK_SERVER_TOKEN = "collaborator";
    process.env.OPENWORK_OBSERVABILITY_TOKEN = "observer-only";
    let enabled = false;
    const actions: string[] = [];
    globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        return Response.json({
          config: { enabled, scopes: ["lifecycle"], content: "metadata" },
        });
      }
      const body = JSON.parse(String(init?.body)) as {
        events?: Array<{ action?: string }>;
      };
      for (const event of body.events ?? []) {
        if (event.action) actions.push(event.action);
      }
      return Response.json({ ok: true, accepted: 1, rejected: 0 });
    }, { preconnect: originalFetch.preconnect });

    const hooks = await OpenWorkObservability();
    await Bun.sleep(800);
    enabled = true;
    await hooks.event();

    expect(actions).toContain("plugin.factory.instantiated");
  });

  test("bypasses a cached disabled config for the first prompt after enable", async () => {
    process.env.OPENWORK_SERVER_URL = "http://127.0.0.1:8787";
    process.env.OPENWORK_SERVER_TOKEN = "collaborator";
    process.env.OPENWORK_OBSERVABILITY_TOKEN = "observer-only";
    let enabled = false;
    let collectionEpoch = 0;
    const events: Array<Record<string, unknown>> = [];
    globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        return Response.json({
          config: { enabled, scopes: ["lifecycle", "prompt"], content: "hash" },
          collectionEpoch,
        });
      }
      const body = JSON.parse(String(init?.body)) as { events?: Array<Record<string, unknown>> };
      events.push(...(body.events ?? []));
      return Response.json({ ok: true, accepted: 1, rejected: 0 });
    }, { preconnect: originalFetch.preconnect });

    const hooks = await OpenWorkObservability();
    await hooks.event();
    enabled = true;
    collectionEpoch = 1;
    await hooks["experimental.chat.system.transform"](
      { context: { sessionID: "immediate-enable" } },
      { system: ["first enabled prompt"] },
    );

    const prompt = events.find((event) => event.action === "system-prompt.snapshot");
    expect(prompt?.data).toMatchObject({ status: "initial", collectionEpoch: 1 });
  });

  test("refreshes and retries a prompt rejected by a concurrent epoch change", async () => {
    process.env.OPENWORK_SERVER_URL = "http://127.0.0.1:8787";
    process.env.OPENWORK_SERVER_TOKEN = "collaborator";
    process.env.OPENWORK_OBSERVABILITY_TOKEN = "observer-only";
    let collectionEpoch = 1;
    const promptEvents: Array<Record<string, unknown>> = [];
    globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        return Response.json({
          config: { enabled: true, scopes: ["lifecycle", "prompt"], content: "hash" },
          collectionEpoch,
        });
      }
      const body = JSON.parse(String(init?.body)) as { events?: Array<Record<string, unknown>> };
      const event = body.events?.[0];
      if (event?.action === "system-prompt.snapshot") {
        promptEvents.push(event);
        if (promptEvents.length === 1) {
          collectionEpoch = 2;
          return Response.json({ ok: true, accepted: 0, rejected: 1 });
        }
      }
      return Response.json({ ok: true, accepted: 1, rejected: 0 });
    }, { preconnect: originalFetch.preconnect });

    const hooks = await OpenWorkObservability();
    await hooks["experimental.chat.system.transform"](
      { context: { sessionID: "racing-epoch" } },
      { system: ["prompt at boundary"] },
    );

    expect(promptEvents).toHaveLength(2);
    expect(promptEvents.map((event) => (
      event.data as { collectionEpoch?: number; status?: string }
    ))).toEqual([
      expect.objectContaining({ collectionEpoch: 1, status: "initial" }),
      expect.objectContaining({ collectionEpoch: 2, status: "initial" }),
    ]);
    expect(promptEvents.every((event) => event.cause === undefined)).toBe(true);
  });

  test("coalesces same-turn prompt reads without allowing older responses to regress epochs", async () => {
    process.env.OPENWORK_SERVER_URL = "http://127.0.0.1:8787";
    process.env.OPENWORK_SERVER_TOKEN = "collaborator";
    process.env.OPENWORK_OBSERVABILITY_TOKEN = "observer-only";
    let activeReads = 0;
    let maxActiveReads = 0;
    let readCount = 0;
    const promptEvents: Array<Record<string, unknown>> = [];
    globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        activeReads += 1;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        readCount += 1;
        const readNumber = readCount;
        await Bun.sleep(readNumber === 1 ? 20 : 2);
        activeReads -= 1;
        return Response.json({
          config: { enabled: true, scopes: ["lifecycle", "prompt"], content: "hash" },
          collectionEpoch: readNumber === 1 ? 1 : 2,
        });
      }
      const body = JSON.parse(String(init?.body)) as { events?: Array<Record<string, unknown>> };
      for (const event of body.events ?? []) {
        if (event.action === "system-prompt.snapshot") promptEvents.push(event);
      }
      return Response.json({ ok: true, accepted: 1, rejected: 0 });
    }, { preconnect: originalFetch.preconnect });

    const hooks = await OpenWorkObservability();
    const transform = hooks["experimental.chat.system.transform"];
    await Promise.all(Array.from({ length: 10 }, (_, index) => (
      transform(
        { context: { sessionID: `concurrent-${index}` } },
        { system: [`prompt ${index}`] },
      )
    )));
    await Bun.sleep(25);

    expect(maxActiveReads).toBe(2);
    expect(readCount).toBe(2);
    expect(promptEvents).toHaveLength(10);
    expect(promptEvents.every((event) => (
      (event.data as { collectionEpoch?: number }).collectionEpoch === 2
    ))).toBe(true);
  });

  test("does not share a pre-enable disabled read with the first post-enable prompt", async () => {
    process.env.OPENWORK_SERVER_URL = "http://127.0.0.1:8787";
    process.env.OPENWORK_SERVER_TOKEN = "collaborator";
    process.env.OPENWORK_OBSERVABILITY_TOKEN = "observer-only";
    let enabled = false;
    let collectionEpoch = 0;
    let blockNextRead = false;
    let releaseBlockedRead: () => void = () => undefined;
    let markBlockedReadStarted: () => void = () => undefined;
    const blockedReadStarted = new Promise<void>((resolve) => {
      markBlockedReadStarted = resolve;
    });
    const blockedRead = new Promise<void>((resolve) => {
      releaseBlockedRead = resolve;
    });
    const promptEvents: Array<Record<string, unknown>> = [];
    globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        const snapshot = { enabled, collectionEpoch };
        if (blockNextRead) {
          blockNextRead = false;
          markBlockedReadStarted();
          await blockedRead;
        }
        return Response.json({
          config: {
            enabled: snapshot.enabled,
            scopes: ["lifecycle", "prompt"],
            content: "hash",
          },
          collectionEpoch: snapshot.collectionEpoch,
        });
      }
      const body = JSON.parse(String(init?.body)) as { events?: Array<Record<string, unknown>> };
      for (const event of body.events ?? []) {
        if (event.action === "system-prompt.snapshot") promptEvents.push(event);
      }
      return Response.json({ ok: true, accepted: 1, rejected: 0 });
    }, { preconnect: originalFetch.preconnect });

    const hooks = await OpenWorkObservability();
    await hooks.event();
    const transform = hooks["experimental.chat.system.transform"];
    blockNextRead = true;
    const beforeEnable = transform(
      { context: { sessionID: "before-enable" } },
      { system: ["before"] },
    );
    await blockedReadStarted;

    enabled = true;
    collectionEpoch = 1;
    const afterEnable = transform(
      { context: { sessionID: "after-enable" } },
      { system: ["after"] },
    );
    releaseBlockedRead();
    await Promise.all([beforeEnable, afterEnable]);

    expect(promptEvents).toHaveLength(1);
    expect(promptEvents[0]?.context).toMatchObject({ sessionId: "after-enable" });
    expect(promptEvents[0]?.data).toMatchObject({ collectionEpoch: 1, status: "initial" });
  });

  test("re-announces the factory and resets prompt lineage for each collection epoch", async () => {
    process.env.OPENWORK_SERVER_URL = "http://127.0.0.1:8787";
    process.env.OPENWORK_SERVER_TOKEN = "collaborator";
    process.env.OPENWORK_OBSERVABILITY_TOKEN = "observer-only";
    let enabled = true;
    let collectionEpoch = 1;
    const events: Array<Record<string, unknown>> = [];
    globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        return Response.json({
          config: { enabled, scopes: ["lifecycle", "prompt"], content: "hash" },
          collectionEpoch,
        });
      }
      const body = JSON.parse(String(init?.body)) as { events?: Array<Record<string, unknown>> };
      events.push(...(body.events ?? []));
      return Response.json({ ok: true, accepted: 1, rejected: 0 });
    }, { preconnect: originalFetch.preconnect });

    const hooks = await OpenWorkObservability();
    const transform = hooks["experimental.chat.system.transform"];
    await transform({ context: { sessionID: "epoch-session" } }, { system: ["same prompt"] });

    enabled = false;
    await Bun.sleep(800);
    await hooks.event();
    enabled = true;
    collectionEpoch = 2;
    await Bun.sleep(800);
    await transform({ context: { sessionID: "epoch-session" } }, { system: ["same prompt"] });

    const factoryEvents = events.filter((event) => event.action === "plugin.factory.instantiated");
    const promptEvents = events.filter((event) => event.action === "system-prompt.snapshot");
    expect(factoryEvents.map((event) => (event.data as { collectionEpoch?: number }).collectionEpoch))
      .toEqual([1, 2]);
    expect(promptEvents.map((event) => (event.data as { status?: string }).status))
      .toEqual(["initial", "initial"]);
  });

  test("bounds multi-megabyte full prompts before the ingestion request", async () => {
    process.env.OPENWORK_SERVER_URL = "http://127.0.0.1:8787";
    process.env.OPENWORK_SERVER_TOKEN = "collaborator";
    process.env.OPENWORK_OBSERVABILITY_TOKEN = "observer-only";
    const posts: Array<{ bytes: number; event: Record<string, unknown> }> = [];
    globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        return Response.json({
          config: { enabled: true, scopes: ["lifecycle", "prompt"], content: "full" },
          collectionEpoch: 1,
        });
      }
      const serialized = String(init?.body);
      const body = JSON.parse(serialized) as { events?: Array<Record<string, unknown>> };
      for (const event of body.events ?? []) {
        posts.push({ bytes: new TextEncoder().encode(serialized).byteLength, event });
      }
      return Response.json({ ok: true, accepted: 1, rejected: 0 });
    }, { preconnect: originalFetch.preconnect });

    const hooks = await OpenWorkObservability();
    const raw = "💥".repeat(2_500_000);
    await hooks["experimental.chat.system.transform"](
      { context: { sessionID: "large-prompt" } },
      { system: [raw] },
    );

    const prompt = posts.find((entry) => entry.event.action === "system-prompt.snapshot");
    expect(prompt?.bytes).toBeLessThan(4 * 1024 * 1024);
    expect(prompt?.event.content).toMatchObject({
      length: raw.length,
      complete: false,
      truncated: true,
      hash: expect.any(String),
      rawHash: expect.any(String),
      capturedHash: expect.any(String),
    });
    expect(JSON.stringify((prompt?.event.content as { value?: unknown }).value).length)
      .toBeLessThan(raw.length);
  });

  test("does not advance prompt lineage when ingestion rejects an event", async () => {
    process.env.OPENWORK_SERVER_URL = "http://127.0.0.1:8787";
    process.env.OPENWORK_SERVER_TOKEN = "collaborator";
    process.env.OPENWORK_OBSERVABILITY_TOKEN = "observer-only";
    const promptEvents: Array<Record<string, unknown>> = [];
    let promptAttempts = 0;
    globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        return Response.json({
          config: { enabled: true, scopes: ["lifecycle", "prompt"], content: "hash" },
        });
      }
      const body = JSON.parse(String(init?.body)) as { events?: Array<Record<string, unknown>> };
      const event = body.events?.[0];
      if (event?.action === "system-prompt.snapshot" || event?.action === "system-prompt.changed") {
        promptEvents.push(event);
        promptAttempts += 1;
        return Response.json({ ok: true, accepted: promptAttempts === 1 ? 0 : 1, rejected: promptAttempts === 1 ? 1 : 0 });
      }
      return Response.json({ ok: true, accepted: 1, rejected: 0 });
    }, { preconnect: originalFetch.preconnect });

    const hooks = await OpenWorkObservability();
    const transform = hooks["experimental.chat.system.transform"];
    await transform({ context: { sessionID: "rejected-lineage" } }, { system: ["first"] });
    await transform({ context: { sessionID: "rejected-lineage" } }, { system: ["second"] });

    expect(promptEvents).toHaveLength(2);
    expect(promptEvents.map((event) => (event.data as { status?: string }).status))
      .toEqual(["initial", "initial"]);
    expect(promptEvents[1]?.cause).toBeUndefined();
  });
});
