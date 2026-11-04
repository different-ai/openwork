/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { EngineV2PreviewStatus } from "../src/app/lib/openwork-server";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const server = await import("../src/app/lib/openwork-server");
const { requestEngineSwitch, resolveEngineSwitchPrompt, selectedChatEngine, useEngineSwitchStore } = await import("../src/react-app/shell/engine-switch");
const { useOpencodeEngineControls } = await import("../src/react-app/shell/opencode-engine-controls");
const { toast } = await import("../src/components/ui/sonner");
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let root: Root | null = null;
let previousBridge: unknown;
const status: EngineV2PreviewStatus = {
  enabled: false, running: false, chatRouting: false,
  mirroredProviderIds: [], skippedProviderIds: [], catalogModelIds: [],
};

beforeEach(() => {
  previousBridge = window.__OPENWORK_ELECTRON__;
  Reflect.set(window, "__OPENWORK_ELECTRON__", {});
  useEngineSwitchStore.setState({ switching: false, switchPrompt: null });
});
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  useEngineSwitchStore.setState({ switching: false, switchPrompt: null });
  Reflect.set(window, "__OPENWORK_ELECTRON__", previousBridge);
  document.body.innerHTML = "";
  mock.restore();
});
afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  if (ownedDom) await GlobalRegistrator.unregister();
});

function engineClient() {
  const client = server.createOpenworkServerClient({ baseUrl: "http://localhost:8787", token: "test-token" });
  spyOn(client, "getEngineV2PreviewStatus").mockResolvedValue(status);
  spyOn(client, "getEngineActivity").mockResolvedValue({
    v1: { verdict: "idle", busySessions: 0, waitingRequests: 0 }, v2: null,
  });
  spyOn(client, "switchOpencodeEngine").mockResolvedValue({ ...status, enabled: true, chatRouting: true });
  return client;
}

test("engine selection requires both enabled and chat routing", () => {
  expect(selectedChatEngine({ enabled: true, chatRouting: false })).toBe("v1");
  expect(selectedChatEngine({ enabled: true, chatRouting: true })).toBe("v2");
});

test("idle switch updates routing and notifies the app", async () => {
  const client = engineClient();
  const changed = mock(() => {});
  window.addEventListener("openwork-engine-changed", changed);
  try {
    expect(await requestEngineSwitch(client, "v2", "v1")).toMatchObject({ chatRouting: true });
    expect(client.switchOpencodeEngine).toHaveBeenCalledWith("v2");
    expect(changed).toHaveBeenCalledTimes(1);
    expect(useEngineSwitchStore.getState().switching).toBe(false);
  } finally {
    window.removeEventListener("openwork-engine-changed", changed);
  }
});

for (const confirmed of [false, true]) {
  test(`active v2 tasks require a decision before returning to separate v1 history (${confirmed ? "switch" : "cancel"})`, async () => {
    const client = engineClient();
    spyOn(client, "getEngineActivity").mockResolvedValue({
      v1: { verdict: "idle", busySessions: 0, waitingRequests: 0 },
      v2: { verdict: "busy", busySessions: 1, waitingRequests: 2 },
    });
    const pending = requestEngineSwitch(client, "v1", "v2");
    await Promise.resolve();
    await Promise.resolve();
    expect(useEngineSwitchStore.getState().switchPrompt).toMatchObject({ from: "v2", runningTasks: 3 });
    expect(client.switchOpencodeEngine).not.toHaveBeenCalled();
    resolveEngineSwitchPrompt(confirmed);
    const result = await pending;
    expect(result === null).toBe(!confirmed);
    expect(client.switchOpencodeEngine).toHaveBeenCalledTimes(confirmed ? 1 : 0);
    expect(useEngineSwitchStore.getState()).toMatchObject({ switching: false, switchPrompt: null });
  });
}

for (const desktop of [false, true]) {
  test(`${desktop ? "desktop" : "web"} exposes only appropriate engine actions and respects v2-only routing`, async () => {
    if (!desktop) Reflect.deleteProperty(window, "__OPENWORK_ELECTRON__");
    const client = engineClient();
    spyOn(client, "getEngineV2PreviewStatus").mockResolvedValue({ ...status, enabled: true, chatRouting: true, v2Only: true });
    function Controls() {
      const controls = useOpencodeEngineControls(client);
      return <>{controls.items.map((item) => <button key={item.id} data-id={item.id} disabled={item.disabled}>{item.title}</button>)}</>;
    }
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root?.render(<Controls />));
    expect(host.querySelectorAll("button").length).toBe(desktop ? 2 : 0);
    expect(host.querySelector('[data-id="opencode.migrate-v2"]')).toBeNull();
    if (desktop) expect(host.querySelector('[data-id="opencode.switch-v1"]')?.hasAttribute("disabled")).toBe(true);
    else expect(client.getEngineV2PreviewStatus).not.toHaveBeenCalled();
  });
}

for (const counts of [{ busySessions: 1, waitingRequests: 0 }, { busySessions: 0, waitingRequests: 1 }]) {
  test(`v1 handoff waits for active work (${JSON.stringify(counts)}) without offering an override`, async () => {
    const client = engineClient();
    const error = spyOn(toast, "error").mockImplementation(() => "test-toast");
    spyOn(client, "getEngineActivity").mockResolvedValue({ v1: { verdict: "busy", ...counts }, v2: null });
    expect(await requestEngineSwitch(client, "v2", "v1")).toBeNull();
    expect(client.switchOpencodeEngine).not.toHaveBeenCalled();
    expect(useEngineSwitchStore.getState()).toMatchObject({ switching: false, switchPrompt: null });
    expect(error).toHaveBeenCalledWith("Wait for running OpenCode v1 tasks to finish before switching to v2.");
  });
}

for (const v2Only of [false, true]) {
  test(`shared-history adoption locks v1 independently of organization policy (${v2Only})`, async () => {
    const reason = "Chat history is now managed by OpenCode v2.";
    const client = engineClient();
    spyOn(client, "getEngineV2PreviewStatus").mockResolvedValue({ ...status, enabled: true, chatRouting: true, v2Only, v1UnavailableReason: reason });
    function Controls() {
      const controls = useOpencodeEngineControls(client);
      return <>
        <p>{controls.v1Locked}</p>
        {controls.items.map((item) => <button key={item.id} data-id={item.id} disabled={item.disabled} onClick={item.action}>{item.detail}</button>)}
        <button data-id="direct-select" onClick={() => controls.select("v1")}>Select v1</button>
      </>;
    }
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root?.render(<Controls />));
    const v1 = host.querySelector('[data-id="opencode.switch-v1"]');
    expect(v1?.hasAttribute("disabled")).toBe(true);
    expect(v1?.textContent).toBe(reason);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-id="direct-select"]')?.click());
    expect(client.switchOpencodeEngine).not.toHaveBeenCalled();
  });
}

test("a server rejection of unsafe v1 reversion reports the reason without switching", async () => {
  const client = engineClient();
  const message = "Chat history is now managed by OpenCode v2.";
  const error = spyOn(toast, "error").mockImplementation(() => "test-toast");
  spyOn(client, "switchOpencodeEngine").mockRejectedValue(new server.OpenworkServerError(409, "engine_v1_history_adopted", message));
  const changed = mock(() => {});
  window.addEventListener("openwork-engine-changed", changed);
  try {
    expect(await requestEngineSwitch(client, "v1", "v2")).toBeNull();
    expect(error).toHaveBeenCalledWith(message);
    expect(changed).not.toHaveBeenCalled();
    expect(useEngineSwitchStore.getState()).toMatchObject({ switching: false, switchPrompt: null });
  } finally {
    window.removeEventListener("openwork-engine-changed", changed);
  }
});

for (const extra of [{}, { v2Only: true }, { v1UnavailableReason: "Shared history adopted by v2." }, { v1UnavailableReason: 123 }]) {
  test(`status parser preserves only valid optional engine locks (${JSON.stringify(extra)})`, async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ...status, ...extra }), { status: 200 }));
    const client = server.createOpenworkServerClient({ baseUrl: "http://localhost:8787", token: "test-token" });
    const parsed = await client.getEngineV2PreviewStatus();
    expect(parsed.v2Only).toBe("v2Only" in extra ? extra.v2Only : undefined);
    expect(parsed.v1UnavailableReason).toBe("v1UnavailableReason" in extra && typeof extra.v1UnavailableReason === "string" ? extra.v1UnavailableReason : undefined);
  });
}
