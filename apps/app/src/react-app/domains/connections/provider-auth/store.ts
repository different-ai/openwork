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
} from "../../../../app/lib/tauri";
import type {
  Client,
  ProviderListItem,
  WorkspaceDisplay,
} from "../../../../app/types";
import { isTauriRuntime, safeStringify } from "../../../../app/utils";
import {
  compareProviders,
  filterProviderList,
  mapConfigProvidersToList,
} from "../../../../app/utils/providers";
import type { OpenworkServerStore } from "../openwork-server-store";
import {
  readWorkspaceCloudImports,
  withWorkspaceCloudImports,
  type CloudImportedProvider,
} from "../../../../app/cloud/import-state";

type ProviderReturnFocusTarget = "none" | "composer";

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
  selectedWorkspaceDisplay: () => WorkspaceDisplay;
  selectedWorkspaceRoot: () => string;
  runtimeWorkspaceId: () => string | null;
  openworkServer: OpenworkServerStore;
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

  const getProviderAuthWorkerType = (): "local" | "remote" =>
    options.selectedWorkspaceDisplay().workspaceType === "remote" ? "remote" : "local";

  const getProviderAuthProviders = (): ProviderAuthProvider[] => {
    const merged = new Map<string, ProviderAuthProvider>();

    for (const provider of options.providers()) {
      const id = provider.id?.trim();
      if (!id) continue;
      merged.set(id, {
        id,
        name: provider.name?.trim() || id,
        env: Array.isArray(provider.env) ? provider.env : [],
      });
    }

    for (const provider of state.cloudOrgProviders) {
      const id = provider.providerId.trim();
      if (!id || merged.has(id)) continue;
      merged.set(id, {
        id,
        name: provider.name.trim() || id,
        env: getCloudProviderEnv(provider.providerConfig),
      });
    }

    return [...merged.values()].sort(compareProviders);
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
    const openworkSnapshot = options.openworkServer.getSnapshot();
    const openworkClient = openworkSnapshot.openworkServerClient;
    const openworkWorkspaceId = options.runtimeWorkspaceId();
    const openworkCapabilities = openworkSnapshot.openworkServerCapabilities;
    const canUseOpenworkServer =
      openworkSnapshot.openworkServerStatus === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkCapabilities?.config?.read;

    if (canUseOpenworkServer) {
      const config = await openworkClient.getConfig(openworkWorkspaceId);
      return config.openwork ?? {};
    }

    if (isLocalWorkspace && isTauriRuntime() && root) {
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
    const openworkSnapshot = options.openworkServer.getSnapshot();
    const openworkClient = openworkSnapshot.openworkServerClient;
    const openworkWorkspaceId = options.runtimeWorkspaceId();
    const openworkCapabilities = openworkSnapshot.openworkServerCapabilities;
    const canUseOpenworkServer =
      openworkSnapshot.openworkServerStatus === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkCapabilities?.config?.write;

    if (canUseOpenworkServer) {
      await openworkClient.patchConfig(openworkWorkspaceId, { openwork: config });
      return true;
    }

    if (isLocalWorkspace && isTauriRuntime() && root) {
      const result = await workspaceOpenworkWrite({
        workspacePath: root,
        config: config as never,
      });
      if (!result.ok) {
        throw new Error(
          result.stderr || result.stdout || "Failed to write .opencode/openwork.json",
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
    const nextConfig = withWorkspaceCloudImports(config, {
      ...cloudImports,
      providers: nextProviders,
    });
    const persisted = await writeWorkspaceOpenworkConfigRecord(nextConfig);
    if (!persisted) {
      throw new Error(
        "OpenWork server unavailable. Connect to manage imported cloud providers.",
      );
    }
    setStateField("importedCloudProviders", nextProviders);
  };

  const readProjectConfigFile = async () => {
    const root = options.selectedWorkspaceRoot().trim();
    const isLocalWorkspace =
      options.selectedWorkspaceDisplay().workspaceType === "local";
    const openworkSnapshot = options.openworkServer.getSnapshot();
    const openworkClient = openworkSnapshot.openworkServerClient;
    const openworkWorkspaceId = options.runtimeWorkspaceId();
    const openworkCapabilities = openworkSnapshot.openworkServerCapabilities;
    const canUseOpenworkServer =
      openworkSnapshot.openworkServerStatus === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkCapabilities?.config?.read &&
      typeof openworkClient.readOpencodeConfigFile === "function";

    if (canUseOpenworkServer) {
      return await openworkClient.readOpencodeConfigFile(openworkWorkspaceId, "project");
    }

    if (isLocalWorkspace && isTauriRuntime() && root) {
      return await readOpencodeConfig("project", root);
    }

    return null;
  };

  const writeProjectConfigFile = async (content: string) => {
    const root = options.selectedWorkspaceRoot().trim();
    const isLocalWorkspace =
      options.selectedWorkspaceDisplay().workspaceType === "local";
    const openworkSnapshot = options.openworkServer.getSnapshot();
    const openworkClient = openworkSnapshot.openworkServerClient;
    const openworkWorkspaceId = options.runtimeWorkspaceId();
    const openworkCapabilities = openworkSnapshot.openworkServerCapabilities;
    const canUseOpenworkServer =
      openworkSnapshot.openworkServerStatus === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkCapabilities?.config?.write &&
      typeof openworkClient.writeOpencodeConfigFile === "function";

    if (canUseOpenworkServer) {
      const result = await openworkClient.writeOpencodeConfigFile(
        openworkWorkspaceId,
        "project",
        content,
      );
      if (!result.ok) {
        throw new Error(result.stderr || result.stdout || "Failed to write opencode.jsonc");
      }
      return true;
    }

    if (isLocalWorkspace && isTauriRuntime() && root) {
      const result = await writeOpencodeConfig("project", root, content);
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
    const configFile = await readProjectConfigFile();
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
    provider: Pick<DenOrgLlmProvider, "id" | "name" | "providerId">,
  ) => {
    const withoutExisting = removeCloudProviderComment(raw, provider.providerId);
    const propertyPattern = new RegExp(
      `^([ \t]*)"${escapeRegExp(provider.providerId)}":`,
      "m",
    );
    return withoutExisting.replace(
      propertyPattern,
      `$1${cloudProviderComment(provider)}\n$1"${provider.providerId}":`,
    );
  };

  const getProviderModelIds = (provider: Pick<DenOrgLlmProvider, "models">) =>
    provider.models.map((model) => model.id.trim()).filter(Boolean).sort();

  const formatConfigWithCloudProvider = (
    raw: string,
    provider: DenOrgLlmProviderConnection,
    previousProviderId?: string | null,
  ) => {
    const nextProviderConfig = buildCloudProviderConfig(
      provider,
    ) as unknown as Record<string, unknown>;
    let updated = raw.trim()
      ? raw
      : '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';

    if (previousProviderId && previousProviderId !== provider.providerId) {
      updated = removeCloudProviderComment(updated, previousProviderId);
      const previousEdits = modify(updated, ["provider", previousProviderId], undefined, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      });
      updated = applyEdits(updated, previousEdits);
    }

    const providerEdits = modify(updated, ["provider", provider.providerId], nextProviderConfig, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    });
    updated = applyEdits(updated, providerEdits);
    updated = addCloudProviderComment(updated, provider);

    const disabledToRemove = new Set([provider.providerId, previousProviderId ?? ""]);
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

  const assertCloudProviderImportSafe = async (
    provider: DenOrgLlmProviderConnection,
  ) => {
    const existingImported = Object.values(state.importedCloudProviders).find(
      (entry) => entry.providerId === provider.providerId,
    );
    if (existingImported && existingImported.cloudProviderId !== provider.id) {
      throw new Error(
        `${provider.providerId} is already imported from ${existingImported.name}. Remove it before importing a different cloud provider.`,
      );
    }

    if (!existingImported && options.providerConnectedIds().includes(provider.providerId)) {
      throw new Error(
        `${provider.providerId} is already connected in this workspace. Disconnect it before importing the cloud-managed version.`,
      );
    }

    const configFile = await readProjectConfigFile();
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
      provider.providerId in (providerSection as Record<string, unknown>)
    ) {
      throw new Error(
        `${provider.providerId} already has a provider block in opencode.jsonc. Remove it before importing the cloud-managed version.`,
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

    const client = createDenClient({ baseUrl: settings.baseUrl, token });
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

  const applyProviderListState = (value: ProviderListResponse) => {
    options.setProviders(value.all ?? []);
    options.setProviderDefaults(value.default ?? {});
    options.setProviderConnectedIds(value.connected ?? []);
    refreshSnapshot();
    emitChange();
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
      if (provider) return t("providers.provider_error", undefined, { provider });
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
      if (!id || id === "opencode") continue;
      if (!Array.isArray(provider.env) || provider.env.length === 0) continue;
      const existing = merged[id] ?? [];
      if (existing.some((method) => method.type === "api")) continue;
      merged[id] = [...existing, { type: "api", label: t("providers.api_key_label") }];
    }

    for (const [id, providerMethods] of Object.entries(merged)) {
      const provider = availableProviders.find((item) => item.id === id);
      const normalizedId = id.trim().toLowerCase();
      const normalizedName = provider?.name?.trim().toLowerCase() ?? "";
      const isOpenAiProvider = normalizedId === "openai" || normalizedName === "openai";
      if (!isOpenAiProvider) continue;
      merged[id] = providerMethods.filter((method) => {
        if (method.type !== "oauth") return true;
        const label = method.label.toLowerCase();
        const isHeadless = label.includes("headless") || label.includes("device");
        return workerType === "remote" ? isHeadless : !isHeadless;
      });
    }

    for (const provider of cloudProviders) {
      const id = provider.providerId.trim();
      if (!id) continue;
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
      try {
        unwrap(await c.instance.dispose());
      } catch {
        // ignore dispose failures and try reading current state anyway
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
        unwrap(await activeClient.provider.list()),
        disabledProviders,
      );
      applyProviderListState(updated);
      return updated;
    } catch {
      try {
        const fallback = unwrap(await activeClient.config.providers());
        const mapped = mapConfigProvidersToList(fallback.providers);
        const next = filterProviderList(
          {
            all: mapped,
            connected: options
              .providerConnectedIds()
              .filter((id) => mapped.some((provider) => provider.id === id)),
            default: fallback.default,
          },
          disabledProviders,
        );
        applyProviderListState(next);
        return next;
      } catch {
        return null;
      }
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

    if (!Number.isInteger(methodIndex) || methodIndex < 0) {
      throw new Error(t("providers.oauth_method_required"));
    }

    const waitForProviderConnection = async (timeoutMs = 15000, pollMs = 2000) => {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        try {
          const updated = await refreshProviders({ dispose: true });
          if (Array.isArray(updated?.connected) && updated.connected.includes(resolved)) {
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

  async function connectCloudProvider(cloudProviderId: string) {
    setStateField("providerAuthError", null);
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
      const den = createDenClient({ baseUrl: settings.baseUrl, token });
      const provider = await den.getOrgLlmProviderConnection(orgId, cloudProviderId);
      const existingImported = state.importedCloudProviders[cloudProviderId] ?? null;
      const apiKey = provider.apiKey?.trim() ?? "";
      const env = getCloudProviderEnv(provider.providerConfig);
      if (!apiKey && env.length > 0) {
        throw new Error(`${provider.name} does not have a stored organization credential yet.`);
      }

      await assertCloudProviderImportSafe(provider);

      if (apiKey) {
        await c.auth.set({
          providerID: provider.providerId,
          auth: { type: "api", key: apiKey },
        });
      }
      if (existingImported?.providerId && existingImported.providerId !== provider.providerId) {
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
        formatConfigWithCloudProvider(raw, provider, existingImported?.providerId ?? null),
      );
      if (!updatedConfig) {
        throw new Error("Could not update opencode.jsonc for this workspace.");
      }

      const nextImportedProviders = {
        ...state.importedCloudProviders,
        [provider.id]: {
          cloudProviderId: provider.id,
          providerId: provider.providerId,
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
        .filter((id) => id !== provider.providerId && id !== existingImported?.providerId);
      options.setDisabledProviders(nextDisabledProviders);
      options.markOpencodeConfigReloadRequired();
      refreshSnapshot();
      emitChange();
      return `${t("status.connected")} ${provider.name}`;
    } catch (error) {
      const message = describeProviderError(error, "Failed to connect organization provider.");
      setStateField("providerAuthError", message);
      throw error instanceof Error ? error : new Error(message);
    }
  }

  async function removeCloudProvider(cloudProviderId: string) {
    setStateField("providerAuthError", null);
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
      setStateField("providerAuthError", message);
      throw error instanceof Error ? error : new Error(message);
    }
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

    const provider = options.providers().find((entry) => entry.id === resolved) as
      | (ProviderListItem & { source?: string })
      | undefined;
    const canDisableProvider = provider?.source === "config" || provider?.source === "custom";

    const disableProvider = async () => {
      const config = unwrap(await c.config.get());
      const disabledProviders = Array.isArray(config.disabled_providers)
        ? config.disabled_providers
        : [];
      if (disabledProviders.includes(resolved)) {
        return false;
      }

      const next = [...disabledProviders, resolved];
      options.setDisabledProviders(next);
      try {
        const result = await c.config.update({
          config: { ...config, disabled_providers: next },
        });
        assertNoClientError(result);
        options.markOpencodeConfigReloadRequired();
      } catch (error) {
        options.setDisabledProviders(disabledProviders);
        throw error;
      }
      refreshSnapshot();
      emitChange();
      return true;
    };

    try {
      await removeProviderAuthCredentials(resolved);
      let updated = await refreshProviders({ dispose: true });
      if (canDisableProvider && Array.isArray(updated?.connected) && updated.connected.includes(resolved)) {
        const disabled = await disableProvider();
        if (disabled && updated) {
          updated = filterProviderList(updated, options.disabledProviders() ?? []);
          applyProviderListState(updated);
        }
        if (!Array.isArray(updated?.connected) || !updated.connected.includes(resolved)) {
          return disabled
            ? `${t("providers.disconnected_prefix")} ${resolved} ${t("providers.disabled_in_config_suffix")}`
            : `${t("providers.disconnected_prefix")} ${resolved}.`;
        }
      }

      if (Array.isArray(updated?.connected) && updated.connected.includes(resolved)) {
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
  };

  const start = () => {
    if (started || disposed) return;
    started = true;
    lastWorkspaceKey = currentWorkspaceKey();
    if (typeof window !== "undefined") {
      const handleDenSessionUpdate = () => {
        cloudOrgProvidersLoadKey = "";
        cloudOrgProvidersInFlightKey = "";
        cloudOrgProvidersInFlight = null;
        mutateState((current) => ({
          ...current,
          cloudOrgProviders: [],
          providerAuthMethods: {},
        }));
      };
      window.addEventListener(
        "openwork-den-session-updated",
        handleDenSessionUpdate as EventListener,
      );
      denSessionCleanup = () => {
        window.removeEventListener(
          "openwork-den-session-updated",
          handleDenSessionUpdate as EventListener,
        );
      };
    }
    void refreshImportedCloudProviders();
    refreshSnapshot();
    emitChange();
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
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
    startProviderAuth,
    refreshProviders,
    completeProviderAuthOAuth,
    submitProviderApiKey,
    connectCloudProvider,
    removeCloudProvider,
    disconnectProvider,
    openProviderAuthModal,
    closeProviderAuthModal,
  };
}

export function useProviderAuthStoreSnapshot(store: ProviderAuthStore) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
