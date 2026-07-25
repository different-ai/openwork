import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const MAX_CONFIG_ROOT_LENGTH = 4_096;
const FORBIDDEN_CONFIG_ROOT_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

function pathApi(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function optionEnv(opts) {
  return opts?.env ?? process.env;
}

function optionPlatform(opts) {
  return opts?.platform ?? process.platform;
}

function envValue(env, key) {
  return String(env?.[key] ?? "").trim();
}

function envRawValue(env, key) {
  const value = env?.[key];
  return typeof value === "string" ? value : "";
}

function optionHomeDir(opts) {
  const configured = opts?.homeDir?.trim();
  if (configured) return configured;
  const env = optionEnv(opts);
  const platform = optionPlatform(opts);
  const fromEnv = platform === "win32"
    ? envValue(env, "USERPROFILE") || envValue(env, "HOME")
    : envValue(env, "HOME");
  return fromEnv || homedir();
}

function defaultOpenworkConfigDir(opts) {
  const env = optionEnv(opts);
  const platform = optionPlatform(opts);
  const paths = pathApi(platform);
  const homeDir = optionHomeDir(opts);
  if (platform === "win32") {
    const appData = envValue(env, "APPDATA");
    const root = appData || paths.join(homeDir, "AppData", "Roaming");
    return paths.join(root, "openwork");
  }
  const xdgConfigHome = envValue(env, "XDG_CONFIG_HOME");
  const root = xdgConfigHome || paths.join(homeDir, ".config");
  return paths.join(root, "openwork");
}

export function openworkConfigDir(opts) {
  const env = optionEnv(opts);
  const platform = optionPlatform(opts);
  const paths = pathApi(platform);
  const override = envValue(env, "OPENWORK_SERVER_CONFIG");
  if (override) return paths.dirname(paths.resolve(override));
  return defaultOpenworkConfigDir(opts);
}

export function openworkServerConfigPath(opts) {
  const env = optionEnv(opts);
  const platform = optionPlatform(opts);
  const paths = pathApi(platform);
  const override = envValue(env, "OPENWORK_SERVER_CONFIG");
  if (override) return paths.resolve(override);
  return paths.join(defaultOpenworkConfigDir(opts), "server.json");
}

export function openworkEnvStorePath(opts) {
  const env = optionEnv(opts);
  const platform = optionPlatform(opts);
  const paths = pathApi(platform);
  const override = envValue(env, "OPENWORK_ENV_STORE");
  if (override) return paths.resolve(override);
  return paths.join(defaultOpenworkConfigDir(opts), "env.json");
}

function safeConfigRoot(value, paths) {
  return value.length > 0
    && value.length <= MAX_CONFIG_ROOT_LENGTH
    && paths.isAbsolute(value)
    && !FORBIDDEN_CONFIG_ROOT_CHARS.test(value);
}

export function globalOpencodeConfigDir(opts) {
  const env = optionEnv(opts);
  const platform = optionPlatform(opts);
  const paths = pathApi(platform);
  const configuredDirectory = envRawValue(env, "OPENCODE_CONFIG_DIR");
  if (safeConfigRoot(configuredDirectory, paths)) return configuredDirectory;

  const configuredRoot = envRawValue(env, "XDG_CONFIG_HOME");
  const configRoot = safeConfigRoot(configuredRoot, paths)
    ? configuredRoot
    : paths.join(optionHomeDir(opts), ".config");
  // OpenCode accepts OPENCODE_CONFIG_DIR as the directory containing its
  // opencode.json(c) files. It is not an XDG parent directory.
  return paths.join(configRoot, "opencode");
}

export function resolveGlobalOpencodeConfigPath(opts) {
  const platform = optionPlatform(opts);
  const paths = pathApi(platform);
  const base = globalOpencodeConfigDir(opts);
  const jsonc = paths.join(base, "opencode.jsonc");
  const json = paths.join(base, "opencode.json");
  if (existsSync(jsonc)) return jsonc;
  if (existsSync(json)) return json;
  return jsonc;
}

export function workspaceOpencodeConfigCandidates(workspaceRoot) {
  return [
    path.join(workspaceRoot, "opencode.jsonc"),
    path.join(workspaceRoot, "opencode.json"),
    path.join(workspaceRoot, ".opencode", "opencode.jsonc"),
    path.join(workspaceRoot, ".opencode", "opencode.json"),
  ];
}

export function resolveWorkspaceOpencodeConfigPath(workspaceRoot) {
  const candidates = workspaceOpencodeConfigCandidates(workspaceRoot);
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function desktopConfigDir(opts) {
  const env = optionEnv(opts);
  const platform = optionPlatform(opts);
  const paths = pathApi(platform);
  const xdgConfigHome = envValue(env, "XDG_CONFIG_HOME");
  if (xdgConfigHome) return xdgConfigHome;
  if (platform === "win32") {
    const localAppData = envValue(env, "LOCALAPPDATA");
    if (localAppData) return localAppData;
    return paths.join(optionHomeDir(opts), "AppData", "Local");
  }
  return paths.join(optionHomeDir(opts), ".config");
}

export function desktopBootstrapPath(opts) {
  const env = optionEnv(opts);
  const platform = optionPlatform(opts);
  const paths = pathApi(platform);
  const override = envValue(env, "OPENWORK_DESKTOP_BOOTSTRAP_PATH");
  if (override) return override;
  if (envValue(env, "OPENWORK_DEV_MODE") === "1" && opts?.userDataDir) {
    return paths.join(opts.userDataDir, "openwork-dev-data", "home", ".config", "openwork", "desktop-bootstrap.json");
  }
  return paths.join(desktopConfigDir(opts), "openwork", "desktop-bootstrap.json");
}

export function legacyDesktopBootstrapPath(opts) {
  const platform = optionPlatform(opts);
  const paths = pathApi(platform);
  // Existing installers may have written this file using USERPROFILE/HOME while
  // Electron used os.homedir(). optionHomeDir accepts an explicit homeDir but
  // otherwise checks the same env variables before os.homedir(), so both legacy
  // locations continue to resolve for normal installs.
  return paths.join(optionHomeDir(opts), ".config", "openwork", "desktop-bootstrap.json");
}

export function expandHomePath(value, opts) {
  if (value === "~") return optionHomeDir(opts);
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return pathApi(optionPlatform(opts)).join(optionHomeDir(opts), value.slice(2));
  }
  return value;
}

export function openworkServerDataDir(opts) {
  const env = optionEnv(opts);
  const platform = optionPlatform(opts);
  const paths = pathApi(platform);
  const override = envValue(env, "OPENWORK_DATA_DIR");
  if (override) return expandHomePath(override, opts);
  return paths.join(optionHomeDir(opts), ".openwork", "openwork-server");
}

export function opencodeDataDirs(opts) {
  const env = optionEnv(opts);
  const platform = optionPlatform(opts);
  const paths = pathApi(platform);
  const homeDir = optionHomeDir(opts);
  const dirs = [];
  const xdgDataHome = envValue(env, "XDG_DATA_HOME");
  if (xdgDataHome) dirs.push(paths.join(xdgDataHome, "opencode"));
  dirs.push(paths.join(homeDir, ".local", "share", "opencode"));
  if (platform === "darwin") dirs.push(paths.join(homeDir, "Library", "Application Support", "opencode"));
  if (platform === "win32") {
    const appData = envValue(env, "APPDATA") || paths.join(homeDir, "AppData", "Roaming");
    dirs.push(paths.join(appData, "opencode"));
  }
  return Array.from(new Set(dirs));
}

export function opencodeCacheDirs(opts) {
  const env = optionEnv(opts);
  const platform = optionPlatform(opts);
  const paths = pathApi(platform);
  const dirs = [];
  const xdgCacheHome = envValue(env, "XDG_CACHE_HOME");
  if (xdgCacheHome) dirs.push(paths.join(xdgCacheHome, "opencode"));
  dirs.push(paths.join(optionHomeDir(opts), ".cache", "opencode"));
  return Array.from(new Set(dirs));
}
