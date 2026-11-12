/** @jsxImportSource react */
import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";

const ownedDom = !GlobalRegistrator.isRegistered && typeof document === "undefined";
let createRoot: typeof import("react-dom/client")["createRoot"];
let AccountStatusMenu: typeof import("../src/react-app/domains/session/sidebar/account-status-menu")["AccountStatusMenu"];
let ShellConfigProvider: typeof import("../src/react-app/shell/shell-config")["ShellConfigProvider"];
let root: Root | null = null;
let host: HTMLDivElement;
let previousAct: unknown;
let controlSettingsBlocked = false;

// Keep the router, menu primitives, status resolution, and shell config real.
// Only replace context hooks that require the desktop/cloud application shell.
mock.module("../src/react-app/domains/cloud/den-auth-provider", () => ({
  useDenAuth: () => ({
    isSignedIn: true,
    status: "signed-in",
    user: { id: "test-user", name: "Test User", email: "test@example.com" },
    verifiedIdentity: null,
  }),
  isDenSessionRestoring: () => false,
}));
mock.module("../src/react-app/kernel/platform", () => ({
  usePlatform: () => ({ openLink: () => {} }),
}));
mock.module("../src/react-app/shell/control/control-provider", () => ({
  useControlAction: () => {},
}));
mock.module("../src/react-app/domains/cloud/desktop-config-provider", () => ({
  useDesktopRestriction: (key: string) => key === "allowControlSettings" && controlSettingsBlocked,
}));
mock.module("../src/react-app/domains/cloud/use-gateway-usage", () => ({
  useGatewayUsage: () => ({ authorized: false }),
}));

beforeAll(async () => {
  if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
  createRoot = (await import("react-dom/client")).createRoot;
  AccountStatusMenu = (await import("../src/react-app/domains/session/sidebar/account-status-menu")).AccountStatusMenu;
  ShellConfigProvider = (await import("../src/react-app/shell/shell-config")).ShellConfigProvider;
});
afterAll(async () => { if (ownedDom) await GlobalRegistrator.unregister(); });
beforeEach(() => {
  previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  controlSettingsBlocked = false;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host.remove();
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
});

function LocationProbe() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

async function openMenu(developerMode: boolean) {
  await act(async () => root?.render(
    <MemoryRouter initialEntries={["/workspace/test/session/test"]}>
      <ShellConfigProvider>
        <AccountStatusMenu
          clientConnected
          openworkServerStatus="connected"
          developerMode={developerMode}
          showConnectionStatus
          providerConnectedIds={["openwork"]}
          mcpConnectedCount={0}
          openWorkConnectState={{ status: "failed", issue: null, attempt: 1, maxAttempts: 1 }}
        />
        <LocationProbe />
      </ShellConfigProvider>
    </MemoryRouter>,
  ));
  const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Account menu"]');
  expect(trigger).not.toBeNull();
  await act(async () => { trigger?.click(); });
  const menu = document.querySelector('[role="menu"]');
  expect(menu).not.toBeNull();
  expect(menu?.textContent).toContain("OpenWork Connect: Needs attention");
  return menu;
}

function diagnosticsAction() {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find(item => item.textContent?.trim() === "Run diagnostics");
}

test.each([
  [false, "/settings/advanced/agent-access"],
  [true, "/settings/debug"],
] satisfies [boolean, string][])("Run diagnostics with developerMode=%s navigates to %s", async (developerMode, destination) => {
  await openMenu(developerMode);
  const action = diagnosticsAction();
  expect(action).toBeDefined();
  await act(async () => { action?.click(); });
  expect(host.querySelector('[data-testid="location"]')?.textContent).toBe(destination);
});

test.each([false, true])("allowControlSettings restriction hides Run diagnostics with developerMode=%s", async (developerMode) => {
  controlSettingsBlocked = true;
  const menu = await openMenu(developerMode);
  expect(diagnosticsAction()).toBeUndefined();
  expect(menu?.textContent).toContain("Account");
  expect(host.querySelector('[data-testid="location"]')?.textContent).toBe("/workspace/test/session/test");
});
