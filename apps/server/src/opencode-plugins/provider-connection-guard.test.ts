import { describe, expect, test } from "bun:test";
import {
  CONNECTION_LOST_MESSAGE,
  createConnectionMonitor,
  guardProviderFetch,
  isGuardedFetch,
  type Disruption,
  type Timers,
} from "./provider-connection-guard.js";
import { OpenWorkProviderConnection } from "./openwork-provider-connection.js";

/** Manual clock and timers so every scenario is deterministic. */
function createHarness(options: { addresses?: string[] } = {}) {
  let now = 1_000_000;
  let addresses = options.addresses ?? ["10.0.0.5"];
  const scheduled = new Map<number, { at: number; callback: () => void }>();
  let nextId = 0;
  const timers: Timers = {
    setTimeout: (callback, ms) => {
      const id = (nextId += 1);
      scheduled.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimeout: (id) => {
      if (typeof id === "number") scheduled.delete(id);
    },
  };
  const advance = async (ms: number) => {
    const target = now + ms;
    while (true) {
      const due = [...scheduled.entries()].filter(([, entry]) => entry.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      scheduled.delete(due[0]);
      now = due[1].at;
      due[1].callback();
      await Promise.resolve();
    }
    now = target;
    await Promise.resolve();
  };
  const monitor = createConnectionMonitor({
    now: () => now,
    readAddresses: () => addresses,
    timers,
    tickMs: 5_000,
    suspendGapMs: 30_000,
  });
  const disruptions: Disruption[] = [];
  monitor.onDisruption((kind) => disruptions.push(kind));
  return {
    monitor,
    timers,
    disruptions,
    now: () => now,
    advance,
    setAddresses(next: string[]) {
      addresses = next;
    },
    jumpClock(ms: number) {
      now += ms;
    },
  };
}

/** A provider body that emits `chunks`, then stays silent until pushed or closed. */
function textStream(chunks: string[]) {
  const queue = [...chunks];
  let closed = false;
  let wake: (() => void) | null = null;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (queue.length === 0 && !closed) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      if (queue.length > 0) {
        controller.enqueue(new TextEncoder().encode(queue.shift()!));
        return;
      }
      controller.close();
    },
  });
  return {
    stream,
    push(text: string) {
      queue.push(text);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
  };
}

describe("connection monitor", () => {
  test("reports a resume when the clock jumps past the suspend gap and the machine is online", () => {
    const h = createHarness();
    h.monitor.tick();
    h.jumpClock(5_000);
    h.monitor.tick();
    expect(h.disruptions).toEqual([]);
    h.jumpClock(120_000);
    h.monitor.tick();
    expect(h.disruptions).toEqual(["resume"]);
  });

  test("goes offline silently and reports a network change once a route returns", () => {
    const h = createHarness();
    h.monitor.tick();
    h.setAddresses([]);
    h.monitor.tick();
    expect(h.monitor.online).toBe(false);
    expect(h.disruptions).toEqual([]);
    h.setAddresses(["192.168.1.20"]);
    h.monitor.tick();
    expect(h.monitor.online).toBe(true);
    expect(h.disruptions).toEqual(["network-change"]);
  });

  test("waitForOnline resolves immediately online, on reconnect, at the bound, or rejects on abort", async () => {
    const h = createHarness();
    h.monitor.tick();
    await expect(h.monitor.waitForOnline({ maxWaitMs: 1_000 })).resolves.toBeUndefined();

    h.setAddresses([]);
    h.monitor.tick();
    let resolved = false;
    const waiting = h.monitor.waitForOnline({ maxWaitMs: 45_000 }).then(() => {
      resolved = true;
    });
    await h.advance(1_000);
    expect(resolved).toBe(false);
    h.setAddresses(["10.0.0.5"]);
    h.monitor.tick();
    await waiting;
    expect(resolved).toBe(true);

    h.setAddresses([]);
    h.monitor.tick();
    let bounded = false;
    const boundedWait = h.monitor.waitForOnline({ maxWaitMs: 45_000 }).then(() => {
      bounded = true;
    });
    await h.advance(44_000);
    expect(bounded).toBe(false);
    await h.advance(1_000);
    await boundedWait;
    expect(bounded).toBe(true);

    const controller = new AbortController();
    const aborted = h.monitor.waitForOnline({ signal: controller.signal, maxWaitMs: 45_000 });
    controller.abort(new Error("user stopped"));
    await expect(aborted).rejects.toThrow("user stopped");
  });
});

describe("guarded provider fetch", () => {
  test("passes a healthy streaming response through untouched", async () => {
    const h = createHarness();
    h.monitor.tick();
    const upstream = textStream(["data: a\n\n", "data: b\n\n"]);
    const fetchFn = async () => new Response(upstream.stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    const guarded = guardProviderFetch(fetchFn, h.monitor, { now: h.now, timers: h.timers });
    const response = await guarded("https://provider.test/v1/messages");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("data: a\n\n");
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toBe("data: b\n\n");
    upstream.close();
    expect((await reader.read()).done).toBe(true);
  });

  test("fails a silent stream with a retryable connection-lost error after a resume, not before", async () => {
    const h = createHarness();
    h.monitor.tick();
    const upstream = textStream(["data: started\n\n"]);
    let cancelled: unknown = null;
    const fetchFn = async (_input: RequestInfo | URL, init?: RequestInit) => {
      init?.signal?.addEventListener("abort", () => {
        cancelled = init.signal?.reason;
      });
      return new Response(upstream.stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const guarded = guardProviderFetch(fetchFn, h.monitor, { now: h.now, timers: h.timers, graceMs: 10_000 });
    const response = await guarded("https://provider.test/v1/messages");
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);

    // Long silence without any disruption is the model thinking: never fail it.
    const pending = reader.read();
    let settled = false;
    pending.then(() => { settled = true; }, () => { settled = true; });
    await h.advance(240_000);
    expect(settled).toBe(false);

    // The machine slept; on resume nothing arrives within the grace window.
    h.jumpClock(600_000);
    h.monitor.tick();
    await h.advance(9_000);
    expect(settled).toBe(false);
    await h.advance(1_000);
    await expect(pending).rejects.toThrow(CONNECTION_LOST_MESSAGE);
    expect(cancelled).toBeInstanceOf(Error);
    expect(/connection lost/i.test(CONNECTION_LOST_MESSAGE)).toBe(true);
  });

  test("keeps a stream that produces bytes within the grace window after a resume", async () => {
    const h = createHarness();
    h.monitor.tick();
    const upstream = textStream(["data: started\n\n"]);
    const fetchFn = async () => new Response(upstream.stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    const guarded = guardProviderFetch(fetchFn, h.monitor, { now: h.now, timers: h.timers, graceMs: 10_000 });
    const response = await guarded("https://provider.test/v1/messages");
    const reader = response.body!.getReader();
    await reader.read();

    const pending = reader.read();
    h.jumpClock(600_000);
    h.monitor.tick();
    await h.advance(4_000);
    upstream.push("data: still here\n\n");
    const part = await pending;
    expect(new TextDecoder().decode(part.value)).toBe("data: still here\n\n");
    await h.advance(10_000);
    upstream.push("data: more\n\n");
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: more\n\n");
  });

  test("fails a request still waiting for headers after a network change", async () => {
    const h = createHarness();
    h.monitor.tick();
    const fetchFn = (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });
    const guarded = guardProviderFetch(fetchFn, h.monitor, { now: h.now, timers: h.timers, graceMs: 10_000 });
    const request = guarded("https://provider.test/v1/messages");
    let settled = false;
    request.then(() => { settled = true; }, () => { settled = true; });
    await h.advance(60_000);
    expect(settled).toBe(false);
    h.setAddresses(["10.0.0.9"]);
    h.monitor.tick();
    await h.advance(10_000);
    await expect(request).rejects.toThrow(CONNECTION_LOST_MESSAGE);
  });

  test("holds a new request while offline and sends it once a route returns", async () => {
    const h = createHarness();
    h.monitor.tick();
    h.setAddresses([]);
    h.monitor.tick();
    const sentAt: number[] = [];
    const fetchFn = async () => {
      sentAt.push(h.now());
      return new Response(null, { status: 204 });
    };
    const guarded = guardProviderFetch(fetchFn, h.monitor, { now: h.now, timers: h.timers, offlineHoldMs: 45_000 });
    const request = guarded("https://provider.test/v1/messages");
    await h.advance(20_000);
    expect(sentAt).toEqual([]);
    h.setAddresses(["10.0.0.5"]);
    h.monitor.tick();
    const response = await request;
    expect(response.status).toBe(204);
    expect(sentAt).toHaveLength(1);
  });

  test("a user abort while offline surfaces as the caller's abort, not a connection error", async () => {
    const h = createHarness();
    h.monitor.tick();
    h.setAddresses([]);
    h.monitor.tick();
    const guarded = guardProviderFetch(async () => new Response(null, { status: 204 }), h.monitor, { now: h.now, timers: h.timers });
    const controller = new AbortController();
    const request = guarded("https://provider.test/v1/messages", { signal: controller.signal });
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("OpenWorkProviderConnection config hook", () => {
  test("guards every configured provider's fetch once and leaves other options intact", async () => {
    const hooks = await OpenWorkProviderConnection();
    const config = {
      provider: {
        anthropic: { options: { apiKey: "k", baseURL: "https://anthropic.test" } },
        openwork: { npm: "@ai-sdk/openai-compatible" },
        broken: "not-a-record",
      },
    };
    await hooks.config(config);
    const anthropic = config.provider.anthropic.options;
    expect(anthropic.apiKey).toBe("k");
    expect(anthropic.baseURL).toBe("https://anthropic.test");
    expect(isGuardedFetch(Reflect.get(anthropic, "fetch"))).toBe(true);
    const openwork = Reflect.get(config.provider.openwork, "options");
    expect(isGuardedFetch(Reflect.get(openwork, "fetch"))).toBe(true);
    const first = Reflect.get(anthropic, "fetch");
    await hooks.config(config);
    expect(Reflect.get(anthropic, "fetch")).toBe(first);
    expect(config.provider.broken).toBe("not-a-record");
  });

  test("module exposes only the plugin factory", async () => {
    const mod = await import("./openwork-provider-connection.js");
    expect(Object.keys(mod)).toEqual(["OpenWorkProviderConnection"]);
  });
});
