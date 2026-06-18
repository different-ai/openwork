// Desktop workspace persistence and bootstrap configuration. This module owns
// on-disk workspace state, per-workspace openwork.json files, remote workspace
// normalization/discovery, and the workspace-facing command operations.
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { openworkWorkspaceDisplayName, selectOpenworkWorkspaceForConnection } from "./remote-workspace.mjs";
import { exportWorkspaceConfig, importWorkspaceConfig } from "./workspace-archive.mjs";

const EMPTY_WORKSPACE_LIST = Object.freeze({
  selectedId: "",
  watchedId: null,
  activeId: null,
  workspaces: [],
});

function execResult(ok, stdout = "", stderr = "", status = ok ? 0 : 1) {
  return { ok, status, stdout, stderr };
}

async function pathExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

function parseFirstJsonObject(raw) {
  let inString = false;
  let escaped = false;
  let depth = 0;
  let start = -1;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          return { ok: true, value: JSON.parse(raw.slice(start, index + 1)) };
        } catch {
          return { ok: false, value: null };
        }
      }
    }
  }

  return { ok: false, value: null };
}

async function writeJsonFileAtomic(outputPath, value) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  JSON.parse(content);
  await mkdir(path.dirname(outputPath), { recursive: true });
  const tempPath = `${outputPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, outputPath);
}

async function readJsonFile(targetPath, fallback) {
  try {
    const raw = await readFile(targetPath, "utf8");
    try {
      return JSON.parse(raw);
    } catch (error) {
      const recovered = parseFirstJsonObject(raw);
      if (recovered.ok) {
        console.warn(`[json] recovered ${targetPath} from trailing invalid data`, error);
        await writeJsonFileAtomic(targetPath, recovered.value);
        return recovered.value;
      }
      throw error;
    }
  } catch {
    return fallback;
  }
}

export function createWorkspaceStore({ app, defaultDenBaseUrl, defaultRequireSignin, forceRequireSignin }) {
  function desktopBootstrapPath() {
    if (process.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH?.trim()) {
      return process.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH.trim();
    }
    // Dev mode swaps process.env.HOME to the sandboxed dev-data home midway
    // through startup (runtime.mjs buildChildEnv -> Object.assign(process.env)),
    // which changes what os.homedir() returns. Resolve the dev-data home
    // deterministically so early and late IPC reads target the same file.
    if (process.env.OPENWORK_DEV_MODE === "1") {
      return path.join(
        app.getPath("userData"),
        "openwork-dev-data",
        "home",
        ".config",
        "openwork",
        "desktop-bootstrap.json",
      );
    }
    return path.join(os.homedir(), ".config", "openwork", "desktop-bootstrap.json");
  }

  function workspaceStatePath() {
    return path.join(app.getPath("userData"), "openwork-workspaces.json");
  }

  function openworkServerTokenStorePath() {
    return path.join(app.getPath("userData"), "openwork-server-tokens.json");
  }

  function openworkServerConfigPath() {
    if (process.env.OPENWORK_SERVER_CONFIG?.trim()) return path.resolve(process.env.OPENWORK_SERVER_CONFIG.trim());
    if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "openwork", "server.json");
    return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "openwork", "server.json");
  }

  // Earlier Electron alpha builds copied Tauri's openwork-workspaces.json into
  // an Electron-only workspace-state.json. Keep importing that file when the
  // shared canonical file is missing, but write openwork-workspaces.json going
  // forward so Tauri rollback and Electron both read the same desktop state.
  function legacyElectronWorkspaceStatePath() {
    return path.join(app.getPath("userData"), "workspace-state.json");
  }

  async function migrateLegacyElectronWorkspaceStateIfNeeded() {
    const current = workspaceStatePath();
    const legacy = legacyElectronWorkspaceStatePath();
    try {
      if (existsSync(current)) return false;
      if (!existsSync(legacy)) return false;
      await mkdir(path.dirname(current), { recursive: true });
      const raw = await readFile(legacy, "utf8");
      await writeFile(current, raw, "utf8");
      console.info("[migration] copied workspace-state.json to openwork-workspaces.json");
      return true;
    } catch (error) {
      console.warn("[migration] legacy Electron workspace-state copy failed", error);
      return false;
    }
  }

  function normalizeDesktopBootstrapConfig(input) {
    const baseUrl = typeof input?.baseUrl === "string" ? input.baseUrl.trim() : "";
    if (!baseUrl) {
      throw new Error("baseUrl is required");
    }

    const apiBaseUrl =
      typeof input?.apiBaseUrl === "string" && input.apiBaseUrl.trim().length > 0
        ? input.apiBaseUrl.trim()
        : null;
    return {
      baseUrl,
      apiBaseUrl,
      requireSignin: forceRequireSignin || input?.requireSignin === true,
    };
  }

  async function getDesktopBootstrapConfig() {
    const configPath = desktopBootstrapPath();
    try {
      const raw = await readFile(configPath, "utf8");
      return normalizeDesktopBootstrapConfig(JSON.parse(raw));
    } catch (error) {
      console.warn("[desktop-bootstrap] falling back to defaults", {
        path: configPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        baseUrl: defaultDenBaseUrl,
        apiBaseUrl: null,
        requireSignin: defaultRequireSignin,
      };
    }
  }

  async function debugDesktopBootstrapConfig() {
    const configPath = desktopBootstrapPath();
    const result = {
      path: configPath,
      home: os.homedir(),
      envHome: process.env.HOME ?? null,
      envOverride: process.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH ?? null,
      exists: existsSync(configPath),
      raw: null,
      parsed: null,
      normalized: null,
      error: null,
    };

    try {
      result.raw = await readFile(configPath, "utf8");
      result.parsed = JSON.parse(result.raw);
      result.normalized = normalizeDesktopBootstrapConfig(result.parsed);
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
    }

    return result;
  }

  async function setDesktopBootstrapConfig(config) {
    const normalized = normalizeDesktopBootstrapConfig(config);
    const outputPath = desktopBootstrapPath();
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    return normalized;
  }

  function defaultWorkspaceOpenworkConfig(workspacePath, preset = null) {
    return {
      version: 1,
      workspace: workspacePath
        ? {
            name: path.basename(workspacePath) || "Workspace",
            createdAt: Date.now(),
            preset: preset || null,
          }
        : null,
      authorizedRoots: workspacePath ? [workspacePath] : [],
      reload: null,
    };
  }

  async function normalizeLocalWorkspacePath(rawPath) {
    const trimmed = String(rawPath ?? "").trim();
    if (!trimmed) return "";
    const expanded = trimmed === "~"
      ? os.homedir()
      : trimmed.startsWith("~/") || trimmed.startsWith("~\\")
        ? path.join(os.homedir(), trimmed.slice(2))
        : trimmed;
    const resolved = path.resolve(expanded);
    return realpath(resolved).catch(() => resolved);
  }

  function normalizeWorkspacePathKey(value) {
    const trimmed = String(value ?? "").trim();
    return trimmed ? path.resolve(trimmed).replace(/\\/g, "/").toLowerCase() : "";
  }

  function normalizeRecoveredWorkspacePath(value) {
    const trimmed = String(value ?? "").trim();
    if (!trimmed) return "";
    if (process.platform !== "win32") return trimmed;
    return trimmed
      .replace(/^\\\\\?\\UNC\\/i, "\\\\")
      .replace(/^\\\\\?\\/i, "")
      .replace(/^\/\/\?\/UNC\//i, "//")
      .replace(/^\/\/\?\//i, "")
      .replace(/\//g, "\\");
  }

  function isRecord(value) {
    return typeof value === "object" && value !== null;
  }

  async function recoverWorkspacesFromTokenStore() {
    const store = await readJsonFile(openworkServerTokenStorePath(), null);
    if (!isRecord(store) || !isRecord(store.workspaces)) return [];

    const candidates = [];
    for (const [rawPath, entry] of Object.entries(store.workspaces)) {
      const normalizedInput = normalizeRecoveredWorkspacePath(rawPath);
      if (!normalizedInput) continue;
      const workspacePath = await normalizeLocalWorkspacePath(normalizedInput);
      if (!(await pathExists(workspacePath))) continue;
      candidates.push({
        path: workspacePath,
        updatedAt: isRecord(entry) && typeof entry.updatedAt === "number" ? entry.updatedAt : 0,
      });
    }

    candidates.sort((left, right) => right.updatedAt - left.updatedAt);
    const seen = new Set();
    return candidates.flatMap((candidate) => {
      const key = normalizeWorkspacePathKey(candidate.path);
      if (!key || seen.has(key)) return [];
      seen.add(key);
      return [normalizeWorkspaceEntry({
        id: localWorkspaceId(candidate.path),
        name: path.basename(candidate.path) || "Workspace",
        displayName: path.basename(candidate.path) || "Workspace",
        path: candidate.path,
        preset: "starter",
        workspaceType: "local",
      })];
    });
  }

  async function recoverWorkspacesFromServerConfig() {
    const config = await readJsonFile(openworkServerConfigPath(), null);
    if (!isRecord(config) || !Array.isArray(config.workspaces)) return [];

    const seen = new Set();
    const workspaces = [];
    for (const entry of config.workspaces) {
      if (!isRecord(entry)) continue;
      const workspaceType = entry.workspaceType === "remote" ? "remote" : "local";
      const rawPath = typeof entry.path === "string" ? entry.path.trim() : "";
      const normalizedPath = workspaceType === "local"
        ? await normalizeLocalWorkspacePath(normalizeRecoveredWorkspacePath(rawPath))
        : rawPath;
      if (workspaceType === "local" && (!normalizedPath || !(await pathExists(normalizedPath)))) continue;

      const baseUrl = typeof entry.baseUrl === "string" ? entry.baseUrl.trim() : "";
      const directory = typeof entry.directory === "string" && entry.directory.trim() ? entry.directory.trim() : null;
      const remoteType = entry.remoteType === "opencode" ? "opencode" : "openwork";
      const openworkWorkspaceId = typeof entry.openworkWorkspaceId === "string" ? entry.openworkWorkspaceId.trim() : "";
      const id = typeof entry.id === "string" && entry.id.trim()
        ? entry.id.trim()
        : workspaceType === "remote"
          ? remoteType === "openwork"
            ? openworkRemoteWorkspaceId(baseUrl, openworkWorkspaceId)
            : remoteWorkspaceId(baseUrl, directory)
          : localWorkspaceId(normalizedPath);
      const key = workspaceType === "remote" ? id : normalizeWorkspacePathKey(normalizedPath);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      workspaces.push(normalizeWorkspaceEntry({
        ...entry,
        id,
        path: normalizedPath,
        name: typeof entry.name === "string" && entry.name.trim()
          ? entry.name.trim()
          : path.basename(normalizedPath) || "Workspace",
        displayName: typeof entry.displayName === "string" ? entry.displayName : undefined,
        preset: typeof entry.preset === "string" && entry.preset.trim() ? entry.preset.trim() : "starter",
        workspaceType,
        ...(workspaceType === "remote" ? { remoteType, baseUrl, directory } : {}),
      }));
    }
    return workspaces;
  }

  async function recoverWorkspacesFromKnownState() {
    const fromServerConfig = await recoverWorkspacesFromServerConfig();
    if (fromServerConfig.length > 0) return fromServerConfig;
    return recoverWorkspacesFromTokenStore();
  }

  function stableWorkspaceId(value) {
    return `ws_${createHash("sha256").update(String(value)).digest("hex").slice(0, 12)}`;
  }

  function localWorkspaceId(workspacePath) {
    return stableWorkspaceId(workspacePath);
  }

  function remoteWorkspaceId(baseUrl, directory) {
    const key = String(directory ?? "").trim()
      ? `remote::${baseUrl}::${String(directory).trim()}`
      : `remote::${baseUrl}`;
    return stableWorkspaceId(key);
  }

  function parseOpenworkWorkspaceIdFromUrl(input) {
    const raw = String(input ?? "").trim();
    if (!raw) return null;
    try {
      const url = new URL(raw);
      const segments = url.pathname.split("/").filter(Boolean);
      const workspaceIndex = segments.indexOf("workspace");
      const legacyIndex = segments.indexOf("w");
      const mountIndex = workspaceIndex >= 0 ? workspaceIndex : legacyIndex;
      return mountIndex >= 0 && segments[mountIndex + 1]
        ? decodeURIComponent(segments[mountIndex + 1])
        : null;
    } catch {
      const match = raw.match(/\/(?:workspace|w)\/([^/?#]+)/);
      if (!match?.[1]) return null;
      try {
        return decodeURIComponent(match[1]);
      } catch {
        return match[1];
      }
    }
  }

  function stripOpenworkWorkspaceMount(input) {
    const raw = String(input ?? "").trim();
    if (!raw) return null;
    try {
      const url = new URL(raw);
      const segments = url.pathname.split("/").filter(Boolean);
      const workspaceIndex = segments.indexOf("workspace");
      const legacyIndex = segments.indexOf("w");
      const mountIndex = workspaceIndex >= 0 ? workspaceIndex : legacyIndex;
      if (mountIndex >= 0 && segments[mountIndex + 1]) {
        const prefix = segments.slice(0, mountIndex).join("/");
        url.pathname = prefix ? `/${prefix}` : "/";
      }
      return url.toString().replace(/\/+$/, "");
    } catch {
      return raw.replace(/\/(?:workspace|w)\/[^/?#]+.*$/, "").replace(/\/+$/, "") || raw;
    }
  }

  function openworkRemoteWorkspaceId(hostUrl, workspaceId) {
    const remoteWorkspaceId = String(workspaceId ?? "").trim() || parseOpenworkWorkspaceIdFromUrl(hostUrl);
    if (remoteWorkspaceId) return `rem_${remoteWorkspaceId}`;
    return `rem_${createHash("sha256").update(`openwork::${hostUrl}`).digest("hex").slice(0, 12)}`;
  }

  async function fetchOpenworkWorkspaceList(hostUrl, token, hostToken) {
    const url = `${String(hostUrl ?? "").replace(/\/+$/, "")}/workspaces`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    const headers = new Headers();
    const bearerToken = String(token ?? "").trim();
    const hostAuthToken = String(hostToken ?? "").trim();
    if (bearerToken) headers.set("Authorization", `Bearer ${bearerToken}`);
    if (hostAuthToken) headers.set("X-OpenWork-Host-Token", hostAuthToken);

    try {
      const response = await fetch(url, { headers, signal: controller.signal });
      if (!response.ok) {
        throw new Error(`OpenWork workspace discovery failed (${response.status} ${response.statusText || "HTTP error"})`);
      }
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  async function discoverOpenworkWorkspace({ hostUrl, token, hostToken, directory }) {
    const list = await fetchOpenworkWorkspaceList(hostUrl, token, hostToken);
    return selectOpenworkWorkspaceForConnection(list, directory);
  }

  function normalizeWorkspaceEntry(input) {
    return {
      id: String(input.id),
      name: String(input.name ?? "Workspace"),
      path: String(input.path ?? ""),
      preset: String(input.preset ?? "starter"),
      workspaceType: input.workspaceType === "remote" ? "remote" : "local",
      remoteType: input.remoteType ?? null,
      baseUrl: input.baseUrl ?? null,
      directory: input.directory ?? null,
      displayName: input.displayName ?? null,
      openworkHostUrl: input.openworkHostUrl ?? null,
      openworkToken: input.openworkToken ?? null,
      openworkClientToken: input.openworkClientToken ?? null,
      openworkHostToken: input.openworkHostToken ?? null,
      openworkWorkspaceId: input.openworkWorkspaceId ?? null,
      openworkWorkspaceName: input.openworkWorkspaceName ?? null,
      sandboxBackend: input.sandboxBackend ?? null,
      sandboxRunId: input.sandboxRunId ?? null,
      sandboxContainerName: input.sandboxContainerName ?? null,
    };
  }

  async function readWorkspaceOpenworkConfig(workspacePath) {
    const openworkPath = path.join(workspacePath, ".opencode", "openwork.json");
    if (!(await pathExists(openworkPath))) {
      return defaultWorkspaceOpenworkConfig(workspacePath);
    }
    const raw = await readFile(openworkPath, "utf8");
    return JSON.parse(raw);
  }

  async function writeWorkspaceOpenworkConfig(workspacePath, config) {
    const openworkPath = path.join(workspacePath, ".opencode", "openwork.json");
    await mkdir(path.dirname(openworkPath), { recursive: true });
    await writeFile(openworkPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    return execResult(true, `Wrote ${openworkPath}`);
  }

  async function writeWorkspaceState(nextState) {
    const outputPath = workspaceStatePath();
    const selectedId = String(nextState?.selectedId ?? nextState?.activeId ?? "");
    const watchedId = typeof nextState?.watchedId === "string" ? nextState.watchedId : "";
    const output = {
      ...nextState,
      // Tauri's Rust state uses selectedWorkspaceId/watchedWorkspaceId on disk
      // with activeId as a legacy alias. Keep Electron's selectedId/watchedId
      // too so older Electron builds can still read the same file.
      selectedId,
      selectedWorkspaceId: selectedId,
      watchedId: watchedId || null,
      watchedWorkspaceId: watchedId,
      activeId: selectedId || null,
    };
    await writeJsonFileAtomic(outputPath, output);
    return output;
  }

  async function readWorkspaceState() {
    const state = await readJsonFile(workspaceStatePath(), EMPTY_WORKSPACE_LIST);
    let selectedId =
      typeof state?.selectedId === "string"
        ? state.selectedId
        : typeof state?.selectedWorkspaceId === "string"
          ? state.selectedWorkspaceId
          : typeof state?.activeId === "string"
            ? state.activeId
            : "";
    let watchedId =
      typeof state?.watchedId === "string"
        ? state.watchedId
        : typeof state?.watchedWorkspaceId === "string"
          ? state.watchedWorkspaceId
          : null;
    let activeId = typeof state?.activeId === "string" ? state.activeId : null;
    let workspaces = Array.isArray(state?.workspaces) ? state.workspaces : [];
    let changed = false;
    if (workspaces.length === 0) {
      const recoveredWorkspaces = await recoverWorkspacesFromKnownState();
      if (recoveredWorkspaces.length > 0) {
        const selectedWorkspace = recoveredWorkspaces[0];
        console.info("[migration] recovered desktop workspaces from persisted OpenWork state", {
          count: recoveredWorkspaces.length,
          selectedWorkspaceId: selectedWorkspace.id,
        });
        selectedId = selectedWorkspace.id;
        watchedId = selectedWorkspace.id;
        activeId = selectedWorkspace.id;
        workspaces = recoveredWorkspaces;
        changed = true;
      }
    }
    const idMap = new Map();
    const migratedWorkspaces = workspaces.map((entry) => {
      const workspace = entry && typeof entry === "object" ? entry : normalizeWorkspaceEntry(entry ?? {});
      if (workspace.workspaceType !== "remote" || workspace.remoteType !== "openwork") return workspace;

      const remoteWorkspaceId = String(workspace.openworkWorkspaceId ?? "").trim()
        || parseOpenworkWorkspaceIdFromUrl(workspace.openworkHostUrl)
        || parseOpenworkWorkspaceIdFromUrl(workspace.baseUrl);
      if (!remoteWorkspaceId) return workspace;

      const hostUrl = stripOpenworkWorkspaceMount(workspace.openworkHostUrl) || stripOpenworkWorkspaceMount(workspace.baseUrl);
      const nextId = openworkRemoteWorkspaceId(hostUrl ?? workspace.baseUrl, remoteWorkspaceId);
      idMap.set(workspace.id, nextId);
      const nextWorkspace = {
        ...workspace,
        id: nextId,
        baseUrl: hostUrl,
        openworkWorkspaceId: remoteWorkspaceId,
        openworkHostUrl: hostUrl,
      };
      if (workspace.id !== nextWorkspace.id || workspace.baseUrl !== nextWorkspace.baseUrl || workspace.openworkWorkspaceId !== nextWorkspace.openworkWorkspaceId || workspace.openworkHostUrl !== nextWorkspace.openworkHostUrl) {
        changed = true;
      }
      return nextWorkspace;
    });
    // Older desktop state can contain multiple OpenWork remote entries that
    // normalize to the same rem_<workspaceId> after stripping worker mounts.
    // Collapse them here so React never receives duplicate workspace keys.
    const workspaceIndexById = new Map();
    const dedupedWorkspaces = [];
    for (const workspace of migratedWorkspaces) {
      const workspaceId = String(workspace?.id ?? "").trim();
      if (!workspaceId) {
        dedupedWorkspaces.push(workspace);
        continue;
      }
      const existingIndex = workspaceIndexById.get(workspaceId);
      if (existingIndex === undefined) {
        workspaceIndexById.set(workspaceId, dedupedWorkspaces.length);
        dedupedWorkspaces.push(workspace);
        continue;
      }
      // Keep the later entry: normal mutations replace-then-push refreshed
      // remote workspaces, and there is no persisted updatedAt to compare.
      dedupedWorkspaces[existingIndex] = workspace;
      changed = true;
    }

    const migratedSelectedId = idMap.get(selectedId) ?? selectedId;
    const migratedWatchedId = watchedId ? idMap.get(watchedId) ?? watchedId : null;
    const migratedActiveId = activeId ? idMap.get(activeId) ?? activeId : null;
    if (migratedSelectedId !== selectedId || migratedWatchedId !== watchedId || migratedActiveId !== activeId) changed = true;

    const nextState = {
      selectedId: migratedSelectedId,
      watchedId: migratedWatchedId,
      activeId: migratedActiveId,
      workspaces: dedupedWorkspaces,
    };

    if (changed) {
      return writeWorkspaceState(nextState);
    }
    return nextState;
  }

  async function mutateWorkspaceState(mutator) {
    const current = await readWorkspaceState();
    const next = await mutator({ ...current, workspaces: [...current.workspaces] });
    return writeWorkspaceState(next);
  }

  async function listLocalWorkspacePaths() {
    return (await readWorkspaceState())
      .workspaces
      .filter((entry) => entry?.workspaceType !== "remote")
      .map((entry) => String(entry?.path ?? "").trim())
      .filter(Boolean);
  }

  function workspacePathKey(workspace) {
    return normalizeWorkspacePathKey(workspace.path);
  }

  async function setSelectedWorkspace(workspaceId) {
    return mutateWorkspaceState((state) => {
      state.selectedId = workspaceId;
      state.activeId = workspaceId || null;
      return state;
    });
  }

  async function setRuntimeActiveWorkspace(workspaceId) {
    return mutateWorkspaceState((state) => {
      state.watchedId = typeof workspaceId === "string" && workspaceId.trim() ? workspaceId : null;
      return state;
    });
  }

  async function createWorkspace(input = {}) {
    const rawFolderPath = String(input.folderPath ?? "").trim();
    if (!rawFolderPath) throw new Error("folderPath is required");
    const folderPath = await normalizeLocalWorkspacePath(rawFolderPath);
    await mkdir(folderPath, { recursive: true });
    const preset = String(input.preset ?? "starter");
    const workspace = normalizeWorkspaceEntry({
      id: localWorkspaceId(folderPath),
      name: String(input.name ?? (path.basename(folderPath) || "Workspace")),
      displayName: String(input.name ?? (path.basename(folderPath) || "Workspace")),
      path: folderPath,
      preset,
      workspaceType: "local",
    });
    await mkdir(path.join(folderPath, ".opencode"), { recursive: true });
    await writeWorkspaceOpenworkConfig(folderPath, defaultWorkspaceOpenworkConfig(folderPath, preset));

    return mutateWorkspaceState((state) => {
      const key = workspacePathKey(workspace);
      state.workspaces = state.workspaces.filter(
        (entry) => entry.id !== workspace.id && normalizeWorkspacePathKey(entry.path) !== key,
      );
      state.workspaces.push(workspace);
      state.selectedId = workspace.id;
      state.activeId = workspace.id;
      state.watchedId = workspace.id;
      return state;
    });
  }

  async function createRemoteWorkspace(input = {}) {
    const baseUrl = String(input.baseUrl ?? "").trim();
    if (!baseUrl) throw new Error("baseUrl is required");
    if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
      throw new Error("baseUrl must start with http:// or https://");
    }
    const remoteType = input.remoteType === "opencode" ? "opencode" : "openwork";
    const directory = typeof input.directory === "string" && input.directory.trim() ? input.directory.trim() : null;
    const rawOpenworkHostUrl = typeof input.openworkHostUrl === "string" && input.openworkHostUrl.trim()
      ? input.openworkHostUrl.trim()
      : null;
    const openworkHostUrl = remoteType === "openwork"
      ? stripOpenworkWorkspaceMount(rawOpenworkHostUrl ?? baseUrl)
      : rawOpenworkHostUrl;
    const openworkWorkspaceId = typeof input.openworkWorkspaceId === "string" && input.openworkWorkspaceId.trim()
      ? input.openworkWorkspaceId.trim()
      : remoteType === "openwork"
        ? parseOpenworkWorkspaceIdFromUrl(rawOpenworkHostUrl) || parseOpenworkWorkspaceIdFromUrl(baseUrl)
        : null;
    let resolvedOpenworkWorkspaceId = openworkWorkspaceId;
    let resolvedOpenworkWorkspaceName = input.openworkWorkspaceName ?? null;
    if (remoteType === "openwork" && !resolvedOpenworkWorkspaceId) {
      const discovered = await discoverOpenworkWorkspace({
        hostUrl: openworkHostUrl ?? baseUrl,
        token: input.openworkToken,
        hostToken: input.openworkHostToken,
        directory,
      });
      if (!discovered?.id) {
        throw new Error(
          directory
            ? `OpenWork server has no workspace matching ${directory}.`
            : "OpenWork server returned no workspaces.",
        );
      }
      resolvedOpenworkWorkspaceId = String(discovered.id).trim();
      resolvedOpenworkWorkspaceName = openworkWorkspaceDisplayName(discovered);
    }
    const id = remoteType === "openwork"
      ? openworkRemoteWorkspaceId(openworkHostUrl ?? baseUrl, resolvedOpenworkWorkspaceId)
      : remoteWorkspaceId(baseUrl, directory);
    const workspace = normalizeWorkspaceEntry({
      id,
      name: String(input.displayName ?? resolvedOpenworkWorkspaceName ?? "Remote workspace"),
      displayName: input.displayName ?? null,
      path: directory ?? "",
      preset: "remote",
      workspaceType: "remote",
      remoteType,
      baseUrl: remoteType === "openwork" ? (openworkHostUrl ?? baseUrl) : baseUrl,
      directory,
      openworkHostUrl,
      openworkToken: input.openworkToken ?? null,
      openworkClientToken: input.openworkClientToken ?? null,
      openworkHostToken: input.openworkHostToken ?? null,
      openworkWorkspaceId: resolvedOpenworkWorkspaceId,
      openworkWorkspaceName: resolvedOpenworkWorkspaceName,
      sandboxBackend: input.sandboxBackend ?? null,
      sandboxRunId: input.sandboxRunId ?? null,
      sandboxContainerName: input.sandboxContainerName ?? null,
    });
    return mutateWorkspaceState((state) => {
      state.workspaces = state.workspaces.filter((entry) => entry.id !== workspace.id);
      state.workspaces.push(workspace);
      state.selectedId = workspace.id;
      state.activeId = workspace.id;
      return state;
    });
  }

  async function updateRemoteWorkspace(input = {}) {
    const workspaceId = String(input.workspaceId ?? "").trim();
    if (!workspaceId) throw new Error("workspaceId is required");
    const { workspaceId: _workspaceId, ...patch } = input;
    return mutateWorkspaceState(async (state) => {
      const existing = state.workspaces.find((entry) => entry.id === workspaceId);
      if (!existing) return state;

      let nextWorkspace = { ...existing, ...patch };
      const nextRemoteType = nextWorkspace.remoteType === "opencode" ? "opencode" : "openwork";
      if (nextRemoteType === "openwork") {
        const rawHostUrl = typeof nextWorkspace.openworkHostUrl === "string" && nextWorkspace.openworkHostUrl.trim()
          ? nextWorkspace.openworkHostUrl.trim()
          : null;
        const nextBaseUrl = String(nextWorkspace.baseUrl ?? "").trim();
        const hostUrl = stripOpenworkWorkspaceMount(rawHostUrl ?? nextBaseUrl);
        const directory = typeof nextWorkspace.directory === "string" && nextWorkspace.directory.trim()
          ? nextWorkspace.directory.trim()
          : null;
        const parsedWorkspaceId = parseOpenworkWorkspaceIdFromUrl(rawHostUrl) || parseOpenworkWorkspaceIdFromUrl(nextBaseUrl);
        let remoteWorkspaceId = parsedWorkspaceId || (
          typeof nextWorkspace.openworkWorkspaceId === "string" && nextWorkspace.openworkWorkspaceId.trim()
            ? nextWorkspace.openworkWorkspaceId.trim()
            : null
        );
        let remoteWorkspaceName = nextWorkspace.openworkWorkspaceName ?? null;
        if (!remoteWorkspaceId) {
          const discovered = await discoverOpenworkWorkspace({
            hostUrl: hostUrl ?? nextBaseUrl,
            token: nextWorkspace.openworkToken,
            hostToken: nextWorkspace.openworkHostToken,
            directory,
          });
          if (!discovered?.id) {
            throw new Error(
              directory
                ? `OpenWork server has no workspace matching ${directory}.`
                : "OpenWork server returned no workspaces.",
            );
          }
          remoteWorkspaceId = String(discovered.id).trim();
          remoteWorkspaceName = openworkWorkspaceDisplayName(discovered);
        }
        const nextId = openworkRemoteWorkspaceId(hostUrl ?? nextBaseUrl, remoteWorkspaceId);
        nextWorkspace = normalizeWorkspaceEntry({
          ...nextWorkspace,
          id: nextId,
          baseUrl: hostUrl ?? nextBaseUrl,
          openworkHostUrl: hostUrl,
          directory,
          remoteType: "openwork",
          openworkWorkspaceId: remoteWorkspaceId,
          openworkWorkspaceName: remoteWorkspaceName,
        });
        if (nextId !== workspaceId) {
          if (state.selectedId === workspaceId) state.selectedId = nextId;
          if (state.activeId === workspaceId) state.activeId = nextId;
          if (state.watchedId === workspaceId) state.watchedId = nextId;
        }
      }

      state.workspaces = state.workspaces.map((entry) =>
        entry.id === workspaceId ? nextWorkspace : entry,
      );
      return state;
    });
  }

  async function updateWorkspaceDisplayName(input = {}) {
    const workspaceId = String(input.workspaceId ?? "").trim();
    if (!workspaceId) throw new Error("workspaceId is required");
    return mutateWorkspaceState((state) => {
      state.workspaces = state.workspaces.map((entry) =>
        entry.id === workspaceId ? { ...entry, displayName: input.displayName ?? null } : entry,
      );
      return state;
    });
  }

  async function forgetWorkspace(workspaceId) {
    if (!workspaceId) throw new Error("workspaceId is required");
    return mutateWorkspaceState((state) => {
      state.workspaces = state.workspaces.filter((entry) => entry.id !== workspaceId);
      if (state.selectedId === workspaceId) state.selectedId = "";
      if (state.activeId === workspaceId) state.activeId = null;
      if (state.watchedId === workspaceId) state.watchedId = null;
      return state;
    });
  }

  async function addAuthorizedRoot(input = {}) {
    const workspacePath = String(input.workspacePath ?? "").trim();
    const authorizedRoot = String(input.folderPath ?? input.authorizedRoot ?? "").trim();
    if (!workspacePath || !authorizedRoot) {
      throw new Error("workspacePath and folderPath are required");
    }
    const config = await readWorkspaceOpenworkConfig(workspacePath);
    if (!Array.isArray(config.authorizedRoots)) {
      config.authorizedRoots = [];
    }
    if (!config.authorizedRoots.includes(authorizedRoot)) {
      config.authorizedRoots.push(authorizedRoot);
    }
    return writeWorkspaceOpenworkConfig(workspacePath, config);
  }

  async function exportConfig(input = {}) {
    const workspaceId = String(input.workspaceId ?? "").trim();
    const outputPath = String(input.outputPath ?? "").trim();
    if (!workspaceId) throw new Error("workspaceId is required");
    if (!outputPath) throw new Error("outputPath is required");
    const state = await readWorkspaceState();
    const workspace = state.workspaces.find((entry) => entry.id === workspaceId);
    if (!workspace) throw new Error("Unknown workspaceId");
    return exportWorkspaceConfig({ workspace, outputPath });
  }

  async function importConfig(input = {}) {
    const archivePath = String(input.archivePath ?? "").trim();
    const targetDirRaw = String(input.targetDir ?? "").trim();
    if (!archivePath) throw new Error("archivePath is required");
    if (!targetDirRaw) throw new Error("targetDir is required");
    const targetDir = await normalizeLocalWorkspacePath(targetDirRaw);
    const imported = await importWorkspaceConfig({
      archivePath,
      targetDir,
      name: input.name ?? null,
    });
    const workspace = normalizeWorkspaceEntry({
      id: localWorkspaceId(targetDir),
      name: imported.workspaceName,
      displayName: null,
      path: targetDir,
      preset: imported.preset,
      workspaceType: "local",
    });
    return mutateWorkspaceState((state) => {
      const key = workspacePathKey(workspace);
      state.workspaces = state.workspaces.filter(
        (entry) => entry.id !== workspace.id && normalizeWorkspacePathKey(entry.path) !== key,
      );
      state.workspaces.push(workspace);
      state.selectedId = workspace.id;
      state.activeId = workspace.id;
      state.watchedId = workspace.id;
      return state;
    });
  }

  async function resetOpenworkState() {
    await rm(workspaceStatePath(), { force: true });
    await rm(desktopBootstrapPath(), { force: true });
    return undefined;
  }

  return {
    addAuthorizedRoot,
    createRemoteWorkspace,
    createWorkspace,
    debugDesktopBootstrapConfig,
    defaultWorkspaceOpenworkConfig,
    exportConfig,
    forgetWorkspace,
    getDesktopBootstrapConfig,
    importConfig,
    listLocalWorkspacePaths,
    migrateLegacyElectronWorkspaceStateIfNeeded,
    readWorkspaceOpenworkConfig,
    readWorkspaceState,
    resetOpenworkState,
    setDesktopBootstrapConfig,
    setRuntimeActiveWorkspace,
    setSelectedWorkspace,
    updateRemoteWorkspace,
    updateWorkspaceDisplayName,
    writeWorkspaceOpenworkConfig,
    writeWorkspaceState,
  };
}
