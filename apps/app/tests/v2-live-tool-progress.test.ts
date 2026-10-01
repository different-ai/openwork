import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { rememberV2LiveToolProgress, restoreV2LiveToolProgress } from "../src/app/lib/v2-live-tool-progress";

const key = "openwork.v2.live-tool-progress.v1";
const identity = { scope: "http://server/workspace/one/opencode2", sessionID: "session", messageID: "message", callID: "call" };
let ownedDom = false;
let previous: string | null;
beforeEach(() => {
  ownedDom = typeof window === "undefined";
  if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
  previous = sessionStorage.getItem(key); sessionStorage.removeItem(key);
});
afterEach(async () => {
  if (previous === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, previous);
  if (ownedDom) await GlobalRegistrator.unregister();
});

test("observed progress cannot cross server/workspace, session, reply or invocation identities", () => {
  const metadata = { toolCalls: [{ tool: "service.read", status: "running", input: {} }], openworkToolDetails: [{ startedAt: 10 }], unrelated: "not retained" };
  rememberV2LiveToolProgress(identity, metadata);
  expect(restoreV2LiveToolProgress(identity)).toEqual({ toolCalls: metadata.toolCalls, openworkToolDetails: metadata.openworkToolDetails });
  for (const field of ["scope", "sessionID", "messageID", "callID"] as const) {
    expect(restoreV2LiveToolProgress({ ...identity, [field]: "another" })).toEqual({});
  }
});

test("tab retention bounds both count and actual serialized bytes, including large call inputs", () => {
  for (let i = 0; i < 70; i++) rememberV2LiveToolProgress({ ...identity, callID: String(i) }, { toolCalls: [{ tool: "read", input: {} }] });
  expect(JSON.parse(sessionStorage.getItem(key)!).length).toBe(64);
  expect(restoreV2LiveToolProgress({ ...identity, callID: "0" })).toEqual({});
  for (let i = 0; i < 20; i++) rememberV2LiveToolProgress({ ...identity, callID: `large-${i}` }, { toolCalls: [{ input: "🦆".repeat(25_000) }] });
  expect(new TextEncoder().encode(sessionStorage.getItem(key)!).byteLength).toBeLessThanOrEqual(1_024 * 1_024);
  rememberV2LiveToolProgress(identity, { toolCalls: [{ input: "x".repeat(300_000) }] });
  expect(restoreV2LiveToolProgress(identity)).toEqual({});
});

test("expired, malformed or unavailable tab storage adds no invented progress", () => {
  sessionStorage.setItem(key, JSON.stringify([{ ...identity, updatedAt: Date.now() - 7 * 60 * 60 * 1_000, metadata: { toolCalls: [] } }]));
  expect(restoreV2LiveToolProgress(identity)).toEqual({});
  sessionStorage.setItem(key, "bad JSON");
  expect(restoreV2LiveToolProgress(identity)).toEqual({});
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage")!;
  try {
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, get() { throw new DOMException("Denied", "SecurityError"); } });
    expect(() => rememberV2LiveToolProgress(identity, { toolCalls: [{ tool: "read" }] })).not.toThrow();
    expect(restoreV2LiveToolProgress(identity)).toEqual({});
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
      getItem: () => null, setItem() { throw new DOMException("Full", "QuotaExceededError"); }, removeItem() {},
    } });
    expect(() => rememberV2LiveToolProgress(identity, { toolCalls: [{ tool: "read" }] })).not.toThrow();
    expect(restoreV2LiveToolProgress(identity)).toEqual({});
  } finally { Object.defineProperty(globalThis, "sessionStorage", descriptor); }
});
