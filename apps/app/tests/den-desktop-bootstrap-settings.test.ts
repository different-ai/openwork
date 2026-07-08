import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  initializeDenBootstrapConfig,
  readDenSettings,
  setDenBootstrapConfig,
  writeDenSettings,
} from "../src/app/lib/den";

const originalWindow = globalThis.window;

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

describe("desktop Den bootstrap settings", () => {
  let bootstrapConfig: { baseUrl: string; requireSignin: boolean; writtenAt?: string };

  beforeEach(() => {
    bootstrapConfig = {
      baseUrl: "https://bootstrap.example.com",
      requireSignin: false,
    };

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: memoryStorage(),
        dispatchEvent: () => true,
        __OPENWORK_ELECTRON__: {
          invokeDesktop: async (command: string, payload?: { baseUrl: string; requireSignin: boolean }) => {
            if (command === "getDesktopBootstrapConfig") return bootstrapConfig;
            if (command === "setDesktopBootstrapConfig" && payload) {
              bootstrapConfig = {
                baseUrl: payload.baseUrl,
                requireSignin: payload.requireSignin,
                writtenAt: "2026-07-08T00:00:00.000Z",
              };
              return bootstrapConfig;
            }
            throw new Error(`Unexpected desktop command: ${command}`);
          },
        },
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  });

  test("reads the desktop base URL from bootstrap instead of stale localStorage", async () => {
    window.localStorage.setItem("openwork.den.baseUrl", "https://stale.example.com");
    window.localStorage.setItem("openwork.den.apiBaseUrl", "https://api.example.com");

    await initializeDenBootstrapConfig();

    const settings = readDenSettings();
    expect(settings.baseUrl).toBe("https://bootstrap.example.com");
    expect(settings.apiBaseUrl).toBe("https://bootstrap.example.com/api/den");
  });

  test("saves base URL changes to bootstrap and clears legacy endpoint storage", async () => {
    await initializeDenBootstrapConfig();
    window.localStorage.setItem("openwork.den.baseUrl", "https://stale.example.com");
    window.localStorage.setItem("openwork.den.apiBaseUrl", "https://api.example.com");

    await setDenBootstrapConfig({
      baseUrl: "https://saved.example.com",
      requireSignin: false,
    });
    writeDenSettings({
      baseUrl: "https://saved.example.com",
      authToken: "tok_test",
      activeOrgId: null,
      activeOrgSlug: null,
      activeOrgName: null,
    });

    expect(bootstrapConfig.baseUrl).toBe("https://saved.example.com");
    expect(window.localStorage.getItem("openwork.den.baseUrl")).toBeNull();
    expect(window.localStorage.getItem("openwork.den.apiBaseUrl")).toBeNull();
    expect(readDenSettings().baseUrl).toBe("https://saved.example.com");
  });
});
