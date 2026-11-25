/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const messageList = await import("../src/components/chat/message-list-provider");
const { AppChatArtifact } = await import("../src/react-app/domains/apps/app-chat-artifact");
const { PanelSessionProvider } = await import("../src/react-app/kernel/panel-session-context");
const { usePanelTabStore } = await import("../src/react-app/domains/session/panel/panel-tab-store");
const { useUiStateStore } = await import("../src/react-app/shell/ui-state-store");
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  usePanelTabStore.setState({ sessions: {} });
  useUiStateStore.setState({ sidePanelState: {} });
  const list = { sessionId: "side" };
  spyOn(messageList, "useMessageList").mockImplementation(() => list as ReturnType<typeof messageList.useMessageList>);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  mock.restore();
});
afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  if (ownedDom) await GlobalRegistrator.unregister();
});

async function openPreview() {
  const button = host.querySelector("button");
  if (!button) throw new Error("Open preview button missing");
  await act(async () => button.click());
}

test("an app opened from the split chat lands in the panel that shows", async () => {
  await act(async () => root.render(
    <PanelSessionProvider value={() => "main"}>
      <AppChatArtifact appId="app" revisionId="r1" title="Revenue" />
    </PanelSessionProvider>,
  ));
  await openPreview();

  expect(usePanelTabStore.getState().sessions.main?.tabs.map((tab) => tab.type)).toEqual(["app"]);
  expect(usePanelTabStore.getState().sessions.side).toBeUndefined();
  expect(useUiStateStore.getState().sidePanelState.main).toBe("panel");
});

test("without a split view an app opens in its own chat's panel", async () => {
  await act(async () => root.render(<AppChatArtifact appId="app" revisionId="r1" title="Revenue" />));
  await openPreview();

  expect(usePanelTabStore.getState().sessions.side?.tabs.map((tab) => tab.type)).toEqual(["app"]);
  expect(useUiStateStore.getState().sidePanelState.side).toBe("panel");
});
