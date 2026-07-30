import { afterEach, describe, expect, mock, test } from "bun:test";

let capturedFetch: typeof globalThis.fetch | null = null;

async function unusedSessionMethod() {
  throw new Error("SDK mock method should not be called");
}

mock.module("@opencode-ai/sdk/v2/client", () => ({
  createOpencodeClient: (options: { fetch?: typeof globalThis.fetch }) => {
    capturedFetch = options.fetch ?? null;
    return {
      session: {
        list: unusedSessionMethod,
        get: unusedSessionMethod,
        messages: unusedSessionMethod,
        todo: unusedSessionMethod,
        promptAsync: unusedSessionMethod,
        command: unusedSessionMethod,
      },
    };
  },
}));

const { createClient } = await import("../src/app/lib/opencode");

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
  let observedSignal: AbortSignal | null = null;
  let rejectResponse: ((reason: unknown) => void) | null = null;
  const fetchImpl: typeof globalThis.fetch = (input, init) => {
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
