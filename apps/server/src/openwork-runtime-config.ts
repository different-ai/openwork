import { legacyExecutionPermissions } from "./managed-policy-rules.js";
import { DESKTOP_POLICY_ENFORCEMENT_ENABLED, LOCAL_MODEL_PROVIDER_IDS, desktopCapabilityConfig } from "@openwork/types/den/desktop-policies-runtime";
import { materializeLegacyFastProviders } from "@openwork/types/cloud-model-fast";
import { isManagedPolicyPlugin } from "./managed-policy-plugin.js";
import { isLegacyBrowserPlugin } from "./workspace-init.js";
import { ORGANIZATION_PROVIDER_ID, organizationAllowlistsProviders, organizationProviderGate } from "./organization-provider-gate.js";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  openworkExtensionsPreviewPluginPath,
  openworkCapabilitiesKnowledgePluginPath,
  openworkAnthropicAdaptiveThinkingPluginPath,
  openworkAnthropicToolSchemaPluginPath,
  openworkTitleRecoveryPluginPath,
  openworkGatewayQuotaPluginPath,
  openworkOfficeAttachmentsPluginPath,
  openworkSpreadsheetsPluginPath,
  openworkChromeDevtoolsPluginPath,
  openworkComputerUsePluginPath,
  openworkPdfAttachmentsPluginPath,
} from "./openwork-extensions-plugin-path.js";
import type { ServerConfig } from "./types.js";
import { runtimeStorageDir } from "./runtime-db.js";
import {
  onRuntimeOpencodeConfigWrite,
  isEngineGlobalRuntimeConfigId,
  readGlobalRuntimeOpencodeConfig,
  runtimeDisabledProviderList,
  runtimeMcpMap,
  runtimeProviderMap,
  runtimePluginList,
  type RuntimeOpencodeConfig,
} from "./runtime-opencode-config-store.js";
import { CONNECT_MCP_SERVER_NAME_PREFIX } from "./connect-mcp-server-catalog.js";
import { appendOrganizationPrompts, OPENWORK_AGENT_PROMPT } from "./openwork-agent-prompt.js";

export async function buildOpenworkRuntimeConfigObject(
  config?: ServerConfig,
): Promise<Record<string, unknown>> {
  const runtimeConfig = config ? await readGlobalRuntimeOpencodeConfig(config) : {};
  return buildOpenworkRuntimeConfigObjectFromSnapshot(runtimeConfig);
}

export function buildOpenworkRuntimeConfigObjectFromSnapshot(
  runtimeConfig: RuntimeOpencodeConfig,
): Record<string, unknown> {
  if (!DESKTOP_POLICY_ENFORCEMENT_ENABLED) {
    const { managedPolicy, ...localConfig } = runtimeConfig;
    runtimeConfig = managedPolicy ? { ...localConfig, managedPolicy: desktopCapabilityConfig(managedPolicy) } : localConfig;
  }
  const disabledProviders = runtimeDisabledProviderList(runtimeConfig);
  const permissions = legacyExecutionPermissions(runtimeConfig.managedPolicy?.execution);
  const { managedPolicy: _managedPolicy, managedPrompt, ...engineConfig } = runtimeConfig;
  const provider = materializeLegacyFastProviders(runtimeProviderMap(runtimeConfig));
  const allowsProvider = organizationProviderGate(runtimeConfig.managedPolicy);
  const allowlist = allowsProvider && organizationAllowlistsProviders(runtimeConfig.managedPolicy);
  const blockedLocal = allowsProvider && !allowlist ? LOCAL_MODEL_PROVIDER_IDS.filter((id) => !allowsProvider(id)) : [];
  return {
    ...engineConfig,
    ...(allowlist ? { enabled_providers: [
      ...Object.keys(provider).filter((id) => ORGANIZATION_PROVIDER_ID.test(id)),
      ...(allowsProvider("opencode") ? ["opencode"] : []),
      ...LOCAL_MODEL_PROVIDER_IDS.filter((id) => allowsProvider(id)),
    ] } : {}),
    permission: { ...engineConfig.permission, ...permissions },
    default_agent: runtimeConfig.default_agent ?? "openwork",
    agent: {
      openwork: {
        description: "OpenWork default agent",
        mode: "primary",
        temperature: 0.2,
        prompt: appendOrganizationPrompts(OPENWORK_AGENT_PROMPT, managedPrompt),
        permission: {
          ...permissions,
          skill: {
            "customize-opencode": "deny",
            "get-started": "deny",
            "command-creator": "deny",
            "agent-creator": "deny",
            "plugin-creator": "deny",
          },
        },
      },
    },
    plugin: [
      openworkChromeDevtoolsPluginPath(),
      openworkComputerUsePluginPath(),
      openworkCapabilitiesKnowledgePluginPath(),
      openworkExtensionsPreviewPluginPath(),
      openworkOfficeAttachmentsPluginPath(),
      openworkSpreadsheetsPluginPath(),
      openworkPdfAttachmentsPluginPath(),
      openworkAnthropicAdaptiveThinkingPluginPath(),
      openworkAnthropicToolSchemaPluginPath(),
      openworkTitleRecoveryPluginPath(),
      openworkGatewayQuotaPluginPath(),
      ...runtimePluginList(runtimeConfig).filter((plugin) => !isManagedPolicyPlugin(plugin) && !isLegacyBrowserPlugin(plugin)),
    ],
    ...(disabledProviders.length || blockedLocal.length ? { disabled_providers: [...new Set([...disabledProviders, ...blockedLocal])] } : {}),
    mcp: Object.fromEntries(Object.entries(runtimeMcpMap(runtimeConfig))
      .filter(([name]) => !name.startsWith(CONNECT_MCP_SERVER_NAME_PREFIX))),
    ...(Object.keys(provider).length ? { provider } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableJsonValue(value[key])]),
  );
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableJsonValue(value));
}

export async function buildOpenworkRuntimeConfig(config?: ServerConfig): Promise<string> {
  return stableStringify(await buildOpenworkRuntimeConfigObject(config));
}

export function openworkRuntimeConfigFilePath(config: ServerConfig): string {
  return join(runtimeStorageDir(config), "runtime-opencode-config.json");
}

export interface OpenworkRuntimeConfigWriteResult {
  path: string;
  changed: boolean;
}

const fileWriteQueue = new Map<string, Promise<OpenworkRuntimeConfigWriteResult>>();

export async function writeOpenworkRuntimeConfigFile(
  config: ServerConfig,
): Promise<OpenworkRuntimeConfigWriteResult> {
  const path = openworkRuntimeConfigFilePath(config);
  const job = async () => {
    const content = await buildOpenworkRuntimeConfig(config);
    const current = await readFile(path, "utf8").catch(() => undefined);
    if (current === content) return { path, changed: false };
    await mkdir(runtimeStorageDir(config), { recursive: true });
    const tmp = `${path}.${randomUUID()}.tmp`;
    await writeFile(tmp, content, "utf8");
    await rename(tmp, path);
    return { path, changed: true };
  };
  const previous = fileWriteQueue.get(path) ?? Promise.resolve();
  const next = previous.then(job, job);
  fileWriteQueue.set(path, next);
  return await next;
}

export function keepOpenworkRuntimeConfigFileFresh(config: ServerConfig): () => void {
  return onRuntimeOpencodeConfigWrite((writeConfig, writtenWorkspaceId) => {
    if (!isEngineGlobalRuntimeConfigId(writtenWorkspaceId)) return;
    void writeOpenworkRuntimeConfigFile(writeConfig).catch(() => undefined);
  });
}
