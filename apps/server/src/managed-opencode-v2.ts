import { envKey, setEnv } from "@openwork/paths";
import { startupPhase } from "./startup-phase.js";
import type { EnginePermissionRule } from "./managed-policy-rules.js";
import { agentPermissionEngineV2Rules, type AgentPermissionRule, type EngineV2PermissionRule } from "./agent-permission-engine.js";
import type { OrganizationMcpServers } from "./organization-mcp-names.js";
import { nativeModelVariants } from "@openwork/types/cloud-model-fast";
import { gatewayBase } from "./gateway-quota.js";
import { openworkAgentPermissionsV2PluginPath, openworkAutoRouteV2PluginPath, openworkContextV2PluginPath, openworkGatewayQuotaV2PluginPath, openworkMcpResultsV2PluginPath, openworkPrivateValuesV2PluginPath, openworkMcpReadinessV2PluginPath, openworkProviderFiltersV2PluginPath, openworkProviderKeysV2PluginPath, openworkProviderSyncV2PluginPath, openworkVisibleReasoningV2PluginPath } from "./openwork-extensions-plugin-path.js";
import { DRIVE_UPLOAD_PERMISSION, GMAIL_DRAFT_PERMISSION, OUTLOOK_DRAFT_PERMISSION } from "./extensions/cloud-upload-constants.js";
import { pathToFileURL } from "node:url";
import { openworkSandboxV2PluginPath } from "./openwork-extensions-plugin-path.js";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { appendEngineOutputTail, createEngineStartupLineReader } from "./engine-output.js";
import { resolveOpencodeHistoryDatabase } from "./opencode-history.js";
import { providerCredentialBrokerSource } from "./opencode-v2-provider-channel.js";

export { installOpencodeV2Binary } from "./opencode-v2-binary.js";

import { loopbackFetch } from "./server-fetch.js";

export interface OpencodeV2ModelSpec {
  id: string;
  name: string;
  config?: Record<string, unknown>;
}

export type OpencodeV2ProviderFilters = Record<string, { whitelist?: string[]; blacklist?: string[] }>;

export const UNSET_API_KEY = "openwork-engine-v2-preview-unset";

export interface OpencodeV2ProviderSpec {
  id: string;
  name: string;
  baseUrl?: string;
  package?: string;
  settings?: Record<string, unknown>;
  headers?: Record<string, unknown>;
  apiKey: string;
  models: OpencodeV2ModelSpec[];
  whitelist?: string[];
  blacklist?: string[];
  native?: boolean;
}

export interface ManagedOpencodeV2ServerOptions {
  cloudSkillFoldersDirectory?: string;
  isolateProjectConfig?: () => Promise<boolean>;
  bin: string;
  rootDir: string;
  historyDatabase?: string;
  instanceId?: string;
  hostname?: string;
  port?: number;
  env?: Record<string, string>;
  bootTimeoutMs?: number;
  contextTools?: { url: string; token: string; browser?: { url: string; token: string }; sandbox?: { url: string; token: string } };
  providerSession?: { url: string; token: string };
  privateValues?: { url: string; token: string };
  permissions?: () => Promise<EnginePermissionRule[]>;
  skills?: string[];
  agentPermissions?: () => Promise<{ rules: AgentPermissionRule[]; organizationMcp: OrganizationMcpServers }>;
  onExit?: (error: Error) => void;
}

export interface OpencodeV2Health {
  healthy: boolean;
  version: string;
  pid: number;
}

export interface OpencodeV2RequestInit {
  method?: string;
  body?: unknown;
  directory?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export class OpencodeV2ResponseTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`OpenCode v2 response is larger than ${limitBytes} bytes`);
    this.name = "OpencodeV2ResponseTooLargeError";
  }
}

export interface OpencodeV2Connection {
  url: string;
  username: string;
  password: string;
}

export interface ManagedOpencodeV2Server extends OpencodeV2Connection {
  readonly projectConfigDisabled: boolean;
  childPid: number | undefined;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  health(): Promise<OpencodeV2Health>;
  fetchJson(path: string, init?: OpencodeV2RequestInit): Promise<{ status: number; json: unknown }>;
  injectProvider(spec: OpencodeV2ProviderSpec): Promise<void>;
  setProviders(specs: OpencodeV2ProviderSpec[], disabledProviderIds?: string[], providerFilters?: OpencodeV2ProviderFilters): Promise<void>;
  setSkills(directories: string[]): Promise<void>;
  refreshConfig(): Promise<void>;
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchOpencodeV2Json(
  connection: OpencodeV2Connection,
  path: string,
  init: OpencodeV2RequestInit = {},
): Promise<{ status: number; json: unknown }> {
  const separator = path.includes("?") ? "&" : "?";
  const requestPath = init.directory === undefined
    ? path
    : `${path}${separator}location%5Bdirectory%5D=${encodeURIComponent(init.directory)}`;
  const response = await loopbackFetch(`${connection.url}${requestPath}`, {
    method: init.method,
    headers: {
      authorization: `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}`,
      "content-type": "application/json",
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.timeoutMs === undefined ? undefined : AbortSignal.timeout(init.timeoutMs),
  });
  const text = init.maxResponseBytes === undefined
    ? await response.text()
    : await readBoundedText(response, init.maxResponseBytes);
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {
  }
  return { status: response.status, json };
}

async function readBoundedText(response: Response, limit: number): Promise<string> {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new OpencodeV2ResponseTooLargeError(limit);
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) {
      await reader.cancel();
      throw new OpencodeV2ResponseTooLargeError(limit);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

function diagnostics(exitCode: number | null, stdout: string, stderr: string, signal?: NodeJS.Signals | null): Error {
  const tail = (value: string) => value.slice(-4_000);
  const reason = signal ? `signal ${signal}` : `code ${String(exitCode)}`;
  return new Error(
    `OpenCode v2 server exited with ${reason}\nstdout:\n${tail(stdout)}\nstderr:\n${tail(stderr)}`,
  );
}

function passesModelFilters(provider: OpencodeV2ProviderSpec, model: OpencodeV2ModelSpec): boolean {
  return (provider.whitelist === undefined || provider.whitelist.includes(model.id)) && !provider.blacklist?.includes(model.id);
}

function isDeprecatedModel(model: OpencodeV2ModelSpec): boolean {
  return model.config?.status === "deprecated";
}

export function engineListsModel(provider: OpencodeV2ProviderSpec, model: OpencodeV2ModelSpec): boolean {
  return passesModelFilters(provider, model) && !isDeprecatedModel(model);
}

const OPENAI_COMPATIBLE_PACKAGE = "@opencode/ai/providers/openai-compatible";

export function modelCompatibility(config: Record<string, unknown>, modelId: string, providerPackage: string): Record<string, unknown> | undefined {
  const declared = isRecord(config.compatibility) ? config.compatibility : undefined;
  if (declared?.cacheFormat !== undefined || providerPackage !== OPENAI_COMPATIBLE_PACKAGE) return declared;
  const upstreamId = typeof config.id === "string" ? config.id : modelId;
  if (!/claude|anthropic/i.test(upstreamId) && !/claude|anthropic/i.test(modelId)) return declared;
  return { ...declared, cacheFormat: "anthropic" };
}

export function renderOpencodeV2Config(input: {
  providers: OpencodeV2ProviderSpec[];
  disabledProviderIds?: string[];
  permissions?: EnginePermissionRule[];
  skills: string[];
  gatewayQuotaPluginDirectory?: string;
  providerSyncPluginDirectory?: string;
  desktopSession?: string;
  providerFilters?: OpencodeV2ProviderFilters;
  providerFiltersPluginDirectory?: string;
  providerKeysPluginDirectory?: string;
  mcpResultsPluginDirectory?: string;
  mcpReadinessPluginDirectory?: string;
  visibleReasoningPluginDirectory?: string;
  autoRoutePluginDirectory?: string;
  contextPluginDirectory?: string;
  contextTools?: { url: string; token: string; browser?: { url: string; token: string }; sandbox?: { url: string; token: string } };
  agentPermissionRules?: AgentPermissionRule[];
  organizationMcp?: OrganizationMcpServers;
  agentPermissionsPluginDirectory?: string;
  sandboxPluginDirectory?: string;
  privateValuesPluginDirectory?: string;
  privateValues?: { url: string; token: string };
  cloudSkillFoldersDirectory?: string;
}): Record<string, unknown> {
  const disabled = new Set(input.disabledProviderIds ?? []);
  const enabledProviders = input.providers.filter((provider) => !disabled.has(provider.id)
    && (!input.desktopSession || !/^ipr_/i.test(provider.id)));
  const providerConfig: Record<string, unknown> = {};
  for (const provider of enabledProviders) {
    if (provider.native) {
      providerConfig[provider.id] = { settings: { apiKey: provider.apiKey } };
      continue;
    }
    const providerPackage = provider.package?.replace(/^@opencode-ai\/ai\//, "@opencode/ai/") ?? "@opencode/ai/providers/openai-compatible";
    const models: Record<string, unknown> = {};
    for (const model of provider.models) {
      if (!passesModelFilters(provider, model)) continue;
      const config = model.config ?? {};
      const modalities = isRecord(config.modalities) ? config.modalities : {};
      const compatibility = modelCompatibility(config, model.id, providerPackage);
      models[model.id] = {
        name: model.name,
        ...(typeof config.id === "string" ? { modelID: config.id } : {}),
        capabilities: {
          tools: typeof config.tool_call === "boolean" ? config.tool_call : true,
          input: modalities.input ?? ["text"],
          output: config.reasoning === true
            ? [...new Set([...(Array.isArray(modalities.output) ? modalities.output : ["text"]), "reasoning"])]
            : modalities.output ?? ["text"],
        },
        limit: config.limit ?? { context: 128_000, output: 8_192 },
        ...(typeof config.family === "string" ? { family: config.family } : {}),
        ...(isRecord(config.options) ? { settings: config.options } : {}),
        ...(isRecord(config.variants) || config.reasoning === false ? {
          variants: nativeModelVariants(config.variants, providerPackage),
        } : {}),
        ...(isRecord(config.headers) ? { headers: config.headers } : {}),
        ...(compatibility ? { compatibility } : {}),
        ...(isDeprecatedModel(model) ? { disabled: true } : {}),
      };
    }
    providerConfig[provider.id] = {
      name: provider.name,
      package: providerPackage,
      settings: {
        ...provider.settings,
        ...(provider.baseUrl ? { baseURL: provider.baseUrl } : {}),
        apiKey: provider.apiKey,
        name: provider.id,
      },
      ...(provider.headers ? { headers: provider.headers } : {}),
      models,
    };
  }
  const keyedProviders = enabledProviders.filter(provider => !provider.native && provider.apiKey !== UNSET_API_KEY).map(provider => provider.id);
  const gatewayProviders = Object.fromEntries(enabledProviders.flatMap((provider) => {
    const base = gatewayBase(provider.id, provider.baseUrl);
    return base ? [[provider.id, base.href]] : [];
  }));
  const filters: Record<string, { whitelist?: string[]; blacklist?: string[] }> = Object.fromEntries(
    input.providers.filter(provider => provider.whitelist !== undefined || provider.blacklist !== undefined)
      .map(provider => [provider.id, { whitelist: provider.whitelist, blacklist: provider.blacklist }]),
  );
  Object.assign(filters, input.providerFilters);
  for (const id of disabled) filters[id] = { whitelist: [] };
  const plugins = [
    ...(input.desktopSession && input.providerSyncPluginDirectory ? [{
      package: pathToFileURL(input.providerSyncPluginDirectory).href,
      options: { desktopSession: input.desktopSession },
    }] : []),
    ...(input.contextTools && input.contextPluginDirectory ? [{ package: pathToFileURL(input.contextPluginDirectory).href, options: input.contextTools }] : []),
    ...((Object.keys(gatewayProviders).length || input.desktopSession) && input.gatewayQuotaPluginDirectory ? [{
      package: pathToFileURL(input.gatewayQuotaPluginDirectory).href,
      options: { providers: gatewayProviders, ...(input.desktopSession ? { liveProviders: true } : {}) },
    }] : []),
    ...(Object.keys(filters).length && input.providerFiltersPluginDirectory ? [{
      package: pathToFileURL(input.providerFiltersPluginDirectory).href,
      options: { providers: filters },
    }] : []),
    ...(keyedProviders.length && input.providerKeysPluginDirectory ? [{
      package: pathToFileURL(input.providerKeysPluginDirectory).href,
      options: { providers: keyedProviders },
    }] : []),
    ...(input.mcpResultsPluginDirectory ? [{ package: pathToFileURL(input.mcpResultsPluginDirectory).href }] : []),
    ...(input.mcpReadinessPluginDirectory ? [{ package: pathToFileURL(input.mcpReadinessPluginDirectory).href }] : []),
    ...(input.visibleReasoningPluginDirectory ? [{ package: pathToFileURL(input.visibleReasoningPluginDirectory).href }] : []),
    ...(input.autoRoutePluginDirectory ? [{ package: pathToFileURL(input.autoRoutePluginDirectory).href }] : []),
    ...(input.agentPermissionRules?.length && input.agentPermissionsPluginDirectory ? [{
      package: pathToFileURL(input.agentPermissionsPluginDirectory).href,
      options: { rules: input.agentPermissionRules, organizationMcp: input.organizationMcp ?? {} },
    }] : []),
    ...(input.contextTools?.sandbox && input.sandboxPluginDirectory ? [{
      package: pathToFileURL(input.sandboxPluginDirectory).href,
      options: { ...input.contextTools.sandbox, computers: true },
    }] : []),
    ...(input.privateValuesPluginDirectory ? [{
      package: pathToFileURL(input.privateValuesPluginDirectory).href,
      ...(input.privateValues ? { options: input.privateValues } : {}),
    }] : []),
  ];
  const contextWrites = [DRIVE_UPLOAD_PERMISSION, "drive_pull_file", "drive_push_file", GMAIL_DRAFT_PERMISSION, OUTLOOK_DRAFT_PERMISSION];
  const permissions: EngineV2PermissionRule[] = [
    ...(input.contextTools && input.contextPluginDirectory ? contextWrites.map(action => ({ action, resource: "*", effect: "ask" as const })) : []),
    ...agentPermissionEngineV2Rules(input.agentPermissionRules ?? []),
    ...(input.cloudSkillFoldersDirectory ? [
      { action: "external_directory", resource: `${input.cloudSkillFoldersDirectory}/*`, effect: "allow" as const },
      { action: "edit", resource: `${input.cloudSkillFoldersDirectory}/*`, effect: "deny" as const },
    ] : []),
    ...(input.permissions ?? []),
  ];
  return {
    $schema: "https://opencode.ai/config.json",
    providers: providerConfig,
    ...(plugins.length ? { plugins } : {}),
    ...(input.permissions || permissions.length ? { permissions } : {}),
    ...(input.skills.length ? { skills: [...input.skills] } : {}),
  };
}

const ENGINE_INHERITED_ENV = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP",
  "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "CI",
  "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
  "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
  "SystemDrive", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432",
  "ALLUSERSPROFILE", "PUBLIC", "CommonProgramFiles", "CommonProgramFiles(x86)",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "OPENCODE_CLAUDE_PATH",
];

const ENGINE_PROXY_ENV = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];
const ENGINE_NO_PROXY_ENV = ["NO_PROXY", "no_proxy"];
const ENGINE_LOOPBACK_NO_PROXY = ["localhost", "127.0.0.1", "::1"];

function noProxyWithLoopback(value: string | undefined): string {
  const entries = (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.includes("*")) return entries.join(",");
  return [...entries, ...ENGINE_LOOPBACK_NO_PROXY.filter((host) => !entries.includes(host))].join(",");
}

export function inheritedEngineEnv(
  env: NodeJS.ProcessEnv | undefined,
  parentEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const opts = { platform };
  const read = (source: NodeJS.ProcessEnv | undefined, name: string) => {
    const key = envKey(source, name, opts);
    return key === undefined ? undefined : source?.[key];
  };
  const inherited: Record<string, string> = {};
  for (const name of ENGINE_INHERITED_ENV) {
    const value = read(env, name) ?? read(parentEnv, name);
    if (value !== undefined) setEnv(inherited, name, value, opts);
  }
  let proxied = false;
  for (const name of ENGINE_PROXY_ENV) {
    const value = read(env, name) ?? read(parentEnv, name);
    if (value === undefined) continue;
    setEnv(inherited, name, value, opts);
    if (value.trim()) proxied = true;
  }
  const noProxy = ENGINE_NO_PROXY_ENV.map((name) => read(env, name) ?? read(parentEnv, name));
  for (const [index, name] of ENGINE_NO_PROXY_ENV.entries()) {
    const value = noProxy[index] ?? noProxy.find((entry) => entry !== undefined);
    if (proxied) setEnv(inherited, name, noProxyWithLoopback(value), opts);
    else if (noProxy[index] !== undefined) setEnv(inherited, name, noProxy[index], opts);
  }
  return inherited;
}

export async function createManagedOpencodeV2Server(
  options: ManagedOpencodeV2ServerOptions,
): Promise<ManagedOpencodeV2Server> {
  return startupPhase("engine.v2.serve", () => createManagedOpencodeV2ServerInner(options));
}

async function createManagedOpencodeV2ServerInner(
  options: ManagedOpencodeV2ServerOptions,
): Promise<ManagedOpencodeV2Server> {
  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.port ?? 0;
  const bootTimeoutMs = options.bootTimeoutMs ?? 60_000;
  const instanceRoot = options.instanceId ? join(options.rootDir, "instances", options.instanceId) : options.rootDir;
  const configDir = join(instanceRoot, "config");
  const providerSyncPluginDirectory = join(instanceRoot, "provider-sync-plugin");
  const providerCredentialBrokerPath = join(providerSyncPluginDirectory, "credential-broker.cjs");
  const gatewayQuotaPluginDirectory = join(instanceRoot, "gateway-quota-plugin");
  const providerFiltersPluginDirectory = join(instanceRoot, "provider-filters-plugin");
  const providerKeysPluginDirectory = join(instanceRoot, "provider-keys-plugin");
  const mcpResultsPluginDirectory = join(instanceRoot, "mcp-results-plugin");
  const mcpReadinessPluginDirectory = join(instanceRoot, "mcp-readiness-plugin");
  const visibleReasoningPluginDirectory = join(instanceRoot, "visible-reasoning-plugin");
  const autoRoutePluginDirectory = join(instanceRoot, "auto-route-plugin");
  const contextPluginDirectory = join(instanceRoot, "context-plugin");
  const sandboxPluginDirectory = join(instanceRoot, "sandbox-plugin");
  const agentPermissionsPluginDirectory = join(instanceRoot, "agent-permissions-plugin");
  const privateValuesPluginDirectory = join(instanceRoot, "private-values-plugin");
  const password = randomBytes(24).toString("base64url");
  const username = "opencode";
  const sandboxBridge = options.contextTools?.sandbox;
  const projectConfigDisabled = options.isolateProjectConfig ? await options.isolateProjectConfig() : sandboxBridge ? await (async () => {
    try {
      const response = await loopbackFetch(sandboxBridge.url, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${sandboxBridge.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ operation: "host", directory: options.rootDir }),
      });
      const value: unknown = await response.json();
      return !response.ok || !isRecord(value) || value.allowed !== true;
    } catch { return true; }
  })() : false;
  let url = "";
  const providers = new Map<string, OpencodeV2ProviderSpec>();
  let skills: string[] = [...(options.skills ?? [])];
  let disabledProviderIds: string[] = [];
  let providerFilters: OpencodeV2ProviderFilters = {};
  let writes: Promise<void> = Promise.resolve();
  let agentPermissionsPluginWritten = false;
  const opencodeModelsUrl = (options.env?.OPENCODE_MODELS_URL ?? process.env.OPENCODE_MODELS_URL)?.replace(/\/+$/, "");
  const inherited = inheritedEngineEnv(options.env);
  if (options.env?.OPENCODE_CONFIG) inherited.OPENCODE_CONFIG = options.env.OPENCODE_CONFIG;

  await mkdir(options.rootDir, { recursive: true, mode: 0o700 });
  await chmod(options.rootDir, 0o700);
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await chmod(configDir, 0o700);
  if (options.providerSession) {
    await mkdir(providerSyncPluginDirectory, { recursive: true, mode: 0o700 });
    await writeFile(providerCredentialBrokerPath, providerCredentialBrokerSource, { mode: 0o600 });
    await writeFile(join(providerSyncPluginDirectory, "package.json"), JSON.stringify({ type: "module" }), { mode: 0o600 });
    await writeFile(join(providerSyncPluginDirectory, "server.js"),
      `export { default } from ${JSON.stringify(pathToFileURL(openworkProviderSyncV2PluginPath()).href)};\n`, { mode: 0o600 });
  }
  await mkdir(gatewayQuotaPluginDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(gatewayQuotaPluginDirectory, "package.json"), JSON.stringify({ type: "module" }), { mode: 0o600 });
  await writeFile(join(gatewayQuotaPluginDirectory, "server.js"),
    `export { default } from ${JSON.stringify(pathToFileURL(openworkGatewayQuotaV2PluginPath()).href)};\n`, { mode: 0o600 });
  await mkdir(providerFiltersPluginDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(providerFiltersPluginDirectory, "package.json"), JSON.stringify({ type: "module" }), { mode: 0o600 });
  await writeFile(join(providerFiltersPluginDirectory, "server.js"),
    `export { default } from ${JSON.stringify(pathToFileURL(openworkProviderFiltersV2PluginPath()).href)};\n`, { mode: 0o600 });
  await mkdir(providerKeysPluginDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(providerKeysPluginDirectory, "package.json"), JSON.stringify({ type: "module" }), { mode: 0o600 });
  await writeFile(join(providerKeysPluginDirectory, "server.js"),
    `export { default } from ${JSON.stringify(pathToFileURL(openworkProviderKeysV2PluginPath()).href)};\n`, { mode: 0o600 });
  await mkdir(mcpResultsPluginDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(mcpResultsPluginDirectory, "package.json"), JSON.stringify({ type: "module" }), { mode: 0o600 });
  await writeFile(join(mcpResultsPluginDirectory, "server.js"),
    `export { default } from ${JSON.stringify(pathToFileURL(openworkMcpResultsV2PluginPath()).href)};\n`, { mode: 0o600 });
  await mkdir(mcpReadinessPluginDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(mcpReadinessPluginDirectory, "package.json"), JSON.stringify({ type: "module" }), { mode: 0o600 });
  await writeFile(join(mcpReadinessPluginDirectory, "server.js"),
    `export { default } from ${JSON.stringify(pathToFileURL(openworkMcpReadinessV2PluginPath()).href)};\n`, { mode: 0o600 });
  await mkdir(visibleReasoningPluginDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(visibleReasoningPluginDirectory, "package.json"), JSON.stringify({ type: "module" }), { mode: 0o600 });
  await writeFile(join(visibleReasoningPluginDirectory, "server.js"),
    `export { default } from ${JSON.stringify(pathToFileURL(openworkVisibleReasoningV2PluginPath()).href)};\n`, { mode: 0o600 });
  await mkdir(autoRoutePluginDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(autoRoutePluginDirectory, "package.json"), JSON.stringify({ type: "module" }), { mode: 0o600 });
  await writeFile(join(autoRoutePluginDirectory, "server.js"),
    `export { default } from ${JSON.stringify(pathToFileURL(openworkAutoRouteV2PluginPath()).href)};\n`, { mode: 0o600 });
  await mkdir(privateValuesPluginDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(privateValuesPluginDirectory, "package.json"), JSON.stringify({ type: "module" }), { mode: 0o600 });
  await writeFile(join(privateValuesPluginDirectory, "server.js"),
    `export { default } from ${JSON.stringify(pathToFileURL(openworkPrivateValuesV2PluginPath()).href)};\n`, { mode: 0o600 });
  if (options.contextTools) {
    await mkdir(contextPluginDirectory, { recursive: true, mode: 0o700 });
    await writeFile(join(contextPluginDirectory, "package.json"), JSON.stringify({ type: "module" }), { mode: 0o600 });
    await writeFile(join(contextPluginDirectory, "server.js"),
      `export { default } from ${JSON.stringify(pathToFileURL(openworkContextV2PluginPath()).href)};\n`, { mode: 0o600 });
  }
  if (options.contextTools?.sandbox) {
    await mkdir(sandboxPluginDirectory, { recursive: true, mode: 0o700 });
    await writeFile(join(sandboxPluginDirectory, "package.json"), JSON.stringify({ type: "module" }), { mode: 0o600 });
    await writeFile(join(sandboxPluginDirectory, "server.js"),
      `export { default } from ${JSON.stringify(pathToFileURL(openworkSandboxV2PluginPath()).href)};\n`, { mode: 0o600 });
  }
  await writeConfig();
  const historyDatabase = options.historyDatabase ?? await resolveOpencodeHistoryDatabase(options.rootDir);
  const child = spawn(options.bin, ["serve", "--hostname", hostname, "--port", String(port)], {
    env: {
      ...inherited,
      ...(options.env?.OPENCODE_DISABLE_MODELS_FETCH ? { OPENCODE_DISABLE_MODELS_FETCH: options.env.OPENCODE_DISABLE_MODELS_FETCH } : {}),
      ...(options.providerSession ? { OPENWORK_PROVIDER_SESSION_FD: "3", OPENWORK_PROVIDER_SESSION_BROKER: providerCredentialBrokerPath } : {}),
      ...(projectConfigDisabled ? { OPENCODE_CONFIG_PROJECT_DISABLE: "1" } : {}),
      OPENCODE_PASSWORD: password,
      OPENCODE_DB: historyDatabase,
      OPENCODE_CONFIG_DIR: configDir,
      ...(opencodeModelsUrl === undefined ? {} : { OPENCODE_MODELS_URL: opencodeModelsUrl }),
    },
    stdio: ["ignore", "pipe", "pipe", options.providerSession ? "pipe" : "ignore"],
  });
  if (options.providerSession) {
    const channel = child.stdio[3];
    if (!channel || !("end" in channel)) {
      child.kill();
      throw new Error("OpenCode v2 credential channel unavailable");
    }
    channel.on("error", () => { child.kill(); });
    channel.end(JSON.stringify({ endpoint: options.providerSession.url, token: options.providerSession.token }));
  }

  let stdout = "";
  let stderr = "";
  let spawnError: Error | undefined;
  let announced: string | undefined;
  const lines = createEngineStartupLineReader((line) => {
    announced = line.match(/server listening on (http:\/\/[^\s]+)/)?.[1];
    if (announced) lines.stop();
  });
  let closed = false;
  let ready = false;
  let closing = false;
  child.once("close", (code, signal) => {
    closed = true;
    lines.stop();
    if (ready && !closing) options.onExit?.(diagnostics(code, stdout, stderr, signal));
  });
  child.stdout?.on("data", (chunk) => {
    const text = String(chunk);
    stdout = appendEngineOutputTail(stdout, text);
    lines.write(text);
  });
  child.stderr?.on("data", (chunk) => {
    stderr = appendEngineOutputTail(stderr, String(chunk));
  });
  child.on("error", (error) => {
    spawnError = error;
  });

  async function fetchJson(path: string, init: OpencodeV2RequestInit = {}): Promise<{ status: number; json: unknown }> {
    if (!url) throw new Error("OpenCode v2 has not announced its listener");
    return fetchOpencodeV2Json({ url, username, password }, path, init);
  }

  async function health(): Promise<OpencodeV2Health> {
    const response = await fetchJson("/api/info", { timeoutMs: 5_000 });
    if (response.status !== 200 || !isRecord(response.json)) {
      throw new Error(`OpenCode v2 health returned HTTP ${response.status}`);
    }
    const { version, pid } = response.json;
    if (typeof version !== "string" || typeof pid !== "number") {
      throw new Error("OpenCode v2 health returned an invalid payload");
    }
    if (pid !== child.pid) throw new Error("OpenCode v2 health did not match the spawned child");
    return { healthy: true, version, pid };
  }

  function writeConfig(): Promise<void> {
    const next = writes.catch(() => undefined).then(writeConfigNow);
    writes = next;
    return next;
  }

  async function agentPermissionsConfig(read: NonNullable<ManagedOpencodeV2ServerOptions["agentPermissions"]>) {
    const { rules, organizationMcp } = await read();
    if (rules.length === 0) return {};
    if (!agentPermissionsPluginWritten) {
      await mkdir(agentPermissionsPluginDirectory, { recursive: true, mode: 0o700 });
      await writeFile(join(agentPermissionsPluginDirectory, "package.json"), JSON.stringify({ type: "module" }), { mode: 0o600 });
      await writeFile(join(agentPermissionsPluginDirectory, "server.js"),
        `export { default } from ${JSON.stringify(pathToFileURL(openworkAgentPermissionsV2PluginPath()).href)};\n`, { mode: 0o600 });
      agentPermissionsPluginWritten = true;
    }
    return { agentPermissionRules: rules, organizationMcp, agentPermissionsPluginDirectory };
  }

  async function writeConfigNow(): Promise<void> {
    const target = join(configDir, "opencode.json");
    const next = `${JSON.stringify(renderOpencodeV2Config({
      providers: [...providers.values()],
      disabledProviderIds,
      gatewayQuotaPluginDirectory,
      ...(options.providerSession ? { providerSyncPluginDirectory, desktopSession: options.providerSession.url } : {}),
      providerFiltersPluginDirectory,
      providerFilters,
      providerKeysPluginDirectory,
      mcpResultsPluginDirectory,
      mcpReadinessPluginDirectory,
      visibleReasoningPluginDirectory,
      autoRoutePluginDirectory,
      contextPluginDirectory,
      sandboxPluginDirectory,
      privateValuesPluginDirectory,
      ...(options.privateValues ? { privateValues: options.privateValues } : {}),
      contextTools: options.contextTools,
      ...(options.cloudSkillFoldersDirectory ? { cloudSkillFoldersDirectory: options.cloudSkillFoldersDirectory } : {}),
      ...(options.permissions ? { permissions: await options.permissions() } : {}),
      ...(options.agentPermissions ? await agentPermissionsConfig(options.agentPermissions) : {}),
      skills,
    }), null, 2)}\n`;
    const current = await readFile(target, "utf8").catch(() => null);
    if (current === next) return;
    const temporary = `${target}.tmp-${randomBytes(8).toString("hex")}`;
    await writeFile(temporary, next, { mode: 0o600 });
    await rename(temporary, target);
  }

  async function close(): Promise<void> {
    closing = true;
    lines.stop();
    if (child.connected) child.disconnect();
    if (closed || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    const exit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    const exited = await Promise.race([
      exit.then(() => true),
      sleep(2_000).then(() => false),
    ]);
    if (!exited && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exit;
    }
  }

  const managed: ManagedOpencodeV2Server = {
    get url() { return url; },
    username,
    password,
    projectConfigDisabled,
    childPid: child.pid,
    get exitCode() {
      return child.exitCode;
    },
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    health,
    fetchJson,
    async injectProvider(spec) {
      providers.set(spec.id, spec);
      await writeConfig();
    },
    async setProviders(specs, disabled = [], filters = {}) {
      providerFilters = filters;
      providers.clear();
      for (const spec of specs) {
        providers.set(spec.id, spec);
      }
      disabledProviderIds = [...new Set(disabled)].sort();
      await writeConfig();
    },
    async setSkills(directories) {
      skills = [...directories];
      await writeConfig();
    },
    refreshConfig: writeConfig,
    close,
  };

  const deadline = Date.now() + bootTimeoutMs;
  while (Date.now() < deadline) {
    if (spawnError !== undefined) {
      await close();
      throw new Error(`Failed to start OpenCode v2 server: ${spawnError.message}\nstdout:\n${stdout.slice(-4_000)}\nstderr:\n${stderr.slice(-4_000)}`);
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      if (closed) throw diagnostics(child.exitCode, stdout, stderr);
      await sleep(250);
      continue;
    }
    if (!url && announced) {
      try {
        const endpoint = new URL(announced);
        if (endpoint.hostname !== hostname || !endpoint.port || endpoint.port === "0"
          || endpoint.username || endpoint.password || endpoint.pathname !== "/"
          || endpoint.search || endpoint.hash
          || (port !== 0 && Number(endpoint.port) !== port)) {
          throw new Error("OpenCode v2 announced an unexpected listener");
        }
        url = endpoint.origin;
      } catch (error) {
        await close();
        throw error;
      }
    }
    try {
      const state = await health();
      if (state.healthy) {
        ready = true;
        return managed;
      }
    } catch {
    }
    await sleep(250);
  }

  const exited = child.exitCode !== null || child.signalCode !== null;
  await close();
  if (exited) throw diagnostics(child.exitCode, stdout, stderr);
  throw new Error(`Timed out waiting ${bootTimeoutMs}ms for OpenCode v2 health\nstdout:\n${stdout.slice(-4_000)}\nstderr:\n${stderr.slice(-4_000)}`);
}
