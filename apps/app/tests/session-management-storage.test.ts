import { afterEach, expect, test } from "bun:test";
import { sessionManagementStorage } from "../src/react-app/domains/session/sidebar/session-management-storage";

const key = "openwork.react.sessionManagement";
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});
function fixture(raw: string | null, readFailure = false, durable?: string[]) {
  let value = raw;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem() { if (readFailure) throw new Error("synthetic read failure"); return value; },
    setItem(_key: string, next: string) { value = next; },
    removeItem() { value = null; },
  } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: durable ? { __OPENWORK_ELECTRON__: { sessionPins: {
    read: () => ({ ok: true, pins: durable }),
    update: ({ next }: { next: string[] }) => ({ ok: true, pins: next }),
  } } } : {} });
  return { storage: sessionManagementStorage(), value: () => value };
}
for (const raw of ["{broken", '{"state":{"unreadIds":[]}}', '{"state":{"pinnedIds":null}}']) {
  test(`failed or partial hydration never overwrites ${raw}`, () => {
    const { storage, value } = fixture(raw);
    expect(() => storage.getItem(key)).toThrow();
    storage.setItem(key, JSON.stringify({ state: { pinnedIds: [], unreadIds: ["other"] } }));
    expect(value()).toBe(raw);
  });
}
test("read failure preserves the old key on an unrelated write", () => {
  const raw = JSON.stringify({ state: { pinnedIds: ["one"] } });
  const { storage, value } = fixture(raw, true);
  expect(() => storage.getItem(key)).toThrow();
  storage.setItem(key, JSON.stringify({ state: { pinnedIds: [] } }));
  expect(value()).toBe(raw);
});
test("durable pins recover a malformed UI blob without destroying it", () => {
  const { storage, value } = fixture("{broken", false, ["one", "two"]);
  expect(JSON.parse(String(storage.getItem(key))).state.pinnedIds).toEqual(["one", "two"]);
  storage.setItem(key, JSON.stringify({ state: { pinnedIds: ["one", "two"] } }));
  expect(value()).toBe("{broken");
});
