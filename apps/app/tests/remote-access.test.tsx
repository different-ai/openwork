import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RemoteAccessStatus } from "@openwork/types/desktop-ipc";
// Base UI captures DOM availability when imported; initialize the DOM first.
GlobalRegistrator.register({ url: "http://localhost:5173/" });
const { RemoteAccessView } = await import(
  "../src/react-app/domains/settings/pages/remote-access-view"
);
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

let root: Root, client: QueryClient;
let calls: { command: string; args: unknown[] }[];
let state: RemoteAccessStatus;
beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  calls = [];
  state = {
    available: true,
    enabled: true,
    phase: "ready",
    errorCode: null,
    origin: "https://computer.example",
    devices: [],
    pending: [],
    workspaces: [
      { id: "one", name: "Project One" },
      { id: "two", name: "Project Two" },
    ],
  };
  Reflect.set(window, "__OPENWORK_ELECTRON__", {
    invokeDesktop: async (command: string, ...args: unknown[]) => {
      calls.push({ command, args });
      if (command === "remoteAccessStatus") return structuredClone(state);
      if (command === "remoteAccessApprove") {
        state.pending = [];
        return { approved: true };
      }
      if (command === "remoteAccessRevoke") {
        state.devices = [];
        return { revoked: true };
      }
      return {};
    },
  });
  const mount = document.createElement("div");
  document.body.append(mount);
  root = createRoot(mount);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
  document.body.innerHTML = "";
});
const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 20));
};
async function render() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <RemoteAccessView />
      </QueryClientProvider>,
    );
    await flush();
  });
  await act(flush);
}
function button(text: string) {
  const found = [...document.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === text,
  );
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}
async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
    await flush();
  });
}

test("pairing grants only selected projects unless future access is explicitly chosen", async () => {
  state.pending = [
    {
      id: "claim",
      deviceName: "Test phone",
      expiresAt: new Date(Date.now() + 300000).toISOString(),
    },
  ];
  await render();
  await click(button("Review access"));
  expect(button("Allow access").disabled).toBe(true);
  const project = [...document.querySelectorAll("label")].find(
    (label) => label.textContent?.trim() === "Project One",
  );
  if (!project) throw new Error("Missing project selection");
  await click(project);
  expect(button("Allow access").disabled).toBe(false);
  await click(button("Allow access"));
  expect(calls.find((c) => c.command === "remoteAccessApprove")?.args).toEqual([
    "claim",
    { workspaceIds: ["one"], allWorkspaces: false },
  ]);
});

test("all current and future projects is an unchecked opt-in", async () => {
  state.pending = [
    {
      id: "claim",
      deviceName: "Test phone",
      expiresAt: new Date(Date.now() + 300000).toISOString(),
    },
  ];
  await render();
  await click(button("Review access"));
  const future = [...document.querySelectorAll("label")].find((label) =>
    label.textContent?.includes("Allow all current and future projects"),
  );
  if (!future) throw new Error("Missing future-project selection");
  expect(
    future.querySelector('[role="checkbox"]')?.getAttribute("aria-checked"),
  ).toBe("false");
  await click(future);
  await click(button("Allow access"));
  expect(calls.find((c) => c.command === "remoteAccessApprove")?.args).toEqual([
    "claim",
    { workspaceIds: [], allWorkspaces: true },
  ]);
});

test("disabled feature remains visible, allows turning saved access off, and hides pairing", async () => {
  state.available = false;
  state.phase = "unavailable";
  await render();
  expect(document.body.textContent).toContain("administrator can enable");
  expect(document.body.textContent).not.toContain("Pair a phone");
  expect(
    document.querySelector('[role="switch"]')?.getAttribute("aria-disabled"),
  ).not.toBe("true");
});

test("disconnecting requires an explicit confirmation and sends the selected device only", async () => {
  state.devices = [
    {
      id: "phone",
      name: "Test phone",
      workspaceIds: ["one"],
      allWorkspaces: false,
      active: true,
    },
  ];
  await render();
  await click(button("Manage Test phone"));
  await click(button("Disconnect phone"));
  expect(calls.some((c) => c.command === "remoteAccessRevoke")).toBe(false);
  await click(button("Disconnect phone"));
  expect(calls.find((c) => c.command === "remoteAccessRevoke")?.args).toEqual([
    "phone",
  ]);
});
