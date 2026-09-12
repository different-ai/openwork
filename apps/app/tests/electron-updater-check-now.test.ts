import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";

import type { DenDesktopConfig } from "../src/app/lib/den";
import type { ReleaseChannel } from "../src/app/types";
import { formatBytes } from "../src/app/utils";
import {
  useElectronUpdaterState,
  type SettingsUpdateStatus,
} from "../src/react-app/domains/settings/state/electron-updater-state";
import { useUpdateCheckRequestStore } from "../src/react-app/domains/settings/state/update-check-request";

GlobalRegistrator.register({ url: "http://localhost/" });
afterAll(async () => { await GlobalRegistrator.unregister(); });
const { createRoot } = await import("react-dom/client");
const { UpdatesView } = await import("../src/react-app/domains/settings/pages/updates-view");

type Bridge = NonNullable<NonNullable<Window["__OPENWORK_ELECTRON__"]>["updater"]>;
type CheckResult = Awaited<ReturnType<NonNullable<Bridge["check"]>>>;
type Updater = ReturnType<typeof useElectronUpdaterState>;
const installedVersion = "0.18.0";
const stagedVersion = "0.18.5";
const newerVersion = "0.18.10";
const alphaStagedVersion = "0.18.47-alpha.2962";
const alphaNewerVersion = "0.18.47-alpha.2966";
const artifactBytes = 123 * 1024 * 1024;

function stagedFields(status: SettingsUpdateStatus) {
  if (!status) return null;
  const { checkingForNewer, checkError, checkCooldownUntil, newest, candidate, ...staged } = status;
  return staged;
}

describe("Settings staged-update discovery", () => {
  let root: ReturnType<typeof createRoot>;
  let host: HTMLDivElement;
  let updater: Updater;
  let statuses: SettingsUpdateStatus[];
  let checks: { channel?: ReleaseChannel; targetVersion?: string; options?: { preserveStaged?: boolean } }[];
  let downloads: string[];
  let installs: number;
  let installedStages: (string | null)[];
  let downloadedStage: string | null;
  let releaseChannel: ReleaseChannel;
  let currentVersion: string;
  let selectedVersion: string;
  let latestVersion: string;
  let totalBytes: number | null;
  let checkReason: string | undefined;
  let downloadReason: string | undefined;
  let installReason: string | undefined;
  let checkResult: (() => Promise<CheckResult>) | undefined;
  let downloadResult: (() => Promise<{ ok: boolean; reason?: string }>) | undefined;
  let config: DenDesktopConfig;
  let refreshResult: (() => Promise<DenDesktopConfig>) | undefined;
  let autoCheck: boolean;
  let autoDownload: boolean;
  let activeRuns: boolean;
  let clock: number;
  let timers: { at: number; run: () => void }[];
  let automaticTick: () => void;
  const originalDev = process.env.DEV;
  const onReleaseChannelChange = () => {};
  const setError = () => {};
  const refreshDesktopConfig = async () => refreshResult ? refreshResult() : config;

  function Harness() {
    updater = useElectronUpdaterState({
      releaseChannel,
      onReleaseChannelChange,
      updateAutoCheck: autoCheck,
      updateAutoDownload: autoDownload,
      updatePolicyKnown: true,
      desktopConfig: config,
      refreshDesktopConfig,
      setError,
    });
    statuses.push(updater.updateStatus);
    return createElement(UpdatesView, {
      ...updater,
      busy: false,
      webDeployment: false,
      updateAutoCheck: autoCheck,
      updateAutoDownload: autoDownload,
      toggleUpdateAutoCheck: () => {},
      toggleUpdateAutoDownload: () => {},
      anyActiveRuns: activeRuns,
    });
  }

  function button(label: string) {
    const result = Array.from(document.querySelectorAll("button")).find((node) => node.textContent === label);
    if (!result) throw new Error(`Missing button: ${label}`);
    return result;
  }

  async function click(label: string) {
    await act(async () => { button(label).click(); });
  }

  async function advance(milliseconds: number) {
    await act(async () => {
      clock += milliseconds;
      const due = timers.filter((timer) => timer.at <= clock);
      timers = timers.filter((timer) => timer.at > clock);
      for (const timer of due) timer.run();
    });
  }

  async function stage() {
    await click("Check now");
    expect(updater.updateStatus).toMatchObject({ state: "ready", version: stagedVersion });
    latestVersion = newerVersion;
    statuses = [];
    checks = [];
    downloads = [];
  }

  async function stageAlpha() {
    releaseChannel = "alpha";
    currentVersion = "0.18.47-alpha.2960";
    latestVersion = alphaStagedVersion;
    await act(async () => { root.render(createElement(Harness)); });
    await click("Check now");
    expect(updater.updateStatus).toMatchObject({ state: "ready", version: alphaStagedVersion });
    expect(downloadedStage).toBe(alphaStagedVersion);
    latestVersion = alphaNewerVersion;
    statuses = [];
    checks = [];
    downloads = [];
  }

  beforeEach(async () => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    process.env.DEV = "true";
    clock = 1_800_000_000_000;
    spyOn(Date, "now").mockImplementation(() => clock);
    timers = [];
    automaticTick = () => { throw new Error("Automatic check timer was not mounted"); };
    const setTimeout = window.setTimeout.bind(window);
    spyOn(window, "setTimeout").mockImplementation((handler, delay, ...args) => {
      if (delay === 15_000 && typeof handler === "function") {
        timers.push({ at: clock + delay, run: () => handler(...args) });
        return 987654;
      }
      return setTimeout(handler, delay, ...args);
    });
    const setInterval = window.setInterval.bind(window);
    spyOn(window, "setInterval").mockImplementation((handler, delay, ...args) => {
      if (delay === 15 * 60 * 1000 && typeof handler === "function") {
        automaticTick = () => handler(...args);
        return 987655;
      }
      return setInterval(handler, delay, ...args);
    });
    statuses = [];
    checks = [];
    downloads = [];
    installs = 0;
    installedStages = [];
    downloadedStage = null;
    releaseChannel = "stable";
    currentVersion = installedVersion;
    refreshResult = undefined;
    latestVersion = stagedVersion;
    selectedVersion = stagedVersion;
    totalBytes = artifactBytes;
    checkReason = undefined;
    downloadReason = undefined;
    installReason = undefined;
    checkResult = undefined;
    downloadResult = undefined;
    config = {};
    autoCheck = false;
    autoDownload = true;
    activeRuns = false;
    window.__openworkReadDesktopVersionMetadataEval = () => ({
      minAppVersion: "0.1.0",
      latestAppVersion: releaseChannel === "alpha" ? "0.18.46" : latestVersion,
      publishedDesktopVersions: releaseChannel === "alpha" ? ["0.18.46"] : [latestVersion],
    });
    const bridge: Bridge = {
      getChannel: async () => ({ channel: releaseChannel, currentVersion, feedUrl: "" }),
      setChannel: async (channel) => ({ channel, currentVersion, feedUrl: "" }),
      check: async (channel, targetVersion, options) => {
        checks.push({ channel, targetVersion, options });
        if (checkResult) return checkResult();
        selectedVersion = targetVersion ?? latestVersion;
        return {
          available: true,
          channel,
          currentVersion,
          latestVersion: selectedVersion,
          releaseDate: "2026-09-12",
          releaseNotes: [{ note: `Notes for ${selectedVersion}` }],
          totalBytes,
          ...(options?.preserveStaged ? { stagedVersion: downloadedStage } : {}),
          reason: checkReason,
        };
      },
      download: async () => {
        downloads.push(selectedVersion);
        const result = downloadResult ? await downloadResult() : { ok: !downloadReason, reason: downloadReason };
        downloadedStage = result.ok ? selectedVersion : null;
        return result;
      },
      installAndRestart: async () => {
        installs += 1;
        installedStages.push(downloadedStage);
        return { ok: !installReason, reason: installReason };
      },
    };
    Reflect.set(window, "__OPENWORK_ELECTRON__", { updater: bridge });
    useUpdateCheckRequestStore.getState().clearUpdateCheckRequest();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => { root.render(createElement(Harness)); });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    useUpdateCheckRequestStore.getState().clearUpdateCheckRequest();
    mock.restore();
    if (originalDev === undefined) delete process.env.DEV;
    else process.env.DEV = originalDev;
  });

  test("idle manual check retains stable selection and automatic download", async () => {
    await click("Check now");
    expect(checks).toEqual([{ channel: "stable", targetVersion: stagedVersion, options: undefined }]);
    expect(downloads).toEqual([stagedVersion]);
    expect(updater.updateStatus).toMatchObject({ state: "ready", version: stagedVersion });
  });

  test("manual idle check still waits for selection when automatic download is off", async () => {
    autoDownload = false;
    await act(async () => { root.render(createElement(Harness)); });
    await click("Check now");
    expect(updater.updateStatus).toMatchObject({ state: "available", version: stagedVersion });
    expect(downloads).toEqual([]);
    await click("Download");
    expect(downloads).toEqual([stagedVersion]);
    expect(updater.updateStatus).toMatchObject({ state: "ready", version: stagedVersion });
  });

  test("idle check failure still uses the existing manual recovery path", async () => {
    checkReason = "offline";
    await click("Check now");
    expect(updater.updateStatus).toMatchObject({ state: "error", failedAction: "check" });
    checkReason = undefined;
    await click("Check now");
    expect(checks.every((call) => call.options === undefined)).toBe(true);
    expect(downloads).toEqual([stagedVersion]);
    expect(updater.updateStatus?.state).toBe("ready");
  });

  test("ready Check now calls preserveStaged IPC and never downloads automatically", async () => {
    await stage();
    const staged = stagedFields(updater.updateStatus);
    await click("Check now");
    expect(checks).toEqual([{ channel: "stable", targetVersion: newerVersion, options: { preserveStaged: true } }]);
    expect(downloads).toEqual([]);
    expect(statuses.length).toBeGreaterThan(0);
    for (const status of statuses) expect(stagedFields(status)).toEqual(staged);
    expect(updater.updateStatus?.candidate).toEqual({
      version: newerVersion,
      totalBytes: artifactBytes,
      date: "2026-09-12",
      notes: `Notes for ${newerVersion}`,
      channel: "stable",
    });
    expect(button(`Install v${stagedVersion} & restart`).disabled).toBe(false);
    expect(button(`Download v${newerVersion} (${formatBytes(artifactBytes)})`).disabled).toBe(false);
    expect(host.textContent).toContain(`v${newerVersion} available (v${stagedVersion} downloaded)`);
    expect(host.textContent).toContain(`Notes for ${newerVersion}`);
    expect(host.textContent).toContain("Released 2026-09-12");
    expect(host.textContent).not.toContain("— newest");
  });

  test.each([alphaNewerVersion, alphaStagedVersion, "0.18.47-alpha.2961"])("alpha .2962 stages remain unchanged when discovery returns %s", async (feedVersion) => {
    await stageAlpha();
    const staged = stagedFields(updater.updateStatus);
    latestVersion = feedVersion;
    const deferred = Promise.withResolvers<CheckResult>();
    checkResult = () => deferred.promise;
    await click("Check now");
    expect(updater.updateStatus).toMatchObject({ state: "ready", version: alphaStagedVersion, checkingForNewer: true });
    expect(downloadedStage).toBe(alphaStagedVersion);
    expect(checks).toEqual([{ channel: "alpha", targetVersion: undefined, options: { preserveStaged: true } }]);
    await act(async () => {
      deferred.resolve({ available: true, latestVersion: feedVersion, stagedVersion: alphaStagedVersion, totalBytes: artifactBytes });
    });
    for (const status of statuses) expect(stagedFields(status)).toEqual(staged);
    expect(downloadedStage).toBe(alphaStagedVersion);
    expect(downloads).toEqual([]);
    expect(updater.updateStatus?.newest).toBe(feedVersion === alphaStagedVersion);
    if (feedVersion === alphaNewerVersion) {
      expect(updater.updateStatus?.candidate).toMatchObject({ version: alphaNewerVersion, channel: "alpha", totalBytes: artifactBytes });
      expect(button(`Download v${alphaNewerVersion} (${formatBytes(artifactBytes)})`).disabled).toBe(false);
      expect(host.textContent).toContain(`v${alphaNewerVersion} available (v${alphaStagedVersion} downloaded)`);
    } else {
      expect(updater.updateStatus?.candidate).toBeUndefined();
      expect(host.textContent).not.toContain("Download v");
    }
    expect(button(`Install v${alphaStagedVersion} & restart`).disabled).toBe(false);
  });

  test("alpha .2962 stays installable after .2966 discovery and a failed recheck", async () => {
    await stageAlpha();
    await click("Check now");
    expect(updater.updateStatus?.candidate?.version).toBe(alphaNewerVersion);
    await advance(15_000);
    checkReason = "offline";
    await click("Check now");
    expect(updater.updateStatus).toMatchObject({ state: "ready", version: alphaStagedVersion, checkError: "offline" });
    expect(updater.updateStatus?.candidate).toBeUndefined();
    expect(downloadedStage).toBe(alphaStagedVersion);
    expect(downloads).toEqual([]);
    expect(button("Retry").disabled).toBe(false);
    await click(`Install v${alphaStagedVersion} & restart`);
    expect(installedStages).toEqual([alphaStagedVersion]);
  });

  test("equal feed reports newest only in Settings", async () => {
    await stage();
    latestVersion = stagedVersion;
    await click("Check now");
    expect(updater.updateStatus).toMatchObject({ state: "ready", version: stagedVersion, newest: true });
    expect(updater.updateStatus?.candidate).toBeUndefined();
    expect(host.textContent).toContain(`Ready to install: v${stagedVersion} — newest`);
    expect(host.textContent).not.toContain("Download v");
  });

  test("older feed is neither a newer candidate nor equal-newest", async () => {
    await stage();
    latestVersion = "0.18.4";
    await click("Check now");
    expect(updater.updateStatus).toMatchObject({ state: "ready", version: stagedVersion, newest: false });
    expect(updater.updateStatus?.candidate).toBeUndefined();
    expect(host.textContent).not.toContain("— newest");
    expect(host.textContent).not.toContain("Download v");
  });

  test("unknown artifact size is honest in the rendered download action", async () => {
    await stage();
    totalBytes = null;
    await click("Check now");
    expect(button(`Download v${newerVersion} (size unknown)`).disabled).toBe(false);
    expect(updater.updateStatus?.candidate?.totalBytes).toBeNull();
  });

  test("focus, online, visibility and automatic timer never check while ready", async () => {
    await stage();
    autoCheck = true;
    await act(async () => { root.render(createElement(Harness)); });
    await advance(15 * 60 * 1000);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("online"));
      document.dispatchEvent(new Event("visibilitychange"));
      automaticTick();
    });
    expect(checks).toEqual([]);
    expect(downloads).toEqual([]);
    expect(updater.updateStatus).toMatchObject({ state: "ready", version: stagedVersion });
    await click("Check now");
    expect(checks).toHaveLength(1);
    expect(checks[0]?.options).toEqual({ preserveStaged: true });
  });

  test("native menu request shares the staged-preserving manual check", async () => {
    await stage();
    await act(async () => { useUpdateCheckRequestStore.getState().requestUpdateCheck(); });
    expect(checks).toEqual([{ channel: "stable", targetVersion: newerVersion, options: { preserveStaged: true } }]);
    expect(updater.updateStatus).toMatchObject({ state: "ready", version: stagedVersion });
    expect(downloads).toEqual([]);
  });

  test("15-second debounce is disabled and visible, then re-enables", async () => {
    await stage();
    await click("Check now");
    expect(button("Check now (15-second cooldown)").disabled).toBe(true);
    await act(async () => { await updater.checkForUpdates(); });
    await advance(14_999);
    expect(button("Check now (15-second cooldown)").disabled).toBe(true);
    await act(async () => { await updater.checkForUpdates(); });
    expect(checks).toHaveLength(1);
    await advance(1);
    expect(button("Check now").disabled).toBe(false);
    await click("Check now");
    expect(checks).toHaveLength(2);
    expect(downloads).toEqual([]);
  });

  test("in-flight duplicate calls stay blocked even after the cooldown expires", async () => {
    await stage();
    const staged = stagedFields(updater.updateStatus);
    const deferred = Promise.withResolvers<CheckResult>();
    checkResult = () => deferred.promise;
    await click("Check now");
    expect(button("Checking for newer updates…").disabled).toBe(true);
    expect(button(`Install v${stagedVersion} & restart`).disabled).toBe(false);
    await advance(15_000);
    await act(async () => { void updater.checkForUpdates(); void updater.checkForUpdates(); });
    expect(checks).toHaveLength(1);
    await act(async () => {
      deferred.resolve({ available: true, latestVersion: newerVersion, stagedVersion, totalBytes: artifactBytes });
    });
    for (const status of statuses) expect(stagedFields(status)).toEqual(staged);
    expect(downloads).toEqual([]);
  });

  test("a delayed metadata result never reinstates an expired cooldown before its timer fires", async () => {
    await stage();
    const deferred = Promise.withResolvers<CheckResult>();
    checkResult = () => deferred.promise;
    await click("Check now");
    statuses = [];
    await act(async () => {
      clock += 15_001;
      deferred.resolve({ available: true, latestVersion: newerVersion, stagedVersion });
    });
    expect(statuses.length).toBeGreaterThan(0);
    for (const status of statuses) {
      if (!status?.checkingForNewer) expect(status?.checkCooldownUntil).toBeUndefined();
    }
    expect(button("Check now").disabled).toBe(false);
    checkResult = undefined;
    await click("Check now");
    expect(checks).toHaveLength(2);
    expect(downloads).toEqual([]);
  });

  test.each(["result", "throw"])("%s failure preserves A, removes B, and allows immediate Retry", async (kind) => {
    await stage();
    await click("Check now");
    await advance(15_000);
    const staged = stagedFields(updater.updateStatus);
    statuses = [];
    if (kind === "result") checkReason = "offline";
    else checkResult = async () => { throw new Error("offline"); };
    await click("Check now");
    expect(updater.updateStatus).toMatchObject({ state: "ready", version: stagedVersion, checkError: "offline" });
    expect(updater.updateStatus?.candidate).toBeUndefined();
    expect(host.textContent).not.toContain(`Download v${newerVersion}`);
    expect(host.textContent).toContain("offline");
    expect(button("Retry").disabled).toBe(false);
    expect(button(`Install v${stagedVersion} & restart`).disabled).toBe(false);
    for (const status of statuses) expect(stagedFields(status)).toEqual(staged);
    checkReason = undefined;
    checkResult = undefined;
    await click("Retry");
    expect(checks).toHaveLength(3);
    expect(checks.every((call) => call.options?.preserveStaged)).toBe(true);
    expect(updater.updateStatus?.candidate?.version).toBe(newerVersion);
    expect(downloads).toEqual([]);
  });

  for (const reason of [undefined, "offline"]) {
    test.each(["null", "mismatch", "missing"])(`%s staged confirmation clears ready before handling ${reason ?? "success"}`, async (confirmation) => {
      await stage();
      autoCheck = true;
      await act(async () => { root.render(createElement(Harness)); });
      await click("Check now");
      await advance(15_000);
      checkResult = async () => ({
        available: !reason,
        latestVersion: newerVersion,
        ...(confirmation === "missing" ? {} : { stagedVersion: confirmation === "null" ? null : newerVersion }),
        reason,
      });
      await click("Check now");
      expect(updater.updateStatus).toMatchObject({ state: "error", failedAction: "check" });
      expect(updater.updateStatus?.version).toBeUndefined();
      expect(updater.updateStatus?.candidate).toBeUndefined();
      expect(updater.updateStatus?.checkCooldownUntil).toBeUndefined();
      expect(host.textContent).toContain("The previously downloaded update is no longer confirmed ready to install.");
      expect(host.textContent).not.toContain(`Install v${stagedVersion}`);
      expect(host.textContent).not.toContain(`Download v${newerVersion}`);
      expect(button("Retry").disabled).toBe(false);
      await advance(15 * 60 * 1000);
      await act(async () => { window.dispatchEvent(new Event("focus")); automaticTick(); });
      expect(checks).toHaveLength(2);
      expect(downloads).toEqual([]);
      checkResult = undefined;
      await click("Retry");
      expect(checks[2]).toEqual({ channel: "stable", targetVersion: newerVersion, options: undefined });
      expect(updater.updateStatus).toMatchObject({ state: "available", version: newerVersion });
      expect(downloads).toEqual([]);
    });
  }

  test("losing staged confirmation invalidates an install awaiting A's policy", async () => {
    await stage();
    const deferred = Promise.withResolvers<DenDesktopConfig>();
    refreshResult = () => deferred.promise;
    let installing: Promise<void> | undefined;
    await act(async () => { installing = updater.installUpdateAndRestart(); });
    refreshResult = undefined;
    checkResult = async () => ({ available: false, stagedVersion: null, reason: "offline" });
    await click("Check now");
    await act(async () => {
      deferred.resolve({ allowedDesktopVersions: [stagedVersion] });
      await installing;
    });
    expect(installs).toBe(0);
    expect(updater.updateStatus?.state).toBe("error");
    expect(button("Retry").disabled).toBe(false);
  });

  test("explicit Download B clears staged metadata and becomes ready B only on success", async () => {
    await stage();
    await click("Check now");
    const deferred = Promise.withResolvers<{ ok: boolean }>();
    downloadResult = () => deferred.promise;
    statuses = [];
    await click(`Download v${newerVersion} (${formatBytes(artifactBytes)})`);
    expect(downloads).toEqual([newerVersion]);
    expect(updater.updateStatus).toMatchObject({ state: "downloading", version: newerVersion });
    expect(updater.updateStatus?.candidate).toBeUndefined();
    expect(updater.updateStatus?.checkCooldownUntil).toBeUndefined();
    expect(statuses.some((status) => status?.state === "ready")).toBe(false);
    expect(host.textContent).not.toContain(`Install v${stagedVersion}`);
    await act(async () => { deferred.resolve({ ok: true }); });
    expect(updater.updateStatus).toMatchObject({ state: "ready", version: newerVersion });
    expect(button(`Install v${newerVersion} & restart`).disabled).toBe(false);
    expect(button("Check now").disabled).toBe(false);
    await click("Check now");
    expect(checks).toHaveLength(2);
    expect(downloads).toEqual([newerVersion]);
  });

  test("replacement download failure never restores a fake ready A", async () => {
    await stage();
    await click("Check now");
    downloadReason = "download failed";
    statuses = [];
    await click(`Download v${newerVersion} (${formatBytes(artifactBytes)})`);
    expect(downloads).toEqual([newerVersion]);
    expect(updater.updateStatus).toMatchObject({ state: "error", failedAction: "download", message: "download failed" });
    expect(statuses.some((status) => status?.state === "ready")).toBe(false);
    expect(host.textContent).not.toContain(`Install v${stagedVersion}`);
    expect(updater.updateStatus?.candidate).toBeUndefined();
  });

  test("install after B discovery checks A's policy and installs A", async () => {
    await stage();
    await click("Check now");
    config = { allowedDesktopVersions: [stagedVersion] };
    await click(`Install v${stagedVersion} & restart`);
    expect(installs).toBe(1);
    expect(downloads).toEqual([]);
    expect(updater.updateStatus).toMatchObject({ state: "ready", version: stagedVersion });
  });

  test.each([false, true])("deferred install authorization stays bound to A (replacement: %s)", async (replace) => {
    await stage();
    await click("Check now");
    const deferred = Promise.withResolvers<DenDesktopConfig>();
    refreshResult = () => deferred.promise;
    let installing: Promise<void> | undefined;
    await act(async () => { installing = updater.installUpdateAndRestart(); });
    expect(installs).toBe(0);
    if (replace) {
      await click(`Download v${newerVersion} (${formatBytes(artifactBytes)})`);
      expect(downloadedStage).toBe(newerVersion);
    }
    await act(async () => {
      deferred.resolve({ allowedDesktopVersions: [stagedVersion] });
      await installing;
    });
    expect(installedStages).toEqual(replace ? [] : [stagedVersion]);
    expect(installs).toBe(replace ? 0 : 1);
    expect(updater.updateStatus).toMatchObject({ state: "ready", version: replace ? newerVersion : stagedVersion });
    if (replace) {
      await click(`Install v${newerVersion} & restart`);
      expect(updater.updateStatus).toMatchObject({ state: "blocked", version: newerVersion });
      expect(installs).toBe(0);
    }
  });

  test("B approval cannot authorize a revoked staged A at install", async () => {
    await stage();
    await click("Check now");
    config = { allowedDesktopVersions: [newerVersion] };
    await click(`Install v${stagedVersion} & restart`);
    expect(installs).toBe(0);
    expect(updater.updateStatus).toMatchObject({ state: "blocked", version: stagedVersion });
  });

  test("late metadata cannot restore ready A after an install failure", async () => {
    await stage();
    const deferred = Promise.withResolvers<CheckResult>();
    checkResult = () => deferred.promise;
    await click("Check now");
    installReason = "install failed";
    await click(`Install v${stagedVersion} & restart`);
    expect(updater.updateStatus).toMatchObject({ state: "error", failedAction: "install" });
    await act(async () => { deferred.resolve({ available: true, latestVersion: newerVersion, stagedVersion }); });
    expect(updater.updateStatus).toMatchObject({ state: "error", failedAction: "install" });
    expect(updater.updateStatus?.candidate).toBeUndefined();
  });

  test("active-task confirmation keeps the install action versioned to A", async () => {
    await stage();
    await click("Check now");
    activeRuns = true;
    await act(async () => { root.render(createElement(Harness)); });
    await click(`Install v${stagedVersion} & restart`);
    expect(installs).toBe(0);
    const dialog = document.querySelector('[role="alertdialog"], [role="dialog"]');
    expect(dialog?.textContent).toContain(`Install v${stagedVersion} & restart`);
    const confirm = Array.from(dialog?.querySelectorAll("button") ?? []).find((node) => node.textContent === `Install v${stagedVersion} & restart`);
    expect(confirm).toBeDefined();
    await act(async () => { confirm?.click(); });
    expect(installs).toBe(1);
  });

  test("channel override still uses the ordinary manual path", async () => {
    await stage();
    await act(async () => { await updater.checkForUpdates("stable"); });
    expect(checks).toEqual([{ channel: "stable", targetVersion: newerVersion, options: undefined }]);
    expect(downloads).toEqual([newerVersion]);
    expect(updater.updateStatus).toMatchObject({ state: "ready", version: newerVersion });
  });

  test("channel override invalidates old discovery without locking the next ready check", async () => {
    await stage();
    const oldCheck = Promise.withResolvers<CheckResult>();
    checkResult = () => oldCheck.promise;
    await click("Check now");
    checkResult = undefined;
    await act(async () => { await updater.checkForUpdates("stable"); });
    expect(updater.updateStatus).toMatchObject({ state: "ready", version: newerVersion });
    const nextCheck = Promise.withResolvers<CheckResult>();
    checkResult = () => nextCheck.promise;
    expect(button("Check now").disabled).toBe(false);
    await click("Check now");
    expect(checks).toHaveLength(3);
    await act(async () => { oldCheck.resolve({ available: true, latestVersion: newerVersion, stagedVersion }); });
    await act(async () => { void updater.checkForUpdates(); });
    expect(checks).toHaveLength(3);
    await act(async () => { nextCheck.resolve({ available: true, latestVersion: newerVersion, stagedVersion: newerVersion }); });
    expect(updater.updateStatus).toMatchObject({ state: "ready", version: newerVersion, newest: true });
  });

  test("install recovery still uses the destructive stable-targeted runCheck path", async () => {
    await stage();
    await click("Check now");
    checks = [];
    installReason = "update-not-downloaded";
    await click(`Install v${stagedVersion} & restart`);
    expect(checks).toEqual([{ channel: "stable", targetVersion: newerVersion, options: undefined }]);
    expect(downloads).toEqual([newerVersion]);
    expect(updater.updateStatus).toMatchObject({ state: "ready", version: newerVersion });
  });
});
