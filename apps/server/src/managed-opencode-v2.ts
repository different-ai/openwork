import { envKey, setEnv } from "@openwork/paths";
import { startupPhase } from "./startup-phase.js";
import type { EnginePermissionRule } from "./managed-policy-rules.js";
import { agentPermissionEngineV2Rules, type AgentPermissionRule, type EngineV2PermissionRule } from "./agent-permission-engine.js";
import type { OrganizationMcpServers } from "./organization-mcp-names.js";
import { nativeModelVariants } from "@openwork/types/cloud-model-fast";
import { gatewayBase } from "./gateway-quota.js";
import { openworkAgentPermissionsV2PluginPath, openworkAutoRouteV2PluginPath, openworkContextV2PluginPath, openworkGatewayQuotaV2PluginPath, openworkMcpResultsV2PluginPath, openworkMcpReadinessV2PluginPath, openworkProviderFiltersV2PluginPath, openworkProviderSyncV2PluginPath, openworkVisibleReasoningV2PluginPath } from "./openwork-extensions-plugin-path.js";
import { DRIVE_UPLOAD_PERMISSION, GMAIL_DRAFT_PERMISSION, OUTLOOK_DRAFT_PERMISSION } from "./extensions/cloud-upload-constants.js";
import { pathToFileURL } from "node:url";
// Parallel v2 lane prototype: provider injection is a watched-config write. This module
// deliberately has no reload/dispose call, unlike managed-opencode.ts and server.ts reloadOpencodeEngine.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { appendEngineOutputTail, createEngineStartupLineReader } from "./engine-output.js";
import { acquireEngineHistoryLease } from "./opencode-v2-history-lock.js";
import { providerCredentialBrokerSource } from "./opencode-v2-provider-channel.js";

export { installOpencodeV2Binary } from "./opencode-v2-binary.js";

import { loopbackFetch } from "./server-fetch.js";

export interface OpencodeV2ModelSpec {
  id: string;
  name: string;
  config?: Record<string, unknown>;
}

export type OpencodeV2ProviderFilters = Record<string, { whitelist?: string[]; blacklist?: string[] }>;

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
  /**
   * A provider of the engine's own catalog: the config carries only its key,
   * and the engine supplies the endpoints, adapters and models it knows.
   */
  native?: boolean;
}

export interface ManagedOpencodeV2ServerOptions {
  bin: string;
  rootDir: string;
  /**
   * Scopes this server's generated config and plugin loaders under
   * `<rootDir>/instances/<instanceId>`. Several OpenWork apps (an installed
   * build, a dev build, a test world) can share one engine state directory;
   * with one shared config they overwrite each other's file, each write
   * reloads the engine's model catalog, and a turn that starts mid-reload or
   * after the other app's write fails with "Model unavailable". History
   * (`opencode.db`) and the workspace stay shared.
   */
  instanceId?: string;
  hostname?: string;
  port?: number;
  env?: Record<string, string>;
  bootTimeoutMs?: number;
  contextTools?: { url: string; token: string; browser?: { url: string; token: string } };
  /** Session capability travels once over an inherited pipe, never environment or config. */
  providerSession?: { url: string; token: string };
  permissions?: () => Promise<EnginePermissionRule[]>;
  /** Extra absolute skill directories registered before boot, so no later config write reloads the catalog. */
  skills?: string[];
  /**
   * The signed-in member's agent permissions, which the engine and the agent
   * permissions plugin apply, with the organization MCP servers OpenWork
   * registered, which they leave alone.
   */
  agentPermissions?: () => Promise<{ rules: AgentPermissionRule[]; organizationMcp: OrganizationMcpServers }>;
  /** Called once when the engine exits after it became healthy, unless `close()` stopped it. */
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
  /** Stop reading a larger response body and throw OpencodeV2ResponseTooLargeError instead. */
  maxResponseBytes?: number;
}

/** A response body was larger than the caller's `maxResponseBytes`; it was not read into memory. */
export class OpencodeV2ResponseTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`OpenCode v2 response is larger than ${limitBytes} bytes`);
    this.name = "OpencodeV2ResponseTooLargeError";
  }
}

/** Where a running OpenCode v2 server listens, with its generated Basic credentials. */
export interface OpencodeV2Connection {
  url: string;
  username: string;
  password: string;
}

export interface ManagedOpencodeV2Server extends OpencodeV2Connection {
  childPid: number | undefined;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  health(): Promise<OpencodeV2Health>;
  fetchJson(path: string, init?: OpencodeV2RequestInit): Promise<{ status: number; json: unknown }>;
  injectProvider(spec: OpencodeV2ProviderSpec): Promise<void>;
  /**
   * Replace the mirrored providers. `disabledProviderIds` hides those
   * providers (including built-ins such as OpenCode Zen) from the native
   * catalog, matching v1 `disabled_providers`.
   */
  setProviders(specs: OpencodeV2ProviderSpec[], disabledProviderIds?: string[], providerFilters?: OpencodeV2ProviderFilters): Promise<void>;
  /** Extra absolute skill directories registered through native config `skills`. */
  setSkills(directories: string[]): Promise<void>;
  /** Rewrites the config when what it is read from changed, e.g. the organization MCP servers OpenWork registers. */
  refreshConfig(): Promise<void>;
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One JSON request to a running OpenCode v2 server, also usable from another process. */
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
    // Non-JSON engine responses remain observable as raw text.
  }
  return { status: response.status, json };
}

/** Read a body as UTF-8 only while it stays within `limit` bytes; chunks stay off the JS heap until decoded. */
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

/** A models.dev `deprecated` status is written as `disabled`, which the engine's catalog hides. */
function isDeprecatedModel(model: OpencodeV2ModelSpec): boolean {
  return model.config?.status === "deprecated";
}

/** Whether the engine's model catalog lists this model once the generated config loads. */
export function engineListsModel(provider: OpencodeV2ProviderSpec, model: OpencodeV2ModelSpec): boolean {
  return passesModelFilters(provider, model) && !isDeprecatedModel(model);
}

/** The whole generated engine config: every writer emits all current keys. */
export function renderOpencodeV2Config(input: {
  providers: OpencodeV2ProviderSpec[];
  /** v1 `disabled_providers` equivalent; applied through the catalog filter plugin. */
  disabledProviderIds?: string[];
  permissions?: EnginePermissionRule[];
  skills: string[];
  gatewayQuotaPluginDirectory?: string;
  providerSyncPluginDirectory?: string;
  desktopSession?: string;
  /** Catalog-only rules survive removal of live-owned providers from config. */
  providerFilters?: OpencodeV2ProviderFilters;
  providerFiltersPluginDirectory?: string;
  /** Preserves OpenWork Cloud connection reports from Code Mode calls for the chat. */
  mcpResultsPluginDirectory?: string;
  mcpReadinessPluginDirectory?: string;
  /** Applies Settings › Show model reasoning to each agent request. */
  visibleReasoningPluginDirectory?: string;
  autoRoutePluginDirectory?: string;
  contextPluginDirectory?: string;
  contextTools?: { url: string; token: string; browser?: { url: string; token: string } };
  agentPermissionRules?: AgentPermissionRule[];
  organizationMcp?: OrganizationMcpServers;
  agentPermissionsPluginDirectory?: string;
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
        // An absent variants key lets the engine infer reasoning efforts even
        // when the provider explicitly says this model cannot reason.
        ...(isRecord(config.variants) || config.reasoning === false ? {
          variants: nativeModelVariants(config.variants, providerPackage),
        } : {}),
        ...(isRecord(config.headers) ? { headers: config.headers } : {}),
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
  const gatewayProviders = Object.fromEntries(enabledProviders.flatMap((provider) => {
    const base = gatewayBase(provider.id, provider.baseUrl);
    return base ? [[provider.id, base.href]] : [];
  }));
  const filters: Record<string, { whitelist?: string[]; blacklist?: string[] }> = Object.fromEntries(
    input.providers.filter(provider => provider.whitelist !== undefined || provider.blacklist !== undefined)
      .map(provider => [provider.id, { whitelist: provider.whitelist, blacklist: provider.blacklist }]),
  );
  Object.assign(filters, input.providerFilters);
  // v2 config has no `disabled_providers`. An empty whitelist removes every
  // model of a provider from the native catalog, built-in ones included, so a
  // disconnected OpenCode Zen disappears here too and returns once re-enabled.
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
    ...(input.mcpResultsPluginDirectory ? [{ package: pathToFileURL(input.mcpResultsPluginDirectory).href }] : []),
    ...(input.mcpReadinessPluginDirectory ? [{ package: pathToFileURL(input.mcpReadinessPluginDirectory).href }] : []),
    ...(input.visibleReasoningPluginDirectory ? [{ package: pathToFileURL(input.visibleReasoningPluginDirectory).href }] : []),
    // Smart Model Router (feature `autoRouter`): records which model the
    // gateway chose for each Smart reply. It only reads `openwork-auto`
    // responses, which exist only while a Smart Router applies to the member.
    ...(input.autoRoutePluginDirectory ? [{ package: pathToFileURL(input.autoRoutePluginDirectory).href }] : []),
    ...(input.agentPermissionRules?.length && input.agentPermissionsPluginDirectory ? [{
      package: pathToFileURL(input.agentPermissionsPluginDirectory).href,
      options: { rules: input.agentPermissionRules, organizationMcp: input.organizationMcp ?? {} },
    }] : []),
  ];
  // The engine applies the last matching rule, so the managed execution
  // denials come last: an agent permission exception never lifts them. The
  // engine allows unlisted actions, so the context tools' Drive writes and
  // Gmail and Outlook drafts are listed as ask: their bridge runs them only after the person allows it.
  const contextWrites = [DRIVE_UPLOAD_PERMISSION, "drive_pull_file", "drive_push_file", GMAIL_DRAFT_PERMISSION, OUTLOOK_DRAFT_PERMISSION];
  const permissions: EngineV2PermissionRule[] = [
    ...(input.contextTools && input.contextPluginDirectory ? contextWrites.map(action => ({ action, resource: "*", effect: "ask" as const })) : []),
    ...agentPermissionEngineV2Rules(input.agentPermissionRules ?? []), ...(input.permissions ?? []),
  ];
  return {
    $schema: "https://opencode.ai/config.json",
    providers: providerConfig,
    ...(plugins.length ? { plugins } : {}),
    ...(input.permissions || permissions.length ? { permissions } : {}),
    ...(input.skills.length ? { skills: [...input.skills] } : {}),
  };
}

// The engine needs OS paths and locale settings, not the server's provider,
// cloud, database, or control-plane credentials. Unknown keys stay private.
const ENGINE_INHERITED_ENV = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP",
  "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "CI",
  "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
  "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
];

/** Caller values win; on Windows each name matches any spelling (`Path`, `windir`) and is passed once. */
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
  const mcpResultsPluginDirectory = join(instanceRoot, "mcp-results-plugin");
  const mcpReadinessPluginDirectory = join(instanceRoot, "mcp-readiness-plugin");
  const visibleReasoningPluginDirectory = join(instanceRoot, "visible-reasoning-plugin");
  const autoRoutePluginDirectory = join(instanceRoot, "auto-route-plugin");
  const contextPluginDirectory = join(instanceRoot, "context-plugin");
  const agentPermissionsPluginDirectory = join(instanceRoot, "agent-permissions-plugin");
  const password = randomBytes(24).toString("base64url");
  const username = "opencode";
  let url = "";
  const providers = new Map<string, OpencodeV2ProviderSpec>();
  let skills: string[] = [...(options.skills ?? [])];
  let disabledProviderIds: string[] = [];
  let providerFilters: OpencodeV2ProviderFilters = {};
  let writes: Promise<void> = Promise.resolve();
  // Declared before the boot config write, which reads it when the member
  // already has stored agent permissions.
  let agentPermissionsPluginWritten = false;
  const opencodeModelsUrl = (options.env?.OPENCODE_MODELS_URL ?? process.env.OPENCODE_MODELS_URL)?.replace(/\/+$/, "");
  const inherited = inheritedEngineEnv(options.env);
  // A caller may deliberately provide a config file; never inherit the server's
  // OPENCODE_CONFIG or OPENCODE_PURE settings implicitly.
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
  if (options.contextTools) {
    await mkdir(contextPluginDirectory, { recursive: true, mode: 0o700 });
    await writeFile(join(contextPluginDirectory, "package.json"), JSON.stringify({ type: "module" }), { mode: 0o600 });
    await writeFile(join(contextPluginDirectory, "server.js"),
      `export { default } from ${JSON.stringify(pathToFileURL(openworkContextV2PluginPath()).href)};\n`, { mode: 0o600 });
  }
  // Replace the generated config before boot, removing stale managed-policy
  // registrations while retaining independent engine permissions. Leave the
  // old entrypoint on disk: another configuration may still reference it.
  // Cloud skills use Connect on demand, just like v1. No generated Cloud
  // skill directory is registered with the native engine.
  await writeConfig();
  const historyLease = await acquireEngineHistoryLease(options.rootDir);
  const child = spawn(options.bin, ["serve", "--hostname", hostname, "--port", String(port)], {
    env: {
      ...inherited,
      ...(options.env?.OPENCODE_DISABLE_MODELS_FETCH ? { OPENCODE_DISABLE_MODELS_FETCH: options.env.OPENCODE_DISABLE_MODELS_FETCH } : {}),
      ...(options.providerSession ? { OPENWORK_PROVIDER_SESSION_FD: "3", OPENWORK_PROVIDER_SESSION_BROKER: providerCredentialBrokerPath } : {}),
      OPENCODE_PASSWORD: password,
      OPENCODE_DB: join(options.rootDir, "opencode.db"),
      OPENCODE_CONFIG_DIR: configDir,
      ...(opencodeModelsUrl === undefined ? {} : { OPENCODE_MODELS_URL: opencodeModelsUrl }),
    },
    stdio: ["ignore", "pipe", "pipe", options.providerSession ? "pipe" : "ignore"],
  });
  if (options.providerSession) {
    const channel = child.stdio[3];
    if (!channel || !("end" in channel)) {
      child.kill();
      await historyLease.release();
      throw new Error("OpenCode v2 credential channel unavailable");
    }
    // A private, anonymous pipe: no named socket, file, argument, or environment
    // contains this credential. The trusted plugin consumes and closes it before
    // setup and retains it only in its module closure.
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
  // A close event, unlike exit, includes the final bytes from both pipes.
  let closed = false;
  let ready = false;
  let closing = false;
  child.once("close", (code, signal) => {
    closed = true;
    lines.stop();
    void historyLease.release();
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
  try { await historyLease.child(child.pid); }
  catch (error) { child.kill(); await historyLease.release(); throw error; }

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

  // Every rewrite (providers, permissions, skills) serializes through one
  // queue and emits the whole current state, so no writer drops another's keys.
  function writeConfig(): Promise<void> {
    const next = writes.catch(() => undefined).then(writeConfigNow);
    writes = next;
    return next;
  }

  // The agent permissions plugin is written and loaded only for a member who
  // has agent permissions; everyone else's engine config stays as it was.
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
      mcpResultsPluginDirectory,
      mcpReadinessPluginDirectory,
      visibleReasoningPluginDirectory,
      autoRoutePluginDirectory,
      contextPluginDirectory,
      contextTools: options.contextTools,
      ...(options.permissions ? { permissions: await options.permissions() } : {}),
      ...(options.agentPermissions ? await agentPermissionsConfig(options.agentPermissions) : {}),
      skills,
    }), null, 2)}\n`;
    // The engine watches this file and reloads its model catalog on every
    // change; an identical rewrite would only open a window where models are
    // briefly unavailable.
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
      // Failed spawns have no process and may never emit `exit` (only `close`).
      await historyLease.release();
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
    await historyLease.release();
  }

  const managed: ManagedOpencodeV2Server = {
    get url() { return url; },
    username,
    password,
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
    // Only the child can write its stdout pipe. Do not send the generated
    // credential to a probed port before that child confirms it has bound.
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
      // The engine can return 503 or refuse connections while booting.
    }
    await sleep(250);
  }

  const exited = child.exitCode !== null || child.signalCode !== null;
  await close();
  if (exited) throw diagnostics(child.exitCode, stdout, stderr);
  throw new Error(`Timed out waiting ${bootTimeoutMs}ms for OpenCode v2 health\nstdout:\n${stdout.slice(-4_000)}\nstderr:\n${stderr.slice(-4_000)}`);
}
