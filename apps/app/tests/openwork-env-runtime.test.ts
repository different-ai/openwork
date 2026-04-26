import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  readOpenworkEnvPendingChanges,
  writeOpenworkEnvPendingChanges,
} from "../src/app/lib/openwork-env-runtime";

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

describe("openwork env runtime", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: memoryStorage(),
        sessionStorage: memoryStorage(),
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  });

  test("persists pending changes across browser sessions", () => {
    writeOpenworkEnvPendingChanges(true);
    expect(readOpenworkEnvPendingChanges()).toBe(true);

    window.sessionStorage.clear();
    expect(readOpenworkEnvPendingChanges()).toBe(true);

    writeOpenworkEnvPendingChanges(false);
    expect(readOpenworkEnvPendingChanges()).toBe(false);
  });

  test("reads legacy sessionStorage pending state", () => {
    window.sessionStorage.setItem("openwork.settings.environment.pendingChanges", "1");

    expect(readOpenworkEnvPendingChanges()).toBe(true);
  });
});
