import { afterEach, describe, expect, jest, mock, test } from "bun:test";

let capturedFetch: typeof globalThis.fetch | null = null;

const { createOpencodeClient: createSDKClient } = await import("@opencode-ai/sdk/v2/client");

mock.module("@opencode-ai/sdk/v2/client", () => ({
  createOpencodeClient: (options: Parameters<typeof createSDKClient>[0]) => {
    capturedFetch = options?.fetch ?? null;
    return createSDKClient(options);
  },
}));

const { createClient, createPromptMessageID, PromptAdmissionUnknownError, hasAcceptedPromptMessage } = await import("../src/app/lib/opencode");

const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;

type PromiseState = "pending" | "fulfilled" | "rejected";

function installWindow(value: unknown) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value,
  });
}

function restoreGlobals() {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: originalFetch,
  });
  capturedFetch = null;
}

function installControllableFetch() {
  let attempts = 0;
  let observedSignal: AbortSignal | null = null;
  let rejectResponse: ((reason: unknown) => void) | null = null;
  let resolveResponse: ((response: Response) => void) | null = null;
  const fetchImpl: typeof globalThis.fetch = (input, init) => {
    attempts += 1;
    observedSignal = init?.signal ?? (input instanceof Request ? input.signal : null);
    return new Promise<Response>((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
      if (!observedSignal) return;
      const abort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
      if (observedSignal.aborted) {
        abort();
        return;
      }
      observedSignal.addEventListener("abort", abort, { once: true });
    });
  };
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: fetchImpl,
  });
  return {
    attempts: () => attempts,
    observedSignal: () => observedSignal,
    cancel: () => rejectResponse?.(new Error("test cleanup")),
    complete: (response: Response) => resolveResponse?.(response),
  };
}

function createCapturedFetch() {
  capturedFetch = null;
  createClient("https://web.example/workspace/ws_test/opencode");
  if (!capturedFetch) {
    throw new Error("SDK mock did not receive an OpenCode fetch implementation");
  }
  return capturedFetch;
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function trackPromise<T>(promise: Promise<T>) {
  let state: PromiseState = "pending";
  void promise.then(
    () => {
      state = "fulfilled";
    },
    () => {
      state = "rejected";
    },
  );
  return () => state;
}

describe("OpenCode transport timeouts", () => {
  afterEach(() => {
    jest.useRealTimers();
    restoreGlobals();
  });

  test.each(["web URL", "web Request", "desktop Request"])("preserves caller cancellation and the deadline on history GETs (%s)", async (transport) => {
    jest.useFakeTimers();
    installWindow(transport === "desktop Request" ? { __OPENWORK_ELECTRON__: {} } : undefined);
    const { observedSignal, attempts } = installControllableFetch();
    const fetchImpl = createCapturedFetch();
    const url = "http://127.0.0.1:8788/workspace/ws_test/opencode/session/ses_1/message";
    for (const cause of ["preaborted", "caller", "deadline"]) {
      const caller = new AbortController();
      const reason = new DOMException("History read canceled", "AbortError");
      if (cause === "preaborted") caller.abort(reason);
      const before = attempts();
      const result = (transport === "web URL"
        ? fetchImpl(url, { signal: caller.signal })
        : fetchImpl(new Request(url, { signal: caller.signal }))).catch((error: unknown) => error);
      if (cause === "caller") caller.abort(reason);
      if (cause === "deadline") jest.advanceTimersByTime(10_000);
      const error = await result;
      if (cause === "deadline") {
        expect(error).toMatchObject({ message: "Request timed out." });
        expect(caller.signal.aborted).toBe(false);
      } else expect(error).toBe(reason);
      expect(attempts() - before).toBe(cause === "preaborted" ? 0 : 1);
      if (cause !== "preaborted") expect(observedSignal()?.aborted).toBe(true);
    }
  });

  test("desktop history Request init overrides signal and headers without dropping authentication", async () => {
    installWindow({ __OPENWORK_ELECTRON__: {} });
    const { createDesktopFetch } = await import("../src/app/lib/opencode");
    let seen: Request | undefined;
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        seen = new Request(input, init);
        return new Response("[]");
      },
    });
    const original = new AbortController();
    const override = new AbortController();
    const response = await createDesktopFetch({ mode: "openwork", token: "fixture-token" })(
      new Request("http://127.0.0.1/session/ses_1/message", { signal: original.signal, headers: { "x-old": "old" } }),
      { signal: override.signal, headers: { "x-new": "new" } },
    );
    expect(response.status).toBe(200);
    expect(seen?.headers.get("Authorization")).toBe("Bearer fixture-token");
    expect(seen?.headers.get("x-new")).toBe("new");
    expect(seen?.headers.has("x-old")).toBe(false);
    original.abort();
    expect(seen?.signal.aborted).toBe(false);
    override.abort();
    expect(seen?.signal.aborted).toBe(true);
  });

  test.each(["caller", "deadline"])("remote history %s cancellation reaches main and survives IPC error wrapping", async (cause) => {
    jest.useFakeTimers();
    const calls: string[] = [];
    let transferId: string | undefined;
    let rejectFetch: ((error: Error) => void) | undefined;
    installWindow({ __OPENWORK_ELECTRON__: {
      invokeDesktop: (command: string, value: string, init?: { transferId?: string }) => {
        calls.push(command);
        if (command === "__cancelTransfer") {
          expect(value).toBe(transferId);
          rejectFetch?.(new Error("IPC fetch aborted"));
          return Promise.resolve(true);
        }
        transferId = init?.transferId;
        return new Promise((_resolve, reject) => { rejectFetch = reject; });
      },
    } });
    const fetchImpl = createCapturedFetch();
    const caller = new AbortController();
    const reason = new DOMException("History read canceled", "AbortError");
    const result = fetchImpl(new Request("https://worker.example/session/ses_1/message", { signal: caller.signal }))
      .catch((error: unknown) => error);
    expect(transferId).toBeString();
    if (cause === "caller") caller.abort(reason);
    else jest.advanceTimersByTime(10_000);
    const error = await result;
    if (cause === "caller") expect(error).toBe(reason);
    else {
      expect(error).toMatchObject({ message: "Request timed out." });
      expect(caller.signal.aborted).toBe(false);
    }
    expect(calls).toEqual(["__fetch", "__cancelTransfer"]);
  });

  test("remote preaborted GETs do not enter IPC and POSTs do not gain read cancellation", async () => {
    const { desktopFetch } = await import("../src/app/lib/desktop");
    const calls: string[] = [];
    installWindow({ __OPENWORK_ELECTRON__: {
      invokeDesktop: async (command: string, _url: string, init?: { transferId?: string; body?: string }) => {
        calls.push(command);
        expect(init?.transferId).toBeUndefined();
        expect(init?.body).toBe("{}");
        return { status: 204, statusText: "No Content", headers: [], body: "" };
      },
    } });
    const caller = new AbortController();
    caller.abort();
    await expect(desktopFetch(new Request("https://worker.example/session/ses_1/message", { signal: caller.signal })))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toEqual([]);
    expect((await desktopFetch("https://worker.example/session/ses_1/prompt_async", {
      method: "POST", signal: caller.signal, body: "{}",
    })).status).toBe(204);
    expect(calls).toEqual(["__fetch"]);
  });

  test("does not transport-timeout web OpenCode event streams", async () => {
    installWindow(undefined);
    const { cancel, observedSignal } = installControllableFetch();
    const fetchImpl = createCapturedFetch();

    const response = fetchImpl("https://web.example/workspace/ws_test/opencode/event", {
      headers: { Accept: "text/event-stream" },
    });
    const state = trackPromise(response);

    try {
      await delay(10_050);

      expect(observedSignal()).toBeNull();
      expect(state()).toBe("pending");
    } finally {
      cancel();
    }
  }, 15_000);

  test("keeps timing out ordinary web OpenCode requests", async () => {
    installWindow(undefined);
    const { cancel, observedSignal } = installControllableFetch();
    const fetchImpl = createCapturedFetch();

    const response = fetchImpl("https://web.example/workspace/ws_test/opencode/global/health");
    const errorPromise = response.catch((error: unknown) => error);

    try {
      const error = await errorPromise;
      expect(error).toMatchObject({ message: "Request timed out." });
      expect(observedSignal()?.aborted).toBe(true);
    } finally {
      cancel();
    }
  }, 15_000);

  test.each(["web URL", "web Request", "desktop Request"])("preserves caller cancellation on ordinary requests (%s)", async (transport) => {
    installWindow(transport === "desktop Request" ? { __OPENWORK_ELECTRON__: {} } : undefined);
    const { observedSignal } = installControllableFetch();
    const fetchImpl = createCapturedFetch();
    const controller = new AbortController();
    const url = "http://127.0.0.1:8788/session/ses_archive";
    const response = transport === "web URL"
      ? fetchImpl(url, { signal: controller.signal })
      : fetchImpl(new Request(url, { signal: controller.signal }));
    const outcome = response.catch((error: unknown) => error);
    const reason = new Error("Archive verification cancelled");
    controller.abort(reason);
    expect(observedSignal()?.aborted).toBe(true);
    expect(await outcome).toBe(reason);
  });

  test.each(["web", "desktop"])("RequestInit.signal overrides Request.signal (%s)", async (transport) => {
    installWindow(transport === "desktop" ? { __OPENWORK_ELECTRON__: {} } : undefined);
    const { observedSignal } = installControllableFetch();
    const fetchImpl = createCapturedFetch();
    const requestController = new AbortController();
    const initController = new AbortController();
    const response = fetchImpl(new Request("http://127.0.0.1:8788/session/ses_archive", {
      signal: requestController.signal,
    }), { signal: initController.signal });
    const outcome = response.catch((error: unknown) => error);
    requestController.abort();
    expect(observedSignal()?.aborted).toBe(false);
    const reason = new Error("Cancelled through RequestInit");
    initController.abort(reason);
    expect(observedSignal()?.aborted).toBe(true);
    expect(await outcome).toBe(reason);
  });

  test.each(["web", "desktop"])("RequestInit.signal=null disconnects the input Request signal (%s)", async (transport) => {
    jest.useFakeTimers();
    installWindow(transport === "desktop" ? { __OPENWORK_ELECTRON__: {} } : undefined);
    const { observedSignal } = installControllableFetch();
    const fetchImpl = createCapturedFetch();
    const controller = new AbortController();
    const response = fetchImpl(new Request("http://127.0.0.1:8788/session/ses_archive", {
      signal: controller.signal,
    }), { signal: null });
    const outcome = response.catch((error: unknown) => error);
    controller.abort();
    expect(observedSignal()?.aborted).toBe(false);
    jest.advanceTimersByTime(10_000);
    expect(await outcome).toMatchObject({ message: "Request timed out." });
    expect(observedSignal()?.aborted).toBe(true);
  });

  test.each(["web URL", "web Request", "desktop Request"])("transport deadline aborts requests even with a caller signal (%s)", async (transport) => {
    jest.useFakeTimers();
    installWindow(transport === "desktop Request" ? { __OPENWORK_ELECTRON__: {} } : undefined);
    const { observedSignal } = installControllableFetch();
    const fetchImpl = createCapturedFetch();
    const controller = new AbortController();
    const url = "http://127.0.0.1:8788/session/ses_archive";
    const response = transport === "web URL"
      ? fetchImpl(url, { signal: controller.signal })
      : fetchImpl(new Request(url, { signal: controller.signal }));
    const outcome = response.catch((error: unknown) => error);
    jest.advanceTimersByTime(10_000);
    expect(await outcome).toMatchObject({ message: "Request timed out." });
    expect(observedSignal()?.aborted).toBe(true);
    expect(controller.signal.aborted).toBe(false);
  });

  test.each(["web URL", "web Request", "desktop Request"])("bounds prompt_async acceptance at 30 seconds without resending (%s)", async (transport) => {
    jest.useFakeTimers();
    installWindow(transport === "desktop Request" ? { __OPENWORK_ELECTRON__: {} } : undefined);
    const { cancel, observedSignal, attempts } = installControllableFetch();
    const fetchImpl = createCapturedFetch();

    const url = "http://127.0.0.1:8788/workspace/ws_test/opencode/session/ses_send/prompt_async";
    const init = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    };
    const response = transport === "web URL" ? fetchImpl(url, init) : fetchImpl(new Request(url, init));
    const state = trackPromise(response);
    const errorPromise = response.catch((error: unknown) => error);

    try {
      expect(observedSignal()).not.toBeNull();
      jest.advanceTimersByTime(29_999);
      await Promise.resolve();
      expect(observedSignal()?.aborted).toBe(false);
      expect(state()).toBe("pending");

      jest.advanceTimersByTime(1);
      expect(await errorPromise).toBeInstanceOf(PromptAdmissionUnknownError);
      expect(observedSignal()?.aborted).toBe(true);
      jest.advanceTimersByTime(60_000);
      expect(attempts()).toBe(1);
    } finally {
      cancel();
    }
  });

  test.each(["", "/ses_send/prompt"])("desktop v2 cold session write %s survives 21 seconds of organization setup", async (suffix) => {
    jest.useFakeTimers();
    installWindow({ __OPENWORK_ELECTRON__: {} });
    const { observedSignal, attempts, complete, cancel } = installControllableFetch();
    const fetchImpl = createCapturedFetch();
    const pending = fetchImpl(new Request(`http://127.0.0.1:8788/workspace/ws_test/opencode2/api/session${suffix}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    }));
    const state = trackPromise(pending);
    try {
      jest.advanceTimersByTime(21_000);
      await Promise.resolve();
      expect(observedSignal()?.aborted).toBe(false);
      expect(state()).toBe("pending");
      complete(new Response("{}", { status: 200 }));
      expect((await pending).status).toBe(200);
      expect(attempts()).toBe(1);
    } finally { cancel(); }
  });

  test.each(["", "/ses_send/prompt"])("desktop v2 session write %s still has a bounded deadline and is not resent", async (suffix) => {
    jest.useFakeTimers();
    installWindow({ __OPENWORK_ELECTRON__: {} });
    const { observedSignal, attempts, cancel } = installControllableFetch();
    const pending = createCapturedFetch()(new Request(`http://127.0.0.1:8788/workspace/ws_test/opencode2/api/session${suffix}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    })).catch((error: unknown) => error);
    try {
      jest.advanceTimersByTime(59_999);
      expect(observedSignal()?.aborted).toBe(false);
      jest.advanceTimersByTime(1);
      expect(await pending).toMatchObject({ message: "Request timed out." });
      expect(observedSignal()?.aborted).toBe(true);
      jest.advanceTimersByTime(60_000);
      expect(attempts()).toBe(1);
    } finally { cancel(); }
  });

  test("desktop v2 session browsing retains its ordinary read deadline", async () => {
    jest.useFakeTimers();
    installWindow({ __OPENWORK_ELECTRON__: {} });
    const { observedSignal, cancel } = installControllableFetch();
    const pending = createCapturedFetch()(new Request("http://127.0.0.1:8788/workspace/ws_test/opencode2/api/session"))
      .catch((error: unknown) => error);
    try {
      jest.advanceTimersByTime(10_000);
      expect(await pending).toMatchObject({ message: "Request timed out." });
      expect(observedSignal()?.aborted).toBe(true);
    } finally { cancel(); }
  });

  test("keeps synchronous command and summarize requests untimed", async () => {
    jest.useFakeTimers();
    installWindow(undefined);
    const { cancel, observedSignal } = installControllableFetch();
    const fetchImpl = createCapturedFetch();

    for (const path of ["command", "summarize"]) {
      const response = fetchImpl(`https://web.example/workspace/ws_test/opencode/session/ses_send/${path}`, {
        method: "POST",
      });
      const state = trackPromise(response);
      const settled = response.catch(() => undefined);
      jest.advanceTimersByTime(5 * 60_000);
      await Promise.resolve();
      expect(observedSignal()).toBeNull();
      expect(state()).toBe("pending");
      cancel();
      await settled;
    }
  });

  test.each([408, 500, 502, 503, 504, "network", "malformed"])("preserves uncertain prompt admission without replay (%s)", async (failure) => {
    installWindow(undefined);
    const requests: Request[] = [];
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input, init));
        if (failure === "network") throw new TypeError("connection lost");
        return new Response("not json", { status: failure === "malformed" ? 200 : failure });
      },
    });
    const client = createClient("https://web.example/workspace/ws_test/opencode", "/workspace/test");
    const messageID = createPromptMessageID();
    await expect(client.session.promptAsync({
      sessionID: "ses_parent", messageID, parts: [{ type: "text", text: "follow up" }],
    })).rejects.toMatchObject({ name: "PromptAdmissionUnknownError", admission: "unknown", messageID });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.url).toBe("https://web.example/workspace/ws_test/opencode/session/ses_parent/prompt_async");
    expect(requests[0]?.headers.get("x-opencode-directory")).toBe("/workspace/test");
    expect(await requests[0]?.json()).toMatchObject({ messageID });
  });

  test("keeps explicit client rejection distinct from unknown admission", async () => {
    installWindow(undefined);
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async () => Response.json({ message: "invalid prompt" }, { status: 400 }),
    });
    const client = createClient("https://web.example");
    const result = await client.session.promptAsync({ sessionID: "ses_parent", parts: [] });
    expect(result.error).toEqual({ message: "invalid prompt" });
  });

  test.each(["prompt", "acceptance check"])("bounds a stalled response body without repeating the %s", async (operation) => {
    jest.useFakeTimers();
    installWindow(undefined);
    let attempts = 0;
    let body: ReadableStreamDefaultController<Uint8Array> | undefined;
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async () => {
        attempts += 1;
        return new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller; } }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      },
    });
    const client = createClient("https://web.example");
    const messageID = createPromptMessageID();
    const result = (operation === "prompt"
      ? client.session.promptAsync({ sessionID: "ses_parent", messageID, parts: [] })
      : hasAcceptedPromptMessage(client, "ses_parent", messageID)).catch((error: unknown) => error);
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    jest.advanceTimersByTime(operation === "prompt" ? 30_000 : 10_000);
    const error = await result;
    if (operation === "prompt") expect(error).toMatchObject({ admission: "unknown", messageID });
    else expect(error).toMatchObject({ message: "Acceptance check timed out. The message is still held." });
    jest.advanceTimersByTime(60_000);
    expect(attempts).toBe(1);
    body?.close();
  });

  test("the bounded native POST preserves the same message ID on its unknown error", async () => {
    jest.useFakeTimers();
    installWindow(undefined);
    const { attempts } = installControllableFetch();
    const client = createClient("https://web.example");
    const messageID = createPromptMessageID();
    const error = client.session.promptAsync({ sessionID: "ses_parent", messageID, parts: [] }).catch((error: unknown) => error);
    jest.advanceTimersByTime(30_000);
    expect(await error).toMatchObject({ admission: "unknown", messageID });
    jest.advanceTimersByTime(60_000);
    expect(attempts()).toBe(1);
  });

  test("lets caller AbortSignal cancel web streams", async () => {
    installWindow(undefined);
    const { cancel, observedSignal } = installControllableFetch();
    const fetchImpl = createCapturedFetch();
    const controller = new AbortController();

    const response = fetchImpl("https://web.example/workspace/ws_test/opencode/output", {
      headers: { Accept: "text/event-stream" },
      signal: controller.signal,
    });
    const errorPromise = response.catch((error: unknown) => error);

    try {
      controller.abort();

      expect(observedSignal()).toBe(controller.signal);
      const error = await errorPromise;
      expect(error).toMatchObject({ name: "AbortError" });
    } finally {
      cancel();
    }
  }, 15_000);

  test("leaves desktop OpenCode event streams untimed", async () => {
    installWindow({ __OPENWORK_ELECTRON__: {} });
    const { cancel, observedSignal } = installControllableFetch();
    const fetchImpl = createCapturedFetch();

    const response = fetchImpl("https://web.example/workspace/ws_test/opencode/event", {
      headers: { Accept: "text/event-stream" },
    });
    const state = trackPromise(response);

    try {
      await Promise.resolve();

      expect(observedSignal()).toBeNull();
      expect(state()).toBe("pending");
    } finally {
      cancel();
    }
  });
});
