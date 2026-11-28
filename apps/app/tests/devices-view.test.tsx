/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";
import { remoteDeviceSchema } from "@openwork/types/den/remote-devices";
import type { ListedComputer } from "@openwork/types/den/computers";
import { computerSharingSettingsSchema, DEFAULT_COMPUTER_SHARING_SETTINGS, type ComputerSharingState } from "@openwork/types/computer-sharing";
import type { AutomationsDenContext } from "../src/react-app/domains/automations/use-automations";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createDenClient } = await import("../src/app/lib/den");
const { DevicesContent } = await import("../src/react-app/domains/settings/pages/devices-view");
const { ComputerSharingSection } = await import("../src/react-app/domains/devices/computer-sharing-section");
const previousDesktop = Reflect.get(window, "__OPENWORK_ELECTRON__");
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const realFetch = globalThis.fetch;
const context: AutomationsDenContext = {
  client: createDenClient({ baseUrl: "https://den.example.test", token: "test-token" }),
  organizationId: "test-org", ready: true, queryRoot: ["den", "automations", "test-org"],
};
const stamp = "2026-11-26T12:00:00.000Z";
const vm = remoteDeviceSchema.parse({
  id: "build", kind: "vm", provider: "daytona", source: "manual", platform: "linux",
  label: "Build box", access: "mine", availability: "unknown", state: "unknown", statusDetail: null,
  lastSeenAt: null, createdAt: stamp, appVersion: null, computerId: null, workbotChat: null,
  canRename: true, canRemove: true,
});
const devices = [vm,
  { ...vm, id: "ready", label: "Sam", availability: "online" },
  { ...vm, id: "paused", label: "Paused box", provider: "workbot", source: "workbot", availability: "paused" },
  { ...vm, id: "problem", label: "Offline box", availability: "offline" },
  { ...vm, id: "setup", label: "Setup box", availability: "needs_setup" },
  { ...vm, id: "desktop", label: "Ada", kind: "desktop", platform: "darwin", provider: "openwork_desktop", source: "desktop_app", availability: "offline", lastSeenAt: stamp },
  { ...vm, id: "shared", label: "Shared box", access: "shared" },
];
const existing: ListedComputer = {
  id: vm.id, kind: "registered_vm", provider: vm.provider, label: vm.label, ownerMemberId: "test-member",
  availability: "unknown", state: "starts_when_needed", lastSeenAt: null,
  access: { choice: "allow", scope: "whole_vm", folders: ["/workspace/build"] },
  reach: { outcome: "allow", route: "checked", scope: { surface: "whole_vm", folders: ["/workspace/build"] } },
};

let queryClient: InstanceType<typeof QueryClient>;
let container: HTMLElement;
let root: Root;

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  queryClient.clear();
  globalThis.fetch = realFetch;
  if (previousDesktop === undefined) Reflect.deleteProperty(window, "__OPENWORK_ELECTRON__");
  else Reflect.set(window, "__OPENWORK_ELECTRON__", previousDesktop);
});

afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  if (ownedDom) await GlobalRegistrator.unregister();
});

type RequestEntry = { method: string; path: string; body: unknown };
type SharingFixture = { state: ComputerSharingState; folder?: string; refusal?: { error: string } | { message: string }; devices?: typeof devices; beforeWrite?: () => Promise<void> };
const sharingState = (): ComputerSharingState => ({
  settings: DEFAULT_COMPUTER_SHARING_SETTINGS, availability: { state: "available" },
  organizationAllows: true, revokedSources: [], sync: "synced",
});
async function renderDevices({ enabled, computer = existing, rejectRename = false, rejectAccess = false, sharing }: {
  enabled: boolean; computer?: ListedComputer; rejectRename?: boolean; rejectAccess?: boolean; sharing?: SharingFixture;
}) {
  const requests: RequestEntry[] = [];
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname.replace(/^\/api\/den/, "");
    const body = request.body ? await request.json() : null;
    requests.push({ method: request.method, path, body });
    if (path === "/v1/remote-devices") return Response.json({ devices: sharing?.devices ?? devices });
    if (path === "/computers/sharing" && sharing) {
      expect(request.headers.get("X-OpenWork-Host-Token")).toBe("test-host");
      if (request.method === "PUT") {
        await sharing.beforeWrite?.();
        if (sharing.refusal) return Response.json(sharing.refusal, { status: 400 });
        sharing.state = { ...sharing.state, settings: computerSharingSettingsSchema.parse(body) };
      }
      return Response.json(sharing.state);
    }
    if (path === "/v1/computers") return Response.json({ computers: [computer] });
    const renamed = devices.find(device => path === `/v1/remote-devices/${device.id}`);
    if (renamed && request.method === "PATCH") return rejectRename
      ? Response.json({ error: "name_taken", message: "You already have a computer called that. Pick another name." }, { status: 409 })
      : Response.json({ device: body && typeof body === "object" ? { ...renamed, ...body } : renamed });
    if (path === "/v1/computers/build/access" && request.method === "PUT") return rejectAccess
      ? Response.json({ error: "not_configurable", message: "That computer can't be configured here." }, { status: 409 })
      : Response.json({ computer: { ...computer, access: { folders: [], ...body } } });
    throw new Error(`Unexpected request: ${request.method} ${path}`);
  }, { preconnect: realFetch.preconnect });
  if (sharing) Reflect.set(window, "__OPENWORK_ELECTRON__", { invokeDesktop: async (command: string, url?: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
    if (command === "openworkServerInfo") return { running: true, baseUrl: "http://127.0.0.1:4567", generation: 1, hostToken: "test-host" };
    if (command === "pickDirectory") return sharing.folder ?? null;
    if (command === "__cancelTransfer") return;
    if (command === "__fetch" && url) {
      const response = await globalThis.fetch(url, init);
      return { status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers), body: await response.text() };
    }
    throw new Error(`Unexpected desktop call: ${command}`);
  } });
  await act(async () => root.render(<QueryClientProvider client={queryClient}><DevicesContent context={context} computersEnabled={enabled} SharingSection={ComputerSharingSection} /></QueryClientProvider>));
  await until(() => document.querySelector('[data-testid="device-row"]') !== null);
  return requests;
}

async function until(done: () => boolean) {
  for (let attempt = 0; attempt < 20 && !done(); attempt++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  }
  if (!done()) throw new Error(`Expected UI state not reached: ${document.body.textContent}`);
}

function control(selector: string) {
  const element = document.querySelector(selector);
  if (!(element instanceof HTMLElement)) throw new Error(`Missing ${selector}`);
  return element;
}

function textControl(selector: string) {
  const element = control(selector);
  if (!(element instanceof HTMLInputElement)) throw new Error(`Expected input ${selector}`);
  return element;
}

async function edit(menuItem: string, label = "Build box") {
  await act(async () => control(`button[aria-label="Manage ${label}"]`).click());
  await act(async () => {
    const item = [...document.querySelectorAll('[role="menuitem"]')].find(element => element.textContent === menuItem);
    if (!(item instanceof HTMLElement)) throw new Error(`No ${menuItem} menu item`);
    item.click();
  });
  await until(() => document.querySelector('[role="dialog"]') !== null);
}

async function enter(selector: string, value: string) {
  const input = textControl(selector);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function save() {
  await act(async () => control('[role="dialog"] button[type="submit"]').click());
}

function state(label: string) {
  return [...container.querySelectorAll('[data-testid="device-row"]')]
    .find(row => row.querySelector("button")?.getAttribute("aria-label") === `Manage ${label}`)
    ?.querySelector('[role="status"]')?.textContent;
}

const writes = (requests: RequestEntry[]) => requests.filter(({ method }) => method !== "GET");

test("feature off keeps the legacy states and rename dialog without asking for computer access", async () => {
  const requests = await renderDevices({ enabled: false });
  expect(state("Build box")).toBe("Not checked yet");
  expect(state("Sam")).toBe("Online");
  expect(state("Offline box")).toBe("Offline");
  await edit("Rename");
  expect(control('[role="dialog"]').textContent).toContain("Rename computer");
  expect(document.querySelector('[role="switch"]')).toBeNull();
  expect(document.querySelector("#device-folder")).toBeNull();
  await save();
  await until(() => document.querySelector('[role="dialog"]') === null);
  expect(requests.some(({ path }) => path.startsWith("/v1/computers"))).toBe(false);
  expect(writes(requests)).toEqual([{ method: "PATCH", path: "/v1/remote-devices/build", body: { label: "Build box" } }]);
});

test("feature on uses the three cloud states and leaves desktop status and last report as they were", async () => {
  const requests = await renderDevices({ enabled: true });
  await until(() => state("Sam") === "Ready");
  expect(state("Build box")).toBe("Starts when needed");
  expect(state("Paused box")).toBe("Starts when needed");
  expect(state("Offline box")).toBe("Has a problem");
  expect(state("Setup box")).toBe("Has a problem");
  expect(state("Ada")).toBe("Offline");
  expect(container.querySelector("time")?.dateTime).toBe(stamp);
  await edit("Rename", "Ada");
  expect(document.querySelector('[role="switch"]')).toBeNull();
  expect(requests.some(({ path }) => path.startsWith("/v1/computers"))).toBe(false);
});

function accessButton() {
  const button = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(element => element.textContent === "Save access");
  if (!button) throw new Error("Missing Save access");
  return button;
}

async function saveAccess() {
  await act(async () => accessButton().click());
}

test("saving a name never saves or resets access, even with an unsaved revocation", async () => {
  const requests = await renderDevices({ enabled: true });
  await edit("Edit");
  await until(() => document.querySelector("#device-folder") !== null);
  expect(control('[role="switch"]').getAttribute("aria-checked")).toBe("true");
  expect(textControl("#device-folder").value).toBe("/workspace/build");
  expect(accessButton().disabled).toBe(true);
  await act(async () => control('[role="switch"]').click());
  expect(accessButton().disabled).toBe(false);
  await enter("#device-label", "Sam's build box");
  await save();
  await until(() => document.querySelector('[role="dialog"]') === null);
  expect(writes(requests)).toEqual([{ method: "PATCH", path: "/v1/remote-devices/build", body: { label: "Sam's build box" } }]);
});

const legacy: ListedComputer = { ...existing, access: { choice: "allow", folders: ["/workspace/legacy"] },
  reach: { outcome: "allow", route: "checked", scope: { surface: "sandbox", folders: ["/workspace/legacy"] } } };

test("legacy access starts off; opting in and saving sends an explicit whole-computer grant", async () => {
  const requests = await renderDevices({ enabled: true, computer: legacy });
  await edit("Edit");
  await until(() => document.querySelector("#device-folder") !== null);
  expect(control('[role="switch"]').getAttribute("aria-checked")).toBe("false");
  expect(textControl("#device-folder").value).toBe("/workspace");
  expect(control('[role="dialog"]').textContent).not.toContain("access files outside the working folder");
  const detail = control('button[aria-label="Whole-computer access details"]');
  await act(async () => detail.focus());
  await until(() => Boolean(document.querySelector('[data-slot="tooltip-content"]')?.textContent?.includes("access files outside the working folder")));
  expect(accessButton().disabled).toBe(true);
  await act(async () => control('[role="switch"]').click());
  await enter("#device-folder", "/workspace/new");
  expect(writes(requests)).toEqual([]);
  await saveAccess();
  await until(() => writes(requests).length > 0 && accessButton().disabled);
  expect(writes(requests)).toEqual([{ method: "PUT", path: "/v1/computers/build/access", body: { choice: "allow", scope: "whole_vm", folders: ["/workspace/new"] } }]);
});

test("an unconfigured computer defaults to off; an invalid folder blocks only access changes", async () => {
  const requests = await renderDevices({ enabled: true, computer: { ...existing, access: { choice: null, folders: [] } } });
  await edit("Edit");
  await until(() => document.querySelector("#device-folder") !== null);
  expect(control('[role="switch"]').getAttribute("aria-checked")).toBe("false");
  await act(async () => control('[role="switch"]').click());
  await enter("#device-folder", "workspace");
  await saveAccess();
  expect(control('[role="dialog"] [role="alert"]').textContent).toBe("Enter a full folder path, such as /workspace.");
  expect(writes(requests)).toEqual([]);
  await save();
  await until(() => document.querySelector('[role="dialog"]') === null);
  expect(writes(requests).map(({ method }) => method)).toEqual(["PATCH"]);
});

test("an organization refusal locks access without blocking a rename", async () => {
  const requests = await renderDevices({ enabled: true, computer: { ...existing, reach: {
    outcome: "refuse", layer: "organization", code: "organization_off", changeableBy: "organization_admin", message: "Off for this organization.",
  } } });
  await edit("Edit");
  await until(() => document.querySelector("#device-folder") !== null);
  const toggle = control('[role="switch"]');
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(toggle.hasAttribute("data-disabled")).toBe(true);
  expect(toggle.getAttribute("aria-describedby")).toBe("device-access-locked");
  const reason = control("#device-access-locked");
  expect(reason.textContent).toBe("Your organization has turned this off. An organization admin can change it.");
  expect(reason.classList.contains("text-muted-foreground")).toBe(true);
  expect(reason.querySelector("svg")).not.toBeNull();
  expect(textControl("#device-folder").disabled).toBe(true);
  await save();
  await until(() => document.querySelector('[role="dialog"]') === null);
  expect(writes(requests).map(({ method }) => method)).toEqual(["PATCH"]);
});

test("a name conflict shows Den's sentence inline and does not save or clear the access draft", async () => {
  const requests = await renderDevices({ enabled: true, rejectRename: true });
  await edit("Edit");
  await until(() => document.querySelector("#device-folder") !== null);
  await enter("#device-label", "Sam");
  await enter("#device-folder", "/workspace/sam");
  await save();
  await until(() => document.querySelector('[role="dialog"] [role="alert"]') !== null);
  expect(control('[role="dialog"] [role="alert"]').textContent).toBe("You already have a computer called that. Pick another name.");
  expect(textControl("#device-label").value).toBe("Sam");
  expect(textControl("#device-folder").value).toBe("/workspace/sam");
  expect(writes(requests).map(({ method }) => method)).toEqual(["PATCH"]);
});

test("an access conflict leaves the dialog and both drafts in place without saving the name", async () => {
  const requests = await renderDevices({ enabled: true, rejectAccess: true });
  await edit("Edit");
  await until(() => document.querySelector("#device-folder") !== null);
  await enter("#device-folder", "/workspace/sam");
  await enter("#device-label", "Sam's build box");
  await act(async () => control('[role="switch"]').click());
  await saveAccess();
  await until(() => document.querySelector('[role="dialog"] [role="alert"]') !== null);
  expect(control('[role="dialog"] [role="alert"]').textContent).toBe("That computer can't be configured here.");
  expect(textControl("#device-label").value).toBe("Sam's build box");
  expect(textControl("#device-folder").value).toBe("/workspace/sam");
  expect(control('[role="switch"]').getAttribute("aria-checked")).toBe("false");
  expect(writes(requests).map(({ method }) => method)).toEqual(["PUT"]);
});

const optIn = '[role="switch"][aria-label="Let my other computers run code here (in the sandbox)"]';
const sharingHeading = "Run code from my other computers";
const source = (name: string) => `[role="switch"][aria-label="${name}"]`;
const toggleSharing = (selector: string) => act(async () => control(selector).click());
const settled = () => !control(optIn).hasAttribute("data-disabled");
const sharingWrites = (requests: RequestEntry[]) => writes(requests).filter(({ path }) => path === "/computers/sharing").map(({ body }) => body);
const studio = remoteDeviceSchema.parse({ ...vm, id: "studio", kind: "desktop", provider: "openwork_desktop", source: "desktop_app", platform: "darwin", availability: "online", label: "Studio Mac" });
const travel = { ...studio, id: "travel", label: "Studio Mac (2)", availability: "offline", lastSeenAt: stamp };

function buttonWithText(label: string) {
  const button = [...document.querySelectorAll("button")].find(element => element.textContent === label);
  if (!button) throw new Error(`Missing ${label}`);
  return button;
}

test("computers flag off never reads local sharing on a desktop", async () => {
  const requests = await renderDevices({ enabled: false, sharing: { state: sharingState() } });
  expect(container.textContent).not.toContain(sharingHeading);
  expect(requests.map(({ path }) => path)).toEqual(["/v1/remote-devices"]);
});

test("full sharing polling stops when Devices unmounts", async () => {
  const intervals = spyOn(globalThis, "setInterval");
  const clears = spyOn(globalThis, "clearInterval");
  try {
    await renderDevices({ enabled: true, sharing: { state: sharingState() } });
    await until(() => document.querySelector(optIn) !== null);
    const query = queryClient.getQueryCache().findAll({ queryKey: ["openwork-server", "computer-sharing"] })[0];
    expect(query?.getObserversCount()).toBe(1);
    const index = intervals.mock.calls.findLastIndex(([, delay]) => delay === 5_000);
    expect(index).toBeGreaterThanOrEqual(0);
    const timer = intervals.mock.results[index]?.value;
    clears.mockClear();
    await act(async () => root.render(null));
    expect(query?.getObserversCount()).toBe(0);
    expect(clears).toHaveBeenCalledWith(timer);
  } finally {
    intervals.mockRestore();
    clears.mockRestore();
  }
});

test("unavailable sharing shows the server's sentence instead of a switch", async () => {
  const message = "This computer can't run the OpenWork sandbox.";
  await renderDevices({ enabled: true, sharing: { state: { ...sharingState(), availability: { state: "unavailable", reason: "unsupported_platform", message } } } });
  await until(() => Boolean(container.textContent?.includes(message)));
  expect(container.textContent).toContain(sharingHeading);
  expect(document.querySelector(optIn)).toBeNull();
});

test("organization policy keeps the sharing choice visible but locked", async () => {
  const initial = sharingState();
  const requests = await renderDevices({ enabled: true, sharing: { state: { ...initial, organizationAllows: false, settings: { ...initial.settings, enabled: true } } } });
  await until(() => document.querySelector(optIn) !== null);
  const toggle = control(optIn);
  const note = document.getElementById(toggle.getAttribute("aria-describedby") ?? "");
  expect(toggle.hasAttribute("data-disabled")).toBe(true);
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(note?.textContent).toBe("Your admin turned this off for the organization");
  expect(note?.querySelector("svg")).not.toBeNull();
  expect(note?.classList.contains("text-muted-foreground")).toBe(true);
  await toggleSharing(optIn);
  expect(sharingWrites(requests)).toEqual([]);
});

test("turn on sharing, add a read-only folder, allow edits, then stop sharing the folder", async () => {
  const path = "/Users/test/project";
  const requests = await renderDevices({ enabled: true, sharing: { state: sharingState(), folder: path } });
  await until(() => document.querySelector(optIn) !== null);
  expect(control(optIn).getAttribute("aria-checked")).toBe("false");
  await toggleSharing(optIn);
  await until(() => settled() && control(optIn).getAttribute("aria-checked") === "true");
  expect(container.textContent).toContain("On, but nothing is shared yet");
  expect(container.textContent).toContain("No folders shared. Work from another computer has nothing to open.");
  await act(async () => buttonWithText("Share a folder").click());
  await until(() => settled() && document.querySelector(`[title="${path}"]`) !== null);
  const select = '[role="combobox"][aria-label="Access to project"]';
  expect(control(select).querySelector('[data-slot="select-value"]')?.textContent).toBe("Read-only");
  await toggleSharing(select);
  await until(() => document.querySelectorAll('[role="option"]').length === 2);
  const options = [...document.querySelectorAll('[role="option"]')];
  expect(options.map(element => element.textContent)).toEqual(["Read-only", "Can edit"]);
  const editOption = options.find(element => element.textContent === "Can edit");
  if (!(editOption instanceof HTMLElement)) throw new Error("Missing Can edit option");
  await act(async () => {
    editOption.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
    editOption.click();
  });
  await until(() => settled() && control(select).querySelector('[data-slot="select-value"]')?.textContent === "Can edit");
  await toggleSharing('button[aria-label="Stop sharing project"]');
  await until(() => settled() && document.querySelector(select) === null);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(sharingWrites(requests)).toEqual([
    { enabled: true, folders: [], sources: [] },
    { enabled: true, folders: [{ path, access: "read" }], sources: [] },
    { enabled: true, folders: [{ path, access: "edit" }], sources: [] },
    { enabled: true, folders: [], sources: [] },
  ]);
});

test("two similarly named computers stay distinct; grants and optimistic revoke use IDs", async () => {
  const initial = sharingState();
  const fixture: SharingFixture = { state: { ...initial, settings: { ...initial.settings, enabled: true } }, devices: [studio, travel] };
  const requests = await renderDevices({ enabled: true, sharing: fixture });
  await until(() => document.querySelector(source("Studio Mac (2)")) !== null);
  expect(control(source("Studio Mac")).getAttribute("aria-checked")).toBe("false");
  expect(control(source("Studio Mac (2)")).closest("li")?.textContent).toContain("Offline, last seen");
  await toggleSharing(source("Studio Mac (2)"));
  await until(settled);
  await toggleSharing(source("Workbot"));
  await until(settled);
  const pendingWrite = Promise.withResolvers<void>();
  fixture.beforeWrite = () => pendingWrite.promise;
  try {
    await toggleSharing(source("Studio Mac (2)"));
    expect(control(source("Studio Mac (2)")).getAttribute("aria-checked")).toBe("false");
    expect(fixture.state.settings.sources).toHaveLength(2);
  } finally {
    pendingWrite.resolve();
  }
  await until(settled);
  expect(sharingWrites(requests)).toEqual([
    { enabled: true, folders: [], sources: [{ kind: "computer", id: "travel" }] },
    { enabled: true, folders: [], sources: [{ kind: "computer", id: "travel" }, { kind: "workbot" }] },
    { enabled: true, folders: [], sources: [{ kind: "workbot" }] },
  ]);
});

test("a refreshed Den revoke locks the source; a removed computer can be removed locally", async () => {
  const initial = sharingState();
  const fixture: SharingFixture = {
    state: { ...initial, settings: { ...initial.settings, enabled: true, sources: [{ kind: "computer", id: "studio" }, { kind: "computer", id: "removed" }] } },
    devices: [studio],
  };
  const requests = await renderDevices({ enabled: true, sharing: fixture });
  await until(() => document.querySelector(source("Studio Mac")) !== null);
  expect(control(source("Studio Mac")).getAttribute("aria-checked")).toBe("true");
  fixture.state = { ...fixture.state, revokedSources: [{ source: { kind: "computer", id: "studio" }, revokedAt: stamp }] };
  await act(async () => queryClient.refetchQueries({ queryKey: ["openwork-server", "computer-sharing"] }));
  await until(() => control(source("Studio Mac")).getAttribute("aria-checked") === "false");
  const revoked = control(source("Studio Mac"));
  expect(revoked.hasAttribute("data-disabled")).toBe(true);
  expect(revoked.closest("li")?.textContent).toContain("Revoked in your organization's settings");
  expect(revoked.closest("li")?.textContent).toContain("Allow it again from My Computers.");
  expect(container.textContent).toContain("A removed computer");
  await act(async () => buttonWithText("Remove").click());
  await until(() => settled() && !container.textContent?.includes("A removed computer"));
  expect(sharingWrites(requests)).toEqual([{ enabled: true, folders: [], sources: [{ kind: "computer", id: "studio" }] }]);
});

test("folder validation shows the server's sentence inline and does not keep the optimistic folder", async () => {
  const initial = sharingState();
  const refusal = "Choose a folder that isn't already shared inside another folder.";
  await renderDevices({ enabled: true, sharing: {
    state: { ...initial, settings: { ...initial.settings, enabled: true } }, folder: "/Users/test/project/subfolder", refusal: { error: refusal }, devices: [studio],
  } });
  await until(() => document.querySelector(optIn) !== null);
  await act(async () => buttonWithText("Share a folder").click());
  await until(() => document.querySelector('[role="alert"]') !== null);
  expect(control('[role="alert"]').textContent).toBe(refusal);
  expect(document.querySelector('[aria-label="Stop sharing subfolder"]')).toBeNull();
});

test("a desktop rename keeps Den's name conflict inline without adding cloud access controls", async () => {
  const requests = await renderDevices({ enabled: true, rejectRename: true });
  await edit("Rename", "Ada");
  expect(document.querySelector('#device-folder')).toBeNull();
  await enter('#device-label', 'Studio Mac');
  await save();
  await until(() => document.querySelector('[role="dialog"] [role="alert"]') !== null);
  expect(control('[role="dialog"] [role="alert"]').textContent).toBe("You already have a computer called that. Pick another name.");
  expect(writes(requests)).toEqual([{ method: "PATCH", path: "/v1/remote-devices/desktop", body: { label: "Studio Mac" } }]);
  expect(requests.some(({ path }) => path === "/v1/computers")).toBe(false);
});
