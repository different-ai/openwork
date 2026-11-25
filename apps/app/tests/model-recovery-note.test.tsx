/** @jsxImportSource react */
import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import * as den from "../src/app/lib/den";
import { ModelRecoveryNote } from "../src/react-app/domains/session/surface/composer/model-recovery-note";
import { modelRecoveryChatKey, useModelRecoveryStore } from "../src/react-app/domains/session/surface/model-recovery-store";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const previous = { providerID: "ipr_fixture", modelID: "gwm_opus", title: "Claude Opus 4.5" };
const replacement = { providerID: "ipr_fixture", modelID: "gwm_sonnet", title: "Claude Sonnet 4.5" };
const key = modelRecoveryChatKey("member/workspace", "chat-a");
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  useModelRecoveryStore.setState({ byChat: {} });
  mock.restore();
});
afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  if (ownedDom) await GlobalRegistrator.unregister();
});

async function mount(options: { sessionId?: string; model?: typeof replacement } = {}) {
  const onChange = mock(() => {});
  const onSwitchBack = mock(() => {});
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<ModelRecoveryNote scope="member/workspace" sessionId={options.sessionId ?? "chat-a"}
    selectedModel={options.model ?? replacement} onChange={onChange} onSwitchBack={onSwitchBack} />));
  cleanups.push(async () => { await act(async () => root.unmount()); host.remove(); });
  const click = async (label: string) => {
    const button = Array.from(host.querySelectorAll("button")).find((candidate) => candidate.textContent === label || candidate.getAttribute("aria-label") === label);
    if (!button) throw new Error(`Button not found: ${label}`);
    await act(async () => button.click());
  };
  return { host, onChange, onSwitchBack, click };
}

function record() { useModelRecoveryStore.getState().record(key, { previous, replacement }); }

test("confirmed removal names both models and Change opens the composer picker", async () => {
  record();
  const view = await mount();
  expect(view.host.textContent).toContain("Claude Opus 4.5 was removed by your organization · Using Claude Sonnet 4.5 ·");
  expect(view.host.textContent).not.toMatch(/ipr_|gwm_/);
  expect(view.host.querySelector('[role="status"]')).not.toBeNull();
  await view.click("Change");
  expect(view.onChange).toHaveBeenCalledTimes(1);
  expect(view.onSwitchBack).not.toHaveBeenCalled();
});

test("recovery renders signed out without requesting feature state", async () => {
  record();
  spyOn(den, "readDenSettings").mockReturnValue({ ...den.readDenSettings(), authToken: null, activeOrgId: null });
  const fetch = spyOn(globalThis, "fetch");
  const view = await mount();
  expect(view.host.textContent).toContain("was removed by your organization");
  expect(fetch).not.toHaveBeenCalled();
  expect(view.onSwitchBack).not.toHaveBeenCalled();
});

test("dismissal affects only this chat", async () => {
  record();
  const otherKey = modelRecoveryChatKey("member/workspace", "chat-b");
  useModelRecoveryStore.getState().record(otherKey, { previous, replacement });
  const view = await mount();
  await view.click("Dismiss model change");
  expect(view.host.textContent).toBe("");
  expect(useModelRecoveryStore.getState().byChat[otherKey].dismissed).toBe(false);
});

test("an unrelated chat does not inherit the note", async () => {
  record();
  expect((await mount({ sessionId: "chat-b" })).host.textContent).toBe("");
});

test("a visible side composer verifies return independently of the selected route", async () => {
  record();
  useModelRecoveryStore.getState().dismiss(key);
  const settings = { ...den.readDenSettings(), baseUrl: "https://den.example.test", authToken: "member-token", activeOrgId: "org-a" };
  const client = den.createDenClient({ baseUrl: settings.baseUrl, token: settings.authToken });
  const inventory = spyOn(client, "getModelRemovalInventory").mockResolvedValue({ models: [previous, replacement], lockedModels: [] });
  spyOn(den, "createDenClient").mockReturnValue(client);
  spyOn(den, "readDenSettings").mockReturnValue(settings);
  const view = await mount();
  expect(inventory).toHaveBeenCalledWith("org-a");
  expect(view.host.textContent).toContain("Claude Opus 4.5 is available again");
  expect(view.host.textContent).toContain("Switch back");
});

test("Switch back is offered only after return and restores the prior choice", async () => {
  record();
  useModelRecoveryStore.getState().markReturned(key, true);
  const view = await mount();
  expect(view.host.textContent).toContain("Claude Opus 4.5 is available again");
  await view.click("Switch back");
  expect(view.onSwitchBack).toHaveBeenCalledWith(previous);
  expect(useModelRecoveryStore.getState().byChat[key]).toBeUndefined();
});
