import { afterEach, describe, expect, test } from "bun:test";

import {
  DenApiError,
  ensureDenActiveOrganization,
  isDenSessionRevokedError,
  mergePassiveDenSettings,
  readDenSettings,
  writeDenSettings,
} from "../src/app/lib/den";
import { resolveDenAuthFailureStatus } from "../src/react-app/domains/cloud/den-auth-provider";

const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;

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

afterEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: originalFetch,
  });
});

describe("mergePassiveDenSettings", () => {
  test("preserves stored credentials and org when in-memory state is empty", () => {
    const result = mergePassiveDenSettings(
      {
        baseUrl: "https://stored.example.com",
        authToken: "tok_stored",
        activeOrgId: "org_stored",
        activeOrgSlug: "stored-org",
        activeOrgName: "Stored Org",
      },
      {
        baseUrl: "https://next.example.com",
        authToken: null,
        activeOrgId: null,
        activeOrgSlug: null,
        activeOrgName: null,
      },
    );

    expect(result).toEqual({
      baseUrl: "https://next.example.com",
      apiBaseUrl: "https://next.example.com/api/den",
      authToken: "tok_stored",
      activeOrgId: "org_stored",
      activeOrgSlug: "stored-org",
      activeOrgName: "Stored Org",
    });
  });

  test("uses fresh in-memory values when they are present", () => {
    const result = mergePassiveDenSettings(
      {
        baseUrl: "https://stored.example.com",
        authToken: "tok_stored",
        activeOrgId: "org_stored",
        activeOrgSlug: "stored-org",
        activeOrgName: "Stored Org",
      },
      {
        baseUrl: "https://next.example.com",
        authToken: " tok_fresh ",
        activeOrgId: " org_fresh ",
        activeOrgSlug: " fresh-org ",
        activeOrgName: " Fresh Org ",
      },
    );

    expect(result.authToken).toBe("tok_fresh");
    expect(result.activeOrgId).toBe("org_fresh");
    expect(result.activeOrgSlug).toBe("fresh-org");
    expect(result.activeOrgName).toBe("Fresh Org");
  });

  test("keeps empty storage empty when in-memory state is empty", () => {
    const result = mergePassiveDenSettings(
      {
        baseUrl: "https://stored.example.com",
        authToken: null,
        activeOrgId: null,
        activeOrgSlug: null,
        activeOrgName: null,
      },
      {
        baseUrl: "https://next.example.com",
        authToken: null,
        activeOrgId: null,
        activeOrgSlug: null,
        activeOrgName: null,
      },
    );

    expect(result.authToken).toBeNull();
    expect(result.activeOrgId).toBeNull();
    expect(result.activeOrgSlug).toBeNull();
    expect(result.activeOrgName).toBeNull();
  });

  test("passive write leaves stored session keys intact", () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: memoryStorage(),
        dispatchEvent: () => true,
      },
    });

    window.localStorage.setItem("micx.den.authToken", "tok_stored");
    window.localStorage.setItem("micx.den.activeOrgId", "org_stored");
    window.localStorage.setItem("micx.den.activeOrgSlug", "stored-org");
    window.localStorage.setItem("micx.den.activeOrgName", "Stored Org");

    writeDenSettings(
      mergePassiveDenSettings(readDenSettings(), {
        baseUrl: "https://next.example.com",
        authToken: null,
        activeOrgId: null,
        activeOrgSlug: null,
        activeOrgName: null,
      }),
    );

    expect(window.localStorage.getItem("micx.den.authToken")).toBe("tok_stored");
    expect(window.localStorage.getItem("micx.den.activeOrgId")).toBe("org_stored");
    expect(window.localStorage.getItem("micx.den.activeOrgSlug")).toBe("stored-org");
    expect(window.localStorage.getItem("micx.den.activeOrgName")).toBe("Stored Org");
  });
});

describe("ensureDenActiveOrganization", () => {
  test("preserves the selected organization when the server temporarily returns none", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: memoryStorage(),
        dispatchEvent: () => true,
      },
    });
    writeDenSettings({
      baseUrl: "https://den.test",
      authToken: "tok_stored",
      activeOrgId: "org_stored",
      activeOrgSlug: "stored-org",
      activeOrgName: "Stored Org",
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: (async () => new Response(JSON.stringify({
        orgs: [],
        activeOrgId: null,
        activeOrgSlug: null,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) satisfies typeof fetch,
    });

    await expect(ensureDenActiveOrganization()).resolves.toBeNull();
    expect(readDenSettings()).toMatchObject({
      activeOrgId: "org_stored",
      activeOrgSlug: "stored-org",
      activeOrgName: "Stored Org",
    });
  });
});

describe("isDenSessionRevokedError", () => {
  test("only treats Den-shaped 401s as revoked sessions", () => {
    expect(isDenSessionRevokedError(new DenApiError(401, "unauthorized", "Unauthorized"))).toBe(
      true,
    );
    expect(isDenSessionRevokedError(new DenApiError(401, "request_failed", "Proxy 401"))).toBe(
      false,
    );
    expect(isDenSessionRevokedError(new DenApiError(500, "server_error", "Server error"))).toBe(
      false,
    );
    expect(isDenSessionRevokedError(new Error("Request timed out."))).toBe(false);
  });
});

describe("resolveDenAuthFailureStatus", () => {
  test("keeps proxy-shaped 401s unavailable while Den-shaped 401s sign out", () => {
    expect(resolveDenAuthFailureStatus(new DenApiError(401, "request_failed", "Proxy 401"))).toBe(
      "unavailable",
    );
    expect(resolveDenAuthFailureStatus(new DenApiError(401, "unauthorized", "Unauthorized"))).toBe(
      "signed_out",
    );
    expect(resolveDenAuthFailureStatus(new Error("Request timed out."))).toBe("unavailable");
  });
});
