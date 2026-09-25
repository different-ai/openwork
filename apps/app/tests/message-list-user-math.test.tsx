/** @jsxImportSource react */
import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { UIMessage } from "ai";

import { MessageList } from "../src/components/chat/message-list";
import { MessageListProvider } from "../src/components/chat/message-list-provider";
import { createDefaultPlatform, PlatformProvider } from "../src/react-app/kernel/platform";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const actEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
  if (ownedDom) await GlobalRegistrator.unregister();
});

function list(messages: UIMessage[]) {
  return (
    <PlatformProvider value={createDefaultPlatform()}>
      <MessageListProvider
        workspaceId="ws"
        sessionId="session"
        showThinking={true}
        developerMode={false}
        displaySuggestions={false}
        providerConnectedCount={1}
        syncDegraded={false}
        dispatchAction={() => {}}
        setPrompt={() => {}}
        onRevertToUserMessage={() => {}}
        onForkAtMessage={() => {}}
        onEditUserMessage={() => {}}
        onOpenSubagentSession={() => {}}
        onMcpReconnect={() => Promise.reject(new Error("unused"))}
        onMcpReopenAuthorization={() => Promise.resolve()}
      >
        <MessageList messages={messages} status="submitted" activityStatus="thinking" />
      </MessageListProvider>
    </PlatformProvider>
  );
}

function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => { await act(async () => root.unmount()); container.remove(); });
  return {
    container,
    async render(messages: UIMessage[]) { await act(async () => root.render(list(messages))); },
  };
}

function userBubble(view: { container: HTMLElement }, id: string) {
  const bubble = view.container.querySelector(`[data-message-id="${id}"]`);
  if (!bubble) throw new Error(`Missing user bubble ${id}`);
  return bubble;
}

test("renders a $...$ bubble through the math-only renderer", async () => {
  const view = mount();
  await view.render([{ id: "math-1", role: "user", parts: [
    { type: "text", text: "Energy is $E = mc^2$ right?" },
  ] }]);
  const bubble = userBubble(view, "math-1");
  expect(bubble.querySelector(".katex")).toBeDefined();
  expect(bubble.querySelector(".katex")?.textContent).toContain("E");
});

test("keeps bare URLs clickable when the bubble also contains a $ delimiter", async () => {
  const view = mount();
  await view.render([{ id: "math-2", role: "user", parts: [
    { type: "text", text: "See https://openwork.com pricing, about $5 per seat." },
  ] }]);
  const bubble = userBubble(view, "math-2");
  const link = bubble.querySelector('a[href="https://openwork.com"]');
  if (!link) throw new Error("Missing URL anchor — bubble was routed to the math renderer");
  // Currency text is unrelated to a math span and never becomes KaTeX.
  expect(bubble.querySelector(".katex")).toBeNull();
});

test("does not route skill-chip bubbles through the math renderer", async () => {
  const view = mount();
  await view.render([{ id: "math-3", role: "user", parts: [
    { type: "text", text: "Load [skill write_file] with $x$ math" },
  ] }]);
  const bubble = userBubble(view, "math-3");
  expect(bubble.querySelector('[data-message-role="user"]')).toBeDefined();
  expect(bubble.querySelector(".katex")).toBeNull();
});