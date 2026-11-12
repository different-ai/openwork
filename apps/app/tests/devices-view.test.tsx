/** @jsxImportSource react */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { remoteDeviceSchema, type RemoteDevice } from "@openwork/types/den/remote-devices";
import type { RemoteSessionAccessMode } from "@openwork/types/automations";
import type { RemoteSessionAccessState } from "../src/app/lib/desktop";
import type { AutomationsDenContext } from "../src/react-app/domains/automations/use-automations";

let createRoot: typeof import("react-dom/client")["createRoot"];
let DevicesContent: typeof import("../src/react-app/domains/settings/pages/devices-view")["DevicesContent"];
let connection: typeof import("../src/react-app/domains/devices/computer-connection-store");
let thisDevice: typeof import("../src/react-app/domains/devices/this-device-store")["useThisDeviceStore"];
let root: Root | null = null;
let queryClient: QueryClient;
const ownedDom = !GlobalRegistrator.isRegistered && typeof document === "undefined";
beforeAll(async () => {
  if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  createRoot = (await import("react-dom/client")).createRoot;
  DevicesContent = (await import("../src/react-app/domains/settings/pages/devices-view")).DevicesContent;
  connection = await import("../src/react-app/domains/devices/computer-connection-store");
  thisDevice = (await import("../src/react-app/domains/devices/this-device-store")).useThisDeviceStore;
});
const previousBridge = typeof window === "undefined" ? undefined : window.__OPENWORK_ELECTRON__;
afterEach(async () => {
  await act(async () => root?.unmount()); root = null;
  queryClient?.clear(); document.body.innerHTML = "";
  Reflect.set(window, "__OPENWORK_ELECTRON__", previousBridge);
  connection.markThisComputerConnected(); thisDevice.setState({ deviceIds: {} });
});
afterAll(async () => { if (ownedDom) await GlobalRegistrator.unregister(); });
const device = (change: Partial<RemoteDevice> = {}): RemoteDevice => ({
  id: "desktop-1", kind: "desktop", provider: "openwork_desktop", source: "desktop_app", platform: "darwin",
  label: "Ada's Mac", access: "mine", availability: "online", state: "ready", statusDetail: null,
  lastSeenAt: "2026-11-10T10:00:00Z", createdAt: "2026-11-10T09:00:00Z", appVersion: "0.14.2",
  computerId: "runner-1", workbotChat: null, canRename: true, canRemove: true, disconnectedAt: null, canDisconnect: false, ...change,
});
const pause = () => new Promise(resolve => setTimeout(resolve, 20));
const calls: Array<{ kind: string; input?: unknown }> = [];
async function render(options: { devices?: RemoteDevice[]; enabled?: boolean; ready?: boolean; failure?: boolean; sessionAccess?: boolean; organizationName?: string; onSignOut?: () => void; signedOut?: boolean; disconnectFailure?: boolean } = {}) {
  calls.length = 0;
  const devices = options.devices ?? [device(), device({ id: "vm-1", label: "Build VM", kind: "vm", provider: "daytona", availability: "paused", state: "paused", access: "shared" })];
  const client = {
    listRemoteDevices: async () => { calls.push({ kind: "list" }); if (options.failure) throw new Error("Network unavailable"); return devices; },
    getRemoteDevice: async () => { calls.push({ kind: "detail" }); return { device: devices[0], events: [{ id: "event-1", type: "registered", actor: "device", level: "info", message: "Computer registered", createdAt: "2026-11-10T10:00:00Z" }] }; },
    registerRemoteDevice: async (_org: string, input: unknown) => { calls.push({ kind: "register", input }); return devices[0]; },
    renameRemoteDevice: async (_org: string, id: string, label: string) => { calls.push({ kind: "rename", input: { id, label } }); return devices[0]; },
    disconnectRemoteDevice: async (_org: string, id: string) => { calls.push({ kind: "disconnect", input: id }); if (options.disconnectFailure) throw new Error("Network unavailable"); return { device: devices[0], signedOut: options.signedOut ?? true }; },
    removeRemoteDevice: async (_org: string, id: string) => { calls.push({ kind: "remove", input: id }); },
  } as unknown as NonNullable<AutomationsDenContext["client"]>;
  const context: AutomationsDenContext = { client, ready: options.ready ?? true, organizationId: "org-1", queryRoot: ["den", "automations", "org-1"] };
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => { root!.render(<QueryClientProvider client={queryClient}><DevicesContent context={context} enabled={options.enabled ?? true} sessionAccess={options.sessionAccess} organizationName={options.organizationName} onSignOut={options.onSignOut} /></QueryClientProvider>); await pause(); });
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
async function manage(label = "Ada's Mac") {
  const trigger = [...document.querySelectorAll<HTMLButtonElement>("button[aria-label]")].find(button => button.getAttribute("aria-label") === `Manage ${label}`);
  expect(trigger).toBeDefined();
  await act(async () => { trigger!.click(); await pause(); });
}
/** The entries of the open row menu, closed again afterwards. */
async function menuOf(label: string) {
  await manage(label);
  const items = [...document.querySelectorAll('[role="menuitem"]')].map(item => item.textContent?.trim());
  await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await pause(); });
  return items;
}
const row = (label: string) => [...document.querySelectorAll<HTMLElement>('[data-testid="device-row"]')].find(item => item.textContent?.includes(label))!;
const notice = () => document.querySelector<HTMLElement>('[data-testid="computer-disconnected"]');
const outcome = () => document.querySelector('[data-testid="device-outcome"]')?.textContent ?? null;

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

test("a disconnected computer says so at the top, calmly, with a way to sign out", async () => {
  await render();
  expect(notice()).toBeNull();
  await act(async () => root?.unmount()); root = null; document.body.innerHTML = "";
  connection.markThisComputerDisconnected("this sign-in");
  let signOuts = 0;
  await render({ organizationName: "Acme", onSignOut: () => { signOuts += 1; } });
  expect(notice()?.getAttribute("role")).toBe("status");
  expect(notice()?.textContent).toContain("This computer was disconnected from Acme.");
  expect(notice()?.textContent).toContain("Sign out and sign in again to reconnect it.");
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(document.querySelectorAll('[data-testid="device-row"]').length).toBe(2);
  await click("Sign out");
  expect(signOuts).toBe(1);
  await act(async () => { connection.markThisComputerConnected(); await pause(); });
  expect(notice()).toBeNull();
});
test("the disconnected notice names no organization it does not know, and is not shown signed out", async () => {
  connection.markThisComputerDisconnected("this sign-in");
  await render();
  expect(notice()?.textContent).toContain("This computer was disconnected from your organization.");
  await act(async () => root?.unmount()); root = null; document.body.innerHTML = "";
  await render({ ready: false });
  expect(notice()).toBeNull();
});
test("this computer's choice stays readable while it is disconnected", async () => {
  desktopSessionAccess(notConnected);
  connection.markThisComputerDisconnected("this sign-in");
  const container = await render({ sessionAccess: true });
  expect(notice()).not.toBeNull();
  expect(container.textContent).toContain(accessHeading);
  expect(container.textContent).toContain("Start tasks here");
  expect(reason("off")).toBe("Available once this computer is connected to your organization.");
});
test("a disconnected desktop's row says so, what to do, and its short version", async () => {
  await render({ devices: [
    device({ disconnectedAt: "2026-11-10T11:00:00Z", availability: "offline", statusDetail: "Screen Recording is off", appVersion: "0.18.66-alpha.4137+053df1c" }),
    device({ id: "desktop-2", label: "Office PC", platform: "win32", appVersion: "0.18.66-alpha.4137+053df1c" }),
  ] });
  const status = row("Ada's Mac").querySelector('[role="status"]')!;
  expect(status.textContent).toBe("Disconnected");
  expect(status.className).toContain("text-muted-foreground");
  expect(row("Ada's Mac").textContent).toContain("Sign in on it again to reconnect.");
  expect(row("Ada's Mac").textContent).not.toContain("Offline");
  expect(row("Ada's Mac").textContent).not.toContain("Screen Recording is off");
  expect(row("Ada's Mac").textContent).toContain("OpenWork 0.18.66 alpha");
  expect(row("Ada's Mac").textContent).not.toContain("4137");
  expect(row("Office PC").querySelector('[role="status"]')!.textContent).toBe("Online");
  expect(row("Office PC").textContent).not.toContain("Sign in on it again");
});
test("Disconnect is offered for the member's other signed-in desktops, never for this computer", async () => {
  const devices = [
    device({ canDisconnect: true, canRemove: false }),
    device({ id: "desktop-2", label: "Office PC", computerId: "runner-2", canDisconnect: true, canRename: false, canRemove: false }),
    device({ id: "desktop-3", label: "Old laptop", computerId: null, disconnectedAt: "2026-11-10T11:00:00Z" }),
  ];
  thisDevice.setState({ deviceIds: { "org-1": "desktop-1" } });
  await render({ devices });
  expect(row("Ada's Mac").textContent).toContain("This computer");
  expect(await menuOf("Ada's Mac")).toEqual(["Rename"]);
  expect(await menuOf("Office PC")).toEqual(["Disconnect"]);
  expect(await menuOf("Old laptop")).toEqual(["Rename", "Remove"]);
});
test("before its first report, this computer is known by the id its runner registers with", async () => {
  const previous = localStorage.getItem("openwork.automations.desktop-runner-id");
  localStorage.setItem("openwork.automations.desktop-runner-id", "runner-1");
  Reflect.set(window, "__OPENWORK_ELECTRON__", {});
  try {
    await render({ devices: [
      device({ canDisconnect: true, canRemove: false }),
      device({ id: "desktop-2", label: "Office PC", computerId: "runner-2", canDisconnect: true, canRemove: false }),
    ] });
    expect(row("Ada's Mac").textContent).toContain("This computer");
    expect(await menuOf("Ada's Mac")).toEqual(["Rename"]);
    expect(row("Office PC").textContent).not.toContain("This computer");
    expect(await menuOf("Office PC")).toEqual(["Rename", "Disconnect"]);
  } finally {
    if (previous === null) localStorage.removeItem("openwork.automations.desktop-runner-id");
    else localStorage.setItem("openwork.automations.desktop-runner-id", previous);
  }
});
test("disconnecting waits for confirmation, then says whether OpenWork was signed out there", async () => {
  for (const [signedOut, message] of [
    [true, "Disconnected. OpenWork was signed out on that computer."],
    [false, "Disconnected. It can't act as a computer until someone signs in on it again."],
  ] as const) {
    await render({ signedOut, devices: [device(), device({ id: "desktop-2", label: "Office PC", canDisconnect: true, canRemove: false })] });
    await manage("Office PC"); await click("Disconnect");
    expect(calls.some(call => call.kind === "disconnect")).toBe(false);
    expect(document.body.textContent).toContain("Disconnect Office PC?");
    expect(document.body.textContent).toContain("OpenWork on that computer is signed out and it stops taking tasks and sharing sessions. Sign in on it again to reconnect it.");
    expect(outcome()).toBeNull();
    await click("Disconnect");
    expect(calls.filter(call => call.kind === "disconnect").map(call => call.input)).toEqual(["desktop-2"]);
    expect(document.body.textContent).not.toContain("Disconnect Office PC?");
    expect(outcome()).toBe(message);
    expect(calls.filter(call => call.kind === "list").length).toBe(2);
    await manage(); await click("Rename");
    expect(outcome()).toBeNull();
    await act(async () => root?.unmount()); root = null; document.body.innerHTML = "";
  }
});
test("a cancelled disconnect sends nothing, and a failed one stays in the dialog and says so", async () => {
  await render({ disconnectFailure: true, devices: [device({ id: "desktop-2", label: "Office PC", canDisconnect: true })] });
  await manage("Office PC"); await click("Disconnect"); await click("Cancel");
  expect(calls.some(call => call.kind === "disconnect")).toBe(false);
  expect(outcome()).toBeNull();
  await manage("Office PC"); await click("Disconnect"); await click("Disconnect");
  expect(calls.filter(call => call.kind === "disconnect").length).toBe(1);
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("Network unavailable");
  expect(document.body.textContent).toContain("Disconnect Office PC?");
  expect(outcome()).toBeNull();
});
test("a desktop listed by an older Den, which sends no disconnect fields, shows as connected with no Disconnect", async () => {
  const { disconnectedAt: _disconnectedAt, canDisconnect: _canDisconnect, ...fromOlderDen } = device({ id: "desktop-2", label: "Office PC" });
  await render({ devices: [remoteDeviceSchema.parse(fromOlderDen)] });
  expect(row("Office PC").querySelector('[role="status"]')!.textContent).toBe("Online");
  expect(row("Office PC").textContent).not.toContain("Disconnected");
  expect(row("Office PC").textContent).not.toContain("Sign in on it again");
  expect(await menuOf("Office PC")).toEqual(["Rename", "Remove"]);
});
test("removing a disconnected desktop no longer says it comes back when it reports", async () => {
  await render({ devices: [device({ disconnectedAt: "2026-11-10T11:00:00Z" }), device({ id: "desktop-2", label: "Office PC" })] });
  await manage(); await click("Remove");
  expect(document.body.textContent).toContain("This won't stop or delete the computer. It appears again if someone signs in on it.");
  expect(document.body.textContent).not.toContain("when it next reports");
  await click("Cancel");
  await manage("Office PC"); await click("Remove");
  expect(document.body.textContent).toContain("A desktop can appear again when it next reports.");
});

const accessHeading = "What other devices can do on this computer";
const accessState = (change: Partial<RemoteSessionAccessState> = {}): RemoteSessionAccessState => ({ mode: "created", ceiling: "all", effective: "created", supported: true, optIn: false, connected: true, ...change });
/** No runner is connected to an organization: signed out, disconnected, or not registered yet. */
const notConnected = accessState({ mode: null, ceiling: null, supported: false, connected: false });
const accessOrder = { off: 0, created: 1, all: 2 } as const;
/** What the main process says applies: off wins, then the choice or the default, capped by the organization. */
function applies(state: RemoteSessionAccessState): RemoteSessionAccessMode {
  if (state.mode === "off") return "off";
  const base = state.mode ?? (state.optIn ? "off" : "created");
  const cap = state.ceiling ?? "created";
  const narrower = accessOrder[base] <= accessOrder[cap] ? base : cap;
  return narrower === "all" && !state.supported ? "created" : narrower;
}
/** This computer's main process: it keeps the choice and says what is in force. */
function desktopSessionAccess(initial: Partial<RemoteSessionAccessState>, options: { failWrites?: boolean } = {}) {
  const first = accessState(initial);
  const desktop = { state: { ...first, effective: first.connected ? applies(first) : first.effective }, reads: 0, writes: [] as RemoteSessionAccessMode[] };
  Reflect.set(window, "__OPENWORK_ELECTRON__", { remoteSessionAccess: {
    get: async () => { desktop.reads += 1; return desktop.state; },
    set: async (mode: RemoteSessionAccessMode) => {
      desktop.writes.push(mode);
      if (options.failWrites || !desktop.state.connected) throw new Error("Error invoking remote method");
      desktop.state = { ...desktop.state, mode, effective: applies({ ...desktop.state, mode }) };
      return desktop.state;
    },
  } });
  return desktop;
}
const choice = (mode: RemoteSessionAccessMode) => document.getElementById(`session-access-${mode}`)?.closest("label")?.querySelector<HTMLElement>('[role="radio"]') ?? null;
const offered = () => (["off", "created", "all"] as const).filter(mode => choice(mode) !== null);
const chosen = () => offered().filter(mode => choice(mode)!.getAttribute("aria-checked") === "true");
const locked = () => offered().filter(mode => choice(mode)!.getAttribute("aria-disabled") === "true");
const reason = (mode: RemoteSessionAccessMode) => document.querySelector(`[data-testid="session-access-reason-${mode}"]`)?.textContent ?? null;
const unchosen = () => document.querySelector('[data-testid="session-access-unchosen"]')?.textContent ?? null;
async function choose(mode: RemoteSessionAccessMode) {
  await act(async () => { choice(mode)!.click(); await pause(); });
}
const reset = async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; };

test("everyone with the Devices page can turn their computer off: the choice needs no other feature, only the desktop app", async () => {
  const desktop = desktopSessionAccess({});
  const container = await render();
  expect(container.textContent).toContain(accessHeading);
  expect(offered()).toEqual(["off", "created"]);
  expect(container.textContent).toContain("Nothing");
  expect(container.textContent).toContain("Your other devices, Workbot and agents can't start or reach anything on this computer.");
  expect(container.textContent).toContain("Start tasks here");
  expect(container.textContent).toContain("Your other devices, Workbot and agents working for you can start tasks here and follow, continue and answer the ones they started.");
  expect(container.textContent).not.toContain("Also open sessions I started here");
  expect(chosen()).toEqual(["created"]); expect(locked()).toEqual([]);
  expect(container.querySelectorAll('[data-testid="device-row"]').length).toBe(2);
  await choose("off");
  expect(desktop.writes).toEqual(["off"]);
  expect(chosen()).toEqual(["off"]);
  await reset();

  expect((await render({ enabled: false })).textContent).not.toContain(accessHeading);
  await reset();
  Reflect.set(window, "__OPENWORK_ELECTRON__", undefined);
  const web = await render({ sessionAccess: true });
  expect(web.textContent).not.toContain(accessHeading);
  expect(web.querySelectorAll('[data-testid="device-row"]').length).toBe(2);
});
test("sessions started here are a third choice where the organization offers it, or when already chosen", async () => {
  desktopSessionAccess({});
  const container = await render({ sessionAccess: true });
  expect(offered()).toEqual(["off", "created", "all"]);
  expect(container.textContent).toContain("Also open sessions I started here");
  expect(container.textContent).toContain("They can also open sessions you started on this computer, continue them, stop them and answer their questions and permission requests.");
  expect(chosen()).toEqual(["created"]); expect(locked()).toEqual([]);
  expect(reason("created")).toBeNull(); expect(reason("all")).toBeNull(); expect(unchosen()).toBeNull();
  await reset();

  // The feature went away after the owner chose it: the choice is still shown, so it can be narrowed.
  const desktop = desktopSessionAccess({ mode: "all", supported: false });
  await render();
  expect(offered()).toEqual(["off", "created", "all"]);
  expect(chosen()).toEqual(["all"]);
  expect(reason("all")).toBe("Not in effect. Sign in again or update OpenWork to use this.");
  await choose("created");
  expect(desktop.writes).toEqual(["created"]);
  expect(offered()).toEqual(["off", "created"]);
});
test("a computer whose owner has not chosen shows what applies and says so", async () => {
  // The organization's opt-in: nothing reaches it until its owner allows it.
  const optIn = desktopSessionAccess({ mode: null, optIn: true });
  await render();
  expect(chosen()).toEqual(["off"]); expect(locked()).toEqual([]);
  expect(unchosen()).toBe("You haven't allowed this computer yet, so nothing reaches it.");
  await choose("created");
  expect(optIn.writes).toEqual(["created"]);
  expect(chosen()).toEqual(["created"]); expect(unchosen()).toBeNull();
  await reset();

  // Without it, as before the choice existed.
  const before = desktopSessionAccess({ mode: null });
  await render();
  expect(chosen()).toEqual(["created"]);
  expect(unchosen()).toBe("You haven't chosen. Tasks started from your other devices are allowed, as before.");
  // Selecting what already applies makes it the owner's choice.
  await choose("created");
  expect(before.writes).toEqual(["created"]);
  expect(unchosen()).toBeNull();
  await reset();

  const keptOff = desktopSessionAccess({ mode: null, optIn: true });
  await render();
  await choose("off");
  expect(keptOff.writes).toEqual(["off"]);
  expect(chosen()).toEqual(["off"]); expect(unchosen()).toBeNull();
  await reset();

  // The organization has turned it off: that is the reason, not the missing choice.
  desktopSessionAccess({ mode: null, ceiling: "off" });
  await render();
  expect(chosen()).toEqual(["off"]); expect(unchosen()).toBeNull();
  expect(reason("created")).toBe("Your organization has turned this off.");
});
test("a choice the organization or this computer's connection does not allow is shown locked, with the reason once", async () => {
  for (const [state, lockedChoices, reasons] of [
    [{ ceiling: "off" }, ["created", "all"], { created: "Not in effect. Your organization has turned this off." }],
    [{ mode: "off", ceiling: "off" }, ["created", "all"], { created: "Your organization has turned this off." }],
    [{ mode: "all", ceiling: "off" }, ["created", "all"], { created: "Your organization has turned this off.", all: "Not in effect. Your organization has turned this off." }],
    [{ ceiling: "created" }, ["all"], { all: "Your organization only allows tasks started remotely." }],
    [{ mode: "all", ceiling: "created" }, ["all"], { all: "Not in effect. Your organization only allows tasks started remotely." }],
    [{ ceiling: null }, ["all"], { all: "Available once this computer is connected to your organization." }],
    [{ ceiling: null, supported: false }, ["all"], { all: "Sign in again or update OpenWork to use this." }],
    [{ supported: false }, ["all"], { all: "Sign in again or update OpenWork to use this." }],
    [notConnected, ["off", "created", "all"], { off: "Available once this computer is connected to your organization." }],
  ] as const) {
    const desktop = desktopSessionAccess(state);
    await render({ sessionAccess: true });
    const label = JSON.stringify(state);
    expect(locked(), label).toEqual([...lockedChoices]);
    for (const mode of ["off", "created", "all"] as const) expect(reason(mode), `${label} ${mode}`).toBe((reasons as Partial<Record<RemoteSessionAccessMode, string>>)[mode] ?? null);
    expect(chosen(), label).toEqual(desktop.state.connected ? [desktop.state.mode ?? desktop.state.effective] : []);
    // A locked choice is explained, not alarming, and cannot be picked.
    expect(document.querySelector('[role="alert"]'), label).toBeNull();
    for (const element of document.querySelectorAll('[data-testid^="session-access-reason-"]')) expect(element.className, label).not.toContain("destructive");
    for (const mode of lockedChoices) await choose(mode);
    expect(desktop.writes, label).toEqual([]);
    expect(document.body.textContent, label).not.toContain("Allow all sessions");
    await reset();
  }
});
test("a stored choice the organization no longer allows can still be narrowed", async () => {
  const desktop = desktopSessionAccess({ mode: "all", ceiling: "created" });
  await render({ sessionAccess: true });
  expect(chosen()).toEqual(["all"]);
  await choose("created");
  expect(desktop.writes).toEqual(["created"]);
  expect(chosen()).toEqual(["created"]);
  expect(reason("all")).toBe("Your organization only allows tasks started remotely.");
  await choose("off");
  expect(desktop.writes).toEqual(["created", "off"]);
  expect(chosen()).toEqual(["off"]);
});
test("only opening sessions started here asks for confirmation; the other two apply at once", async () => {
  const desktop = desktopSessionAccess({});
  await render({ sessionAccess: true });
  await choose("off");
  expect(desktop.writes).toEqual(["off"]); expect(chosen()).toEqual(["off"]);
  expect(document.body.textContent).not.toContain("Allow all sessions");
  await choose("created");
  expect(desktop.writes).toEqual(["off", "created"]); expect(chosen()).toEqual(["created"]);
  expect(document.body.textContent).not.toContain("Allow all sessions");

  await choose("all");
  expect(desktop.writes).toEqual(["off", "created"]);
  expect(document.body.textContent).toContain("will be able to open any session on this computer");
  expect(document.body.textContent).toContain("You can turn this off here at any time.");
  await click("Cancel");
  expect(desktop.writes).toEqual(["off", "created"]); expect(chosen()).toEqual(["created"]);
  await choose("all"); await click("Allow all sessions");
  expect(desktop.writes).toEqual(["off", "created", "all"]);
  const reads = desktop.reads;
  expect(reads).toBeGreaterThan(1);
  expect(chosen()).toEqual(["all"]); expect(reason("all")).toBeNull();
  await choose("created");
  expect(desktop.writes).toEqual(["off", "created", "all", "created"]);
  expect(desktop.reads).toBeGreaterThan(reads);
  expect(chosen()).toEqual(["created"]);
  expect(document.body.textContent).not.toContain("Allow all sessions");
});
test("a choice that could not be saved says so and shows what this computer still has", async () => {
  const desktop = desktopSessionAccess({ mode: "all" }, { failWrites: true });
  await render({ sessionAccess: true });
  await choose("off");
  expect(desktop.writes).toEqual(["off"]);
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("Couldn't change this. Try again.");
  expect(chosen()).toEqual(["all"]);
});
test("signed out, the choices are shown locked: a choice belongs to an organization", async () => {
  const desktop = desktopSessionAccess(notConnected);
  const container = await render({ ready: false });
  expect(container.textContent).toContain("Cloud account"); expect(calls).toHaveLength(0);
  expect(container.textContent).toContain(accessHeading);
  expect(offered()).toEqual(["off", "created"]);
  expect(locked()).toEqual(["off", "created"]); expect(chosen()).toEqual([]);
  expect(reason("off")).toBe("Available once this computer is connected to your organization.");
  expect(unchosen()).toBeNull();
  await choose("off");
  expect(desktop.writes).toEqual([]);
});
