import { beforeEach, describe, expect, test } from "bun:test";

// Minimal localStorage stub so the persisted zustand store works under bun.
const storage = new Map<string, string>();
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
Object.defineProperty(globalThis, "localStorage", {
  value: localStorageStub,
  configurable: true,
});

const { useNotificationStore } = await import("../src/react-app/kernel/notification-store");

function reset() {
  useNotificationStore.setState({ notifications: [] });
  storage.clear();
}

describe("notification store", () => {
  beforeEach(reset);

  test("add creates an unread entry", () => {
    useNotificationStore.getState().add({
      kind: "system",
      title: "Something happened",
      body: "Details",
    });

    const notifications = useNotificationStore.getState().notifications;
    expect(notifications).toHaveLength(1);
    expect(notifications[0].title).toBe("Something happened");
    expect(notifications[0].severity).toBe("info");
    expect(notifications[0].readAt).toBeNull();
    expect(notifications[0].count).toBe(1);
  });

  test("dedupeKey coalesces into the existing unread entry", () => {
    const { add } = useNotificationStore.getState();
    add({ kind: "providers", title: "1 new provider available", dedupeKey: "new-providers" });
    add({ kind: "providers", title: "2 new providers available", dedupeKey: "new-providers" });

    const notifications = useNotificationStore.getState().notifications;
    expect(notifications).toHaveLength(1);
    expect(notifications[0].title).toBe("2 new providers available");
    expect(notifications[0].count).toBe(2);
  });

  test("read entries do not absorb new events", () => {
    const { add, markAllRead } = useNotificationStore.getState();
    add({ kind: "providers", title: "1 new provider available", dedupeKey: "new-providers" });
    markAllRead();
    add({ kind: "providers", title: "1 new provider available", dedupeKey: "new-providers" });

    const notifications = useNotificationStore.getState().notifications;
    expect(notifications).toHaveLength(2);
    expect(notifications[0].readAt).toBeNull();
    expect(notifications[1].readAt).not.toBeNull();
  });

  test("coalescing keeps merged fields when the update omits them", () => {
    const { add } = useNotificationStore.getState();
    add({
      kind: "reload",
      title: "Updates pending",
      body: "Will apply when tasks finish.",
      dedupeKey: "engine-reload",
      severity: "info",
    });
    add({
      kind: "reload",
      title: "Updates applied",
      dedupeKey: "engine-reload",
      severity: "success",
    });

    const [entry] = useNotificationStore.getState().notifications;
    expect(entry.title).toBe("Updates applied");
    expect(entry.severity).toBe("success");
    expect(entry.body).toBe("Will apply when tasks finish.");
  });

  test("markAllRead is a no-op when everything is read", () => {
    const { add, markAllRead } = useNotificationStore.getState();
    add({ kind: "system", title: "One" });
    markAllRead();
    const before = useNotificationStore.getState().notifications;
    markAllRead();
    expect(useNotificationStore.getState().notifications).toBe(before);
  });

  test("clearAll empties the list", () => {
    const { add, clearAll } = useNotificationStore.getState();
    add({ kind: "system", title: "One" });
    add({ kind: "system", title: "Two" });
    clearAll();
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
  });

  test("caps the list at 100 entries", () => {
    const { add } = useNotificationStore.getState();
    for (let index = 0; index < 110; index += 1) {
      add({ kind: "system", title: `Entry ${index}` });
    }
    const notifications = useNotificationStore.getState().notifications;
    expect(notifications).toHaveLength(100);
    expect(notifications[0].title).toBe("Entry 109");
  });
});
