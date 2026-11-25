import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "https://web.example/" });
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { LocalProvider, useLocal } = await import("../src/react-app/kernel/local-provider");
const { createClientV2 } = await import("../src/app/lib/opencode-v2-adapter");
const { LOCAL_PREFERENCES_KEY, readShowThinkingPreference } = await import("../src/react-app/kernel/local-preferences-storage");

const base = "http://127.0.0.1:9/workspace/ws_1/opencode2";
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  window.localStorage.clear();
});
afterAll(() => GlobalRegistrator.unregister());

async function sentPromptMetadata(): Promise<unknown> {
  let prompt: unknown;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path.endsWith("/prompt")) prompt = await request.json();
      if (request.method === "GET") return Response.json({ location: {}, data: { id: "ses_1", agent: "build" } });
      return new Response(null, { status: 204 });
    },
  });
  const client = createClientV2(base, "/tmp/ws", { token: "t" });
  const result = await client.session.promptAsync({
    sessionID: "ses_1",
    model: { providerID: "anthropic", modelID: "claude" },
    parts: [{ type: "text", text: "hello" }],
  });
  expect(result.error).toBeUndefined();
  return prompt && typeof prompt === "object" ? Reflect.get(prompt, "metadata") : undefined;
}

test("each prompt carries Settings › Show model reasoning to the engine", async () => {
  window.localStorage.setItem(LOCAL_PREFERENCES_KEY, JSON.stringify({ showThinking: false, showThinkingResetToOff: true }));
  expect(await sentPromptMetadata()).toEqual({ openwork: { showReasoning: false } });

  window.localStorage.setItem(LOCAL_PREFERENCES_KEY, JSON.stringify({ showThinking: true, showThinkingResetToOff: true }));
  expect(await sentPromptMetadata()).toEqual({ openwork: { showReasoning: true } });
});

test("an unset preference sends the setting's default (off)", async () => {
  expect(await sentPromptMetadata()).toEqual({ openwork: { showReasoning: false } });
});

test("saved preferences from before the reset are treated as off", async () => {
  window.localStorage.setItem(LOCAL_PREFERENCES_KEY, JSON.stringify({ showThinking: true }));
  expect(readShowThinkingPreference()).toBe(false);
  window.localStorage.setItem(LOCAL_PREFERENCES_KEY, JSON.stringify({ showThinking: true, showThinkingResetToOff: true }));
  expect(readShowThinkingPreference()).toBe(true);
});

async function mountLocal() {
  let current: { showThinking: boolean } | null = null;
  function Probe() {
    current = useLocal().prefs;
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(createElement(LocalProvider, { children: createElement(Probe) })));
  await act(async () => root.unmount());
  return { prefs: current, stored: JSON.parse(window.localStorage.getItem(LOCAL_PREFERENCES_KEY) ?? "null") };
}

test("the app switches existing users off once, then keeps their choice", async () => {
  window.localStorage.setItem(LOCAL_PREFERENCES_KEY, JSON.stringify({ showThinking: true, analyticsEnabled: false }));
  window.localStorage.setItem("openwork.showThinking", "true");
  const first = await mountLocal();
  expect(first.prefs?.showThinking).toBe(false);
  expect(first.stored).toMatchObject({ showThinking: false, showThinkingResetToOff: true, analyticsEnabled: false });
  expect(window.localStorage.getItem("openwork.showThinking")).toBeNull();

  window.localStorage.setItem(LOCAL_PREFERENCES_KEY, JSON.stringify({ ...first.stored, showThinking: true }));
  const second = await mountLocal();
  expect(second.prefs?.showThinking).toBe(true);
});

test("a fresh install starts with Show model reasoning off", async () => {
  expect((await mountLocal()).prefs?.showThinking).toBe(false);
});
