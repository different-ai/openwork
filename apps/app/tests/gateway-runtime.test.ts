import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  buildDenAuthUrl,
  createDenClient,
  getDenMcpUrl,
  readDenBootstrapConfig,
  readDenSettings,
  resolveDenBaseUrls,
} from "../src/app/lib/den";
import {
  hydrateOpenworkServerSettingsFromEnv,
  readOpenworkServerSettings,
} from "../src/app/lib/openwork-server";
import { resolveOpenworkConnection } from "../src/react-app/shell/openwork-connection";

const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
const originalDeployment = process.env.VITE_OPENWORK_DEPLOYMENT;

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
}

function getRequestUrl(input: RequestInfo | URL): string {
  if (input instanceof URL) return input.toString();
  if (typeof input === "string") return input;
  return input.url;
}

function installWindow(options: {
  origin: string;
  gateway?: boolean;
  bootstrapToken?: string;
  electronInfo?: {
    baseUrl: string;
    ownerToken: string;
    hostToken?: string;
  };
}) {
  const localStorage = memoryStorage();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage,
      dispatchEvent: () => true,
      location: { origin: options.origin },
      __OPENWORK_GATEWAY__: options.gateway ? { version: 1 } : undefined,
      __OPENWORK_BOOTSTRAP__: options.bootstrapToken ? { token: options.bootstrapToken } : undefined,
      __OPENWORK_ELECTRON__: options.electronInfo
        ? {
            invokeDesktop: async (command: string) => {
              if (command !== "openworkServerInfo") {
                throw new Error(`Unexpected desktop command: ${command}`);
              }
              return {
                running: true,
                baseUrl: options.electronInfo?.baseUrl,
                ownerToken: options.electronInfo?.ownerToken,
                hostToken: options.electronInfo?.hostToken,
              };
            },
          }
        : undefined,
    },
  });
  return localStorage;
}

describe("gateway runtime mode", () => {
  beforeEach(() => {
    process.env.VITE_OPENWORK_DEPLOYMENT = "web";
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: originalFetch,
    });
    if (originalDeployment === undefined) {
      delete process.env.VITE_OPENWORK_DEPLOYMENT;
    } else {
      process.env.VITE_OPENWORK_DEPLOYMENT = originalDeployment;
    }
  });

  test("resolves OpenWork server traffic through the gateway origin with the Den session token", async () => {
    const storage = installWindow({ origin: "https://web.openworklabs.com", gateway: true });
    storage.setItem("openwork.den.authToken", "den-session-token");
    storage.setItem("openwork.server.urlOverride", "https://direct-instance.example.com");
    storage.setItem("openwork.server.token", "stale-instance-token");

    const connection = await resolveOpenworkConnection();

    expect(connection).toEqual({
      normalizedBaseUrl: "https://web.openworklabs.com",
      resolvedToken: "den-session-token",
      resolvedHostToken: "",
      hostInfo: null,
      source: "gateway",
    });
  });

  test("keeps Den web on the configured origin and Den API calls on the gateway origin", () => {
    const storage = installWindow({ origin: "https://gw.example", gateway: true });
    storage.setItem("openwork.den.baseUrl", "https://app.openworklabs.com");
    storage.setItem("openwork.den.authToken", "den-session-token");

    expect(resolveDenBaseUrls("https://gw.example")).toEqual({
      baseUrl: "https://app.openworklabs.com",
      apiBaseUrl: "https://gw.example/api/den",
    });
    expect(readDenSettings().baseUrl).toBe("https://app.openworklabs.com");
    expect(readDenSettings().apiBaseUrl).toBe("https://gw.example/api/den");
    expect(readDenSettings().authToken).toBe("den-session-token");
  });

  test("builds web auth URLs on the Den web origin with the gateway return origin", () => {
    installWindow({ origin: "https://gw.example", gateway: true });

    const authUrl = new URL(buildDenAuthUrl(readDenSettings().baseUrl, "sign-up"));

    expect(authUrl.origin).toBe("https://app.openworklabs.com");
    expect(authUrl.searchParams.get("mode")).toBe("sign-up");
    expect(authUrl.searchParams.get("webAuth")).toBe("1");
    expect(authUrl.searchParams.get("webAuthReturn")).toBe("https://gw.example");
  });

  test("routes Den auth API paths to Den web and v1 paths through the gateway API", async () => {
    installWindow({ origin: "https://gw.example", gateway: true });
    const requestedUrls: string[] = [];
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: RequestInfo | URL) => {
        requestedUrls.push(getRequestUrl(input));
        return new Response(JSON.stringify({
          user: { id: "user_test", email: "user@example.com" },
          token: "tok_test",
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const client = createDenClient({ baseUrl: readDenSettings().baseUrl, token: "tok_test" });
    await client.signInEmail("user@example.com", "password");
    await client.getSession();

    expect(requestedUrls).toEqual([
      "https://app.openworklabs.com/api/auth/sign-in/email",
      "https://gw.example/api/den/v1/me",
    ]);
  });

  test("uses the gateway Den API proxy for MCP", () => {
    installWindow({ origin: "https://gw.example", gateway: true });

    expect(getDenMcpUrl()).toBe("https://gw.example/api/den/mcp");
  });

  test("returns a stable gateway bootstrap snapshot for React external stores", () => {
    installWindow({ origin: "https://web.openworklabs.com", gateway: true });

    const first = readDenBootstrapConfig();
    const second = readDenBootstrapConfig();

    expect(second).toBe(first);
    expect(first.baseUrl).toBe("https://app.openworklabs.com");
    expect(first.apiBaseUrl).toBe("https://web.openworklabs.com/api/den");
  });

  test("does not hydrate an instance bootstrap token into server storage behind the gateway", () => {
    const storage = installWindow({
      origin: "https://web.openworklabs.com",
      gateway: true,
      bootstrapToken: "instance-token-must-not-store",
    });

    hydrateOpenworkServerSettingsFromEnv();

    expect(storage.getItem("openwork.server.token")).toBeNull();
    expect(readOpenworkServerSettings().token).toBeUndefined();
  });
});

describe("non-gateway connection modes", () => {
  beforeEach(() => {
    process.env.VITE_OPENWORK_DEPLOYMENT = "web";
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: originalFetch,
    });
    if (originalDeployment === undefined) {
      delete process.env.VITE_OPENWORK_DEPLOYMENT;
    } else {
      process.env.VITE_OPENWORK_DEPLOYMENT = originalDeployment;
    }
  });

  test("direct instance bootstrap hydration and same-origin resolution are unchanged without the marker", async () => {
    installWindow({ origin: "https://instance.example.com", bootstrapToken: "instance-token" });

    hydrateOpenworkServerSettingsFromEnv();
    const connection = await resolveOpenworkConnection();

    expect(readOpenworkServerSettings().token).toBe("instance-token");
    expect(connection.normalizedBaseUrl).toBe("https://instance.example.com");
    expect(connection.resolvedToken).toBe("instance-token");
    expect(connection.source).toBe("same-origin");
  });

  test("stored server settings still win without the marker", async () => {
    const storage = installWindow({ origin: "https://instance.example.com" });
    storage.setItem("openwork.server.urlOverride", "https://manual.example.com");
    storage.setItem("openwork.server.token", "manual-token");
    storage.setItem("openwork.server.hostToken", "host-token");

    const connection = await resolveOpenworkConnection();

    expect(connection.normalizedBaseUrl).toBe("https://manual.example.com");
    expect(connection.resolvedToken).toBe("manual-token");
    expect(connection.resolvedHostToken).toBe("");
    expect(connection.source).toBe("stored-settings");
  });

  test("plain web Den settings still use a stored custom base URL without the marker", () => {
    const storage = installWindow({ origin: "https://instance.example.com" });
    storage.setItem("openwork.den.baseUrl", "https://den.self-hosted.example.com");

    expect(readDenSettings().baseUrl).toBe("https://den.self-hosted.example.com");
    expect(readDenSettings().apiBaseUrl).toBe("https://den.self-hosted.example.com/api/den");
  });

  test("desktop runtime still uses live desktop server info without the marker", async () => {
    installWindow({
      origin: "https://instance.example.com",
      electronInfo: {
        baseUrl: "http://127.0.0.1:8787",
        ownerToken: "owner-token",
        hostToken: "host-token",
      },
    });

    const connection = await resolveOpenworkConnection();

    expect(connection.normalizedBaseUrl).toBe("http://127.0.0.1:8787");
    expect(connection.resolvedToken).toBe("owner-token");
    expect(connection.resolvedHostToken).toBe("host-token");
    expect(connection.source).toBe("desktop-runtime");
  });
});
