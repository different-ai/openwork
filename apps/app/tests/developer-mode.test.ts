import { afterEach, describe, expect, test } from "bun:test";

import {
  clearDesktopDeveloperModeRestartPending,
  desktopExactPromptLoggingEnabled,
  desktopDeveloperModeRestartPending,
  readDesktopExactPromptLogging,
  readDesktopDeveloperMode,
  withDesktopDeveloperModeObservability,
  writeDesktopDeveloperMode,
  writeDesktopExactPromptLogging,
} from "../src/app/lib/developer-mode";
import {
  engineRestart,
  engineStart,
  openworkServerRestart,
  runtimeBootstrap,
} from "../src/app/lib/desktop";

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");

afterEach(() => {
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, "window", originalWindowDescriptor);
    return;
  }
  Reflect.deleteProperty(globalThis, "window");
});

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

describe("desktop Developer Mode observability", () => {
  test("keeps exact prompt logging off for existing Developer Mode preferences", () => {
    const storage = memoryStorage();
    writeDesktopDeveloperMode(true, storage);

    expect(readDesktopDeveloperMode(storage)).toBe(true);
    expect(readDesktopExactPromptLogging(storage)).toBe(false);
    expect(desktopExactPromptLoggingEnabled(storage)).toBe(false);
    expect(withDesktopDeveloperModeObservability(undefined, storage)).toEqual({
      openworkDeveloperMode: true,
      openworkPromptLog: false,
    });
  });

  test("replays a separately consented exact-prompt preference after relaunch", () => {
    const storage = memoryStorage();
    writeDesktopDeveloperMode(true, storage);
    writeDesktopExactPromptLogging(true, storage);

    expect(withDesktopDeveloperModeObservability({
      openworkPromptLog: false,
      openworkRemoteAccess: true,
    }, storage)).toEqual({
      openworkDeveloperMode: true,
      openworkPromptLog: true,
      openworkRemoteAccess: true,
    });
  });

  test("marks restart when the metadata/exact level changes and revokes consent on Developer Mode off", () => {
    const storage = memoryStorage();
    writeDesktopDeveloperMode(true, storage);
    expect(desktopDeveloperModeRestartPending(storage)).toBe(true);
    clearDesktopDeveloperModeRestartPending(storage);

    writeDesktopExactPromptLogging(true, storage);
    expect(desktopDeveloperModeRestartPending(storage)).toBe(true);
    clearDesktopDeveloperModeRestartPending(storage);

    writeDesktopDeveloperMode(false, storage);
    expect(readDesktopExactPromptLogging(storage)).toBe(false);
    expect(desktopExactPromptLoggingEnabled(storage)).toBe(false);

    expect(desktopDeveloperModeRestartPending(storage)).toBe(true);
    clearDesktopDeveloperModeRestartPending(storage);
    expect(desktopDeveloperModeRestartPending(storage)).toBe(false);
  });

  test("injects the persisted preference through every managed-runtime IPC call", async () => {
    const storage = memoryStorage();
    storage.setItem("openwork.developerMode", "1");
    storage.setItem("openwork.promptObservabilityExact", "1");
    const calls: Array<{ command: string; args: unknown[] }> = [];
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: storage,
        __OPENWORK_ELECTRON__: {
          invokeDesktop: async (command: string, ...args: unknown[]) => {
            calls.push({ command, args });
            if (command === "openworkServerInfo") {
              return {
                running: true,
                developerModeRequested: true,
                promptLogRequested: true,
                promptLogEnabled: true,
                observabilityLevel: "exact",
                promptLogSource: "desktop-option",
              };
            }
            return {};
          },
        },
      },
    });

    await runtimeBootstrap();
    await engineStart("/workspace", { openworkRemoteAccess: true });
    await engineRestart();
    await openworkServerRestart({ remoteAccessEnabled: true });

    expect(calls).toEqual([
      { command: "runtimeBootstrap", args: [{ openworkDeveloperMode: true, openworkPromptLog: true }] },
      { command: "openworkServerInfo", args: [] },
      {
        command: "engineStart",
        args: ["/workspace", { openworkRemoteAccess: true, openworkDeveloperMode: true, openworkPromptLog: true }],
      },
      { command: "openworkServerInfo", args: [] },
      { command: "engineRestart", args: [{ openworkDeveloperMode: true, openworkPromptLog: true }] },
      { command: "openworkServerInfo", args: [] },
      {
        command: "openworkServerRestart",
        args: [{ remoteAccessEnabled: true, openworkDeveloperMode: true, openworkPromptLog: true }],
      },
      { command: "openworkServerInfo", args: [] },
    ]);
  });
});
