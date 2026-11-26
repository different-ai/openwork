import { buildManagedProviderConfig, readProviderEnvNames, selectPrimaryCredentialEnvName } from "@openwork/types/managed-provider-config";
import { applyEdits, modify } from "jsonc-parser";
import type { ProviderConfig } from "@opencode-ai/sdk/v2/client";
import type { GatewayUsableModel } from "@openwork/types/den/gateway";
import { AUTO_ROUTER_PROVIDER_ID } from "@openwork/types/den/auto-router";
import type { ModelOption, ModelRef } from "@/app/types";
import { catalogModelVariants, CLOUD_MODEL_CONFIG_VERSION } from "@openwork/types/cloud-model-fast";

import type {
  DenOrgLlmProvider,
  DenOrgLlmProviderConnection,
} from "../../../../app/lib/den";
import type { CloudImportedProvider } from "../../../../app/cloud/import-state";

const getStringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.trim().length > 0,
      )
    : [];

const sameStringList = (a: string[], b: string[]) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const removeCloudProviderComment = (raw: string, providerId: string) =>
  raw.replace(
    new RegExp(
      `(^[ \t]*)// OpenWork Cloud import:.*\\n\\1(?="${escapeRegExp(providerId)}":)`,
      "m",
    ),
    "$1",
  );

export const getCloudProviderEnv = readProviderEnvNames;

export const resolveCloudProviderCredentials = (
  provider: Pick<
    DenOrgLlmProviderConnection,
    "apiKey" | "apiKeys" | "providerConfig"
  >,
) => {
  const apiKeys = provider.apiKeys ?? {};
  const envNames = getCloudProviderEnv(provider.providerConfig);
  const orderedNames = [
    ...envNames.filter((name) => name in apiKeys),
    ...Object.keys(apiKeys).filter((name) => !envNames.includes(name)),
  ];
  const envEntries = orderedNames.flatMap((name) => {
    const value = apiKeys[name]?.trim();
    return value ? [{ key: name, value }] : [];
  });
  const primaryCredentialEnvName = selectPrimaryCredentialEnvName(
    envNames,
    envEntries.map((entry) => entry.key),
  );
  const primaryApiKey =
    provider.apiKey?.trim() ||
    envEntries.find((entry) => entry.key === primaryCredentialEnvName)?.value ||
    "";
  return { envEntries, primaryApiKey };
};

export const getCloudManagedProviderId = (
  provider: Pick<DenOrgLlmProvider, "id" | "providerId" | "source">,
) => (provider.source === "openwork" ? "openwork" : provider.id.trim());

export const isCloudManagedProviderKey = (providerId: string) =>
  /^(lpr|ipr)_/i.test(providerId) || providerId.trim() === "openwork" || providerId.trim() === AUTO_ROUTER_PROVIDER_ID;

export const OPENWORK_GATEWAY_PROVIDER_SOURCE = "openwork_gateway";
export const OPENWORK_GATEWAY_BADGE_LABEL = "via OpenWork Gateway";

export type GatewayConnectProvider = {
  cloudProviderId: string;
  credentialSetId?: string;
  models?: GatewayUsableModel[];
  providerId: string;
  sourceProviderId?: string;
  name: string;
  authUrl: string | null;
};

export const gatewayConnectProviderKey = (provider: { cloudProviderId: string; credentialSetId?: string }) =>
  provider.credentialSetId ? `${provider.cloudProviderId}:${provider.credentialSetId}` : provider.cloudProviderId;

export function isGatewaySetConnected(provider: GatewayConnectProvider, imported: Record<string, CloudImportedProvider>) {
  const ready = imported[provider.cloudProviderId];
  if (!ready) return false;
  if (!provider.credentialSetId) return true;
  const suffix = provider.credentialSetId.slice(4);
  return ready.modelIds.some((id) => id.startsWith("gwm_") && id.split("_")[2] === suffix);
}

export const GATEWAY_MEMBER_AUTH_REQUIRED_REASON = "member_auth_required";

export const gatewayConnectCopy = (name: string) => `Sign in to ${name} to use it`;

export const resolveGatewayConnectProviders = (
  skippedProviders:
    | Record<string, { cloudProviderId: string; credentialSetId?: string; models?: GatewayUsableModel[]; providerId: string; sourceProviderId?: string; name: string; reason: string; authUrl?: string | null }>
    | undefined
    | null,
): GatewayConnectProvider[] =>
  Object.values(skippedProviders ?? {})
    .filter((provider) => provider.reason === GATEWAY_MEMBER_AUTH_REQUIRED_REASON)
    .map((provider) => ({
      cloudProviderId: provider.cloudProviderId,
      credentialSetId: provider.credentialSetId,
      ...(provider.models === undefined ? {} : { models: provider.models }),
      providerId: provider.providerId,
      ...(provider.sourceProviderId ? { sourceProviderId: provider.sourceProviderId } : {}),
      name: provider.name,
      authUrl: provider.authUrl ?? null,
    }));

export type LiveGatewayProvider = {
  id: string;
  providerId: string;
  name: string;
  credentialStatus: "ready" | "member_auth_required" | "org_credential_missing";
  updatedAt: string;
  models: GatewayUsableModel[];
  authorizationRequests: { credentialSetId: string; name: string; authUrl: string; models?: GatewayUsableModel[] }[];
};

export const resolveLiveGatewayConnectProviders = (providers: readonly LiveGatewayProvider[]): GatewayConnectProvider[] =>
  providers.flatMap((provider) => {
    const sourceProviderId = provider.providerId.trim();
    const connectProvider = {
      cloudProviderId: provider.id,
      providerId: provider.id,
      ...(sourceProviderId ? { sourceProviderId } : {}),
      authUrl: null,
    };
    const requests = provider.authorizationRequests.map((request) => ({
      ...connectProvider,
      credentialSetId: request.credentialSetId,
      ...(request.models === undefined ? {} : { models: request.models }),
      name: `${provider.name} / ${request.name}`,
    }));
    if (requests.length > 0 || provider.models.length > 0 || provider.credentialStatus !== GATEWAY_MEMBER_AUTH_REQUIRED_REASON) return requests;
    return [{ ...connectProvider, name: provider.name }];
  });

export const resolveLiveGatewayReadyProviders = (
  providers: readonly LiveGatewayProvider[] | null,
  listedCloudProviderIds: readonly string[] = [],
): LiveGatewayProvider[] =>
  (providers ?? []).filter((provider) => provider.models.length > 0 && !listedCloudProviderIds.includes(provider.id));

export const resolveLiveGatewayImportedProviders = (providers: readonly LiveGatewayProvider[]): Record<string, CloudImportedProvider> =>
  Object.fromEntries(providers.filter((provider) => provider.models.length > 0).map((provider) => [provider.id, {
    cloudProviderId: provider.id,
    providerId: provider.id,
    sourceProviderId: provider.providerId,
    name: provider.name,
    source: OPENWORK_GATEWAY_PROVIDER_SOURCE,
    updatedAt: provider.updatedAt || null,
    modelIds: provider.models.map((model) => model.id).sort(),
    importedAt: null,
  } satisfies CloudImportedProvider]));

export function isLiveGatewaySetConnected(provider: GatewayConnectProvider, providers: readonly LiveGatewayProvider[]) {
  const live = providers.find((entry) => entry.id === provider.cloudProviderId);
  if (!live) return false;
  if (provider.credentialSetId) {
    const suffix = provider.credentialSetId.slice(4);
    return !live.authorizationRequests.some((request) => request.credentialSetId === provider.credentialSetId)
      && live.models.some((model) => model.id.split("_")[2] === suffix);
  }
  return live.models.length > 0;
}

export function resolvePendingGatewaySignIns(input: {
  signedIn: boolean;
  liveGatewayProviders: readonly LiveGatewayProvider[] | null;
  skippedProviders: Parameters<typeof resolveGatewayConnectProviders>[0];
}): GatewayConnectProvider[] {
  if (!input.signedIn) return [];
  return input.liveGatewayProviders !== null
    ? resolveLiveGatewayConnectProviders(input.liveGatewayProviders)
    : resolveGatewayConnectProviders(input.skippedProviders);
}

export function isPendingGatewaySignInConnected(
  provider: GatewayConnectProvider,
  snapshot: { liveGatewayProviders: readonly LiveGatewayProvider[] | null; importedCloudProviders: Record<string, CloudImportedProvider> },
) {
  return snapshot.liveGatewayProviders === null
    ? isGatewaySetConnected(provider, snapshot.importedCloudProviders)
    : isLiveGatewaySetConnected(provider, snapshot.liveGatewayProviders);
}

export function pendingGatewayModelOptions(providers: readonly GatewayConnectProvider[]): ModelOption[] {
  return providers.flatMap((provider) => (provider.models ?? []).flatMap((model) => {
    if (!provider.credentialSetId || model.credentialSetId !== provider.credentialSetId) return [];
    return [{
      providerID: provider.providerId, modelID: model.id, title: model.name,
      description: provider.name, footer: "Sign-in required", source: "cloud",
      behaviorTitle: "Reasoning", behaviorLabel: "Default", behaviorDescription: "",
      behaviorValue: null, isFree: false,
      gatewayAuthorization: { cloudProviderId: provider.cloudProviderId, credentialSetId: provider.credentialSetId },
    } satisfies ModelOption];
  }));
}

export function isGatewayModelReady(
  provider: GatewayConnectProvider,
  model: ModelRef,
  snapshot: { importedCloudProviders: Record<string, CloudImportedProvider>; cloudProviderServerSync: { reloadPending: boolean; skippedProviders: Record<string, { cloudProviderId: string; credentialSetId?: string }> } | null; gatewayUsageProviderScope?: number | null },
) {
  return Boolean(provider.credentialSetId) && model.modelID.split("_")[2] === provider.credentialSetId?.slice(4)
    && snapshot.gatewayUsageProviderScope != null && snapshot.cloudProviderServerSync?.reloadPending === false
    && !snapshot.cloudProviderServerSync.skippedProviders[gatewayConnectProviderKey(provider)]
    && snapshot.importedCloudProviders[provider.cloudProviderId]?.providerId === model.providerID
    && snapshot.importedCloudProviders[provider.cloudProviderId]?.modelIds.includes(model.modelID) === true;
}

export const GATEWAY_CONNECT_POLL_INTERVAL_MS = 10_000;
export const GATEWAY_CONNECT_POLL_ATTEMPTS = 60;
export function subscribeWindowRefocus(wake: () => void): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};
  const onVisibility = () => { if (document.visibilityState === "visible") wake(); };
  window.addEventListener("focus", wake);
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    window.removeEventListener("focus", wake);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

export const GATEWAY_CONNECT_TIMEOUT_MESSAGE = "Sign-in has not been confirmed. Check the browser, then refresh AI Providers. If consent expired or was canceled, retry sign-in.";

export async function connectGatewayProvider(input: {
  provider: GatewayConnectProvider;
  startOAuth: (providerId: string, credentialSetId?: string, signal?: AbortSignal) => Promise<{ authorizationUrl: string }>;
  signal: AbortSignal;
  openUrl: (url: string) => void | Promise<void>;
  resync: () => Promise<unknown>;
  isConnected: () => boolean;
  wait?: (ms: number) => Promise<void>;
  subscribeWake?: (wake: () => void) => () => void;
  pollIntervalMs?: number;
  attempts?: number;
}): Promise<boolean> {
  if (input.signal.aborted) return false;
  const { authorizationUrl } = await input.startOAuth(input.provider.cloudProviderId, input.provider.credentialSetId, input.signal);
  if (input.signal.aborted) return false;
  await input.openUrl(authorizationUrl);
  if (input.signal.aborted) return false;
  const subscribeWake = input.subscribeWake ?? subscribeWindowRefocus;
  const wait = input.wait ?? ((ms: number) => new Promise<void>((resolve) => {
    let done = false;
    let unsubscribe = () => {};
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      input.signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    unsubscribe = subscribeWake(finish);
    if (done) unsubscribe();
    input.signal.addEventListener("abort", finish, { once: true });
    if (input.signal.aborted) finish();
  }));
  const attempts = input.attempts ?? GATEWAY_CONNECT_POLL_ATTEMPTS;
  const interval = input.pollIntervalMs ?? GATEWAY_CONNECT_POLL_INTERVAL_MS;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (input.signal.aborted) return false;
    await wait(interval);
    if (input.signal.aborted) return false;
    try {
      await input.resync();
    } catch {
      continue;
    }
    if (input.signal.aborted) return false;
    if (input.isConnected()) return true;
  }
  return false;
}

export const resolveGatewayProviderIds = (
  importedCloudProviders: Record<string, Pick<CloudImportedProvider, "providerId" | "source">> | undefined,
): Set<string> =>
  new Set(
    Object.values(importedCloudProviders ?? {})
      .filter((provider) => provider.source === OPENWORK_GATEWAY_PROVIDER_SOURCE)
      .map((provider) => provider.providerId),
  );


export const resolveGatewayCloudProviderIds = (
  importedCloudProviders: Record<string, Pick<CloudImportedProvider, "providerId" | "source" | "cloudProviderId">> | undefined,
): Map<string, string> =>
  new Map(
    Object.values(importedCloudProviders ?? {})
      .filter((provider) => provider.source === OPENWORK_GATEWAY_PROVIDER_SOURCE)
      .map((provider) => [provider.providerId, provider.cloudProviderId]),
  );

export const getProviderModelIds = (
  provider: Pick<DenOrgLlmProvider, "models">,
) =>
  provider.models
    .flatMap((model) => {
      const id = model.id.trim();
      return id ? [id] : [];
    })
    .sort();

export const isCloudProviderOutOfSync = (
  provider: DenOrgLlmProvider,
  importedProvider: CloudImportedProvider,
) =>
  (importedProvider.modelConfigVersion !== CLOUD_MODEL_CONFIG_VERSION
    && provider.models.some((model) => catalogModelVariants(model.config, provider.providerConfig.npm) !== undefined)) ||
  importedProvider.providerId !== getCloudManagedProviderId(provider) ||
  importedProvider.sourceProviderId !== provider.providerId ||
  (importedProvider.source ?? null) !== provider.source ||
  (importedProvider.updatedAt ?? null) !== (provider.updatedAt ?? null) ||
  !sameStringList(
    importedProvider.modelIds,
    getProviderModelIds(provider),
  );

export const buildCloudProviderConfig = (
  provider: DenOrgLlmProviderConnection,
): ProviderConfig => {
  const next: ProviderConfig = buildManagedProviderConfig(provider);
  for (const key of ["npm", "api"] as const) {
    const value = provider.providerConfig[key];
    if (typeof value === "string" && value.trim()) next[key] = value;
  }
  if (provider.providerConfig.options && typeof provider.providerConfig.options === "object") {
    next.options = provider.providerConfig.options as Record<string, unknown>;
  }
  if (Array.isArray(provider.providerConfig.blacklist)) {
    next.blacklist = getStringList(provider.providerConfig.blacklist);
  }

  return next;
};

export const buildRuntimeProviderPatch = (
  provider: DenOrgLlmProviderConnection,
  localProviderId: string,
  previousProviderId?: string | null,
): Record<string, unknown> => {
  const patch: Record<string, unknown> = {};
  if (previousProviderId && previousProviderId !== localProviderId) {
    patch[previousProviderId] = null;
  }
  patch[localProviderId] = buildCloudProviderConfig(provider) as unknown as Record<string, unknown>;
  return patch;
};

export const formatConfigWithoutCloudProvider = (
  raw: string,
  providerId: string,
  disabledProviders: string[],
) => {
  let updated = raw.trim()
    ? raw
    : '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
  updated = removeCloudProviderComment(updated, providerId);
  const providerEdits = modify(updated, ["provider", providerId], undefined, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  updated = applyEdits(updated, providerEdits);

  const nextDisabled = disabledProviders.filter((id) => id !== providerId);
  const disabledEdits = modify(updated, ["disabled_providers"], nextDisabled, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  updated = applyEdits(updated, disabledEdits);
  return updated.endsWith("\n") ? updated : `${updated}\n`;
};
