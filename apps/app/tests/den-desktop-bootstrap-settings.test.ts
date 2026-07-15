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
    requireSignin: boolean;
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
    clearDenSession();
    expect(window.localStorage.getItem(CLOUD_MCP_SYNC_MARKER_STORAGE_KEY)).toBeNull();
  });
});
