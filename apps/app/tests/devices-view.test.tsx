/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";
import { remoteDeviceSchema } from "@openwork/types/den/remote-devices";
import type { ListedComputer } from "@openwork/types/den/computers";
import type { AutomationsDenContext } from "../src/react-app/domains/automations/use-automations";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createDenClient } = await import("../src/app/lib/den");
const { DevicesContent } = await import("../src/react-app/domains/settings/pages/devices-view");
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
});

afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  if (ownedDom) await GlobalRegistrator.unregister();
});

type RequestEntry = { method: string; path: string; body: unknown };
async function renderDevices({ enabled, computer = existing, rejectRename = false, rejectAccess = false }: {
  enabled: boolean; computer?: ListedComputer; rejectRename?: boolean; rejectAccess?: boolean;
}) {
  const requests: RequestEntry[] = [];
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname.replace(/^\/api\/den/, "");
    const body = request.body ? await request.json() : null;
    requests.push({ method: request.method, path, body });
    if (path === "/v1/remote-devices") return Response.json({ devices });
    if (path === "/v1/computers") return Response.json({ computers: [computer] });
    if (path === "/v1/remote-devices/build" && request.method === "PATCH") return rejectRename
      ? Response.json({ error: "name_taken", message: "You already have a computer called that. Pick another name." }, { status: 409 })
      : Response.json({ device: body && typeof body === "object" ? { ...vm, ...body } : vm });
    if (path === "/v1/computers/build/access" && request.method === "PUT") return rejectAccess
      ? Response.json({ error: "not_configurable", message: "That computer can't be configured here." }, { status: 409 })
      : Response.json({ computer: { ...computer, access: { folders: [], ...body } } });
    throw new Error(`Unexpected request: ${request.method} ${path}`);
  }, { preconnect: realFetch.preconnect });
  await act(async () => root.render(<QueryClientProvider client={queryClient}><DevicesContent context={context} computersEnabled={enabled} /></QueryClientProvider>));
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
  expect(control("#device-access-risk").textContent).toContain("access files outside the working folder");
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
  expect(toggle.getAttribute("aria-describedby")).toBe("device-access-risk device-access-locked");
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
