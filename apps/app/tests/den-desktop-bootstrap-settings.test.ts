import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  clearDenSession,
  CLOUD_MCP_SYNC_MARKER_STORAGE_KEY,
  initializeDenBootstrapConfig,
  readDenBootstrapConfig,
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
  let bootstrapConfig: {
    baseUrl: string;
    apiBaseUrl?: string;
    requireSignin: boolean;
    fromFile?: boolean;
    writtenAt?: string;
    claimLinks?: Array<{ id: string; role: string; url: string; expiresAt: string }>;
    prepared?: {
      orgId: string;
      orgName: string;
      orgSlug: string;
      skillId: string;
      skillTitle: string;
      skillsDir: string;
      skillPath: string;
      preparedAt: string;
    };
  };

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
          invokeDesktop: async (command: string, payload?: { baseUrl: string; apiBaseUrl?: string | null; requireSignin: boolean }) => {
            if (command === "getDesktopBootstrapConfig") return bootstrapConfig;
            if (command === "setDesktopBootstrapConfig" && payload) {
              bootstrapConfig = {
                baseUrl: payload.baseUrl,
                ...(payload.apiBaseUrl ? { apiBaseUrl: payload.apiBaseUrl } : {}),
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

  test("keeps the prepared workspace and claim action in the shared bootstrap snapshot", async () => {
    bootstrapConfig.claimLinks = [{
      id: "claim_owner",
      role: "owner",
      url: "https://bootstrap.example.com/workspace-claim?token=secret",
      expiresAt: "2026-07-15T00:00:00.000Z",
    }];
    bootstrapConfig.prepared = {
      orgId: "org_demo",
      orgName: "Different AI",
      orgSlug: "different-ai",
      skillId: "skill_demo",
      skillTitle: "Customer Briefing",
      skillsDir: "/tmp/skills",
      skillPath: "/tmp/skills/customer-briefing/SKILL.md",
      preparedAt: "2026-07-14T00:00:00.000Z",
    };

    await initializeDenBootstrapConfig();

    expect(readDenBootstrapConfig().prepared?.orgName).toBe("Different AI");
    expect(readDenBootstrapConfig().claimLinks?.[0]?.role).toBe("owner");
  });

  test("threads desktop bootstrap file origin into the shared bootstrap snapshot", async () => {
    bootstrapConfig.fromFile = true;

    await initializeDenBootstrapConfig();

    expect(readDenBootstrapConfig().source).toBe("file");
  });

  test("uses preload desktop bootstrap before async desktop IPC", async () => {
    let ipcReads = 0;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: memoryStorage(),
        dispatchEvent: () => true,
        __OPENWORK_ELECTRON__: {
          meta: {
            desktopBootstrap: {
              baseUrl: "https://preload.example.com",
              requireSignin: true,
              fromFile: true,
            },
          },
          invokeDesktop: async (command: string) => {
            if (command === "getDesktopBootstrapConfig") ipcReads += 1;
            throw new Error(`Unexpected desktop command: ${command}`);
          },
        },
      },
    });

    await initializeDenBootstrapConfig();

    expect(readDenBootstrapConfig().baseUrl).toBe("https://preload.example.com");
    expect(readDenBootstrapConfig().source).toBe("file");
    expect(ipcReads).toBe(0);
  });

  test("uses Den Web runtime-config API URL as the desktop source of truth", async () => {
    const fetches: string[] = [];
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: memoryStorage(),
        dispatchEvent: () => true,
        __OPENWORK_ELECTRON__: {
          invokeDesktop: async (command: string, url?: string) => {
            if (command === "getDesktopBootstrapConfig") {
              return {
                baseUrl: "https://app.runtime.example.com",
                requireSignin: false,
              };
            }
            if (command === "__fetch" && typeof url === "string") {
              fetches.push(url);
              return {
                status: 200,
                statusText: "OK",
                headers: [["content-type", "application/json"]],
                body: JSON.stringify({ denApiUrl: "https://api.override.example.com" }),
              };
            }
            throw new Error(`Unexpected desktop command: ${command}`);
          },
        },
      },
    });

    await initializeDenBootstrapConfig();

    expect(fetches).toEqual(["https://app.runtime.example.com/api/runtime-config"]);
    expect(readDenBootstrapConfig().baseUrl).toBe("https://app.runtime.example.com");
    expect(readDenBootstrapConfig().apiBaseUrl).toBe("https://api.override.example.com");
  });

  test("falls back to the same-origin API path when runtime-config is unavailable", async () => {
    await initializeDenBootstrapConfig();

    expect(readDenBootstrapConfig().baseUrl).toBe("https://bootstrap.example.com");
    expect(readDenBootstrapConfig().apiBaseUrl).toBe("https://bootstrap.example.com/api/den");
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

  test("sends and preserves an explicit direct API base through desktop IPC", async () => {
    await initializeDenBootstrapConfig();

    await setDenBootstrapConfig({
      baseUrl: "https://app.saved.example.com",
      apiBaseUrl: "https://api.saved.example.com",
      requireSignin: true,
    });

    expect(bootstrapConfig.apiBaseUrl).toBe("https://api.saved.example.com");
    expect(readDenBootstrapConfig().apiBaseUrl).toBe("https://api.saved.example.com");
    expect(readDenSettings().apiBaseUrl).toBe("https://api.saved.example.com");
  });

  test("session or server changes invalidate configured Cloud MCP token markers", async () => {
    await initializeDenBootstrapConfig();
    window.localStorage.setItem(CLOUD_MCP_SYNC_MARKER_STORAGE_KEY, "stale-marker");

    writeDenSettings({
      baseUrl: "https://bootstrap.example.com",
      authToken: "first-session",
      activeOrgId: "org_test",
      activeOrgSlug: null,
      activeOrgName: null,
    });
    expect(window.localStorage.getItem(CLOUD_MCP_SYNC_MARKER_STORAGE_KEY)).toBeNull();

    window.localStorage.setItem(CLOUD_MCP_SYNC_MARKER_STORAGE_KEY, "stale-marker");
    writeDenSettings({
      baseUrl: "https://bootstrap.example.com",
      authToken: "next-session",
      activeOrgId: "org_test",
      activeOrgSlug: null,
      activeOrgName: null,
    });
    expect(window.localStorage.getItem(CLOUD_MCP_SYNC_MARKER_STORAGE_KEY)).toBeNull();

    window.localStorage.setItem(CLOUD_MCP_SYNC_MARKER_STORAGE_KEY, "stale-marker");
    writeDenSettings({
      baseUrl: "https://next.example.com",
      authToken: "next-session",
      activeOrgId: "org_test",
      activeOrgSlug: null,
      activeOrgName: null,
    });
    expect(window.localStorage.getItem(CLOUD_MCP_SYNC_MARKER_STORAGE_KEY)).toBeNull();

    window.localStorage.setItem(CLOUD_MCP_SYNC_MARKER_STORAGE_KEY, "stale-marker");
    window.localStorage.setItem("openwork.react.dashboardTileCache.v1.user_alice.org_ops", "private report");
    window.localStorage.setItem("openwork.react.dashboardTileCache.v1.user_bob.org_finance", "private forecast");
    window.localStorage.setItem("unrelated.preference", "keep me");
    clearDenSession();
    expect(window.localStorage.getItem(CLOUD_MCP_SYNC_MARKER_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem("openwork.react.dashboardTileCache.v1.user_alice.org_ops")).toBeNull();
    expect(window.localStorage.getItem("openwork.react.dashboardTileCache.v1.user_bob.org_finance")).toBeNull();
    expect(window.localStorage.getItem("unrelated.preference")).toBe("keep me");
  });
});
