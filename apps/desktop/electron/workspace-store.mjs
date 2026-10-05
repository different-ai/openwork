// Desktop workspace persistence and bootstrap configuration. This module owns
// on-disk workspace state, per-workspace openwork.json files, and the
// workspace-facing command operations.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  desktopBootstrapPath as resolveDesktopBootstrapPath,
  legacyDesktopBootstrapPath as resolveLegacyDesktopBootstrapPath,
  normalizeWorkspaceRootPath,
  openworkServerConfigPath as resolveOpenworkServerConfigPath,
} from "@openwork/paths";

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

// Resolved once at module load so a mid-session process.env mutation
// (runtime.mjs buildChildEnv -> Object.assign(process.env)) can never retarget
// reads to a different file.
const DEFAULT_DESKTOP_BOOTSTRAP_PATH = resolveDesktopBootstrapPath({ homeDir: os.homedir() });

// Older builds resolved the default as ~/.config on every OS, ignoring
// LOCALAPPDATA and XDG_CONFIG_HOME. Keep reading that file when the canonical one
// is missing so existing installs keep their deployment config.
const LEGACY_DESKTOP_BOOTSTRAP_PATH = resolveLegacyDesktopBootstrapPath({ homeDir: os.homedir() });
const HOSTED_DESKTOP_WEB_URL = "https://app.openworklabs.com";
const HOSTED_DESKTOP_API_URL = "https://api.openworklabs.com";

function bootstrapUrlOrigin(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    return new URL(value.trim()).origin;
  } catch {
    return value.trim().replace(/\/+$/, "");
  }
}

function isHostedDesktopBootstrapConfig(config) {
  const baseUrlOrigin = bootstrapUrlOrigin(config?.baseUrl);
  return baseUrlOrigin === HOSTED_DESKTOP_WEB_URL || baseUrlOrigin === HOSTED_DESKTOP_API_URL;
}

export function createWorkspaceStore({
  app,
  defaultDenBaseUrl,
  defaultRequireSignin,
  forceRequireSignin,
}) {
  function desktopBootstrapPath() {
    if (process.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH?.trim()) {
      return resolveDesktopBootstrapPath({ env: process.env, homeDir: os.homedir(), userDataDir: app.getPath("userData") });
    }
    // Dev mode swaps process.env.HOME to the sandboxed dev-data home midway
    // through startup (runtime.mjs buildChildEnv -> Object.assign(process.env)),
    // which changes what os.homedir() returns. Resolve the dev-data home
    // deterministically so early and late IPC reads target the same file.
    if (process.env.OPENWORK_DEV_MODE === "1") {
      return resolveDesktopBootstrapPath({ env: process.env, homeDir: os.homedir(), userDataDir: app.getPath("userData") });
    }
    return DEFAULT_DESKTOP_BOOTSTRAP_PATH;
  }

  function legacyDesktopBootstrapPath() {
    // An explicit bootstrap path defines an isolated installation boundary.
    // Never let a legacy global config cross that boundary: it may contain a
    // completed activation from another distribution or deployment.
    if (process.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH?.trim()) return null;
    const primary = desktopBootstrapPath();
    if (primary === DEFAULT_DESKTOP_BOOTSTRAP_PATH && LEGACY_DESKTOP_BOOTSTRAP_PATH !== primary) {
      return LEGACY_DESKTOP_BOOTSTRAP_PATH;
    }
    return null;
  }

  function workspaceStatePath() {
    const override = process.env.OPENWORK_DESKTOP_WORKSPACE_STATE_PATH?.trim();
    if (override) return path.resolve(override);
    return path.join(app.getPath("userData"), "openwork-workspaces.json");
  }

  function openworkServerTokenStorePath() {
    const override = process.env.OPENWORK_SERVER_TOKEN_STORE_PATH?.trim();
    if (override) return path.resolve(override);
    return path.join(app.getPath("userData"), "openwork-server-tokens.json");
  }

  function openworkServerConfigPath() {
    return resolveOpenworkServerConfigPath({ env: process.env, homeDir: os.homedir() });
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

    // The handoff grant is a one-time, short-lived (~5 min) desktop sign-in
    // token written to this machine-local config by the bootstrap CLI. The app
    // exchanges it once on boot and then rewrites this file with `handoff: null`
    // (see den-auth-provider) so it is never reusable. It is intentionally kept
    // in plaintext here because it is single-use and local-only; do not persist
    // long-lived secrets in this file.
    const handoffInput = input?.handoff;
    const handoff = handoffInput && typeof handoffInput === "object"
      ? {
          grant: typeof handoffInput.grant === "string" ? handoffInput.grant.trim() : "",
          denBaseUrl: typeof handoffInput.denBaseUrl === "string" ? handoffInput.denBaseUrl.trim() : "",
          orgId: typeof handoffInput.orgId === "string" ? handoffInput.orgId.trim() : "",
          orgName: typeof handoffInput.orgName === "string" ? handoffInput.orgName.trim() : "",
          orgSlug: typeof handoffInput.orgSlug === "string" ? handoffInput.orgSlug.trim() : "",
          skillId: typeof handoffInput.skillId === "string" ? handoffInput.skillId.trim() : "",
          skillTitle: typeof handoffInput.skillTitle === "string" ? handoffInput.skillTitle.trim() : "",
          createdAt: typeof handoffInput.createdAt === "string" ? handoffInput.createdAt.trim() : "",
        }
      : null;
    const normalizedHandoff = handoff?.grant && handoff.denBaseUrl && handoff.orgId && handoff.orgName && handoff.skillId && handoff.skillTitle
      ? handoff
      : null;
    const preparedInput = input?.prepared;
    const prepared = preparedInput && typeof preparedInput === "object"
      ? {
          orgId: typeof preparedInput.orgId === "string" ? preparedInput.orgId.trim() : "",
          orgName: typeof preparedInput.orgName === "string" ? preparedInput.orgName.trim() : "",
          orgSlug: typeof preparedInput.orgSlug === "string" ? preparedInput.orgSlug.trim() : "",
          skillId: typeof preparedInput.skillId === "string" ? preparedInput.skillId.trim() : "",
          skillTitle: typeof preparedInput.skillTitle === "string" ? preparedInput.skillTitle.trim() : "",
          skillsDir: typeof preparedInput.skillsDir === "string" ? preparedInput.skillsDir.trim() : "",
          skillPath: typeof preparedInput.skillPath === "string" ? preparedInput.skillPath.trim() : "",
          preparedAt: typeof preparedInput.preparedAt === "string" ? preparedInput.preparedAt.trim() : "",
        }
      : null;
    const normalizedPrepared = prepared?.orgId && prepared.orgName && prepared.skillId && prepared.skillTitle && prepared.skillPath
      ? prepared
      : null;
    const claimLinksInput = Array.isArray(input?.claimLinks) ? input.claimLinks : [];
    const claimLinks = claimLinksInput.flatMap((link) => {
      if (!link || typeof link !== "object") return [];
      const id = typeof link.id === "string" ? link.id.trim() : "";
      const role = typeof link.role === "string" ? link.role.trim() : "";
      const token = typeof link.token === "string" ? link.token.trim() : "";
      const url = typeof link.url === "string" ? link.url.trim() : "";
      const expiresAt = typeof link.expiresAt === "string" ? link.expiresAt.trim() : "";
      return id && role && url && expiresAt ? [{ id, role, ...(token ? { token } : {}), url, expiresAt }] : [];
    });
    const writtenAt = typeof input?.writtenAt === "string" ? input.writtenAt.trim() : "";
    const apiBaseUrl = typeof input?.apiBaseUrl === "string" ? input.apiBaseUrl.trim() : "";
    const brandAppName = typeof input?.brandAppName === "string" ? input.brandAppName.trim().slice(0, 64) : "";
    const brandLogoUrl = typeof input?.brandLogoUrl === "string" ? input.brandLogoUrl.trim() : "";
    const brandIconUrl = typeof input?.brandIconUrl === "string" ? input.brandIconUrl.trim() : "";
    const enterpriseActivationInput = input?.enterpriseActivation;
    const enterpriseActivation = enterpriseActivationInput && typeof enterpriseActivationInput === "object"
      ? {
          activatedAt: typeof enterpriseActivationInput.activatedAt === "string"
            ? enterpriseActivationInput.activatedAt.trim()
            : "",
          denBaseUrl: typeof enterpriseActivationInput.denBaseUrl === "string"
            ? enterpriseActivationInput.denBaseUrl.trim()
            : "",
        }
      : null;
    const normalizedEnterpriseActivation = enterpriseActivation?.activatedAt && enterpriseActivation.denBaseUrl
      ? enterpriseActivation
      : null;
    return {
      baseUrl,
      ...(apiBaseUrl ? { apiBaseUrl } : {}),
      requireSignin: forceRequireSignin || input?.requireSignin === true,
      // Only an explicit policy is carried. The artifact default is never
      // materialized here: desktop-bootstrap.json is shared by both flavors
      // (one application identifier, one user-data directory), so persisting
      // the enterprise default would gate the public artifact on the same
      // machine. Consumers fall back to their own build default when the key
      // is absent, which is exactly the documented precedence.
      ...(typeof input?.requireActivation === "boolean"
        ? { requireActivation: input.requireActivation }
        : {}),
      ...(brandAppName ? { brandAppName } : {}),
      ...(brandLogoUrl ? { brandLogoUrl } : {}),
      ...(brandIconUrl ? { brandIconUrl } : {}),
      ...(writtenAt ? { writtenAt } : {}),
      ...(claimLinks.length > 0 ? { claimLinks } : {}),
      ...(normalizedHandoff ? { handoff: normalizedHandoff } : {}),
      ...(normalizedPrepared ? { prepared: normalizedPrepared } : {}),
      ...(normalizedEnterpriseActivation ? { enterpriseActivation: normalizedEnterpriseActivation } : {}),
    };
  }

  function desktopBootstrapCandidateTimeMs(candidate) {
    const writtenAt = typeof candidate.parsed?.writtenAt === "string" ? candidate.parsed.writtenAt.trim() : "";
    const writtenAtMs = writtenAt ? Date.parse(writtenAt) : Number.NaN;
    return Number.isFinite(writtenAtMs) ? writtenAtMs : candidate.mtimeMs;
  }

  function compareDesktopBootstrapCandidates(left, right) {
    const classDifference = Number(!isHostedDesktopBootstrapConfig(left.normalized)) - Number(!isHostedDesktopBootstrapConfig(right.normalized));
    return classDifference || desktopBootstrapCandidateTimeMs(left) - desktopBootstrapCandidateTimeMs(right);
  }

  async function readDesktopBootstrapCandidate(candidatePath) {
    let exists = false;
    let mtimeMs = 0;
    try {
      const stats = await stat(candidatePath);
      exists = true;
      mtimeMs = stats.mtimeMs;
    } catch {
      // Missing paths are normal; keep the read error below for diagnostics.
    }

    try {
      const raw = await readFile(candidatePath, "utf8");
      const parsed = JSON.parse(raw);
      return {
        ok: true,
        path: candidatePath,
        exists: true,
        raw,
        parsed,
        normalized: normalizeDesktopBootstrapConfig(parsed),
        mtimeMs,
        error: null,
      };
    } catch (error) {
      return {
        ok: false,
        path: candidatePath,
        exists,
        raw: null,
        parsed: null,
        normalized: null,
        mtimeMs,
        error,
      };
    }
  }

  function readDesktopBootstrapCandidateSync(candidatePath) {
    let exists = false;
    let mtimeMs = 0;
    try {
      const stats = statSync(candidatePath);
      exists = true;
      mtimeMs = stats.mtimeMs;
    } catch {
      // Missing paths are normal; keep the read error below for diagnostics.
    }

    try {
      const raw = readFileSync(candidatePath, "utf8");
      const parsed = JSON.parse(raw);
      return {
        ok: true,
        path: candidatePath,
        exists: true,
        raw,
        parsed,
        normalized: normalizeDesktopBootstrapConfig(parsed),
        mtimeMs,
        error: null,
      };
    } catch (error) {
      return {
        ok: false,
        path: candidatePath,
        exists,
        raw: null,
        parsed: null,
        normalized: null,
        mtimeMs,
        error,
      };
    }
  }

  async function migrateLegacyDesktopBootstrapConfig(configPath, legacyCandidate) {
    try {
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(configPath, legacyCandidate.raw, "utf8");
      console.info("[desktop-bootstrap] migrated legacy config", {
        from: legacyCandidate.path,
        to: configPath,
      });
    } catch (migrationError) {
      console.warn("[desktop-bootstrap] legacy config migration failed", migrationError);
    }
  }

  async function getDesktopBootstrapConfig() {
    const configPath = desktopBootstrapPath();
    const primary = await readDesktopBootstrapCandidate(configPath);
    const legacyPath = legacyDesktopBootstrapPath();
    const legacy = legacyPath ? await readDesktopBootstrapCandidate(legacyPath) : null;

    if (primary.ok && legacy?.ok) {
      if (compareDesktopBootstrapCandidates(legacy, primary) > 0) {
        await migrateLegacyDesktopBootstrapConfig(configPath, legacy);
        return { ...legacy.normalized, fromFile: true };
      }
      return { ...primary.normalized, fromFile: true };
    }

    if (primary.ok) return { ...primary.normalized, fromFile: true };

    if (legacy?.ok) {
      await migrateLegacyDesktopBootstrapConfig(configPath, legacy);
      return { ...legacy.normalized, fromFile: true };
    }

    console.warn("[desktop-bootstrap] falling back to defaults", {
      path: configPath,
      error: primary.error instanceof Error ? primary.error.message : String(primary.error),
    });
    return {
      baseUrl: defaultDenBaseUrl,
      requireSignin: defaultRequireSignin,
      fromFile: false,
    };
  }

  function readDesktopBootstrapConfigSync() {
    const configPath = desktopBootstrapPath();
    const primary = readDesktopBootstrapCandidateSync(configPath);
    const legacyPath = legacyDesktopBootstrapPath();
    const legacy = legacyPath ? readDesktopBootstrapCandidateSync(legacyPath) : null;

    if (primary.ok && legacy?.ok) {
      return {
        ...(compareDesktopBootstrapCandidates(legacy, primary) > 0 ? legacy.normalized : primary.normalized),
        fromFile: true,
      };
    }

    if (primary.ok) return { ...primary.normalized, fromFile: true };
    if (legacy?.ok) return { ...legacy.normalized, fromFile: true };

    return {
      baseUrl: defaultDenBaseUrl,
      requireSignin: defaultRequireSignin,
      fromFile: false,
    };
  }

  async function debugDesktopBootstrapConfig() {
    const configPath = desktopBootstrapPath();
    const legacyPath = legacyDesktopBootstrapPath();
    const result = {
      path: configPath,
      legacyPath,
      legacyExists: legacyPath ? existsSync(legacyPath) : false,
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
    const stamped = { ...normalized, writtenAt: new Date().toISOString() };
    await writeJsonFileAtomic(outputPath, stamped);
    return stamped;
  }

  async function clearDesktopBootstrapFiles() {
    await rm(desktopBootstrapPath(), { force: true });
    const legacyPath = legacyDesktopBootstrapPath();
    if (legacyPath) {
      await rm(legacyPath, { force: true });
    }
  }

  async function clearDesktopBootstrapConfig() {
    await clearDesktopBootstrapFiles();
    return undefined;
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
    const normalized = normalizeWorkspaceRootPath(expanded, { platform: process.platform });
    const resolved = path.resolve(normalized);
    return realpath(resolved).catch(() => resolved);
  }

  function normalizeWorkspacePathKey(value) {
    try {
      const normalized = normalizeWorkspaceRootPath(value, { platform: process.platform });
      return normalized ? path.resolve(normalized).replace(/\\/g, "/").toLowerCase() : "";
    } catch {
      return "";
    }
  }

  function normalizeRecoveredWorkspacePath(value) {
    try {
      return normalizeWorkspaceRootPath(value, { platform: process.platform });
    } catch {
      return "";
    }
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

  async function forgetWorkspaceToken(workspacePath) {
    const workspaceKey = normalizeWorkspacePathKey(workspacePath);
    if (!workspaceKey) return;

    const store = await readJsonFile(openworkServerTokenStorePath(), null);
    if (!isRecord(store) || !isRecord(store.workspaces)) return;

    const workspaces = { ...store.workspaces };
    let changed = false;
    for (const storedPath of Object.keys(workspaces)) {
      if (normalizeWorkspacePathKey(normalizeRecoveredWorkspacePath(storedPath)) !== workspaceKey) continue;
      delete workspaces[storedPath];
      changed = true;
    }
    if (changed) {
      await writeJsonFileAtomic(openworkServerTokenStorePath(), { ...store, workspaces });
    }
  }

  async function recoverWorkspacesFromServerConfig() {
    const config = await readJsonFile(openworkServerConfigPath(), null);
    if (!isRecord(config) || !Array.isArray(config.workspaces)) return [];

    const seen = new Set();
    const workspaces = [];
    for (const entry of config.workspaces) {
      if (!isRecord(entry)) continue;
      // Remote workspaces were removed; skip any an older build persisted.
      if (isLegacyRemoteWorkspace(entry)) continue;
      const rawPath = typeof entry.path === "string" ? entry.path.trim() : "";
      const normalizedPath = await normalizeLocalWorkspacePath(normalizeRecoveredWorkspacePath(rawPath));
      if (!normalizedPath || !(await pathExists(normalizedPath))) continue;

      const id = typeof entry.id === "string" && entry.id.trim()
        ? entry.id.trim()
        : localWorkspaceId(normalizedPath);
      const key = normalizeWorkspacePathKey(normalizedPath);
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
        workspaceType: "local",
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

  function isLegacyRemoteWorkspace(entry) {
    return isRecord(entry) && entry.workspaceType === "remote";
  }

  function normalizeWorkspaceEntry(input) {
    return {
      id: String(input.id),
      name: String(input.name ?? "Workspace"),
      path: String(input.path ?? ""),
      preset: String(input.preset ?? "starter"),
      workspaceType: "local",
      baseUrl: input.baseUrl ?? null,
      directory: input.directory ?? null,
      displayName: input.displayName ?? null,
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
    const workspaceStateExists = existsSync(workspaceStatePath());
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
    if (!workspaceStateExists && process.env.OPENWORK_DESKTOP_DISABLE_WORKSPACE_RECOVERY !== "1") {
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
    // Remote workspaces were removed. Drop entries persisted by older builds
    // and move any selection that pointed at one to a remaining workspace.
    const droppedIds = new Set();
    const localWorkspaces = workspaces.filter((entry) => {
      if (!isLegacyRemoteWorkspace(entry)) return true;
      droppedIds.add(String(entry.id ?? ""));
      return false;
    });
    if (droppedIds.size > 0) {
      changed = true;
      const fallbackId = String(localWorkspaces[0]?.id ?? "");
      if (droppedIds.has(selectedId)) selectedId = fallbackId;
      if (watchedId && droppedIds.has(watchedId)) watchedId = null;
      if (activeId && droppedIds.has(activeId)) activeId = fallbackId || null;
    }

    const nextState = {
      selectedId,
      watchedId,
      activeId,
      workspaces: localWorkspaces,
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

  async function bootstrapFirstLaunchWorkspace() {
    const state = await readWorkspaceState();
    // Recovery and an explicitly saved empty list both take precedence.
    if (state.workspaces.length > 0 || existsSync(workspaceStatePath())) return null;
    const home = process.env.OPENWORK_DEV_MODE === "1" && process.env.OPENWORK_DEV_SHARED_STATE !== "1"
      ? path.join(app.getPath("userData"), "openwork-dev-data", "home")
      : os.homedir();
    const folderPath = await normalizeLocalWorkspacePath(path.join(home, "OpenWork Chat"));
    try {
      await createWorkspace({ folderPath });
      return null;
    } catch (error) {
      // A blocked default folder is recoverable by choosing another folder.
      // Never hide registry writes or unexpected initialization failures.
      if (
        !["EEXIST", "ENOTDIR", "EACCES", "EPERM", "EROFS"].includes(error?.code)
        || typeof error.path !== "string"
        || (error.path !== folderPath && !error.path.startsWith(`${folderPath}${path.sep}`))
      ) throw error;
      return { folderPath, error: error.message };
    }
  }

  async function listLocalWorkspacePaths() {
    return (await readWorkspaceState())
      .workspaces
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
    if (!(await pathExists(path.join(folderPath, ".opencode", "openwork.json")))) {
      await writeWorkspaceOpenworkConfig(folderPath, defaultWorkspaceOpenworkConfig(folderPath, preset));
    }

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
    let workspacePath = "";
    const nextState = await mutateWorkspaceState((state) => {
      const workspace = state.workspaces.find((entry) => entry.id === workspaceId);
      workspacePath = String(workspace?.path ?? "");
      state.workspaces = state.workspaces.filter((entry) => entry.id !== workspaceId);
      if (state.selectedId === workspaceId) state.selectedId = "";
      if (state.activeId === workspaceId) state.activeId = null;
      if (state.watchedId === workspaceId) state.watchedId = null;
      return state;
    });
    await forgetWorkspaceToken(workspacePath);
    return nextState;
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
    await clearDesktopBootstrapFiles();
    return undefined;
  }

  return {
    addAuthorizedRoot,
    bootstrapFirstLaunchWorkspace,
    createWorkspace,
    clearDesktopBootstrapConfig,
    debugDesktopBootstrapConfig,
    defaultWorkspaceOpenworkConfig,
    exportConfig,
    forgetWorkspace,
    getDesktopBootstrapConfig,
    importConfig,
    listLocalWorkspacePaths,
    migrateLegacyElectronWorkspaceStateIfNeeded,
    readDesktopBootstrapConfigSync,
    readWorkspaceOpenworkConfig,
    readWorkspaceState,
    resetOpenworkState,
    setDesktopBootstrapConfig,
    setRuntimeActiveWorkspace,
    setSelectedWorkspace,
    updateWorkspaceDisplayName,
    writeWorkspaceOpenworkConfig,
    writeWorkspaceState,
  };
}
