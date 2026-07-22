import { beforeEach, describe, expect, test } from "bun:test";

import { LOCAL_PREFERENCES_KEY } from "../src/react-app/kernel/local-preferences-storage";
import { notifyDesktopEvent } from "../src/react-app/shell/desktop-notifications";

type DesktopCall = { command: string; args: unknown[] };

const storage = new Map<string, string>();
const calls: DesktopCall[] = [];

const localStorageStub = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    storage.set(key, value);
  },
  removeItem: (key: string) => {
    storage.delete(key);
  },
  clear: () => storage.clear(),
  key: (index: number) => [...storage.keys()][index] ?? null,
  get length() {
    return storage.size;
  },
};

function setPreference(value: "off" | "important" | "all") {
  localStorageStub.setItem(LOCAL_PREFERENCES_KEY, JSON.stringify({ desktopNotifications: value }));
}

function installRuntime({ focused }: { focused: boolean }) {
  Object.defineProperty(globalThis, "window", {
    value: {
      localStorage: localStorageStub,
      __OPENWORK_ELECTRON__: {
        invokeDesktop: async (command: string, ...args: unknown[]) => {
          calls.push({ command, args });
          return { ok: true };
        },
      },
    },
    configurable: true,
  });

  Object.defineProperty(globalThis, "document", {
    value: {
      visibilityState: focused ? "visible" : "hidden",
      hasFocus: () => focused,
    },
    configurable: true,
  });
}

describe("desktop notifications", () => {
  beforeEach(() => {
    storage.clear();
    calls.length = 0;
    installRuntime({ focused: false });
  });

  test("off suppresses important events", () => {
    setPreference("off");

    notifyDesktopEvent({ type: "task.failed", sessionId: "session-a", errorText: "Boom" });

    expect(calls).toHaveLength(0);
  });

  test("important sends attention events but not completions", async () => {
    setPreference("important");

    notifyDesktopEvent({ type: "task.completed", sessionId: "session-a" });
    notifyDesktopEvent({ type: "question.asked", sessionId: "session-a", question: "Question: Continue?" });
    await Promise.resolve();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "desktopNotificationShow",
      args: [{ title: "Question needs your answer", body: "Question: Continue?" }],
    });
  });

  test("all sends task completion notifications", async () => {
    setPreference("all");

    notifyDesktopEvent({ type: "task.completed", sessionId: "session-a" });
    await Promise.resolve();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "desktopNotificationShow",
      args: [{ title: "Task completed", body: "The session finished running." }],
    });
  });

  test("focused app suppresses native popups", () => {
    setPreference("all");
    installRuntime({ focused: true });

    notifyDesktopEvent({ type: "task.failed", sessionId: "session-a", errorText: "Boom" });

    expect(calls).toHaveLength(0);
  });
});
