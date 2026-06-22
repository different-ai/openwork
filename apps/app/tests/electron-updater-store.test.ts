import { beforeEach, describe, expect, test, mock } from "bun:test";
import type { ReleaseChannel } from "../src/app/types";

// Mock version-gate module before importing the store
mock.module("../src/app/lib/version-gate", () => {
  return {
    isAlphaUpdateAllowed: async () => true,
    isUpdateAllowed: async () => true,
  };
});

// Minimal window and localStorage stub so the zustand store works under bun.
const storage = new Map<string, string>();
const localStorageStub = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    storage.set(key, value);
  },
  removeItem: (key: string) => {
    storage.delete(key);
  },
  clear: () => storage.clear(),
  key: (index: number) => [...storage.keys()][index] ?? null,
  get length() {
    return storage.size;
  },
};

Object.defineProperty(globalThis, "localStorage", {
  value: localStorageStub,
  configurable: true,
});

Object.defineProperty(globalThis, "window", {
  value: globalThis,
  configurable: true,
});

// Setup mock bridge
const mockCheck = mock(async (channel: string) => {
  return {
    currentVersion: "1.0.0",
    latestVersion: "1.1.0",
    available: true,
    channel,
  };
});

const mockDownload = mock(async () => {
  return { ok: true };
});

const mockUpdaterBridge = {
  check: mockCheck,
  download: mockDownload,
  getChannel: mock(async () => ({ channel: "stable", currentVersion: "1.0.0" })),
  setChannel: mock(async (channel: string) => ({ channel, currentVersion: "1.0.0" })),
  onDownloadProgress: mock((callback: any) => {
    return () => {};
  }),
};

(globalThis as any).__OPENWORK_ELECTRON__ = {
  updater: mockUpdaterBridge,
};

const { useElectronUpdaterStore } = await import("../src/react-app/domains/settings/state/electron-updater-store");

function resetStore() {
  useElectronUpdaterStore.setState({
    appVersion: null,
    updateEnv: null,
    updateStatus: null,
  });
  mockCheck.mockClear();
  mockDownload.mockClear();
  storage.clear();
}

describe("electron updater store", () => {
  beforeEach(resetStore);

  test("coalesces concurrent checkForUpdates calls for the same channel", async () => {
    let resolveCheck: any;
    const checkPromise = new Promise<any>((resolve) => {
      resolveCheck = resolve;
    });
    mockCheck.mockImplementation(async () => {
      return await checkPromise;
    });

    const check1 = useElectronUpdaterStore.getState().checkForUpdates({
      releaseChannel: "stable",
      desktopConfig: null,
    });
    const check2 = useElectronUpdaterStore.getState().checkForUpdates({
      releaseChannel: "stable",
      desktopConfig: null,
    });

    resolveCheck({
      currentVersion: "1.0.0",
      latestVersion: "1.2.0",
      available: true,
      channel: "stable",
    });

    await Promise.all([check1, check2]);

    expect(mockCheck).toHaveBeenCalledTimes(1);
    expect(useElectronUpdaterStore.getState().updateStatus?.state).toBe("available");
    expect(useElectronUpdaterStore.getState().updateStatus?.version).toBe("1.2.0");
  });

  test("runs a new check and discards stale check when release channel changes", async () => {
    let resolveCheckStable: any;
    const checkPromiseStable = new Promise<any>((resolve) => {
      resolveCheckStable = resolve;
    });

    let resolveCheckAlpha: any;
    const checkPromiseAlpha = new Promise<any>((resolve) => {
      resolveCheckAlpha = resolve;
    });

    mockCheck.mockImplementation(async (channel: string) => {
      if (channel === "stable") return await checkPromiseStable;
      return await checkPromiseAlpha;
    });

    // Start checking stable
    const checkStable = useElectronUpdaterStore.getState().checkForUpdates({
      releaseChannel: "stable",
      desktopConfig: null,
    });

    // Immediately check alpha (channel switched)
    const checkAlpha = useElectronUpdaterStore.getState().checkForUpdates({
      releaseChannel: "alpha",
      desktopConfig: null,
    });

    // Resolve stable check first with old results
    resolveCheckStable({
      currentVersion: "1.0.0",
      latestVersion: "1.2.0",
      available: true,
      channel: "stable",
    });
    await checkStable;

    // The stable check should have been ignored because the channel changed
    expect(useElectronUpdaterStore.getState().updateStatus?.state).toBe("checking");

    // Resolve alpha check with new results
    resolveCheckAlpha({
      currentVersion: "1.0.0",
      latestVersion: "1.3.0-alpha.1",
      available: true,
      channel: "alpha",
    });
    await checkAlpha;

    expect(mockCheck).toHaveBeenCalledTimes(2);
    expect(useElectronUpdaterStore.getState().updateStatus?.state).toBe("available");
    expect(useElectronUpdaterStore.getState().updateStatus?.version).toBe("1.3.0-alpha.1");
  });

  test("downloadUpdate coalesces concurrent downloadUpdate calls and guards state", async () => {
    // Should not download if state is not available
    await useElectronUpdaterStore.getState().downloadUpdate({
      releaseChannel: "stable",
      desktopConfig: null,
    });
    expect(mockDownload).not.toHaveBeenCalled();

    // Set state to available
    useElectronUpdaterStore.setState({
      updateStatus: {
        state: "available",
        version: "1.2.0",
      },
    });

    let resolveDownload: any;
    const downloadPromise = new Promise<any>((resolve) => {
      resolveDownload = resolve;
    });
    mockDownload.mockImplementation(async () => {
      return await downloadPromise;
    });

    const download1 = useElectronUpdaterStore.getState().downloadUpdate({
      releaseChannel: "stable",
      desktopConfig: null,
    });
    const download2 = useElectronUpdaterStore.getState().downloadUpdate({
      releaseChannel: "stable",
      desktopConfig: null,
    });

    resolveDownload({ ok: true });
    await Promise.all([download1, download2]);

    expect(mockDownload).toHaveBeenCalledTimes(1);
    expect(useElectronUpdaterStore.getState().updateStatus?.state).toBe("ready");
  });
});
