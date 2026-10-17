import { withEngineSwitchFence } from "./engine-switch-fence.js";
import { acquireHistoryCopyLock } from "./opencode-v2-history-lock.js";
import { engineAutoUpgradeRetry, historyRevision, runEngineAutoUpgrade, waitForEngineIdle, type EngineAutoUpgradeRetry } from "./engine-auto-upgrade.js";
import { createV2ContextBridge } from "./opencode-v2-context-bridge.js";
import { createV2ProviderSessionBridge } from "./opencode-v2-provider-session.js";
import type { CloudProviderDenSession } from "./cloud-provider-sync.js";
import { ApiError } from "./errors.js";
import { hasV1Chat, hasV1ChatsSince, opencodeV1DatabasePath, readMigrationSessions, runOpencodeV1HistoryMigration, snapshotV1Database, type EngineV2MigrationStatus } from "./opencode-v2-migration.js";
import { executionRules } from "./managed-policy-rules.js";
import { agentPermissionEngineMcpDenial, agentPermissionRulesOf } from "./agent-permission-engine.js";
import { registeredOrganizationMcpServers } from "./connect-mcp-server-catalog.js";
import { waitForEngineSkillChanges } from "./opencode-v2-skill-settle.js";
import { MCP_READINESS_RPC_ID } from "./opencode-v2-mcp-readiness.js";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
import { findManagedEngineWorkspace } from "./workspaces.js";
import { globalSkillDirectories } from "./skills.js";
import { localProviderDefinitions, readLocalProviderApiKeys } from "./opencode-v2-local-auth.js";

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
export const ENGINE_V2_UPKEEP_WAITS: Readonly<Record<"providerPushJoinMs" | "workspaceProviderReadyMs" | "mcpRetryMs" | "mcpHealthMs", number>> = Object.freeze({
  providerPushJoinMs: 10_000,
  workspaceProviderReadyMs: 8_000,
  mcpRetryMs: 60_000,
  mcpHealthMs: 60_000,
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
  /** Effective Gateway owner on the selected engine, not merely the Den rollout. */
  liveProviderSync: boolean;
  running: boolean;
  version?: string;
  pid?: number;
  binSource?: "env" | "path" | "cache";
  mirroredProviderIds: string[];
  skippedProviderIds: string[];
  catalogModelIds: string[];
  lastMirroredAt?: string;
  lastError?: string;
  /** Most recent upkeep step that did not finish in time or was rejected; requests proceeded. */
  lastWarning?: string;
  migration: EngineV2MigrationStatus;
  /** This profile has OpenCode v1 chat history that could be migrated. */
  v1HistoryAvailable: boolean;
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
  /** Refuse (409 engine_migration_required) while v1 has chats no finished migration copied. */
  requireV1HistoryCopied(): Promise<void>;
  /** Why v2 cannot open `sessionId` when it is a v1 chat not copied yet; otherwise null. */
  describeUncopiedChat(sessionId: string): Promise<string | null>;
  connection(): { url: string; username: string; password: string } | undefined;
  ensureWorkspaceReady(directory: string): Promise<void>;
  refreshProviders(): Promise<void>;
  setLiveProviderSync(enabled: boolean): Promise<void>;
  /**
   * Reconcile a folder's MCP connections with the engine: register new or
   * changed ones, remove revoked ones, and restart failed ones after a back-off.
   * Healthy and starting connections are left alone. `reconnect` names are
   * restarted now, without the back-off, when they are not healthy.
   * Background upkeep: prompts never wait on it.
   */
  syncWorkspaceMcp(workspaceId: string, directory: string, options?: { reconnect?: string[] }): Promise<void>;
  /** Explicit mutations join the native client's executable MCP registry. */
  settleWorkspaceMcp(workspaceId: string, directory: string, server: string): Promise<void>;
  /** Start a folder's upkeep in the background the first time it is seen. Never waits or throws. */
  warmWorkspace(workspaceId: string, directory: string): void;
  /** After OpenWork writes workspace skills, briefly wait for the engine to reflect them. Never throws. */
  settleWorkspaceSkills(directory: string): Promise<void>;
  migrateHistory(): EngineV2PreviewStatus;
  stop(): Promise<void>;
}

export interface EngineV2PreviewState {
  enabled: boolean;
  chatRouting?: boolean;
  /**
   * When the last finished migration started (ms). v1 chats created before it
   * are in v2. Kept on disk so a restart tells a finished migration from a partial one.
   */
  v1HistoryCopiedAt?: number;
  /** Set while a migration runs, so one OpenWork closed mid-copy resumes when it starts again. */
  v1HistoryCopyStartedAt?: number;
  /** A durable receipt keeps completion and errors visible across restarts. */
  historyCopyResult?: EngineV2MigrationStatus;
  /** Automatic copies only resume while the hosted rollout is still enabled. */
  automaticHistoryCopy?: boolean;
  automaticHistoryRevision?: string;
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

function statePath(config: Pick<ServerConfig, "configPath">): string {
  return join(runtimeStorageDir(config), PREVIEW_STATE_FILE);
}

export function readEngineV2PreviewState(config: Pick<ServerConfig, "configPath">): EngineV2PreviewState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(statePath(config), "utf8"));
    if (
      !isRecord(parsed)
      || typeof parsed.enabled !== "boolean"
      || (parsed.chatRouting !== undefined && typeof parsed.chatRouting !== "boolean")
    ) {
      return { enabled: false, chatRouting: false };
    }
    return {
      enabled: parsed.enabled,
      chatRouting: parsed.chatRouting === true,
      ...(parsed.automaticHistoryCopy === true ? { automaticHistoryCopy: true } : {}),
      ...(typeof parsed.automaticHistoryRevision === "string" ? { automaticHistoryRevision: parsed.automaticHistoryRevision } : {}),
      ...(parsed.engineOrigin === "fresh" || parsed.engineOrigin === "manual" || parsed.engineOrigin === "forced" || parsed.engineOrigin === "reverted"
        ? { engineOrigin: parsed.engineOrigin } : {}),
      ...(typeof parsed.engineChangedAt === "string" ? { engineChangedAt: parsed.engineChangedAt } : {}),
      ...(parsed.engineForced === true ? { engineForced: true } : {}),
      ...(isRecord(parsed.autoUpgradeRetry) && typeof parsed.autoUpgradeRetry.attempts === "number"
        && Number.isFinite(parsed.autoUpgradeRetry.attempts) && typeof parsed.autoUpgradeRetry.retryAt === "number"
        && Number.isFinite(parsed.autoUpgradeRetry.retryAt)
        ? { autoUpgradeRetry: { attempts: parsed.autoUpgradeRetry.attempts, retryAt: parsed.autoUpgradeRetry.retryAt } } : {}),
      ...(typeof parsed.v1HistoryCopiedAt === "number" ? { v1HistoryCopiedAt: parsed.v1HistoryCopiedAt } : {}),
      ...(typeof parsed.v1HistoryCopyStartedAt === "number" ? { v1HistoryCopyStartedAt: parsed.v1HistoryCopyStartedAt } : {}),
      ...(isRecord(parsed.historyCopyResult) && (parsed.historyCopyResult.state === "completed" || parsed.historyCopyResult.state === "error")
        && typeof parsed.historyCopyResult.imported === "number" && typeof parsed.historyCopyResult.skipped === "number" && typeof parsed.historyCopyResult.total === "number"
        ? { historyCopyResult: { state: parsed.historyCopyResult.state, imported: parsed.historyCopyResult.imported,
          skipped: parsed.historyCopyResult.skipped, total: parsed.historyCopyResult.total,
          ...(typeof parsed.historyCopyResult.error === "string" ? { error: parsed.historyCopyResult.error } : {}),
          ...(typeof parsed.historyCopyResult.backupPath === "string" ? { backupPath: parsed.historyCopyResult.backupPath } : {}),
          ...(typeof parsed.historyCopyResult.startedAt === "string" ? { startedAt: parsed.historyCopyResult.startedAt } : {}),
          ...(parsed.historyCopyResult.resumed === true ? { resumed: true } : {}),
          ...(Array.isArray(parsed.historyCopyResult.notCopied) ? { notCopied: parsed.historyCopyResult.notCopied.flatMap((chat: unknown) =>
            isRecord(chat) && typeof chat.id === "string" && typeof chat.title === "string"
              && (chat.reason === "too_large" || chat.reason === "rejected" || chat.reason === "stopped")
              ? [{ id: chat.id, title: chat.title, reason: chat.reason }] : []) } : {}),
          ...(Array.isArray(parsed.historyCopyResult.trimmed) ? { trimmed: parsed.historyCopyResult.trimmed.flatMap((chat: unknown) =>
            isRecord(chat) && typeof chat.id === "string" && typeof chat.title === "string"
              ? [{ id: chat.id, title: chat.title }] : []) } : {}) } } : {}),
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
export function seedFreshInstallEngineState(config: Pick<ServerConfig, "configPath" | "freshInstallEngine" | "engineAutoUpgrade" | "engineForcePolicy">, env: NodeJS.ProcessEnv = process.env): boolean {
  const state = freshInstallEngineState({
    requested: config.freshInstallEngine,
    env,
    stateFileExists: existsSync(statePath(config)),
    v1HistoryExists: v1HistoryExists(env),
  });
  if (!state) return false;
  try {
    mkdirSync(runtimeStorageDir(config), { recursive: true });
    writeFileSync(statePath(config), `${JSON.stringify({ ...state, engineOrigin: "fresh", engineChangedAt: new Date().toISOString(), ...(config.engineAutoUpgrade ? { engineForced: true } : {}) }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
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
  const override = process.env.OPENWORK_OPENCODE2_BIN?.trim();
  if (config.engineV2Only) {
    // An immutable image must contain its executable. Fail before launching a
    // managed child; do not download a replacement or fall back to v1.
    const bin = override || "opencode2";
    await exec(bin, ["--version"], { timeout: 5_000 });
    return { bin, source: override ? "env" : "path" };
  }
  if (override) return { bin: override, source: "env" };

  let pathError = "not found";
  try {
    await exec("opencode2", ["--version"]);
    return { bin: "opencode2", source: "path" };
  } catch (error) {
    pathError = errorMessage(error);
  }

  try {
    const binary = await installOpencodeV2Binary(join(runtimeStorageDir(config), "opencode-v2-verified"), OPENCODE_V2_VERSION);
    return { bin: binary, source: "cache" };
  } catch (error) {
    throw new Error(
      `Unable to resolve OpenCode v2 (${pathError}; verified download: ${errorMessage(error)}). Set OPENWORK_OPENCODE2_BIN to a working opencode2 binary.`,
    );
  }
}

export function mapRuntimeProvidersToV2Specs(
  providerMap: Record<string, unknown>,
  storedCredentials: ReadonlyMap<string, string> = new Map(),
  localApiKeys: ReadonlyMap<string, string> = new Map(),
): { specs: OpencodeV2ProviderSpec[]; skippedProviderIds: string[] } {
  const specs: OpencodeV2ProviderSpec[] = [];
  const skippedProviderIds: string[] = [];

  for (const [id, value] of Object.entries(providerMap)) {
    if (!isRecord(value)) {
      skippedProviderIds.push(id);
      continue;
    }
    // Only built-in adapters: do not turn organization configuration into a
    // request to install an arbitrary runtime package.
    const packages: Record<string, string> = {
      "@ai-sdk/openai": "@opencode/ai/providers/openai",
      "@ai-sdk/anthropic": "@opencode/ai/providers/anthropic",
      "@openrouter/ai-sdk-provider": "@opencode/ai/providers/openrouter",
      "@ai-sdk/openai-compatible": "@opencode/ai/providers/openai-compatible",
    };
    const options = isRecord(value.options) ? value.options : {};
    // Catalog `api` metadata may use only the native adapter's trusted origin.
    // Custom destinations must use the existing explicit options.baseURL path.
    const explicitBaseUrl = typeof options.baseURL === "string" && options.baseURL.trim()
      ? options.baseURL : undefined;
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
          && url.origin === nativeOrigins[value.npm] && !url.username && !url.password;
      } catch { /* Invalid endpoint metadata is never mirrored. */ }
      if (!trusted) { skippedProviderIds.push(id); continue; }
    }
    const endpoint = explicitBaseUrl ?? value.api;
    const baseUrl = typeof endpoint === "string" && endpoint.trim() ? endpoint : undefined;
    const packageName = typeof value.npm === "string" && Object.hasOwn(packages, value.npm) ? packages[value.npm] : undefined;
    if ((value.npm !== undefined && !packageName)
      || (!baseUrl && (!packageName || value.npm === "@ai-sdk/openai-compatible"))) {
      skippedProviderIds.push(id);
      continue;
    }
    const { apiKey, baseURL, headers, ...settings } = options;
    const envNames = Array.isArray(value.env)
      ? value.env.filter((name): name is string => typeof name === "string") : [];
    const credentialName = selectPrimaryCredentialEnvName(envNames, storedCredentials.keys());
    const storedKey = credentialName ? storedCredentials.get(credentialName) : undefined;
    // Resolve only this provider's declared credential, never inherit the
    // server environment or copy unrelated secrets into the sidecar.
    const explicitKey = typeof apiKey === "string" && apiKey.trim() !== "" && !apiKey.includes("{env:") ? apiKey : undefined;
    const resolvedKey = explicitKey ?? storedKey ?? localApiKeys.get(id);
    if (envNames.length > 0 && !resolvedKey) {
      skippedProviderIds.push(id);
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
      ...(baseUrl ? { baseUrl } : {}),
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
  skippedProviderIds.sort((left, right) => left.localeCompare(right));
  return { specs, skippedProviderIds };
}

export function shouldSyncLiveProviderOwnerTransition(previous: boolean, next: boolean, rollout: boolean): boolean {
  return previous || next || rollout;
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

/** Translate only fields supported by the pinned v2 MCP API. */
export function mapRuntimeMcpToV2(value: unknown): Record<string, unknown> | undefined {
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
  return { type: "remote", url: value.url, headers: strings(value.headers),
    ...(oauth === undefined ? {} : { oauth }), ...shared };
}

interface McpLocation {
  workspaceId: string;
  /** Config fingerprint of each registration this mirror owns. */
  applied: Map<string, string>;
  /** Last rejected registration or restart per name, for the back-off. */
  attempts: Map<string, { fingerprint: string; at: number }>;
  /** The latest run; the next one starts after it. */
  tail?: Promise<void>;
  /** A run that has not started yet; later triggers join it. */
  queued?: { promise: Promise<void>; reconnect: Set<string> };
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

/** Start-time feature decisions never reuse an earlier engine's ownership. */
export async function resolveLiveProviderSyncForEngineStart(resolve?: () => Promise<boolean>): Promise<boolean> {
  try { return await resolve?.() === true; }
  catch { return false; }
}

export function createEngineV2Preview(options: {
  config: ServerConfig;
  env?: Pick<EnvService, "list" | "onChange">;
  deferStart?: boolean;
  hostReadRequest?: (path: string, init?: RequestInit) => Promise<unknown>;
  providerSession?: () => CloudProviderDenSession | null;
  /** Fresh Den resolution on every child start, independent of the cloud sync timer. */
  resolveLiveProviderSync?: () => Promise<boolean>;
  waits?: Partial<typeof ENGINE_V2_UPKEEP_WAITS>;
  /** Same running-task probe used by the interactive migration route; unknown is not idle. */
  autoUpgradeIdle?: () => Promise<boolean>;
  autoRevertIdle?: () => Promise<boolean>;
  autoUpgradeError?: (error: string) => void;
}): EngineV2Preview {
  const { config } = options;
  const waits = { ...ENGINE_V2_UPKEEP_WAITS, ...options.waits };
  const rootDir = join(runtimeStorageDir(config), "opencode-v2", "state");
  const workspaceDir = join(rootDir, "workspace");
  seedFreshInstallEngineState(config);
  const savedState = readEngineV2PreviewState(config);
  if (config.engineV2Only && (savedState.automaticHistoryCopy || savedState.v1HistoryCopyStartedAt !== undefined
    || (v1HistoryExists(process.env) && (!savedState.enabled || !savedState.chatRouting)))) {
    throw new Error("OpenCode v2-only runtime requires completed adoption. Restore the dual-engine image to finish migrating this profile; its history has not been changed.");
  }
  const initialState = config.engineV2Only
    ? { ...savedState, enabled: true, chatRouting: true }
    : resolveInitialEngineV2PreviewState(process.env, savedState);
  // A migration OpenWork closed mid-copy resumes at start; report it from the
  // first status read, since the server answers before it starts the engine.
  const resumeMigration = initialState.v1HistoryCopyStartedAt !== undefined && !initialState.automaticHistoryCopy;
  let automaticHistoryCopy = initialState.automaticHistoryCopy === true;
  let automaticHistoryRevision = initialState.automaticHistoryRevision;
  let engineOrigin: EngineOrigin = initialState.engineOrigin ?? "manual";
  let engineChangedAt = initialState.engineChangedAt;
  let engineForced = initialState.engineForced === true;
  let forceUpgrade = config.engineAutoUpgrade === true;
  let forceRevert = (config.engineForcePolicy === true || config.engineAutoUpgrade === true) && !forceUpgrade;
  let autoUpgradeRetry = initialState.autoUpgradeRetry;
  const autoUpgradeAbort = new AbortController();
  const autoRevertAbort = new AbortController();
  let autoUpgradeJob: Promise<void> | undefined;
  let autoRevertJob: Promise<void> | undefined;
  let migration: EngineV2MigrationStatus = resumeMigration
    ? { state: "running", phase: "starting", imported: 0, skipped: 0, total: 0, resumed: true }
    : initialState.historyCopyResult ?? { state: "idle", imported: 0, skipped: 0, total: 0 };
  let migrationJob: Promise<void> | undefined;
  let migrationAbort: AbortController | undefined;
  let stopping = false;
  let enabled = initialState.enabled;
  let chatRouting = initialState.chatRouting === true;
  // Selected once per child lifetime. A runtime kill changes only the next
  // engine start: never resume the old writer while a live plugin still owns v2.
  let liveProviderSync = false;
  const ownsGateway = () => liveProviderSync;
  let v1HistoryCopiedAt = initialState.v1HistoryCopiedAt;
  let v1HistoryCopyStartedAt = initialState.v1HistoryCopyStartedAt;
  const persistState = (receipt: EngineV2MigrationStatus = migration) => writeEngineV2PreviewState(config, {
    enabled, chatRouting, engineOrigin, engineForced,
    ...(engineChangedAt === undefined ? {} : { engineChangedAt }),
    ...(automaticHistoryRevision === undefined ? {} : { automaticHistoryRevision }),
    ...(automaticHistoryCopy ? { automaticHistoryCopy: true } : {}),
    ...(autoUpgradeRetry ? { autoUpgradeRetry } : {}),
    ...(v1HistoryCopiedAt === undefined ? {} : { v1HistoryCopiedAt }),
    ...(v1HistoryCopyStartedAt === undefined ? {} : { v1HistoryCopyStartedAt }),
    ...(receipt.state === "completed" || receipt.state === "error" ? { historyCopyResult: receipt } : {}),
  });
  let allowRunning = true;
  let running = false;
  let version: string | undefined;
  let pid: number | undefined;
  let binSource: EngineV2PreviewStatus["binSource"];
  let mirroredProviderIds: string[] = [];
  let skippedProviderIds: string[] = [];
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

  function syncWorkspaceMcp(workspaceId: string, directory: string, options: { reconnect?: string[] } = {}): Promise<void> {
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
      return location.queued.promise;
    }
    const owner = location;
    const reconnect = new Set(options.reconnect);
    const promise = (owner.tail ?? Promise.resolve()).catch(() => undefined).then(() => {
      if (owner.queued?.promise === promise) owner.queued = undefined;
      return reconcileWorkspaceMcp(directory, owner, reconnect);
    });
    owner.queued = { promise, reconnect };
    owner.tail = promise;
    return promise;
  }

  async function reconcileWorkspaceMcp(directory: string, location: McpLocation, reconnect: ReadonlySet<string>): Promise<void> {
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
      const mapped = mapRuntimeMcpToV2(value);
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
    const failures: string[] = [];
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
    const tasks: Array<Promise<void>> = [];
    // Only registrations owned by this mirror are removed. A changed config is
    // removed before it is registered again, so a failed replacement cannot
    // leave an old credential or revoked tool active.
    for (const name of applied.keys()) {
      const wanted = desired.get(name);
      if (!wanted) tasks.push(remove(name));
      else if (wanted.fingerprint !== applied.get(name) && !backedOff(name, wanted.fingerprint)) {
        tasks.push(remove(name).then(() => register(name, wanted.config, wanted.fingerprint)));
      }
    }
    for (const [name, { config: mcpConfig, fingerprint }] of desired) {
      const status = live?.get(name);
      if (applied.has(name) && applied.get(name) !== fingerprint) continue;
      if (!applied.has(name) || (live && status === undefined)) {
        // New, or the engine lost it (an identical PUT to a live entry is a no-op).
        if (!backedOff(name, fingerprint)) tasks.push(register(name, mcpConfig, fingerprint));
        continue;
      }
      // Connected and starting connections are left alone. `disabled` is only
      // ever set by an OpenWork repair, and needs_auth is retried only on request.
      const unhealthy = status === "failed" || status === "disabled" || (status === "needs_auth" && reconnect.has(name));
      if (status === "connected") attempts.delete(name);
      else if (unhealthy && !backedOff(name, fingerprint)) tasks.push(restart(name, fingerprint));
    }
    for (const result of await Promise.allSettled(tasks)) {
      if (result.status === "rejected") failures.push(errorMessage(result.reason));
    }
    // A failed run keeps its record as is: only successful registrations are
    // recorded, and the live status check catches anything unhealthy.
    if (failures.length) throw new Error(failures.join("; "));
  }

  async function settleWorkspaceMcp(workspaceId: string, directory: string, server: string): Promise<void> {
    if (!enabled) return;
    await ensureWorkspaceReady(directory);
    await syncWorkspaceMcp(workspaceId, directory);
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

  function hasV1History(): boolean {
    try { return existsSync(opencodeV1DatabasePath()); } catch { return false; }
  }

  function status(): EngineV2PreviewStatus {
    return {
      engineOrigin, engineForced,
      ...(engineChangedAt === undefined ? {} : { engineChangedAt }),
      forceUpgradePending: automaticHistoryCopy || (forceUpgrade && !forceRevert && !chatRouting && autoUpgradeJob !== undefined),
      enabled,
      migration: { ...migration },
      v1HistoryAvailable: hasV1History(),
      chatRouting,
      liveProviderSync: enabled && chatRouting && ownsGateway(),
      running,
      ...(version === undefined ? {} : { version }),
      ...(pid === undefined ? {} : { pid }),
      ...(binSource === undefined ? {} : { binSource }),
      mirroredProviderIds: [...mirroredProviderIds],
      skippedProviderIds: [...skippedProviderIds],
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
    const localKeys = await readLocalProviderApiKeys();
    const combinedProviders = { ...await localProviderDefinitions(config, localKeys, configured), ...configured };
    // Native plugin is the sole Gateway owner. Local and legacy providers still
    // use the old mirror, including their normal readiness/catalog checks.
    const providerMap = Object.fromEntries(Object.entries(combinedProviders)
      .filter(([id]) => !ownsGateway() || !/^ipr_/i.test(id)));
    const credentials = new Map((await options.env?.list() ?? []).map((entry) => [entry.key, entry.value]));
    const mapped = mapRuntimeProvidersToV2Specs(providerMap, credentials, localKeys);
    const specs = mapped.specs.filter((spec) => !disabled.has(spec.id));
    if (ownsGateway()) mirroredSpecs = specs;
    discovered();
    const nextMirroredProviderIds = specs.map((spec) => spec.id);
    const providerFilters = Object.fromEntries(Object.entries(combinedProviders).flatMap(([id, value]) => {
      if (!isRecord(value)) return [];
      const whitelist = Array.isArray(value.whitelist) ? value.whitelist.filter((id): id is string => typeof id === "string") : undefined;
      const blacklist = Array.isArray(value.blacklist) ? value.blacklist.filter((id): id is string => typeof id === "string") : undefined;
      return whitelist || blacklist ? [[id, { whitelist, blacklist }]] : [];
    }));
    await active.setProviders(specs, disabledProviderIds, providerFilters);
    mirroredSpecs = specs.filter(spec => !ownsGateway() || !/^ipr_/i.test(spec.id));
    workspaceReadiness.clear();
    mirroredProviderIds = nextMirroredProviderIds.filter(id => !ownsGateway() || !/^ipr_/i.test(id));
    skippedProviderIds = [...mapped.skippedProviderIds];
    lastMirroredAt = new Date().toISOString();
    pushed();
    // Re-check folders already in use now, so their next prompt pays nothing.
    for (const directory of mcpLocations.keys()) void ensureWorkspaceReady(directory).catch(() => undefined);
    const catalog = await waitForEngineV2Catalog(active, workspaceDir, specs, CATALOG_MIRROR_TIMEOUT_MS, ownsGateway);
    currentCatalogModelIds = catalog.modelIds;
    lastError = catalog.lastError;
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

  async function setLiveProviderSync(next: boolean): Promise<void> {
    // Signed-in cold boot delivers identity after the child starts. Activation
    // is one-way for this lifetime: one watched-config write removes the old
    // Gateway specs and registers the plugin atomically. A kill never resumes
    // the old writer against a plugin that the engine may still have loaded.
    if (!next || liveProviderSync || !enabled || !chatRouting) return;
    liveProviderSync = true;
    try {
      await sidecar?.refreshConfig();
    } catch (error) {
      liveProviderSync = false;
      throw error;
    }
    mirroredSpecs = mirroredSpecs.filter(spec => !/^ipr_/i.test(spec.id));
    workspaceReadiness.clear();
    if (sidecar) scheduleMirror();
  }

  async function closeSidecar(): Promise<void> {
    const active = sidecar;
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
    if (config.engineV2Only && v1HistoryExists(process.env)
      && await hasV1ChatsSince(opencodeV1DatabasePath(), v1HistoryCopiedAt ?? 0, true)) {
      throw new Error("OpenCode v2-only runtime found uncopied v1 chats. Restore the dual-engine image to finish adoption; retained history has not been changed.");
    }
    const resolved = await resolveBinary(config);
    binSource = resolved.source;
    if (!enabled || !allowRunning) return;
    liveProviderSync = await resolveLiveProviderSyncForEngineStart(options.resolveLiveProviderSync);
    if (!enabled || !allowRunning) return;
    await mkdir(workspaceDir, { recursive: true });
    // Remove copies left by the former v2-only Cloud materializer. Cloud
    // skills now use the same metadata/on-demand Connect path as v1.
    await rm(join(rootDir, "cloud-skills"), { recursive: true, force: true });
    const opencodeModelsUrl = await resolveOpencodeModelsUrl();
    contextBridge = options.hostReadRequest ? await createV2ContextBridge(options.hostReadRequest) : undefined;
    providerSessionBridge = options.providerSession ? await createV2ProviderSessionBridge(() =>
      ownsGateway() ? options.providerSession?.() ?? null : null) : undefined;
    const globalSkills = globalSkillDirectories();
    const managed = await createManagedOpencodeV2Server({
      contextTools: contextBridge,
      ...(providerSessionBridge ? { providerSession: { ...providerSessionBridge, enabled: ownsGateway } } : {}),
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
    // A saved/in-progress offline copy owns the database. Startup and config
    // upkeep must not reopen it while a worker is committing history batches.
    if (v1HistoryCopyStartedAt !== undefined) return;
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

  let startFailureJob: Promise<void> | undefined;
  function recordStartError(error: unknown): void {
    running = false;
    lastError = `${errorMessage(error)} Set OPENWORK_OPENCODE2_BIN to a working opencode2 binary to override resolution.`;
    if (!engineForced || engineOrigin !== "fresh") return;
    // Fresh selection is saved before startup, just like the desktop default.
    // A failed forced start must not strand that profile on an unavailable v2.
    chatRouting = false;
    enabled = false;
    engineForced = false;
    engineChangedAt = new Date().toISOString();
    migration = { ...migration, state: "error", error: lastError, startedAt: engineChangedAt };
    autoUpgradeRetry = engineAutoUpgradeRetry(autoUpgradeRetry?.attempts ?? 0);
    options.autoUpgradeError?.(lastError);
    startFailureJob = persistState().catch(error => warn(`Automatic fresh upgrade state: ${errorMessage(error)}`));
  }

  async function stopRuntime(): Promise<void> {
    allowRunning = false;
    unsubscribe?.();
    unsubscribe = undefined;
    mirrorDirty = false;
    if (startPromise) await startPromise.catch(() => undefined);
    if (mirrorInFlight) await mirrorInFlight;
    await closeSidecar();
  }

  function requireNoMigration(): void {
    if (migration.state === "running") {
      throw new ApiError(409, "engine_migration_running", "Wait for chat migration to finish before switching engines.");
    }
  }

  async function setEnabled(nextEnabled: boolean): Promise<EngineV2PreviewStatus> {
    if (!nextEnabled) throw new ApiError(409, "engine_v1_retired", "Switching back to OpenCode v1 is no longer supported.");
    requireNoMigration();
    if (nextEnabled && enabled && running) return status();
    enabled = nextEnabled;
    engineOrigin = "manual";
    engineForced = false;
    await persistState();
    allowRunning = true;
    lastError = undefined;
    // Fire and forget: binary resolution can install from npm and boot can take
    // tens of seconds, while renderer config requests time out after 10s. The
    // status endpoint reports progress and records failures via lastError.
    void start().catch(recordStartError);
    return status();
  }

  // v2 opens a v1 chat only once a migration has copied it. Routing to v2
  // before that leaves every such chat unreadable, so it waits for a copy.
  async function requireV1HistoryCopied(): Promise<void> {
    requireNoMigration();
    if (chatRouting) return;
    let source: string;
    try { source = opencodeV1DatabasePath(); } catch { return; }
    if (await hasV1ChatsSince(source, v1HistoryCopiedAt ?? 0)) {
      throw new ApiError(409, "engine_migration_required", "Migrate your OpenCode v1 chats before switching to v2, so they stay readable.");
    }
  }

  async function describeUncopiedChat(sessionId: string): Promise<string | null> {
    let source: string;
    try { source = opencodeV1DatabasePath(); } catch { return null; }
    if (!await hasV1Chat(source, sessionId)) return null;
    return migration.state === "running"
      ? "This chat is being copied to OpenCode v2. It opens here once copying finishes."
      : "This chat is still in OpenCode v1 and hasn't been copied to v2. Contact your administrator to recover this chat from its retained backup.";
  }

  async function setChatRouting(nextChatRouting: boolean, origin: EngineOrigin = "manual", forceOwned = origin === "forced"): Promise<EngineV2PreviewStatus> {
    if (!nextChatRouting && (config.engineV2Only || origin === "manual")) {
      throw new ApiError(409, "engine_v1_retired", "Switching back to OpenCode v1 is no longer supported.");
    }
    if (nextChatRouting) await requireV1HistoryCopied();
    else requireNoMigration();
    const previous = { enabled, chatRouting, engineOrigin, engineChangedAt, engineForced, automaticHistoryCopy, automaticHistoryRevision, autoUpgradeRetry };
    chatRouting = nextChatRouting;
    engineOrigin = origin;
    if (origin === "reverted") enabled = false;
    engineChangedAt = new Date().toISOString();
    engineForced = forceOwned;
    if (forceOwned) {
      // One durable write selects v2 and retires the private copy marker. A
      // crash must not leave routing selected while startup is still fenced.
      automaticHistoryCopy = false;
      automaticHistoryRevision = undefined;
      autoUpgradeRetry = undefined;
    }
    try { await persistState(); }
    catch (error) {
      ({ enabled, chatRouting, engineOrigin, engineChangedAt, engineForced, automaticHistoryCopy, automaticHistoryRevision, autoUpgradeRetry } = previous);
      throw error;
    }
    warmActiveWorkspace();
    return status();
  }

  function connection(): { url: string; username: string; password: string } | undefined {
    if (v1HistoryCopyStartedAt !== undefined || migration.state === "running") return undefined;
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

  function migrateHistory(): EngineV2PreviewStatus {
    if (config.engineV2Only) throw new ApiError(409, "engine_v1_retired", "Restore the dual-engine image to recover v1 history.");
    return migration.state === "running" ? status() : runMigration(false);
  }

  function runMigration(resumed: boolean, automatic = false): EngineV2PreviewStatus {
    const startedAt = new Date().toISOString();
    const marker = resumed ? { resumed } : {};
    migration = { state: "running", phase: "starting", imported: 0, skipped: 0, total: 0, startedAt, ...marker };
    const abort = new AbortController();
    migrationAbort = abort;
    migrationJob = (async () => {
      let completed: EngineV2MigrationStatus | undefined;
      let persistedCompletion = false;
      try {
        const source = opencodeV1DatabasePath();
        const resolved = await resolveBinary(config);
        enabled = true;
        allowRunning = true;
        // Initialize/upgrade the target schema with its own pinned engine,
        // then close it before any direct SQLite transfer. An existing saved
        // copy already owns an initialized target and must never be reopened.
        if (v1HistoryCopyStartedAt === undefined) await start();
        if (sidecar) {
          const activity = await sidecar.fetchJson("/api/session/active");
          if (activity.status !== 200 || !isRecord(activity.json) || !isRecord(activity.json.data)) {
            throw new Error("Could not verify that OpenCode v2 is idle. No history was changed.");
          }
          if (Object.values(activity.json.data).some(value => isRecord(value) && value.type === "running")) {
            throw new Error("Wait for running OpenCode v2 tasks to finish before migrating history.");
          }
        }
        v1HistoryCopyStartedAt = Date.parse(startedAt);
        await persistState();
        await stopRuntime();
        const storageDir = join(runtimeStorageDir(config), "opencode-v2");
        await runOpencodeV1HistoryMigration({ source, storageDir,
          bin: resolved.bin, targetDatabase: join(rootDir, "opencode.db"), signal: abort.signal,
          backup: { database: join(rootDir, "opencode.db"), directory: join(storageDir, "backups") },
          progress: (next) => {
            const result = { ...next, startedAt: next.startedAt ?? startedAt, ...marker };
            if (next.state === "completed") completed = result;
            else migration = result;
          } });
        if (completed) {
          v1HistoryCopiedAt = Date.parse(completed.startedAt ?? startedAt);
          v1HistoryCopyStartedAt = undefined;
          if (!stopping && !automatic) { allowRunning = true; await start(); }
          await persistState(completed);
          persistedCompletion = true;
          migration = completed;
        }
      } catch (error) {
        migration = { ...migration, state: "error", error: errorMessage(error) };
      }
      // Errors retain both the start marker and SQLite checkpoints. Restart
      // resumes instead of making partially copied history available in v2.
      if (!persistedCompletion) await persistState().catch((error) => warn(`Migration state: ${errorMessage(error)}`));
      if (v1HistoryCopyStartedAt === undefined && enabled && !stopping && !automatic) {
        allowRunning = true;
        await start().catch(recordStartError);
      }
    })();
    return status();
  }

  async function autoUpgrade(): Promise<boolean> {
    const attemptStartedAt = new Date().toISOString();
    let attemptedCopy = false;
    try {
      if (autoUpgradeRetry && Date.now() < autoUpgradeRetry.retryAt) return false;
      const source = opencodeV1DatabasePath();
      // Unlike the interactive availability hint, unreadable history is not
      // evidence of an empty profile. Fail closed rather than hide its chats.
      if (!existsSync(source) || (await readMigrationSessions(source)).length === 0) {
        await waitForEngineIdle({ signal: autoUpgradeAbort.signal, idle: options.autoUpgradeIdle ?? (async () => false) });
        enabled = true;
        allowRunning = true;
        await start();
        if (!running) throw new Error("OpenCode v2 did not become healthy. Keeping v1.");
        autoUpgradeAbort.signal.throwIfAborted();
        if (!forceUpgrade || forceRevert) return true;
        await withEngineSwitchFence(config, { from: "v1", to: "v2", operation: async () => {
          if (!forceUpgrade || !await options.autoUpgradeIdle?.() || (existsSync(source) && (await readMigrationSessions(source)).length > 0)) {
            throw new Error("OpenCode v1 gained history or running work while v2 started. Keeping v1 until a later boot.");
          }
          migration = { state: "idle", imported: 0, skipped: 0, total: 0 };
          await setChatRouting(true, "fresh", true);
        } });
        return true;
      }
      await runEngineAutoUpgrade({
        signal: autoUpgradeAbort.signal,
        idle: options.autoUpgradeIdle ?? (async () => false),
        revision: () => historyRevision(source),
        copy: async () => {
          const revision = await historyRevision(source);
          if (automaticHistoryCopy && automaticHistoryRevision !== undefined && automaticHistoryRevision !== revision
            && v1HistoryCopyStartedAt === undefined && migration.backupPath) {
            // A previous automatic copy never served v2, but v1 changed while
            // it ran. Restore its pre-copy target before taking a fresh snapshot.
            // Independent v2 chats in that backup survive; v1 is never written.
            await stopRuntime();
            const target = join(rootDir, "opencode.db");
            const temporary = `${target}.auto-restore`;
            const ownership = await acquireHistoryCopyLock(target);
            try {
              await rm(temporary, { force: true });
              await snapshotV1Database(migration.backupPath, temporary);
              await rm(`${target}-wal`, { force: true });
              await rm(`${target}-shm`, { force: true });
              await rename(temporary, target);
              v1HistoryCopiedAt = undefined;
              automaticHistoryRevision = undefined;
              await persistState();
              await ownership.complete();
            } finally { await ownership.release(); }
          }
          automaticHistoryCopy = true;
          automaticHistoryRevision ??= revision;
          // Persist ownership and source revision before starting, including a
          // crash before the copy marker. A resumed stale snapshot never switches.
          await persistState();
          attemptedCopy = true;
          runMigration(v1HistoryCopyStartedAt !== undefined, true);
          await migrationJob;
          if (migration.state !== "completed") throw new Error(migration.error ?? "Automatic history copy did not finish.");
          if (automaticHistoryRevision !== await historyRevision(source)) {
            throw new Error("OpenCode v1 changed since the saved history snapshot. Keeping v1 until a later boot.");
          }
        },
        switchEngine: async () => {
          if (!forceUpgrade || forceRevert) throw new Error("Automatic upgrade is no longer enabled. Keeping v1.");
          allowRunning = true;
          await start();
          if (!running) throw new Error("OpenCode v2 did not become healthy. Keeping v1.");
          autoUpgradeAbort.signal.throwIfAborted();
          await withEngineSwitchFence(config, { from: "v1", to: "v2", operation: async () => {
            if (!forceUpgrade || !await options.autoUpgradeIdle?.() || automaticHistoryRevision !== await historyRevision(source)) {
              throw new Error("OpenCode v1 changed while v2 started. Keeping v1 until a later boot.");
            }
            await setChatRouting(true, "forced");
          } });
        },
      });
      return true;
    } catch (error) {
      // Keep the source engine serving and the private copy/checkpoint for the
      // next boot. There is deliberately no retry loop in this process.
      chatRouting = false;
      const message = errorMessage(error);
      migration = { ...migration, state: "error", error: message,
        startedAt: attemptedCopy ? migration.startedAt ?? attemptStartedAt : attemptStartedAt };
      lastError = message;
      autoUpgradeRetry = engineAutoUpgradeRetry(autoUpgradeRetry?.attempts ?? 0);
      options.autoUpgradeError?.(message);
      await persistState().catch((error) => warn(`Automatic upgrade state: ${errorMessage(error)}`));
      return false;
    }
  }

  async function autoRevert(): Promise<boolean> {
    try {
      await autoUpgradeJob;
      if (!forceRevert || !engineForced || !chatRouting) return true;
      await waitForEngineIdle({ signal: autoRevertAbort.signal,
        idle: options.autoRevertIdle ?? (async () => !running) });
      autoRevertAbort.signal.throwIfAborted();
      // Re-check ownership after waiting: an explicit user engine choice is
      // never undone by an organization rollout.
      if (!forceRevert || !engineForced || !chatRouting) return true;
      await withEngineSwitchFence(config, { from: "v2", to: "v1", operation: async () => {
        if (!forceRevert || !engineForced || !await (options.autoRevertIdle?.() ?? Promise.resolve(!running))) {
          throw new Error("OpenCode v2 gained running work before the switch. Keeping v2.");
        }
        await setChatRouting(false, "reverted");
        // Match the existing switch-to-v1 path: no inactive v2 process should
        // accept a late prompt from a renderer that has not refreshed yet.
        await stopRuntime().catch(error => { lastError = errorMessage(error); options.autoUpgradeError?.(lastError); });
      } });
      return true;
    } catch (error) {
      lastError = errorMessage(error);
      options.autoUpgradeError?.(lastError);
      await persistState().catch((error) => warn(`Automatic revert state: ${errorMessage(error)}`));
      return false;
    }
  }

  function setForcePolicy(policy: { upgrade: boolean }): EngineV2PreviewStatus {
    // The installation has retired v1, so organization policy cannot route to
    // an absent executable. Dual-engine desktop/standalone rollback is unchanged.
    if (config.engineV2Only) return status();
    forceUpgrade = policy.upgrade;
    forceRevert = !policy.upgrade;
    // A policy change never cancels a copy or a running task. The current
    // operation re-checks the latest policy before committing its engine switch.
    startWhenReady();
    return status();
  }

  async function stop(): Promise<void> {
    stopping = true;
    autoUpgradeAbort.abort(new Error("Automatic upgrade paused while OpenWork closes."));
    migrationAbort?.abort(new Error("History copy paused while OpenWork closes. Restart to resume."));
    autoRevertAbort.abort(new Error("Automatic revert paused while OpenWork closes."));
    await autoUpgradeJob;
    await autoRevertJob;
    await migrationJob;
    await startFailureJob;
    await stopRuntime();
    await startFailureJob;
  }

  function startWhenReady(): void {
    if (stopping) return;
    if (config.engineV2Only) { void start().catch(recordStartError); return; }
    if (resumeMigration && !migrationJob) { runMigration(true); return; }
    if (migration.state === "running") return;
    // Boot returns immediately. A resolved hosted rollout starts at most one
    // background attempt; off reverts only a force-owned v2 choice.
    if (forceRevert && engineForced && chatRouting && !config.readOnly && !autoRevertJob) {
      autoRevertJob = autoRevert().then(success => { if (success) autoRevertJob = undefined; });
    } else if (forceUpgrade && !forceRevert && !config.readOnly && !chatRouting && !autoUpgradeJob) {
      autoUpgradeJob = autoUpgrade().then(success => { if (success) autoUpgradeJob = undefined; });
    } else if (enabled && !automaticHistoryCopy && engineOrigin !== "reverted" && !(forceUpgrade && !chatRouting)) void start().catch(recordStartError);
  }
  if (!options.deferStart) startWhenReady();
  return { start: startWhenReady, setForcePolicy, migrateHistory, status, setEnabled, setChatRouting, requireV1HistoryCopied, describeUncopiedChat, connection, ensureWorkspaceReady, refreshProviders, setLiveProviderSync, syncWorkspaceMcp, settleWorkspaceMcp, warmWorkspace, settleWorkspaceSkills, stop };
}
