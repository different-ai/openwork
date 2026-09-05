import { readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cacheVerifiedRecoveryArtifact,
  compatibleRecoveryReleases,
  compareStableVersions,
  parseRecoveryManifest,
  readCachedRecoveryArtifact,
  readRecoveryState,
  recordHealthyVersion,
  recoveryManifestName,
  recoveryVersionMarkers,
  selectRecoveryArtifact,
  stableVersion,
  verifyCachedRecoveryArtifact,
} from "./recovery.mjs";

const ELECTRON_UPDATER_CHANNEL_FILENAME = "electron-updater-channel.v1.json";

// In dev mode, app.getVersion() returns the Electron framework version
// (e.g. "35.7.5") instead of the OpenWork app version. Read from
// package.json so the UI always shows the correct version.
const __updater_dirname = path.dirname(fileURLToPath(import.meta.url));
let _cachedAppVersion = null;
function resolveAppVersion(app) {
  if (_cachedAppVersion) return _cachedAppVersion;
  const electronVersion = app.getVersion();
  // If packaged, app.getVersion() is correct (set by electron-builder).
  if (app.isPackaged) {
    _cachedAppVersion = electronVersion;
    return electronVersion;
  }
  // In dev, read from package.json.
  try {
    const pkgPath = path.resolve(__updater_dirname, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    _cachedAppVersion = pkg.version || electronVersion;
  } catch {
    _cachedAppVersion = electronVersion;
  }
  return _cachedAppVersion;
}
const ELECTRON_UPDATER_FEEDS = Object.freeze({
  stable: "https://github.com/different-ai/openwork/releases/latest/download",
  alpha: "https://github.com/different-ai/openwork/releases/download/alpha-macos-latest",
});

function normalizeElectronUpdaterChannel(value, manifestChannel = "latest") {
  if (manifestChannel !== "latest") return "stable";
  if (value === "alpha" && process.platform === "darwin") return "alpha";
  return "stable";
}

function electronUpdaterChannelPath(app) {
  return path.join(app.getPath("userData"), ELECTRON_UPDATER_CHANNEL_FILENAME);
}

async function readElectronUpdaterChannel(app, manifestChannel = "latest") {
  try {
    const raw = await readFile(electronUpdaterChannelPath(app), "utf8");
    const parsed = JSON.parse(raw);
    return normalizeElectronUpdaterChannel(parsed?.channel, manifestChannel);
  } catch {
    return "stable";
  }
}

async function writeElectronUpdaterChannel(app, channel, manifestChannel = "latest") {
  const normalized = normalizeElectronUpdaterChannel(channel, manifestChannel);
  const outputPath = electronUpdaterChannelPath(app);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    `${JSON.stringify({ channel: normalized, writtenAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
  return normalized;
}

function electronUpdaterFeedUrl(channel, manifestChannel = "latest") {
  return ELECTRON_UPDATER_FEEDS[normalizeElectronUpdaterChannel(channel, manifestChannel)];
}

function normalizeStableTargetVersion(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/^v/i, "");
  return /^\d+\.\d+\.\d+$/.test(normalized) ? normalized : null;
}

function parseComparableVersion(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/^v/i, "");
  if (!normalized) return null;

  const [versionCore] = normalized.split("+", 1);
  if (!versionCore) return null;

  const [releasePart, prereleasePart = ""] = versionCore.split("-", 2);
  const release = releasePart.split(".").map((segment) => Number(segment));
  if (!release.length || release.some((segment) => !Number.isInteger(segment) || segment < 0)) {
    return null;
  }

  const prerelease = prereleasePart
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);

  return { release, prerelease };
}

function comparePrereleaseIdentifiers(left, right) {
  if (!left.length && !right.length) return 0;
  if (!left.length) return 1;
  if (!right.length) return -1;

  const count = Math.max(left.length, right.length);
  for (let index = 0; index < count; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;

    const leftNumeric = /^\d+$/.test(leftPart) ? Number(leftPart) : null;
    const rightNumeric = /^\d+$/.test(rightPart) ? Number(rightPart) : null;

    if (leftNumeric !== null && rightNumeric !== null) {
      if (leftNumeric !== rightNumeric) return leftNumeric < rightNumeric ? -1 : 1;
      continue;
    }

    if (leftNumeric !== null) return -1;
    if (rightNumeric !== null) return 1;

    const comparison = leftPart.localeCompare(rightPart);
    if (comparison !== 0) return comparison < 0 ? -1 : 1;
  }

  return 0;
}

function compareVersions(left, right) {
  const parsedLeft = parseComparableVersion(left);
  const parsedRight = parseComparableVersion(right);
  if (!parsedLeft || !parsedRight) return null;

  const count = Math.max(parsedLeft.release.length, parsedRight.release.length);
  for (let index = 0; index < count; index += 1) {
    const leftPart = parsedLeft.release[index] ?? 0;
    const rightPart = parsedRight.release[index] ?? 0;
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
  }

  return comparePrereleaseIdentifiers(parsedLeft.prerelease, parsedRight.prerelease);
}

function isVersionNewer(candidate, current) {
  const comparison = compareVersions(candidate, current);
  return comparison === null ? candidate !== current : comparison > 0;
}

export function targetedStableUpdaterFeed(currentVersion, targetVersion, allowOlder = false) {
  const normalizedTarget = normalizeStableTargetVersion(targetVersion);
  if (!normalizedTarget) {
    throw new Error("Target update version must use the stable x.y.z format.");
  }
  const comparison = compareVersions(normalizedTarget, currentVersion);
  if (comparison === null) {
    throw new Error("Installed version could not be validated for a targeted update.");
  }
  if (comparison === 0 || (!allowOlder && comparison < 0)) {
    throw new Error(allowOlder
      ? "Recovery target version must differ from the installed version."
      : "Target update version must be newer than the installed version.");
  }
  return `https://github.com/different-ai/openwork/releases/download/v${normalizedTarget}`;
}

function updaterChannelState(app, channel, targetVersion = null, manifestChannel = "latest") {
  const normalized = normalizeElectronUpdaterChannel(channel, manifestChannel);
  const currentVersion = resolveAppVersion(app);
  return {
    channel: normalized,
    feedUrl: targetVersion
      ? targetedStableUpdaterFeed(currentVersion, targetVersion)
      : electronUpdaterFeedUrl(normalized, manifestChannel),
    currentVersion,
  };
}

async function applyElectronUpdaterFeed(
  app,
  updater,
  targetVersion = null,
  manifestChannel = "latest",
  allowOlder = false,
  channelOverride,
) {
  const channel = channelOverride === undefined
    ? await readElectronUpdaterChannel(app, manifestChannel)
    : normalizeElectronUpdaterChannel(channelOverride, manifestChannel);
  if (targetVersion && channel !== "stable") {
    throw new Error("Version-specific update feeds are supported only on the stable channel.");
  }
  const currentVersion = resolveAppVersion(app);
  const state = targetVersion
    ? {
        channel,
        feedUrl: targetedStableUpdaterFeed(currentVersion, targetVersion, allowOlder),
        currentVersion,
      }
    : updaterChannelState(app, channel, null, manifestChannel);
  updater.allowPrerelease = state.channel === "alpha";
  // Moving from alpha back to stable can be a semver downgrade; still show
  // the latest stable so users can return to the stable channel deliberately.
  updater.allowDowngrade = state.channel === "stable" && (!targetVersion || allowOlder);
  // Select the manifest through the generic provider's own `channel` option
  // rather than AppUpdater#channel: that setter is a no-op unless the instance
  // was constructed with a channel, which would silently leave a custom
  // distribution reading latest*.yml and updating itself into the public app.
  // Public builds pass no channel and keep the provider's `latest` default.
  if (updater?.setFeedURL) {
    updater.setFeedURL({
      provider: "generic",
      url: state.feedUrl,
      ...(manifestChannel !== "latest" ? { channel: manifestChannel } : {}),
    });
  }
  return state;
}

function runDefaults(args) {
  return new Promise((resolve) => {
    execFile("/usr/bin/defaults", args, (error) => {
      // Best-effort: a failure here just means we fall back to Squirrel's
      // default move-based install. Never block the update on it.
      if (error) console.warn("[updater] defaults write failed", error?.message ?? error);
      resolve(undefined);
    });
  });
}

// Squirrel.Mac's `ShipIt` helper (which swaps the .app on macOS) reads its
// options from this NSUserDefaults domain.
const SHIP_IT_DEFAULTS_DOMAIN = "com.differentai.openwork.ShipIt";

// Squirrel.Mac defaults to moving the *entire* app bundle through a temp
// directory. On repeat installs that move can leave the staged bundle missing,
// producing:
//   "Failed to copy bundle … no such file or directory"
//   "Too many attempts to install, aborting update"
// and silently relaunching the OLD app (so the in-app version looks updated
// while the on-disk renderer stays stale). Enabling DirectContentsWrite makes
// ShipIt write file contents in place instead of moving whole bundles, which
// avoids the ENOENT abort.
async function enableSquirrelDirectContentsWrite(
  shipItDefaultsDomain = SHIP_IT_DEFAULTS_DOMAIN,
) {
  if (process.platform !== "darwin") return;
  await runDefaults(["write", shipItDefaultsDomain, "SquirrelMacEnableDirectContentsWrite", "-bool", "YES"]);
}

// Path of the ShipIt cache that, when stuck, keeps aborting future installs.
// Exported for tests.
export function staleUpdaterStatePaths(app, shipItDefaultsDomain = SHIP_IT_DEFAULTS_DOMAIN) {
  if (process.platform !== "darwin") return [];
  const home = app.getPath("home");
  return [path.join(home, "Library", "Caches", shipItDefaultsDomain)];
}

// Remove a previously-failed, half-applied update so the next attempt starts
// from a clean slate. A stuck `ShipIt` state (after "Too many attempts to
// install, aborting update") can otherwise keep aborting future installs.
async function cleanStaleUpdaterState(app, shipItDefaultsDomain) {
  for (const target of staleUpdaterStatePaths(app, shipItDefaultsDomain)) {
    try {
      await rm(target, { recursive: true, force: true });
    } catch (error) {
      console.warn("[updater] failed to clean stale state", target, error?.message ?? error);
    }
  }
}

// electron-updater wiring. Packaged-only; dev builds skip this so the
// updater doesn't try to probe a non-existent release channel.
export function preventPendingUpdaterInstall(updater) {
  if (updater) updater.autoInstallOnAppQuit = false;
}

export function registerUpdaterIpc({
  app,
  ipcMain,
  getMainWindow,
  loadAutoUpdater = () => import("electron-updater"),
  manifestChannel = "latest",
  shipItDefaultsDomain = SHIP_IT_DEFAULTS_DOMAIN,
  electronNet = null,
  shell = null,
  distribution = "public",
  platform = process.platform,
  arch = process.arch,
  env = process.env,
}) {
  let autoUpdaterInstance = null;
  let autoUpdaterLoadPromise = null;
  let checkedUpdateVersion = null;
  let checkedUpdateTargetVersion = null;
  let checkedUpdateChannel = null;
  let updateDownloaded = false;
  let recoveryReleases = [];
  const recoveryWitness = { installRequests: [], openedArtifactUrls: [], quitRequested: false };
  let updaterOperationQueue = Promise.resolve();

  function queueUpdaterOperation(operation) {
    const result = updaterOperationQueue.then(operation, operation);
    updaterOperationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  function sendToRenderer(channel, data) {
    try {
      const win = typeof getMainWindow === "function" ? getMainWindow() : null;
      if (win?.webContents && !win.isDestroyed()) {
        win.webContents.send(channel, data);
      }
    } catch {
      // Window may be closed; swallow send failures.
    }
  }

  async function ensureAutoUpdater() {
    if (!app.isPackaged) return null;
    if (!autoUpdaterLoadPromise) {
      autoUpdaterLoadPromise = (async () => {
        try {
          const mod = await loadAutoUpdater();
          autoUpdaterInstance = mod.autoUpdater ?? mod.default?.autoUpdater ?? null;
          if (autoUpdaterInstance) {
            autoUpdaterInstance.autoDownload = false;
            autoUpdaterInstance.autoInstallOnAppQuit = true;
            // Differential (blockmap) downloads reconstruct the update zip from the
            // installed app + a diff. On macOS that reconstructed bundle is what
            // feeds Squirrel's fragile move-based install, and is a common trigger
            // for the "Failed to copy bundle … no such file" abort. Download the
            // full zip instead — alpha builds are swapped wholesale anyway.
            autoUpdaterInstance.disableDifferentialDownload = true;
            // Make Squirrel.Mac write contents in place rather than moving whole
            // bundles (see enableSquirrelDirectContentsWrite for why).
            await enableSquirrelDirectContentsWrite(shipItDefaultsDomain);
            autoUpdaterInstance.on("error", (err) => {
              // Do not invalidate a staged download on arbitrary updater errors.
              // A later transient check failure does not delete the downloaded
              // update; quitAndInstall reports a descriptive failure if it is gone.
              console.warn("[updater] error", err);
            });
            autoUpdaterInstance.on("update-downloaded", () => {
              updateDownloaded = true;
            });
            // Forward download progress to the renderer so the UI can show
            // incremental bytes instead of staying stuck at 0.
            autoUpdaterInstance.on("download-progress", (info) => {
              sendToRenderer("openwork:updater:download-progress", {
                bytesPerSecond: info.bytesPerSecond ?? 0,
                percent: info.percent ?? 0,
                transferred: info.transferred ?? 0,
                total: info.total ?? 0,
                delta: info.delta ?? 0,
              });
            });
            await applyElectronUpdaterFeed(app, autoUpdaterInstance, null, manifestChannel);
          }
        } catch (error) {
          console.warn("[updater] electron-updater not available", error);
          autoUpdaterInstance = null;
        }
        return autoUpdaterInstance;
      })();
    }
    return autoUpdaterLoadPromise;
  }

  async function resolveRecoveryArtifact(version) {
    if (!electronNet?.fetch) return null;
    try {
      const manifestUrl = `https://github.com/different-ai/openwork/releases/download/v${version}/${recoveryManifestName(platform, arch, distribution)}`;
      const response = await electronNet.fetch(manifestUrl, { headers: { Accept: "text/yaml, text/plain, */*" } });
      if (!response.ok) return null;
      return selectRecoveryArtifact(parseRecoveryManifest(await response.text()), {
        version,
        platform,
        arch,
        distribution,
      });
    } catch {
      return null;
    }
  }

  async function cacheCurrentHealthyRelease() {
    if (!electronNet?.fetch) return null;
    const currentVersion = stableVersion(resolveAppVersion(app));
    if (!currentVersion) return null;
    const state = await readRecoveryState(app, distribution);
    if (state.currentVersion !== currentVersion) return null;
    const existing = await readCachedRecoveryArtifact(app, { platform, arch, distribution });
    if (existing?.artifact.version === currentVersion) return existing;
    const artifact = await resolveRecoveryArtifact(currentVersion);
    if (!artifact) return null;
    const filePath = await cacheVerifiedRecoveryArtifact({
      app,
      artifact,
      fetchArtifact: (url) => electronNet.fetch(url),
    });
    return { artifact, filePath };
  }

  function evalRecoveryReleases() {
    if (typeof env.OPENWORK_EVAL_RECOVERY_RELEASES === "string") {
      try {
        const target = String(env.OPENWORK_EVAL_RECOVERY_TARGET ?? "").split("-");
        const targetPlatform = target[0];
        const targetArch = target[1];
        const targetDistribution = target.slice(2).join("-");
        const raw = JSON.parse(env.OPENWORK_EVAL_RECOVERY_RELEASES);
        const stable = Array.isArray(raw) ? raw.filter((release) =>
          stableVersion(release?.version)
          && release?.channel === "stable"
          && release?.artifact?.platform === targetPlatform
          && release?.artifact?.arch === targetArch
          && release?.artifact?.distribution === targetDistribution
          && typeof release?.artifact?.url === "string",
        ) : [];
        return stable.map((release, index) => ({
          id: release.version,
          version: release.version,
          marking: index === 0 ? "current" : index === 1 ? "previous" : null,
          artifact: release.artifact,
          cachedFilePath: null,
          eval: true,
        }));
      } catch {
        return [];
      }
    }
    if (typeof env.OPENWORK_EVAL_RECOVERY_CANDIDATES === "string") {
      try {
        const raw = JSON.parse(env.OPENWORK_EVAL_RECOVERY_CANDIDATES);
        return Array.isArray(raw) ? raw.filter((candidate) =>
          candidate?.verified === true
          && stableVersion(candidate?.version)
          && typeof candidate?.artifactUrl === "string",
        ).map((candidate) => ({
          id: candidate.version,
          version: candidate.version,
          marking: "previous",
          artifact: { platform, arch, distribution, url: candidate.artifactUrl },
          cachedFilePath: null,
          eval: true,
        })) : [];
      } catch {
        return [];
      }
    }
    return null;
  }

  ipcMain.handle("openwork:recovery:recordHealthy", async () => {
    return recordHealthyVersion(app, distribution, resolveAppVersion(app));
  });

  ipcMain.handle("openwork:recovery:list", async (_event, policy = {}) => {
    const evalReleases = evalRecoveryReleases();
    if (evalReleases) {
      recoveryReleases = evalReleases;
      return {
        ok: true,
        releases: recoveryReleases.map(({ id, version, marking }) => ({ id, version, marking })),
      };
    }
    const state = await readRecoveryState(app, distribution);
    const installedVersion = resolveAppVersion(app);
    const markers = recoveryVersionMarkers(installedVersion, state);
    const cached = await readCachedRecoveryArtifact(app, { platform, arch, distribution });
    const catalogVersions = Array.isArray(policy?.versions) ? policy.versions : [];
    const localOnly = catalogVersions.length === 0;
    recoveryReleases = await compatibleRecoveryReleases({
      versions: [
        ...catalogVersions,
        installedVersion,
        ...(state.currentVersion ? [state.currentVersion] : []),
        ...(state.previousVersion ? [state.previousVersion] : []),
        ...(cached ? [cached.artifact.version] : []),
      ],
      currentVersion: markers.currentVersion,
      previousVersion: markers.previousVersion,
      minimumVersion: policy?.minimumVersion,
      allowedVersions: policy?.allowedVersions,
      resolveArtifact: async (version) =>
        cached?.artifact.version === version
          ? { ...cached.artifact, cachedFilePath: cached.filePath }
          : localOnly ? null : resolveRecoveryArtifact(version),
    });
    return {
      ok: true,
      releases: recoveryReleases.map(({ id, version, marking }) => ({ id, version, marking })),
    };
  });

  async function useRecoveryRelease(rawId) {
    const id = stableVersion(rawId);
    const release = id ? recoveryReleases.find((candidate) => candidate.id === id) : null;
    if (!release) return { ok: false, reason: "That recovery version is no longer available. Retry the release list." };
    if (release.eval) {
      if (env.OPENWORK_EVAL_RECOVERY_CANDIDATES) {
        recoveryWitness.installRequests.push({ version: release.version, artifactUrl: release.artifact.url });
      } else {
        recoveryWitness.openedArtifactUrls.push(release.artifact.url);
      }
      return { ok: true, action: "eval" };
    }
    if (compareStableVersions(release.version, resolveAppVersion(app)) === 0) {
      return { ok: false, reason: "That version is already installed." };
    }
    if (release.cachedFilePath) {
      if (!(await verifyCachedRecoveryArtifact(release.cachedFilePath, release.artifact))) {
        return { ok: false, reason: "The cached recovery installer could not be verified. Retry while online." };
      }
      if (!shell?.openPath) return { ok: false, reason: "This package cannot open the recovery installer." };
      const openError = await shell.openPath(release.cachedFilePath);
      if (openError) return { ok: false, reason: openError };
      return {
        ok: true,
        action: "installer",
        message: "The verified installer is open. Follow the operating system steps to finish.",
      };
    }
    const freshArtifact = await resolveRecoveryArtifact(release.version);
    if (!freshArtifact || freshArtifact.url !== release.artifact.url || freshArtifact.sha512 !== release.artifact.sha512) {
      return { ok: false, reason: "This installer could not be verified. Refresh the list and try again." };
    }
    const currentVersion = resolveAppVersion(app);
    const updater = await ensureAutoUpdater();
    if (updater && app.isPackaged) {
      try {
        await applyElectronUpdaterFeed(app, updater, release.version, manifestChannel, true);
        const result = await updater.checkForUpdates();
        if (compareVersions(result?.updateInfo?.version ?? "", release.version) !== 0) {
          throw new Error("Recovery manifest resolved to a different version.");
        }
        if (compareStableVersions(release.version, currentVersion) === null) {
          throw new Error("Installed version could not be validated.");
        }
        updater.autoInstallOnAppQuit = true;
        await updater.downloadUpdate();
        updater.quitAndInstall(false, true);
        return { ok: true, action: "install" };
      } catch (error) {
        preventPendingUpdaterInstall(updater);
        return { ok: false, reason: String(error?.message ?? error) };
      }
    }
    if (!electronNet?.fetch || !shell?.openPath) return { ok: false, reason: "Automatic recovery is unavailable on this package." };
    try {
      const filePath = await cacheVerifiedRecoveryArtifact({
        app,
        artifact: freshArtifact,
        fetchArtifact: (url) => electronNet.fetch(url),
      });
      if (!(await verifyCachedRecoveryArtifact(filePath, freshArtifact))) {
        return { ok: false, reason: "The downloaded recovery installer could not be verified." };
      }
      const openError = await shell.openPath(filePath);
      if (openError) return { ok: false, reason: openError };
      return { ok: true, action: "installer", message: "The verified installer is open. Follow the operating system steps to finish." };
    } catch (error) {
      return { ok: false, reason: String(error?.message ?? error) };
    }
  }

  ipcMain.handle("openwork:recovery:use", async (_event, id) =>
    queueUpdaterOperation(() => useRecoveryRelease(id)));
  ipcMain.handle("openwork:recovery:restorePrevious", async () => {
    return queueUpdaterOperation(() => {
      const previous = recoveryReleases.find((release) => release.marking === "previous");
      return previous ? useRecoveryRelease(previous.id) : { ok: false, reason: "No verified previous version is available." };
    });
  });
  ipcMain.handle("openwork:recovery:evalSnapshot", async () => ({
    candidates: recoveryReleases,
    releases: recoveryReleases,
    ...recoveryWitness,
  }));

  ipcMain.handle("openwork:updater:getChannel", async () => queueUpdaterOperation(async () => {
    const channel = await readElectronUpdaterChannel(app, manifestChannel);
    return updaterChannelState(app, channel, null, manifestChannel);
  }));

  ipcMain.handle("openwork:updater:setChannel", async (_event, rawChannel) => queueUpdaterOperation(async () => {
    const channel = await writeElectronUpdaterChannel(app, rawChannel, manifestChannel);
    checkedUpdateVersion = null;
    checkedUpdateTargetVersion = null;
    checkedUpdateChannel = null;
    updateDownloaded = false;
    const updater = await ensureAutoUpdater();
    if (updater) {
      // A channel change invalidates any previously downloaded update. This
      // also prevents an Alpha build from installing automatically on quit
      // after an organization policy moves the desktop back to Stable.
      preventPendingUpdaterInstall(updater);
      return applyElectronUpdaterFeed(app, updater, null, manifestChannel, false, channel);
    }
    return updaterChannelState(app, channel, null, manifestChannel);
  }));

  ipcMain.handle("openwork:updater:check", async (_event, rawChannel, rawTargetVersion) => queueUpdaterOperation(async () => {
    // A check selects a feed for this operation only. The persisted preference
    // belongs exclusively to setChannel so a stale check cannot undo a choice.
    const channel = rawChannel === undefined
      ? await readElectronUpdaterChannel(app, manifestChannel)
      : normalizeElectronUpdaterChannel(rawChannel, manifestChannel);
    const updater = await ensureAutoUpdater();
    try {
      const targetVersion = rawTargetVersion === undefined
        ? null
        : normalizeStableTargetVersion(rawTargetVersion);
      if (rawTargetVersion !== undefined && !targetVersion) {
        throw new Error("Target update version must use the stable x.y.z format.");
      }
      const channelState = updater
        ? await applyElectronUpdaterFeed(app, updater, targetVersion, manifestChannel, false, channel)
        : updaterChannelState(app, channel, targetVersion, manifestChannel);
      if (!updater) return { available: false, reason: "unavailable", ...channelState };

      const result = await updater.checkForUpdates();
      const info = result?.updateInfo ?? null;
      const currentVersion = resolveAppVersion(app);
      if (targetVersion && compareVersions(info?.version ?? "", targetVersion) !== 0) {
        throw new Error(`Target update manifest did not resolve to v${targetVersion}.`);
      }
      const available = Boolean(info?.version && isVersionNewer(info.version, currentVersion));
      checkedUpdateVersion = available ? info.version : null;
      checkedUpdateTargetVersion = available ? targetVersion : null;
      checkedUpdateChannel = available ? channelState.channel : null;
      if (!available) updateDownloaded = false;
      return {
        available,
        currentVersion,
        latestVersion: targetVersion ?? info?.version ?? null,
        releaseDate: info?.releaseDate ?? null,
        releaseNotes: info?.releaseNotes ?? null,
        ...channelState,
      };
    } catch (error) {
      checkedUpdateVersion = null;
      checkedUpdateTargetVersion = null;
      checkedUpdateChannel = null;
      // A transient failed check must not invalidate an already-downloaded update.
      return {
        available: false,
        reason: String(error?.message ?? error),
        ...updaterChannelState(
          app,
          channel,
          null,
          manifestChannel,
        ),
      };
    }
  }));

  ipcMain.handle("openwork:updater:download", async () => queueUpdaterOperation(async () => {
    const updater = await ensureAutoUpdater();
    if (!updater) return { ok: false, reason: "unavailable" };
    try {
      await applyElectronUpdaterFeed(
        app,
        updater,
        checkedUpdateTargetVersion,
        manifestChannel,
        false,
        checkedUpdateChannel ?? undefined,
      );
      const currentVersion = resolveAppVersion(app);
      if (!checkedUpdateVersion || !isVersionNewer(checkedUpdateVersion, currentVersion)) {
        const result = await updater.checkForUpdates();
        const info = result?.updateInfo ?? null;
        if (
          checkedUpdateTargetVersion &&
          compareVersions(info?.version ?? "", checkedUpdateTargetVersion) !== 0
        ) {
          throw new Error(`Target update manifest did not resolve to v${checkedUpdateTargetVersion}.`);
        }
        checkedUpdateVersion = info?.version && isVersionNewer(info.version, currentVersion)
          ? info.version
          : null;
      }
      if (!checkedUpdateVersion) {
        return { ok: false, reason: "No update available." };
      }
      await cacheCurrentHealthyRelease().catch((error) => {
        console.warn("[updater] could not cache the current healthy installer", error);
      });
      // Clear any stuck ShipIt state from a prior aborted install so this
      // download applies cleanly on quit.
      await cleanStaleUpdaterState(app, shipItDefaultsDomain);
      updater.autoInstallOnAppQuit = true;
      await updater.downloadUpdate();
      updateDownloaded = true;
      return { ok: true };
    } catch (error) {
      updateDownloaded = false;
      return { ok: false, reason: String(error?.message ?? error) };
    }
  }));

  ipcMain.handle("openwork:updater:installAndRestart", async () => queueUpdaterOperation(async () => {
    if (!updateDownloaded) return { ok: false, reason: "update-not-downloaded" };
    const updater = await ensureAutoUpdater();
    if (!updater) return { ok: false, reason: "unavailable" };
    try {
      // Re-assert the in-place-write default right before the swap; the ShipIt
      // defaults domain may have been wiped when stale state was cleaned.
      await enableSquirrelDirectContentsWrite();
      updater.quitAndInstall(false, true);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: String(error?.message ?? error) };
    }
  }));

  return { ensureAutoUpdater };
}
