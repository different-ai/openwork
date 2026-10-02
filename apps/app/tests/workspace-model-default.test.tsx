import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { readStoredDefaultModel, readWorkspaceDefaultModel, resolveNewTaskModel, setWorkspaceDefaultModel, useWorkspaceDefaultModel, workspaceDefaultModelKey, workspaceModelScope, writeStoredDefaultModel } from "../src/react-app/kernel/model-config";
import { getSessionModelSelection, useSessionModelStore } from "../src/react-app/domains/session/surface/session-model-store";

GlobalRegistrator.register({ url: "http://localhost" });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
afterAll(async () => { await GlobalRegistrator.unregister(); });

const fallback = { model: { providerID: "fixture", modelID: "global" }, variant: "low" };
const chosen = { providerID: "fixture", modelID: "workspace-choice" };
const scope = (workspaceId: string, profileId = "profile-one", origin = "https://runtime.invalid") => workspaceModelScope({
  profileId, workspaceId, opencodeBaseUrl: `${origin}/workspace/${workspaceId}/opencode2`, localRuntime: false,
});

test("workspace default applies to new tasks only, survives remount, and keeps other workspaces and global fallback unchanged", async () => {
  const first = scope("one");
  const second = scope("two");
  writeStoredDefaultModel(fallback.model);
  useSessionModelStore.getState().setModel("existing", fallback.model, "high");
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  function NewTask({ workspaceId }: { workspaceId: string }) {
    const owner = scope(workspaceId);
    const saved = useWorkspaceDefaultModel(owner);
    const selection = saved ?? fallback;
    return createElement("div", null,
      createElement("span", { "data-model": true }, selection.model.modelID),
      createElement("button", { onClick: () => setWorkspaceDefaultModel(owner, chosen) }, "Set workspace default"),
      createElement("button", { onClick: () => {
        const next = resolveNewTaskModel(owner, fallback);
        if (next.model) useSessionModelStore.getState().setModel(`new-${workspaceId}`, next.model, next.variant);
      } }, "Create task"));
  }
  try {
    await act(async () => root.render(createElement(NewTask, { workspaceId: "one" })));
    expect(host.querySelector("span")?.textContent).toBe("global");
    await act(async () => host.querySelectorAll("button")[0].click());
    expect(host.querySelector("span")?.textContent).toBe("workspace-choice");
    await act(async () => host.querySelectorAll("button")[1].click());
    expect(getSessionModelSelection("new-one")).toEqual({ model: chosen, variant: null });
    expect(getSessionModelSelection("existing")).toEqual({ model: fallback.model, variant: "high" });
    await act(async () => root.render(createElement(NewTask, { workspaceId: "two" })));
    expect(host.querySelector("span")?.textContent).toBe("global");
    await act(async () => host.querySelectorAll("button")[1].click());
    expect(getSessionModelSelection("new-two")).toEqual(fallback);
    expect(readWorkspaceDefaultModel(second)).toBeNull();
    await act(async () => root.render(null));
    await act(async () => root.render(createElement(NewTask, { workspaceId: "one" })));
    expect(host.querySelector("span")?.textContent).toBe("workspace-choice");
    expect(readWorkspaceDefaultModel(first)).toEqual({ model: chosen, variant: null });
    expect(readStoredDefaultModel()).toEqual(fallback.model);
    expect(resolveNewTaskModel(scope("one", "profile-two"), fallback)).toEqual(fallback);
    expect(resolveNewTaskModel(scope("one", "profile-one", "https://other-runtime.invalid"), fallback)).toEqual(fallback);
    expect(setWorkspaceDefaultModel(null, chosen)).toBe(false);
  } finally { await act(async () => root.unmount()); host.remove(); localStorage.clear(); }
});

test("scope omits credentials and transient desktop ports while distinguishing remote runtimes", () => {
  const input = { profileId: "local", workspaceId: "one", localRuntime: true };
  const first = workspaceModelScope({ ...input, opencodeBaseUrl: "http://localhost:4096/workspace/one/opencode2?token=synthetic#secret" });
  const restarted = workspaceModelScope({ ...input, opencodeBaseUrl: "http://localhost:8192/workspace/one/opencode" });
  expect(first).toEqual(restarted);
  expect(workspaceDefaultModelKey(first)).not.toMatch(/synthetic|secret|4096/);
  expect(workspaceModelScope({ ...input, profileId: null, opencodeBaseUrl: "http://localhost:4096" })).toBeNull();
  expect(workspaceModelScope({ ...input, workspaceId: "", opencodeBaseUrl: "http://localhost:4096" })).toBeNull();
});
