import { afterEach, describe, expect, test } from "bun:test";

import { createOpenworkServerStore } from "../src/react-app/domains/connections/openwork-server-store";

const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;

type BridgeCalls = { info: number; restart: number };

function installDesktopWindow(input: {
  serverInfo: (() => unknown) | null;
  restartInfo?: () => unknown;
  calls: BridgeCalls;
}) {
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => void storage.set(key, value),
        removeItem: (key: string) => void storage.delete(key),
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      __OPENWORK_ELECTRON__: {
        invokeDesktop: async (command: string) => {
          if (command === "openworkServerInfo") {
            input.calls.info += 1;
            if (!input.serverInfo) throw new Error("server info unavailable");
            return input.serverInfo();
          }
          if (command === "openworkServerRestart") {
            input.calls.restart += 1;
            if (!input.restartInfo) throw new Error("restart unavailable");
            return input.restartInfo();
          }
          throw new Error(`Unexpected desktop command: ${command}`);
        },
      },
    },
  });
}

function createStore() {
  return createOpenworkServerStore({
    startupPreference: () => "server",
    documentVisible: () => true,
    developerMode: () => false,
    runtimeWorkspaceId: () => "workspace_local",
    activeClient: () => null,
    selectedWorkspaceDisplay: () => ({
      id: "workspace_local",
      name: "Local",
      path: "/tmp/openwork-restart-guard",
      preset: "starter",
      workspaceType: "local",
    }),
    restartLocalServer: async () => true,
    createRemoteWorkspaceFlow: async () => false,
  });
}

const HEALTHY_INFO = {
  running: true,
  baseUrl: "http://127.0.0.1:61234",
  port: 61234,
  clientToken: "client-token",
  hostToken: "host-token",
  ownerToken: "owner-token",
  remoteAccessEnabled: false,
};

afterEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
  globalThis.fetch = originalFetch;
});

describe("local openwork server recovery restart guard", () => {
  test("a fresh store with a healthy live server never restarts it", async () => {
    const calls: BridgeCalls = { info: 0, restart: 0 };
    installDesktopWindow({ serverInfo: () => HEALTHY_INFO, calls });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ ok: true, version: "test", uptimeMs: 1 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const store = createStore();
    // Fresh store: no start(), no observed host info — the exact state a
    // just-mounted Settings route races its cloud reconcile against.
    const client = await store.ensureLocalOpenworkServerClient();

    expect(client).not.toBeNull();
    expect(client?.baseUrl).toBe("http://127.0.0.1:61234");
    expect(calls.restart).toBe(0);
  });

  test("a genuinely dead local server still restarts", async () => {
    const calls: BridgeCalls = { info: 0, restart: 0 };
    installDesktopWindow({
      // The bridge answers, but the recorded server is gone.
      serverInfo: () => ({ running: false, baseUrl: "", clientToken: "" }),
      restartInfo: () => HEALTHY_INFO,
      calls,
    });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ ok: true, version: "test", uptimeMs: 1 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const store = createStore();
    const client = await store.ensureLocalOpenworkServerClient();

    expect(calls.restart).toBe(1);
    expect(client).not.toBeNull();
    expect(client?.baseUrl).toBe("http://127.0.0.1:61234");
  });
});
