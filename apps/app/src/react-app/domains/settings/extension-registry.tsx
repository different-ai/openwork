/** @jsxImportSource react */
import type { ReactNode } from "react";
import type { McpDirectoryInfo } from "../../../app/constants";
import { extensionContribution } from "../../../app/extensions";
import type { OpenworkServerClient } from "../../../app/lib/openwork-server";
import type { LocalProviderInstallInput } from "./openai-image-extension";

/**
 * Context bag that the settings route passes to extension config factories.
 * Each extension picks what it needs; unused fields are ignored.
 */
export type ExtensionConfigContext = {
  openworkServerClient?: OpenworkServerClient | null;
  hostOpenworkServerClient?: OpenworkServerClient | null;
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
    onInstall: (input: LocalProviderInstallInput) => void | Promise<void>;
  };
};

export type ExtensionConfigFactory = (ctx: ExtensionConfigContext) => ReactNode;

const registry = new Map<string, ExtensionConfigFactory>();

export function registerExtensionConfig(id: string, factory: ExtensionConfigFactory) {
  registry.set(id, factory);
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
