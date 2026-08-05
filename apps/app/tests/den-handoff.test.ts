import { afterEach, describe, expect, test } from "bun:test";

import { exchangeHandoffAndSignIn } from "../src/app/lib/den-handoff";

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

function stubWindow() {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: memoryStorage(),
      sessionStorage: memoryStorage(),
      dispatchEvent: () => true,
    },
  });
}

function stubExchangeResponse(payload: Record<string, unknown>) {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: (async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) satisfies typeof fetch,
  });
}

const exchangeUser = { id: "user_invited", email: "invited@example.com", name: "Invited Member" };

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

describe("exchangeHandoffAndSignIn", () => {
  test("persists the organization resolved by the handoff exchange", async () => {
    stubWindow();
    stubExchangeResponse({
      token: "tok_handoff",
      user: exchangeUser,
      organization: { id: "org_invited", slug: "invited-org", name: "Invited Org" },
    });

    const result = await exchangeHandoffAndSignIn("grant_test", { baseUrl: "https://den.test" });

    expect(result.ok).toBe(true);
    expect(window.localStorage.getItem("micx.den.activeOrgId")).toBe("org_invited");
    expect(window.localStorage.getItem("micx.den.activeOrgSlug")).toBe("invited-org");
    expect(window.localStorage.getItem("micx.den.activeOrgName")).toBe("Invited Org");
  });

  test("prefers the caller-provided organization over the exchange payload", async () => {
    stubWindow();
    stubExchangeResponse({
      token: "tok_handoff",
      user: exchangeUser,
      organization: { id: "org_exchange", slug: "exchange-org", name: "Exchange Org" },
    });

    const result = await exchangeHandoffAndSignIn("grant_test", {
      baseUrl: "https://den.test",
      activeOrg: { id: "org_bootstrap", slug: "bootstrap-org", name: "Bootstrap Org" },
    });

    expect(result.ok).toBe(true);
    expect(window.localStorage.getItem("micx.den.activeOrgId")).toBe("org_bootstrap");
  });

  test("preserves the stored organization when the exchange has none", async () => {
    stubWindow();
    window.localStorage.setItem("micx.den.activeOrgId", "org_stored");
    window.localStorage.setItem("micx.den.activeOrgSlug", "stored-org");
    window.localStorage.setItem("micx.den.activeOrgName", "Stored Org");
    stubExchangeResponse({ token: "tok_handoff", user: exchangeUser });

    const result = await exchangeHandoffAndSignIn("grant_test", { baseUrl: "https://den.test" });

    expect(result.ok).toBe(true);
    expect(window.localStorage.getItem("micx.den.activeOrgId")).toBe("org_stored");
    expect(window.localStorage.getItem("micx.den.activeOrgSlug")).toBe("stored-org");
    expect(window.localStorage.getItem("micx.den.activeOrgName")).toBe("Stored Org");
  });
});
