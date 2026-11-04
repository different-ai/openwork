import { startupPhase } from "./startup-phase.js";
import { withEngineSwitchFence } from "./engine-switch-fence.js";
import { engineAutoUpgradeRetry, waitForEngineIdle, type EngineAutoUpgradeRetry } from "./engine-auto-upgrade.js";
import { createV2ContextBridge } from "./opencode-v2-context-bridge.js";
import type { PrepareDriveUpload } from "./extensions/approved-drive-upload.js";
import { createV2ProviderSessionBridge } from "./opencode-v2-provider-session.js";
import type { CloudProviderDenSession } from "./cloud-provider-sync.js";
import { ApiError } from "./errors.js";
import { adoptOriginalHistory, opencodeV1DatabasePath, originalHistoryUsesV2, resolveOpencodeHistoryDatabase } from "./opencode-history.js";
import { executionRules } from "./managed-policy-rules.js";
import { agentPermissionEngineMcpDenial, agentPermissionRulesOf } from "./agent-permission-engine.js";
import { CONNECT_MCP_APP_HOST_CAPABILITY_HEADER, registeredOrganizationMcpServers } from "./connect-mcp-server-catalog.js";
import { waitForEngineSkillChanges } from "./opencode-v2-skill-settle.js";
import { MCP_READINESS_RPC_ID } from "./opencode-v2-mcp-readiness.js";
import { captureServerException } from "./telemetry.js";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import constants from "../../../constants.json" with { type: "json" };
import {
  createManagedOpencodeV2Server,
  engineListsModel,
  installOpencodeV2Binary,
  type ManagedOpencodeV2Server,
  type OpencodeV2ProviderSpec,
} from "./managed-opencode-v2.js";
import { resolveOpencodeModelsUrl } from "./opencode-models-url.js";
import { runtimeStorageDir } from "./runtime-db.js";
import {
  isEngineGlobalRuntimeConfigId,
  listRuntimeOpencodeConfigRows,
  onRuntimeOpencodeConfigWrite,
  readGlobalRuntimeOpencodeConfig,
  readEffectiveRuntimeOpencodeConfig,
  runtimeDisabledProviderList,
  runtimeMcpMap,
  runtimeProviderMap,
} from "./runtime-opencode-config-store.js";
import type { EnvService } from "./env-file.js";
import { selectPrimaryCredentialEnvName } from "./managed-provider-auth.js";
import type { ServerConfig } from "./types.js";
import { approvedProviderEnvironmentNames, machineOwnedProviderIds, MACHINE_PROVIDER_TEMPLATE_OWNERSHIP, resolveProviderConfigTemplates, type ProviderConfigTemplateError } from "./provider-config-templates.js";
import { readOpenworkWorkspaceConfig } from "./openwork-workspace-config-store.js";

/**
 * A stable id for this OpenWork app's engine config. Each desktop app gives
 * its server its own state path, so an installed build, a dev build and a
 * test world sharing one engine state directory stop overwriting each other's
 * engine config. A server without one keeps the shared layout.
 */
export function engineInstanceId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const key = env.OPENWORK_SERVER_STATE_PATH?.trim() || env.OPENWORK_ELECTRON_APP_IDENTIFIER?.trim();
  return key ? createHash("sha256").update(key).digest("hex").slice(0, 12) : undefined;
}
import { findManagedEngineWorkspace, hasExternalOpencode } from "./workspaces.js";
import { globalSkillDirectories } from "./skills.js";
import {
  environmentProviderKey,
  localProviderDefinitions,
  parseEngineV2NativeProviders,
  readLocalProviderAuth,
  readUserConfigProviders,
  type EngineV2NativeProvider,
  type EngineV2NativeProviders,
  type EngineV2SkippedProvider,
  type EngineV2SkippedProviderReason,
} from "./opencode-v2-local-auth.js";
import { ORGANIZATION_PROVIDER_ID, organizationProviderGate } from "./organization-provider-gate.js";

export type { EngineV2SkippedProvider, EngineV2SkippedProviderReason } from "./opencode-v2-local-auth.js";

const OPENCODE_V2_VERSION = constants.opencodeV2Version;
const PREVIEW_STATE_FILE = "engine-v2-preview.json";
const UNSET_API_KEY = "openwork-engine-v2-preview-unset";
// A cold sidecar can return HTTP 503 while its model catalog initializes for 17–20 seconds.
const CATALOG_MIRROR_TIMEOUT_MS = 60_000;
// Upkeep waits are bounded and never fail a request, as in v1: the engine
// serves what it has, and OpenWork only improves the next turn's odds.
// MCP upkeep never holds a request. A registration the engine rejected, or a
// connection that failed to start, is retried after `mcpRetryMs`, or at once
// when its configuration changes. Every `mcpHealthMs` known folders are
// checked for connections that failed or went missing.
export const ENGINE_V2_UPKEEP_WAITS: Readonly<Record<"providerPushJoinMs" | "workspaceProviderReadyMs" | "mcpRetryMs" | "mcpHealthMs" | "engineRestartMs" | "engineRestartMaxMs", number>> = Object.freeze({
  providerPushJoinMs: 10_000,
  workspaceProviderReadyMs: 8_000,
  mcpRetryMs: 60_000,
  mcpHealthMs: 60_000,
  // First wait before starting an engine that failed or exited again; it
  // doubles per attempt up to the maximum.
  engineRestartMs: 2_000,
  engineRestartMaxMs: 300_000,
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait for `promise` at most `ms`, without leaving the timer behind. */
async function joinBounded(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([promise.catch(() => undefined), new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]);
  clearTimeout(timer);
}

export type EngineOrigin = "fresh" | "manual" | "forced" | "reverted";

export interface EngineV2PreviewStatus {
  engineOrigin: EngineOrigin;
  engineChangedAt?: string;
  engineForced: boolean;
  forceUpgradePending: boolean;
  enabled: boolean;
  chatRouting: boolean;
  /** Effective Gateway owner on the selected engine: managed v2, never v1. */
  liveProviderSync: boolean;
  running: boolean;
  version?: string;
  pid?: number;
  binSource?: "env" | "path" | "cache";
  mirroredProviderIds: string[];
  skippedProviderIds: string[];
  /**
   * Why each provider in `skippedProviderIds` is not on this engine, including
   * providers connected on this computer that never reached the mirror.
   */
  skippedProviders?: EngineV2SkippedProvider[];
  catalogModelIds: string[];
  lastMirroredAt?: string;
  lastError?: string;
  /** Most recent upkeep step that did not finish in time or was rejected; requests proceeded. */
  lastWarning?: string;
  /**
   * The signed-in organization's `opencodeV2Only` rollout is on: v2 serves every
   * chat and switching to v1 is refused. Never saved: off when signed out or Den is unreachable.
   */
  v2Only: boolean;
  /** An adopted in-place v2 store cannot accept new v1 chat writes safely. */
  v1UnavailableReason?: string;
}

export interface RuntimeProviderRecordLike {
  name?: string;
  npm?: string;
  options?: {
    baseURL?: string;
    apiKey?: string;
  };
  models?: Record<string, unknown>;
}

export interface EngineV2Preview {
  start(): void;
  setForcePolicy(policy: { upgrade: boolean }): EngineV2PreviewStatus;
  status(): EngineV2PreviewStatus;
  setEnabled(enabled: boolean): Promise<EngineV2PreviewStatus>;
  setChatRouting(chatRouting: boolean): Promise<EngineV2PreviewStatus>;
  connection(): { url: string; username: string; password: string } | undefined;
  ensureWorkspaceReady(directory: string): Promise<void>;
  refreshProviders(): Promise<void>;
  /**
   * Reconcile a folder's MCP connections with the engine: register new or
   * changed ones, remove revoked ones, and restart failed ones after a back-off.
   * Healthy and starting connections are left alone. `reconnect` names are
   * restarted now, without the back-off, when they are not healthy.
   * The call rejects only for the connections it names (`reconnect`, or
   * `servers` to check them without a restart); with neither, for any.
   * Background upkeep: prompts never wait on it.
   */
  syncWorkspaceMcp(workspaceId: string, directory: string, options?: { reconnect?: string[]; servers?: string[] }): Promise<void>;
  /** Explicit mutations join the native client's executable MCP registry. */
  settleWorkspaceMcp(workspaceId: string, directory: string, server: string): Promise<void>;
  /** Start a folder's upkeep in the background the first time it is seen. Never waits or throws. */
  warmWorkspace(workspaceId: string, directory: string): void;
  /** After OpenWork writes workspace skills, briefly wait for the engine to reflect them. Never throws. */
  settleWorkspaceSkills(directory: string): Promise<void>;
  /**
   * Apply the organization's `opencodeV2Only` rollout. Turning it on selects v2
   * once v1 is idle. Upstream owns in-place migration on startup. Turning it off changes no engine selection.
   */
  setV2Only(enabled: boolean): Promise<EngineV2PreviewStatus>;
  stop(): Promise<void>;
}

export interface EngineV2PreviewState {
  /** Sticky selection only; prevents deleting the last v2 chat from changing stores. */
  historyDatabase?: string;
  enabled: boolean;
  chatRouting?: boolean;
  engineOrigin?: EngineOrigin;
  engineChangedAt?: string;
  engineForced?: boolean;
  autoUpgradeRetry?: EngineAutoUpgradeRetry;
}

export function resolveInitialEngineV2PreviewState(
  env: NodeJS.ProcessEnv,
  persisted: EngineV2PreviewState,
): EngineV2PreviewState {
  const override = env.OPENWORK_ENGINE_V2_PREVIEW;
  if (override === "1" || override === "chat") return { ...persisted, enabled: true, chatRouting: true };
  if (override === "sidecar") return { ...persisted, enabled: true, chatRouting: false };
  return persisted;
}

interface ResolvedBinary {
  bin: string;
  source: "env" | "path" | "cache";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const ENGINE_FAILURE_TITLES = {
  start: "OpenCode v2 did not start",
  exit: "OpenCode v2 stopped unexpectedly",
  upgrade: "OpenCode v2 upgrade did not finish",
} as const;

/**
 * Error reporting gets the first line of an engine failure, with the home
 * folder shortened to ~, and never the engine output that follows it.
 */
function reportEngineFailure(stage: keyof typeof ENGINE_FAILURE_TITLES, error: unknown): void {
  const home = homedir();
  const firstLine = errorMessage(error).split("\n", 1)[0] ?? "";
  const reason = (home ? firstLine.split(home).join("~") : firstLine).slice(0, 300);
  captureServerException(new Error(`${ENGINE_FAILURE_TITLES[stage]}: ${reason}`), { method: "ENGINE", route: `engine.v2.${stage}` });
}

function statePath(config: Pick<ServerConfig, "configPath">): string {
  return join(runtimeStorageDir(config), PREVIEW_STATE_FILE);
}

/**
 * Engine selection as an earlier build saved it. Every build since v1 and v2
 * coexisted writes `enabled` and `chatRouting`. The short-lived v2-only build
 * stopped writing them because v2 was its only engine; its state means v2
 * serves this profile, so a later build must keep v2 rather than fall back to
 * v1 and hide every chat created since.
 */
function savedEngineSelection(parsed: Record<string, unknown>): Pick<EngineV2PreviewState, "enabled" | "chatRouting" | "engineOrigin" | "engineForced"> | undefined {
  if (parsed.enabled === undefined && parsed.chatRouting === undefined) {
    return { enabled: true, chatRouting: true, engineOrigin: "forced", engineForced: true };
  }
  if (typeof parsed.enabled !== "boolean" || (parsed.chatRouting !== undefined && typeof parsed.chatRouting !== "boolean")) return undefined;
  return { enabled: parsed.enabled, chatRouting: parsed.chatRouting === true };
}

export function readEngineV2PreviewState(config: Pick<ServerConfig, "configPath">): EngineV2PreviewState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(statePath(config), "utf8"));
    const selection = isRecord(parsed) ? savedEngineSelection(parsed) : undefined;
    if (!isRecord(parsed) || !selection) {
      return { enabled: false, chatRouting: false };
    }
    return {
      ...selection,
      ...(typeof parsed.historyDatabase === "string" && isAbsolute(parsed.historyDatabase) ? { historyDatabase: parsed.historyDatabase } : {}),
      ...(parsed.engineOrigin === "fresh" || parsed.engineOrigin === "manual" || parsed.engineOrigin === "forced" || parsed.engineOrigin === "reverted"
        ? { engineOrigin: parsed.engineOrigin } : {}),
      ...(typeof parsed.engineChangedAt === "string" ? { engineChangedAt: parsed.engineChangedAt } : {}),
      ...(parsed.engineForced === true ? { engineForced: true } : {}),
      ...(isRecord(parsed.autoUpgradeRetry) && typeof parsed.autoUpgradeRetry.attempts === "number"
        && Number.isFinite(parsed.autoUpgradeRetry.attempts) && typeof parsed.autoUpgradeRetry.retryAt === "number"
        && Number.isFinite(parsed.autoUpgradeRetry.retryAt)
        ? { autoUpgradeRetry: { attempts: parsed.autoUpgradeRetry.attempts, retryAt: parsed.autoUpgradeRetry.retryAt } } : {}),

    };
  } catch {
    return { enabled: false, chatRouting: false };
  }
}

/**
 * The engine a brand-new install starts on. Desktop and the hosted web
 * bootstrap request it without overriding earlier OpenWork state. Updated installs, a
 * saved engine choice, OpenCode v1 history, or an explicit
 * OPENWORK_ENGINE_V2_PREVIEW all keep today's behavior.
 */
export function freshInstallEngineState(input: {
  requested: ServerConfig["freshInstallEngine"];
  env: NodeJS.ProcessEnv;
  stateFileExists: boolean;
  v1HistoryExists: boolean;
}): EngineV2PreviewState | undefined {
  if (input.requested !== "v2") return undefined;
  if (input.env.OPENWORK_ENGINE_V2_PREVIEW?.trim()) return undefined;
  if (input.stateFileExists || input.v1HistoryExists) return undefined;
  return { enabled: true, chatRouting: true };
}

function v1HistoryExists(env: NodeJS.ProcessEnv): boolean {
  try {
    return existsSync(opencodeV1DatabasePath(env));
  } catch {
    // An unusable OPENCODE_DB is not a fresh profile we can reason about; keep v1.
    return true;
  }
}

/**
 * Save the fresh-install engine choice once, before the first read, so later
 * starts (which no longer look fresh) keep it and a switch back to v1 sticks.
 */
export function seedFreshInstallEngineState(config: Pick<ServerConfig, "configPath" | "freshInstallEngine" | "engineAutoUpgrade" | "engineForcePolicy" | "externalOpencode" | "opencodeBaseUrl"> & Partial<Pick<ServerConfig, "workspaces">>, env: NodeJS.ProcessEnv = process.env): boolean {
  if (hasExternalOpencode(config)) return false;
  const state = freshInstallEngineState({
    requested: config.freshInstallEngine,
    env,
    stateFileExists: existsSync(statePath(config)),
    v1HistoryExists: v1HistoryExists(env),
  });
  if (!state) return false;
  try {
    mkdirSync(runtimeStorageDir(config), { recursive: true });
    writeFileSync(statePath(config), `${JSON.stringify({ ...state, engineOrigin: "fresh", engineChangedAt: new Date().toISOString(), ...(config.engineAutoUpgrade !== false ? { engineForced: true } : {}) }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return true;
  } catch {
    // Another start wrote it first, or the folder is read-only: keep what is on disk.
    return false;
  }
}

export async function writeEngineV2PreviewState(
  config: ServerConfig,
  state: EngineV2PreviewState,
): Promise<void> {
  await mkdir(runtimeStorageDir(config), { recursive: true });
  const path = statePath(config);
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

function exec(file: string, args: string[], options: { cwd?: string; timeout?: number } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function resolveBinary(config: ServerConfig): Promise<ResolvedBinary> {
  return startupPhase("engine.v2.resolve", () => resolveBinaryInner(config));
}

async function resolveBinaryInner(config: ServerConfig): Promise<ResolvedBinary> {
  const override = process.env.OPENWORK_OPENCODE2_BIN?.trim();
  if (override) return { bin: override, source: "env" };

  let pathError = "not found";
  try {
    await startupPhase("engine.v2.version-probe", () => exec("opencode2", ["--version"]));
    return { bin: "opencode2", source: "path" };
  } catch (error) {
    pathError = errorMessage(error);
  }

  try {
    const binary = await installOpencodeV2Binary(join(runtimeStorageDir(config), "opencode-v2-verified"), OPENCODE_V2_VERSION);
    return { bin: binary, source: "cache" };
  } catch (error) {
    throw new Error(
      `Unable to resolve OpenCode v2 (${pathError}; verified download: ${errorMessage(error)}). ${BINARY_OVERRIDE_ADVICE}`,
    );
  }
}

const BINARY_OVERRIDE_ADVICE = "Set OPENWORK_OPENCODE2_BIN to a working opencode2 binary to override resolution.";

/**
 * Only failures to find or run the engine executable suggest a different
 * binary. Database and configuration errors retain their own diagnostics.
 */
export function engineStartErrorMessage(error: unknown): string {
  const message = errorMessage(error);
  if (message.includes("OPENWORK_OPENCODE2_BIN")) return message;
  const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
  const binary = code === "ENOENT" || code === "EACCES" || code === "ENOEXEC" || code === "EPERM"
    || /^Failed to start OpenCode v2 server|^OpenCode v2 server exited with code|^Timed out waiting \d+ms for OpenCode v2 health|unexpected listener|\bspawn\b|ENOENT|EACCES|ENOEXEC/.test(message);
  return binary ? `${message} ${BINARY_OVERRIDE_ADVICE}` : message;
}

export function mapRuntimeProvidersToV2Specs(
  providerMap: Record<string, unknown>,
  storedCredentials: ReadonlyMap<string, string> = new Map(),
  localApiKeys: ReadonlyMap<string, string> = new Map(),
  configuredProviderIds: ReadonlySet<string> = new Set(),
): { specs: OpencodeV2ProviderSpec[]; skippedProviderIds: string[]; skippedProviders: EngineV2SkippedProvider[] } {
  const specs: OpencodeV2ProviderSpec[] = [];
  const skippedProviders: EngineV2SkippedProvider[] = [];
  const skip = (id: string, reason: EngineV2SkippedProviderReason) => { skippedProviders.push({ id, reason }); };

  for (const [id, value] of Object.entries(providerMap)) {
    if (!isRecord(value)) {
      skip(id, "metadata");
      continue;
    }
    // Only built-in adapters: do not turn organization configuration into a
    // request to install an arbitrary runtime package.
    const packages: Record<string, string> = {
      "@ai-sdk/openai": "@opencode/ai/providers/openai",
      "@ai-sdk/anthropic": "@opencode/ai/providers/anthropic",
      "@openrouter/ai-sdk-provider": "@opencode/ai/providers/openrouter",
      "@ai-sdk/openai-compatible": "@opencode/ai/providers/openai-compatible",
      "@ai-sdk/azure": "@opencode/ai/providers/azure/responses",
    };
    const options = isRecord(value.options) ? value.options : {};
    const isConfigured = configuredProviderIds.has(id);
    // Catalog `api` metadata may use only the native adapter's trusted origin.
    // Custom destinations must be explicitly configured (or use options.baseURL).
    const explicitBaseUrl = typeof options.baseURL === "string" && options.baseURL.trim()
      ? options.baseURL : undefined;
    const endpoint = explicitBaseUrl ?? value.api;
    const baseUrl = typeof endpoint === "string" && endpoint.trim() ? endpoint : undefined;
    const safeBaseUrl = (candidate: string | undefined): boolean => {
      if (candidate === undefined) return true;
      try {
        const url = new URL(candidate);
        return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
      } catch { return false; }
    };
    if (!safeBaseUrl(baseUrl)) {
      skip(id, "unsupported");
      continue;
    }
    if (!explicitBaseUrl && value.api !== undefined) {
      const nativeOrigins: Record<string, string> = {
        "@ai-sdk/openai": "https://api.openai.com",
        "@ai-sdk/anthropic": "https://api.anthropic.com",
        "@openrouter/ai-sdk-provider": "https://openrouter.ai",
      };
      let trusted = false;
      try {
        const url = new URL(typeof value.api === "string" ? value.api : "");
        trusted = typeof value.npm === "string" && Object.hasOwn(nativeOrigins, value.npm)
          && url.origin === nativeOrigins[value.npm];
      } catch { /* Invalid endpoint metadata is never mirrored. */ }
      if (!trusted && !isConfigured) { skip(id, "unsupported"); continue; }
    }
    const packageName = typeof value.npm === "string" && Object.hasOwn(packages, value.npm) ? packages[value.npm] : undefined;
    if ((value.npm !== undefined && !packageName)
      || (!baseUrl && (!packageName || value.npm === "@ai-sdk/openai-compatible"))) {
      skip(id, "unsupported");
      continue;
    }
    const { apiKey, baseURL, headers, ...settings } = options;
    let normalizedBaseUrl = baseUrl;
    if (value.npm === "@ai-sdk/azure" && settings.useDeploymentBasedUrls !== true && baseUrl !== undefined) {
      try {
        const url = new URL(baseUrl);
        if (url.protocol === "https:" && url.hostname.endsWith(".openai.azure.com") && /\/openai\/v1\/?$/.test(url.pathname)) {
          url.pathname = url.pathname.replace(/\/v1\/?$/, "");
          normalizedBaseUrl = url.toString().replace(/\/$/, "");
        }
      } catch { /* The general safe endpoint check above rejects malformed URLs. */ }
    }
    const envNames = Array.isArray(value.env)
      ? value.env.filter((name): name is string => typeof name === "string") : [];
    const credentialName = selectPrimaryCredentialEnvName(envNames, storedCredentials.keys());
    const storedKey = credentialName ? storedCredentials.get(credentialName) : undefined;
    // Resolve only this provider's declared credential, never inherit the
    // server environment or copy unrelated secrets into the sidecar.
    const explicitKey = typeof apiKey === "string" && apiKey.trim() !== "" && !apiKey.includes("{env:") ? apiKey : undefined;
    const resolvedKey = explicitKey ?? storedKey ?? localApiKeys.get(id);
    if (envNames.length > 0 && !resolvedKey) {
      skip(id, "credentials");
      continue;
    }
    const models = isRecord(value.models)
      ? Object.entries(value.models)
        .map(([modelId, model]) => ({
          id: modelId,
          name: isRecord(model) && typeof model.name === "string" ? model.name : modelId,
          ...(isRecord(model) ? { config: model } : {}),
        }))
        .sort((left, right) => left.id.localeCompare(right.id))
      : [];
    specs.push({
      id,
      name: typeof value.name === "string" ? value.name : id,
      ...(normalizedBaseUrl ? { baseUrl: normalizedBaseUrl } : {}),
      ...(packageName ? { package: packageName } : {}),
      ...(Object.keys(settings).length ? { settings } : {}),
      ...(isRecord(headers) ? { headers } : {}),
      apiKey: resolvedKey ?? UNSET_API_KEY,
      ...(Array.isArray(value.whitelist) ? { whitelist: value.whitelist.filter((id): id is string => typeof id === "string") } : {}),
      ...(Array.isArray(value.blacklist) ? { blacklist: value.blacklist.filter((id): id is string => typeof id === "string") } : {}),
      models,
    });
  }

  specs.sort((left, right) => left.id.localeCompare(right.id));
  skippedProviders.sort((left, right) => left.id.localeCompare(right.id));
  return { specs, skippedProviderIds: skippedProviders.map(provider => provider.id), skippedProviders };
}

/** One entry per provider, sorted by id; the first reason given for a provider wins. */
export function mergeSkippedProviders(...groups: ReadonlyArray<readonly EngineV2SkippedProvider[]>): EngineV2SkippedProvider[] {
  const merged = new Map<string, EngineV2SkippedProvider>();
  for (const provider of groups.flat()) if (!merged.has(provider.id)) merged.set(provider.id, provider);
  return [...merged.values()].sort((left, right) => left.id.localeCompare(right.id));
}

/** A catalog provider of the engine: only its key goes into the config. */
export function nativeProviderSpec(provider: { id: string; name: string; apiKey: string }): OpencodeV2ProviderSpec {
  return { id: provider.id, name: provider.name, apiKey: provider.apiKey, models: [], native: true };
}

/** The engine's catalog providers; none when it cannot answer, so the mirror falls back to full definitions. */
export async function readEngineV2NativeProviders(
  active: Pick<ManagedOpencodeV2Server, "fetchJson">,
): Promise<Map<string, EngineV2NativeProvider>> {
  const response = await active.fetchJson("/api/integration", { timeoutMs: 10_000 }).catch(() => undefined);
  return response?.status === 200 ? parseEngineV2NativeProviders(response.json) : new Map();
}

/**
 * Providers from this computer's own OpenCode config file (see
 * readUserConfigProviders). Settings definitions win for the same id. An
 * entry that only adds a key to a catalog provider (no package or endpoint of
 * its own) becomes a native provider; anything else is a full definition.
 */
export async function userConfigProviders(
  configured: Record<string, unknown>,
  allows: ((providerId: string) => boolean) | null,
  native: EngineV2NativeProviders,
  localKeys: ReadonlyMap<string, string>,
  credentials: ReadonlyMap<string, string>,
  read: () => Promise<{ directory: string; providers: Record<string, Record<string, unknown>> }> = readUserConfigProviders,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{
  /** Every id the file defines, so the auth.json path leaves them alone. */
  claimed: Record<string, unknown>;
  definitions: Record<string, unknown>;
  native: Array<{ id: string; name: string; apiKey: string }>;
  skipped: EngineV2SkippedProvider[];
  errors: ProviderConfigTemplateError[];
}> {
  const file = await read();
  const claimed = Object.fromEntries(Object.entries(file.providers)
    .filter(([id]) => !(id in configured) && !ORGANIZATION_PROVIDER_ID.test(id)));
  const skipped: EngineV2SkippedProvider[] = [];
  const allowed: Record<string, unknown> = {};
  for (const [id, provider] of Object.entries(claimed)) {
    if (allows && !allows(id)) skipped.push({ id, reason: "policy" });
    else allowed[id] = provider;
  }
  // Same rules as v1 for this file: its environment and files beside it.
  const templates = await resolveProviderConfigTemplates(allowed, {
    directory: file.directory, environment: credentials, localProviderIds: new Set(Object.keys(allowed)),
    remoteEnvironmentNames: new Map(), inheritedEnvironment: environment,
  });
  const definitions: Record<string, unknown> = {};
  const nativeProviders: Array<{ id: string; name: string; apiKey: string }> = [];
  for (const [id, value] of Object.entries(templates.providers)) {
    const catalog = native.get(id);
    const settings = isRecord(value) && isRecord(value.options) ? value.options : {};
    if (!catalog || !isRecord(value) || value.npm !== undefined || value.api !== undefined || settings.baseURL !== undefined) {
      definitions[id] = value;
      continue;
    }
    const written = typeof settings.apiKey === "string" && settings.apiKey.trim() ? settings.apiKey : undefined;
    const apiKey = written ?? localKeys.get(id) ?? environmentProviderKey(id, catalog, environment);
    if (apiKey) nativeProviders.push({ id, name: typeof value.name === "string" && value.name.trim() ? value.name : catalog.name, apiKey });
    else skipped.push({ id, reason: "credentials" });
  }
  return { claimed, definitions, native: nativeProviders, skipped, errors: templates.errors };
}

export function shouldSyncLiveProviderOwnerTransition(previous: boolean, next: boolean): boolean {
  return previous !== next;
}

export function shouldWaitForMirroredProviders(liveProviderSync: boolean, specs: readonly OpencodeV2ProviderSpec[]): boolean {
  return !liveProviderSync || specs.some(spec => !/^ipr_/i.test(spec.id));
}

export async function waitForEngineV2Catalog(
  active: Pick<ManagedOpencodeV2Server, "fetchJson">,
  directory: string,
  specs: readonly OpencodeV2ProviderSpec[],
  timeoutMs = CATALOG_MIRROR_TIMEOUT_MS,
  ownsGateway: () => boolean = () => false,
): Promise<{ modelIds: string[]; lastError?: string }> {
  if (!shouldWaitForMirroredProviders(ownsGateway(), specs)) return { modelIds: [] };
  const shouldConfirm = (providerID: string) => !ownsGateway() || !/^ipr_/i.test(providerID);
  const mirrored = new Set(specs.map((spec) => spec.id));
  const expectedModels = specs.flatMap((spec) => spec.models
    .filter((model) => engineListsModel(spec, model))
    .map((model) => ({ providerID: spec.id, id: model.id, label: `${model.name} (${spec.name})` })));
  const deadline = Date.now() + timeoutMs;
  const readCatalog = async () => {
    const catalog = await active.fetchJson("/api/model", {
      directory, timeoutMs: Math.max(1, Math.min(5_000, deadline - Date.now())),
    }).catch((error: unknown) => ({ status: 0, json: { message: errorMessage(error) } }));
    const payload = isRecord(catalog.json) ? catalog.json.data : undefined;
    const models = Array.isArray(payload) && payload.every(
      (model): model is { providerID: string; id: string } =>
        isRecord(model) && typeof model.providerID === "string" && typeof model.id === "string",
    ) ? payload : undefined;
    const missing = expectedModels.filter((expected) => shouldConfirm(expected.providerID)
      && !models?.some((model) => model.providerID === expected.providerID && model.id === expected.id));
    const message = isRecord(catalog.json) && typeof catalog.json.message === "string" ? ` ${catalog.json.message}` : "";
    return { models, missing, status: catalog.status, message,
      ready: catalog.status === 200 && models !== undefined && missing.length === 0 };
  };

  let catalog = await readCatalog();
  while (!catalog.ready && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, deadline - Date.now())));
    if (Date.now() >= deadline) break;
    catalog = await readCatalog();
  }
  const modelIds = [...new Set(catalog.models?.flatMap((model) => mirrored.has(model.providerID) ? [model.id] : []) ?? [])]
    .sort((left, right) => left.localeCompare(right));
  if (catalog.ready) return { modelIds };
  // Name models the way the model picker does: gateway ids are opaque.
  const after = `after ${Math.round(timeoutMs / 1000)} seconds`;
  if (catalog.status !== 200 || catalog.models === undefined) {
    const response = catalog.status === 0 ? "no response" : `HTTP ${catalog.status}`;
    const detail = catalog.message ? `:${catalog.message}` : "";
    return { modelIds, lastError: `OpenCode v2's model list could not be read ${after} (${response}${detail}).` };
  }
  const labels = catalog.missing.map((model) => model.label);
  const shown = labels.length > 3 ? `${labels.slice(0, 3).join(", ")} and ${labels.length - 3} more` : labels.join(", ");
  return {
    modelIds,
    lastError: `OpenCode v2 has not listed ${labels.length} ${labels.length === 1 ? "model" : "models"} ${after}: ${shown}.`,
  };
}

/**
 * The v2 engine lists organization skills as native skills
 * (openwork-cloud-skills-v2), so Den need not repeat them in Connect's server
 * instructions. Den only drops that list when it also serves native delivery.
 */
const CONNECT_NATIVE_SKILLS_CAPABILITY = "native-skills-v1";

function withClientCapability(headers: Record<string, string>, capability: string): Record<string, string> {
  const key = Object.keys(headers).find((name) => name.toLowerCase() === CONNECT_MCP_APP_HOST_CAPABILITY_HEADER)
    ?? CONNECT_MCP_APP_HOST_CAPABILITY_HEADER;
  const existing = (headers[key] ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  return existing.includes(capability) ? headers : { ...headers, [key]: [...existing, capability].join(",") };
}

/** Translate only fields supported by the pinned v2 MCP API. */
export function mapRuntimeMcpToV2(value: unknown, name?: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  if (value.enabled === false || value.disabled === true) return undefined;
  const shared = {
    ...(typeof value.codemode === "boolean" ? { codemode: value.codemode } : {}),
    ...(typeof value.timeout === "number" && value.timeout > 0
      ? { timeout: { startup: value.timeout, catalog: value.timeout, execution: value.timeout } } : {}),
  };
  const strings = (input: unknown) => isRecord(input)
    ? Object.fromEntries(Object.entries(input).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};
  if (value.type === "local" && Array.isArray(value.command)
    && value.command.length > 0 && value.command.every((part) => typeof part === "string" && part.trim())) {
    return { type: "local", command: value.command, environment: strings(value.environment),
      ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}), ...shared };
  }
  if (value.type !== "remote" || typeof value.url !== "string" || !/^https?:\/\//i.test(value.url)) return undefined;
  const oauth = isRecord(value.oauth) ? {
    ...(typeof value.oauth.clientId === "string" ? { client_id: value.oauth.clientId } : {}),
    ...(typeof value.oauth.clientSecret === "string" ? { client_secret: value.oauth.clientSecret } : {}),
    ...(typeof value.oauth.scope === "string" ? { scope: value.oauth.scope } : {}),
  } : value.oauth === false ? false : undefined;
  const headers = strings(value.headers);
  return { type: "remote", url: value.url,
    headers: name === "openwork-cloud" ? withClientCapability(headers, CONNECT_NATIVE_SKILLS_CAPABILITY) : headers,
    // Only the managed Connect endpoint needs modern discovery and per-request
    // clientInfo. Keep third-party servers on the engine's legacy default.
    ...(name === "openwork-cloud" ? { protocol: "auto" } : {}),
    ...(oauth === undefined ? {} : { oauth }), ...shared };
}

interface McpLocation {
  workspaceId: string;
  /** Config fingerprint of each registration this mirror owns. */
  applied: Map<string, string>;
  /** Last rejected registration or restart per name, for the back-off. */
  attempts: Map<string, { fingerprint: string; at: number }>;
  /** The latest run; the next one starts after it. */
  tail?: Promise<McpFailures>;
  /** A run that has not started yet; later triggers join it. */
  queued?: { promise: Promise<McpFailures>; reconnect: Set<string> };
}

/** One run's failure message per connection name. */
type McpFailures = ReadonlyMap<string, string>;

/**
 * A run serves every caller that joined it. Each one hears only about the
 * connections it named, so one broken server never fails another's request;
 * background upkeep names none and hears about all of them.
 */
async function rejectMcpFailures(run: Promise<McpFailures>, names?: readonly string[]): Promise<void> {
  const failures = [...await run].filter(([name]) => !names || names.includes(name));
  if (failures.length) throw new Error(failures.map(([name, message]) => `${name}: ${message}`).join("; "));
}

/** Live MCP status per name for one location, or undefined when unknown. */
async function readLiveMcpStatus(
  active: Pick<ManagedOpencodeV2Server, "fetchJson">,
  directory: string,
): Promise<Map<string, string> | undefined> {
  const result = await active.fetchJson("/api/mcp", { directory, timeoutMs: 5_000 }).catch(() => undefined);
  const entries = isRecord(result?.json) ? result.json.data : undefined;
  if (result?.status !== 200 || !Array.isArray(entries)) return undefined;
  const statuses = new Map<string, string>();
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.name !== "string") continue;
    statuses.set(entry.name, isRecord(entry.status) && typeof entry.status.status === "string" ? entry.status.status : "unknown");
  }
  return statuses;
}

export function createEngineV2Preview(options: {
  config: ServerConfig;
  env?: Pick<EnvService, "list" | "onChange">;
  deferStart?: boolean;
  hostReadRequest?: (path: string, init?: RequestInit) => Promise<unknown>;
  prepareDriveUpload?: PrepareDriveUpload;
  providerSession?: () => CloudProviderDenSession | null;
  waits?: Partial<typeof ENGINE_V2_UPKEEP_WAITS>;
  /** Running-task probe for leaving v1; unknown is not idle. */
  autoUpgradeIdle?: () => Promise<boolean>;
  autoUpgradeError?: (error: string) => void;
}): EngineV2Preview {
  const { config } = options;
  const waits = { ...ENGINE_V2_UPKEEP_WAITS, ...options.waits };
  const rootDir = join(runtimeStorageDir(config), "opencode-v2", "state");
  const workspaceDir = join(rootDir, "workspace");
  seedFreshInstallEngineState(config);
  const initialState = resolveInitialEngineV2PreviewState(process.env, readEngineV2PreviewState(config));
  let engineOrigin: EngineOrigin = initialState.engineOrigin ?? "manual";
  let engineChangedAt = initialState.engineChangedAt;
  let engineForced = initialState.engineForced === true;
  // Only engines using this host's history can be migrated automatically. The
  // bootstrap ownership snapshot survives managed global/workspace URL hydration.
  // An explicit saved/pinned engine still wins; legacy policy cannot undo it.
  const autoUpgradeEnabled = !hasExternalOpencode(config) && config.engineAutoUpgrade !== false && !process.env.OPENWORK_ENGINE_V2_PREVIEW?.trim();
  let autoUpgradeRetry = initialState.autoUpgradeRetry;
  const autoUpgradeAbort = new AbortController();
  let autoUpgradeJob: Promise<void> | undefined;
  let stopping = false;
  let enabled = initialState.enabled;
  let chatRouting = initialState.chatRouting === true;
  // A managed v2 child owns Gateway inventory whenever its private identity bridge is installed.
  const ownsGateway = () => options.providerSession !== undefined;
  // The organization rollout, applied by the server once Den answers. Never
  // persisted, so a revoked rollout or an offline start cannot keep it on.
  let v2Only = false;
  let v2OnlyJob: Promise<void> | undefined;
  let v1UnavailableReason: string | undefined;
  const adoptedHistoryReason = "This history has been opened by OpenCode v2. Switching to v1 would leave new chats outside v2 history.";
  let selectedHistoryDatabase = initialState.historyDatabase;
  async function selectHistoryDatabase(): Promise<string> {
    if (!selectedHistoryDatabase) {
      selectedHistoryDatabase = await resolveOpencodeHistoryDatabase(rootDir);
      // A path receipt, not a migration checkpoint: never switch databases
      // after the user deletes their last chat, or resurrect an old history.
      await persistState();
    }
    if (selectedHistoryDatabase === opencodeV1DatabasePath()) {
      adoptOriginalHistory(config);
      v1UnavailableReason = adoptedHistoryReason;
    }
    return selectedHistoryDatabase;
  }
  // Every write keeps `enabled`, `chatRouting` and `engineOrigin`: earlier
  // builds read them to pick the engine, and treat a file without them as v1.
  const persistState = () => writeEngineV2PreviewState(config, {
    enabled, chatRouting, engineOrigin, engineForced,
    ...(selectedHistoryDatabase ? { historyDatabase: selectedHistoryDatabase } : {}),
    ...(engineChangedAt === undefined ? {} : { engineChangedAt }),
    ...(autoUpgradeRetry ? { autoUpgradeRetry } : {}),
  });
  let allowRunning = true;
  let running = false;
  let version: string | undefined;
  let pid: number | undefined;
  let binSource: EngineV2PreviewStatus["binSource"];
  let mirroredProviderIds: string[] = [];
  let skippedProviderIds: string[] = [];
  let skippedProviders: EngineV2SkippedProvider[] = [];
  let currentCatalogModelIds: string[] = [];
  let lastMirroredAt: string | undefined;
  let lastError: string | undefined;
  let lastWarning: string | undefined;
  const warn = (message: string) => { lastWarning = `${new Date().toISOString()} ${message}`; };
  let sidecar: ManagedOpencodeV2Server | undefined;
  let contextBridge: Awaited<ReturnType<typeof createV2ContextBridge>> | undefined;
  let providerSessionBridge: Awaited<ReturnType<typeof createV2ProviderSessionBridge>> | undefined;
  let unsubscribe: (() => void) | undefined;
  let startPromise: Promise<void> | undefined;
  let restartAttempts = 0;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let healthySince: number | undefined;
  let mirrorInFlight: Promise<void> | undefined;
  // Settles once a mirror has pushed providers to the engine, before its
  // catalog confirmation; readiness joins this, never the whole mirror.
  let providerPush: Promise<void> | undefined;
  // Resolves after local inventory is read, before any old push/confirmation.
  let providerDiscovery: Promise<void> | undefined;
  let mirrorDirty = false;
  // The last mirror's push failure. A model the catalog has not listed is
  // reported in status but never fails a caller whose providers were pushed.
  let mirrorError: string | undefined;
  const workspaceReadiness = new Map<string, Promise<void>>();
  let mirroredSpecs: OpencodeV2ProviderSpec[] = [];
  // One MCP reconciler per folder, keyed by directory.
  const mcpLocations = new Map<string, McpLocation>();
  let mcpHealthTimer: ReturnType<typeof setInterval> | undefined;
  async function settleWorkspaceSkills(directory: string): Promise<void> {
    const active = sidecar;
    if (!active || !chatRouting) return;
    await waitForEngineSkillChanges(directory, async () => {
      const response = await active.fetchJson("/api/skill", { directory, timeoutMs: 5_000 });
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      return response.json;
    });
  }

  function syncWorkspaceMcp(workspaceId: string, directory: string, options: { reconnect?: string[]; servers?: string[] } = {}): Promise<void> {
    const named = options.servers ?? options.reconnect;
    let location = mcpLocations.get(directory);
    if (!location) {
      location = { workspaceId, applied: new Map(), attempts: new Map() };
      mcpLocations.set(directory, location);
    }
    location.workspaceId = workspaceId;
    // Serialize each folder. Triggers that arrive while a run is in flight
    // share one follow-up run, which re-reads config and live status, so a
    // burst coalesces and never reuses a snapshot taken before a change.
    if (location.queued) {
      for (const name of options.reconnect ?? []) location.queued.reconnect.add(name);
      return rejectMcpFailures(location.queued.promise, named);
    }
    const owner = location;
    const reconnect = new Set(options.reconnect);
    const promise = (owner.tail ?? Promise.resolve()).catch(() => undefined).then(() => {
      if (owner.queued?.promise === promise) owner.queued = undefined;
      return reconcileWorkspaceMcp(directory, owner, reconnect);
    });
    owner.queued = { promise, reconnect };
    owner.tail = promise;
    return rejectMcpFailures(promise, named);
  }

  async function reconcileWorkspaceMcp(directory: string, location: McpLocation, reconnect: ReadonlySet<string>): Promise<McpFailures> {
    const active = sidecar;
    if (!active) throw new Error("OpenCode v2 is not running");
    const effective = await readEffectiveRuntimeOpencodeConfig(config, location.workspaceId);
    const runtime = runtimeMcpMap(effective);
    const agentPermissionRules = agentPermissionRulesOf(effective.managedPolicy);
    // Local servers the member's agent permissions block are not registered,
    // and an earlier registration is removed below like any other unwanted entry.
    // The agent permissions plugin learns of new organization servers first,
    // so it does not disable them as they are registered.
    const mcpRules = agentPermissionRules.some((rule) => rule.action === "mcp");
    if (mcpRules) await active.refreshConfig();
    const organizationMcp = mcpRules ? await registeredOrganizationMcpServers(config, [location.workspaceId]) : {};
    const desired = new Map(Object.entries(runtime).flatMap(([name, value]) => {
      if (agentPermissionEngineMcpDenial(agentPermissionRules, name, value, organizationMcp)) return [];
      const mapped = mapRuntimeMcpToV2(value, name);
      return mapped ? [[name, { config: mapped, fingerprint: JSON.stringify(mapped) }] as const] : [];
    }));
    const { applied, attempts } = location;
    // The engine's live status, not our record of what we sent, decides
    // whether a connection is healthy. A 204 only means the engine accepted
    // the config; the connection starts afterwards and can fail (a local app
    // that was closed), and the engine never retries it on its own.
    const live = await readLiveMcpStatus(active, directory);
    const backedOff = (name: string, fingerprint: string) => {
      const attempt = attempts.get(name);
      return !reconnect.has(name) && attempt?.fingerprint === fingerprint && Date.now() - attempt.at < waits.mcpRetryMs;
    };
    const remove = async (name: string) => {
      const result = await active.fetchJson(`/api/experimental/mcp/${encodeURIComponent(name)}`, { method: "DELETE", directory, timeoutMs: 15_000 });
      if (result.status !== 204 && result.status !== 404) throw new Error(`OpenCode v2 MCP removal failed (${result.status})`);
      applied.delete(name);
    };
    const register = async (name: string, mcpConfig: Record<string, unknown>, fingerprint: string) => {
      // The engine connects before it answers (up to the startup timeout).
      const status = await active.fetchJson(`/api/experimental/mcp/${encodeURIComponent(name)}`, {
        method: "PUT", body: { config: mcpConfig }, directory, timeoutMs: 30_000,
      }).then((result) => result.status, (error) => { warn(`MCP ${name}: ${errorMessage(error)}`); return 0; });
      if (status !== 204) {
        attempts.set(name, { fingerprint, at: Date.now() });
        if (status !== 0) warn(`MCP ${name}: registration failed (${status})`);
        return;
      }
      attempts.delete(name);
      applied.set(name, fingerprint);
    };
    const restart = async (name: string, fingerprint: string) => {
      // The engine ignores a PUT identical to the config it has, so a failed
      // connection is restarted with /connect. On a healthy client /connect
      // closes and reopens it, which is why only unhealthy ones get here.
      attempts.set(name, { fingerprint, at: Date.now() });
      warn(`MCP ${name}: connection ${live?.get(name) ?? "missing"}; reconnecting`);
      const result = await active.fetchJson(`/api/experimental/mcp/${encodeURIComponent(name)}/connect`, { method: "POST", directory, timeoutMs: 30_000 });
      if (result.status !== 204) warn(`MCP ${name}: reconnect failed (${result.status})`);
    };
    const tasks: Array<[string, Promise<void>]> = [];
    // Only registrations owned by this mirror are removed. A changed config is
    // removed before it is registered again, so a failed replacement cannot
    // leave an old credential or revoked tool active.
    for (const name of applied.keys()) {
      const wanted = desired.get(name);
      if (!wanted) tasks.push([name, remove(name)]);
      else if (wanted.fingerprint !== applied.get(name) && !backedOff(name, wanted.fingerprint)) {
        tasks.push([name, remove(name).then(() => register(name, wanted.config, wanted.fingerprint))]);
      }
    }
    for (const [name, { config: mcpConfig, fingerprint }] of desired) {
      const status = live?.get(name);
      if (applied.has(name) && applied.get(name) !== fingerprint) continue;
      if (!applied.has(name) || (live && status === undefined)) {
        // New, or the engine lost it (an identical PUT to a live entry is a no-op).
        if (!backedOff(name, fingerprint)) tasks.push([name, register(name, mcpConfig, fingerprint)]);
        continue;
      }
      // Connected and starting connections are left alone. `disabled` is only
      // ever set by an OpenWork repair, and needs_auth is retried only on request.
      const unhealthy = status === "failed" || status === "disabled" || (status === "needs_auth" && reconnect.has(name));
      if (status === "connected") attempts.delete(name);
      else if (unhealthy && !backedOff(name, fingerprint)) tasks.push([name, restart(name, fingerprint)]);
    }
    // A failed run keeps its record as is: only successful registrations are
    // recorded, and the live status check catches anything unhealthy.
    const failures = new Map<string, string>();
    const results = await Promise.allSettled(tasks.map(([, task]) => task));
    results.forEach((result, index) => {
      if (result.status === "rejected") failures.set(tasks[index][0], errorMessage(result.reason));
    });
    return failures;
  }

  async function settleWorkspaceMcp(workspaceId: string, directory: string, server: string): Promise<void> {
    // While v1 serves chats, or v2 is not up, the saved config is the whole
    // change: v2 reads each folder's connections from it when it opens the folder.
    if (!sidecar || !chatRouting) return;
    await ensureWorkspaceReady(directory);
    await syncWorkspaceMcp(workspaceId, directory, { servers: [server] });
    if (!enabled) return;
    const active = sidecar;
    if (!active) throw new ApiError(503, "mcp_tools_not_ready", "This connection is saved, but its tools are not ready yet. Retry.");
    const result = await active.fetchJson(`/api/rpc/${encodeURIComponent(MCP_READINESS_RPC_ID)}/waitForTools`, {
      method: "POST", directory, body: { input: { server } }, timeoutMs: 30_000,
    });
    if (result.status !== 200 || !isRecord(result.json) || !isRecord(result.json.output) || result.json.output.ready !== true) {
      throw new ApiError(503, "mcp_tools_not_ready", "This connection is saved, but its tools are not ready yet. Retry.");
    }
  }

  function checkMcpHealth(): void {
    for (const [directory, location] of mcpLocations) {
      void syncWorkspaceMcp(location.workspaceId, directory).catch((error) => warn(`MCP: ${errorMessage(error)}`));
    }
  }

  function status(): EngineV2PreviewStatus {
    return {
      engineOrigin, engineForced,
      ...(engineChangedAt === undefined ? {} : { engineChangedAt }),
      forceUpgradePending: autoUpgradeEnabled && !chatRouting && autoUpgradeJob !== undefined,
      enabled,
      v2Only,
      ...(v1UnavailableReason ? { v1UnavailableReason } : {}),
      chatRouting,
      liveProviderSync: enabled && chatRouting && ownsGateway(),
      running,
      ...(version === undefined ? {} : { version }),
      ...(pid === undefined ? {} : { pid }),
      ...(binSource === undefined ? {} : { binSource }),
      mirroredProviderIds: [...mirroredProviderIds],
      skippedProviderIds: [...skippedProviderIds],
      skippedProviders: skippedProviders.map(provider => ({ ...provider })),
      catalogModelIds: [...currentCatalogModelIds],
      ...(lastMirroredAt === undefined ? {} : { lastMirroredAt }),
      ...(lastError === undefined ? {} : { lastError }),
      ...(lastWarning === undefined ? {} : { lastWarning }),
    };
  }

  async function mirrorProviders(): Promise<void> {
    const active = sidecar;
    if (!active) return;
    let pushed = () => {};
    const push = new Promise<void>((resolve) => { pushed = resolve; });
    providerPush = push;
    let discovered = () => {};
    const discovery = new Promise<void>((resolve) => { discovered = resolve; });
    providerDiscovery = discovery;
    try {
      await pushAndConfirmProviders(active, pushed, discovered);
    } finally {
      discovered();
      pushed();
      if (providerDiscovery === discovery) providerDiscovery = undefined;
      if (providerPush === push) providerPush = undefined;
    }
  }

  async function pushAndConfirmProviders(active: ManagedOpencodeV2Server, pushed: () => void, discovered: () => void): Promise<void> {
    const globalRuntime = await readGlobalRuntimeOpencodeConfig(config);
    const configured = runtimeProviderMap(globalRuntime);
    // Same list v1 receives as `disabled_providers` (e.g. a disconnected
    // OpenCode Zen). Re-enabling removes the entry and this mirror restores it.
    const disabledProviderIds = runtimeDisabledProviderList(globalRuntime);
    const disabled = new Set(disabledProviderIds);
    // "Only models you provide": the providers v1 omits from `enabled_providers`
    // never reach v2 either, whether configured or connected on this computer.
    const allowsProvider = organizationProviderGate(globalRuntime.managedPolicy);
    const localAuth = await readLocalProviderAuth();
    const localKeys = allowsProvider
      ? new Map([...localAuth.apiKeys].filter(([id]) => allowsProvider(id)))
      : localAuth.apiKeys;
    const credentials = new Map((await options.env?.list() ?? []).map((entry) => [entry.key, entry.value]));
    // Providers the engine's own catalog knows need only a key from us.
    const native = await readEngineV2NativeProviders(active);
    // v1 reads catalog keys from its environment: the server's, plus Settings › Environment.
    const environment: NodeJS.ProcessEnv = { ...process.env, ...Object.fromEntries(credentials) };
    const userFile = await userConfigProviders(configured, allowsProvider, native, localKeys, credentials, undefined, environment);
    const local = await localProviderDefinitions(config, localAuth, { ...configured, ...userFile.claimed }, {
      allows: allowsProvider, native, environment,
    });
    const blockedConfigured = Object.keys(configured).filter(id => allowsProvider && !allowsProvider(id));
    const combinedProviders = { ...local.providers, ...Object.fromEntries(Object.entries(configured)
      .filter(([id]) => !allowsProvider || allowsProvider(id))) };
    // Native plugin is the sole Gateway owner. Local and legacy providers still
    // use the old mirror, including their normal readiness/catalog checks.
    const providerMap = Object.fromEntries(Object.entries(combinedProviders)
      .filter(([id]) => !ownsGateway() || !/^ipr_/i.test(id)));
    // Persisted cloud ownership is written before managed runtime rows. Do not
    // treat a Den-pushed definition as local merely because it is in that map.
    const ownership = await readOpenworkWorkspaceConfig(config, "__cloud_provider_ownership__");
    const managedIds = new Set(Array.isArray(ownership.providerIds) ? ownership.providerIds : []);
    const localOwnership = await readOpenworkWorkspaceConfig(config, MACHINE_PROVIDER_TEMPLATE_OWNERSHIP);
    const localProviderIds = machineOwnedProviderIds(configured, localOwnership);
    for (const id of localProviderIds) {
      if (managedIds.has(id) || /^(?:lpr_|ipr_|openwork$)/i.test(id)) localProviderIds.delete(id);
    }
    const templates = await resolveProviderConfigTemplates(providerMap, {
      directory: runtimeStorageDir(config), environment: credentials, localProviderIds,
      remoteEnvironmentNames: approvedProviderEnvironmentNames(ownership.providerEnvHashes, credentials),
    });
    // Hand-written definitions are trusted like Settings ones: the person wrote their endpoints.
    const mapped = mapRuntimeProvidersToV2Specs({ ...templates.providers, ...userFile.definitions }, credentials, localKeys,
      new Set([...Object.keys(configured), ...Object.keys(userFile.definitions)]));
    const specs = [...mapped.specs, ...[...local.native, ...userFile.native].map(nativeProviderSpec)]
      .filter((spec) => !disabled.has(spec.id))
      .sort((left, right) => left.id.localeCompare(right.id));
    if (ownsGateway()) mirroredSpecs = specs;
    discovered();
    const nextMirroredProviderIds = specs.map((spec) => spec.id);
    const providerFilters = Object.fromEntries(Object.entries({ ...userFile.definitions, ...combinedProviders }).flatMap(([id, value]) => {
      if (!isRecord(value)) return [];
      const whitelist = Array.isArray(value.whitelist) ? value.whitelist.filter((id): id is string => typeof id === "string") : undefined;
      const blacklist = Array.isArray(value.blacklist) ? value.blacklist.filter((id): id is string => typeof id === "string") : undefined;
      return whitelist || blacklist ? [[id, { whitelist, blacklist }]] : [];
    }));
    await active.setProviders(specs, disabledProviderIds, providerFilters);
    mirroredSpecs = specs.filter(spec => !ownsGateway() || !/^ipr_/i.test(spec.id));
    workspaceReadiness.clear();
    mirroredProviderIds = nextMirroredProviderIds.filter(id => !ownsGateway() || !/^ipr_/i.test(id));
    const skipped = mergeSkippedProviders(
      local.skipped,
      blockedConfigured.map((id): EngineV2SkippedProvider => ({ id, reason: "policy" })),
      userFile.skipped,
      [...templates.errors, ...userFile.errors].map((error): EngineV2SkippedProvider => ({ id: error.providerId, reason: "metadata" })),
      mapped.skippedProviders,
    );
    skippedProviderIds = skipped.map(provider => provider.id);
    skippedProviders = skipped;
    lastMirroredAt = new Date().toISOString();
    pushed();
    // Re-check folders already in use now, so their next prompt pays nothing.
    for (const directory of mcpLocations.keys()) void ensureWorkspaceReady(directory).catch(() => undefined);
    const catalog = await waitForEngineV2Catalog(active, workspaceDir, specs, CATALOG_MIRROR_TIMEOUT_MS, ownsGateway);
    currentCatalogModelIds = catalog.modelIds;
    lastError = [...templates.errors, ...userFile.errors].map(error => error.message)
      .concat(catalog.lastError ? [catalog.lastError] : []).join("\n") || undefined;
  }

  function scheduleMirror(): void {
    mirrorDirty = true;
    if (mirrorInFlight) return;
    mirrorInFlight = (async () => {
      try {
        while (mirrorDirty && allowRunning && sidecar) {
          mirrorDirty = false;
          mirrorError = undefined;
          try {
            await mirrorProviders();
          } catch (error) {
            mirrorError = lastError = errorMessage(error);
          }
        }
      } finally {
        mirrorInFlight = undefined;
        if (mirrorDirty && allowRunning && sidecar) scheduleMirror();
      }
    })();
    void mirrorInFlight;
  }

  async function refreshProviders(): Promise<void> {
    if (!running || !sidecar) throw new Error("OpenCode v2 is not running");
    scheduleMirror();
    await mirrorInFlight;
    if (mirrorError) throw new Error(mirrorError);
  }

  async function closeSidecar(): Promise<void> {
    const active = sidecar;
    unsubscribe?.();
    unsubscribe = undefined;
    workspaceReadiness.clear();
    sidecar = undefined;
    mcpLocations.clear();
    if (mcpHealthTimer) clearInterval(mcpHealthTimer);
    mcpHealthTimer = undefined;
    running = false;
    version = undefined;
    pid = undefined;
    const bridge = contextBridge;
    contextBridge = undefined;
    const sessionBridge = providerSessionBridge;
    providerSessionBridge = undefined;
    try {
      await Promise.all([bridge?.close(), sessionBridge?.close(), active?.close()]);
    } catch (error) {
      lastError = errorMessage(error);
    }
  }

  async function startSidecar(): Promise<void> {
    const resolved = await resolveBinary(config);
    binSource = resolved.source;
    if (!enabled || !allowRunning) return;
    await mkdir(workspaceDir, { recursive: true });
    // Remove copies left by the former v2-only Cloud materializer. Cloud
    // skills now use the same metadata/on-demand Connect path as v1.
    await rm(join(rootDir, "cloud-skills"), { recursive: true, force: true });
    const opencodeModelsUrl = await resolveOpencodeModelsUrl();
    contextBridge = options.hostReadRequest ? await createV2ContextBridge(options.hostReadRequest, connection, options.prepareDriveUpload) : undefined;
    providerSessionBridge = options.providerSession ? await createV2ProviderSessionBridge(() =>
      options.providerSession?.() ?? null) : undefined;
    const globalSkills = globalSkillDirectories();
    const historyDatabase = await selectHistoryDatabase();
    const managed = await createManagedOpencodeV2Server({
      historyDatabase,
      contextTools: contextBridge,
      ...(providerSessionBridge ? { providerSession: providerSessionBridge } : {}),
      bin: resolved.bin,
      rootDir,
      instanceId: engineInstanceId(),
      env: { OPENCODE_MODELS_URL: opencodeModelsUrl },
      permissions: async () => {
        const runtime = await readGlobalRuntimeOpencodeConfig(config);
        return executionRules(runtime.managedPolicy?.execution);
      },
      // The engine reads ~/.claude/skills and ~/.agents/skills itself, but its
      // config folder is OpenWork's own, so it never sees these two global
      // folders the skill picker lists, and a picked skill there can't be sent.
      skills: [globalSkills.openwork, globalSkills.agentLegacy],
      agentPermissions: async () => {
        const rules = agentPermissionRulesOf((await readGlobalRuntimeOpencodeConfig(config)).managedPolicy);
        if (rules.length === 0) return { rules, organizationMcp: {} };
        const workspaceIds = (await listRuntimeOpencodeConfigRows(config)).map((row) => row.workspaceId);
        return { rules, organizationMcp: await registeredOrganizationMcpServers(config, workspaceIds) };
      },
      onExit: (error) => engineExited(managed, error),
    });
    sidecar = managed;
    if (!enabled || !allowRunning) {
      await closeSidecar();
      return;
    }
    try {
      const health = await managed.health();
      version = health.version;
      pid = health.pid;
      running = health.healthy;
      healthySince = Date.now();
      lastError = undefined;
      const unsubscribeConfig = onRuntimeOpencodeConfigWrite((_writeConfig, workspaceId) => {
        const global = isEngineGlobalRuntimeConfigId(workspaceId);
        if (global) scheduleMirror();
        // Connections installed through OpenWork also update already-open
        // locations while a conversation is active.
        for (const [directory, location] of mcpLocations) {
          if (global || location.workspaceId === workspaceId) void syncWorkspaceMcp(location.workspaceId, directory).catch((error) => {
            if (sidecar) lastError = `MCP: ${errorMessage(error)}`;
          });
        }
      });
      mcpHealthTimer = setInterval(checkMcpHealth, waits.mcpHealthMs);
      mcpHealthTimer.unref?.();
      const unsubscribeEnv = options.env?.onChange(scheduleMirror);
      unsubscribe = () => { unsubscribeConfig(); unsubscribeEnv?.(); };
      scheduleMirror();
      // Readiness joins the provider push itself; it must not wait for the
      // mirror's slower catalog confirmation.
      warmActiveWorkspace();
      if (mirrorInFlight) await mirrorInFlight;
      if (!enabled || !allowRunning) {
        await closeSidecar();
        return;
      }
    } catch (error) {
      await closeSidecar();
      throw error;
    }
  }

  async function start(): Promise<void> {
    if (sidecar) return;
    if (startPromise) {
      await startPromise;
      return;
    }
    const pending = startSidecar().catch(async error => { await closeSidecar(); throw error; });
    startPromise = pending;
    try {
      await pending;
    } finally {
      if (startPromise === pending) startPromise = undefined;
    }
  }

  function recordStartError(error: unknown): void {
    running = false;
    lastError = engineStartErrorMessage(error);
    // One report per incident: retries of an engine that keeps failing stay local.
    if (restartAttempts === 0) reportEngineFailure("start", error);
    // Never infer that v1 is safe from a failed executable/configuration read:
    // upstream may already have adopted this store during an earlier boot.
    // Keep the selected engine and retry it, including fresh/forced profiles.
    scheduleRestart();
  }

  // An engine that serves chats and failed to start, or exited on its own,
  // starts again after a wait that doubles per attempt. An explicit stop
  // keeps v2 down on purpose.
  function scheduleRestart(): void {
    if (restartTimer || stopping || !allowRunning || !enabled || !chatRouting) return;
    const wait = Math.min(waits.engineRestartMs * 2 ** restartAttempts, waits.engineRestartMaxMs);
    restartAttempts += 1;
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      if (stopping || !allowRunning || !enabled || !chatRouting) return;
      void start().catch(recordStartError);
    }, wait);
    restartTimer.unref?.();
  }

  // The engine stopped without being asked. Drop it so callers see that v2 is
  // not running, then start a new one. An engine that stayed up longer than
  // the longest wait starts over at the first wait.
  function engineExited(exited: ManagedOpencodeV2Server, error: Error): void {
    if (sidecar !== exited) return;
    if (healthySince !== undefined && Date.now() - healthySince >= waits.engineRestartMaxMs) restartAttempts = 0;
    lastError = errorMessage(error);
    reportEngineFailure("exit", error);
    void closeSidecar().then(scheduleRestart);
  }

  async function stopRuntime(): Promise<void> {
    allowRunning = false;
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = undefined;
    unsubscribe?.();
    unsubscribe = undefined;
    mirrorDirty = false;
    if (startPromise) await startPromise.catch(() => undefined);
    if (mirrorInFlight) await mirrorInFlight;
    await closeSidecar();
  }

  async function requireV1Allowed(): Promise<void> {
    if (v2Only) {
      throw new ApiError(409, "engine_v2_only", "Your organization runs every chat on OpenCode v2. Switching to OpenCode v1 is turned off.");
    }
    if (v1UnavailableReason || await originalHistoryUsesV2(config)) {
      v1UnavailableReason = adoptedHistoryReason;
      throw new ApiError(409, "engine_v1_history_adopted", adoptedHistoryReason);
    }
  }

  async function setEnabled(nextEnabled: boolean): Promise<EngineV2PreviewStatus> {
    if (!nextEnabled) await requireV1Allowed();
    if (nextEnabled && enabled && running) return status();
    if (nextEnabled) {
      await selectHistoryDatabase();
      // An enable-only request cannot leave chats on a v1 store that this
      // process is about to adopt. Separate-store preview behavior is unchanged.
      if (v1UnavailableReason) chatRouting = true;
    }
    enabled = nextEnabled;
    engineOrigin = "manual";
    // A recorded time marks an explicit choice, which the background upgrade respects.
    engineChangedAt = new Date().toISOString();
    engineForced = false;
    await persistState();
    if (!enabled) {
      await stopRuntime();
      return status();
    }
    allowRunning = true;
    lastError = undefined;
    // Fire and forget: binary resolution can install from npm and boot can take
    // tens of seconds, while renderer config requests time out after 10s. The
    // status endpoint reports progress and records failures via lastError.
    void start().catch(recordStartError);
    return status();
  }

  async function setChatRouting(nextChatRouting: boolean, origin: EngineOrigin = "manual", forceOwned = origin === "forced"): Promise<EngineV2PreviewStatus> {
    if (!nextChatRouting) await requireV1Allowed();
    else await selectHistoryDatabase();
    const previous = { enabled, chatRouting, engineOrigin, engineChangedAt, engineForced, autoUpgradeRetry };
    chatRouting = nextChatRouting;
    engineOrigin = origin;
    if (origin === "reverted") enabled = false;
    engineChangedAt = new Date().toISOString();
    engineForced = forceOwned;
    if (forceOwned) autoUpgradeRetry = undefined;
    try { await persistState(); }
    catch (error) {
      ({ enabled, chatRouting, engineOrigin, engineChangedAt, engineForced, autoUpgradeRetry } = previous);
      throw error;
    }
    warmActiveWorkspace();
    return status();
  }

  function connection(): { url: string; username: string; password: string } | undefined {
    if (!running || !sidecar) return undefined;
    return { url: sidecar.url, username: sidecar.username, password: sidecar.password };
  }

  async function ensureWorkspaceReady(directory: string): Promise<void> {
    // Read local inventory first so mixed local/Gateway startup keeps local
    // readiness. This is not the provider push or catalog confirmation join.
    if (ownsGateway() && providerDiscovery) await providerDiscovery;
    // Gateway discovery is native: no old push join or catalog/readiness poll
    // is owed when the mirror has no local/legacy providers to prepare.
    if (!shouldWaitForMirroredProviders(ownsGateway(), mirroredSpecs)) return;
    // Join a mirror only until its providers are pushed; its catalog
    // confirmation can take a minute and is status, not readiness.
    if (providerPush) await joinBounded(providerPush, waits.providerPushJoinMs);
    const active = sidecar;
    if (!active) throw new Error("OpenCode v2 is not running");
    const existing = workspaceReadiness.get(directory);
    if (existing) return existing;
    // V2 loads each new location's configuration asynchronously: for about
    // 200 ms its catalog omits configured providers. v1's engine waits for its
    // own folder setup instead. This wait is bounded, never fails the request,
    // and its result is reused until the next provider mirror.
    const pending = (async () => {
      const deadline = Date.now() + waits.workspaceProviderReadyMs;
      do {
        const response = await active.fetchJson("/api/provider", { directory, timeoutMs: 5_000 }).catch(() => undefined);
        const payload = isRecord(response?.json) ? response.json.data : undefined;
        if (response?.status === 200 && Array.isArray(payload) && mirroredSpecs.every((spec) =>
          payload.some((provider) => isRecord(provider) && provider.id === spec.id
            && isRecord(provider.settings) && provider.settings.apiKey === spec.apiKey)
        )) return;
        await delay(100);
      } while (Date.now() < deadline);
      warn(`Providers: ${directory} did not list every mirrored provider in time; serving the engine's catalog`);
    })();
    workspaceReadiness.set(directory, pending);
    await pending;
  }

  function warmWorkspace(workspaceId: string, directory: string): void {
    if (!sidecar || mcpLocations.has(directory)) return;
    void ensureWorkspaceReady(directory).catch(() => undefined);
    void syncWorkspaceMcp(workspaceId, directory).catch((error) => warn(`MCP: ${errorMessage(error)}`));
  }

  // When v2 serves chats, open the active workspace as soon as the sidecar is
  // up, so the window's first model read does not wait on the location's setup.
  function warmActiveWorkspace(): void {
    if (!chatRouting || !sidecar) return;
    const workspace = findManagedEngineWorkspace(config.workspaces);
    if (workspace?.path) warmWorkspace(workspace.id, workspace.path);
  }

  // OpenCode owns schema conversion on startup. OpenWork only waits for the
  // engine being left to become idle and changes the existing routing choice.
  async function autoUpgrade(): Promise<boolean> {
    try {
      if (autoUpgradeRetry && Date.now() < autoUpgradeRetry.retryAt) return false;
      await waitForEngineIdle({ signal: autoUpgradeAbort.signal, idle: options.autoUpgradeIdle ?? (async () => false) });
      if (chosenV1Manually()) return true;
      await withEngineSwitchFence(config, { from: "v1", to: "v2", operation: async () => {
        if (stopping || chosenV1Manually() || !await options.autoUpgradeIdle?.()) return;
        enabled = true;
        allowRunning = true;
        await setChatRouting(true, "forced", true);
      } });
      if (!stopping) await start();
      return true;
    } catch (error) {
      // Never return to v1 after v2 may have converted the database in place.
      lastError = errorMessage(error);
      autoUpgradeRetry = engineAutoUpgradeRetry(autoUpgradeRetry?.attempts ?? 0);
      reportEngineFailure("upgrade", error);
      options.autoUpgradeError?.(lastError);
      await persistState().catch(error => warn(`Automatic upgrade state: ${errorMessage(error)}`));
      if (chatRouting) scheduleRestart();
      return false;
    }
  }

  async function applyV2Only(): Promise<void> {
    if (!v2Only || stopping || config.readOnly) return;
    if (autoUpgradeJob) await autoUpgradeJob;
    if (!v2Only || stopping) return;
    if (!chatRouting || !enabled || engineOrigin === "reverted") {
      if (!await (options.autoUpgradeIdle ?? (async () => false))()) {
        warn("OpenCode v2 only: waiting for running OpenCode v1 tasks before selecting v2");
        return;
      }
      await withEngineSwitchFence(config, { from: "v1", to: "v2", operation: async () => {
        if (!v2Only || stopping) return;
        enabled = true;
        allowRunning = true;
        await setChatRouting(true, "forced", true);
      } });
    }
    if (!v2Only || stopping) return;
    allowRunning = true;
    await start().catch(recordStartError);
  }

  async function setV2Only(next: boolean): Promise<EngineV2PreviewStatus> {
    // A policy refresh must still retry a switch deferred by running v1 work.
    const needsSwitch = next && !chatRouting;
    if (v2Only === next && !needsSwitch) return status();
    v2Only = next;
    // Turning the rollout off keeps the engine selection, routing and any
    // copy in progress exactly as they are: nothing moves back to v1.
    if (next && !v2OnlyJob) {
      v2OnlyJob = applyV2Only()
        .catch(error => { warn(`OpenCode v2 only: ${errorMessage(error)}`); })
        .finally(() => { v2OnlyJob = undefined; });
    }
    return status();
  }

  function setForcePolicy(_policy: { upgrade: boolean }): EngineV2PreviewStatus {
    // Compatibility for older Den/desktop heartbeats. Automatic migration no
    // longer depends on org rollout policy, including legacy upgrade:false.
    return status();
  }

  async function stop(): Promise<void> {
    stopping = true;
    autoUpgradeAbort.abort(new Error("Automatic upgrade paused while OpenWork closes."));
    await autoUpgradeJob;
    await v2OnlyJob;
    await stopRuntime();
  }

  // Someone explicitly switched this install back to OpenCode v1. Installs that
  // never chose report "manual" too (the default), but have no recorded time.
  function chosenV1Manually(): boolean {
    return engineOrigin === "manual" && Boolean(engineChangedAt) && !chatRouting;
  }

  function startWhenReady(): void {
    if (stopping) return;
    // Boot returns immediately; migration makes at most one background attempt
    // per boot and preserves explicit local engine choices.
    if (autoUpgradeEnabled && !config.readOnly && !chatRouting && !autoUpgradeJob && !chosenV1Manually()) {
      autoUpgradeJob = autoUpgrade().then(success => { if (success) autoUpgradeJob = undefined; });
    } else if (enabled && engineOrigin !== "reverted" && !(autoUpgradeEnabled && !chatRouting && !chosenV1Manually())) void start().catch(recordStartError);
  }
  if (!options.deferStart) startWhenReady();
  return { start: startWhenReady, setForcePolicy, setV2Only, status, setEnabled, setChatRouting, connection, ensureWorkspaceReady, refreshProviders, syncWorkspaceMcp, settleWorkspaceMcp, warmWorkspace, settleWorkspaceSkills, stop };
}
