/** @jsxImportSource react */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RemoteDevice } from "@openwork/types/den/remote-devices";
import type { RemoteSessionAccessMode } from "@openwork/types/automations";
import type { RemoteSessionAccessState } from "../src/app/lib/desktop";
import type { AutomationsDenContext } from "../src/react-app/domains/automations/use-automations";

let createRoot: typeof import("react-dom/client")["createRoot"];
let DevicesContent: typeof import("../src/react-app/domains/settings/pages/devices-view")["DevicesContent"];
let root: Root | null = null;
let queryClient: QueryClient;
const ownedDom = !GlobalRegistrator.isRegistered && typeof document === "undefined";
beforeAll(async () => {
  if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  createRoot = (await import("react-dom/client")).createRoot;
  DevicesContent = (await import("../src/react-app/domains/settings/pages/devices-view")).DevicesContent;
});
const previousBridge = typeof window === "undefined" ? undefined : window.__OPENWORK_ELECTRON__;
afterEach(async () => {
  await act(async () => root?.unmount()); root = null;
  queryClient?.clear(); document.body.innerHTML = "";
  Reflect.set(window, "__OPENWORK_ELECTRON__", previousBridge);
});
afterAll(async () => { if (ownedDom) await GlobalRegistrator.unregister(); });
const device = (change: Partial<RemoteDevice> = {}): RemoteDevice => ({
  id: "desktop-1", kind: "desktop", provider: "openwork_desktop", source: "desktop_app", platform: "darwin",
  label: "Ada's Mac", access: "mine", availability: "online", state: "ready", statusDetail: null,
  lastSeenAt: "2026-11-10T10:00:00Z", createdAt: "2026-11-10T09:00:00Z", appVersion: "0.14.2",
  computerId: "runner-1", workbotChat: null, canRename: true, canRemove: true, ...change,
});
const pause = () => new Promise(resolve => setTimeout(resolve, 20));
const calls: Array<{ kind: string; input?: unknown }> = [];
async function render(options: { devices?: RemoteDevice[]; enabled?: boolean; ready?: boolean; failure?: boolean; sessionAccess?: boolean } = {}) {
  calls.length = 0;
  const devices = options.devices ?? [device(), device({ id: "vm-1", label: "Build VM", kind: "vm", provider: "daytona", availability: "paused", state: "paused", access: "shared" })];
  const client = {
    listRemoteDevices: async () => { calls.push({ kind: "list" }); if (options.failure) throw new Error("Network unavailable"); return devices; },
    getRemoteDevice: async () => { calls.push({ kind: "detail" }); return { device: devices[0], events: [{ id: "event-1", type: "registered", actor: "device", level: "info", message: "Computer registered", createdAt: "2026-11-10T10:00:00Z" }] }; },
    registerRemoteDevice: async (_org: string, input: unknown) => { calls.push({ kind: "register", input }); return devices[0]; },
    renameRemoteDevice: async (_org: string, id: string, label: string) => { calls.push({ kind: "rename", input: { id, label } }); return devices[0]; },
    removeRemoteDevice: async (_org: string, id: string) => { calls.push({ kind: "remove", input: id }); },
  } as unknown as NonNullable<AutomationsDenContext["client"]>;
  const context: AutomationsDenContext = { client, ready: options.ready ?? true, organizationId: "org-1", queryRoot: ["den", "automations", "org-1"] };
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => { root!.render(<QueryClientProvider client={queryClient}><DevicesContent context={context} enabled={options.enabled ?? true} sessionAccess={options.sessionAccess} /></QueryClientProvider>); await pause(); });
  await act(pause);
  return container;
}
async function click(text: string) {
  const button = [...document.querySelectorAll<HTMLElement>("button,[role=menuitem]")].find(item => item.textContent?.trim() === text);
  expect(button).toBeDefined();
  await act(async () => { button!.click(); await pause(); });
}
async function fill(id: string, value: string) {
  const input = document.getElementById(id) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function manage() {
  await act(async () => { (document.querySelector('[aria-label="Manage Ada\'s Mac"]') as HTMLButtonElement).click(); await pause(); });
}

test("web Devices groups desktops and VMs with reported state and lazy recent events", async () => {
  const container = await render();
  expect(container.textContent).toContain("Your computers"); expect(container.textContent).toContain("Cloud computers");
  expect(container.querySelectorAll('[data-testid="device-row"]').length).toBe(2);
  expect(container.textContent).toContain("Online"); expect(container.textContent).toContain("Paused");
  expect(container.textContent).toContain("Shared with your organization");
  expect(calls.some(call => call.kind === "detail")).toBe(false);
  await act(async () => { const details = container.querySelector("details")!; details.open = true; details.dispatchEvent(new Event("toggle")); await pause(); });
  await act(pause);
  expect(container.textContent).toContain("Computer registered");
});
test("off and signed-out states never fetch device data", async () => {
  const container = await render({ enabled: false });
  expect(container.textContent).toContain("Not turned on"); expect(calls).toHaveLength(0);
});
test("signed-out Devices offers sign-in direction", async () => {
  const container = await render({ ready: false });
  expect(container.textContent).toContain("Cloud account"); expect(calls).toHaveLength(0);
});
test("failed reads offer retry", async () => {
  const container = await render({ failure: true });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Couldn't refresh devices");
  await click("Try again"); expect(calls.filter(call => call.kind === "list").length).toBe(2);
});
test("register VM dialog sends validated provider, ID, platform and sharing", async () => {
  await render({ devices: [] }); await click("Add a computer");
  await fill("device-label", "Build machine"); await fill("device-external-id", "vm-42");
  await act(async () => { document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await pause(); });
  expect(calls.find(call => call.kind === "register")?.input).toEqual({ label: "Build machine", provider: "freestyle", externalId: "vm-42", platform: "linux", shared: false });
});
test("invalid VM IDs stay in the dialog without sending a registration", async () => {
  await render(); await click("Add a computer");
  await fill("device-label", "Build VM"); await fill("device-external-id", "https://provider.example/vm/42");
  await act(async () => { document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await pause(); });
  expect(calls.some(call => call.kind === "register")).toBe(false);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Use the id the provider shows");
});
test("read-only devices have no mutation menu", async () => {
  const container = await render({ devices: [device({ canRename: false, canRemove: false })] });
  expect(container.querySelector('[aria-label="Manage Ada\\\'s Mac"]')).toBeNull();
});
test("the desktop report and runner share one stable install ID", async () => {
  const { desktopRunnerId, organizationRunnerId } = await import("../src/react-app/domains/automations/automation-runner-identity");
  const { buildDeviceReport } = await import("../src/react-app/domains/devices/device-report");
  const id = desktopRunnerId();
  expect(desktopRunnerId()).toBe(id);
  const report = buildDeviceReport({ installId: null, label: "This Mac", platform: "darwin", appVersion: "0.14.2", osVersion: null, arch: null }, null, desktopRunnerId());
  expect(report?.installId).toBe(id);
  expect(organizationRunnerId(id, "org-a")).toBe(`${id}:org-a`);
  expect(desktopRunnerId()).toBe(id);
});
test("query caches isolate different sign-ins without including credentials", async () => {
  const { remoteDevicesContextQueryKey } = await import("../src/react-app/domains/devices/use-remote-devices");
  const context = { client: {} as NonNullable<AutomationsDenContext["client"]>, organizationId: "org-1", ready: true, queryRoot: ["den", "automations", "org-1"] as const };
  expect(remoteDevicesContextQueryKey(context)).toEqual(remoteDevicesContextQueryKey(context));
  expect(remoteDevicesContextQueryKey(context)).not.toEqual(remoteDevicesContextQueryKey({ ...context, client: {} as NonNullable<AutomationsDenContext["client"]> }));
});
test("rename saves the new name and remove waits for confirmation", async () => {
  await render(); await manage(); await click("Rename"); await fill("device-label", "Office Mac"); await click("Save changes");
  expect(calls.find(call => call.kind === "rename")?.input).toEqual({ id: "desktop-1", label: "Office Mac" });
  await manage(); await click("Remove");
  expect(calls.some(call => call.kind === "remove")).toBe(false);
  expect(document.body.textContent).toContain("won't stop or delete"); await click("Remove device");
  expect(calls.find(call => call.kind === "remove")?.input).toBe("desktop-1");
});

const accessHeading = "Sessions other devices can reach";
const accessState = (change: Partial<RemoteSessionAccessState> = {}): RemoteSessionAccessState => ({ mode: "created", ceiling: "all", effective: "created", supported: true, ...change });
/** This computer's main process: it keeps the choice and says what is in force. */
function desktopSessionAccess(initial: RemoteSessionAccessState, options: { failWrites?: boolean } = {}) {
  const desktop = { state: initial, reads: 0, writes: [] as RemoteSessionAccessMode[] };
  Reflect.set(window, "__OPENWORK_ELECTRON__", { remoteSessionAccess: {
    get: async () => { desktop.reads += 1; return desktop.state; },
    set: async (mode: RemoteSessionAccessMode) => {
      desktop.writes.push(mode);
      if (options.failWrites) throw new Error("Error invoking remote method");
      desktop.state = { ...desktop.state, mode, effective: mode === "all" && desktop.state.ceiling === "all" && desktop.state.supported ? "all" : "created" };
      return desktop.state;
    },
  } });
  return desktop;
}
const choice = (mode: RemoteSessionAccessMode) => document.getElementById(`session-access-${mode}`)!.closest("label")!.querySelector<HTMLElement>('[role="radio"]')!;
const chosen = (mode: RemoteSessionAccessMode) => choice(mode).getAttribute("aria-checked") === "true";
const unavailable = (mode: RemoteSessionAccessMode) => choice(mode).getAttribute("aria-disabled") === "true";
const reason = () => document.querySelector('[data-testid="session-access-reason"]')?.textContent ?? null;
async function choose(mode: RemoteSessionAccessMode) {
  await act(async () => { choice(mode).click(); await pause(); });
}

test("this computer's session choice is hidden while the feature is off or outside the desktop app", async () => {
  const desktop = desktopSessionAccess(accessState());
  expect((await render({ sessionAccess: false })).textContent).not.toContain(accessHeading);
  expect((await render()).textContent).not.toContain(accessHeading);
  expect(desktop.reads).toBe(0);
  Reflect.set(window, "__OPENWORK_ELECTRON__", undefined);
  const container = await render({ sessionAccess: true });
  expect(container.textContent).not.toContain(accessHeading);
  expect(container.querySelectorAll('[data-testid="device-row"]').length).toBe(2);
});
test("this computer starts on sessions started remotely, with both choices explained", async () => {
  desktopSessionAccess(accessState());
  const container = await render({ sessionAccess: true });
  expect(container.textContent).toContain(accessHeading);
  expect(container.textContent).toContain("Only sessions started remotely");
  expect(container.textContent).toContain("Your other devices can follow and answer tasks they started here.");
  expect(container.textContent).toContain("All sessions on this computer");
  expect(container.textContent).toContain("Your other devices, Workbot and agents working for you can also open sessions you started here, continue them, stop them and answer their questions and permission requests.");
  expect(chosen("created")).toBe(true); expect(chosen("all")).toBe(false);
  expect(unavailable("created")).toBe(false); expect(unavailable("all")).toBe(false);
  expect(reason()).toBeNull();
  expect(container.querySelectorAll('[data-testid="device-row"]').length).toBe(2);
});
test("all sessions cannot be chosen past the organization's limit, before it is known, or on an older sign-in", async () => {
  for (const [state, text] of [
    [accessState({ ceiling: "created" }), "Your organization only allows sessions started remotely."],
    [accessState({ ceiling: null }), "Available once this computer is connected to your organization."],
    [accessState({ ceiling: null, supported: false }), "Sign in again or update OpenWork to use this."],
    [accessState({ supported: false }), "Sign in again or update OpenWork to use this."],
  ] as const) {
    const desktop = desktopSessionAccess(state);
    await render({ sessionAccess: true });
    expect(reason()).toBe(text);
    expect(unavailable("all")).toBe(true); expect(unavailable("created")).toBe(false);
    await choose("all");
    expect(desktop.writes).toEqual([]);
    expect(document.body.textContent).not.toContain("Allow all sessions");
    await act(async () => root?.unmount()); root = null; document.body.innerHTML = "";
  }
});
test("a stored choice of all sessions the organization no longer allows is shown as not in effect and can be narrowed", async () => {
  const desktop = desktopSessionAccess(accessState({ mode: "all", ceiling: "created" }));
  await render({ sessionAccess: true });
  expect(chosen("all")).toBe(true);
  expect(reason()).toBe("Not in effect. Your organization only allows sessions started remotely.");
  await choose("created");
  expect(desktop.writes).toEqual(["created"]);
  expect(chosen("created")).toBe(true);
  expect(reason()).toBe("Your organization only allows sessions started remotely.");
});
test("choosing all sessions waits for confirmation; narrowing applies at once", async () => {
  const desktop = desktopSessionAccess(accessState());
  await render({ sessionAccess: true });
  await choose("all");
  expect(desktop.writes).toEqual([]);
  expect(document.body.textContent).toContain("will be able to open any session on this computer");
  expect(document.body.textContent).toContain("You can turn this off here at any time.");
  await click("Cancel");
  expect(desktop.writes).toEqual([]); expect(chosen("created")).toBe(true);
  await choose("all"); await click("Allow all sessions");
  expect(desktop.writes).toEqual(["all"]);
  const reads = desktop.reads;
  expect(reads).toBeGreaterThan(1);
  expect(chosen("all")).toBe(true); expect(reason()).toBeNull();
  await choose("created");
  expect(desktop.writes).toEqual(["all", "created"]);
  expect(desktop.reads).toBeGreaterThan(reads);
  expect(chosen("created")).toBe(true);
  expect(document.body.textContent).not.toContain("Allow all sessions");
});
test("a choice that could not be saved says so and shows what this computer still has", async () => {
  const desktop = desktopSessionAccess(accessState({ mode: "all", effective: "all" }), { failWrites: true });
  await render({ sessionAccess: true });
  await choose("created");
  expect(desktop.writes).toEqual(["created"]);
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("Couldn't change this. Try again.");
  expect(chosen("all")).toBe(true);
});
test("signed out, this computer's choice can still be narrowed", async () => {
  const desktop = desktopSessionAccess(accessState({ mode: "all", ceiling: null, supported: false }));
  const container = await render({ sessionAccess: true, ready: false });
  expect(container.textContent).toContain("Cloud account"); expect(calls).toHaveLength(0);
  expect(reason()).toBe("Not in effect. Sign in again or update OpenWork to use this.");
  await choose("created");
  expect(desktop.writes).toEqual(["created"]);
});
