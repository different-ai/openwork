import { afterEach, describe, expect, jest, test } from "bun:test";

const { createDesktopFetch } = await import("../src/app/lib/opencode");

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
  return createDesktopFetch();
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

describe("Desktop OpenCode transport timeouts", () => {
  afterEach(() => {
    jest.useRealTimers();
    restoreGlobals();
  });

  test.each(["URL", "Request"])("preserves caller cancellation and the deadline on history GETs (%s)", async (transport) => {
    jest.useFakeTimers();
    installWindow({ __OPENWORK_ELECTRON__: {} });
    const { observedSignal, attempts } = installControllableFetch();
    const fetchImpl = createCapturedFetch();
    const url = "http://127.0.0.1:8788/workspace/ws_test/opencode2/api/session/ses_1/message";
    for (const cause of ["preaborted", "caller", "deadline"]) {
      const caller = new AbortController();
      const reason = new DOMException("History read canceled", "AbortError");
      if (cause === "preaborted") caller.abort(reason);
      const before = attempts();
      const result = (transport === "URL"
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
    const response = await createDesktopFetch("fixture-token")(
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

  test("preserves caller cancellation on ordinary requests", async () => {
    installWindow({ __OPENWORK_ELECTRON__: {} });
    const { observedSignal } = installControllableFetch();
    const fetchImpl = createCapturedFetch();
    const controller = new AbortController();
    const response = fetchImpl(new Request("http://127.0.0.1:8788/api/session/ses_read", { signal: controller.signal }));
    const outcome = response.catch((error: unknown) => error);
    const reason = new Error("Read cancelled");
    controller.abort(reason);
    expect(observedSignal()?.aborted).toBe(true);
    expect(await outcome).toBe(reason);
  });

  test("RequestInit.signal overrides Request.signal", async () => {
    installWindow({ __OPENWORK_ELECTRON__: {} });
    const { observedSignal } = installControllableFetch();
    const fetchImpl = createCapturedFetch();
    const requestController = new AbortController();
    const initController = new AbortController();
    const response = fetchImpl(new Request("http://127.0.0.1:8788/api/session/ses_read", {
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

  test("RequestInit.signal=null disconnects the input Request signal", async () => {
    jest.useFakeTimers();
    installWindow({ __OPENWORK_ELECTRON__: {} });
    const { observedSignal } = installControllableFetch();
    const fetchImpl = createCapturedFetch();
    const controller = new AbortController();
    const response = fetchImpl(new Request("http://127.0.0.1:8788/api/session/ses_read", {
      signal: controller.signal,
    }), { signal: null });
    const outcome = response.catch((error: unknown) => error);
    controller.abort();
    expect(observedSignal()?.aborted).toBe(false);
    jest.advanceTimersByTime(10_000);
    expect(await outcome).toMatchObject({ message: "Request timed out." });
    expect(observedSignal()?.aborted).toBe(true);
  });

  test("transport deadline aborts requests even with a caller signal", async () => {
    jest.useFakeTimers();
    installWindow({ __OPENWORK_ELECTRON__: {} });
    const { observedSignal } = installControllableFetch();
    const fetchImpl = createCapturedFetch();
    const controller = new AbortController();
    const response = fetchImpl(new Request("http://127.0.0.1:8788/api/session/ses_read", { signal: controller.signal }));
    const outcome = response.catch((error: unknown) => error);
    jest.advanceTimersByTime(10_000);
    expect(await outcome).toMatchObject({ message: "Request timed out." });
    expect(observedSignal()?.aborted).toBe(true);
    expect(controller.signal.aborted).toBe(false);
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

  test("leaves desktop OpenCode event streams untimed", async () => {
    installWindow({ __OPENWORK_ELECTRON__: {} });
    const { cancel, observedSignal } = installControllableFetch();
    const fetchImpl = createCapturedFetch();

    const response = fetchImpl("https://web.example/workspace/ws_test/opencode2/api/event", {
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
