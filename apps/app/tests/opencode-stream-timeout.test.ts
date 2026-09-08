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
  const fetchImpl: typeof globalThis.fetch = (input, init) => {
    attempts += 1;
    observedSignal = init?.signal ?? (input instanceof Request ? input.signal : null);
    return new Promise<Response>((_resolve, reject) => {
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
