import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { getResolvedShikiTheme, setThemeMode } from "../src/app/theme";

const originalDocument = globalThis.document;
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

function installThemeTestEnvironment(systemPrefersDark: boolean) {
  const documentElement = {
    dataset: {} as Record<string, string>,
    style: {
      colorScheme: "",
    },
  };

  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { documentElement },
  });

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: memoryStorage(),
      matchMedia: () => ({
        matches: systemPrefersDark,
        addEventListener() {},
        removeEventListener() {},
      }),
      __OPENWORK_ELECTRON__: {
        invokeDesktop() {
          return undefined;
        },
      },
    },
  });
}

describe("getResolvedShikiTheme", () => {
  beforeEach(() => {
    installThemeTestEnvironment(false);
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: originalDocument,
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  });

  test("returns the light Shiki theme in light mode", () => {
    setThemeMode("light");
    expect(getResolvedShikiTheme()).toBe("github-light");
  });

  test("returns the dark Shiki theme in dark mode", () => {
    setThemeMode("dark");
    expect(getResolvedShikiTheme()).toBe("github-dark");
  });

  test("uses the system dark preference in system mode", () => {
    installThemeTestEnvironment(true);
    setThemeMode("system");
    expect(getResolvedShikiTheme()).toBe("github-dark");
  });
});
