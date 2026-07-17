import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { minimatch } from "minimatch";
import type { McpItem, ServerConfig } from "./types.js";
import { sanitizeDiagnosticString } from "./diagnostic-sanitizer.js";
import { readJsoncFile } from "./jsonc.js";
import { opencodeConfigPath } from "./workspace-files.js";
import { validateMcpConfig, validateMcpName } from "./validators.js";
import {
  readRuntimeOpencodeConfig,
  runtimeMcpMap,
  writeRuntimeOpencodeConfig,
  type RuntimeOpencodeConfig,
} from "./runtime-opencode-config-store.js";

export type McpToolDenySource = "config.project" | "config.global";

export type McpToolDeny = {
  source: McpToolDenySource;
  style: "tools.deny" | "tools" | "permission" | "permissions";
  pattern: string;
  matched: string;
};

type McpToolAllow = McpToolDeny;

const OPENWORK_CLOUD_DIAGNOSTIC_TOOL_IDS = [
  "openwork-cloud_search_capabilities",
  "openwork-cloud_execute_capability",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const FORBIDDEN_CONFIG_ROOT_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const MAX_CONFIG_ROOT_LENGTH = 4_096;
const DIAGNOSTIC_STATIC_CONFIG_MAX_BYTES = 1024 * 1024;

export function resolveGlobalOpenCodeConfigPath(input?: {
  opencodeConfigDir?: string;
  xdgConfigHome?: string;
  homeDir?: string;
}): string {
  const configuredDirectory = input?.opencodeConfigDir ?? process.env.OPENCODE_CONFIG_DIR;
  const safeConfiguredDirectory = typeof configuredDirectory === "string"
    && configuredDirectory.length > 0
    && configuredDirectory.length <= MAX_CONFIG_ROOT_LENGTH
    && isAbsolute(configuredDirectory)
    && !FORBIDDEN_CONFIG_ROOT_CHARS.test(configuredDirectory)
    ? configuredDirectory
    : null;
  const configuredRoot = input?.xdgConfigHome ?? process.env.XDG_CONFIG_HOME;
  const configRoot = typeof configuredRoot === "string"
    && configuredRoot.length > 0
    && configuredRoot.length <= MAX_CONFIG_ROOT_LENGTH
    && isAbsolute(configuredRoot)
    && !FORBIDDEN_CONFIG_ROOT_CHARS.test(configuredRoot)
    ? configuredRoot
    : join(input?.homeDir ?? homedir(), ".config");
  // OpenCode accepts OPENCODE_CONFIG_DIR as the directory containing its
  // opencode.json(c) files. It is not an XDG parent directory.
  const base = safeConfiguredDirectory ?? join(configRoot, "opencode");
  const jsonc = join(base, "opencode.jsonc");
  const json = join(base, "opencode.json");
  if (existsSync(jsonc)) return jsonc;
  if (existsSync(json)) return json;
  return jsonc; // fall back to jsonc (readJsoncFile handles missing files gracefully)
}

function getMcpConfig(config: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const mcp = config.mcp;
  if (!isRecord(mcp)) return {};
  const output: Record<string, Record<string, unknown>> = {};
  for (const [name, value] of Object.entries(mcp)) {
    if (isRecord(value)) output[name] = value;
  }
  return output;
}

function getDeniedToolPatterns(config: Record<string, unknown>): string[] {
  const tools = config.tools;
  if (!isRecord(tools)) return [];
  const deny = tools.deny;
  if (!Array.isArray(deny)) return [];
  return deny.filter((item): item is string => typeof item === "string");
}

function getToolIdsForDiagnostics(name: string, toolIds: string[]): string[] {
  if (toolIds.length > 0) return toolIds;
  return [name];
}

function diagnosticToolIdsForMcp(name: string): string[] {
  return name === "openwork-cloud" ? OPENWORK_CLOUD_DIAGNOSTIC_TOOL_IDS : [];
}

function permissionCandidates(name: string, toolId: string): string[] {
  const candidates = new Set([toolId, `tool.${toolId}`, `tool:${toolId}`, `mcp.${name}`, `mcp.${name}.*`, `mcp:${name}`, `mcp:${name}:*`, "mcp.*", "mcp:*"]);
  const prefix = `${name}_`;
  if (toolId.startsWith(prefix)) {
    const suffix = toolId.slice(prefix.length);
    candidates.add(`mcp.${name}.${suffix}`);
    candidates.add(`mcp:${name}:${suffix}`);
  }
  return Array.from(candidates);
}

function matchesToolPattern(name: string, toolId: string, pattern: string): boolean {
  for (const candidate of permissionCandidates(name, toolId)) {
    if (candidate === pattern || minimatch(candidate, pattern)) return true;
  }
  return false;
}

function deniesValue(value: unknown): boolean {
  if (value === false || value === "deny") return true;
  if (!isRecord(value)) return false;
  return value.enabled === false || value.action === "deny" || value.effect === "deny" || value.permission === "deny";
}

function allowsValue(value: unknown): boolean {
  if (value === true || value === "allow") return true;
  if (!isRecord(value)) return false;
  return value.enabled === true || value.action === "allow" || value.effect === "allow" || value.permission === "allow";
}

function pushDeny(
  denies: McpToolDeny[],
  source: McpToolDenySource,
  style: McpToolDeny["style"],
  pattern: string,
  matched: string,
): void {
  denies.push({
    source,
    style,
    pattern: sanitizeDiagnosticString(pattern),
    matched: sanitizeDiagnosticString(matched),
  });
}

function collectToolsDenyArray(
  config: Record<string, unknown>,
  source: McpToolDenySource,
  name: string,
  toolIds: string[],
): McpToolDeny[] {
  const denies: McpToolDeny[] = [];
  for (const pattern of getDeniedToolPatterns(config)) {
    for (const toolId of toolIds) {
      if (matchesToolPattern(name, toolId, pattern)) pushDeny(denies, source, "tools.deny", pattern, toolId);
    }
  }
  return denies;
}

function collectToolsRecordDenies(
  config: Record<string, unknown>,
  source: McpToolDenySource,
  name: string,
  toolIds: string[],
  mode: "deny" | "allow",
): McpToolDeny[] {
  const tools = config.tools;
  if (!isRecord(tools)) return [];
  const denies: McpToolDeny[] = [];
  for (const [pattern, value] of Object.entries(tools)) {
    if (pattern === "deny") continue;
    const matchesMode = mode === "deny" ? deniesValue(value) : allowsValue(value);
    if (!matchesMode) continue;
    for (const toolId of toolIds) {
      if (matchesToolPattern(name, toolId, pattern)) pushDeny(denies, source, "tools", pattern, toolId);
    }
  }
  return denies;
}

function collectPermissionRulesetDenies(
  value: unknown,
  source: McpToolDenySource,
  style: "permission" | "permissions",
  name: string,
  toolIds: string[],
  mode: "deny" | "allow",
): McpToolDeny[] {
  if (!Array.isArray(value)) return [];
  const denies: McpToolDeny[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const action = typeof entry.action === "string" ? entry.action : typeof entry.effect === "string" ? entry.effect : "";
    if (action !== mode) continue;
    const pattern = typeof entry.pattern === "string"
      ? entry.pattern
      : typeof entry.permission === "string"
        ? entry.permission
        : "";
    if (!pattern) continue;
    for (const toolId of toolIds) {
      if (matchesToolPattern(name, toolId, pattern)) pushDeny(denies, source, style, pattern, toolId);
    }
  }
  return denies;
}

function collectPermissionScalarDeny(
  value: unknown,
  source: McpToolDenySource,
  style: "permission" | "permissions",
  toolIds: string[],
  mode: "deny" | "allow",
): McpToolDeny[] {
  const matchesMode = mode === "deny" ? deniesValue(value) : allowsValue(value);
  if (!matchesMode) return [];
  const denies: McpToolDeny[] = [];
  for (const toolId of toolIds) pushDeny(denies, source, style, "*", toolId);
  return denies;
}

function collectPermissionObjectDenies(
  value: unknown,
  source: McpToolDenySource,
  style: "permission" | "permissions",
  name: string,
  toolIds: string[],
  mode: "deny" | "allow",
): McpToolDeny[] {
  if (!isRecord(value)) return [];
  const denies: McpToolDeny[] = [];
  for (const [key, nested] of Object.entries(value)) {
    const matchesMode = mode === "deny" ? deniesValue(nested) : allowsValue(nested);
    if (matchesMode) {
      for (const toolId of toolIds) {
        if (matchesToolPattern(name, toolId, key)) pushDeny(denies, source, style, key, toolId);
      }
      continue;
    }
    if (key === "tool" || key === "tools") {
      const nestedMatchesMode = mode === "deny" ? deniesValue(nested) : allowsValue(nested);
      if (nestedMatchesMode) {
        for (const toolId of toolIds) pushDeny(denies, source, style, key, toolId);
        continue;
      }
      for (const [pattern, permission] of Object.entries(isRecord(nested) ? nested : {})) {
        const nestedPermissionMatchesMode = mode === "deny" ? deniesValue(permission) : allowsValue(permission);
        if (!nestedPermissionMatchesMode) continue;
        for (const toolId of toolIds) {
          if (matchesToolPattern(name, toolId, pattern)) pushDeny(denies, source, style, pattern, toolId);
        }
      }
    }
  }
  return denies;
}

function uniqueDenies(denies: McpToolDeny[]): McpToolDeny[] {
  const seen = new Set<string>();
  const unique: McpToolDeny[] = [];
  for (const deny of denies) {
    const key = `${deny.source}\0${deny.style}\0${deny.pattern}\0${deny.matched}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(deny);
  }
  return unique;
}

function collectMcpToolMatchesFromConfig(
  config: Record<string, unknown>,
  source: McpToolDenySource,
  name: string,
  toolIds: string[],
  mode: "deny" | "allow",
): McpToolDeny[] {
  const diagnosticToolIds = getToolIdsForDiagnostics(name, toolIds);
  return uniqueDenies([
    ...(mode === "deny" ? collectToolsDenyArray(config, source, name, diagnosticToolIds) : []),
    ...collectToolsRecordDenies(config, source, name, diagnosticToolIds, mode),
    ...collectPermissionScalarDeny(config.permission, source, "permission", diagnosticToolIds, mode),
    ...collectPermissionRulesetDenies(config.permission, source, "permission", name, diagnosticToolIds, mode),
    ...collectPermissionObjectDenies(config.permission, source, "permission", name, diagnosticToolIds, mode),
    ...collectPermissionScalarDeny(config.permissions, source, "permissions", diagnosticToolIds, mode),
    ...collectPermissionRulesetDenies(config.permissions, source, "permissions", name, diagnosticToolIds, mode),
    ...collectPermissionObjectDenies(config.permissions, source, "permissions", name, diagnosticToolIds, mode),
  ]);
}

function diagnoseMcpToolDeniesFromConfig(
  config: Record<string, unknown>,
  source: McpToolDenySource,
  name: string,
  toolIds: string[],
): McpToolDeny[] {
  return collectMcpToolMatchesFromConfig(config, source, name, toolIds, "deny");
}

function collectProjectAllows(
  config: Record<string, unknown>,
  name: string,
  toolIds: string[],
): McpToolAllow[] {
  return collectMcpToolMatchesFromConfig(config, "config.project", name, toolIds, "allow");
}

function projectAllowOverridesGlobalDeny(allow: McpToolAllow, deny: McpToolDeny): boolean {
  return allow.matched === deny.matched || minimatch(deny.matched, allow.pattern);
}

function filterGlobalDeniesOverriddenByProjectAllows(globalDenies: McpToolDeny[], projectAllows: McpToolAllow[]): McpToolDeny[] {
  return globalDenies.filter((deny) => !projectAllows.some((allow) => projectAllowOverridesGlobalDeny(allow, deny)));
}

export function diagnoseMcpToolDeniesFromConfigs(input: {
  projectConfig: Record<string, unknown>;
  globalConfig: Record<string, unknown>;
  name: string;
  toolIds?: string[];
}): McpToolDeny[] {
  const toolIds = input.toolIds ?? diagnosticToolIdsForMcp(input.name);
  const projectAllows = collectProjectAllows(input.projectConfig, input.name, toolIds);
  const projectDenies = diagnoseMcpToolDeniesFromConfig(input.projectConfig, "config.project", input.name, toolIds);
  const globalDenies = diagnoseMcpToolDeniesFromConfig(input.globalConfig, "config.global", input.name, toolIds);
  return uniqueDenies([
    ...projectDenies,
    ...filterGlobalDeniesOverriddenByProjectAllows(globalDenies, projectAllows),
  ]);
}

export async function diagnoseMcpToolDenies(
  workspaceRoot: string,
  name: string,
  toolIds?: string[],
): Promise<McpToolDeny[]> {
  const { data: config } = await readJsoncFile(opencodeConfigPath(workspaceRoot), {} as Record<string, unknown>, { allowInvalid: true });
  const { data: globalConfig } = await readJsoncFile(resolveGlobalOpenCodeConfigPath(), {} as Record<string, unknown>, { allowInvalid: true });
  return diagnoseMcpToolDeniesFromConfigs({ projectConfig: config, globalConfig, name, toolIds });
}

function hasInvalidMcpConfig(config: Record<string, unknown>): boolean {
  if (!Object.hasOwn(config, "mcp")) return false;
  if (!isRecord(config.mcp)) return true;
  return Object.values(config.mcp).some((entry) => !isRecord(entry));
}

type ToolPolicyAction = "allow" | "ask" | "deny";
type ToolPolicyRule = ToolPolicyAction | Record<string, ToolPolicyAction>;
type ToolPolicyMap = Record<string, ToolPolicyRule>;

const TOOL_POLICY_ACTIONS = new Set<ToolPolicyAction>(["allow", "ask", "deny"]);

function isToolPolicyAction(value: unknown): value is ToolPolicyAction {
  return typeof value === "string" && TOOL_POLICY_ACTIONS.has(value as ToolPolicyAction);
}

function isToolPolicyRule(value: unknown): value is ToolPolicyRule {
  if (isToolPolicyAction(value)) return true;
  return isRecord(value) && Object.values(value).every(isToolPolicyAction);
}

function isToolPolicyMap(value: unknown): value is ToolPolicyMap {
  return isRecord(value) && Object.values(value).every(isToolPolicyRule);
}

function isLegacyToolMap(value: unknown): value is Record<string, boolean> {
  return isRecord(value) && Object.values(value).every((enabled) => typeof enabled === "boolean");
}

function hasInvalidAgentToolPolicy(container: unknown): boolean {
  if (container === undefined) return false;
  if (!isRecord(container)) return true;
  return Object.values(container).some((agent) => {
    if (!isRecord(agent)) return true;
    if (agent.permission !== undefined
      && !isToolPolicyAction(agent.permission)
      && !isToolPolicyMap(agent.permission)) return true;
    return agent.tools !== undefined && !isLegacyToolMap(agent.tools);
  });
}

function hasInvalidToolPolicyConfig(config: Record<string, unknown>): boolean {
  if (config.permission !== undefined
    && !isToolPolicyAction(config.permission)
    && !isToolPolicyMap(config.permission)) return true;
  if (config.tools !== undefined && !isLegacyToolMap(config.tools)) return true;
  return hasInvalidAgentToolPolicy(config.agent)
    || hasInvalidAgentToolPolicy(config.mode);
}

function normalizeToolPolicy(value: unknown): ToolPolicyMap {
  if (isToolPolicyAction(value)) return { "*": value };
  return isToolPolicyMap(value) ? value : {};
}

function toolPolicyFromLegacyTools(value: unknown): ToolPolicyMap {
  if (!isLegacyToolMap(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([tool, enabled]) => [tool, enabled ? "allow" : "deny"]),
  );
}

function mergeToolPolicy(target: ToolPolicyMap, source: ToolPolicyMap): ToolPolicyMap {
  const merged: ToolPolicyMap = { ...target };
  for (const [action, rule] of Object.entries(source)) {
    const current = merged[action];
    merged[action] = isRecord(current) && isRecord(rule)
      ? { ...current, ...rule }
      : rule;
  }
  return merged;
}

function configuredToolPolicy(config: Record<string, unknown>): ToolPolicyMap {
  return mergeToolPolicy(toolPolicyFromLegacyTools(config.tools), normalizeToolPolicy(config.permission));
}

function policyForAgentContainer(
  config: Record<string, unknown>,
  containerName: "agent" | "mode",
  agentName: string,
): ToolPolicyMap {
  const container = config[containerName];
  if (!isRecord(container) || !isRecord(container[agentName])) return {};
  const agent = container[agentName];
  return mergeToolPolicy(toolPolicyFromLegacyTools(agent.tools), normalizeToolPolicy(agent.permission));
}

function mergeConfiguredPolicies(
  configs: Record<string, unknown>[],
  select: (config: Record<string, unknown>) => ToolPolicyMap,
): ToolPolicyMap {
  return configs.reduce<ToolPolicyMap>(
    (policy, config) => mergeToolPolicy(policy, select(config)),
    {},
  );
}

function openCodeWildcardMatch(input: string, pattern: string): boolean {
  const normalized = input.replaceAll("\\", "/");
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?";
  return new RegExp("^" + escaped + "$", process.platform === "win32" ? "si" : "s").test(normalized);
}

function toolPolicyRules(policy: ToolPolicyMap): Array<{
  permission: string;
  pattern: string;
  action: ToolPolicyAction;
}> {
  return Object.entries(policy).flatMap(([permission, rule]) => {
    if (isToolPolicyAction(rule)) return [{ permission, pattern: "*", action: rule }];
    return Object.entries(rule).map(([pattern, action]) => ({ permission, pattern, action }));
  });
}

function deniedToolIds(
  configs: Record<string, unknown>[],
  agentName: string,
  toolIds: string[],
): string[] {
  // OpenCode merges the deprecated top-level `tools` map and the current
  // `permission` map independently, then applies every permission key after
  // every tools key. A project `tools: { x: true }` therefore cannot undo a
  // global `permission: { x: "deny" }`.
  const topLevel = mergeToolPolicy(
    mergeConfiguredPolicies(configs, (config) => toolPolicyFromLegacyTools(config.tools)),
    mergeConfiguredPolicies(configs, (config) => normalizeToolPolicy(config.permission)),
  );
  // Deprecated `mode.<name>` is folded into `agent.<name>` only after all
  // ordinary agent layers have merged, so mode policy remains the later set.
  const agent = mergeToolPolicy(
    mergeConfiguredPolicies(configs, (config) => policyForAgentContainer(config, "agent", agentName)),
    mergeConfiguredPolicies(configs, (config) => policyForAgentContainer(config, "mode", agentName)),
  );
  const rules = [...toolPolicyRules(topLevel), ...toolPolicyRules(agent)];
  return toolIds.filter((toolId) => {
    const decision = rules.slice().reverse().find((rule) => (
      openCodeWildcardMatch(toolId, rule.permission)
      // OpenCode only removes a tool when the winning rule applies to the
      // entire tool resource. Resource-specific rules are enforced at call
      // time and do not hide the tool from the catalog.
      && rule.pattern === "*"
    ));
    return decision?.action === "deny";
  });
}

function isMcpDisabledByTools(config: Record<string, unknown>, name: string): boolean {
  const sanitizedName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  return deniedToolIds([config], "", [`${sanitizedName}___openwork_mcp_probe__`]).length > 0;
}

export async function listMcp(serverConfig: ServerConfig, workspaceId: string, workspaceRoot: string): Promise<McpItem[]> {
  return listMcpFromRuntimeSnapshot(workspaceRoot, await readRuntimeOpencodeConfig(serverConfig, workspaceId));
}

export type McpConfigCollision = {
  name: string;
  sources: McpItem["source"][];
};

export type McpInventoryInspection = {
  items: McpItem[];
  collisions: McpConfigCollision[];
  layerStatus: {
    project: "available" | "missing" | "invalid" | "unreadable";
    global: "available" | "missing" | "invalid" | "unreadable";
  };
  toolPolicy: {
    scope: "passive-static-subset";
    status: "available" | "unavailable";
    inspectedToolIds: string[];
    deniedToolIds: string[];
  };
};

async function inspectMcpConfigLayer(
  path: string,
  options: { maxBytes: number; signal?: AbortSignal },
): Promise<{
  data: Record<string, unknown>;
  status: "available" | "missing" | "invalid" | "unreadable";
}> {
  try {
    const result = await readJsoncFile(path, {} as Record<string, unknown>, {
      allowInvalid: true,
      maxBytes: options.maxBytes,
      regularFileOnly: true,
      signal: options.signal,
    });
    return {
      data: result.data,
      status: result.invalid
        || hasInvalidMcpConfig(result.data)
        || hasInvalidToolPolicyConfig(result.data)
        ? "invalid"
        : result.missing
          ? "missing"
          : "available",
    };
  } catch {
    options.signal?.throwIfAborted();
    return { data: {}, status: "unreadable" };
  }
}

export async function listMcpFromRuntimeSnapshot(
  workspaceRoot: string,
  runtimeConfig: RuntimeOpencodeConfig,
): Promise<McpItem[]> {
  const { data: config } = await readJsoncFile(opencodeConfigPath(workspaceRoot), {} as Record<string, unknown>, { allowInvalid: true });
  const { data: globalConfig } = await readJsoncFile(resolveGlobalOpenCodeConfigPath(), {} as Record<string, unknown>, { allowInvalid: true });

  const projectMcpMap = getMcpConfig(config);
  const globalMcpMap = getMcpConfig(globalConfig);
  const runtimeMap = runtimeMcpMap(runtimeConfig);

  const items: McpItem[] = [];

  // Preserve production behavior: runtime MCPs are dynamically POSTed to
  // OpenCode and can supersede static project/global entries after startup.
  for (const [name, entry] of Object.entries(globalMcpMap)) {
    if (Object.prototype.hasOwnProperty.call(projectMcpMap, name)) continue;
    const toolDenies = diagnoseMcpToolDeniesFromConfigs({ projectConfig: config, globalConfig, name });
    items.push({
      name,
      config: entry,
      source: "config.global",
      disabledByTools: toolDenies.length > 0 || undefined,
      ...(toolDenies.length ? { toolDenies } : {}),
    });
  }

  for (const [name, entry] of Object.entries(projectMcpMap)) {
    if (Object.prototype.hasOwnProperty.call(runtimeMap, name)) continue;
    const toolDenies = diagnoseMcpToolDeniesFromConfigs({ projectConfig: config, globalConfig, name });
    items.push({
      name,
      config: entry,
      source: "config.project",
      disabledByTools: toolDenies.length > 0 || undefined,
      ...(toolDenies.length ? { toolDenies } : {}),
    });
  }

  for (const [name, entry] of Object.entries(runtimeMap)) {
    const toolDenies = diagnoseMcpToolDeniesFromConfigs({ projectConfig: config, globalConfig, name });
    items.push({
      name,
      config: entry,
      source: "config.remote",
      disabledByTools: toolDenies.length > 0 || undefined,
      ...(toolDenies.length ? { toolDenies } : {}),
    });
  }

  return items;
}

/**
 * Diagnostics-only passive inventory. It returns every configured layer and
 * collision metadata without claiming which entry is effective: OpenCode's
 * static config merge and OpenWork's later dynamic MCP registration can make
 * that answer lifecycle-dependent, and observing it would wake a cold engine.
 */
export async function inspectMcpLayersFromRuntimeSnapshot(
  workspaceRoot: string,
  runtimeConfig: RuntimeOpencodeConfig,
  options?: {
    globalConfigPath?: string;
    maxConfigBytes?: number;
    signal?: AbortSignal;
    toolPolicy?: { agentName: string; mcpName: string; toolIds: string[] };
  },
): Promise<McpInventoryInspection> {
  const policyQuery = options?.toolPolicy;
  const layerReadOptions = {
    maxBytes: options?.maxConfigBytes ?? DIAGNOSTIC_STATIC_CONFIG_MAX_BYTES,
    signal: options?.signal,
  };
  const [projectLayer, globalLayer] = await Promise.all([
    inspectMcpConfigLayer(opencodeConfigPath(workspaceRoot), layerReadOptions),
    inspectMcpConfigLayer(
      options?.globalConfigPath ?? resolveGlobalOpenCodeConfigPath(),
      layerReadOptions,
    ),
  ]);
  options?.signal?.throwIfAborted();
  const projectConfig = projectLayer.data;
  const globalConfig = globalLayer.data;
  const maps: Array<{ source: McpItem["source"]; values: Record<string, Record<string, unknown>> }> = [
    { source: "config.global", values: getMcpConfig(globalConfig) },
    { source: "config.remote", values: runtimeMcpMap(runtimeConfig) },
    { source: "config.project", values: getMcpConfig(projectConfig) },
  ];
  const items: McpItem[] = [];
  const sourcesByName = new Map<string, McpItem["source"][]>();
  const policyUnavailable = projectLayer.status === "invalid"
    || projectLayer.status === "unreadable"
    || globalLayer.status === "invalid"
    || globalLayer.status === "unreadable";
  const inspectedToolIds = policyQuery ? [...new Set(policyQuery.toolIds)] : [];
  const policyDeniedToolIds = policyQuery && !policyUnavailable
    ? deniedToolIds([globalConfig, projectConfig], policyQuery.agentName, inspectedToolIds)
    : [];
  for (const layer of maps) {
    for (const [name, entry] of Object.entries(layer.values)) {
      const sources = sourcesByName.get(name) ?? [];
      sources.push(layer.source);
      sourcesByName.set(name, sources);
      items.push({
        name,
        config: entry,
        source: layer.source,
        disabledByTools: policyQuery && name === policyQuery.mcpName
          ? policyDeniedToolIds.length > 0 || undefined
          : (isMcpDisabledByTools(projectConfig, name)
            || isMcpDisabledByTools(globalConfig, name))
            || undefined,
      });
    }
  }
  return {
    items,
    layerStatus: { project: projectLayer.status, global: globalLayer.status },
    toolPolicy: {
      scope: "passive-static-subset",
      status: policyQuery && !policyUnavailable ? "available" : "unavailable",
      inspectedToolIds,
      deniedToolIds: policyDeniedToolIds,
    },
    collisions: [...sourcesByName.entries()]
      .filter(([, sources]) => sources.length > 1)
      .map(([name, sources]) => ({ name, sources })),
  };
}

export async function addMcp(
  serverConfig: ServerConfig,
  workspaceId: string,
  name: string,
  config: Record<string, unknown>,
): Promise<{ action: "added" | "updated" }> {
  validateMcpName(name);
  validateMcpConfig(config);
  const runtimeConfig = await readRuntimeOpencodeConfig(serverConfig, workspaceId);
  const mcpMap = { ...runtimeMcpMap(runtimeConfig) };
  const existed = Object.prototype.hasOwnProperty.call(mcpMap, name);
  mcpMap[name] = config;
  await writeRuntimeOpencodeConfig(serverConfig, workspaceId, (current) => ({ ...current, mcp: mcpMap }));
  return { action: existed ? "updated" : "added" };
}

export async function removeMcp(serverConfig: ServerConfig, workspaceId: string, name: string): Promise<boolean> {
  const runtimeConfig = await readRuntimeOpencodeConfig(serverConfig, workspaceId);
  const mcpMap = { ...runtimeMcpMap(runtimeConfig) };
  if (!Object.prototype.hasOwnProperty.call(mcpMap, name)) return false;
  delete mcpMap[name];
  await writeRuntimeOpencodeConfig(serverConfig, workspaceId, (current) => ({ ...current, mcp: mcpMap }));
  return true;
}

// Flips `enabled` on a workspace MCP entry. Returns false for "toggle does
// not apply": missing, non-object, or malformed enough that OpenCode would
// fail to load it. The HTTP layer maps false to 404. Globals are out of
// scope by design — only workspace-level entries.
//
// `updateJsoncPath` (vs `updateJsoncTopLevel`) preserves inline comments
// inside the MCP entry — see the regression that motivated #1444.
export async function setMcpEnabled(
  serverConfig: ServerConfig,
  workspaceId: string,
  name: string,
  enabled: boolean,
): Promise<boolean> {
  validateMcpName(name);
  const runtimeConfig = await readRuntimeOpencodeConfig(serverConfig, workspaceId);
  const mcpMap = { ...runtimeMcpMap(runtimeConfig) };
  if (!Object.prototype.hasOwnProperty.call(mcpMap, name)) return false;
  const current = mcpMap[name];
  if (!current || typeof current !== "object" || Array.isArray(current)) return false;
  try {
    validateMcpConfig({ ...(current as Record<string, unknown>), enabled });
  } catch {
    return false;
  }
  mcpMap[name] = { ...(current as Record<string, unknown>), enabled };
  await writeRuntimeOpencodeConfig(serverConfig, workspaceId, (currentConfig) => ({ ...currentConfig, mcp: mcpMap }));
  return true;
}
