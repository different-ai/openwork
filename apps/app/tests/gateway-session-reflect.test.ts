import { afterEach, describe, expect, test } from "bun:test";

import {
  initializeDenBootstrapConfig,
  readDenBootstrapConfig,
  readDenSettings,
  writeDenSettings,
} from "../src/app/lib/den";
import { shouldHoldWelcomeForDenSession } from "../src/react-app/shell/welcome-den-session";

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

function installGatewayWindow() {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __OPENWORK_GATEWAY__: { version: 1 },
      addEventListener: () => undefined,
      dispatchEvent: () => true,
      localStorage: memoryStorage(),
      location: { origin: "https://web.openworklabs.com" },
      removeEventListener: () => undefined,
    },
  });
}

describe("gateway Den session reflection", () => {
  afterEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  });

  test("a stored gateway token suppresses the signed-out welcome surface", async () => {
    installGatewayWindow();
    await initializeDenBootstrapConfig();

    writeDenSettings({
      baseUrl: "https://app.openworklabs.com",
      authToken: "tok_gateway_session",
      activeOrgId: null,
      activeOrgSlug: null,
      activeOrgName: null,
    });

    const hasStoredAuthToken = Boolean(readDenSettings().authToken?.trim());
    expect(hasStoredAuthToken).toBe(true);
    expect(
      shouldHoldWelcomeForDenSession({
        authStatus: "checking",
        hasStoredAuthToken,
        isSignedIn: false,
      }),
    ).toBe(true);
    expect(
      shouldHoldWelcomeForDenSession({
        authStatus: "signed_in",
        hasStoredAuthToken: true,
        isSignedIn: true,
      }),
    ).toBe(true);
    expect(
      shouldHoldWelcomeForDenSession({
        authStatus: "signed_out",
        hasStoredAuthToken: false,
        isSignedIn: false,
      }),
    ).toBe(false);
  });

  test("a stored token holds the welcome surface only for transient or signed-in auth", () => {
    expect(
      shouldHoldWelcomeForDenSession({
        authStatus: "checking",
        hasStoredAuthToken: true,
        isSignedIn: false,
      }),
    ).toBe(true);
    expect(
      shouldHoldWelcomeForDenSession({
        authStatus: "signed_in",
        hasStoredAuthToken: true,
        isSignedIn: true,
      }),
    ).toBe(true);
    expect(
      shouldHoldWelcomeForDenSession({
        authStatus: "unavailable",
        hasStoredAuthToken: true,
        isSignedIn: false,
      }),
    ).toBe(false);
    expect(
      shouldHoldWelcomeForDenSession({
        authStatus: "signed_out",
        hasStoredAuthToken: true,
        isSignedIn: false,
      }),
    ).toBe(false);
  });

  test("gateway bootstrap snapshot identity stays stable while settings reflect the token", async () => {
    installGatewayWindow();
    await initializeDenBootstrapConfig();

    const first = readDenBootstrapConfig();
    const second = readDenBootstrapConfig();
    expect(second).toBe(first);

    writeDenSettings({
      baseUrl: "https://app.openworklabs.com",
      authToken: "tok_gateway_session",
      activeOrgId: null,
      activeOrgSlug: null,
      activeOrgName: null,
    });

    const afterToken = readDenBootstrapConfig();
    expect(afterToken).toBe(first);
    expect(readDenSettings().authToken).toBe("tok_gateway_session");
    expect(readDenSettings().apiBaseUrl).toBe("https://web.openworklabs.com/api/den");
  });
});
