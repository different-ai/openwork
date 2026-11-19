/** @jsxImportSource react */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ControlSessionLike } from "../src/react-app/domains/session/control/list-control-sessions";
import { getSessionModelSelection, useSessionModelSelection, useSessionModelStore } from "../src/react-app/domains/session/surface/session-model-store";
import { restoreSessionModel, useRestoreSessionModel } from "../src/react-app/domains/session/surface/use-restore-session-model";

const ownsDom = !GlobalRegistrator.isRegistered && typeof document === "undefined";
const fallback = { providerID: "local-provider", modelID: "unrelated-default" };
const launched = { providerID: "remote-provider", id: "launch-model", variant: "high" };
let root: Root;
let host: HTMLDivElement;
let previousAct: unknown;

beforeAll(() => {
  if (ownsDom) GlobalRegistrator.register({ url: "http://localhost/" });
  previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});
afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  if (ownsDom) await GlobalRegistrator.unregister();
});
beforeEach(() => {
  window.localStorage.clear();
  useSessionModelStore.setState({ bySessionId: {} });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useSessionModelStore.setState({ bySessionId: {} });
});

function Composer({ id, session }: { id: string; session?: ControlSessionLike | null }) {
  useRestoreSessionModel(id, session);
  const selection = useSessionModelSelection({
    sessionId: id, fallbackModel: fallback, fallbackModelLabel: "Local default",
    fallbackVariant: null, fallbackVariantLabel: "Default", onFallbackVariantChange: () => {},
  });
  return <output data-session={id}>{selection.selectedModel.providerID}/{selection.selectedModel.modelID}:{selection.modelVariant ?? "default"}</output>;
}
const render = async (id: string, session?: ControlSessionLike | null) => {
  await act(async () => root.render(<Composer id={id} session={session} />));
};

test("opening a remotely launched session restores its model and effort for both the selector and follow-up sends", async () => {
  window.localStorage.setItem("openwork.defaultModel", "local-provider/unrelated-default");
  await render("remote", { id: "remote", model: launched });
  expect(host.textContent).toBe("remote-provider/launch-model:high");
  expect(getSessionModelSelection("remote")).toEqual({
    model: { providerID: "remote-provider", modelID: "launch-model" }, variant: "high",
  });
  expect(JSON.parse(window.localStorage.getItem("openwork.sessionModels.v1") ?? "{}").remote)
    .toEqual(getSessionModelSelection("remote"));
  expect(window.localStorage.getItem("openwork.defaultModel")).toBe("local-provider/unrelated-default");
});

test("background follow-ups restore from their owned native read before resolving the send model", () => {
  restoreSessionModel("remote", { id: "remote", model: launched });
  expect(getSessionModelSelection("remote")).toEqual({
    model: { providerID: launched.providerID, modelID: launched.id }, variant: launched.variant,
  });
  useSessionModelStore.getState().setModel("remote", fallback, "low");
  restoreSessionModel("remote", { id: "remote", model: launched });
  expect(getSessionModelSelection("remote")).toEqual({ model: fallback, variant: "low" });
});

test("the engine's default effort becomes the composer's null effort", async () => {
  await render("remote", { id: "remote", model: { ...launched, variant: "default" } });
  expect(getSessionModelSelection("remote")?.variant).toBeNull();
});

test("a remembered local model and effort win over an older launch model", async () => {
  useSessionModelStore.getState().setModel("remote", fallback, "low");
  await render("remote", { id: "remote", model: launched });
  expect(host.textContent).toBe("local-provider/unrelated-default:low");
});

test("an effort-only change is not reset by later snapshots of the same launch model", async () => {
  await render("remote", { id: "remote", model: launched });
  await act(async () => useSessionModelStore.getState().setVariant("remote", "low"));
  await render("remote", { id: "remote", model: { ...launched, variant: "medium" } });
  expect(getSessionModelSelection("remote")?.variant).toBe("low");
});

test("a picker choice made before delayed history arrives is never overwritten", async () => {
  await render("remote", null);
  await act(async () => useSessionModelStore.getState().setModel("remote", fallback, "medium"));
  await render("remote", { id: "remote", model: launched });
  expect(host.textContent).toBe("local-provider/unrelated-default:medium");
});

test("history belonging to another conversation cannot seed the selected conversation", async () => {
  await render("new-session", { id: "old-session", model: launched });
  expect(getSessionModelSelection("new-session")).toBeNull();
  expect(getSessionModelSelection("old-session")).toBeNull();
  expect(host.textContent).toBe("local-provider/unrelated-default:default");
});

test("two panes restore independent launch models", async () => {
  await act(async () => root.render(<>
    <Composer id="one" session={{ id: "one", model: launched }} />
    <Composer id="two" session={{ id: "two", model: { providerID: "other-provider", id: "other-model" } }} />
  </>));
  expect(getSessionModelSelection("one")?.model.modelID).toBe("launch-model");
  expect(getSessionModelSelection("two")?.model.modelID).toBe("other-model");
});

test("an engine-bound router stays selected rather than adopting a concrete reply model", async () => {
  await render("remote", { id: "remote", model: { providerID: "openwork-auto", id: "smart-router" } });
  expect(getSessionModelSelection("remote")?.model).toEqual({ providerID: "openwork-auto", modelID: "smart-router" });
});

test("sessions without a valid bound model retain the existing fallback without writing memory", async () => {
  for (const model of [undefined, null, {}, { providerID: " ", id: "launch-model" }, { providerID: "remote-provider", id: "" }]) {
    await render("legacy", { id: "legacy", model });
    expect(getSessionModelSelection("legacy")).toBeNull();
    expect(host.textContent).toBe("local-provider/unrelated-default:default");
  }
});
