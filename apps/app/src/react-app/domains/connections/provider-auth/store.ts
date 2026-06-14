import { useSyncExternalStore } from "react";

import { applyEdits, modify, parse } from "jsonc-parser";
import type {
  ProviderAuthAuthorization,
  ProviderConfig,
  ProviderListResponse,
} from "@opencode-ai/sdk/v2/client";

import { t } from "../../../../i18n";
import {
  createDenClient,
  readDenSettings,
  type DenOrgLlmProvider,
  type DenOrgLlmProviderConnection,
} from "../../../../app/lib/den";
import { unwrap, waitForHealthy } from "../../../../app/lib/opencode";
import {
  readOpencodeConfig,
  writeOpencodeConfig,
  workspaceOpenworkRead,
  workspaceOpenworkWrite,
} from "../../../../app/lib/desktop";
import type {
  Client,
  ProviderListItem,
  WorkspaceDisplay,
} from "../../../../app/types";
import { isDesktopRuntime, safeStringify } from "../../../../app/utils";
import {
  compareProviders,
  filterProviderList,
} from "../../../../app/utils/providers";
import { getReactQueryClient } from "../../../infra/query-client";
import { ensureProviderListQuery } from "../../../infra/provider-list-query";
import type { OpenworkServerStoreSnapshot } from "../openwork-server-store";

/**
 * The slice of the openwork-server store this store actually consumes.
 * The settings route passes the full store; the session route passes a
 * lightweight endpoint-backed adapter (previously forced through `as never`).
 */
export type ProviderAuthOpenworkServer = {
  getSnapshot: () => Pick<
    OpenworkServerStoreSnapshot,
    "openworkServerStatus" | "openworkServerClient"
  > & {
    openworkServerCapabilities: { config?: { read?: boolean; write?: boolean } } | null;
  };
};
import {
  denSessionUpdatedEvent,
  type DenSessionUpdatedDetail,
} from "../../../../app/lib/den-session-events";
import {
  readWorkspaceCloudImports,
  withWorkspaceCloudImports,
  type CloudImportedProvider,
} from "../../../../app/cloud/import-state";
import { refreshDesktopCloudSync } from "../../../../app/cloud/desktop-cloud-sync";
import { dispatchNewProviders } from "../../../../app/lib/provider-events";
import {
  isDesktopProviderBlocked,
  type DesktopAppRestrictionChecker,
} from "../../../../app/cloud/desktop-app-restrictions";

type ProviderReturnFocusTarget = "none" | "composer";
type CloudProviderSyncReason = "sign_in" | "app_launch" | "interval" | "settings_cloud_opened";

export type ProviderAuthMethod = {
  type: "oauth" | "api" | "cloud";
  label: string;
  methodIndex?: number;
  cloudProviderId?: string;
  description?: string;
  env?: string[];
  modelCount?: number;
};

export type ProviderAuthProvider = {
  id: string;
  name: string;
  env: string[];
};

export type ProviderOAuthStartResult = {
  methodIndex: number;
  authorization: ProviderAuthAuthorization;
};

export type ProviderAuthStoreSnapshot = {
  providerAuthModalOpen: boolean;
  providerAuthBusy: boolean;
  providerAuthError: string | null;
  providerAuthMethods: Record<string, ProviderAuthMethod[]>;
  providerAuthPreferredProviderId: string | null;
  providerAuthWorkerType: "local" | "remote";
  providerAuthProviders: ProviderAuthProvider[];
  cloudOrgProviders: DenOrgLlmProvider[];
  importedCloudProviders: Record<string, CloudImportedProvider>;
};

type CreateProviderAuthStoreOptions = {
  client: () => Client | null;
  providers: () => ProviderListItem[];
  providerDefaults: () => Record<string, string>;
  providerConnectedIds: () => string[];
  disabledProviders: () => string[];
  checkDesktopAppRestriction: DesktopAppRestrictionChecker;
  selectedWorkspaceDisplay: () => WorkspaceDisplay;
  selectedWorkspaceRoot: () => string;
  runtimeWorkspaceId: () => string | null;
  ensureRuntimeWorkspaceId?: () => Promise<string | null | undefined>;
  openworkServer: ProviderAuthOpenworkServer;
  setProviders: (value: ProviderListItem[]) => void;
  setProviderDefaults: (value: Record<string, string>) => void;
  setProviderConnectedIds: (value: string[]) => void;
  setDisabledProviders: (value: string[]) => void;
  markOpencodeConfigReloadRequired: () => void;
  focusPromptSoon?: () => void;
};

type MutableState = {
  providerAuthModalOpen: boolean;
  providerAuthBusy: boolean;
  providerAuthError: string | null;
  providerAuthMethods: Record<string, ProviderAuthMethod[]>;
  providerAuthPreferredProviderId: string | null;
  providerAuthReturnFocusTarget: ProviderReturnFocusTarget;
  cloudOrgProviders: DenOrgLlmProvider[];
  importedCloudProviders: Record<string, CloudImportedProvider>;
};

export type ProviderAuthStore = ReturnType<typeof createProviderAuthStore>;

export function createProviderAuthStore(options: CreateProviderAuthStoreOptions) {
  const listeners = new Set<() => void>();

  let snapshot: ProviderAuthStoreSnapshot;
  let disposed = false;
  let started = false;
  let denSessionCleanup: (() => void) | null = null;
  let lastWorkspaceKey = "";

  let state: MutableState = {
    providerAuthModalOpen: false,
    providerAuthBusy: false,
    providerAuthError: null,
    providerAuthMethods: {},
    providerAuthPreferredProviderId: null,
    providerAuthReturnFocusTarget: "none",
    cloudOrgProviders: [],
    importedCloudProviders: {},
  };

  let cloudOrgProvidersLoadKey = "";
  let cloudOrgProvidersInFlightKey = "";
  let cloudOrgProvidersInFlight: Promise<DenOrgLlmProvider[]> | null = null;
  let cloudProviderSyncInFlight: Promise<void> | null = null;
  let cloudProviderSyncQueuedReason: CloudProviderSyncReason | null = null;
  let cloudProviderSyncContextKey = "";

  const emitChange = () => {
    for (const listener of listeners) listener();
  };

  const getStringList = (value: unknown) =>
    Array.isArray(value)
      ? value.filter(
          (entry): entry is string =>
            typeof entry === "string" && entry.trim().length > 0,
        )
      : [];

  const getCloudProviderEnv = (config: Record<string, unknown>) =>
    getStringList(config.env);
  const sortStrings = (values: string[]) => values.toSorted();
  const sameStringList = (a: string[], b: string[]) =>
    a.length === b.length && a.every((value, index) => value === b[index]);

  const getCloudManagedProviderId = (
    provider: Pick<DenOrgLlmProvider, "id" | "providerId" | "source">,
  ) => provider.source === "openwork" ? "openwork" : provider.id.trim();

  const getProviderAuthWorkerType = (): "local" | "remote" =>
    options.selectedWorkspaceDisplay().workspaceType === "remote" ? "remote" : "local";

  const getProviderAuthProviders = (): ProviderAuthProvider[] => {
    const merged = new Map<string, ProviderAuthProvider>();

    for (const provider of options.providers()) {
      const id = provider.id?.trim();
      if (!id) continue;
      if (isDesktopProviderBlocked({ providerId: id, checkRestriction: options.checkDesktopAppRestriction })) continue;
      merged.set(id, {
        id,
        name: provider.name?.trim() || id,
        env: Array.isArray(provider.env) ? provider.env : [],
      });
    }

    for (const provider of state.cloudOrgProviders) {
      const id = provider.providerId.trim();
      if (!id || merged.has(id)) continue;
      if (isDesktopProviderBlocked({ providerId: id, checkRestriction: options.checkDesktopAppRestriction })) continue;
      merged.set(id, {
        id,
        name: provider.name.trim() || id,
        env: getCloudProviderEnv(provider.providerConfig),
      });
    }

    return Array.from(merged.values()).toSorted(compareProviders);
  };

  const resolveOpenworkConfigTarget = async (mode: "read" | "write") => {
    const openworkSnapshot = options.openworkServer.getSnapshot();
    const openworkClient = openworkSnapshot.openworkServerClient;
    let openworkWorkspaceId = options.runtimeWorkspaceId()?.trim() || null;
    if (!openworkWorkspaceId && openworkSnapshot.openworkServerStatus === "connected" && openworkClient) {
      openworkWorkspaceId = (await options.ensureRuntimeWorkspaceId?.())?.trim() || null;
    }
    const hasOpenworkTarget =
      openworkSnapshot.openworkServerStatus === "connected" &&
      Boolean(openworkClient && openworkWorkspaceId);
    const canUseOpenworkServer =
      hasOpenworkTarget &&
      openworkSnapshot.openworkServerCapabilities?.config?.[mode] !== false;
    return {
      openworkClient,
      openworkWorkspaceId,
      hasOpenworkTarget,
      canUseOpenworkServer,
    };
  };

  const refreshSnapshot = () => {
    snapshot = {
      providerAuthModalOpen: state.providerAuthModalOpen,
      providerAuthBusy: state.providerAuthBusy,
      providerAuthError: state.providerAuthError,
      providerAuthMethods: state.providerAuthMethods,
      providerAuthPreferredProviderId: state.providerAuthPreferredProviderId,
      providerAuthWorkerType: getProviderAuthWorkerType(),
      providerAuthProviders: getProviderAuthProviders(),
      cloudOrgProviders: state.cloudOrgProviders,
      importedCloudProviders: state.importedCloudProviders,
    };
  };

  const mutateState = (updater: (current: MutableState) => MutableState) => {
    state = updater(state);
    refreshSnapshot();
    emitChange();
  };

  const setStateField = <K extends keyof MutableState>(
    key: K,
    value: MutableState[K],
  ) => {
    if (Object.is(state[key], value)) return;
    mutateState((current) => ({ ...current, [key]: value }));
  };

  const buildCloudProviderMethod = (
    provider: DenOrgLlmProvider,
  ): ProviderAuthMethod => ({
    type: "cloud",
    label:
      provider.name.trim().toLowerCase() ===
      provider.providerId.trim().toLowerCase()
        ? "Use organization provider"
        : `Use ${provider.name}`,
    cloudProviderId: provider.id,
    description:
      provider.models.length > 0
        ? `${provider.models.length} curated model${
            provider.models.length === 1 ? "" : "s"
          } managed by your organization.`
        : "Use the provider and credential managed by your organization.",
    env: getCloudProviderEnv(provider.providerConfig),
    modelCount: provider.models.length,
  });

  const buildCloudProviderConfig = (
    provider: DenOrgLlmProviderConnection,
  ): ProviderConfig => {
    const models = Object.fromEntries(
      provider.models.map((model) => {
        const next: NonNullable<ProviderConfig["models"]>[string] = {
          id: model.id,
          name: model.name,
        };
        const raw = model.config;
        for (const key of [
          "family",
          "release_date",
          "attachment",
          "reasoning",
          "temperature",
          "tool_call",
          "interleaved",
          "cost",
          "limit",
          "modalities",
          "status",
          "options",
          "headers",
          "provider",
          "variants",
        ] as const) {
          const value = raw[key];
          if (value !== undefined) {
            (next as Record<string, unknown>)[key] = value;
          }
        }
        return [model.id, next];
      }),
    );

    const next: ProviderConfig = {
      id: provider.providerId,
      name: provider.name,
      env: getCloudProviderEnv(provider.providerConfig),
      models,
    };

    if (
      typeof provider.providerConfig.npm === "string" &&
      provider.providerConfig.npm.trim()
    ) {
      next.npm = provider.providerConfig.npm;
    }
    if (
      typeof provider.providerConfig.api === "string" &&
      provider.providerConfig.api.trim()
    ) {
      next.api = provider.providerConfig.api;
    }
    if (
      provider.providerConfig.options &&
      typeof provider.providerConfig.options === "object"
    ) {
      next.options = provider.providerConfig.options as Record<string, unknown>;
    }
    if (Array.isArray(provider.providerConfig.whitelist)) {
      next.whitelist = getStringList(provider.providerConfig.whitelist);
    }
    if (Array.isArray(provider.providerConfig.blacklist)) {
      next.blacklist = getStringList(provider.providerConfig.blacklist);
    }

    return next;
  };

  const readWorkspaceOpenworkConfigRecord = async (): Promise<
    Record<string, unknown>
  > => {
    const root = options.selectedWorkspaceRoot().trim();
    const isLocalWorkspace =
      options.selectedWorkspaceDisplay().workspaceType === "local";
    const { openworkClient, openworkWorkspaceId, hasOpenworkTarget, canUseOpenworkServer } =
      await resolveOpenworkConfigTarget("read");

    if (canUseOpenworkServer && openworkClient && openworkWorkspaceId) {
      const config = await openworkClient.getConfig(openworkWorkspaceId);
      return config.openwork ?? {};
    }

    if (hasOpenworkTarget) {
      return {};
    }

    if (isLocalWorkspace && isDesktopRuntime() && root) {
      return (await workspaceOpenworkRead({
        workspacePath: root,
      })) as unknown as Record<string, unknown>;
    }

    return {};
  };

  const writeWorkspaceOpenworkConfigRecord = async (
    config: Record<string, unknown>,
  ) => {
    const root = options.selectedWorkspaceRoot().trim();
    const isLocalWorkspace =
      options.selectedWorkspaceDisplay().workspaceType === "local";
    const { openworkClient, openworkWorkspaceId, hasOpenworkTarget, canUseOpenworkServer } =
      await resolveOpenworkConfigTarget("write");

    if (canUseOpenworkServer && openworkClient && openworkWorkspaceId) {
      await openworkClient.patchConfig(openworkWorkspaceId, { openwork: config });
      return true;
    }

    if (hasOpenworkTarget) {
      return false;
    }

    if (isLocalWorkspace && isDesktopRuntime() && root) {
      const result = await workspaceOpenworkWrite({
        workspacePath: root,
        config: config as never,
      });
      const typed = result as { ok: boolean; stderr?: string; stdout?: string };
      if (!typed.ok) {
        throw new Error(
          typed.stderr || typed.stdout || "Failed to write .opencode/openwork.json",
        );
      }
      return true;
    }

    return false;
  };

  const refreshImportedCloudProviders = async () => {
    try {
      const config = await readWorkspaceOpenworkConfigRecord();
      const cloudImports = readWorkspaceCloudImports(config);
      setStateField("importedCloudProviders", cloudImports.providers);
      return cloudImports.providers;
    } catch {
      setStateField("importedCloudProviders", {});
      return {};
    }
  };

  const persistImportedCloudProviders = async (
    nextProviders: Record<string, CloudImportedProvider>,
  ) => {
    const config = await readWorkspaceOpenworkConfigRecord();
    const cloudImports = readWorkspaceCloudImports(config);
    const nextCloudImports = {
      ...cloudImports,
      providers: nextProviders,
    };
    const nextConfig = withWorkspaceCloudImports(config, {
      ...nextCloudImports,
    });
    const persisted = await writeWorkspaceOpenworkConfigRecord(nextConfig);
    if (!persisted) {
      throw new Error(
        "OpenWork server unavailable. Connect to manage imported cloud providers.",
      );
    }
    setStateField("importedCloudProviders", nextProviders);
    const target = await resolveOpenworkConfigTarget("write");
    void refreshDesktopCloudSync({
      openworkClient: target.openworkClient,
      workspaceId: target.openworkWorkspaceId,
    }).catch(() => null);
  };

  const readProjectConfigFile = async () => {
    const root = options.selectedWorkspaceRoot().trim();
    const isLocalWorkspace =
      options.selectedWorkspaceDisplay().workspaceType === "local";
    const { openworkClient, openworkWorkspaceId, hasOpenworkTarget, canUseOpenworkServer } =
      await resolveOpenworkConfigTarget("read");

    if (canUseOpenworkServer && openworkClient && openworkWorkspaceId) {
      return await openworkClient.readOpencodeConfigFile(openworkWorkspaceId, "project");
    }

    if (hasOpenworkTarget) {
      throw new Error("OpenWork server config API is unavailable for this workspace.");
    }

    if (isLocalWorkspace && isDesktopRuntime() && root) {
      return await readOpencodeConfig("project", root);
    }

    return null;
  };

  const writeProjectConfigFile = async (content: string) => {
    const root = options.selectedWorkspaceRoot().trim();
    const isLocalWorkspace =
      options.selectedWorkspaceDisplay().workspaceType === "local";
    const { openworkClient, openworkWorkspaceId, hasOpenworkTarget, canUseOpenworkServer } =
      await resolveOpenworkConfigTarget("write");

    if (canUseOpenworkServer && openworkClient && openworkWorkspaceId) {
      const result = await openworkClient.writeOpencodeConfigFile(
        openworkWorkspaceId,
        "project",
        content,
      ) as { ok: boolean; stderr?: string; stdout?: string };
      if (!result.ok) {
        throw new Error(result.stderr || result.stdout || "Failed to write opencode.jsonc");
      }
      return true;
    }

    if (hasOpenworkTarget) {
      throw new Error("OpenWork server config API is unavailable for this workspace.");
    }

    if (isLocalWorkspace && isDesktopRuntime() && root) {
      const result = await writeOpencodeConfig("project", root, content) as { ok: boolean; stderr?: string; stdout?: string };
      if (!result.ok) {
        throw new Error(result.stderr || result.stdout || "Failed to write opencode.jsonc");
      }
      return true;
    }

    return false;
  };

  const updateProjectConfigFile = async (
    updater: (raw: string) => string,
    fallbackUpdate?: (config: Record<string, unknown>) => Record<string, unknown>,
  ) => {
    const configFile = await readProjectConfigFile() as { content?: string } | null;
    if (configFile) {
      const raw = configFile.content?.trim()
        ? configFile.content
        : '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
      await writeProjectConfigFile(updater(raw));
      return true;
    }

    if (!fallbackUpdate) {
      return false;
    }

    const c = options.client();
    if (!c) {
      throw new Error(t("providers.not_connected"));
    }
    const config = unwrap(await c.config.get());
    const next = fallbackUpdate(config);
    await c.config.update({ config: next });
    return true;
  };

  const normalizeDisabledProviders = (value: unknown) =>
    Array.isArray(value)
      ? [
          ...new Set(
            value
              .filter((entry): entry is string => typeof entry === "string")
              .map((entry) => entry.trim())
              .filter(Boolean),
          ),
        ]
      : [];

  const formatConfigWithProviderDisabledState = (
    raw: string,
    providerId: string,
    disabled: boolean,
  ) => {
    const resolvedProviderId = providerId.trim();
    let updated = raw.trim()
      ? raw
      : '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
    const parsed = parse(updated) as Record<string, unknown> | undefined;
    const currentDisabled = normalizeDisabledProviders(parsed?.disabled_providers);
    const nextDisabled = disabled
      ? [...currentDisabled.filter((entry) => entry !== resolvedProviderId), resolvedProviderId]
      : currentDisabled.filter((entry) => entry !== resolvedProviderId);

    const disabledEdits = modify(
      updated,
      ["disabled_providers"],
      nextDisabled.length ? nextDisabled : undefined,
      { formattingOptions: { insertSpaces: true, tabSize: 2 } },
    );
    updated = applyEdits(updated, disabledEdits);
    return updated.endsWith("\n") ? updated : `${updated}\n`;
  };

  const ensureProjectProviderDisabledState = async (
    providerId: string,
    disabled: boolean,
  ) => {
    const resolvedProviderId = providerId.trim();
    if (!resolvedProviderId) {
      throw new Error(t("providers.provider_id_required"));
    }

    const currentDisabled = normalizeDisabledProviders(options.disabledProviders());
    const nextDisabled = disabled
      ? [...currentDisabled.filter((entry) => entry !== resolvedProviderId), resolvedProviderId]
      : currentDisabled.filter((entry) => entry !== resolvedProviderId);

    if (
      nextDisabled.length === currentDisabled.length &&
      nextDisabled.every((entry, index) => entry === currentDisabled[index])
    ) {
      return false;
    }

    const updatedConfig = await updateProjectConfigFile(
      (raw) => formatConfigWithProviderDisabledState(raw, resolvedProviderId, disabled),
      (config) => {
        const nextConfig = { ...config };
        if (nextDisabled.length) {
          nextConfig.disabled_providers = nextDisabled;
        } else {
          delete nextConfig.disabled_providers;
        }
        return nextConfig;
      },
    );

    if (!updatedConfig) {
      throw new Error("Could not update opencode.jsonc for this workspace.");
    }

    options.setDisabledProviders(nextDisabled);
    options.markOpencodeConfigReloadRequired();
    refreshSnapshot();
    emitChange();
    return true;
  };

  const assertProviderAllowedByDesktopPolicy = (providerId: string) => {
    if (
      isDesktopProviderBlocked({
        providerId,
        checkRestriction: options.checkDesktopAppRestriction,
      })
    ) {
      throw new Error(`${providerId} is blocked by your organization desktop policy.`);
    }
  };

  const escapeRegExp = (value: string) =>
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const cloudProviderComment = (provider: Pick<DenOrgLlmProvider, "id" | "name">) =>
    `// OpenWork Cloud import: ${provider.name
      .replace(/\s+/g, " ")
      .trim()} (${provider.id}). Manage this entry from Cloud settings.`;

  const removeCloudProviderComment = (raw: string, providerId: string) =>
    raw.replace(
      new RegExp(
        `(^[ \t]*)// OpenWork Cloud import:.*\\n\\1(?="${escapeRegExp(providerId)}":)`,
        "m",
      ),
      "$1",
    );

  const addCloudProviderComment = (
    raw: string,
    provider: Pick<DenOrgLlmProvider, "id" | "name">,
    localProviderId: string,
  ) => {
    const withoutExisting = removeCloudProviderComment(raw, localProviderId);
    const propertyPattern = new RegExp(
      `^([ \t]*)"${escapeRegExp(localProviderId)}":`,
      "m",
    );
    return withoutExisting.replace(
      propertyPattern,
      `$1${cloudProviderComment(provider)}\n$1"${localProviderId}":`,
    );
  };

  const getProviderModelIds = (provider: Pick<DenOrgLlmProvider, "models">) =>
    provider.models.flatMap((model) => {
      const id = model.id.trim();
      return id ? [id] : [];
    }).sort();

  const formatConfigWithCloudProvider = (
    raw: string,
    provider: DenOrgLlmProviderConnection,
    localProviderId: string,
    previousProviderId?: string | null,
  ) => {
    const nextProviderConfig = buildCloudProviderConfig(
      provider,
    ) as unknown as Record<string, unknown>;
    let updated = raw.trim()
      ? raw
      : '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';

    if (previousProviderId && previousProviderId !== localProviderId) {
      updated = removeCloudProviderComment(updated, previousProviderId);
      const previousEdits = modify(updated, ["provider", previousProviderId], undefined, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      });
      updated = applyEdits(updated, previousEdits);
    }

    const providerEdits = modify(updated, ["provider", localProviderId], nextProviderConfig, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    });
    updated = applyEdits(updated, providerEdits);
    updated = addCloudProviderComment(updated, provider, localProviderId);

    const disabledToRemove = new Set([localProviderId, previousProviderId ?? ""]);
    const currentDisabled = options.disabledProviders();
    if (currentDisabled.some((id) => disabledToRemove.has(id))) {
      const nextDisabled = currentDisabled.filter((id) => !disabledToRemove.has(id));
      const disabledEdits = modify(updated, ["disabled_providers"], nextDisabled, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      });
      updated = applyEdits(updated, disabledEdits);
    }

    return updated.endsWith("\n") ? updated : `${updated}\n`;
  };

  const formatConfigWithoutCloudProvider = (raw: string, providerId: string) => {
    let updated = raw.trim()
      ? raw
      : '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
    updated = removeCloudProviderComment(updated, providerId);
    const providerEdits = modify(updated, ["provider", providerId], undefined, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    });
    updated = applyEdits(updated, providerEdits);

    const nextDisabled = options.disabledProviders().filter((id) => id !== providerId);
    const disabledEdits = modify(updated, ["disabled_providers"], nextDisabled, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    });
    updated = applyEdits(updated, disabledEdits);
    return updated.endsWith("\n") ? updated : `${updated}\n`;
  };

  // Sweep all cloud-managed provider entries (keys matching /^lpr_/) from
  // opencode.jsonc regardless of importedCloudProviders state. Returns the
  // list of provider IDs that were removed so callers can also clear their
  // auth credentials.
  const sweepOrphanCloudProvidersFromConfig = async (): Promise<string[]> => {
    const configFile = await readProjectConfigFile() as { content?: string } | null;
    if (!configFile?.content?.trim()) return [];
    const parsed = parse(configFile.content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const providerSection = (parsed as Record<string, unknown>).provider;
    if (
      !providerSection ||
      typeof providerSection !== "object" ||
      Array.isArray(providerSection)
    ) {
      return [];
    }
    const orphanIds = Object.keys(providerSection as Record<string, unknown>).filter(
      (key) => /^lpr_/i.test(key),
    );
    if (orphanIds.length === 0) return [];

    await updateProjectConfigFile((raw) => {
      let next = raw;
      for (const id of orphanIds) {
        next = formatConfigWithoutCloudProvider(next, id);
      }
      return next;
    });
    return orphanIds;
  };

  const assertCloudProviderImportSafe = async (
    provider: DenOrgLlmProviderConnection,
  ) => {
    const localProviderId = getCloudManagedProviderId(provider);
    const existingImported = state.importedCloudProviders[provider.id] ?? null;
    if (
      existingImported &&
      existingImported.providerId !== localProviderId &&
      Object.values(state.importedCloudProviders).some(
        (entry) => entry.providerId === localProviderId && entry.cloudProviderId !== provider.id,
      )
    ) {
      throw new Error(
        `${localProviderId} is already imported from another cloud provider. Remove it before importing this one.`,
      );
    }

    if (!existingImported && options.providerConnectedIds().includes(localProviderId)) {
      throw new Error(
        `${localProviderId} is already connected in this workspace. Disconnect it before importing the cloud-managed version.`,
      );
    }

    const configFile = await readProjectConfigFile() as { content?: string } | null;
    if (!configFile?.content?.trim() || existingImported) {
      return;
    }

    const parsed = parse(configFile.content);
    const providerSection =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).provider
        : null;
    if (
      providerSection &&
      typeof providerSection === "object" &&
      !Array.isArray(providerSection) &&
      localProviderId in (providerSection as Record<string, unknown>)
    ) {
      throw new Error(
        `${localProviderId} already has a provider block in opencode.jsonc. Remove it before importing the cloud-managed version.`,
      );
    }
  };

  const getCloudOrgProvidersKey = () => {
    const settings = readDenSettings();
    return [
      settings.baseUrl,
      settings.apiBaseUrl ?? "",
      settings.activeOrgId?.trim() ?? "",
      settings.authToken?.trim() ?? "",
    ].join("::");
  };

  const refreshCloudOrgProviders = async (optionsArg?: { force?: boolean }) => {
    const settings = readDenSettings();
    const loadKey = getCloudOrgProvidersKey();
    const token = settings.authToken?.trim() ?? "";
    const orgId = settings.activeOrgId?.trim() ?? "";

    if (!optionsArg?.force && cloudOrgProvidersLoadKey === loadKey) {
      return state.cloudOrgProviders;
    }

    if (cloudOrgProvidersInFlight && cloudOrgProvidersInFlightKey === loadKey) {
      return cloudOrgProvidersInFlight;
    }

    if (!token || !orgId) {
      setStateField("cloudOrgProviders", []);
      cloudOrgProvidersLoadKey = loadKey;
      return [];
    }

    const client = createDenClient({
      baseUrl: settings.baseUrl,
      apiBaseUrl: settings.apiBaseUrl,
      token,
    });
    const request = client
      .listOrgLlmProviders(orgId)
      .then((providers) => {
        setStateField("cloudOrgProviders", providers);
        cloudOrgProvidersLoadKey = loadKey;
        return providers;
      })
      .catch((error) => {
        setStateField("cloudOrgProviders", []);
        cloudOrgProvidersLoadKey = "";
        throw error;
      })
      .finally(() => {
        if (cloudOrgProvidersInFlightKey === loadKey) {
          cloudOrgProvidersInFlight = null;
          cloudOrgProvidersInFlightKey = "";
        }
      });

    cloudOrgProvidersInFlight = request;
    cloudOrgProvidersInFlightKey = loadKey;
    return request;
  };

  // Track whether the provider list has been loaded at least once.
  // The first load (app startup) populates the initial state — we don't
  // want to fire "new provider" events for providers that were already
  // there. After the first load, any new provider IS genuinely new.
  let providerListInitialized = false;

  const applyProviderListState = (value: ProviderListResponse, opts?: { suppressNewProviderEvent?: boolean }) => {
    const prevConnected = new Set(options.providerConnectedIds());
    const nextConnected = value.connected ?? [];
    const nextAll = value.all ?? [];
    options.setProviders(nextAll);
    options.setProviderDefaults(value.default ?? {});
    options.setProviderConnectedIds(nextConnected);
    refreshSnapshot();
    emitChange();

    if (!providerListInitialized) {
      providerListInitialized = true;
      return;
    }

    // Detect newly connected providers and fire a global event so
    // the NewProvidersListener records a notification — regardless of
    // which route is active.
    if (!opts?.suppressNewProviderEvent) {
      const newIds = nextConnected.filter((id) => !prevConnected.has(id));
      if (newIds.length > 0) {
        const infos = newIds.map((id) => {
          const provider = nextAll.find((p) => (p.id ?? "") === id);
          const models = provider?.models ?? {};
          const firstModelId = Object.keys(models)[0];
          return {
            id,
            name: provider?.name ?? id,
            providerId: id,
            firstModelId,
            firstModelName: firstModelId
              ? (models[firstModelId]?.name ?? firstModelId)
              : undefined,
          };
        });
        dispatchNewProviders({ providers: infos, source: "local_config" });
      }
    }
  };

  const removeProviderFromState = (providerId: string) => {
    const resolved = providerId.trim();
    if (!resolved) return;
    options.setProviders(options.providers().filter((provider) => provider.id !== resolved));
    options.setProviderConnectedIds(
      options.providerConnectedIds().filter((id) => id !== resolved),
    );
    options.setProviderDefaults(
      Object.fromEntries(
        Object.entries(options.providerDefaults()).filter(([id]) => id !== resolved),
      ),
    );
    refreshSnapshot();
    emitChange();
  };

  const assertNoClientError = (result: unknown) => {
    const maybe = result as { error?: unknown } | null | undefined;
    if (!maybe || maybe.error === undefined) return;
    throw new Error(describeProviderError(maybe.error, t("providers.request_failed")));
  };

  const removeProviderAuthCredentials = async (providerId: string) => {
    const c = options.client();
    if (!c) {
      throw new Error(t("providers.not_connected"));
    }

    const authClient = c.auth as unknown as {
      remove?: (options: { providerID: string }) => Promise<unknown>;
      set?: (options: { providerID: string; auth: unknown }) => Promise<unknown>;
    };
    if (typeof authClient.remove === "function") {
      const result = await authClient.remove({ providerID: providerId });
      assertNoClientError(result);
      return;
    }

    const rawClient = (c as unknown as {
      client?: { delete?: (options: { url: string }) => Promise<unknown> };
    }).client;
    if (rawClient?.delete) {
      await rawClient.delete({ url: `/auth/${encodeURIComponent(providerId)}` });
      return;
    }

    if (typeof authClient.set === "function") {
      const result = await authClient.set({ providerID: providerId, auth: null });
      assertNoClientError(result);
      return;
    }

    throw new Error(t("providers.removal_unsupported"));
  };

  const describeProviderError = (error: unknown, fallback: string) => {
    const readString = (value: unknown, max = 700) => {
      if (typeof value !== "string") return null;
      const trimmed = value.trim();
      if (!trimmed) return null;
      if (trimmed.length <= max) return trimmed;
      return `${trimmed.slice(0, Math.max(0, max - 3))}...`;
    };

    const records: Record<string, unknown>[] = [];
    const root = error && typeof error === "object" ? (error as Record<string, unknown>) : null;
    if (root) {
      records.push(root);
      if (root.data && typeof root.data === "object") {
        records.push(root.data as Record<string, unknown>);
      }
      if (root.cause && typeof root.cause === "object") {
        const cause = root.cause as Record<string, unknown>;
        records.push(cause);
        if (cause.data && typeof cause.data === "object") {
          records.push(cause.data as Record<string, unknown>);
        }
      }
    }

    const firstString = (keys: string[]) => {
      for (const record of records) {
        for (const key of keys) {
          const value = readString(record[key]);
          if (value) return value;
        }
      }
      return null;
    };

    const firstNumber = (keys: string[]) => {
      for (const record of records) {
        for (const key of keys) {
          const value = record[key];
          if (typeof value === "number" && Number.isFinite(value)) return value;
        }
      }
      return null;
    };

    const status = firstNumber(["statusCode", "status"]);
    const provider = firstString(["providerID", "providerId", "provider"]);
    const code = firstString(["code", "errorCode"]);
    const response = firstString(["responseBody", "body", "response"]);
    const raw =
      (error instanceof Error ? readString(error.message) : null) ||
      firstString(["message", "detail", "reason", "error"]) ||
      (typeof error === "string" ? readString(error) : null);

    const generic = raw && /^unknown\s+error$/i.test(raw);
    const heading = (() => {
      if (status === 401 || status === 403) return t("providers.auth_failed");
      if (status === 429) return t("providers.rate_limit_exceeded");
      if (provider) return t("providers.provider_error", { provider });
      return fallback;
    })();

    const lines = [heading];
    if (raw && !generic && raw !== heading) lines.push(raw);
    if (status && !heading.includes(String(status))) lines.push(`Status: ${status}`);
    if (provider && !heading.includes(provider)) lines.push(`Provider: ${provider}`);
    if (code) lines.push(`Code: ${code}`);
    if (response) lines.push(`Response: ${response}`);
    if (lines.length > 1) return lines.join("\n");

    if (raw && !generic) return raw;
    if (error && typeof error === "object") {
      const serialized = safeStringify(error);
      if (serialized && serialized !== "{}") return serialized;
    }
    return fallback;
  };

  const buildProviderAuthMethods = (
    methods: Record<string, ProviderAuthMethod[]>,
    availableProviders: ProviderAuthProvider[],
    workerType: "local" | "remote",
    cloudProviders: DenOrgLlmProvider[],
  ) => {
    const merged = Object.fromEntries(
      Object.entries(methods ?? {}).map(([id, providerMethods]) => [
        id,
        (providerMethods ?? []).map((method, methodIndex) => ({
          ...method,
          methodIndex,
        })),
      ]),
    ) as Record<string, ProviderAuthMethod[]>;

    for (const provider of availableProviders ?? []) {
      const id = provider.id?.trim();
      if (!id) continue;
      if (isDesktopProviderBlocked({ providerId: id, checkRestriction: options.checkDesktopAppRestriction })) continue;
      if (!Array.isArray(provider.env) || provider.env.length === 0) continue;
      const existing = merged[id] ?? [];
      if (existing.some((method) => method.type === "api")) continue;
      merged[id] = [...existing, { type: "api", label: t("providers.api_key_label") }];
    }

    const availableProvidersById = new Map((availableProviders ?? []).map((provider) => [provider.id, provider]));
    for (const [id, providerMethods] of Object.entries(merged)) {
      if (isDesktopProviderBlocked({ providerId: id, checkRestriction: options.checkDesktopAppRestriction })) {
        delete merged[id];
        continue;
      }
      const provider = availableProvidersById.get(id);
      const normalizedId = id.trim().toLowerCase();
      const normalizedName = provider?.name?.trim().toLowerCase() ?? "";
      const isOpenAiProvider = normalizedId === "openai" || normalizedName === "openai";
      if (!isOpenAiProvider) continue;
      merged[id] = providerMethods.filter((method) => {
        if (method.type !== "oauth") return true;
        const label = method.label.toLowerCase();
        const isHeadless = /headless|device/.test(label);
        return workerType === "remote" ? isHeadless : !isHeadless;
      });
    }

    for (const provider of cloudProviders) {
      const id = provider.providerId.trim();
      if (!id) continue;
      if (isDesktopProviderBlocked({ providerId: id, checkRestriction: options.checkDesktopAppRestriction })) continue;
      const existing = merged[id] ?? [];
      if (
        existing.some(
          (method) =>
            method.type === "cloud" && method.cloudProviderId === provider.id,
        )
      ) {
        continue;
      }
      merged[id] = [...existing, buildCloudProviderMethod(provider)];
    }

    return merged;
  };

  const loadProviderAuthMethods = async (workerType: "local" | "remote") => {
    const c = options.client();
    if (!c) {
      throw new Error(t("providers.not_connected"));
    }
    const methods = unwrap(await c.provider.auth());
    const cloudProviders = await refreshCloudOrgProviders().catch(
      () => [] as DenOrgLlmProvider[],
    );
    return buildProviderAuthMethods(
      methods as Record<string, ProviderAuthMethod[]>,
      getProviderAuthProviders(),
      workerType,
      cloudProviders,
    );
  };

  async function startProviderAuth(
    providerId?: string,
    methodIndex?: number,
  ): Promise<ProviderOAuthStartResult> {
    setStateField("providerAuthError", null);
    const c = options.client();
    if (!c) {
      throw new Error(t("providers.not_connected"));
    }
    try {
      const cachedMethods = state.providerAuthMethods;
      const authMethods = Object.keys(cachedMethods).length
        ? cachedMethods
        : await loadProviderAuthMethods(getProviderAuthWorkerType());
      const providerIds = Object.keys(authMethods).sort();
      if (!providerIds.length) {
        throw new Error(t("providers.no_providers_available"));
      }

      const resolved = providerId?.trim() ?? "";
      if (!resolved) {
        throw new Error(t("providers.provider_id_required"));
      }
      assertProviderAllowedByDesktopPolicy(resolved);

      const methods = authMethods[resolved];
      if (!methods || !methods.length) {
        throw new Error(`${t("providers.unknown_provider")}: ${resolved}`);
      }

      const oauthIndex =
        methodIndex !== undefined
          ? methodIndex
          : methods.find((method) => method.type === "oauth")?.methodIndex ?? -1;
      if (oauthIndex === -1) {
        throw new Error(
          `${t("providers.no_oauth_prefix")} ${resolved}. ${t("providers.use_api_key_suffix")}`,
        );
      }

      const selectedMethod = methods.find((method) => method.methodIndex === oauthIndex);
      if (!selectedMethod || selectedMethod.type !== "oauth") {
        throw new Error(`${t("providers.not_oauth_flow_prefix")} ${resolved}.`);
      }

      const auth = unwrap(
        await c.provider.oauth.authorize({ providerID: resolved, method: oauthIndex }),
      );
      return { methodIndex: oauthIndex, authorization: auth };
    } catch (error) {
      const message = describeProviderError(error, t("providers.connect_failed"));
      setStateField("providerAuthError", message);
      throw error instanceof Error ? error : new Error(message);
    }
  }

  async function refreshProviders(optionsArg?: { dispose?: boolean }) {
    const c = options.client();
    if (!c) return null;

    if (optionsArg?.dispose) {
      // Prefer the OpenWork server engine reload: it disposes the engine AND
      // re-registers runtime-DB MCPs, so non-primary workspaces and pending
      // changes are picked up instead of silently dropping (toggles "turn
      // off").
      let reloaded = false;
      try {
        const openworkSnapshot = options.openworkServer.getSnapshot();
        const openworkClient = openworkSnapshot.openworkServerClient;
        if (openworkSnapshot.openworkServerStatus === "connected" && openworkClient) {
          const workspaceId =
            options.runtimeWorkspaceId()?.trim() ||
            (await options.ensureRuntimeWorkspaceId?.())?.trim() ||
            "";
          if (workspaceId) {
            await openworkClient.reloadEngine(workspaceId);
            reloaded = true;
          }
        }
      } catch {
        // fall back to a direct engine dispose below
      }

      if (!reloaded) {
        try {
          unwrap(await c.instance.dispose());
        } catch {
          // ignore dispose failures and try reading current state anyway
        }
      }

      try {
        await waitForHealthy(options.client() ?? c, { timeoutMs: 8000, pollMs: 250 });
      } catch {
        // ignore health wait failures and still attempt provider reads
      }
    }

    const activeClient = options.client() ?? c;
    let disabledProviders = options.disabledProviders() ?? [];
    try {
      const config = unwrap(await activeClient.config.get());
      disabledProviders = Array.isArray(config.disabled_providers)
        ? config.disabled_providers
        : [];
      options.setDisabledProviders(disabledProviders);
      refreshSnapshot();
      emitChange();
    } catch {
      // ignore config read failures and continue with current store state
    }

    try {
      const updated = filterProviderList(
        await ensureProviderListQuery(getReactQueryClient(), {
          client: activeClient,
          directory: options.selectedWorkspaceRoot(),
          force: Boolean(optionsArg?.dispose),
        }),
        disabledProviders,
      );
      applyProviderListState(updated);
      return updated;
    } catch {
      return null;
    }
  }

  async function completeProviderAuthOAuth(
    providerId: string,
    methodIndex: number,
    code?: string,
  ) {
    setStateField("providerAuthError", null);
    const c = options.client();
    if (!c) {
      throw new Error(t("providers.not_connected"));
    }

    const resolved = providerId?.trim();
    if (!resolved) {
      throw new Error(t("providers.provider_id_required"));
    }
    assertProviderAllowedByDesktopPolicy(resolved);

    if (!Number.isInteger(methodIndex) || methodIndex < 0) {
      throw new Error(t("providers.oauth_method_required"));
    }

    const waitForProviderConnection = async (timeoutMs = 15000, pollMs = 2000) => {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        try {
          const updated = await refreshProviders({ dispose: true });
          const connected = new Set(updated?.connected ?? []);
          if (connected.has(resolved)) {
            return true;
          }
        } catch {
          // ignore and retry
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
      return false;
    };

    const isPendingOauthError = (error: unknown) => {
      const text = error instanceof Error ? error.message : String(error ?? "");
      return /request timed out/i.test(text) || /ProviderAuthOauthMissing/i.test(text);
    };

    try {
      const trimmedCode = code?.trim();
      const result = await c.provider.oauth.callback({
        providerID: resolved,
        method: methodIndex,
        code: trimmedCode || undefined,
      });
      assertNoClientError(result);
      const updated = await refreshProviders({ dispose: true });
      const connectedNow = Array.isArray(updated?.connected) && updated.connected.includes(resolved);
      if (connectedNow) {
        return { connected: true, message: `${t("status.connected")} ${resolved}` };
      }
      const connected = await waitForProviderConnection();
      if (connected) {
        return { connected: true, message: `${t("status.connected")} ${resolved}` };
      }
      return { connected: false, pending: true };
    } catch (error) {
      if (isPendingOauthError(error)) {
        const updated = await refreshProviders({ dispose: true });
        if (Array.isArray(updated?.connected) && updated.connected.includes(resolved)) {
          return { connected: true, message: `${t("status.connected")} ${resolved}` };
        }
        const connected = await waitForProviderConnection();
        if (connected) {
          return { connected: true, message: `${t("status.connected")} ${resolved}` };
        }
        return { connected: false, pending: true };
      }
      const message = describeProviderError(error, t("providers.oauth_failed"));
      setStateField("providerAuthError", message);
      throw error instanceof Error ? error : new Error(message);
    }
  }

  async function submitProviderApiKey(providerId: string, apiKey: string) {
    setStateField("providerAuthError", null);
    const c = options.client();
    if (!c) {
      throw new Error(t("providers.not_connected"));
    }

    const trimmed = apiKey.trim();
    if (!trimmed) {
      throw new Error(t("providers.api_key_required"));
    }
    assertProviderAllowedByDesktopPolicy(providerId);

    try {
      await c.auth.set({ providerID: providerId, auth: { type: "api", key: trimmed } });
      await refreshProviders({ dispose: true });
      return `${t("status.connected")} ${providerId}`;
    } catch (error) {
      const message = describeProviderError(error, t("providers.save_api_key_failed"));
      setStateField("providerAuthError", message);
      throw error instanceof Error ? error : new Error(message);
    }
  }

  async function connectCloudProviderInternal(
    cloudProviderId: string,
    optionsArg?: { silent?: boolean },
  ) {
    if (!optionsArg?.silent) {
      setStateField("providerAuthError", null);
    }
    const c = options.client();
    if (!c) {
      throw new Error(t("providers.not_connected"));
    }

    const settings = readDenSettings();
    const token = settings.authToken?.trim() ?? "";
    const orgId = settings.activeOrgId?.trim() ?? "";
    if (!token || !orgId) {
      throw new Error("Sign in to OpenWork Cloud and choose an organization first.");
    }

    try {
      const den = createDenClient({
        baseUrl: settings.baseUrl,
        apiBaseUrl: settings.apiBaseUrl,
        token,
      });
      const provider = await den.getOrgLlmProviderConnection(orgId, cloudProviderId);
      assertProviderAllowedByDesktopPolicy(provider.providerId);
      const existingImported = state.importedCloudProviders[cloudProviderId] ?? null;
      const localProviderId = getCloudManagedProviderId(provider);
      const apiKey = provider.apiKey?.trim() ?? "";
      const env = getCloudProviderEnv(provider.providerConfig);
      if (!apiKey && env.length > 0) {
        throw new Error(`${provider.name} does not have a stored organization credential yet.`);
      }

      await assertCloudProviderImportSafe(provider);

      if (apiKey) {
        await c.auth.set({
          providerID: localProviderId,
          auth: { type: "api", key: apiKey },
        });
      }
      if (existingImported?.providerId && existingImported.providerId !== localProviderId) {
        try {
          await removeProviderAuthCredentials(existingImported.providerId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error ?? "");
          if (!/not found|unknown auth|404/i.test(message.toLowerCase())) {
            throw error;
          }
        }
      }
      const updatedConfig = await updateProjectConfigFile((raw) =>
        formatConfigWithCloudProvider(raw, provider, localProviderId, existingImported?.providerId ?? null),
      );
      if (!updatedConfig) {
        throw new Error("Could not update opencode.jsonc for this workspace.");
      }

      const nextImportedProviders = {
        ...state.importedCloudProviders,
        [provider.id]: {
          cloudProviderId: provider.id,
          providerId: localProviderId,
          // Track the provider id as shipped by the server at import time
          // so we can detect local/remote drift later (see dev #1510 "key
          // cloud providers by cloud id"). On first import both match.
          sourceProviderId: provider.providerId,
          name: provider.name,
          source: provider.source,
          updatedAt: provider.updatedAt ?? null,
          modelIds: getProviderModelIds(provider),
          importedAt: Date.now(),
        },
      };
      await persistImportedCloudProviders(nextImportedProviders);

      const nextDisabledProviders = options
        .disabledProviders()
        .filter((id) => id !== localProviderId && id !== existingImported?.providerId);
      options.setDisabledProviders(nextDisabledProviders);
      options.markOpencodeConfigReloadRequired();
      await refreshProviders({ dispose: true });
      refreshSnapshot();
      emitChange();
      return `${t("status.connected")} ${provider.name}`;
    } catch (error) {
      const message = describeProviderError(error, "Failed to connect organization provider.");
      if (!optionsArg?.silent) {
        setStateField("providerAuthError", message);
      }
      throw error instanceof Error ? error : new Error(message);
    }
  }

  async function connectCloudProvider(cloudProviderId: string) {
    return await connectCloudProviderInternal(cloudProviderId);
  }

  async function removeCloudProviderInternal(
    cloudProviderId: string,
    optionsArg?: { silent?: boolean },
  ) {
    if (!optionsArg?.silent) {
      setStateField("providerAuthError", null);
    }
    const imported = state.importedCloudProviders[cloudProviderId];
    if (!imported) {
      throw new Error("This cloud provider has not been imported into the workspace.");
    }

    try {
      try {
        await removeProviderAuthCredentials(imported.providerId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error ?? "");
        if (!/not found|unknown auth|404/i.test(message.toLowerCase())) {
          throw error;
        }
      }
      const updatedConfig = await updateProjectConfigFile((raw) =>
        formatConfigWithoutCloudProvider(raw, imported.providerId),
      );
      if (!updatedConfig) {
        throw new Error("Could not update opencode.jsonc for this workspace.");
      }

      const nextImportedProviders = { ...state.importedCloudProviders };
      delete nextImportedProviders[cloudProviderId];
      await persistImportedCloudProviders(nextImportedProviders);

      options.setDisabledProviders(
        options.disabledProviders().filter((id) => id !== imported.providerId),
      );
      options.markOpencodeConfigReloadRequired();
      refreshSnapshot();
      emitChange();
      return `${t("providers.disconnected_prefix")} ${imported.name}`;
    } catch (error) {
      const message = describeProviderError(error, t("providers.disconnect_failed"));
      if (!optionsArg?.silent) {
        setStateField("providerAuthError", message);
      }
      throw error instanceof Error ? error : new Error(message);
    }
  }

  async function removeCloudProvider(cloudProviderId: string) {
    return await removeCloudProviderInternal(cloudProviderId);
  }

  const logCloudProviderSyncError = (reason: CloudProviderSyncReason, error: unknown) => {
    const message = describeProviderError(error, "Cloud provider sync failed.");
    console.warn(`[cloud-provider-sync:${reason}] ${message}`);
    return message;
  };

  const getCloudProviderSyncContextKey = () => {
    const settings = readDenSettings();
    return [
      settings.baseUrl,
      settings.apiBaseUrl ?? "",
      settings.activeOrgId?.trim() ?? "",
      settings.authToken?.trim() ?? "",
      options.selectedWorkspaceDisplay().workspaceType,
      options.selectedWorkspaceRoot().trim(),
      options.runtimeWorkspaceId() ?? "",
      options.client() ? "connected" : "disconnected",
    ].join("::");
  };

  const hasCloudProviderSyncPrerequisites = () => {
    const settings = readDenSettings();
    const workspaceTarget =
      options.selectedWorkspaceRoot().trim() || options.runtimeWorkspaceId() || "";
    return Boolean(
      options.client() &&
        settings.authToken?.trim() &&
        settings.activeOrgId?.trim() &&
        workspaceTarget,
    );
  };

  const isCloudProviderOutOfSync = (
    provider: DenOrgLlmProvider,
    importedProvider: CloudImportedProvider,
  ) =>
    importedProvider.providerId !== getCloudManagedProviderId(provider) ||
    importedProvider.sourceProviderId !== provider.providerId ||
    (importedProvider.source ?? null) !== provider.source ||
    (importedProvider.updatedAt ?? null) !== (provider.updatedAt ?? null) ||
    !sameStringList(importedProvider.modelIds, sortStrings(provider.models.map((model) => model.id)));

  async function performCloudProviderSync(reason: CloudProviderSyncReason) {
    if (!hasCloudProviderSyncPrerequisites()) {
      return;
    }

    const [importedProviders, liveProviders] = await Promise.all([
      refreshImportedCloudProviders(),
      refreshCloudOrgProviders({ force: true }),
    ]);
    const liveProviderMap = new Map(liveProviders.map((provider) => [provider.id, provider]));
    const failures: string[] = [];
    const processedLiveProviderIds = new Set<string>();
    let configChanged = false;

    for (const importedProvider of Object.values(importedProviders)) {
      const liveProvider = liveProviderMap.get(importedProvider.cloudProviderId);
      if (!liveProvider) {
        try {
          await removeCloudProviderInternal(importedProvider.cloudProviderId, { silent: true });
          configChanged = true;
        } catch (error) {
          failures.push(logCloudProviderSyncError(reason, error));
        }
        continue;
      }

      processedLiveProviderIds.add(liveProvider.id);

      if (!isCloudProviderOutOfSync(liveProvider, importedProvider)) {
        continue;
      }

      try {
        await removeCloudProviderInternal(importedProvider.cloudProviderId, { silent: true });
        await connectCloudProviderInternal(liveProvider.id, { silent: true });
        configChanged = true;
      } catch (error) {
        failures.push(logCloudProviderSyncError(reason, error));
      }
    }

    const nextImportedProviders = state.importedCloudProviders;
    const newlyImported: Array<{ id: string; name: string; providerId: string; firstModelId?: string; firstModelName?: string }> = [];
    for (const liveProvider of liveProviders) {
      if (processedLiveProviderIds.has(liveProvider.id)) {
        continue;
      }
      if (nextImportedProviders[liveProvider.id]) {
        continue;
      }

      try {
        await connectCloudProviderInternal(liveProvider.id, { silent: true });
        configChanged = true;
        const firstModel = liveProvider.models[0] ?? null;
        newlyImported.push({
          id: liveProvider.id,
          name: liveProvider.name,
          providerId: liveProvider.providerId,
          firstModelId: firstModel?.id,
          firstModelName: firstModel?.name ?? firstModel?.id,
        });
      } catch (error) {
        failures.push(logCloudProviderSyncError(reason, error));
      }
    }

    if (configChanged) {
      await refreshProviders({ dispose: true }).catch(() => null);
    }

    // Notify the UI about newly imported providers so the global toast
    // can be shown regardless of which route is active.
    if (newlyImported.length > 0) {
      dispatchNewProviders({
        providers: newlyImported,
        source: reason === "sign_in" ? "sign_in" : "cloud_sync",
      });
    }

    if (failures.length > 0) {
      throw new Error(failures.join("\n"));
    }
  }

  async function runCloudProviderSync(reason: CloudProviderSyncReason) {
    if (cloudProviderSyncInFlight) {
      cloudProviderSyncQueuedReason = reason;
      return cloudProviderSyncInFlight;
    }

    const request = performCloudProviderSync(reason)
      .catch((error) => {
        const message = logCloudProviderSyncError(reason, error);
        if (reason === "settings_cloud_opened") {
          setStateField("providerAuthError", message);
        }
      })
      .finally(() => {
        cloudProviderSyncInFlight = null;
        const queuedReason = cloudProviderSyncQueuedReason;
        cloudProviderSyncQueuedReason = null;
        if (queuedReason) {
          void runCloudProviderSync(queuedReason);
        }
      });

    cloudProviderSyncInFlight = request;
    return request;
  }

  async function disconnectProvider(providerId: string) {
    setStateField("providerAuthError", null);
    const c = options.client();
    if (!c) {
      throw new Error(t("providers.not_connected"));
    }

    const resolved = providerId.trim();
    if (!resolved) {
      throw new Error(t("providers.provider_id_required"));
    }

    const trackedImport = Object.values(state.importedCloudProviders).find(
      (entry) => entry.providerId === resolved,
    );
    if (trackedImport) {
      return await removeCloudProvider(trackedImport.cloudProviderId);
    }

    try {
      await removeProviderAuthCredentials(resolved);
      const updated = await refreshProviders({ dispose: true });
      if (Array.isArray(updated?.connected) && updated.connected.includes(resolved)) {
        // Provider is still connected (e.g. via env var). Just remove
        // stored credentials; do NOT add to disabled_providers.
        return `Removed stored credentials for ${resolved}${t("providers.still_connected_suffix")}`;
      }
      removeProviderFromState(resolved);
      return `${t("providers.disconnected_prefix")} ${resolved}`;
    } catch (error) {
      const message = describeProviderError(error, t("providers.disconnect_failed"));
      setStateField("providerAuthError", message);
      throw error instanceof Error ? error : new Error(message);
    }
  }

  async function openProviderAuthModal(optionsArg?: {
    returnFocusTarget?: ProviderReturnFocusTarget;
    preferredProviderId?: string;
  }) {
    mutateState((current) => ({
      ...current,
      providerAuthReturnFocusTarget: optionsArg?.returnFocusTarget ?? "none",
      providerAuthPreferredProviderId: optionsArg?.preferredProviderId?.trim() || null,
      providerAuthBusy: true,
      providerAuthError: null,
    }));

    try {
      const methods = await loadProviderAuthMethods(getProviderAuthWorkerType());
      mutateState((current) => ({
        ...current,
        providerAuthMethods: methods,
        providerAuthModalOpen: true,
      }));
    } catch (error) {
      const message = describeProviderError(error, t("providers.load_failed"));
      mutateState((current) => ({
        ...current,
        providerAuthPreferredProviderId: null,
        providerAuthReturnFocusTarget: "none",
        providerAuthError: message,
      }));
      throw error;
    } finally {
      setStateField("providerAuthBusy", false);
    }
  }

  function closeProviderAuthModal(optionsArg?: { restorePromptFocus?: boolean }) {
    const shouldFocusPrompt =
      optionsArg?.restorePromptFocus ?? state.providerAuthReturnFocusTarget === "composer";
    mutateState((current) => ({
      ...current,
      providerAuthModalOpen: false,
      providerAuthError: null,
      providerAuthPreferredProviderId: null,
      providerAuthReturnFocusTarget: "none",
    }));
    if (shouldFocusPrompt) {
      options.focusPromptSoon?.();
    }
  }

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const currentWorkspaceKey = () =>
    `${options.selectedWorkspaceRoot().trim()}::${options.runtimeWorkspaceId() ?? ""}`;

  const syncFromOptions = () => {
    const workspaceKey = currentWorkspaceKey();
    const workspaceChanged = workspaceKey !== lastWorkspaceKey;
    lastWorkspaceKey = workspaceKey;
    refreshSnapshot();
    emitChange();
    if (workspaceChanged) {
      void refreshImportedCloudProviders();
    }
    if (!hasCloudProviderSyncPrerequisites()) {
      cloudProviderSyncContextKey = "";
      return;
    }

    const nextSyncContextKey = getCloudProviderSyncContextKey();
    if (nextSyncContextKey === cloudProviderSyncContextKey) {
      return;
    }

    cloudProviderSyncContextKey = nextSyncContextKey;
    void runCloudProviderSync("app_launch");
  };

  const start = () => {
    if (started) return;
    // StrictMode double-mount re-arms after dispose.
    disposed = false;
    started = true;
    lastWorkspaceKey = currentWorkspaceKey();
    if (typeof window !== "undefined") {
      const handleDenSessionUpdate = (event: Event) => {
        cloudOrgProvidersLoadKey = "";
        cloudOrgProvidersInFlightKey = "";
        cloudOrgProvidersInFlight = null;
        const detail = (event as CustomEvent<DenSessionUpdatedDetail>).detail;

        if (detail?.status === "success") {
          mutateState((current) => ({
            ...current,
            cloudOrgProviders: [],
            providerAuthMethods: {},
          }));
          void runCloudProviderSync("sign_in");
        } else {
          // Sign-out or error: remove all cloud-imported providers from the workspace
          // Capture the full import records BEFORE clearing state
          const importedProviders = { ...state.importedCloudProviders };
          const importedIds = Object.keys(importedProviders);

          // Best-effort cleanup: remove each cloud provider from opencode.jsonc
          // BEFORE clearing state so removeCloudProviderInternal can find the records
          void (async () => {
            for (const cloudId of importedIds) {
              try {
                await removeCloudProviderInternal(cloudId, { silent: true });
              } catch {
                // Ignore individual removal failures during sign-out cleanup
              }
            }
            // Final sweep: remove any orphan `lpr_*` provider keys that remain
            // in opencode.jsonc but weren't tracked in importedCloudProviders
            // (e.g. from a previous failed cleanup or external edit).
            try {
              const orphans = await sweepOrphanCloudProvidersFromConfig();
              for (const providerId of orphans) {
                try {
                  await removeProviderAuthCredentials(providerId);
                } catch {
                  // Ignore auth removal failures for orphans
                }
              }
              if (orphans.length > 0) {
                options.markOpencodeConfigReloadRequired();
              }
            } catch {
              // Ignore sweep failures during sign-out cleanup
            }
            // Clear state AFTER cleanup so the records are available during removal
            mutateState((current) => ({
              ...current,
              cloudOrgProviders: [],
              providerAuthMethods: {},
              importedCloudProviders: {},
            }));
            refreshSnapshot();
            emitChange();
          })();
        }
      };
      window.addEventListener(
        denSessionUpdatedEvent,
        handleDenSessionUpdate as EventListener,
      );
      denSessionCleanup = () => {
        window.removeEventListener(
          denSessionUpdatedEvent,
          handleDenSessionUpdate as EventListener,
        );
      };
    }
    void refreshImportedCloudProviders().then((imported) => {
      // Startup cleanup: if no auth token, remove any cloud providers that
      // were left behind. Handles orphans from a previous sign-out that
      // didn't clean up (e.g. crash, force-quit, external edit).
      if (!hasCloudProviderSyncPrerequisites()) {
        void (async () => {
          // First: remove anything tracked in import state
          if (imported && Object.keys(imported).length > 0) {
            for (const cloudId of Object.keys(imported)) {
              try {
                await removeCloudProviderInternal(cloudId, { silent: true });
              } catch {}
            }
          }
          // Then: sweep any `lpr_*` keys that remain in opencode.jsonc
          try {
            const orphans = await sweepOrphanCloudProvidersFromConfig();
            for (const providerId of orphans) {
              try {
                await removeProviderAuthCredentials(providerId);
              } catch {}
            }
            if (orphans.length > 0) {
              options.markOpencodeConfigReloadRequired();
            }
          } catch {}
          mutateState((current) => ({
            ...current,
            importedCloudProviders: {},
          }));
          refreshSnapshot();
          emitChange();
        })();
      }
    });
    refreshSnapshot();
    emitChange();
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    started = false;
    denSessionCleanup?.();
    denSessionCleanup = null;
    listeners.clear();
  };

  refreshSnapshot();

  return {
    subscribe,
    getSnapshot: () => snapshot,
    start,
    dispose,
    syncFromOptions,
    refreshCloudOrgProviders,
    runCloudProviderSync,
    startProviderAuth,
    refreshProviders,
    completeProviderAuthOAuth,
    submitProviderApiKey,
    connectCloudProvider,
    removeCloudProvider,
    disconnectProvider,
    ensureProjectProviderDisabledState,
    openProviderAuthModal,
    closeProviderAuthModal,
  };
}

export function useProviderAuthStoreSnapshot(store: ProviderAuthStore) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
