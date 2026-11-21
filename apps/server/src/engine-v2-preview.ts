import { startupPhase } from "./startup-phase.js";
import { managedDesktopPolicy } from "./managed-desktop-policy.js";
import { assertSandboxEngineIdle, sandboxPolicyPending } from "./sandbox-engine-transition.js";
import { localSandboxRuntime } from "./local-sandbox-runtime.js";
import { applySandboxSettings, readAppliedSandboxSettings, readSandboxSettings } from "./sandbox-settings-store.js";
import { withEngineSwitchFence } from "./engine-switch-fence.js";
import { createEngineSystemProxy } from "./engine-system-proxy.js";
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
import { cloudSkillFoldersRoot } from "./cloud-skill-folders-root.js";

export type { EngineV2SkippedProvider, EngineV2SkippedProviderReason } from "./opencode-v2-local-auth.js";

const OPENCODE_V2_VERSION = constants.opencodeV2Version;
const PREVIEW_STATE_FILE = "engine-v2-preview.json";
const UNSET_API_KEY = "openwork-engine-v2-preview-unset";
const CATALOG_MIRROR_TIMEOUT_MS = 60_000;
export const ENGINE_V2_UPKEEP_WAITS: Readonly<Record<"providerPushJoinMs" | "workspaceProviderReadyMs" | "mcpRetryMs" | "mcpHealthMs" | "engineRestartMs" | "engineRestartMaxMs", number>> = Object.freeze({
  providerPushJoinMs: 10_000,
  workspaceProviderReadyMs: 8_000,
  mcpRetryMs: 60_000,
  mcpHealthMs: 60_000,
  engineRestartMs: 2_000,
  engineRestartMaxMs: 300_000,
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  liveProviderSync: boolean;
  running: boolean;
  version?: string;
  pid?: number;
  binSource?: "env" | "path" | "cache";
  mirroredProviderIds: string[];
  skippedProviderIds: string[];
  skippedProviders?: EngineV2SkippedProvider[];
  catalogModelIds: string[];
  lastMirroredAt?: string;
  lastError?: string;
  lastWarning?: string;
  v2Only: boolean;
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
  assertSandboxReady(directory: string): Promise<void>;
  assertProjectConfigReady(): Promise<void>;
  ensureProjectIsolation(options?: { deferBusy?: boolean }): Promise<void>;
  projectIsolationStatus(): Promise<{ pending: boolean; effectiveAllowHostExecution: boolean }>;
  refreshProviders(): Promise<void>;
  refreshGatewayInventory(): void;
  syncWorkspaceMcp(workspaceId: string, directory: string, options?: { reconnect?: string[]; servers?: string[] }): Promise<void>;
  settleWorkspaceMcp(workspaceId: string, directory: string, server: string): Promise<void>;
  warmWorkspace(workspaceId: string, directory: string): void;
  settleWorkspaceSkills(directory: string): Promise<void>;
  setV2Only(enabled: boolean): Promise<EngineV2PreviewStatus>;
  syncSystemProxy(): Promise<void>;
  stop(): Promise<void>;
}

export interface EngineV2PreviewState {
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

function reportEngineFailure(stage: keyof typeof ENGINE_FAILURE_TITLES, error: unknown): void {
  const home = homedir();
  const firstLine = errorMessage(error).split("\n", 1)[0] ?? "";
  const reason = (home ? firstLine.split(home).join("~") : firstLine).slice(0, 300);
  captureServerException(new Error(`${ENGINE_FAILURE_TITLES[stage]}: ${reason}`), { method: "ENGINE", route: `engine.v2.${stage}` });
}

function statePath(config: Pick<ServerConfig, "configPath">): string {
  return join(runtimeStorageDir(config), PREVIEW_STATE_FILE);
}

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
    return true;
  }
}

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
    const packages: Record<string, string> = {
      "@ai-sdk/openai": "@opencode/ai/providers/openai",
      "@ai-sdk/anthropic": "@opencode/ai/providers/anthropic",
      "@openrouter/ai-sdk-provider": "@opencode/ai/providers/openrouter",
      "@ai-sdk/openai-compatible": "@opencode/ai/providers/openai-compatible",
      "@ai-sdk/azure": "@opencode/ai/providers/azure/responses",
    };
    const options = isRecord(value.options) ? value.options : {};
    const isConfigured = configuredProviderIds.has(id);
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
      } catch {}
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
      } catch {}
    }
    const envNames = Array.isArray(value.env)
      ? value.env.filter((name): name is string => typeof name === "string") : [];
    const credentialName = selectPrimaryCredentialEnvName(envNames, storedCredentials.keys());
    const storedKey = credentialName ? storedCredentials.get(credentialName) : undefined;
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

export function mergeSkippedProviders(...groups: ReadonlyArray<readonly EngineV2SkippedProvider[]>): EngineV2SkippedProvider[] {
  const merged = new Map<string, EngineV2SkippedProvider>();
  for (const provider of groups.flat()) if (!merged.has(provider.id)) merged.set(provider.id, provider);
  return [...merged.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function nativeProviderSpec(provider: { id: string; name: string; apiKey: string }): OpencodeV2ProviderSpec {
  return { id: provider.id, name: provider.name, apiKey: provider.apiKey, models: [], native: true };
}

export async function readEngineV2NativeProviders(
  active: Pick<ManagedOpencodeV2Server, "fetchJson">,
): Promise<Map<string, EngineV2NativeProvider>> {
  const response = await active.fetchJson("/api/integration", { timeoutMs: 10_000 }).catch(() => undefined);
  return response?.status === 200 ? parseEngineV2NativeProviders(response.json) : new Map();
}

export async function userConfigProviders(
  configured: Record<string, unknown>,
  allows: ((providerId: string) => boolean) | null,
  native: EngineV2NativeProviders,
  localKeys: ReadonlyMap<string, string>,
  credentials: ReadonlyMap<string, string>,
  read: () => Promise<{ directory: string; providers: Record<string, Record<string, unknown>> }> = readUserConfigProviders,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{
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

const CONNECT_NATIVE_SKILLS_CAPABILITY = "native-skills-v1";

function withClientCapability(headers: Record<string, string>, capability: string): Record<string, string> {
  const key = Object.keys(headers).find((name) => name.toLowerCase() === CONNECT_MCP_APP_HOST_CAPABILITY_HEADER)
    ?? CONNECT_MCP_APP_HOST_CAPABILITY_HEADER;
  const existing = (headers[key] ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  return existing.includes(capability) ? headers : { ...headers, [key]: [...existing, capability].join(",") };
}

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
    ...(name === "openwork-cloud" ? { protocol: "auto" } : {}),
    ...(oauth === undefined ? {} : { oauth }), ...shared };
}

interface McpLocation {
  workspaceId: string;
  applied: Map<string, string>;
  attempts: Map<string, { fingerprint: string; at: number }>;
  tail?: Promise<McpFailures>;
  queued?: { promise: Promise<McpFailures>; reconnect: Set<string> };
}

type McpFailures = ReadonlyMap<string, string>;

async function rejectMcpFailures(run: Promise<McpFailures>, names?: readonly string[]): Promise<void> {
  const failures = [...await run].filter(([name]) => !names || names.includes(name));
  if (failures.length) throw new Error(failures.map(([name, message]) => `${name}: ${message}`).join("; "));
}

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
  fileSends?: Parameters<typeof createV2ContextBridge>[3];
  providerSession?: () => CloudProviderDenSession | null;
  waits?: Partial<typeof ENGINE_V2_UPKEEP_WAITS>;
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
  const autoUpgradeEnabled = !hasExternalOpencode(config) && config.engineAutoUpgrade !== false && !process.env.OPENWORK_ENGINE_V2_PREVIEW?.trim();
  let autoUpgradeRetry = initialState.autoUpgradeRetry;
  const autoUpgradeAbort = new AbortController();
  let autoUpgradeJob: Promise<void> | undefined;
  let stopping = false;
  let enabled = initialState.enabled;
  let chatRouting = initialState.chatRouting === true;
  const ownsGateway = () => options.providerSession !== undefined;
  let v2Only = false;
  let v2OnlyJob: Promise<void> | undefined;
  let v1UnavailableReason: string | undefined;
  const adoptedHistoryReason = "This history has been opened by OpenCode v2. Switching to v1 would leave new chats outside v2 history.";
  let selectedHistoryDatabase = initialState.historyDatabase;
  async function selectHistoryDatabase(): Promise<string> {
    if (!selectedHistoryDatabase) {
      selectedHistoryDatabase = await resolveOpencodeHistoryDatabase(rootDir);
      await persistState();
    }
    if (selectedHistoryDatabase === opencodeV1DatabasePath()) {
      adoptOriginalHistory(config);
      v1UnavailableReason = adoptedHistoryReason;
    }
    return selectedHistoryDatabase;
  }
  const persistState = () => writeEngineV2PreviewState(config, {
    enabled, chatRouting, engineOrigin, engineForced,
    ...(selectedHistoryDatabase ? { historyDatabase: selectedHistoryDatabase } : {}),
    ...(engineChangedAt === undefined ? {} : { engineChangedAt }),
    ...(autoUpgradeRetry ? { autoUpgradeRetry } : {}),
  });
  let allowRunning = true;
  const systemProxy = createEngineSystemProxy(config);
  let sidecarSystemProxy = false;
  let systemProxySync: Promise<void> = Promise.resolve();
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
  let providerPush: Promise<void> | undefined;
  let providerDiscovery: Promise<void> | undefined;
  let mirrorDirty = false;
  let mirrorError: string | undefined;
  const workspaceReadiness = new Map<string, Promise<void>>();
  let mirroredSpecs: OpencodeV2ProviderSpec[] = [];
  const mcpLocations = new Map<string, McpLocation>();
  let mcpHealthTimer: ReturnType<typeof setInterval> | undefined;
  async function settleWorkspaceSkills(directory: string): Promise<void> {
    const active = sidecar;
    if (!active || !chatRouting) return;
    await assertProjectConfigReady();
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
    await assertProjectConfigReady();
    const effective = await readEffectiveRuntimeOpencodeConfig(config, location.workspaceId);
    const runtime = runtimeMcpMap(effective);
    const agentPermissionRules = agentPermissionRulesOf(effective.managedPolicy);
    const mcpRules = agentPermissionRules.some((rule) => rule.action === "mcp");
    if (mcpRules) await active.refreshConfig();
    const organizationMcp = mcpRules ? await registeredOrganizationMcpServers(config, [location.workspaceId]) : {};
    const hostAllowed = await managedDesktopPolicy(config).assertHostExecution().then(() => true, () => false);
    const desired = new Map(Object.entries(runtime).flatMap(([name, value]) => {
      if (!hostAllowed || agentPermissionEngineMcpDenial(agentPermissionRules, name, value, organizationMcp)) return [];
      const mapped = mapRuntimeMcpToV2(value, name);
      return mapped ? [[name, { config: mapped, fingerprint: JSON.stringify(mapped) }] as const] : [];
    }));
    const { applied, attempts } = location;
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
      await managedDesktopPolicy(config).assertHostExecution();
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
      await managedDesktopPolicy(config).assertHostExecution();
      attempts.set(name, { fingerprint, at: Date.now() });
      warn(`MCP ${name}: connection ${live?.get(name) ?? "missing"}; reconnecting`);
      const result = await active.fetchJson(`/api/experimental/mcp/${encodeURIComponent(name)}/connect`, { method: "POST", directory, timeoutMs: 30_000 });
      if (result.status !== 204) warn(`MCP ${name}: reconnect failed (${result.status})`);
    };
    const tasks: Array<[string, Promise<void>]> = [];
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
        if (!backedOff(name, fingerprint)) tasks.push([name, register(name, mcpConfig, fingerprint)]);
        continue;
      }
      const unhealthy = status === "failed" || status === "disabled" || (status === "needs_auth" && reconnect.has(name));
      if (status === "connected") attempts.delete(name);
      else if (unhealthy && !backedOff(name, fingerprint)) tasks.push([name, restart(name, fingerprint)]);
    }
    const failures = new Map<string, string>();
    const results = await Promise.allSettled(tasks.map(([, task]) => task));
    results.forEach((result, index) => {
      if (result.status === "rejected") failures.set(tasks[index][0], errorMessage(result.reason));
    });
    return failures;
  }

  async function settleWorkspaceMcp(workspaceId: string, directory: string, server: string): Promise<void> {
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

  let isolationInFlight: Promise<void> | undefined;
  let isolationRefreshing = false;
  let isolationTimer: ReturnType<typeof setInterval> | undefined;
  async function localSandboxSettingsPending(): Promise<boolean> {
    const [desired, applied] = await Promise.all([readSandboxSettings(config), readAppliedSandboxSettings(config)]);
    return desired.forceSandbox !== applied.forceSandbox;
  }
  async function projectIsolationStatus(): Promise<{ pending: boolean; effectiveAllowHostExecution: boolean }> {
    const policy = managedDesktopPolicy(config);
    const [desired, applied] = await Promise.all([readSandboxSettings(config), readAppliedSandboxSettings(config)]);
    const required = await policy.requiresSandbox(desired.forceSandbox);
    return {
      pending: isolationRefreshing || policy.projectIsolationTransition() || desired.forceSandbox !== applied.forceSandbox
        || (sidecar !== undefined && sidecar.projectConfigDisabled !== required),
      effectiveAllowHostExecution: !policy.projectIsolationTransition() && (sidecar ? !sidecar.projectConfigDisabled : !applied.forceSandbox),
    };
  }
  function handleIsolationError(error: unknown, deferBusy = false): void {
    if (error instanceof ApiError && ["engine_busy", "sandbox_engine_busy", "sandbox_engine_activity_unavailable"].includes(error.code)) {
      if (deferBusy) return;
      throw sandboxPolicyPending();
    }
    throw error;
  }
  async function waitForIsolation(refresh: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([refresh, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ApiError(503, "sandbox_engine_refresh_failed", "OpenWork is still applying your sandbox setting. Try again in a moment.")), 30_000);
        timer.unref();
      })]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async function ensureProjectIsolation(change: { deferBusy?: boolean } = {}): Promise<void> {
    if (isolationInFlight) return waitForIsolation(isolationInFlight).catch(error => handleIsolationError(error, change.deferBusy));
    const pending = (async () => {
      if (startPromise) await startPromise;
      const policy = managedDesktopPolicy(config);
      if (!sidecar) { if (!policy.projectIsolationTransition()) await applySandboxSettings(config); return; }
      const needsChange = async () => sidecar !== undefined && (sidecar.projectConfigDisabled !== await policy.requiresSandbox() || await localSandboxSettingsPending());
      if (!await needsChange()) return;
      await withEngineSwitchFence(config, { from: "v2", to: "v2", rejectActive: true, operation: async () => {
        const active = sidecar;
        if (!active) throw new ApiError(503, "sandbox_unavailable", "OpenWork stopped before it could apply your sandbox setting. Try again. Nothing ran.");
        if (!await policy.requiresSandbox()) {
          try { await policy.verifySandboxHostAuthority(); }
          catch (error) { if (!await policy.requiresSandbox()) throw error; }
        }
        if (!await needsChange()) return;
        await assertSandboxEngineIdle(active);
        isolationRefreshing = true;
        policy.setProjectIsolationTransition(true);
        const resume = allowRunning;
        await stopRuntime();
        if (stopping || !enabled || !resume) throw new ApiError(503, "sandbox_unavailable", "OpenWork stopped while applying your sandbox setting. Start it and try again.");
        allowRunning = true;
        try { await start(); }
        catch (error) {
          recordStartError(error);
          throw new ApiError(503, "sandbox_engine_refresh_failed", "Your sandbox setting is saved, but OpenWork couldn’t apply it. Try again. Nothing ran.");
        }
        if (!sidecar || sidecar.projectConfigDisabled !== await policy.requiresSandbox()) {
          throw new ApiError(503, "sandbox_engine_permission_changed", "Your sandbox permissions changed while OpenWork was applying them. Send your message again.");
        }
      } });
    })();
    const settled = pending.finally(() => {
      if (isolationInFlight === settled) { isolationInFlight = undefined; isolationRefreshing = false; }
    });
    isolationInFlight = settled;
    return waitForIsolation(settled).catch(error => handleIsolationError(error, change.deferBusy));
  }

  async function assertProjectConfigReady(): Promise<void> {
    const status = await projectIsolationStatus();
    const refresh = isolationRefreshing ? isolationInFlight : undefined;
    if (refresh) await waitForIsolation(refresh);
    if ((refresh || status.pending) && (await projectIsolationStatus()).pending) throw sandboxPolicyPending();
  }

  async function assertSandboxReady(directory: string): Promise<void> {
    const policy = managedDesktopPolicy(config);
    await policy.assertHostExecution().catch(() => undefined);
    await ensureProjectIsolation();
    if (!await policy.requiresSandbox()) return;
    const active = sidecar;
    if (!active || !contextBridge?.sandbox) throw new ApiError(503, "sandbox_unavailable", "The sandbox is not ready. Wait a moment and send your message again.");
    if (!active.projectConfigDisabled) throw new ApiError(503, "sandbox_engine_restart_required", "Restart OpenWork to apply your sandbox setting, then send your message again.");
    if (version?.replace(/^v/, "") !== OPENCODE_V2_VERSION) throw new ApiError(503, "sandbox_engine_unsupported", "This version of OpenWork can’t enforce your sandbox setting. Update OpenWork and try again.");
    const plugins = await active.fetchJson("/api/plugin", { directory, timeoutMs: 10_000 });
    const instance = engineInstanceId();
    const expected = join(rootDir, ...(instance ? ["instances", instance] : []), "sandbox-plugin");
    const data = isRecord(plugins.json) && Array.isArray(plugins.json.data) ? plugins.json.data : [];
    const installed = data.filter(isRecord).some(plugin => plugin.id === "openwork.sandbox"
      && isRecord(plugin.state) && plugin.state.status === "active"
      && isRecord(plugin.source) && plugin.source.type === "local" && plugin.source.path === expected);
    if (plugins.status !== 200 || !installed) throw new ApiError(503, "sandbox_unavailable", "OpenWork couldn’t verify that the sandbox is ready. Restart OpenWork and try again.");
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
    const disabledProviderIds = runtimeDisabledProviderList(globalRuntime);
    const disabled = new Set(disabledProviderIds);
    const allowsProvider = organizationProviderGate(globalRuntime.managedPolicy);
    const unreadable: string[] = [];
    const localAuth = await readLocalProviderAuth().catch((error: unknown) => {
      unreadable.push(errorMessage(error));
      return { apiKeys: new Map<string, string>(), signIns: new Set<string>() };
    });
    const localKeys = allowsProvider
      ? new Map([...localAuth.apiKeys].filter(([id]) => allowsProvider(id)))
      : localAuth.apiKeys;
    const credentials = new Map((await options.env?.list() ?? []).map((entry) => [entry.key, entry.value]));
    const native = await readEngineV2NativeProviders(active);
    const environment: NodeJS.ProcessEnv = { ...process.env, ...Object.fromEntries(credentials) };
    const userFile = await userConfigProviders(configured, allowsProvider, native, localKeys, credentials, undefined, environment);
    const local = await localProviderDefinitions(config, localAuth, { ...configured, ...userFile.claimed }, {
      allows: allowsProvider, native, environment,
      onCatalogError: () => { unreadable.push("Could not read locally connected provider metadata"); },
    });
    const blockedConfigured = Object.keys(configured).filter(id => allowsProvider && !allowsProvider(id));
    const combinedProviders = { ...local.providers, ...Object.fromEntries(Object.entries(configured)
      .filter(([id]) => !allowsProvider || allowsProvider(id))) };
    const providerMap = Object.fromEntries(Object.entries(combinedProviders)
      .filter(([id]) => !ownsGateway() || !/^ipr_/i.test(id)));
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
    for (const directory of mcpLocations.keys()) void ensureWorkspaceReady(directory).catch(() => undefined);
    const catalog = await waitForEngineV2Catalog(active, workspaceDir, specs, CATALOG_MIRROR_TIMEOUT_MS, ownsGateway);
    currentCatalogModelIds = catalog.modelIds;
    lastError = [...unreadable, ...[...templates.errors, ...userFile.errors].map(error => error.message)]
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
    if (isolationTimer) clearInterval(isolationTimer);
    isolationTimer = undefined;
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
    await rm(join(rootDir, "cloud-skills"), { recursive: true, force: true });
    const opencodeModelsUrl = await resolveOpencodeModelsUrl();
    await applySandboxSettings(config);
    contextBridge = options.hostReadRequest ? await createV2ContextBridge(options.hostReadRequest, connection, options.prepareDriveUpload, options.fileSends, config) : undefined;
    providerSessionBridge = options.providerSession ? await createV2ProviderSessionBridge(() =>
      options.providerSession?.() ?? null) : undefined;
    const globalSkills = globalSkillDirectories();
    const historyDatabase = await selectHistoryDatabase();
    const policy = managedDesktopPolicy(config);
    const startedWithSystemProxy = systemProxy.wanted();
    const systemProxyEnv = startedWithSystemProxy ? await systemProxy.env() : {};
    const managed = await createManagedOpencodeV2Server({
      ...(policy.projectIsolationTransition() && contextBridge?.sandbox ? {
        isolateProjectConfig: async () => {
          try { await policy.verifySandboxHostAuthority(); } catch { return true; }
          return policy.requiresSandbox();
        },
      } : {}),
      historyDatabase,
      contextTools: contextBridge,
      cloudSkillFoldersDirectory: cloudSkillFoldersRoot(config),
      ...(providerSessionBridge ? { providerSession: providerSessionBridge } : {}),
      bin: resolved.bin,
      rootDir,
      instanceId: engineInstanceId(),
      env: { ...systemProxyEnv, OPENCODE_MODELS_URL: opencodeModelsUrl },
      permissions: async () => {
        const runtime = await readGlobalRuntimeOpencodeConfig(config);
        return executionRules(runtime.managedPolicy?.execution);
      },
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
    sidecarSystemProxy = startedWithSystemProxy;
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
        for (const [directory, location] of mcpLocations) {
          if (global || location.workspaceId === workspaceId) void syncWorkspaceMcp(location.workspaceId, directory).catch((error) => {
            if (sidecar) lastError = `MCP: ${errorMessage(error)}`;
          });
        }
      });
      mcpHealthTimer = setInterval(checkMcpHealth, waits.mcpHealthMs);
      mcpHealthTimer.unref?.();
      isolationTimer = setInterval(() => {
        if (stopping || !allowRunning || !sidecar) return;
        void ensureProjectIsolation({ deferBusy: true }).catch(error => warn(`Permissions: ${errorMessage(error)}`));
      }, 500);
      isolationTimer.unref?.();
      const unsubscribeEnv = options.env?.onChange(scheduleMirror);
      unsubscribe = () => { unsubscribeConfig(); unsubscribeEnv?.(); };
      scheduleMirror();
      warmActiveWorkspace();
      if (mirrorInFlight) await mirrorInFlight;
      if (!enabled || !allowRunning) {
        await closeSidecar();
        return;
      }
      if (policy.projectIsolationTransition() && running && managed === sidecar
        && managed.projectConfigDisabled === await policy.requiresSandbox() && managed === sidecar) {
        policy.setProjectIsolationTransition(false);
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
    if (restartAttempts === 0) reportEngineFailure("start", error);
    scheduleRestart();
  }

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

  function engineExited(exited: ManagedOpencodeV2Server, error: Error): void {
    if (sidecar !== exited) return;
    if (healthySince !== undefined && Date.now() - healthySince >= waits.engineRestartMaxMs) restartAttempts = 0;
    lastError = errorMessage(error);
    reportEngineFailure("exit", error);
    void closeSidecar().then(scheduleRestart);
  }

  async function applySystemProxy(): Promise<void> {
    if (!systemProxy.available || stopping) return;
    await systemProxy.record(await managedDesktopPolicy(config).systemProxyEnabled());
    if (startPromise) await startPromise.catch(() => undefined);
    const mismatched = () => sidecar !== undefined && sidecarSystemProxy !== systemProxy.wanted();
    if (!mismatched() || stopping) return;
    await withEngineSwitchFence(config, { from: "v2", to: "v2", rejectActive: true, operation: async () => {
      const active = sidecar;
      if (!active || !mismatched() || stopping || !enabled || !allowRunning) return;
      await assertSandboxEngineIdle(active);
      await stopRuntime();
      if (stopping || !enabled) return;
      allowRunning = true;
      await start().catch(recordStartError);
    } });
  }
  function syncSystemProxy(): Promise<void> {
    systemProxySync = systemProxySync.then(applySystemProxy).catch(() => undefined);
    return systemProxySync;
  }

  const signedOutSystemProxyCheck = systemProxy.available ? setTimeout(() => { void syncSystemProxy(); }, 30_000) : undefined;
  signedOutSystemProxyCheck?.unref?.();

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
    await managedDesktopPolicy(config).assertLegacyHostExecution();
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
      if (v1UnavailableReason) chatRouting = true;
    }
    enabled = nextEnabled;
    engineOrigin = "manual";
    engineChangedAt = new Date().toISOString();
    engineForced = false;
    await persistState();
    if (!enabled) {
      await stopRuntime();
      return status();
    }
    allowRunning = true;
    lastError = undefined;
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
    await assertProjectConfigReady();
    if (ownsGateway() && providerDiscovery) await providerDiscovery;
    if (!shouldWaitForMirroredProviders(ownsGateway(), mirroredSpecs)) return;
    if (providerPush) await joinBounded(providerPush, waits.providerPushJoinMs);
    const active = sidecar;
    if (!active) throw new Error("OpenCode v2 is not running");
    const existing = workspaceReadiness.get(directory);
    if (existing) return existing;
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
    void localSandboxRuntime(config).prepare(directory, "workspace-ready");
    void ensureWorkspaceReady(directory).catch(() => undefined);
    void syncWorkspaceMcp(workspaceId, directory).catch((error) => warn(`MCP: ${errorMessage(error)}`));
  }

  function warmActiveWorkspace(): void {
    if (!chatRouting || !sidecar) return;
    const workspace = findManagedEngineWorkspace(config.workspaces);
    if (workspace?.path) warmWorkspace(workspace.id, workspace.path);
  }

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
    const needsSwitch = next && !chatRouting;
    if (v2Only === next && !needsSwitch) return status();
    v2Only = next;
    if (next && !v2OnlyJob) {
      v2OnlyJob = applyV2Only()
        .catch(error => { warn(`OpenCode v2 only: ${errorMessage(error)}`); })
        .finally(() => { v2OnlyJob = undefined; });
    }
    return status();
  }

  function setForcePolicy(_policy: { upgrade: boolean }): EngineV2PreviewStatus {
    return status();
  }

  async function stop(): Promise<void> {
    stopping = true;
    clearTimeout(signedOutSystemProxyCheck);
    autoUpgradeAbort.abort(new Error("Automatic upgrade paused while OpenWork closes."));
    await autoUpgradeJob;
    await v2OnlyJob;
    await stopRuntime();
  }

  function chosenV1Manually(): boolean {
    return engineOrigin === "manual" && Boolean(engineChangedAt) && !chatRouting;
  }

  function startWhenReady(): void {
    if (stopping) return;
    if (autoUpgradeEnabled && !config.readOnly && !chatRouting && !autoUpgradeJob && !chosenV1Manually()) {
      autoUpgradeJob = autoUpgrade().then(success => { if (success) autoUpgradeJob = undefined; });
    } else if (enabled && engineOrigin !== "reverted" && !(autoUpgradeEnabled && !chatRouting && !chosenV1Manually())) void start().catch(recordStartError);
  }
  if (!options.deferStart) startWhenReady();
  return { start: startWhenReady, syncSystemProxy, setForcePolicy, setV2Only, status, setEnabled, setChatRouting, connection, ensureWorkspaceReady, assertSandboxReady, assertProjectConfigReady, ensureProjectIsolation, projectIsolationStatus, refreshProviders,
    refreshGatewayInventory: () => { providerSessionBridge?.invalidateInventory(); },
    syncWorkspaceMcp, settleWorkspaceMcp, warmWorkspace, settleWorkspaceSkills, stop };
}
