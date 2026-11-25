/** @jsxImportSource react */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { SettingsUpdateStatus } from "../src/react-app/domains/settings/state/electron-updater-state";

GlobalRegistrator.register({ url: "http://localhost/" });
afterAll(async () => { await GlobalRegistrator.unregister(); });
const { createRoot } = await import("react-dom/client");

let status: SettingsUpdateStatus = null;
let installs = 0;
let downloads = 0;
mock.module("../src/react-app/kernel/local-provider", () => ({
  useLocal: () => ({ prefs: {}, setPrefs: () => {} }),
}));
mock.module("../src/react-app/domains/cloud/desktop-config-provider", () => ({
  useDesktopConfig: () => ({ loading: false, config: {}, refreshFresh: async () => ({}) }),
}));
mock.module("../src/react-app/domains/cloud/enterprise-activation-gate", () => ({
  useEnterpriseActivationRequired: () => false,
}));
mock.module("../src/react-app/domains/cloud/brand-theme", () => ({ useBrandAppName: () => "OpenWork" }));
mock.module("../src/react-app/shell/notifications", () => ({ notifyAlert: () => {} }));
// An unrelated rollout must not make Restart appear before the build is staged.
mock.module("../src/react-app/domains/session/status/use-desktop-feature", () => ({ useDesktopFeature: () => true }));
mock.module("../src/react-app/domains/settings/state/electron-updater-state", () => ({
  useElectronUpdaterState: () => ({
    appVersion: "0.18.0",
    updateEnv: { supported: true },
    updateStatus: status,
    checkForUpdates: async () => {},
    downloadUpdate: async () => { downloads += 1; },
    installUpdateAndRestart: async () => { installs += 1; },
    setReleaseChannel: async () => {},
  }),
}));
const { DesktopUpdaterProvider, DesktopUpdateButton } = await import("../src/react-app/domains/settings/state/desktop-updater-provider");

describe("titlebar staged-update restart", () => {
  let root: ReturnType<typeof createRoot>;
  let host: HTMLDivElement;
  async function render() {
    await act(async () => { root.render(<DesktopUpdaterProvider><DesktopUpdateButton /></DesktopUpdaterProvider>); });
  }
  async function click(label: string) {
    const button = Array.from(document.querySelectorAll("button")).find((node) => node.textContent === label);
    if (!button) throw new Error(`Missing button: ${label}`);
    await act(async () => { button.click(); });
  }
  beforeEach(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    status = null;
    installs = 0;
    downloads = 0;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    localStorage.clear();
  });

  test.each(["idle", "checking", "available", "blocked", "downloading", "error"] satisfies NonNullable<SettingsUpdateStatus>["state"][])("does not offer a restart while %s", async (state) => {
    status = { state, version: "0.18.5" };
    await render();
    expect(host.querySelector("[data-update-button]") !== null).toBe(false);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(downloads).toBe(0);
    expect(installs).toBe(0);
  });

  test("only restarts a staged build after confirmation, without a download window", async () => {
    status = { state: "ready", version: "0.18.5" };
    await render();
    expect(host.querySelector("[data-update-button]")).not.toBeNull();
    await click("Restart to update");
    expect(document.body.textContent).toContain("Restart OpenWork?");
    expect(installs).toBe(0);
    await click("Restart & update");
    expect(installs).toBe(1);
    expect(downloads).toBe(0);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });

  test("Keep working leaves the staged update alone", async () => {
    status = { state: "ready", version: "0.18.5" };
    await render();
    await click("Restart to update");
    await click("Keep working");
    expect(installs).toBe(0);
    expect(downloads).toBe(0);
    expect(host.querySelector("[data-update-button]")).not.toBeNull();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });
});
