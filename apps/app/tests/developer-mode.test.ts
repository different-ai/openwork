import { describe, expect, test } from "bun:test";

import {
  createDeveloperModeStore,
  DEVELOPER_MODE_STORAGE_KEY,
} from "../src/react-app/shell/developer-mode";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

describe("developer mode store", () => {
  test("updates every same-window subscriber from one canonical setter", () => {
    const storage = memoryStorage();
    const store = createDeveloperModeStore(storage);
    const observed: boolean[] = [];
    const disposeFirst = store.subscribe(() => observed.push(store.getSnapshot()));
    const disposeSecond = store.subscribe(() => observed.push(store.getSnapshot()));

    store.set(true);
    store.toggle();

    expect(observed).toEqual([true, true, false, false]);
    expect(storage.getItem(DEVELOPER_MODE_STORAGE_KEY)).toBe("0");
    disposeFirst();
    disposeSecond();
  });

  test("reacts to external storage notifications", () => {
    const storage = memoryStorage({ [DEVELOPER_MODE_STORAGE_KEY]: "0" });
    let notifyStorage = () => {};
    const store = createDeveloperModeStore(storage, (listener) => {
      notifyStorage = listener;
      return () => {};
    });
    let updates = 0;
    const dispose = store.subscribe(() => { updates += 1; });

    storage.setItem(DEVELOPER_MODE_STORAGE_KEY, "1");
    notifyStorage();

    expect(store.getSnapshot()).toBe(true);
    expect(updates).toBe(1);
    dispose();
  });

  test("remains reactive when local storage is unavailable", () => {
    const store = createDeveloperModeStore(null);
    let updates = 0;
    store.subscribe(() => { updates += 1; });

    store.set(true);

    expect(store.getSnapshot()).toBe(true);
    expect(updates).toBe(1);
  });
});
