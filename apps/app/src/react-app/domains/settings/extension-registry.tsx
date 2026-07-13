/** @jsxImportSource react */
import type {
  ContributionBinding,
  ContributionDescriptor,
  ContributionRegistration,
  ReadyContributionBinding,
} from "@openwork/contribution-registry";
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

export type ExtensionRuntimeConnection = (
  entry: McpDirectoryInfo,
  ctx: ExtensionRuntimeContext,
) => boolean;

export type SettingsExtensionDescriptor = ContributionDescriptor & {
  readonly kind: "app.settings-extension";
  readonly contractVersion: 1;
  /** All legacy manifest refs and fallback ids that select this settings panel. */
  readonly settingsPanelRefs: readonly string[];
  /** Extension ids that can use the optional runtime connection binding. */
  readonly connectionRefs: readonly string[];
};

export type SettingsExtensionRuntime = {
  readonly settingsPanel: ExtensionConfigFactory;
  readonly isConnected?: ExtensionRuntimeConnection;
};

export type SettingsExtensionHost = {
  readonly realm: "app-settings";
};

export type SettingsExtensionReadyBinding = ReadyContributionBinding<
  SettingsExtensionHost,
  SettingsExtensionRuntime
>;

export type SettingsExtensionBinding = ContributionBinding<
  SettingsExtensionHost,
  SettingsExtensionRuntime
>;

export type SettingsExtensionRegistration = ContributionRegistration<
  SettingsExtensionDescriptor,
  SettingsExtensionHost,
  SettingsExtensionRuntime
>;

export type SettingsExtensionLookup =
  | {
      readonly status: "found";
      readonly ref: string;
      readonly descriptor: SettingsExtensionDescriptor;
      readonly runtime: SettingsExtensionRuntime;
    }
  | {
      readonly status: "unknown";
      readonly ref: string;
    }
  | {
      readonly status: "unavailable";
      readonly ref: string;
      readonly descriptor: SettingsExtensionDescriptor;
      readonly reason: string;
    };

/** Immutable renderer-realm view assembled by the app settings composition root. */
export type SettingsExtensionComposition = {
  readonly descriptors: readonly SettingsExtensionDescriptor[];
  readonly lookupSettingsPanel: (ref: string) => SettingsExtensionLookup;
  readonly lookupConnection: (ref: string) => SettingsExtensionLookup;
};

function extensionRuntimeId(entry: McpDirectoryInfo) {
  return entry.extensionManifest?.id ?? entry.serverName ?? entry.name;
}

function configRegistryId(entry: McpDirectoryInfo) {
  return extensionContribution(entry.extensionManifest, "settings-panel")?.ref ?? entry.serverName ?? entry.name;
}

export function getExtensionConfigSlot(
  composition: SettingsExtensionComposition,
  entry: McpDirectoryInfo,
  ctx: ExtensionConfigContext,
): ReactNode | null {
  const result = composition.lookupSettingsPanel(configRegistryId(entry));
  return result.status === "found" ? result.runtime.settingsPanel(ctx) : null;
}

export function getExtensionConnected(
  composition: SettingsExtensionComposition,
  entry: McpDirectoryInfo,
  ctx: ExtensionRuntimeContext,
): boolean | null {
  const result = composition.lookupConnection(extensionRuntimeId(entry));
  return result.status === "found" && result.runtime.isConnected
    ? result.runtime.isConnected(entry, ctx)
    : null;
}
