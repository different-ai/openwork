import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import type { DenDesktopConfig } from "../src/app/lib/den";
import {
  useElectronUpdaterState,
  type SettingsUpdateStatus,
} from "../src/react-app/domains/settings/state/electron-updater-state";

const installedVersion = "0.18.0";
const downloadedVersion = "0.18.5";
const metadata = { minAppVersion: "0.1.0", latestAppVersion: downloadedVersion, publishedDesktopVersions: [downloadedVersion] };

type Updater = ReturnType<typeof useElectronUpdaterState>;

describe("install re-validates the organization's desktop version policy", () => {
  let root: ReturnType<typeof createRoot>;
  let updater: Updater;
  let statuses: SettingsUpdateStatus[];
  let installs: number;
  let refreshes: number;
  let refreshResult: () => Promise<DenDesktopConfig>;
  let downloadedConfig: DenDesktopConfig;
  const originalDev = process.env.DEV;

  // Stable callbacks, as the provider supplies them; new identities per render
  // would re-run the hook's mount effects forever.
  const onReleaseChannelChange = () => {};
  const setError = () => {};
  const refreshDesktopConfig = () => {
    refreshes += 1;
    return refreshResult();
  };

  function Harness(props: { desktopConfig: DenDesktopConfig }) {
    updater = useElectronUpdaterState({
      releaseChannel: "stable",
      onReleaseChannelChange,
      updateAutoCheck: false,
      updateAutoDownload: true,
      updatePolicyKnown: true,
      desktopConfig: props.desktopConfig,
      refreshDesktopConfig,
      setError,
    });
    statuses.push(updater.updateStatus);
    return null;
  }

  beforeEach(async () => {
    GlobalRegistrator.register({ url: "http://localhost/" });
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    // Bun aliases import.meta.env to process.env; DEV enables the metadata eval hook.
    process.env.DEV = "true";
    window.__openworkReadDesktopVersionMetadataEval = () => metadata;
    installs = 0;
    refreshes = 0;
    statuses = [];
    downloadedConfig = { allowedDesktopVersions: [downloadedVersion] };
    refreshResult = async () => downloadedConfig;
    Reflect.set(window, "__OPENWORK_ELECTRON__", {
      updater: {
        getChannel: async () => ({ channel: "stable", currentVersion: installedVersion }),
        setChannel: async (channel: "stable" | "alpha") => ({ channel, currentVersion: installedVersion }),
        check: async () => ({ available: true, channel: "stable", currentVersion: installedVersion, latestVersion: downloadedVersion }),
        download: async () => ({ ok: true }),
        installAndRestart: async () => {
          installs += 1;
          return { ok: true };
        },
      },
    });
    root = createRoot(document.createElement("div"));
    await act(async () => { root.render(createElement(Harness, { desktopConfig: downloadedConfig })); });
    // Check and download while the organization allows the version.
    await act(async () => { await updater.checkForUpdates(); });
    expect(updater.updateStatus).toMatchObject({ state: "ready", version: downloadedVersion });
    refreshes = 0;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    if (originalDev === undefined) delete process.env.DEV;
    else process.env.DEV = originalDev;
    await GlobalRegistrator.unregister();
  });

  test("installs a downloaded version the organization still allows", async () => {
    await act(async () => { await updater.installUpdateAndRestart(); });

    expect(refreshes).toBe(1);
    expect(installs).toBe(1);
    expect(updater.updateStatus).toMatchObject({ state: "ready", version: downloadedVersion });
  });

  test("refuses to install a version revoked between download and install", async () => {
    refreshResult = async () => ({ allowedDesktopVersions: [installedVersion] });

    await act(async () => { await updater.installUpdateAndRestart(); });

    expect(refreshes).toBe(1);
    expect(installs).toBe(0);
    expect(updater.updateStatus).toMatchObject({
      state: "blocked",
      version: downloadedVersion,
      message: `OpenWork ${downloadedVersion} is available, but this installation is not eligible for it yet.`,
    });
    expect(statuses.some((status) => status?.state === "error")).toBe(false);
  });

  test("installs when the refreshed policy has no allowlist", async () => {
    refreshResult = async () => ({});

    await act(async () => { await updater.installUpdateAndRestart(); });

    expect(installs).toBe(1);
    expect(updater.updateStatus).toMatchObject({ state: "ready" });
  });

  test("uses the last known policy when the refresh fails", async () => {
    refreshResult = async () => { throw new Error("offline"); };

    await act(async () => { await updater.installUpdateAndRestart(); });

    expect(refreshes).toBe(1);
    expect(installs).toBe(1);
    expect(updater.updateStatus).toMatchObject({ state: "ready", version: downloadedVersion });
  });

  test("blocks on the last known policy when the refresh fails after a revocation", async () => {
    await act(async () => {
      root.render(createElement(Harness, { desktopConfig: { allowedDesktopVersions: [installedVersion] } }));
    });
    refreshResult = async () => { throw new Error("offline"); };

    await act(async () => { await updater.installUpdateAndRestart(); });

    expect(installs).toBe(0);
    expect(updater.updateStatus).toMatchObject({ state: "blocked", version: downloadedVersion });
  });
});
