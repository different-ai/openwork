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
        onMcpRetry={() => {}}
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

const previewUrl = "blob:http://localhost/preview";
const serverUrl = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";

test("a sent image keeps its badge element when the local preview settles into the server copy", async () => {
  const view = mount();
  // Optimistic render: the composer's blob: preview of the original file.
  await view.render([{ id: "user-1", role: "user", parts: [
    { type: "text", text: "Look at @designer this" },
    { type: "file", filename: "shot.png", mediaType: "image/png", url: previewUrl },
  ] }]);
  const bubble = view.container.querySelector('[data-message-id="user-1"]');
  const image = bubble?.querySelector("img");
  if (!image) throw new Error("Missing attachment preview image");
  expect(image.getAttribute("src")).toBe(previewUrl);

  // Server echo: the recompressed copy under a data: URL with a new extension,
  // and the prompt text split around the mention into separate parts.
  await view.render([{ id: "user-1", role: "user", parts: [
    { type: "text", text: "Look at " },
    { type: "text", text: "this" },
    { type: "file", filename: "shot.jpg", mediaType: "image/jpeg", url: serverUrl },
  ] }]);
  const settled = Array.from(bubble?.querySelectorAll("img") ?? []);
  expect(settled).toHaveLength(1);
  // Identity, compared as a boolean so a failure does not serialize the DOM.
  expect(settled[0] === image).toBe(true);
  expect(image.getAttribute("src")).toBe(serverUrl);
  expect(image.getAttribute("alt")).toBe("shot.jpg");
});

test("each attachment keeps its own badge while every preview settles", async () => {
  const view = mount();
  await view.render([{ id: "user-2", role: "user", parts: [
    { type: "text", text: "Compare" },
    { type: "file", filename: "a.png", mediaType: "image/png", url: `${previewUrl}/a` },
    { type: "file", filename: "b.png", mediaType: "image/png", url: `${previewUrl}/b` },
  ] }]);
  const bubble = view.container.querySelector('[data-message-id="user-2"]');
  const [first, second] = Array.from(bubble?.querySelectorAll("img") ?? []);
  if (!first || !second) throw new Error("Missing attachment preview images");

  // The first attachment settles before the second one does.
  await view.render([{ id: "user-2", role: "user", parts: [
    { type: "text", text: "Compare" },
    { type: "file", filename: "a.jpg", mediaType: "image/jpeg", url: `${serverUrl}a` },
    { type: "file", filename: "b.png", mediaType: "image/png", url: `${previewUrl}/b` },
  ] }]);
  await view.render([{ id: "user-2", role: "user", parts: [
    { type: "text", text: "Compare" },
    { type: "file", filename: "a.jpg", mediaType: "image/jpeg", url: `${serverUrl}a` },
    { type: "file", filename: "b.jpg", mediaType: "image/jpeg", url: `${serverUrl}b` },
  ] }]);
  const settled = Array.from(bubble?.querySelectorAll("img") ?? []);
  expect(settled.length).toBe(2);
  expect(settled[0] === first && settled[1] === second).toBe(true);
  expect(first.getAttribute("src")).toBe(`${serverUrl}a`);
  expect(second.getAttribute("src")).toBe(`${serverUrl}b`);
});
