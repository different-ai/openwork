/** @jsxImportSource react */
import type { ReactNode } from "react";
import type { McpDirectoryInfo } from "../../../app/constants";
import { extensionContribution } from "../../../app/extensions";
import type { OpenworkServerClient } from "../../../app/lib/openwork-server";

/**
 * Context bag that the settings route passes to extension config factories.
 * Each extension picks what it needs; unused fields are ignored.
 */
export type ExtensionConfigContext = {
  openworkServerClient?: OpenworkServerClient | null;
  hostOpenworkServerClient?: OpenworkServerClient | null;
  extensionConnections?: Record<string, boolean>;
  onExtensionConnectionChange?: (extensionId: string, connected: boolean) => void;
  restartLocalServer?: () => Promise<boolean>;
  computerUse?: {
    connected: boolean;
    connecting: boolean;
    onConnect: () => void | Promise<void>;
    onRefresh: () => void | Promise<void>;
    onPermissionsChange?: (permissions: { accessibility: boolean; screenRecording: boolean }) => void;
  };
  imageExtension: {
    busy: boolean;
    status: string | null;
    error: string | null;
    envKeyDetected: boolean;
    onInstall: (apiKey: string) => void | Promise<void>;
    onTestGenerate: (input: { apiKey: string; prompt: string }) => void | Promise<void>;
  };
  voiceExtension: {
    busy: boolean;
    status: string | null;
    error: string | null;
    envKeyDetected: boolean;
    onSaveApiKey: (apiKey: string) => void | Promise<void>;
    onTestSession: () => void | Promise<void>;
  };
  localProvider: {
    busy: boolean;
    status: string | null;
    error: string | null;
    onInstall: (input: {
      providerId: string;
      name: string;
      baseURL: string;
      modelId: string;
      modelName: string;
      setDefault: boolean;
    }) => void | Promise<void>;
  };
};

export type ExtensionConfigFactory = (ctx: ExtensionConfigContext) => ReactNode;

export type ExtensionRuntimeContext = Pick<
  ExtensionConfigContext,
  "openworkServerClient" | "extensionConnections" | "onExtensionConnectionChange"
>;

export type OpenWorkExtensionRuntime = {
  id: string;
  settingsPanel?: ExtensionConfigFactory;
  settingsPanelRefs?: string[];
  isConnected?: (entry: McpDirectoryInfo, ctx: ExtensionRuntimeContext) => boolean;
};

const registry = new Map<string, ExtensionConfigFactory>();
const runtimeRegistry = new Map<string, OpenWorkExtensionRuntime>();

export function registerExtensionConfig(id: string, factory: ExtensionConfigFactory) {
  registry.set(id, factory);
}

export function registerExtensionRuntime(runtime: OpenWorkExtensionRuntime) {
  runtimeRegistry.set(runtime.id, runtime);
  if (runtime.settingsPanel) {
    registerExtensionConfig(runtime.id, runtime.settingsPanel);
    for (const ref of runtime.settingsPanelRefs ?? []) {
      registerExtensionConfig(ref, runtime.settingsPanel);
    }
  }
}

function extensionRuntimeId(entry: McpDirectoryInfo) {
  return entry.extensionManifest?.id ?? entry.serverName ?? entry.name;
}

function configRegistryId(entry: McpDirectoryInfo) {
  return extensionContribution(entry.extensionManifest, "settings-panel")?.ref ?? entry.serverName ?? entry.name;
}

export function getExtensionConfigSlot(
  entry: McpDirectoryInfo,
  ctx: ExtensionConfigContext,
): ReactNode | null {
  const id = configRegistryId(entry);
  const factory = registry.get(id);
  return factory ? factory(ctx) : null;
}

export function getExtensionConnected(
  entry: McpDirectoryInfo,
  ctx: ExtensionRuntimeContext,
): boolean | null {
  const runtime = runtimeRegistry.get(extensionRuntimeId(entry));
  return runtime?.isConnected ? runtime.isConnected(entry, ctx) : null;
}
