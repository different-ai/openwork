import os from "node:os";
import path from "node:path";

export const DEFAULT_DEN_BASE_URL = "https://app.openworklabs.com";

export function envFlagEnabled(name, env = process.env) {
  const value = env[name]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function configHomePath({ env = process.env, platform = process.platform, homedir = os.homedir() } = {}) {
  if (env.XDG_CONFIG_HOME?.trim()) return env.XDG_CONFIG_HOME.trim();
  if (platform === "win32" && env.APPDATA?.trim()) return env.APPDATA.trim();
  return path.join(homedir, ".config");
}

export function managedDesktopBootstrapPath({ env = process.env, platform = process.platform } = {}) {
  if (platform === "win32") {
    const programData = env.ProgramData?.trim() || env.PROGRAMDATA?.trim() || "C:\\ProgramData";
    return path.join(programData, "OpenWork", "desktop-bootstrap.json");
  }
  if (platform === "darwin") {
    return path.join("/Library", "Application Support", "OpenWork", "desktop-bootstrap.json");
  }
  return path.join("/etc", "openwork", "desktop-bootstrap.json");
}

export function userDesktopBootstrapPath(options = {}) {
  return path.join(configHomePath(options), "openwork", "desktop-bootstrap.json");
}

export function legacyDevDesktopBootstrapPath({ homedir = os.homedir() } = {}) {
  return path.join(homedir, ".config", "openwork", "desktop-bootstrap.json");
}

export function desktopBootstrapCandidates(options = {}) {
  const { env = process.env } = options;
  const candidates = [];
  const envOverride = env.OPENWORK_DESKTOP_BOOTSTRAP_PATH?.trim();
  if (envOverride) {
    candidates.push({ source: "env", path: envOverride });
  }
  candidates.push(
    { source: "managed", path: managedDesktopBootstrapPath(options) },
    { source: "user", path: userDesktopBootstrapPath(options) },
  );
  const legacyDevPath = legacyDevDesktopBootstrapPath(options);
  if (!candidates.some((candidate) => candidate.path === legacyDevPath)) {
    candidates.push({ source: "user-dev", path: legacyDevPath });
  }
  return candidates;
}

export function defaultDesktopBootstrapConfig({ env = process.env } = {}) {
  return {
    baseUrl: DEFAULT_DEN_BASE_URL,
    apiBaseUrl: null,
    requireSignin: envFlagEnabled("OPENWORK_FORCE_SIGNIN", env),
    source: "default",
    path: null,
  };
}

export function normalizeDesktopBootstrapConfig(input, options = {}) {
  const baseUrl = typeof input?.baseUrl === "string" ? input.baseUrl.trim() : "";
  if (!baseUrl) throw new Error("baseUrl is required");
  const apiBaseUrl = typeof input?.apiBaseUrl === "string" && input.apiBaseUrl.trim().length > 0
    ? input.apiBaseUrl.trim()
    : null;
  return {
    baseUrl,
    apiBaseUrl,
    requireSignin: envFlagEnabled("OPENWORK_FORCE_SIGNIN", options.env) || input?.requireSignin === true,
  };
}

export function normalizeUrlOrigin(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return "";
  try {
    return new URL(raw).origin.replace(/\/+$/, "").toLowerCase();
  } catch {
    return raw.replace(/\/+$/, "").toLowerCase();
  }
}

export function isWorkspaceCompatibleWithManagedDen(workspace, denBaseUrl) {
  if (workspace?.workspaceType !== "remote" || workspace?.remoteType !== "openwork") return true;
  const activeDenOrigin = normalizeUrlOrigin(denBaseUrl);
  if (!activeDenOrigin) return true;
  const workspaceDenOrigin = normalizeUrlOrigin(workspace?.openworkDenBaseUrl);
  // Legacy remote OpenWork records predate Den-origin metadata. Keep them in
  // persisted desktop state so startup/filtering is non-destructive; only hide
  // records that explicitly belong to a different Den origin.
  if (!workspaceDenOrigin) return true;
  return workspaceDenOrigin === activeDenOrigin;
}

export function filterWorkspacesForManagedDen(workspaces, denBaseUrl) {
  const input = Array.isArray(workspaces) ? workspaces : [];
  return input.filter((workspace) => isWorkspaceCompatibleWithManagedDen(workspace, denBaseUrl));
}
