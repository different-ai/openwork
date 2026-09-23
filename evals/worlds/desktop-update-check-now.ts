import { evalIn, go } from "@openwork/behaviors";
import { browserScript, setViewport } from "@openwork/cdp";
import type { Seed } from "@openwork/env";

declare global {
  interface Window {
    __checkNowUpdateWitness: {
      channel: "stable" | "alpha";
      latestVersion: string;
      newerVersion: string;
      selectedVersion: string | null;
      stagedVersion: string | null;
      published: boolean;
      checks: { channel: string | undefined; targetVersion: string | undefined; preserveStaged: boolean }[];
      downloads: string[];
      installs: string[];
      offset: number;
      intervalCheck: (() => void) | null;
      finishDownload: (() => void) | null;
      holdCheck: boolean;
      finishCheck: (() => void) | null;
    };
  }
}

export async function desktopUpdateCheckNowWorld(seed: Seed) {
  const releases: { channel: "stable" | "alpha"; staged: string; newer: string } = process.platform === "darwin"
    ? { channel: "alpha", staged: "0.18.47-alpha.2962", newer: "0.18.47-alpha.2966" }
    : { channel: "stable", staged: "999999999.999999999.999999998", newer: "999999999.999999999.999999999" };
  const app = await seed.desktop({ name: "desktop-update-check-now", signIn: false });
  await setViewport(app, { width: 1200, height: 820, deviceScaleFactor: 1 });
  const workspace = await seed.workspace(app, seed.tmpPath("desktop-update-check-now"));
  await evalIn(app, browserScript(async (releases) => {
    // Keep the installed version stable so the first manual check does not
    // re-key the background checker while its fake download is pending.
    const { currentVersion } = await window.__OPENWORK_ELECTRON__.updater.getChannel();
    const state: Window["__checkNowUpdateWitness"] = {
      channel: "stable", latestVersion: releases.staged, newerVersion: releases.newer, selectedVersion: null,
      stagedVersion: null, published: false, checks: [], downloads: [], installs: [],
      offset: 0, intervalCheck: null, finishDownload: null,
      holdCheck: false, finishCheck: null,
    };
    window.__checkNowUpdateWitness = state;
    const now = Date.now.bind(Date);
    Date.now = () => now() + state.offset;
    const schedule = window.setInterval.bind(window);
    const browserWindow: Window = window;
    browserWindow.setInterval = (callback: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (delay === 15 * 60 * 1000 && typeof callback === "function") state.intervalCheck = () => callback(...args);
      return schedule(callback, delay, ...args);
    };
    window.__openworkApplyDesktopConfig({ allowAlphaUpdates: true });
    window.__openworkSetDesktopConfigRefreshResult({ allowAlphaUpdates: true });
    window.__openworkReadDesktopVersionMetadataEval = () => {
      const latestAppVersion = releases.channel === "alpha" ? "0.18.46" : state.latestVersion;
      return { minAppVersion: "0.1.0", latestAppVersion, publishedDesktopVersions: [latestAppVersion] };
    };
    window.__openworkUpdaterEvalBridge = {
      getChannel: async () => ({ channel: state.channel, currentVersion }),
      setChannel: async (channel) => {
        state.channel = channel;
        state.stagedVersion = null;
        return { channel, currentVersion };
      },
      check: async (channel, targetVersion?: string, options?: { preserveStaged?: boolean }) => {
        state.checks.push({ channel, targetVersion, preserveStaged: options?.preserveStaged === true });
        const available = state.published && channel === releases.channel;
        state.selectedVersion = available ? state.latestVersion : null;
        if (!options?.preserveStaged) state.stagedVersion = null;
        if (state.holdCheck) {
          state.holdCheck = false;
          await new Promise<void>((resolve) => { state.finishCheck = resolve; });
        }
        return {
          available, channel, currentVersion,
          latestVersion: available ? state.latestVersion : currentVersion,
          totalBytes: 123 * 1024 * 1024,
          releaseDate: "2026-09-12",
          releaseNotes: [{ note: `Release ${state.latestVersion}` }],
          ...(options?.preserveStaged ? { stagedVersion: state.stagedVersion } : {}),
        };
      },
      download: async () => {
        const version = state.selectedVersion;
        if (!version) throw new Error("No release selected for download");
        state.downloads.push(version);
        state.stagedVersion = null;
        return new Promise((resolve) => {
          state.finishDownload = () => {
            state.finishDownload = null;
            state.stagedVersion = version;
            resolve({ ok: true });
          };
        });
      },
      installAndRestart: async () => {
        if (!state.stagedVersion) return { ok: false, reason: "update-not-downloaded" };
        state.installs.push(state.stagedVersion);
        return { ok: true };
      },
      onDownloadProgress: () => () => {},
    };
  }, [releases]), { awaitPromise: true });
  return {
    app,
    releases,
    snapshot: () => evalIn(app, () => {
      const { channel, checks, downloads, installs, stagedVersion } = window.__checkNowUpdateWitness;
      const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button"));
      const settingsActions = buttons.filter((button) => /^(Install & restart|Download)$/.test(button.textContent?.trim() ?? ""));
      return {
        channel, checks, downloads, installs, stagedVersion,
        automaticChecksEnabled: localStorage.getItem("openwork.react.settings.update-auto-check") !== "0",
        automaticDownloadsEnabled: localStorage.getItem("openwork.react.settings.update-auto-download.v2") !== "0",
        capsuleText: document.querySelector<HTMLElement>("header [data-update-button]")?.textContent?.trim() ?? null,
        updateInSidebar: Boolean(document.querySelector('[data-sidebar="footer"] [data-update-button]')),
        panelText: document.querySelector<HTMLElement>('[role="alertdialog"]')?.innerText ?? null,
        latestVersionText: document.querySelector('[data-testid="updates-latest-version"]')?.textContent?.trim() ?? null,
        settingsActions: settingsActions.map((button) => ({
          text: button.textContent?.trim(), disabled: button.disabled,
          primary: button.classList.contains("bg-foreground"),
          secondary: button.classList.contains("bg-secondary"),
        })),
      };
    }),
    layout: () => evalIn(app, () => {
      const versions = document.querySelector<HTMLElement>('[data-testid="updates-versions"]');
      const actions = document.querySelector<HTMLElement>('[data-testid="updates-actions"]');
      const status = document.querySelector<HTMLElement>('[data-testid="updates-status"]');
      if (!versions || !actions || !status) throw new Error("Update controls are not visible");
      const bounds = (element: Element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      };
      return {
        versions: bounds(versions),
        actions: bounds(actions),
        status: bounds(status),
        values: Array.from(versions.querySelectorAll("dd"), (element) => ({
          ...bounds(element), text: element.textContent?.trim(),
          fits: element.scrollWidth <= element.clientWidth,
        })),
        buttons: Array.from(actions.querySelectorAll("button"), (button) => ({
          ...bounds(button), text: button.textContent?.trim(), disabled: button.disabled,
        })),
        fits: versions.scrollWidth <= versions.clientWidth && actions.scrollWidth <= actions.clientWidth
          && status.scrollWidth <= status.clientWidth,
        viewportWidth: window.innerWidth,
      };
    }),
    resize: (width: number) => setViewport(app, { width, height: 820, deviceScaleFactor: 1 }),
    holdNextCheck: () => evalIn(app, () => { window.__checkNowUpdateWitness.holdCheck = true; }),
    finishCheck: () => evalIn(app, () => {
      const state = window.__checkNowUpdateWitness;
      if (!state.finishCheck) throw new Error("No update check is pending");
      state.finishCheck();
      state.finishCheck = null;
    }),
    publishInitial: () => evalIn(app, () => { window.__checkNowUpdateWitness.published = true; }),
    advanceFeed: () => evalIn(app, () => {
      const state = window.__checkNowUpdateWitness;
      state.latestVersion = state.newerVersion;
    }),
    finishDownload: () => evalIn(app, () => {
      const finish = window.__checkNowUpdateWitness.finishDownload;
      if (!finish) throw new Error("No update download is pending");
      finish();
    }),
    triggerAutomaticChecks: () => evalIn(app, () => {
      const state = window.__checkNowUpdateWitness;
      if (!state.intervalCheck) throw new Error("Automatic update interval was not registered");
      state.offset += 16 * 60 * 1000;
      state.intervalCheck();
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("online"));
      document.dispatchEvent(new Event("visibilitychange"));
    }),
    openSettings: () => go(app, `/workspace/${workspace.workspaceId}/settings/updates`),
    openWorkspace: () => go(app, `/workspace/${workspace.workspaceId}/session`),
  };
}
