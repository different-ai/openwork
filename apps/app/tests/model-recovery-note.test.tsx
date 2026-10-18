/** @jsxImportSource react */
import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import * as features from "../src/react-app/domains/cloud/use-org-feature";
import * as den from "../src/app/lib/den";
import { ModelRecoveryNote } from "../src/react-app/domains/session/surface/composer/model-recovery-note";
import { modelRecoveryChatKey, useDefaultModelRecovery, useModelRecoveryStore } from "../src/react-app/domains/session/surface/model-recovery-store";

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

async function mount(options: { enabled?: boolean; sessionId?: string; model?: typeof replacement } = {}) {
  spyOn(features, "useOrgFeature").mockReturnValue(options.enabled !== false);
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

function DefaultRecoveryPresenter(props: { configuredKey: string; verified: boolean }) {
  useDefaultModelRecovery(modelRecoveryChatKey("member/workspace"), props.configuredKey, props.verified);
  return <ModelRecoveryNote scope="member/workspace" selectedModel={replacement} onChange={() => {}} onSwitchBack={() => {}} />;
}

test("a verified default adopting the same replacement retires its temporary note and obsolete Switch back while mounted", async () => {
  spyOn(features, "useOrgFeature").mockReturnValue(true);
  const chat = modelRecoveryChatKey("member/workspace");
  useModelRecoveryStore.getState().record(chat, { previous, replacement, defaultSelectionKey: "configured-A" });
  useModelRecoveryStore.getState().markReturned(chat, true);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  cleanups.push(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => root.render(<DefaultRecoveryPresenter configuredKey="configured-A" verified />));
  expect(host.textContent).toContain("for now");
  expect(host.textContent).toContain("Switch back");
  // An unresolved read must never destroy the last known recovery record.
  await act(async () => root.render(<DefaultRecoveryPresenter configuredKey="configured-B" verified={false} />));
  expect(useModelRecoveryStore.getState().byChat[chat]).toBeDefined();
  await act(async () => root.render(<DefaultRecoveryPresenter configuredKey="configured-B" verified />));
  expect(useModelRecoveryStore.getState().byChat[chat]).toBeUndefined();
  expect(host.textContent).toBe("");
});

test("confirmed removal names both models and Change opens the composer picker", async () => {
  record();
  const view = await mount();
  expect(view.host.textContent).toContain("Claude Opus 4.5 was removed by your organization · Using Claude Sonnet 4.5 for this chat ·");
  expect(view.host.textContent).not.toMatch(/ipr_|gwm_/);
  expect(view.host.querySelector('[role="status"]')).not.toBeNull();
  await view.click("Change");
  expect(view.onChange).toHaveBeenCalledTimes(1);
  expect(view.onSwitchBack).not.toHaveBeenCalled();
});

test("the default-off rollout hides the note without undoing the selected model", async () => {
  record();
  const view = await mount({ enabled: false });
  expect(view.host.textContent).toBe("");
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
