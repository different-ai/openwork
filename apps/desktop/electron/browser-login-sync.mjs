// Keep selected built-in-browser logins in step with a browser profile.
//
// Consent and policy are separate: policy only makes setup available, while
// the user explicitly chooses one profile and the sites OpenWork may keep
// reading. Cookie values stay inside this main-process module. Persisted state,
// IPC responses, renderer state, and errors contain metadata only.
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { watch as watchFileSystem } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { session } from "electron";
import {
  BUILTIN_BROWSER_PARTITION,
  cookiesForSites,
  fromElectronCookie,
  groupCookiesIntoSites,
  importSourceAvailability,
  registrableDomain,
  toElectronCookie,
} from "@openwork/browser-logins";
import {
  chromiumProfileCandidates,
  deriveChromiumKey,
  firefoxProfileCandidates,
  readChromiumCookieMetadata,
  readChromiumCookies,
  readFirefoxCookieMetadata,
  readFirefoxCookies,
  sqliteCompanionFiles,
} from "@openwork/browser-logins/node";

const require = createRequire(import.meta.url);
const PREVIEW_TTL_MS = 10 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_WATCH_DEBOUNCE_MS = 750;
const POLICY_OFF_MESSAGE = "Browser login sync is turned off. An administrator can make it available in desktop policies.";

function defaultOpenDatabase(filePath) {
  const Database = require("better-sqlite3");
  return new Database(filePath, { readonly: true, fileMustExist: true });
}

function defaultReadKeychainPassword(service) {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/security", ["find-generic-password", "-wa", service], { timeout: 120_000 }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || error.message || "");
        if (/could not be found/i.test(detail)) {
          reject(new Error("key-not-found"));
        } else if (/User interaction is not allowed|canceled|denied/i.test(detail)) {
          reject(new Error("key-denied"));
        } else {
          reject(new Error("key-unavailable"));
        }
        return;
      }
      resolve(String(stdout).replace(/\r?\n$/, ""));
    });
  });
}

function publicSource(source) {
  return { id: source.id, browser: source.browser, label: source.label, profile: source.profile };
}

function emptySyncState() {
  return {
    version: 1,
    userEnabled: false,
    source: null,
    selectedSites: [],
    managedCookies: [],
    status: "not_configured",
    lastSyncedAt: null,
    errorCode: null,
    sourceFingerprint: null,
  };
}

function normalizedSites(sites) {
  return [...new Set((Array.isArray(sites) ? sites : []).map((site) => registrableDomain(String(site))).filter(Boolean))].sort();
}

function normalizeManagedCookie(value) {
  if (!value || typeof value !== "object") return null;
  const host = String(value.host ?? "");
  const name = String(value.name ?? "");
  const cookiePath = String(value.path ?? "/");
  const site = registrableDomain(String(value.site ?? host));
  if (!host || !name || !site) return null;
  return { host, name, path: cookiePath, secure: value.secure === true, site };
}

function normalizePersistedState(value) {
  if (!value || typeof value !== "object" || Number(value.version) !== 1) return emptySyncState();
  const source = value.source && typeof value.source === "object"
    && typeof value.source.id === "string"
    && typeof value.source.browser === "string"
    && typeof value.source.label === "string"
    && typeof value.source.profile === "string"
    ? publicSource(value.source)
    : null;
  if (!source) return emptySyncState();
  const selectedSites = normalizedSites(value.selectedSites);
  return {
    version: 1,
    // A persisted enrollment never resumes from a renderer policy signal.
    // Each Desktop launch starts paused until a native-confirmed Resume.
    userEnabled: false,
    source,
    selectedSites,
    managedCookies: (Array.isArray(value.managedCookies) ? value.managedCookies : []).map(normalizeManagedCookie).filter(Boolean),
    status: "paused",
    lastSyncedAt: typeof value.lastSyncedAt === "number" ? value.lastSyncedAt : null,
    errorCode: null,
    sourceFingerprint: typeof value.sourceFingerprint === "string" ? value.sourceFingerprint : null,
  };
}

function cookieIdentity(cookie) {
  return `${String(cookie.host).toLowerCase()}\u0000${String(cookie.path || "/")}\u0000${String(cookie.name)}`;
}

function managedCookie(cookie) {
  return {
    host: String(cookie.host),
    name: String(cookie.name),
    path: String(cookie.path || "/"),
    secure: cookie.secure === true,
    site: registrableDomain(cookie.host),
  };
}

function managedCookieIdentity(cookie) {
  return cookieIdentity(cookie);
}

function syncErrorCode(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/profile is no longer available|ENOENT|no such file/i.test(message)) return "source_missing";
  if (/key-denied/i.test(message)) return "key_denied";
  if (/key-not-found|key-unavailable|no-key/i.test(message)) return "key_unavailable";
  if (/source-changing/i.test(message)) return "source_busy";
  if (/app-bound-encryption/i.test(message)) return "unsupported_encryption";
  return "read_failed";
}

function isSyncCancelled(error) {
  return error instanceof Error && error.message === "sync-cancelled";
}

function sourceFileSuffix(sourcePath, filePath) {
  return filePath.slice(sourcePath.length);
}

async function describeSourceFiles(sourcePath) {
  const files = [sourcePath, ...sqliteCompanionFiles(sourcePath)];
  const entries = [];
  for (const filePath of files) {
    const details = await stat(filePath);
    entries.push({ filePath, suffix: sourceFileSuffix(sourcePath, filePath), size: details.size, mtimeMs: details.mtimeMs });
  }
  const digest = createHash("sha256");
  for (const entry of entries) digest.update(`${entry.suffix}\u0000${entry.size}\u0000${entry.mtimeMs}\n`);
  return { files: entries, fingerprint: digest.digest("hex") };
}

/**
 * @typedef {{
 *   cookies: {
 *     set(details: import("@openwork/browser-logins").ElectronCookieDetails): Promise<void>,
 *     get(filter: Record<string, unknown>): Promise<Array<import("@openwork/browser-logins").ElectronCookieLike>>,
 *     remove(url: string, name: string): Promise<void>,
 *     flushStore?: () => Promise<void>,
 *   },
 *   clearStorageData(options?: { origin?: string }): Promise<void>,
 * }} LoginSession
 */

/**
 * @param {{
 *   partition?: string,
 *   platform?: string,
 *   home?: string,
 *   env?: Record<string, string | undefined>,
 *   statePath?: string | null,
 *   readKeychainPassword?: (service: string) => Promise<string>,
 *   openDatabase?: (filePath: string) => { prepare(sql: string): { all(): Array<Record<string, unknown>> }, close(): void },
 *   getSession?: () => LoginSession,
 *   now?: () => number,
 *   pollIntervalMs?: number,
 *   watchSource?: typeof watchFileSystem | null,
 *   watchDebounceMs?: number,
 *   confirmUserAction?: (input: { action: "discover" | "read" | "configure" | "resume", source: { id: string, browser: string, label: string, profile: string } | null, sites?: string[] }) => Promise<boolean>,
 * }} [options]
 */
export function createBrowserLoginSync({
  partition = BUILTIN_BROWSER_PARTITION,
  platform = process.platform,
  home = homedir(),
  env = process.env,
  statePath = null,
  readKeychainPassword = defaultReadKeychainPassword,
  openDatabase = defaultOpenDatabase,
  getSession = () => session.fromPartition(partition),
  now = Date.now,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  watchSource = watchFileSystem,
  watchDebounceMs = DEFAULT_WATCH_DEBOUNCE_MS,
  confirmUserAction = async () => true,
} = {}) {
  let policyAllowed = false;
  let policyInitialized = false;
  let state = emptySyncState();
  let stateLoaded = false;
  let stateLoad = null;
  let persistTail = Promise.resolve();
  let syncInFlight = null;
  let mutationInFlight = null;
  let pollTimer = null;
  let watchHandle = null;
  let watchTimer = null;
  let lifecycleGeneration = 0;
  const previews = new Map();
  const testSources = [];
  const chromiumKeys = new Map();

  function publicState() {
    const configured = state.source !== null && state.selectedSites.length > 0;
    const status = !policyAllowed ? "policy_off" : !configured ? "not_configured" : state.status;
    return {
      policyAllowed,
      configured,
      active: policyAllowed && configured && state.userEnabled,
      source: state.source,
      selectedSites: [...state.selectedSites],
      status,
      lastSyncedAt: state.lastSyncedAt,
      errorCode: state.errorCode,
      managedCookieCount: state.managedCookies.length,
    };
  }

  async function ensureStateLoaded() {
    if (stateLoaded) return;
    if (!stateLoad) {
      stateLoad = (async () => {
        if (statePath) {
          try {
            state = normalizePersistedState(JSON.parse(await readFile(statePath, "utf8")));
          } catch (error) {
            if (!(error && typeof error === "object" && error.code === "ENOENT")) state = emptySyncState();
          }
        }
        stateLoaded = true;
      })();
    }
    await stateLoad;
  }

  function persistableState() {
    return {
      version: 1,
      userEnabled: state.userEnabled,
      source: state.source,
      selectedSites: state.selectedSites,
      managedCookies: state.managedCookies,
      lastSyncedAt: state.lastSyncedAt,
      sourceFingerprint: state.sourceFingerprint,
    };
  }

  function persistState() {
    if (!statePath) return Promise.resolve();
    const body = `${JSON.stringify(persistableState(), null, 2)}\n`;
    persistTail = persistTail.then(async () => {
      await mkdir(path.dirname(statePath), { recursive: true });
      const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, body, { encoding: "utf8", mode: 0o600 });
      try {
        await rename(temporaryPath, statePath);
      } catch (error) {
        await rm(temporaryPath, { force: true });
        throw error;
      }
    });
    return persistTail;
  }

  function assertPolicyAllowed() {
    if (!policyAllowed) throw new Error(POLICY_OFF_MESSAGE);
  }

  function discoverProfiles() {
    const chromiumAllowed = importSourceAvailability(platform).find((entry) => entry.browser === "chrome")?.importable === true;
    const chromium = chromiumAllowed
      ? chromiumProfileCandidates({ platform, home, localAppData: env.LOCALAPPDATA ?? null })
      : [];
    const firefox = firefoxProfileCandidates({ platform, home, appData: env.APPDATA ?? null });
    return [...chromium, ...firefox, ...testSources];
  }

  function resolveSource(sourceId) {
    const source = discoverProfiles().find((candidate) => candidate.id === sourceId);
    if (!source) throw new Error("That browser profile is no longer available.");
    return source;
  }

  async function chromiumKey(source) {
    if (platform === "win32") throw new Error("app-bound-encryption");
    if (platform === "linux") throw new Error("key-unavailable");
    if (chromiumKeys.has(source.id)) return chromiumKeys.get(source.id);
    const password = await readKeychainPassword(source.keychainService);
    const key = deriveChromiumKey(password, { platform });
    chromiumKeys.set(source.id, key);
    return key;
  }

  async function copyStableSource(source) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = await describeSourceFiles(source.path);
      const copyDir = await mkdtemp(path.join(tmpdir(), "openwork-login-sync-"));
      const copyPath = path.join(copyDir, "cookies.sqlite");
      try {
        for (const file of before.files) await copyFile(file.filePath, `${copyPath}${file.suffix}`);
        const after = await describeSourceFiles(source.path);
        if (before.fingerprint === after.fingerprint) {
          return { copyDir, copyPath, fingerprint: after.fingerprint };
        }
      } catch (error) {
        await rm(copyDir, { recursive: true, force: true });
        if (attempt === 2) throw error;
        continue;
      }
      await rm(copyDir, { recursive: true, force: true });
    }
    throw new Error("source-changing");
  }

  async function readSourceCookies(source, { sites = null, metadataOnly = false } = {}) {
    const snapshot = await copyStableSource(source);
    try {
      const db = openDatabase(snapshot.copyPath);
      try {
        const query = (sql, params = []) => {
          const statement = db.prepare(sql);
          return Reflect.apply(statement.all, statement, params);
        };
        if (metadataOnly) {
          const cookies = source.browser === "firefox" ? readFirefoxCookieMetadata(query) : readChromiumCookieMetadata(query);
          return { cookies, undecryptable: 0, version: null, fingerprint: snapshot.fingerprint };
        }
        const key = source.browser === "firefox" ? null : await chromiumKey(source);
        const result = source.browser === "firefox"
          ? readFirefoxCookies(query, { sites, httpOnlyOnly: true })
          : readChromiumCookies(query, { key, sites, httpOnlyOnly: true });
        return { ...result, fingerprint: snapshot.fingerprint };
      } finally {
        db.close();
      }
    } finally {
      await rm(snapshot.copyDir, { recursive: true, force: true });
    }
  }

  function expirePreviews() {
    const cutoff = now() - PREVIEW_TTL_MS;
    for (const [id, entry] of previews) if (entry.createdAt < cutoff) previews.delete(id);
  }

  async function listSources() {
    await ensureStateLoaded();
    assertPolicyAllowed();
    if (!(await confirmUserAction({ action: "discover", source: null }))) {
      throw new Error("Browser login sync setup was cancelled.");
    }
    assertPolicyAllowed();
    return {
      availability: importSourceAvailability(platform),
      profiles: discoverProfiles().map(publicSource),
    };
  }

  /** Read one discovered source only after the user opens setup. */
  /** @param {{ sourceId?: unknown }} [request] */
  async function preview({ sourceId } = {}) {
    await ensureStateLoaded();
    assertPolicyAllowed();
    expirePreviews();
    const source = resolveSource(String(sourceId ?? ""));
    if (!(await confirmUserAction({ action: "read", source: publicSource(source) }))) {
      throw new Error("Browser login sync setup was cancelled.");
    }
    assertPolicyAllowed();
    const result = await readSourceCookies(source, { metadataOnly: true });
    assertPolicyAllowed();
    const previewId = randomUUID();
    const syncableCookies = result.cookies.filter((cookie) => cookie.httpOnly === true);
    previews.set(previewId, { source, cookies: syncableCookies, undecryptable: result.undecryptable, fingerprint: result.fingerprint, createdAt: now() });
    return {
      previewId,
      source: publicSource(source),
      sites: groupCookiesIntoSites(syncableCookies, { now: now() }),
      cookieCount: syncableCookies.length,
      undecryptable: result.undecryptable,
    };
  }

  async function removeManagedCookie(cookie) {
    const host = cookie.host.replace(/^\./, "");
    await getSession().cookies.remove(`${cookie.secure ? "https" : "http"}://${host}${cookie.path || "/"}`, cookie.name);
  }

  async function removeManagedCookies(cookies) {
    const results = new Map();
    const failedCookies = [];
    for (const cookie of cookies) {
      const tally = results.get(cookie.site) ?? { site: cookie.site, synced: 0, failed: 0, removed: 0 };
      results.set(cookie.site, tally);
      try {
        await removeManagedCookie(cookie);
        tally.removed += 1;
      } catch {
        tally.failed += 1;
        failedCookies.push(cookie);
      }
    }
    await getSession().cookies.flushStore?.();
    return { sites: [...results.values()], failedCookies };
  }

  async function reconcileCookies(cookies, { complete, generation = lifecycleGeneration }) {
    const assertCurrent = () => {
      if (generation !== lifecycleGeneration || !policyAllowed || !state.userEnabled) {
        throw new Error("sync-cancelled");
      }
    };
    const selected = new Set(state.selectedSites);
    const sourceCookies = cookiesForSites(cookies, state.selectedSites)
      .filter((cookie) => cookie.httpOnly === true)
      .filter((cookie) => cookie.expiresAt === null || cookie.expiresAt * 1000 >= now());
    const sourceByIdentity = new Map(sourceCookies.map((cookie) => [cookieIdentity(cookie), cookie]));
    const previousByIdentity = new Map(state.managedCookies.map((cookie) => [managedCookieIdentity(cookie), cookie]));
    const nextManaged = new Map();
    const tallies = new Map(state.selectedSites.map((site) => [site, { site, synced: 0, failed: 0, removed: 0 }]));
    let writeFailed = false;

    for (const [identity, cookie] of sourceByIdentity) {
      assertCurrent();
      const site = registrableDomain(cookie.host);
      const tally = tallies.get(site) ?? { site, synced: 0, failed: 0, removed: 0 };
      tallies.set(site, tally);
      try {
        await getSession().cookies.set(toElectronCookie(cookie));
        assertCurrent();
        nextManaged.set(identity, managedCookie(cookie));
        tally.synced += 1;
      } catch (error) {
        if (isSyncCancelled(error)) throw error;
        writeFailed = true;
        tally.failed += 1;
        const previous = previousByIdentity.get(identity);
        if (previous) nextManaged.set(identity, previous);
      }
    }

    if (complete && !writeFailed) {
      for (const [identity, cookie] of previousByIdentity) {
        if (nextManaged.has(identity)) continue;
        assertCurrent();
        const tally = tallies.get(cookie.site) ?? { site: cookie.site, synced: 0, failed: 0, removed: 0 };
        tallies.set(cookie.site, tally);
        try {
          await removeManagedCookie(cookie);
          assertCurrent();
          tally.removed += 1;
        } catch (error) {
          if (isSyncCancelled(error)) throw error;
          tally.failed += 1;
          nextManaged.set(identity, cookie);
        }
      }
    } else {
      for (const [identity, cookie] of previousByIdentity) if (!nextManaged.has(identity) && selected.has(cookie.site)) nextManaged.set(identity, cookie);
    }

    state.managedCookies = [...nextManaged.values()].filter((cookie) => selected.has(cookie.site));
    await getSession().cookies.flushStore?.();
    return { sites: [...tallies.values()].filter((tally) => tally.synced > 0 || tally.failed > 0 || tally.removed > 0) };
  }

  function stopWorker() {
    if (pollTimer) clearInterval(pollTimer);
    if (watchTimer) clearTimeout(watchTimer);
    pollTimer = null;
    watchTimer = null;
    watchHandle?.close?.();
    watchHandle = null;
  }

  async function handleSyncFailure(error) {
    state.status = "error";
    state.errorCode = syncErrorCode(error);
    await persistState();
  }

  async function performSync() {
    await ensureStateLoaded();
    assertPolicyAllowed();
    if (!state.userEnabled || !state.source || state.selectedSites.length === 0) throw new Error("Browser login sync is paused or not configured.");
    const generation = lifecycleGeneration;
    const source = resolveSource(state.source.id);
    state.status = "syncing";
    state.errorCode = null;
    const result = await readSourceCookies(source, { sites: state.selectedSites });
    if (generation !== lifecycleGeneration) return { sites: [] };
    const reconciliation = await reconcileCookies(result.cookies, {
      complete: result.undecryptable === 0,
      generation,
    });
    if (generation !== lifecycleGeneration) return reconciliation;
    const failed = reconciliation.sites.some((site) => site.failed > 0);
    if (result.undecryptable > 0 || failed) {
      state.status = "error";
      state.errorCode = result.undecryptable > 0 ? "incomplete_source" : "target_write_failed";
    } else {
      state.status = "synced";
      state.lastSyncedAt = now();
      state.errorCode = null;
    }
    state.sourceFingerprint = result.fingerprint;
    await persistState();
    return reconciliation;
  }

  function runSync({ background = false } = {}) {
    if (syncInFlight) return syncInFlight;
    syncInFlight = performSync()
      .catch(async (error) => {
        await handleSyncFailure(error);
        if (!background) throw new Error(`Browser login sync failed (${state.errorCode}).`);
        return { sites: [] };
      })
      .finally(() => {
        syncInFlight = null;
      });
    return syncInFlight;
  }

  async function cancelInFlightSync() {
    lifecycleGeneration += 1;
    const running = syncInFlight;
    const mutation = mutationInFlight;
    if (running) await running.catch(() => undefined);
    if (mutation) await mutation.catch(() => undefined);
  }

  async function pollSource() {
    if (!policyAllowed || !state.userEnabled || !state.source) return;
    try {
      const source = resolveSource(state.source.id);
      const current = await describeSourceFiles(source.path);
      if (current.fingerprint !== state.sourceFingerprint) await runSync({ background: true });
    } catch (error) {
      await handleSyncFailure(error);
    }
  }

  function scheduleWatchedSync() {
    if (watchTimer) clearTimeout(watchTimer);
    watchTimer = setTimeout(() => {
      watchTimer = null;
      void runSync({ background: true });
    }, watchDebounceMs);
    watchTimer.unref?.();
  }

  function startWorker() {
    stopWorker();
    if (!policyAllowed || !state.userEnabled || !state.source) return;
    if (pollIntervalMs > 0) {
      pollTimer = setInterval(() => void pollSource(), pollIntervalMs);
      pollTimer.unref?.();
    }
    if (!watchSource) return;
    try {
      const source = resolveSource(state.source.id);
      watchHandle = watchSource(path.dirname(source.path), { persistent: false }, (_eventType, filename) => {
        if (!filename || String(filename).startsWith(path.basename(source.path))) scheduleWatchedSync();
      });
    } catch {
      watchHandle = null;
    }
  }

  async function setPolicyAllowed(value) {
    await ensureStateLoaded();
    const nextPolicyAllowed = value === true;
    if (policyAllowed === nextPolicyAllowed) {
      policyInitialized = true;
      return publicState();
    }
    const wasInitialized = policyInitialized;
    policyInitialized = true;
    policyAllowed = nextPolicyAllowed;
    previews.clear();
    if (!policyAllowed) {
      stopWorker();
      await cancelInFlightSync();
      chromiumKeys.clear();
      if (state.source) {
        state.status = "paused";
        if (wasInitialized) {
          state.userEnabled = false;
          await persistState();
        }
      }
      state.errorCode = null;
      return publicState();
    }
    if (state.userEnabled) {
      state.status = "syncing";
      startWorker();
      void runSync({ background: true });
    }
    return publicState();
  }

  /** @param {{ previewId?: unknown, sites?: unknown }} [request] */
  async function configure({ previewId, sites } = {}) {
    await ensureStateLoaded();
    assertPolicyAllowed();
    const entry = typeof previewId === "string" ? previews.get(previewId) : null;
    if (!entry) throw new Error("This setup preview has expired. Choose the browser profile again.");
    previews.delete(previewId);
    const availableSites = new Set(groupCookiesIntoSites(entry.cookies, { now: now() }).map((site) => site.site));
    const selectedSites = normalizedSites(sites).filter((site) => availableSites.has(site));
    if (selectedSites.length === 0) throw new Error("Choose at least one site to sync.");
    if (!(await confirmUserAction({ action: "configure", source: publicSource(entry.source), sites: selectedSites }))) {
      throw new Error("Browser login sync setup was cancelled.");
    }
    assertPolicyAllowed();
    stopWorker();
    await cancelInFlightSync();
    const sourceRead = await readSourceCookies(entry.source, { sites: selectedSites });
    assertPolicyAllowed();
    state.source = publicSource(entry.source);
    state.selectedSites = selectedSites;
    state.userEnabled = true;
    state.status = "syncing";
    state.errorCode = null;
    state.sourceFingerprint = sourceRead.fingerprint;
    const generation = lifecycleGeneration;
    const mutation = reconcileCookies(sourceRead.cookies, {
      complete: sourceRead.undecryptable === 0,
      generation,
    });
    mutationInFlight = mutation;
    let result;
    try {
      result = await mutation;
    } finally {
      if (mutationInFlight === mutation) mutationInFlight = null;
    }
    const failed = result.sites.some((site) => site.failed > 0);
    if (sourceRead.undecryptable > 0 || failed) {
      state.status = "error";
      state.errorCode = sourceRead.undecryptable > 0 ? "incomplete_source" : "target_write_failed";
    } else {
      state.status = "synced";
      state.lastSyncedAt = now();
    }
    await persistState();
    startWorker();
    return result;
  }

  async function getState() {
    await ensureStateLoaded();
    return publicState();
  }

  async function syncNow() {
    await ensureStateLoaded();
    assertPolicyAllowed();
    if (!state.userEnabled || !state.source || state.selectedSites.length === 0) {
      throw new Error("Browser login sync is paused or not configured.");
    }
    return runSync();
  }

  async function pause() {
    await ensureStateLoaded();
    state.userEnabled = false;
    stopWorker();
    await cancelInFlightSync();
    state.status = state.source ? "paused" : "not_configured";
    state.errorCode = null;
    chromiumKeys.clear();
    await persistState();
    return publicState();
  }

  async function resume() {
    await ensureStateLoaded();
    assertPolicyAllowed();
    if (!state.source || state.selectedSites.length === 0) throw new Error("Set up browser login sync first.");
    if (!(await confirmUserAction({ action: "resume", source: state.source }))) {
      throw new Error("Resuming browser login sync was cancelled.");
    }
    assertPolicyAllowed();
    state.userEnabled = true;
    state.status = "syncing";
    await persistState();
    startWorker();
    return runSync();
  }

  async function stopSite(site) {
    await ensureStateLoaded();
    const target = registrableDomain(String(site ?? ""));
    if (!target) throw new Error("Choose a site to stop syncing.");
    stopWorker();
    await cancelInFlightSync();
    const removal = await removeManagedCookies(state.managedCookies.filter((cookie) => cookie.site === target));
    const otherManagedCookies = state.managedCookies.filter((cookie) => cookie.site !== target);
    state.managedCookies = [...otherManagedCookies, ...removal.failedCookies];
    if (removal.failedCookies.length > 0) {
      state.userEnabled = false;
      state.status = "error";
      state.errorCode = "target_remove_failed";
      chromiumKeys.clear();
      await persistState();
      return { sites: removal.sites };
    }
    state.selectedSites = state.selectedSites.filter((entry) => entry !== target);
    if (state.selectedSites.length === 0) {
      state.userEnabled = false;
      state.status = "paused";
      stopWorker();
      chromiumKeys.clear();
    }
    await persistState();
    if (state.userEnabled) startWorker();
    return { sites: removal.sites };
  }

  async function disconnect({ forgetSynced = false } = {}) {
    await ensureStateLoaded();
    stopWorker();
    await cancelInFlightSync();
    chromiumKeys.clear();
    const removal = forgetSynced
      ? await removeManagedCookies(state.managedCookies)
      : { sites: [], failedCookies: [] };
    if (removal.failedCookies.length > 0) {
      state.userEnabled = false;
      state.status = "error";
      state.errorCode = "target_remove_failed";
      state.managedCookies = removal.failedCookies;
      await persistState();
      return { sites: removal.sites };
    }
    state = emptySyncState();
    await persistState();
    return { sites: removal.sites };
  }

  async function listSignedInSites() {
    const cookies = (await getSession().cookies.get({})).map(fromElectronCookie);
    return groupCookiesIntoSites(cookies, { now: now() });
  }

  async function forgetSite(site) {
    const target = registrableDomain(String(site ?? ""));
    if (!target) throw new Error("Choose a site to sign out of.");
    await stopSite(target);
    const browserSession = getSession();
    const cookies = await browserSession.cookies.get({});
    const hosts = new Set();
    let removed = 0;
    for (const cookie of cookies) {
      const domain = String(cookie.domain ?? "");
      if (registrableDomain(domain) !== target) continue;
      const host = domain.replace(/^\./, "");
      hosts.add(host);
      await browserSession.cookies.remove(`${cookie.secure ? "https" : "http"}://${host}${String(cookie.path ?? "/")}`, String(cookie.name ?? ""));
      removed += 1;
    }
    for (const host of hosts) {
      await browserSession.clearStorageData({ origin: `https://${host}` }).catch(() => undefined);
      await browserSession.clearStorageData({ origin: `http://${host}` }).catch(() => undefined);
    }
    await browserSession.cookies.flushStore?.();
    return { site: target, removed };
  }

  async function forgetAll() {
    await disconnect({ forgetSynced: false });
    await getSession().clearStorageData();
    return { ok: true };
  }

  /** Eval-only source registration; production never registers its IPC. */
  /** @param {{ path?: unknown, cookies?: unknown }} [request] */
  async function writeTestStore({ path: filePath, cookies } = {}) {
    if (typeof filePath !== "string" || !filePath.trim()) throw new Error("A file path is required.");
    const resolvedPath = path.resolve(filePath);
    await mkdir(path.dirname(resolvedPath), { recursive: true });
    const [realParent, ...allowedRoots] = await Promise.all([
      realpath(path.dirname(resolvedPath)),
      realpath(tmpdir()),
      ...(platform === "win32" ? [] : [realpath("/tmp")]),
    ]);
    if (!allowedRoots.some((root) => realParent === root || realParent.startsWith(`${root}${path.sep}`))) {
      throw new Error("Eval browser login stores must stay inside a temporary directory.");
    }
    const safePath = path.join(realParent, path.basename(resolvedPath));
    try {
      if ((await lstat(safePath)).isSymbolicLink()) throw new Error("Eval browser login stores cannot be symbolic links.");
    } catch (error) {
      if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
    }
    const Database = require("better-sqlite3");
    const db = new Database(safePath);
    try {
      db.exec("DROP TABLE IF EXISTS moz_cookies");
      db.exec("CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, originAttributes TEXT NOT NULL DEFAULT '', name TEXT, value TEXT, host TEXT, path TEXT, expiry INTEGER, lastAccessed INTEGER, creationTime INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER)");
      const insert = db.prepare("INSERT INTO moz_cookies (originAttributes, name, value, host, path, expiry, lastAccessed, creationTime, isSecure, isHttpOnly, sameSite) VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const cookie of Array.isArray(cookies) ? cookies : []) {
        insert.run(
          String(cookie.name), String(cookie.value), String(cookie.host), String(cookie.path ?? "/"),
          Number(cookie.expiresAt ?? 0), Number(cookie.lastAccessedAt ?? 0) * 1_000_000, 0,
          cookie.secure ? 1 : 0, cookie.httpOnly ? 1 : 0, Number(cookie.sameSite ?? 0),
        );
      }
    } finally {
      db.close();
    }
    const profile = path.basename(path.dirname(safePath));
    const source = { id: `firefox:${profile}`, browser: "firefox", label: "Firefox", profile, path: safePath, keychainService: null };
    const index = testSources.findIndex((entry) => entry.id === source.id);
    if (index >= 0) testSources.splice(index, 1, source);
    else testSources.push(source);
    return publicSource(source);
  }

  function registerIpc(ipcMain, { evalSeam = false } = {}) {
    if (evalSeam) ipcMain.handle("openwork:browser-logins:writeTestStore", (_event, request) => writeTestStore(request && typeof request === "object" ? request : {}));
    ipcMain.handle("openwork:browser-logins:setPolicyAllowed", (_event, value) => setPolicyAllowed(value));
    ipcMain.handle("openwork:browser-logins:sources", () => listSources());
    ipcMain.handle("openwork:browser-logins:preview", (_event, request) => preview(request && typeof request === "object" ? request : {}));
    ipcMain.handle("openwork:browser-logins:configure", (_event, request) => configure(request && typeof request === "object" ? request : {}));
    ipcMain.handle("openwork:browser-logins:state", () => getState());
    ipcMain.handle("openwork:browser-logins:syncNow", () => syncNow());
    ipcMain.handle("openwork:browser-logins:pause", () => pause());
    ipcMain.handle("openwork:browser-logins:resume", () => resume());
    ipcMain.handle("openwork:browser-logins:stopSite", (_event, site) => stopSite(site));
    ipcMain.handle("openwork:browser-logins:disconnect", (_event, request) => disconnect(request && typeof request === "object" ? request : {}));
    ipcMain.handle("openwork:browser-logins:signedIn", () => listSignedInSites());
    ipcMain.handle("openwork:browser-logins:forgetSite", (_event, site) => forgetSite(site));
    ipcMain.handle("openwork:browser-logins:forgetAll", () => forgetAll());
  }

  function shutdown() {
    lifecycleGeneration += 1;
    stopWorker();
    previews.clear();
    chromiumKeys.clear();
  }

  return {
    registerIpc,
    setPolicyAllowed,
    listSources,
    preview,
    configure,
    getState,
    syncNow,
    pause,
    resume,
    stopSite,
    disconnect,
    listSignedInSites,
    forgetSite,
    forgetAll,
    writeTestStore,
    shutdown,
  };
}
