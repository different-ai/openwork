import { describe, expect, test } from "bun:test";
import { CONNECTION_LOST_MESSAGE, guardProviderFetch } from "./provider-connection-guard.js";
import { createResumeMonitor, type Scheduler } from "./provider-resume-monitor.js";
import { OpenWorkProviderConnection } from "./openwork-provider-connection.js";

function createHarness() {
  let now = 0;
  const scheduled = new Map<object, { at: number; callback: () => void }>();
  const clock: Scheduler = {
    now: () => now,
    after(ms, callback) {
      const id = {};
      scheduled.set(id, { at: now + ms, callback });
      return () => { scheduled.delete(id); };
    },
  };
  const advance = async (ms: number) => {
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    const end = now + ms;
    while (true) {
      const due = [...scheduled.entries()].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      scheduled.delete(due[0]);
      now = Math.max(now, due[1].at);
      due[1].callback();
      for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    }
    now = end;
  };
  return {
    clock, advance,
    monitor: createResumeMonitor(clock),
    pending: () => scheduled.size,
    async resume() { now += 40_000; await advance(0); },
  };
}

function stream() {
  let control: ReadableStreamDefaultController<Uint8Array> | undefined;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { control = controller; },
    cancel() { cancelled = true; },
  });
  return {
    response: new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8", "x-provider": "preserved" } }),
    push(text: string) { control?.enqueue(new TextEncoder().encode(text)); },
    close() { control?.close(); },
    cancelled: () => cancelled,
  };
}

describe("resume monitor", () => {
  test("shares one timer across requests and stops when the last request completes", async () => {
    const h = createHarness();
    expect(h.pending()).toBe(0);
    let resumes = 0;
    const first = h.monitor.subscribe(() => { resumes++; });
    const second = h.monitor.subscribe(() => { resumes++; });
    expect(h.pending()).toBe(1);
    await h.advance(120_000);
    expect(resumes).toBe(0);
    await h.resume();
    expect(resumes).toBe(2);
    first();
    expect(h.pending()).toBe(1);
    second();
    expect(h.pending()).toBe(0);
    const fresh = h.monitor.subscribe(() => { resumes++; });
    await h.advance(5_000);
    expect(resumes).toBe(2);
    fresh();
  });
});

describe("managed provider request lifecycle", () => {
  test("ordinary long silence has no added timeout; silence after a pause fails and cancels the transport", async () => {
    const h = createHarness();
    const upstream = stream();
    let signal: AbortSignal | null | undefined;
    const guarded = guardProviderFetch(async (_input, init) => { signal = init?.signal; return upstream.response; }, h.monitor, h.clock);
    const response = await guarded("https://provider.test/v1/messages");
    expect(response.headers.get("x-provider")).toBe("preserved");
    const pending = response.text();
    void pending.catch(() => {});
    await h.advance(300_000);
    expect(signal?.aborted).toBe(false);
    await h.resume();
    await h.advance(29_999);
    expect(signal?.aborted).toBe(false);
    await h.advance(1);
    await expect(pending).rejects.toThrow(CONNECTION_LOST_MESSAGE);
    expect(signal?.aborted).toBe(true);
    expect(upstream.cancelled()).toBe(true);
    expect(h.pending()).toBe(0);
  });

  test("bytes after resume disarm recovery and completion releases all timers", async () => {
    const h = createHarness();
    const upstream = stream();
    const response = await guardProviderFetch(async () => upstream.response, h.monitor, h.clock)("https://provider.test");
    const pending = response.text();
    await h.resume();
    await h.advance(29_000);
    upstream.push("data: still alive\n\n");
    await h.advance(300_000);
    expect(upstream.cancelled()).toBe(false);
    upstream.close();
    expect(await pending).toBe("data: still alive\n\n");
    expect(h.pending()).toBe(0);
  });

  test("a consumer that pauses reading does not make a buffered response look dead", async () => {
    const h = createHarness();
    const upstream = stream();
    upstream.push("data: buffered\n\n");
    const response = await guardProviderFetch(async () => upstream.response, h.monitor, h.clock)("https://provider.test");
    await h.advance(0);
    await h.resume();
    await h.advance(300_000);
    expect(upstream.cancelled()).toBe(false);
    upstream.close();
    expect(await response.text()).toBe("data: buffered\n\n");
    expect(h.pending()).toBe(0);
  });

  test("a request waiting for headers is released after the same bounded resume grace", async () => {
    const h = createHarness();
    const pending = guardProviderFetch(() => new Promise<Response>(() => {}), h.monitor, h.clock)("https://provider.test");
    void pending.catch(() => {});
    await h.resume();
    await h.advance(30_000);
    await expect(pending).rejects.toThrow(CONNECTION_LOST_MESSAGE);
    expect(h.pending()).toBe(0);
  });

  test.each([200, 401, 403, 429, 500])("returns a non-streaming HTTP %i response unchanged", async (status) => {
    const h = createHarness();
    const original = new Response('{"error":"provider response"}', { status, headers: { "content-type": "application/json", "retry-after": "15" } });
    const result = await guardProviderFetch(async () => original, h.monitor, h.clock)("https://provider.test");
    expect(result).toBe(original);
    expect(h.pending()).toBe(0);
    expect(await result.text()).toBe('{"error":"provider response"}');
  });

  test("preserves Request cancellation, arguments, and abort reason while a stream is open", async () => {
    const h = createHarness();
    const upstream = stream();
    const stop = new AbortController();
    const request = new Request("https://provider.test/v1/messages", { method: "POST", headers: { authorization: "Bearer test-only" }, body: "request", signal: stop.signal });
    let signal: AbortSignal | null | undefined;
    const guarded = guardProviderFetch(async (input, init) => {
      expect(input).toBe(request);
      expect(init?.redirect).toBe("manual");
      signal = init?.signal;
      return upstream.response;
    }, h.monitor, h.clock);
    const result = await guarded(request, { redirect: "manual" });
    const pending = result.text();
    void pending.catch(() => {});
    const reason = new Error("user stopped");
    stop.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(signal?.reason).toBe(reason);
    expect(upstream.cancelled()).toBe(true);
    expect(h.pending()).toBe(0);
  });

  test("init.signal overrides Request.signal and an already-aborted request never starts", async () => {
    const h = createHarness();
    const stopped = AbortSignal.abort(new Error("original request stopped"));
    const request = new Request("https://provider.test", { signal: stopped });
    let calls = 0;
    const guarded = guardProviderFetch(async () => { calls++; return new Response(null, { status: 204 }); }, h.monitor, h.clock);
    await expect(guarded(request)).rejects.toBe(stopped.reason);
    expect(calls).toBe(0);
    expect(h.pending()).toBe(0);
    expect((await guarded(request, { signal: null })).status).toBe(204);
    expect(calls).toBe(1);
    expect(h.pending()).toBe(0);
  });

  test("downstream stream cancellation cancels upstream and releases the monitor", async () => {
    const h = createHarness();
    const upstream = stream();
    const response = await guardProviderFetch(async () => upstream.response, h.monitor, h.clock)("https://provider.test");
    await response.body?.cancel("consumer stopped");
    expect(upstream.cancelled()).toBe(true);
    expect(h.pending()).toBe(0);
  });

  test("transport errors retain their identity and leave no timers", async () => {
    const h = createHarness();
    const error = new TypeError("fetch failed");
    const guarded = guardProviderFetch(async () => { throw error; }, h.monitor, h.clock);
    await expect(guarded("https://provider.test")).rejects.toBe(error);
    expect(h.pending()).toBe(0);
  });
});

describe("provider selection", () => {
  test("only managed providers without a custom transport are guarded, once", async () => {
    const hooks = await OpenWorkProviderConnection();
    const customFetch = async () => new Response("custom transport");
    const config = { provider: {
      lpr_example: { options: { apiKey: "k", baseURL: "https://provider.test" } },
      openwork: {},
      openai: { options: {} },
      anthropic: { options: { apiKey: "user-key" } },
      lpr_custom: { options: { fetch: customFetch } },
      lpr_explicit: { options: { fetch: null } },
    } };
    await hooks.config(config);
    const first = Reflect.get(config.provider.lpr_example.options, "fetch");
    expect(typeof first).toBe("function");
    expect(typeof Reflect.get(Reflect.get(config.provider.openwork, "options"), "fetch")).toBe("function");
    expect(config.provider.lpr_example.options.apiKey).toBe("k");
    expect(config.provider.lpr_example.options.baseURL).toBe("https://provider.test");
    expect(Reflect.get(config.provider.openai.options, "fetch")).toBeUndefined();
    expect(Reflect.get(config.provider.anthropic.options, "fetch")).toBeUndefined();
    expect(config.provider.lpr_custom.options.fetch).toBe(customFetch);
    expect(config.provider.lpr_explicit.options.fetch).toBeNull();
    await hooks.config(config);
    expect(Reflect.get(config.provider.lpr_example.options, "fetch")).toBe(first);
  });

  test("module exposes only the plugin factory", async () => {
    expect(Object.keys(await import("./openwork-provider-connection.js"))).toEqual(["OpenWorkProviderConnection"]);
  });
});
