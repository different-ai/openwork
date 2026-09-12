import { evalIn, go } from "@openwork/behaviors";
import { SkipError } from "@openwork/env";
import type { Seed } from "@openwork/env";

declare global {
  interface Window {
    __checkNowUpdateWitness: {
      channel: "stable" | "alpha";
      latestVersion: string;
      selectedVersion: string | null;
      stagedVersion: string | null;
      published: boolean;
      checks: { channel: string | undefined; targetVersion: string | undefined; preserveStaged: boolean }[];
      downloads: string[];
      installs: string[];
      offset: number;
      intervalCheck: (() => void) | null;
      finishDownload: (() => void) | null;
    };
  }
}

export async function desktopUpdateCheckNowWorld(seed: Seed) {
  if (process.platform !== "darwin") throw new SkipError("macOS desktop for the Alpha release channel");
  const app = await seed.desktop({ name: "desktop-update-check-now", signIn: false });
  const workspace = await seed.workspace(app, seed.tmpPath("desktop-update-check-now"));
  await evalIn(app, () => {
    const currentVersion = "0.18.47-alpha.2960";
    const state: Window["__checkNowUpdateWitness"] = {
      channel: "stable", latestVersion: "0.18.47-alpha.2962", selectedVersion: null,
      stagedVersion: null, published: false, checks: [], downloads: [], installs: [],
      offset: 0, intervalCheck: null, finishDownload: null,
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
    window.__openworkReadDesktopVersionMetadataEval = () => ({
      minAppVersion: "0.1.0", latestAppVersion: "0.18.46", publishedDesktopVersions: ["0.18.46"],
    });
    window.__openworkUpdaterEvalBridge = {
      getChannel: async () => ({ channel: state.channel, currentVersion }),
      setChannel: async (channel) => {
        state.channel = channel;
        state.stagedVersion = null;
        return { channel, currentVersion };
      },
      check: async (channel, targetVersion?: string, options?: { preserveStaged?: boolean }) => {
        state.checks.push({ channel, targetVersion, preserveStaged: options?.preserveStaged === true });
        const available = state.published && channel === "alpha";
        state.selectedVersion = available ? state.latestVersion : null;
        if (!options?.preserveStaged) state.stagedVersion = null;
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
  });
  return {
    app,
    snapshot: () => evalIn(app, () => {
      const { channel, checks, downloads, installs, stagedVersion } = window.__checkNowUpdateWitness;
      const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button"));
      const settingsActions = buttons.filter((button) => /^(Install v|Download v)/.test(button.textContent?.trim() ?? ""));
      return {
        channel, checks, downloads, installs, stagedVersion,
        automaticChecksEnabled: localStorage.getItem("openwork.react.settings.update-auto-check") !== "0",
        automaticDownloadsEnabled: localStorage.getItem("openwork.react.settings.update-auto-download.v2") !== "0",
        capsuleText: document.querySelector<HTMLElement>("header [data-update-button]")?.textContent?.trim() ?? null,
        updateInSidebar: Boolean(document.querySelector('[data-sidebar="footer"] [data-update-button]')),
        panelText: document.querySelector<HTMLElement>('[role="alertdialog"]')?.innerText ?? null,
        settingsActions: settingsActions.map((button) => ({
          text: button.textContent?.trim(), disabled: button.disabled,
          primary: button.classList.contains("bg-foreground"),
          secondary: button.classList.contains("bg-secondary"),
        })),
      };
    }),
    publishInitial: () => evalIn(app, () => { window.__checkNowUpdateWitness.published = true; }),
    advanceFeed: () => evalIn(app, () => { window.__checkNowUpdateWitness.latestVersion = "0.18.47-alpha.2966"; }),
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
