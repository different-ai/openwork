import { useSyncExternalStore } from "react";
import { featureAnalytics } from "@/app/lib/analytics";
import { providerCredentialScope, useProviderCredentialHealth } from "./credential-health";
import { liveProviderSyncStatusQueryKey, usesLiveProviderSync, type LiveProviderSyncStatus } from "./live-provider-sync";
import { createClientV2, isOpencodeV2BaseUrl } from "@/app/lib/opencode-v2-adapter";
import { CLAUDE_AGENT_HOST_PROVIDER_ID, CLAUDE_AGENT_PROVIDER_ID, CLAUDE_CODE_CHECK_TIMEOUT_MESSAGE, CLAUDE_CODE_CHECK_TIMEOUT_MS, CLAUDE_CODE_NAME, CLAUDE_CODE_SIGN_IN_POLL_MS, claudeCodeMissing, plainClaudeMessage, type ClaudeAgentSetupState, type ClaudeAgentIntegration } from "@/app/lib/claude-agent";
import type { OpenworkServerClient } from "@/app/lib/openwork-server";
import { fetchProviderCatalog, providerListQueryKey, refreshProviderListQueries } from "../../../infra/provider-list-query";
import { CLOUD_MODEL_CONFIG_VERSION } from "@openwork/types/cloud-model-fast";
import { confirmSharedGatewayProvider, type SharedDeviceProviderArrival } from "./shared-provider-sync";

import { applyEdits, modify, parse } from "jsonc-parser";
import type {
  ProviderAuthAuthorization,
  ProviderListResponse,
} from "@opencode-ai/sdk/v2/client";

import { t } from "../../../../i18n";
import {
  createDenClient,
  readDenSettings,
  resolveDenBaseUrls,
  type DenOrgLlmProvider,
  type DenOrgUsableGatewayProvider,
  type DenOrgLlmProviderConnection,
} from "../../../../app/lib/den";
import { readGatewayUsageScope } from "../../../../app/lib/gateway-usage-scope";
import { refreshGatewayUsageAfterCloudSync } from "../../cloud/gateway-usage-refresh";
import { getOpenworkGatewayOrigin } from "../../../../app/lib/gateway-runtime";
import { unwrap, waitForHealthy } from "../../../../app/lib/opencode";
import {
  readOpencodeConfig,
  writeOpencodeConfig,
  engineRestart,
  workspaceOpenworkRead,
  workspaceOpenworkWrite,
} from "../../../../app/lib/desktop";
import { buildOpenworkWorkspaceBaseUrl, isLoopbackOpenworkServerUrl, OpenworkServerError } from "../../../../app/lib/openwork-server";
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
import {
  clearProviderListQueries,
  ensureProviderCatalogQuery,
  ensureProviderListQuery,
  getConnectedProviderItems,
} from "../../../infra/provider-list-query";
import type {
  OpenworkCloudProviderSyncRun,
  OpenworkCloudProviderSyncSkippedProvider,
} from "../../../../app/lib/openwork-server";
import type { OpenworkServerStoreSnapshot } from "../openwork-server-store";

export type ProviderAuthOpenworkServer = {
  getSnapshot: () => Pick<
    OpenworkServerStoreSnapshot,
    "openworkServerStatus" | "openworkServerClient"
  > & {
    openworkServerAuth?: { token?: string; hostToken?: string };
    openworkServerHostInfo?: { generation: number | null } | null;
    openworkServerCapabilities: { config?: { read?: boolean; write?: boolean }; providerSync?: boolean } | null;
  };
};
import {
  denSettingsChangedEvent,
  denSessionUpdatedEvent,
  type DenSessionUpdatedDetail,
} from "../../../../app/lib/den-session-events";
import {
  readWorkspaceCloudImports,
  withWorkspaceCloudImports,
  type CloudImportedProvider,
} from "../../../../app/cloud/import-state";
import {
  buildRuntimeProviderPatch,
  formatConfigWithoutCloudProvider,
  getCloudManagedProviderId,
  getCloudProviderEnv,
  getProviderModelIds,
  isCloudManagedProviderKey,
  isCloudProviderOutOfSync,
  isGatewayModelReady,
  isLiveGatewaySetConnected,
  type GatewayConnectProvider,
  resolveCloudProviderCredentials,
} from "./cloud-provider-config";
import { dispatchNewProviders, dispatchProviderCatalogChanged } from "../../../../app/lib/provider-events";
import { hasPendingGatewayModelSelection } from "./pending-gateway-model-selection";
import { readManagedDisabledProviders, updateManagedDisabledProviders } from "../managed-engine-config";
import {
  DESKTOP_RESTRICTION_OPENCODE_PROVIDER_ID,
  isDesktopProviderBlocked,
  type DesktopAppRestrictionChecker,
} from "../../../../app/cloud/desktop-app-restrictions";
import {
  isProviderAddRestrictedByDesktopPolicy,
  isProviderAllowedByDesktopPolicy,
  resolveEntitledOrgDefaultModel,
  type ModelEntitlementOption,
} from "./provider-policy";
import {
  readStoredDefaultModel,
  writeStoredDefaultModel,
} from "../../../kernel/model-config";
import { DEFAULT_MODEL } from "../../../../app/constants";

type ProviderReturnFocusTarget = "none" | "composer";
type CloudProviderSyncReason =
  | "sign_in"
  | "app_launch"
  | "app_resume"
  | "model_picker_open"
  | "new_chat"
  | "settings_cloud_opened"
  | "manual";

type CloudProviderSyncWorkResult = void | OpenworkCloudProviderSyncRun | { status: "live" };

type GlobalCloudProviderSyncOutcome = { contextKey: string } & (
  | { status: "completed"; result: CloudProviderSyncWorkResult }
  | { status: "cancelled" }
  | { status: "failed"; error: unknown }
);

type GlobalCloudProviderSyncBatch = {
  contextKey: string;
  sync: () => Promise<CloudProviderSyncWorkResult>;
  isCurrent?: () => boolean;
  promise: Promise<GlobalCloudProviderSyncOutcome>;
  resolve: (outcome: GlobalCloudProviderSyncOutcome) => void;
};

let lastGlobalProviderDisposeRefreshAt = 0;
let activeGlobalCloudProviderSync: GlobalCloudProviderSyncBatch | null = null;
let trailingGlobalCloudProviderSync: GlobalCloudProviderSyncBatch | null = null;
let loggedGatewayCloudProviderSyncSkip = false;
let freshCloudProviderSyncGeneration = 0;

async function enqueueGlobalCloudProviderSync(
  contextKey: string,
  sync: () => Promise<CloudProviderSyncWorkResult>,
  isCurrent?: () => boolean,
): Promise<CloudProviderSyncWorkResult> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (isCurrent?.() === false) return;
    const outcome = await queueGlobalCloudProviderSync(contextKey, sync, isCurrent);
    if (isCurrent?.() === false) return;
    if (outcome.contextKey !== contextKey || outcome.status === "cancelled") continue;
    if (outcome.status === "failed") throw outcome.error;
    return outcome.result;
  }
  throw new Error("Cloud provider sync context kept changing. Try again.");
}

function queueGlobalCloudProviderSync(
  contextKey: string,
  sync: () => Promise<CloudProviderSyncWorkResult>,
  isCurrent?: () => boolean,
): Promise<GlobalCloudProviderSyncOutcome> {
  if (activeGlobalCloudProviderSync?.contextKey === contextKey && activeGlobalCloudProviderSync.isCurrent?.() !== false) {
    const trailing = trailingGlobalCloudProviderSync;
    if (trailing && trailing.contextKey !== contextKey) {
      trailingGlobalCloudProviderSync = null;
      void activeGlobalCloudProviderSync.promise.then(trailing.resolve);
    }
    return activeGlobalCloudProviderSync.promise;
  }
  if (trailingGlobalCloudProviderSync) {
    if (trailingGlobalCloudProviderSync.contextKey !== contextKey || trailingGlobalCloudProviderSync.isCurrent?.() === false) {
      trailingGlobalCloudProviderSync.contextKey = contextKey;
      trailingGlobalCloudProviderSync.sync = sync;
      trailingGlobalCloudProviderSync.isCurrent = isCurrent;
    }
    return trailingGlobalCloudProviderSync.promise;
  }

  const batch = createGlobalCloudProviderSyncBatch(contextKey, sync, isCurrent);
  if (activeGlobalCloudProviderSync) {
    trailingGlobalCloudProviderSync = batch;
  } else {
    startGlobalCloudProviderSync(batch);
  }
  return batch.promise;
}

function createGlobalCloudProviderSyncBatch(
  contextKey: string,
  sync: () => Promise<CloudProviderSyncWorkResult>,
  isCurrent?: () => boolean,
): GlobalCloudProviderSyncBatch {
  let resolve: (outcome: GlobalCloudProviderSyncOutcome) => void = () => undefined;
  const promise = new Promise<GlobalCloudProviderSyncOutcome>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { contextKey, sync, isCurrent, promise, resolve };
}

function startGlobalCloudProviderSync(batch: GlobalCloudProviderSyncBatch): void {
  activeGlobalCloudProviderSync = batch;
  const contextKey = batch.contextKey;
  if (batch.isCurrent?.() === false) {
    batch.resolve({ contextKey, status: "cancelled" });
    finishGlobalCloudProviderSync(batch);
    return;
  }
  void batch.sync().then(
    (result) => {
      batch.resolve(batch.isCurrent?.() === false
        ? { contextKey, status: "cancelled" }
        : { contextKey, status: "completed", result });
      finishGlobalCloudProviderSync(batch);
    },
    (error) => {
      batch.resolve(batch.isCurrent?.() === false
        ? { contextKey, status: "cancelled" }
        : { contextKey, status: "failed", error });
      finishGlobalCloudProviderSync(batch);
    },
  );
}

function finishGlobalCloudProviderSync(batch: GlobalCloudProviderSyncBatch): void {
  if (activeGlobalCloudProviderSync !== batch) return;
  activeGlobalCloudProviderSync = null;
  const trailing = trailingGlobalCloudProviderSync;
  trailingGlobalCloudProviderSync = null;
  if (trailing) startGlobalCloudProviderSync(trailing);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableConfigValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableConfigValue);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableConfigValue(value[key])]),
  );
}

function canonicalConfig(raw: string): string | null {
  const parsed: unknown = parse(raw);
  if (parsed === undefined && raw.trim()) return null;
  return JSON.stringify(stableConfigValue(parsed ?? {}));
}

function configsAreSemanticallyEqual(left: string, right: string): boolean {
  if (left === right) return true;
  const leftCanonical = canonicalConfig(left);
  const rightCanonical = canonicalConfig(right);
  return leftCanonical !== null && leftCanonical === rightCanonical;
}

export type ProviderAuthMethod = {
  type: "oauth" | "api" | "cloud" | "external";
  label: string;
  methodIndex?: number;
};

export type CloudProviderSyncError = {
  kind: "error" | "conflict" | "needs_credential" | "needs_server";
  message: string;
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

export type CloudProviderServerSyncState = {
  lastRun?: { at: string | number; status: "applied" | "noop" | "failed" | "no_session"; message?: string } | null;
  lastVerifiedAt?: string | number | null;
  reloadPending: boolean;
  skippedProviders: Record<string, OpenworkCloudProviderSyncSkippedProvider>;
};

export type ProviderLoadState = {
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
};

export type ProviderAuthStoreSnapshot = {
  claudeAgent?: ClaudeAgentSetupState;
  providerLoadState: ProviderLoadState;
  gatewayUsageProviderScope?: number | null;
  providerAuthModalOpen: boolean;
  providerAuthBusy: boolean;
  providerAuthError: string | null;
  providerAuthMethods: Record<string, ProviderAuthMethod[]>;
  providerAuthPreferredProviderId: string | null;
  providerAuthProviders: ProviderAuthProvider[];
  cloudOrgProviders: DenOrgLlmProvider[];
  importedCloudProviders: Record<string, CloudImportedProvider>;
  cloudProviderServerSync: CloudProviderServerSyncState | null;
  liveGatewayProviders: DenOrgUsableGatewayProvider[] | null;
  lastSyncError: Record<string, CloudProviderSyncError>;
};

type CreateProviderAuthStoreOptions = {
  claudeCheckTiming?: { pollMs?: number; settleMs?: number; timeoutMs?: number; followUpMs?: number; signInPollMs?: number };
  claudeSignInAvailable?: () => boolean;
  providerFilterSyncFixEnabled?: () => boolean;
  nativeOpenworkClient?: () => OpenworkServerClient | null;
  nativeWorkspaceId?: () => string | null;
  client: () => Client | null;
  providers: () => ProviderListItem[];
  providerDefaults: () => Record<string, string>;
  providerConnectedIds: () => string[];
  disabledProviders: () => string[];
  checkDesktopAppRestriction: DesktopAppRestrictionChecker;
  selectedWorkspaceDisplay: () => WorkspaceDisplay;
  providerBaseUrl: () => string;
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
  providerLoadState: ProviderLoadState;
  gatewayUsageProviderScope?: number | null;
  providerAuthModalOpen: boolean;
  providerAuthBusy: boolean;
  providerAuthError: string | null;
  providerAuthMethods: Record<string, ProviderAuthMethod[]>;
  providerAuthPreferredProviderId: string | null;
  providerAuthReturnFocusTarget: ProviderReturnFocusTarget;
  cloudOrgProviders: DenOrgLlmProvider[];
  importedCloudProviders: Record<string, CloudImportedProvider>;
  cloudProviderServerSync: CloudProviderServerSyncState | null;
  liveGatewayProviders: DenOrgUsableGatewayProvider[] | null;
  lastSyncError: Record<string, CloudProviderSyncError>;
};

class CloudProviderImportConflictError extends Error {}
class CloudProviderNeedsCredentialError extends Error {}
class CloudProviderNeedsServerError extends Error {}

function providerListModelEntitlementOptions(
  providerList: ProviderListResponse | null | undefined,
): ModelEntitlementOption[] {
  return getConnectedProviderItems(providerList).flatMap((provider) =>
    Object.keys(provider.models ?? {}).map((modelID) => ({
      providerID: provider.id,
      modelID,
    })),
  );
}

export type ProviderAuthStore = ReturnType<typeof createProviderAuthStore>;

const deliveredDenSession = { identity: "", sync: "" };

export function forgetDeliveredDenSession() {
  deliveredDenSession.identity = "";
  deliveredDenSession.sync = "";
}

export function createProviderAuthStore(options: CreateProviderAuthStoreOptions) {
  const listeners = new Set<() => void>();
  const reportedOAuthConnections = new Set<string>();
  const reportOAuthConnected = (providerId: string) => {
    if (reportedOAuthConnections.has(providerId)) return;
    reportedOAuthConnections.add(providerId);
    featureAnalytics.providerConnected(providerId, "oauth");
  };

  let snapshot: ProviderAuthStoreSnapshot;
  let disposed = false;
  let started = false;
  let denSessionCleanup: (() => void) | null = null;
  let lastWorkspaceKey = "";
  let claudeIntegration: ClaudeAgentIntegration | null = null;
  let claudeBusy = false;
  let claudeChecking = false;
  let claudeVerified = false;
  let claudeError: string | null = null;
  let claudeContext = "";
  let claudeFollowUp: ReturnType<typeof setTimeout> | null = null;
  let claudeIdleWaiters: Array<() => void> = [];
  let claudeSignIn: "idle" | "checking" | "browser" = "idle";
  let claudeSignInRun = 0;
  let claudeInstalled: boolean | null = null;
  let claudeInstalledContext = "";
  const nativeTarget = () => ({
    client: options.nativeOpenworkClient ? options.nativeOpenworkClient() : options.openworkServer.getSnapshot().openworkServerClient,
    workspaceId: (options.nativeWorkspaceId ? options.nativeWorkspaceId() : options.runtimeWorkspaceId())?.trim() || null,
  });
  const nativeContext = () => {
    const target = nativeTarget();
    return JSON.stringify([target.client?.baseUrl, target.client?.token, target.workspaceId]);
  };
  const claudeAvailable = () => {
    if (isProviderAddRestrictedByDesktopPolicy({ providerId: CLAUDE_AGENT_PROVIDER_ID, checkRestriction: options.checkDesktopAppRestriction })) return false;
    const target = nativeTarget();
    return Boolean(target.workspaceId && target.client);
  };
  const claudeLoginOffered = () => claudeAvailable() && claudeContext === nativeContext()
    && Boolean(claudeIntegration?.methods.some((method) => method.id === "claude-login" && method.type === "external"));
  const claudeCanSignIn = () => options.claudeSignInAvailable
    ? options.claudeSignInAvailable()
    : isDesktopRuntime() && options.selectedWorkspaceDisplay().workspaceType === "local" && Boolean(nativeTarget().client?.canSignInToClaudeCode);
  const claudeSetupState = (): ClaudeAgentSetupState | undefined => {
    if (!claudeAvailable()) return undefined;
    const current = claudeContext === nativeContext();
    return {
      integration: current ? claudeIntegration : null,
      busy: claudeBusy || claudeSignIn !== "idle",
      checking: claudeChecking || claudeSignIn === "checking",
      verified: current && claudeVerified,
      error: current ? claudeError : null,
      canSignIn: claudeCanSignIn(),
      signingIn: current && claudeSignIn === "browser",
      ...(claudeInstalled !== null && claudeInstalledContext === nativeContext() ? { installed: claudeInstalled } : {}),
    };
  };

  let state: MutableState = {
    providerLoadState: { status: "idle", error: null },
    providerAuthModalOpen: false,
    providerAuthBusy: false,
    providerAuthError: null,
    providerAuthMethods: {},
    providerAuthPreferredProviderId: null,
    providerAuthReturnFocusTarget: "none",
    cloudOrgProviders: [],
    importedCloudProviders: {},
    cloudProviderServerSync: null,
    liveGatewayProviders: null,
    lastSyncError: {},
  };

  let verifiedGatewayUsageContext = "";
  let cloudOrgProvidersLoadKey = "";
  let cloudOrgProvidersInFlightKey = "";
  let cloudOrgProvidersInFlight: Promise<DenOrgLlmProvider[]> | null = null;
  let cloudOrgProvidersGeneration = 0;
  let cloudProviderSyncContextKey = "";
  let lastDenSessionPushKey = "";
  let lastDenIdentityPushKey = "";
  let denSessionDelivery: { key: string; controller: AbortController } | null = null;
  let denSessionPushInFlight: { mode: "identity" | "sync"; promise: Promise<boolean> } | null = null;

  const emitChange = () => {
    for (const listener of listeners) listener();
   };

  let providerCatalog: ProviderListItem[] = [];

  const getProviderAuthProviders = (): ProviderAuthProvider[] => {
    const merged = new Map<string, ProviderAuthProvider>();
    const restrictToCloud = options.checkDesktopAppRestriction({ restriction: "allowCustomProviders" });

    for (const provider of [...options.providers(), ...providerCatalog]) {
      const id = provider.id?.trim();
      if (!id || merged.has(id)) continue;
      if (
        !isProviderAllowedByDesktopPolicy({
          providerId: id,
          restrictToCloud,
          checkRestriction: options.checkDesktopAppRestriction,
        })
      ) {
        continue;
      }
      merged.set(id, {
        id,
        name: provider.name?.trim() || id,
        env: Array.isArray(provider.env) ? provider.env : [],
      });
    }

    for (const provider of state.cloudOrgProviders) {
      const id = getCloudManagedProviderId(provider);
      if (!id || merged.has(id)) continue;
      if (
        !isProviderAllowedByDesktopPolicy({
          providerId: id,
          restrictToCloud,
          checkRestriction: options.checkDesktopAppRestriction,
        })
      ) {
        continue;
      }
      merged.set(id, {
        id,
        name: provider.name.trim() || id,
        env: provider.runtimeEnvKeys ?? getCloudProviderEnv(provider.providerConfig),
      });
    }

    if (claudeLoginOffered() && !merged.has(CLAUDE_AGENT_HOST_PROVIDER_ID)) {
      merged.set(CLAUDE_AGENT_HOST_PROVIDER_ID, { id: CLAUDE_AGENT_HOST_PROVIDER_ID, name: "Anthropic", env: [] });
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

  const serverHandlesProviderSync = () => {
    const openworkSnapshot = options.openworkServer.getSnapshot();
    return Boolean(
      openworkSnapshot.openworkServerStatus === "connected" &&
      openworkSnapshot.openworkServerCapabilities?.providerSync === true &&
      openworkSnapshot.openworkServerAuth?.hostToken?.trim() &&
      openworkSnapshot.openworkServerClient,
    );
  };

  const getDenSessionDeliveryKey = () => {
    const openworkSnapshot = options.openworkServer.getSnapshot();
    const settings = readDenSettings();
    if (!serverHandlesProviderSync() || !settings.authToken?.trim() || !settings.activeOrgId?.trim()) return "";
    return JSON.stringify([
      settings.apiBaseUrl ?? resolveDenBaseUrls(settings).apiBaseUrl,
      settings.activeOrgId.trim(),
      settings.authToken.trim(),
      openworkSnapshot.openworkServerClient?.baseUrl,
      openworkSnapshot.openworkServerAuth?.token,
      openworkSnapshot.openworkServerAuth?.hostToken,
      openworkSnapshot.openworkServerHostInfo?.generation,
    ]);
  };

  const sharedDenSessionDeliveryKey = () => {
    const openworkSnapshot = options.openworkServer.getSnapshot();
    const settings = readDenSettings();
    const generation = openworkSnapshot.openworkServerHostInfo?.generation;
    const baseUrl = openworkSnapshot.openworkServerClient?.baseUrl ?? "";
    if (generation === null || generation === undefined || !baseUrl || !serverHandlesProviderSync()
      || !settings.authToken?.trim() || !settings.activeOrgId?.trim()) return "";
    let origin = baseUrl;
    try { origin = new URL(baseUrl).origin; } catch {}
    return JSON.stringify([
      settings.apiBaseUrl ?? resolveDenBaseUrls(settings).apiBaseUrl,
      settings.activeOrgId.trim(),
      settings.authToken.trim(),
      origin,
      openworkSnapshot.openworkServerAuth?.hostToken,
      generation,
    ]);
  };

  const invalidateDenSessionDelivery = () => {
    denSessionDelivery?.controller.abort();
    denSessionDelivery = null;
    denSessionPushInFlight = null;
    lastDenSessionPushKey = "";
    lastDenIdentityPushKey = "";
    cloudProviderSyncContextKey = "";
  };

  const syncDenSessionDelivery = () => {
    const key = getDenSessionDeliveryKey();
    if (key !== (denSessionDelivery?.key ?? "")) {
      invalidateDenSessionDelivery();
      verifiedGatewayUsageContext = "";
      mutateState((current) => ({ ...current, cloudProviderServerSync: null, gatewayUsageProviderScope: null }));
      if (key && !disposed) {
        denSessionDelivery = { key, controller: new AbortController() };
      }
    }
    return denSessionDelivery;
  };

  const isCurrentDenSessionDelivery = (delivery: typeof denSessionDelivery) =>
    !disposed && delivery !== null && delivery === denSessionDelivery && delivery.key === getDenSessionDeliveryKey();

  const pushDenSession = (mode: "identity" | "sync" = "sync", force = false): Promise<boolean> => {
    const delivery = syncDenSessionDelivery();
    const openworkClient = options.openworkServer.getSnapshot().openworkServerClient;
    if (!delivery || !openworkClient || disposed) return Promise.resolve(false);
    const sharedKey = sharedDenSessionDeliveryKey();
    if (!force && (delivery.key === (mode === "identity" ? lastDenIdentityPushKey : lastDenSessionPushKey)
      || (sharedKey !== "" && sharedKey === deliveredDenSession[mode]))) return Promise.resolve(true);
    if (denSessionPushInFlight) {
      if (denSessionPushInFlight.mode === mode) return denSessionPushInFlight.promise;
      return denSessionPushInFlight.promise.catch(() => false).then(() =>
        isCurrentDenSessionDelivery(delivery) ? pushDenSession(mode, force) : false);
    }
    if (mode === "sync" && !hasCloudProviderSyncPrerequisites()) return Promise.resolve(false);
    if (mode === "sync") {
      lastDenSessionPushKey = "";
      deliveredDenSession.sync = "";
    }
    const settings = readDenSettings();
    const apiBaseUrl = settings.apiBaseUrl ?? resolveDenBaseUrls(settings).apiBaseUrl;
    const token = settings.authToken?.trim() ?? "";
    const orgId = settings.activeOrgId?.trim() ?? "";
    const request = (async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (!isCurrentDenSessionDelivery(delivery)) return false;
        try {
          const put = mode === "identity" ? openworkClient.putDenIdentity : openworkClient.putDenSession;
          await put({ baseUrl: apiBaseUrl, token, orgId }, delivery.controller.signal);
          if (!isCurrentDenSessionDelivery(delivery)) return false;
          lastDenIdentityPushKey = delivery.key;
          lastDenSessionPushKey = mode === "sync" ? delivery.key : "";
          deliveredDenSession.identity = sharedKey;
          deliveredDenSession.sync = mode === "sync" ? sharedKey : "";
          return true;
        } catch (error) {
          if (!isCurrentDenSessionDelivery(delivery)) return false;
          const retryable = error instanceof OpenworkServerError
            ? (error.status === 403 && error.code === "policy_unavailable") || error.status === 408 || error.status >= 500
            : error instanceof TypeError || (error instanceof Error && error.message === "Request timed out.");
          if (!retryable || attempt === 2) throw error;
          await new Promise<void>((resolve) => {
            const finish = () => {
              clearTimeout(timer);
              delivery.controller.signal.removeEventListener("abort", finish);
              resolve();
            };
            const timer = setTimeout(finish, 250 * 2 ** attempt);
            delivery.controller.signal.addEventListener("abort", finish, { once: true });
          });
        }
      }
      return false;
    })();
    denSessionPushInFlight = { mode, promise: request };
    const clearInFlight = () => {
      if (denSessionPushInFlight?.promise === request) {
        denSessionPushInFlight = null;
      }
    };
    void request.then(clearInFlight, clearInFlight);
    return request;
  };

  const refreshSnapshot = () => {
    snapshot = {
      claudeAgent: claudeSetupState(),
      providerLoadState: state.providerLoadState,
      gatewayUsageProviderScope: state.gatewayUsageProviderScope === readGatewayUsageScope().generation
        && verifiedGatewayUsageContext === getCloudProviderSyncContextKey()
        && state.cloudProviderServerSync?.reloadPending !== true ? state.gatewayUsageProviderScope : null,
      providerAuthModalOpen: state.providerAuthModalOpen,
      providerAuthBusy: state.providerAuthBusy,
      providerAuthError: state.providerAuthError,
      providerAuthMethods: state.providerAuthMethods,
      providerAuthPreferredProviderId: state.providerAuthPreferredProviderId,
      providerAuthProviders: getProviderAuthProviders(),
      cloudOrgProviders: state.cloudOrgProviders,
      importedCloudProviders: state.importedCloudProviders,
      cloudProviderServerSync: state.cloudProviderServerSync,
      liveGatewayProviders: state.liveGatewayProviders,
      lastSyncError: state.lastSyncError,
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

  const readCloudProviderBaseUrl = (provider: DenOrgLlmProviderConnection) => {
    const options = provider.providerConfig.options;
    if (options && typeof options === "object" && !Array.isArray(options)) {
      const baseURL = "baseURL" in options ? options.baseURL : undefined;
      if (typeof baseURL === "string" && baseURL.trim()) return baseURL.trim().replace(/\/api\/v1\/?$/, "");
    }
    const api = provider.providerConfig.api;
    if (typeof api === "string" && api.trim()) return api.trim().replace(/\/api\/v1\/?$/, "");
    return "";
  };

  const mirrorCloudProviderEnv = async (
    provider: DenOrgLlmProviderConnection,
    apiKey: string,
    resolvedEnvEntries: Array<{ key: string; value: string }>,
  ) => {
    const trimmedKey = apiKey.trim();
    if (!trimmedKey) return;
    const openworkClient = options.openworkServer.getSnapshot().openworkServerClient;
    if (!openworkClient) return;
    const entries = [...resolvedEnvEntries];
    if (entries.length === 0) {
      entries.push(
        ...getCloudProviderEnv(provider.providerConfig)
          .slice(0, 1)
          .map((key) => ({ key, value: trimmedKey })),
      );
    }
    if (provider.source === "openwork") {
      if (!entries.some((entry) => entry.key === "OPENWORK_API_KEY")) {
        entries.unshift({ key: "OPENWORK_API_KEY", value: trimmedKey });
      }
      const baseUrl = readCloudProviderBaseUrl(provider);
      if (baseUrl) entries.push({ key: "OPENWORK_INFERENCE_BASE_URL", value: baseUrl });
    }
    if (entries.length === 0) return;
    await openworkClient.upsertUserEnv(entries);
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
    isCurrent = () => true,
  ) => {
    const root = options.selectedWorkspaceRoot().trim();
    const isLocalWorkspace =
      options.selectedWorkspaceDisplay().workspaceType === "local";
    const { openworkClient, openworkWorkspaceId, hasOpenworkTarget, canUseOpenworkServer } =
      await resolveOpenworkConfigTarget("write");
    if (!isCurrent()) return false;

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

  const cloudImportWorkspaceKey = () => JSON.stringify([
    currentWorkspaceKey(),
    options.selectedWorkspaceDisplay().workspaceType,
    options.providerBaseUrl(),
    options.openworkServer.getSnapshot().openworkServerClient?.baseUrl,
  ]);

  const refreshImportedCloudProviders = async (refreshOptions?: { strict?: boolean; verifiedScope?: number }) => {
    try {
      if (serverHandlesProviderSync()) {
        const delivery = syncDenSessionDelivery();
        const contextKey = getCloudProviderSyncContextKey();
        const openworkClient = options.openworkServer.getSnapshot().openworkServerClient;
        if (!openworkClient) throw new Error("OpenWork server unavailable.");
        const status = await openworkClient.getCloudProviderSyncStatus();
        if (!isCurrentDenSessionDelivery(delivery) || contextKey !== getCloudProviderSyncContextKey()) return state.importedCloudProviders;
        const next = Object.fromEntries(status.providers.map((provider) => [provider.cloudProviderId, provider]));
        if (status.hasSession && refreshOptions?.verifiedScope === readGatewayUsageScope().generation) {
          verifiedGatewayUsageContext = contextKey;
        }
        mutateState((current) => ({
          ...current, importedCloudProviders: next,
          gatewayUsageProviderScope: status.hasSession && verifiedGatewayUsageContext === contextKey
            ? refreshOptions?.verifiedScope ?? current.gatewayUsageProviderScope : null,
          cloudProviderServerSync: {
            ...(status.lastRun === undefined || status.lastRun === null ? {} : { lastRun: status.lastRun }),
            ...(() => {
              const verifiedAt = status.lastRun && (status.lastRun.status === "applied" || status.lastRun.status === "noop") ? status.lastRun.at : current.cloudProviderServerSync?.lastVerifiedAt;
              return verifiedAt === undefined ? {} : { lastVerifiedAt: verifiedAt };
            })(),
            reloadPending: status.reloadPending,
            skippedProviders: Object.fromEntries((status.hasSession ? status.skippedProviders.filter((provider) => provider.reason !== "member_auth_required" || verifiedGatewayUsageContext === contextKey) : []).map((provider) => [provider.credentialSetId ? `${provider.cloudProviderId}:${provider.credentialSetId}` : provider.cloudProviderId, provider])),
          },
        }));
        return next;
      }
      if (state.cloudProviderServerSync !== null) {
        setStateField("cloudProviderServerSync", null);
      }
      const generation = cloudOrgProvidersGeneration;
      const contextKey = getCloudProviderSyncContextKey();
      const workspaceKey = cloudImportWorkspaceKey();
      const config = await readWorkspaceOpenworkConfigRecord();
      const cloudImports = readWorkspaceCloudImports(config);
      const next = cloudImports.providers;
      if (
        disposed || generation !== cloudOrgProvidersGeneration ||
        contextKey !== getCloudProviderSyncContextKey() || workspaceKey !== cloudImportWorkspaceKey()
      ) {
        const cleanupGeneration = cloudOrgProvidersGeneration;
        const isCurrent = () => !disposed && cleanupGeneration === cloudOrgProvidersGeneration &&
          workspaceKey === cloudImportWorkspaceKey() && !readDenSettings().authToken?.trim() && !serverHandlesProviderSync();
        for (const importedProvider of Object.values(next)) {
          if (!isCurrent()) break;
          await removeCloudProviderInternal(importedProvider.cloudProviderId, {
            silent: true, importedProvider, isCurrent,
          }).catch(() => undefined);
          if (!isCurrent()) break;
          removeProviderFromState(importedProvider.providerId);
          if (readStoredDefaultModel().providerID === importedProvider.providerId) {
            writeStoredDefaultModel(DEFAULT_MODEL);
          }
        }
        return state.importedCloudProviders;
      }
      const hasNext = Object.keys(next).length > 0;
      const hasCurrent = Object.keys(state.importedCloudProviders).length > 0;
      if (hasNext || !hasCurrent) {
        setStateField("importedCloudProviders", next);
      }
      return next;
    } catch (error) {
      if (refreshOptions?.strict) {
        throw error;
      }
      return state.importedCloudProviders;
    }
  };

  const persistImportedCloudProviders = async (
    nextProviders: Record<string, CloudImportedProvider>,
    isCurrent = () => true,
  ) => {
    const config = await readWorkspaceOpenworkConfigRecord();
    if (!isCurrent()) return;
    const cloudImports = readWorkspaceCloudImports(config);
    const nextCloudImports = {
      ...cloudImports,
      providers: nextProviders,
    };
    const nextConfig = withWorkspaceCloudImports(config, {
      ...nextCloudImports,
    });
    const persisted = await writeWorkspaceOpenworkConfigRecord(nextConfig, isCurrent);
    if (!isCurrent()) return;
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

  const writeProjectConfigFile = async (content: string, isCurrent = () => true) => {
    const root = options.selectedWorkspaceRoot().trim();
    const isLocalWorkspace =
      options.selectedWorkspaceDisplay().workspaceType === "local";
    const { openworkClient, openworkWorkspaceId, hasOpenworkTarget, canUseOpenworkServer } =
      await resolveOpenworkConfigTarget("write");
    if (!isCurrent()) return false;

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

  const patchRuntimeProviders = async (update: Record<string, unknown>, isCurrent = () => true) => {
    const { openworkClient, openworkWorkspaceId, canUseOpenworkServer } =
      await resolveOpenworkConfigTarget("write");
    if (!isCurrent()) return;
    if (!canUseOpenworkServer || !openworkClient || !openworkWorkspaceId) {
      throw new Error("OpenWork server unavailable. Connect to manage cloud providers.");
    }
    await openworkClient.patchConfig(openworkWorkspaceId, {
      opencode: { provider: update },
    });
  };

  const patchRuntimeProviderAndImportedCloudProviders = async (
    providerUpdate: Record<string, unknown>,
    nextProviders: Record<string, CloudImportedProvider>,
  ) => {
    const { openworkClient, openworkWorkspaceId, canUseOpenworkServer } =
      await resolveOpenworkConfigTarget("write");
    if (!canUseOpenworkServer || !openworkClient || !openworkWorkspaceId) {
      throw new Error("OpenWork server unavailable. Connect to manage cloud providers.");
    }
    const config = await readWorkspaceOpenworkConfigRecord();
    const cloudImports = readWorkspaceCloudImports(config);
    const nextConfig = withWorkspaceCloudImports(config, {
      ...cloudImports,
      providers: nextProviders,
    });
    await openworkClient.patchConfig(openworkWorkspaceId, {
      opencode: { provider: providerUpdate },
      openwork: nextConfig,
    });
    setStateField("importedCloudProviders", nextProviders);
  };

  const stripLegacyCloudProviderBlocks = async (providerIds: Array<string | null | undefined>, isCurrent = () => true) => {
    const ids = [...new Set(providerIds.flatMap((id) => (id?.trim() ? [id.trim()] : [])))];
    if (ids.length === 0) return;
    try {
      await updateProjectConfigFile((raw) => {
        let next = raw;
        for (const id of ids) {
          next = formatConfigWithoutCloudProvider(next, id, options.disabledProviders());
        }
        return next;
      }, undefined, isCurrent);
    } catch {
    }
  };

  const updateProjectConfigFile = async (
    updater: (raw: string) => string,
    fallbackUpdate?: (config: Record<string, unknown>) => Record<string, unknown>,
    isCurrent = () => true,
  ) => {
    const configFile = await readProjectConfigFile() as { content?: string } | null;
    if (!isCurrent()) return false;
    if (configFile) {
      const raw = configFile.content?.trim()
        ? configFile.content
        : '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
      const next = updater(raw);
      if (configsAreSemanticallyEqual(raw, next)) {
        return false;
      }
      return await writeProjectConfigFile(next, isCurrent);
    }

    if (!fallbackUpdate) {
      return false;
    }

    const c = options.client();
    const openworkSnapshot = options.openworkServer.getSnapshot();
    const workspaceId = options.runtimeWorkspaceId();
    const workspaceType = options.selectedWorkspaceDisplay().workspaceType;
    const canUseManagedRuntime = Boolean(openworkSnapshot.openworkServerClient && workspaceId?.trim() && workspaceType === "local");
    if (!c && !canUseManagedRuntime) {
      throw new Error(t("providers.not_connected"));
    }
    const config = c ? unwrap(await c.config.get()) : {};
    const next = fallbackUpdate(config);
    await updateManagedDisabledProviders({
      opencodeClient: c,
      openworkClient: openworkSnapshot.openworkServerClient,
      workspaceId,
      workspaceType,
      disabledProviders: next.disabled_providers,
      currentConfig: config,
      removeFallbackKeyWhenEmpty: true,
    });
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

    const nextFrom = (currentDisabled: string[]) => currentDisabled.includes(resolvedProviderId) === disabled
      ? currentDisabled
      : disabled
        ? [...currentDisabled, resolvedProviderId]
        : currentDisabled.filter((entry) => entry !== resolvedProviderId);
    const unchanged = (currentDisabled: string[], nextDisabled: string[]) =>
      nextDisabled.length === currentDisabled.length &&
      nextDisabled.every((entry, index) => entry === currentDisabled[index]);

    const c = options.client();
    const openworkSnapshot = options.openworkServer.getSnapshot();
    const workspaceId = options.runtimeWorkspaceId();
    const workspaceType = options.selectedWorkspaceDisplay().workspaceType;
    if (!workspaceId?.trim() && !options.selectedWorkspaceRoot().trim()) {
      return false;
    }
    const canUseManagedRuntime = Boolean(
      openworkSnapshot.openworkServerClient && workspaceId?.trim() && workspaceType === "local",
    );

    if (canUseManagedRuntime || c) {
      const currentDisabled = normalizeDisabledProviders(await readManagedDisabledProviders({
        opencodeClient: c,
        openworkClient: openworkSnapshot.openworkServerClient,
        workspaceId,
        workspaceType,
      }).catch(() => options.disabledProviders()));
      const nextDisabled = nextFrom(currentDisabled);
      if (unchanged(currentDisabled, nextDisabled)) {
        if (!unchanged(normalizeDisabledProviders(options.disabledProviders()), currentDisabled)) {
          options.setDisabledProviders(currentDisabled);
        }
        return false;
      }
      const result = await updateManagedDisabledProviders({
        opencodeClient: c,
        openworkClient: openworkSnapshot.openworkServerClient,
        workspaceId,
        workspaceType,
        disabledProviders: nextDisabled,
        removeFallbackKeyWhenEmpty: true,
        markReloadRequired: () => options.markOpencodeConfigReloadRequired(),
      });
      options.setDisabledProviders(result.disabledProviders);
      options.markOpencodeConfigReloadRequired();
      refreshSnapshot();
      emitChange();
      return true;
    }

    const currentDisabled = normalizeDisabledProviders(options.disabledProviders());
    const nextDisabled = nextFrom(currentDisabled);
    if (unchanged(currentDisabled, nextDisabled)) return false;

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
      throw new Error("Could not update disabled providers for this workspace.");
    }

    options.setDisabledProviders(nextDisabled);
    options.markOpencodeConfigReloadRequired();
    refreshSnapshot();
    emitChange();
    return true;
  };

  const assertProviderAllowedByDesktopPolicy = (providerId: string) => {
    const restrictToCloud = options.checkDesktopAppRestriction({ restriction: "allowCustomProviders" });
    if (
      isDesktopProviderBlocked({
        providerId,
        checkRestriction: options.checkDesktopAppRestriction,
      })
    ) {
      throw new Error(`${providerId} is blocked by your organization desktop policy.`);
    }
    if (
      !isProviderAllowedByDesktopPolicy({
        providerId,
        restrictToCloud,
        checkRestriction: options.checkDesktopAppRestriction,
      })
    ) {
      throw new Error(t("providers.custom_providers_disabled"));
    }
  };

  const sweepOrphanCloudProvidersFromConfig = async (): Promise<string[]> => {
    const orphanIds = new Set<string>();

    try {
      const { openworkClient, openworkWorkspaceId, canUseOpenworkServer } =
        await resolveOpenworkConfigTarget("write");
      if (canUseOpenworkServer && openworkClient && openworkWorkspaceId) {
        const merged = await openworkClient.getConfig(openworkWorkspaceId);
        const runtimeProvider = isRecord(merged.opencode) ? merged.opencode.provider : null;
        const runtimeOrphans = isRecord(runtimeProvider)
          ? Object.keys(runtimeProvider).filter((key) => /^lpr_/i.test(key))
          : [];
        if (runtimeOrphans.length > 0) {
          await patchRuntimeProviders(
            Object.fromEntries(runtimeOrphans.map((id) => [id, null])),
          );
          for (const id of runtimeOrphans) orphanIds.add(id);
        }
      }
    } catch {
    }

    const configFile = await readProjectConfigFile().catch(() => null) as { content?: string } | null;
    if (configFile?.content?.trim()) {
      const parsed = parse(configFile.content);
      const providerSection =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>).provider
          : null;
      const fileOrphans =
        providerSection && typeof providerSection === "object" && !Array.isArray(providerSection)
          ? Object.keys(providerSection as Record<string, unknown>).filter((key) => /^lpr_/i.test(key))
          : [];
      if (fileOrphans.length > 0) {
        await updateProjectConfigFile((raw) => {
          let next = raw;
          for (const id of fileOrphans) {
            next = formatConfigWithoutCloudProvider(next, id, options.disabledProviders());
          }
          return next;
        });
        for (const id of fileOrphans) orphanIds.add(id);
      }
    }

    return [...orphanIds];
  };

  const assertCloudProviderImportSafe = async (
    provider: DenOrgLlmProviderConnection,
  ) => {
    const localProviderId = getCloudManagedProviderId(provider);
    const existingImported = state.importedCloudProviders[provider.id] ?? null;
    const cloudManagedKey = isCloudManagedProviderKey(localProviderId);
    if (
      existingImported &&
      existingImported.providerId !== localProviderId &&
      Object.values(state.importedCloudProviders).some(
        (entry) => entry.providerId === localProviderId && entry.cloudProviderId !== provider.id,
      )
    ) {
      throw new CloudProviderImportConflictError(
        `${localProviderId} is already imported from another cloud provider. Remove it before importing this one.`,
      );
    }

    if (
      !existingImported &&
      !cloudManagedKey &&
      options.providerConnectedIds().includes(localProviderId)
    ) {
      throw new CloudProviderImportConflictError(
        `${localProviderId} is already connected in this workspace. Disconnect it before importing the cloud-managed version.`,
      );
    }

    const configFile = await readProjectConfigFile() as { content?: string } | null;
    if (
      !configFile?.content?.trim() ||
      existingImported ||
      (cloudManagedKey && localProviderId !== "openwork")
    ) {
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
      throw new CloudProviderImportConflictError(
        `${localProviderId} already has a provider block in opencode.jsonc. Remove it before importing the cloud-managed version.`,
      );
    }
  };

  const getCloudOrgProvidersKey = () => {
    const settings = readDenSettings();
    return [
      settings.baseUrl,
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
      cloudOrgProvidersGeneration += 1;
      setStateField("cloudOrgProviders", []);
      cloudOrgProvidersLoadKey = loadKey;
      return [];
    }

    const client = createDenClient({
      baseUrl: settings.baseUrl,
      token,
    });
    const generation = ++cloudOrgProvidersGeneration;
    const request = client
      .listOrgLlmProviders(orgId)
      .then((providers) => {
        if (
          generation !== cloudOrgProvidersGeneration ||
          getCloudOrgProvidersKey() !== loadKey
        ) {
          return state.cloudOrgProviders;
        }
        const workspaceId = options.runtimeWorkspaceId();
        if (workspaceId) for (const provider of providers) {
          useProviderCredentialHealth.getState().configure(workspaceId, getCloudManagedProviderId(provider), JSON.stringify([settings.baseUrl, orgId, provider.updatedAt]));
        }
        setStateField("cloudOrgProviders", providers);
        cloudOrgProvidersLoadKey = loadKey;
        return providers;
      })
      .catch((error) => {
        if (
          generation === cloudOrgProvidersGeneration &&
          getCloudOrgProvidersKey() === loadKey
        ) {
          setStateField("cloudOrgProviders", []);
          cloudOrgProvidersLoadKey = "";
        }
        throw error;
      })
      .finally(() => {
        if (
          generation === cloudOrgProvidersGeneration &&
          cloudOrgProvidersInFlightKey === loadKey
        ) {
          cloudOrgProvidersInFlight = null;
          cloudOrgProvidersInFlightKey = "";
        }
      });

    cloudOrgProvidersInFlight = request;
    cloudOrgProvidersInFlightKey = loadKey;
    return request;
  };

  const refreshLiveGatewayProviders = async (isCurrent: () => boolean) => {
    const settings = readDenSettings();
    const token = settings.authToken?.trim() ?? "";
    const orgId = settings.activeOrgId?.trim() ?? "";
    if (!token || !orgId) {
      setStateField("liveGatewayProviders", []);
      return;
    }
    try {
      const providers = await createDenClient({ baseUrl: settings.baseUrl, token }).listOrgUsableGatewayProviders(orgId);
      if (isCurrent()) setStateField("liveGatewayProviders", providers);
    } catch (error) {
      console.warn("[cloud-provider-sync] Could not read AI Gateway providers for Settings.", error);
      if (isCurrent() && state.liveGatewayProviders === null) setStateField("liveGatewayProviders", []);
    }
  };

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
    const workspaceId = options.runtimeWorkspaceId();
    if (workspaceId && options.providerBaseUrl().trim()) useProviderCredentialHealth.getState().bindWorkspace(workspaceId, providerCredentialScope(options.providerBaseUrl()));
    const changed = () => { if (workspaceId) useProviderCredentialHealth.getState().changed(workspaceId, providerId); };
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
      changed();
      return;
    }

    const rawClient = (c as unknown as {
      client?: { delete?: (options: { url: string }) => Promise<unknown> };
    }).client;
    if (rawClient?.delete) {
      assertNoClientError(await rawClient.delete({ url: `/auth/${encodeURIComponent(providerId)}` }));
      changed();
      return;
    }

    if (typeof authClient.set === "function") {
      const result = await authClient.set({ providerID: providerId, auth: null });
      assertNoClientError(result);
      changed();
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
  ) => {
    const restrictToCloud = options.checkDesktopAppRestriction({ restriction: "allowCustomProviders" });
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
      if (
        !isProviderAllowedByDesktopPolicy({
          providerId: id,
          restrictToCloud,
          checkRestriction: options.checkDesktopAppRestriction,
        })
      ) {
        continue;
      }
      if (!Array.isArray(provider.env) || provider.env.length === 0) continue;
      const existing = merged[id] ?? [];
      if (existing.some((method) => method.type === "api")) continue;
      merged[id] = [...existing, { type: "api", label: t("providers.api_key_label") }];
    }

    const availableProvidersById = new Map((availableProviders ?? []).map((provider) => [provider.id, provider]));
    for (const [id, providerMethods] of Object.entries(merged)) {
      if (
        !isProviderAllowedByDesktopPolicy({
          providerId: id,
          restrictToCloud,
          checkRestriction: options.checkDesktopAppRestriction,
        })
      ) {
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
        if (!isDesktopRuntime()) return false;
        const label = method.label.toLowerCase();
        return !/headless|device/.test(label);
      });
    }

    return merged;
  };

  const loadProviderCatalog = async (client: Client) => {
    try {
      const catalog = filterProviderList(
        await ensureProviderCatalogQuery(getReactQueryClient(), {
          client,
          baseUrl: options.providerBaseUrl(),
          directory: options.selectedWorkspaceRoot(),
        }),
        options.disabledProviders(),
      );
      providerCatalog = catalog.all ?? [];
    } catch {
      providerCatalog = [];
    }
  };

  const claudeCatalogTarget = (target: { client: OpenworkServerClient; workspaceId: string }) => {
    const baseUrl = `${buildOpenworkWorkspaceBaseUrl(target.client.baseUrl, target.workspaceId)}/opencode2`;
    const directory = options.selectedWorkspaceRoot();
    return { baseUrl, directory, client: createClientV2(baseUrl, directory, { token: target.client.token }) };
  };

  const readClaudeModels = async (target: { client: OpenworkServerClient; workspaceId: string }) => {
    const { client, directory } = claudeCatalogTarget(target);
    const list = await fetchProviderCatalog({ client, directory });
    return { list, listed: list.all.some((provider) => provider.id === CLAUDE_AGENT_PROVIDER_ID && Object.keys(provider.models ?? {}).length > 0) };
  };

  const publishClaudeCatalog = async (target: { client: OpenworkServerClient; workspaceId: string }, context: string, known?: ProviderListResponse) => {
    const { baseUrl, directory } = claudeCatalogTarget(target);
    try {
      const list = known ?? (await readClaudeModels(target)).list;
      if (disposed || nativeContext() !== context || !claudeAvailable()) return;
      getReactQueryClient().setQueryData(providerListQueryKey({ baseUrl, directory }), list);
      await refreshProviderListQueries(getReactQueryClient());
      if (disposed || nativeContext() !== context || !claudeAvailable()) return;
      dispatchProviderCatalogChanged({ baseUrl, directory });
    } catch {
    }
  };

  const claudeWait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  const waitForClaudeCheck = async (
    target: { client: OpenworkServerClient; workspaceId: string },
    input: { repeat: boolean; current: () => boolean },
  ): Promise<{ integration: ClaudeAgentIntegration; list?: ProviderListResponse; problem: string | null } | null> => {
    const pollMs = options.claudeCheckTiming?.pollMs ?? 600;
    const settleMs = input.repeat ? options.claudeCheckTiming?.settleMs ?? 5_000 : 0;
    const timeoutMs = options.claudeCheckTiming?.timeoutMs ?? CLAUDE_CODE_CHECK_TIMEOUT_MS;
    const started = Date.now();
    let cleanReads = 0;
    for (;;) {
      const integration = await target.client.claudeAgentIntegration(target.workspaceId);
      if (!input.current()) return null;
      const active = integration.connections[0];
      if (!active) throw new Error("Claude Code connection was not returned by the server. Check again before retrying.");
      if (active.status?.status === "needs_auth") return { integration, problem: active.status.message };
      const models = await readClaudeModels(target).catch(() => null);
      if (!input.current()) return null;
      const elapsed = Date.now() - started;
      cleanReads = models?.listed && elapsed >= settleMs ? cleanReads + 1 : 0;
      if (cleanReads >= 2) return { integration, list: models?.list, problem: null };
      if (elapsed >= timeoutMs) throw new Error(CLAUDE_CODE_CHECK_TIMEOUT_MESSAGE);
      await claudeWait(pollMs);
      if (!input.current()) return null;
    }
  };

  async function runClaudeAction(action: "read" | "connect" | "disconnect") {
    if (claudeBusy) return;
    if (!claudeAvailable()) throw new Error("Claude Code sign-in is not available in this workspace.");
    const { client, workspaceId } = nativeTarget();
    if (!client || !workspaceId) throw new Error("Choose a workspace to connect Claude Code.");
    const target = { client, workspaceId };
    const context = nativeContext();
    if (claudeContext !== context) { claudeIntegration = null; claudeVerified = false; }
    claudeContext = context;
    claudeBusy = true;
    claudeChecking = action === "connect";
    claudeError = null;
    if (claudeFollowUp) { clearTimeout(claudeFollowUp); claudeFollowUp = null; }
    refreshSnapshot(); emitChange();
    const current = () => !disposed && context === nativeContext() && claudeAvailable();
    try {
      let integration = await client.claudeAgentIntegration(workspaceId);
      if (!current()) return;
      let list: ProviderListResponse | undefined;
      if (action === "connect") {
        if (!integration.methods.some((method) => method.id === "claude-login" && method.type === "external")) {
          throw new Error("Claude Code setup is unavailable on this server. Update OpenWork and check again.");
        }
        const previousIds = new Set(integration.connections.map((connection) => connection.id));
        const repeat = (await readClaudeModels(target).catch(() => null))?.listed === true;
        if (!current()) return;
        claudeVerified = false;
        await client.connectClaudeAgent(workspaceId);
        if (!current()) return;
        integration = await client.claudeAgentIntegration(workspaceId);
        if (!current()) return;
        if (!integration.connections.length) throw new Error("Claude Code connection was not returned by the server. Check again before retrying.");
        const created = integration.connections.filter((connection) => !previousIds.has(connection.id));
        const keep = integration.connections[0] ?? created[0];
        if (keep) {
          for (const connection of integration.connections) {
            if (!previousIds.has(connection.id) || connection.id === keep.id) continue;
            if (!current()) return;
            const latest = await client.claudeAgentIntegration(workspaceId);
            if (!current()) return;
            if (latest.connections[0]?.id === connection.id || !latest.connections.some((entry) => entry.id === connection.id)) continue;
            await client.removeClaudeAgentConnection(workspaceId, connection.id);
          }
          if (!current()) return;
        }
        const checked = await waitForClaudeCheck(target, { repeat, current });
        if (!checked || !current()) return;
        claudeIntegration = checked.integration;
        if (checked.problem) throw new Error(plainClaudeMessage(checked.problem));
        integration = checked.integration;
        list = checked.list;
        claudeVerified = true;
      } else if (action === "disconnect") {
        for (const connection of integration.connections) {
          if (!current()) return;
          await client.removeClaudeAgentConnection(workspaceId, connection.id);
        }
        if (!current()) return;
        integration = await client.claudeAgentIntegration(workspaceId);
        if (!current()) return;
        if (integration.connections.length) throw new Error("Some Claude Code connections remain. Disconnect again to remove them.");
        claudeVerified = false;
      } else if (integration.connections[0]?.status?.status === "needs_auth" || !integration.connections.length) {
        claudeVerified = false;
      }
      if (!current()) return;
      claudeIntegration = integration;
      if (action !== "read") void publishClaudeCatalog(target, context, list);
      if (action === "connect") {
        claudeFollowUp = setTimeout(() => { claudeFollowUp = null; void runClaudeAction("read").catch(() => undefined); }, options.claudeCheckTiming?.followUpMs ?? 15_000);
      }
      return action === "disconnect" ? `Disconnected ${CLAUDE_CODE_NAME} from OpenWork. Claude Code itself stays signed in.` : `${CLAUDE_CODE_NAME} connected`;
    } catch (error) {
      if (!current()) return;
      claudeError = error instanceof Error ? error.message : "Could not check Claude Code. Check again.";
      throw error;
    } finally {
      claudeBusy = false;
      claudeChecking = false;
      for (const resolve of claudeIdleWaiters.splice(0)) resolve();
      if (!disposed) {
        refreshSnapshot(); emitChange();
        if (context !== nativeContext() && claudeAvailable()) void runClaudeAction("read").catch(() => undefined);
      }
    }
  }

  const noteClaudeInstalled = (context: string, installed: boolean | undefined) => {
    if (installed === undefined || disposed || context !== nativeContext()) return;
    const stale = installed && claudeContext === context && claudeCodeMissing(claudeError);
    if (!stale && claudeInstalled === installed && claudeInstalledContext === context) return;
    if (stale) claudeError = null;
    claudeInstalled = installed;
    claudeInstalledContext = context;
    refreshSnapshot(); emitChange();
  };

  async function checkClaudeInstalled() {
    if (!claudeAvailable() || !claudeCanSignIn() || claudeBusy || claudeSignIn !== "idle") return;
    const { client } = nativeTarget();
    if (!client) return;
    const context = nativeContext();
    const signIn = await client.claudeCodeSignIn("status").catch(() => null);
    noteClaudeInstalled(context, signIn?.installed);
  }

  async function signInWithClaudeCode() {
    if (claudeBusy || claudeSignIn !== "idle") return;
    if (!claudeAvailable() || !claudeCanSignIn()) throw new Error("Claude Code sign-in is not available in this workspace.");
    const { client } = nativeTarget();
    if (!client) throw new Error("Choose a workspace to connect Claude Code.");
    const context = nativeContext();
    const run = ++claudeSignInRun;
    if (claudeContext !== context) { claudeIntegration = null; claudeVerified = false; claudeError = null; }
    claudeContext = context;
    const problem = claudeIntegration?.connections[0]?.status;
    const force = claudeError ? !claudeCodeMissing(claudeError) : problem?.status === "needs_auth" && !claudeCodeMissing(problem.message);
    claudeSignIn = force ? "browser" : "checking";
    claudeError = null;
    refreshSnapshot(); emitChange();
    const current = () => !disposed && run === claudeSignInRun && context === nativeContext() && claudeAvailable();
    let signedIn = false;
    try {
      let signIn = await client.claudeCodeSignIn("start", { force });
      noteClaudeInstalled(context, signIn.installed);
      while (signIn.status === "waiting") {
        await claudeWait(options.claudeCheckTiming?.signInPollMs ?? CLAUDE_CODE_SIGN_IN_POLL_MS);
        if (!current()) break;
        signIn = await client.claudeCodeSignIn("status");
        if (signIn.status === "waiting" && claudeSignIn === "checking" && current()) { claudeSignIn = "browser"; refreshSnapshot(); emitChange(); }
      }
      if (!current()) {
        if (run === claudeSignInRun) void client.claudeCodeSignIn("cancel").catch(() => undefined);
        return;
      }
      if (signIn.status === "failed") throw new Error(signIn.message);
      signedIn = signIn.status === "signed_in";
    } catch (error) {
      if (!current()) return;
      if (error instanceof OpenworkServerError && error.code === "claude_code_not_installed") noteClaudeInstalled(context, false);
      claudeError = error instanceof OpenworkServerError && error.status === 404
        ? "This OpenWork server cannot open the Claude Code sign-in. Run claude auth login in a terminal, then connect."
        : error instanceof Error ? error.message : "Could not sign in to Claude Code. Sign in again.";
      throw error;
    } finally {
      if (run === claudeSignInRun && !signedIn) { claudeSignIn = "idle"; if (!disposed) { refreshSnapshot(); emitChange(); } }
    }
    if (!signedIn) return;
    claudeSignIn = "idle";
    return runClaudeAction("connect");
  }

  async function cancelClaudeSignIn() {
    if (claudeSignIn === "idle") return;
    claudeSignInRun += 1;
    claudeSignIn = "idle";
    refreshSnapshot(); emitChange();
    await nativeTarget().client?.claudeCodeSignIn("cancel").catch(() => undefined);
  }

  const loadProviderAuthMethods = async () => {
    const c = options.client();
    const native = claudeAvailable();
    if (!c && !native) throw new Error(t("providers.not_connected"));
    const nativeRead = !native ? Promise.resolve()
      : claudeBusy ? new Promise<void>((resolve) => { claudeIdleWaiters.push(resolve); })
      : runClaudeAction("read").catch(() => undefined);
    let methods: Record<string, ProviderAuthMethod[]> = {};
    let legacyError: unknown = null;
    try {
      if (c) {
        const [legacyMethods] = await Promise.all([c.provider.auth().then(unwrap), loadProviderCatalog(c)]);
        methods = buildProviderAuthMethods(legacyMethods as Record<string, ProviderAuthMethod[]>, getProviderAuthProviders());
      }
    } catch (error) {
      legacyError = error;
    }
    await nativeRead;
    const offered = claudeLoginOffered();
    if (legacyError || (!c && !offered)) {
      if (!offered) throw legacyError ?? new Error(t("providers.not_connected"));
      setStateField("providerAuthError", "Other provider connections could not be loaded. Close this window and retry from AI providers.");
    }
    if (offered) methods[CLAUDE_AGENT_HOST_PROVIDER_ID] = [{ type: "external", label: CLAUDE_CODE_NAME }, ...(methods[CLAUDE_AGENT_HOST_PROVIDER_ID] ?? [])];
    return methods;
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
        : await loadProviderAuthMethods();
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

      reportedOAuthConnections.delete(resolved);
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

  const isIncompatiblePermissionsConfigError = (error: unknown, depth = 0): boolean => {
    if (depth > 5) return false;
    if (typeof error === "string") {
      try {
        const parsed: unknown = JSON.parse(error);
        return isIncompatiblePermissionsConfigError(parsed, depth + 1);
      } catch {
        return error.includes("V2 permissions are not supported by OpenCode V1");
      }
    }
    if (!isRecord(error)) return false;
    return isIncompatiblePermissionsConfigError(error.message, depth + 1)
      || isIncompatiblePermissionsConfigError(error.data, depth + 1)
      || (Array.isArray(error.issues) && error.issues.some(
        (issue) => isRecord(issue) && isIncompatiblePermissionsConfigError(issue.message, depth + 1),
      ));
  };

  let providerRefreshGeneration = 0;

  async function refreshProviders(
    optionsArg?: {
      dispose?: boolean;
      force?: boolean;
      configChanged?: boolean;
    },
    isCurrent = () => !disposed,
  ) {
    const c = options.client();
    if (!c || !isCurrent()) return null;
    const generation = ++providerRefreshGeneration;
    const baseUrl = options.providerBaseUrl();
    const directory = options.selectedWorkspaceRoot();
    const isRefreshCurrent = () => !disposed && isCurrent()
      && generation === providerRefreshGeneration
      && baseUrl === options.providerBaseUrl()
      && directory === options.selectedWorkspaceRoot();
    const force = Boolean(optionsArg?.dispose || optionsArg?.force || state.providerLoadState.error);
    setStateField("providerLoadState", { status: "loading", error: state.providerLoadState.error });

    const serverClient = options.openworkServer.getSnapshot().openworkServerClient;
    const liveCatalog = optionsArg?.dispose && serverClient
      ? await serverClient.getEngineV2PreviewStatus().then(status => status.enabled && status.chatRouting).catch(() => false)
      : false;
    if (optionsArg?.dispose && !liveCatalog) {
      const now = Date.now();
      const shouldDispose = Boolean(optionsArg?.configChanged)
        || now - lastGlobalProviderDisposeRefreshAt >= 10_000;
      const shouldUseServerReload = !(
        isDesktopRuntime() && options.selectedWorkspaceDisplay().workspaceType === "local"
      );
      let reloaded = false;
      if (shouldDispose) {
        lastGlobalProviderDisposeRefreshAt = now;
        if (shouldUseServerReload) {
          try {
            const openworkSnapshot = options.openworkServer.getSnapshot();
            const openworkClient = openworkSnapshot.openworkServerClient;
            if (openworkSnapshot.openworkServerStatus === "connected" && openworkClient) {
              const workspaceId =
                options.runtimeWorkspaceId()?.trim() ||
                (await options.ensureRuntimeWorkspaceId?.())?.trim() ||
                "";
              if (workspaceId) {
                try {
                  await openworkClient.reloadEngine(workspaceId);
                } catch (error) {
                  const unreachable =
                    error instanceof OpenworkServerError && error.code === "opencode_engine_unreachable";
                  if (!unreachable || !isDesktopRuntime()) {
                    throw error;
                  }
                  await engineRestart({ diagnosticsCause: "provider-auth" });
                }
                reloaded = true;
              }
            }
          } catch {
          }
        }

        if (!reloaded) {
          try {
            unwrap(await c.instance.dispose());
          } catch {
          }
        }
      }

      try {
        await waitForHealthy(options.client() ?? c, { timeoutMs: 8000, pollMs: 250 });
      } catch {
      }
    }

    if (!isRefreshCurrent()) return null;
    const activeClient = options.client() ?? c;
    try {
      const disabledProviders = await readManagedDisabledProviders({
        opencodeClient: activeClient,
        openworkClient: options.openworkServer.getSnapshot().openworkServerClient,
        workspaceId: options.runtimeWorkspaceId(),
        workspaceType: options.selectedWorkspaceDisplay().workspaceType,
      });
      if (!isRefreshCurrent()) return null;
      const updated = filterProviderList(
        await ensureProviderListQuery(getReactQueryClient(), {
          client: activeClient,
          baseUrl,
          directory,
          force,
        }),
        disabledProviders,
      );
      if (!isRefreshCurrent()) return null;
      options.setDisabledProviders(disabledProviders);
      applyProviderListState(updated);
      setStateField("providerLoadState", { status: "ready", error: null });
      return updated;
    } catch (error) {
      if (isRefreshCurrent()) {
        setStateField("providerLoadState", {
          status: "error",
          error: t(isIncompatiblePermissionsConfigError(error)
            ? "settings.provider_load_incompatible_permissions"
            : "settings.provider_load_error"),
        });
      }
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
      if (resolved.toLowerCase() === DESKTOP_RESTRICTION_OPENCODE_PROVIDER_ID) {
        await ensureProjectProviderDisabledState(resolved, false);
      }
      const trimmedCode = code?.trim();
      const workspaceId = options.runtimeWorkspaceId();
      const result = await c.provider.oauth.callback({
        providerID: resolved,
        method: methodIndex,
        code: trimmedCode || undefined,
      });
      assertNoClientError(result);
      if (workspaceId) useProviderCredentialHealth.getState().changed(workspaceId, resolved);
      const updated = await refreshProviders({ dispose: true });
      const connectedNow = Array.isArray(updated?.connected) && updated.connected.includes(resolved);
      if (connectedNow) {
        reportOAuthConnected(resolved);
        return { connected: true, message: `${t("status.connected")} ${resolved}` };
      }
      const connected = await waitForProviderConnection();
      if (connected) {
        reportOAuthConnected(resolved);
        return { connected: true, message: `${t("status.connected")} ${resolved}` };
      }
      return { connected: false, pending: true };
    } catch (error) {
      if (isPendingOauthError(error)) {
        const updated = await refreshProviders({ dispose: true });
        if (Array.isArray(updated?.connected) && updated.connected.includes(resolved)) {
          reportOAuthConnected(resolved);
          return { connected: true, message: `${t("status.connected")} ${resolved}` };
        }
        const connected = await waitForProviderConnection();
        if (connected) {
          reportOAuthConnected(resolved);
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
    if (providerId === CLAUDE_AGENT_PROVIDER_ID) throw new Error("Claude Code uses its own sign-in, not an API key.");
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

    setStateField("providerAuthBusy", true);
    try {
      if (providerId.trim().toLowerCase() === DESKTOP_RESTRICTION_OPENCODE_PROVIDER_ID) {
        await ensureProjectProviderDisabledState(providerId, false);
      }
      const workspaceId = options.runtimeWorkspaceId();
      assertNoClientError(await c.auth.set({ providerID: providerId, auth: { type: "api", key: trimmed } }));
      featureAnalytics.providerConnected(providerId, "api_key");
      if (workspaceId) useProviderCredentialHealth.getState().changed(workspaceId, providerId);
      await refreshProviders({ dispose: true });
      await getReactQueryClient().invalidateQueries({ queryKey: ["local-provider-engine-states"] });
      return `${t("status.connected")} ${providerId}`;
    } catch (error) {
      const message = describeProviderError(error, t("providers.save_api_key_failed"));
      setStateField("providerAuthError", message);
      throw error instanceof Error ? error : new Error(message);
    } finally {
      setStateField("providerAuthBusy", false);
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
        token,
      });
      const provider = await den.getOrgLlmProviderConnection(orgId, cloudProviderId);
      const localProviderId = getCloudManagedProviderId(provider);
      assertProviderAllowedByDesktopPolicy(localProviderId);
      const existingImported = state.importedCloudProviders[cloudProviderId] ?? null;
      const { envEntries, primaryApiKey } = resolveCloudProviderCredentials(provider);
      const env = getCloudProviderEnv(provider.providerConfig);
      if (!primaryApiKey && env.length > 0) {
        throw new CloudProviderNeedsCredentialError(
          `${provider.name} does not have a stored organization credential yet.`,
        );
      }

      await assertCloudProviderImportSafe(provider);

      if (envEntries.length > 0) {
        const openworkClient = options.openworkServer.getSnapshot().openworkServerClient;
        if (!openworkClient) {
          throw new CloudProviderNeedsServerError(
            `${provider.name} needs environment variables (${envEntries
              .map((entry) => entry.key)
              .join(", ")}) but the OpenWork server is not available.`,
          );
        }
        await openworkClient.upsertUserEnv(envEntries);
      }
      if (primaryApiKey) {
        await c.auth.set({
          providerID: localProviderId,
          auth: { type: "api", key: primaryApiKey },
        });
        await mirrorCloudProviderEnv(provider, primaryApiKey, envEntries);
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
      const nextImportedProviders = {
        ...state.importedCloudProviders,
        [provider.id]: {
          cloudProviderId: provider.id,
          providerId: localProviderId,
          sourceProviderId: provider.providerId,
          name: provider.name,
          source: provider.source,
          updatedAt: provider.updatedAt ?? null,
          modelIds: getProviderModelIds(provider),
          pinnedModelIds: provider.pinnedModelIds?.filter((id) => getProviderModelIds(provider).includes(id)) ?? [],
          modelConfigVersion: CLOUD_MODEL_CONFIG_VERSION,
          importedAt: Date.now(),
        },
      };
      await patchRuntimeProviderAndImportedCloudProviders(
        buildRuntimeProviderPatch(provider, localProviderId, existingImported?.providerId ?? null),
        nextImportedProviders,
      );
      await stripLegacyCloudProviderBlocks([localProviderId, existingImported?.providerId]);

      const nextDisabledProviders = options
        .disabledProviders()
        .filter((id) => id !== localProviderId && id !== existingImported?.providerId);
      options.setDisabledProviders(nextDisabledProviders);
      if (!optionsArg?.silent) {
        options.markOpencodeConfigReloadRequired();
        await refreshProviders({ dispose: true });
      }
      refreshSnapshot();
      emitChange();
      if (!optionsArg?.silent) featureAnalytics.providerConnected(provider.providerId, "organization");
      return `${t("status.connected")} ${provider.name}`;
    } catch (error) {
      const message = describeProviderError(error, "Failed to connect organization provider.");
      if (!optionsArg?.silent) {
        setStateField("providerAuthError", message);
      }
      throw error instanceof Error ? error : new Error(message);
    }
  }

  const describeCloudProviderSyncError = (error: unknown): CloudProviderSyncError => ({
    kind: error instanceof CloudProviderImportConflictError
      ? "conflict"
      : error instanceof CloudProviderNeedsCredentialError
        ? "needs_credential"
        : error instanceof CloudProviderNeedsServerError
          ? "needs_server"
          : "error",
    message: describeProviderError(error, "Cloud provider sync failed."),
  });

  const setCloudProviderSyncError = (
    cloudProviderId: string,
    error: CloudProviderSyncError | null,
  ) => {
    const current = state.lastSyncError[cloudProviderId];
    if (!error && !current) return;
    if (error && current?.kind === error.kind && current.message === error.message) return;
    const next = { ...state.lastSyncError };
    if (error) {
      next[cloudProviderId] = error;
    } else {
      delete next[cloudProviderId];
    }
    setStateField("lastSyncError", next);
  };

  async function connectCloudProvider(cloudProviderId: string) {
    try {
      const result = await connectCloudProviderInternal(cloudProviderId);
      setCloudProviderSyncError(cloudProviderId, null);
      return result;
    } catch (error) {
      setCloudProviderSyncError(cloudProviderId, describeCloudProviderSyncError(error));
      throw error;
    }
  }

  async function removeCloudProviderInternal(
    cloudProviderId: string,
    optionsArg?: { silent?: boolean; importedProvider?: CloudImportedProvider; isCurrent?: () => boolean },
  ) {
    const isCurrent = optionsArg?.isCurrent ?? (() => true);
    const assertCurrent = () => {
      if (!isCurrent()) throw new Error("Cloud provider cleanup context changed.");
    };
    assertCurrent();
    if (!optionsArg?.silent) {
      setStateField("providerAuthError", null);
    }
    const imported = optionsArg?.importedProvider ?? state.importedCloudProviders[cloudProviderId];
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
      assertCurrent();
      await patchRuntimeProviders({ [imported.providerId]: null }, isCurrent);
      assertCurrent();
      await stripLegacyCloudProviderBlocks([imported.providerId], isCurrent);
      assertCurrent();

      const nextImportedProviders = { ...state.importedCloudProviders };
      delete nextImportedProviders[cloudProviderId];
      await persistImportedCloudProviders(nextImportedProviders, isCurrent);
      assertCurrent();

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

  const recordCloudProviderSyncError = (
    cloudProviderId: string,
    reason: CloudProviderSyncReason,
    error: unknown,
  ) => {
    const syncError = describeCloudProviderSyncError(error);
    setCloudProviderSyncError(cloudProviderId, syncError);
    console.warn(`[cloud-provider-sync:${reason}] ${syncError.message}`);
    return syncError.message;
  };

  const getCloudProviderSyncContextKey = () => {
    const settings = readDenSettings();
    return [
      settings.baseUrl,
      settings.activeOrgId?.trim() ?? "",
      settings.authToken?.trim() ?? "",
      options.selectedWorkspaceDisplay().workspaceType,
      options.selectedWorkspaceRoot().trim(),
      options.runtimeWorkspaceId() ?? "",
      options.client() ? "connected" : "disconnected",
      getDenSessionDeliveryKey(),
    ].join("::");
  };

  const refreshLiveGatewaySignIns = async () => {
    if (disposed || state.liveGatewayProviders === null) return;
    const contextKey = getCloudProviderSyncContextKey();
    await refreshLiveGatewayProviders(() => !disposed && contextKey === getCloudProviderSyncContextKey());
  };

  const hasCloudProviderSyncPrerequisites = () => {
    const settings = readDenSettings();
    const workspaceTarget =
      options.selectedWorkspaceRoot().trim() || options.runtimeWorkspaceId() || "";
    return Boolean(
      options.client() &&
        settings.authToken?.trim() &&
        settings.activeOrgId?.trim() &&
        (workspaceTarget || serverHandlesProviderSync()),
    );
  };

  const publishSettingsCloudProviderSyncError = (
    reason: CloudProviderSyncReason,
    message: string,
  ) => {
    if (reason !== "settings_cloud_opened") return;
    setStateField(
      "providerAuthError",
      hasCloudProviderSyncPrerequisites() ? message : null,
    );
  };

  const preselectEntitledOrgDefaultModel = (
    providerList: ProviderListResponse | null | undefined,
  ) => {
    const replacement = resolveEntitledOrgDefaultModel(
      providerListModelEntitlementOptions(providerList),
      {
        currentDefault: readStoredDefaultModel(),
        restrictToCloud: options.checkDesktopAppRestriction({ restriction: "allowCustomProviders" }),
        checkRestriction: options.checkDesktopAppRestriction,
      },
    );
    if (replacement && !hasPendingGatewayModelSelection()) writeStoredDefaultModel(replacement);
  };

  const refreshProvidersAfterCloudSync = async (optionsArg: {
    dispose?: boolean;
    force?: boolean;
  }, isCurrent = () => !disposed) => {
    const providerList = await refreshProviders(optionsArg, isCurrent);
    if (!isCurrent()) return null;
    preselectEntitledOrgDefaultModel(providerList);
    return providerList;
  };

  async function performCloudProviderSync(reason: CloudProviderSyncReason) {
    const usageScope = readGatewayUsageScope();
    const usageContext = getCloudProviderSyncContextKey();
    if (!hasCloudProviderSyncPrerequisites()) {
      return;
    }

    const [readTarget, target] = await Promise.all([
      resolveOpenworkConfigTarget("read"),
      resolveOpenworkConfigTarget("write"),
    ]);
    if (
      !readTarget.canUseOpenworkServer ||
      !target.canUseOpenworkServer ||
      !target.openworkClient ||
      !target.openworkWorkspaceId
    ) {
      return;
    }

    let importedProviders: Record<string, CloudImportedProvider>;
    try {
      importedProviders = await refreshImportedCloudProviders({ strict: true });
    } catch (error) {
      logCloudProviderSyncError(reason, error);
      return;
    }
    const liveProviders = await refreshCloudOrgProviders({ force: true });
    const liveProviderMap = new Map(liveProviders.map((provider) => [provider.id, provider]));
    const failures: string[] = [];
    const processedLiveProviderIds = new Set<string>();
    let configChanged = false;
    const restrictToCloud = options.checkDesktopAppRestriction({ restriction: "allowCustomProviders" });

    const canSyncProvider = (provider: DenOrgLlmProvider) =>
      isProviderAllowedByDesktopPolicy({
        providerId: getCloudManagedProviderId(provider),
        restrictToCloud,
        checkRestriction: options.checkDesktopAppRestriction,
      });

    const shouldSkipTerminalConflict = (cloudProviderId: string) =>
      reason !== "manual" && state.lastSyncError[cloudProviderId]?.kind === "conflict";

    for (const importedProvider of Object.values(importedProviders)) {
      const liveProvider = liveProviderMap.get(importedProvider.cloudProviderId);
      if (!liveProvider) {
        try {
          await removeCloudProviderInternal(importedProvider.cloudProviderId, { silent: true });
          setCloudProviderSyncError(importedProvider.cloudProviderId, null);
          configChanged = true;
        } catch (error) {
          failures.push(recordCloudProviderSyncError(importedProvider.cloudProviderId, reason, error));
        }
        continue;
      }

      processedLiveProviderIds.add(liveProvider.id);

      if (!canSyncProvider(liveProvider) || shouldSkipTerminalConflict(liveProvider.id)) {
        continue;
      }

      if (!isCloudProviderOutOfSync(liveProvider, importedProvider)) {
        setCloudProviderSyncError(liveProvider.id, null);
        continue;
      }
      if (!liveProvider.hasApiKey && getCloudProviderEnv(liveProvider.providerConfig).length > 0) {
        setCloudProviderSyncError(liveProvider.id, {
          kind: "needs_credential",
          message: `${liveProvider.name} does not have a stored organization credential yet.`,
        });
        continue;
      }

      try {
        await connectCloudProviderInternal(liveProvider.id, { silent: true });
        setCloudProviderSyncError(liveProvider.id, null);
        configChanged = true;
      } catch (error) {
        failures.push(recordCloudProviderSyncError(liveProvider.id, reason, error));
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
      if (!canSyncProvider(liveProvider) || shouldSkipTerminalConflict(liveProvider.id)) {
        continue;
      }
      if (!liveProvider.hasApiKey && getCloudProviderEnv(liveProvider.providerConfig).length > 0) {
        setCloudProviderSyncError(liveProvider.id, {
          kind: "needs_credential",
          message: `${liveProvider.name} does not have a stored organization credential yet.`,
        });
        continue;
      }

      try {
        await connectCloudProviderInternal(liveProvider.id, { silent: true });
        setCloudProviderSyncError(liveProvider.id, null);
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
        failures.push(recordCloudProviderSyncError(liveProvider.id, reason, error));
      }
    }

    const refreshedCatalog = await refreshProvidersAfterCloudSync(
      configChanged ? { dispose: true } : { force: true },
    ).catch(() => null);
    if (refreshedCatalog && failures.length === 0 && usageScope === readGatewayUsageScope()
      && usageContext === getCloudProviderSyncContextKey()
      && Object.values(state.importedCloudProviders).every((provider) => liveProviderMap.has(provider.cloudProviderId))) {
      verifiedGatewayUsageContext = usageContext;
      setStateField("gatewayUsageProviderScope", usageScope.generation);
    }

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

  function isGatewayModelAvailable(provider: GatewayConnectProvider, model: { providerID: string; modelID: string }) {
    const ready = state.liveGatewayProviders === null
      ? isGatewayModelReady(provider, model, state)
      : Boolean(provider.credentialSetId) && model.providerID === provider.cloudProviderId
        && model.modelID.split("_")[2] === provider.credentialSetId?.slice(4)
        && isLiveGatewaySetConnected(provider, state.liveGatewayProviders);
    return ready
      && isProviderAllowedByDesktopPolicy({ providerId: model.providerID,
        restrictToCloud: options.checkDesktopAppRestriction({ restriction: "allowCustomProviders" }),
        checkRestriction: options.checkDesktopAppRestriction })
      && options.providerConnectedIds().includes(model.providerID)
      && !options.disabledProviders().includes(model.providerID)
      && options.providers().some((entry) => entry.id === model.providerID && Boolean(entry.models[model.modelID]));
  }

  async function startGatewayProviderOAuth(providerId: string, credentialSetId?: string, signal?: AbortSignal) {
    const orgId = readDenSettings().activeOrgId;
    const client = options.openworkServer.getSnapshot().openworkServerClient;
    if (!orgId || !client) throw new Error("Sign in to OpenWork before connecting this provider.");
    if (getOpenworkGatewayOrigin()) throw new Error("Open My Model Connections in Den to connect your account, then refresh models here.");
    const contextKey = getCloudProviderSyncContextKey();
    const isCurrent = () => !disposed && !signal?.aborted && contextKey === getCloudProviderSyncContextKey();
    if (!isCurrent() || !await pushDenSession() || !isCurrent()) {
      throw new Error("The active account or organization changed, or its session could not be delivered. Retry sign-in.");
    }
    const delivery = syncDenSessionDelivery();
    if (!delivery || !isCurrent()) throw new Error("The active account changed. Retry sign-in.");
    const requestSignal = signal ? AbortSignal.any([signal, delivery.controller.signal]) : delivery.controller.signal;
    const result = await client.startGatewayProviderOAuth(providerId, orgId, credentialSetId, requestSignal);
    if (!isCurrent()) throw new Error("The active account or organization changed. Retry sign-in.");
    return result;
  }

  async function shareDeviceProvider(providerId: string, verifiedToken?: string): Promise<{ inferenceProviderId: string; name: string }> {
    const orgId = readDenSettings().activeOrgId;
    const client = options.openworkServer.getSnapshot().openworkServerClient;
    if (!orgId || !client) throw new Error("Sign in to OpenWork before sharing this provider.");
    const workspaceClient = options.nativeOpenworkClient?.();
    if (getOpenworkGatewayOrigin() || !isLoopbackOpenworkServerUrl(client.baseUrl)
      || (workspaceClient && workspaceClient.baseUrl !== client.baseUrl)) {
      throw new Error("Share keys from this device's local workspace, or add a provider in AI Gateway.");
    }
    const contextKey = getCloudProviderSyncContextKey();
    const isCurrent = () => !disposed && contextKey === getCloudProviderSyncContextKey();
    if (!isCurrent() || !await pushDenSession() || !isCurrent()) {
      throw new Error("The active account or organization changed, or its session could not be delivered. Nothing was shared.");
    }
    const result = await client.shareDeviceProvider(providerId, orgId, verifiedToken);
    if (isCurrent() && !options.providerFilterSyncFixEnabled?.()) {
      await Promise.allSettled([refreshCloudOrgProviders({ force: true }), runCloudProviderSync("manual")]);
    }
    return result;
  }

  async function syncSharedDeviceProvider(providerId: string, shared: { inferenceProviderId: string; name: string }): Promise<SharedDeviceProviderArrival> {
    if (!options.providerFilterSyncFixEnabled?.()) return { status: "pending" };
    const contextKey = getCloudProviderSyncContextKey();
    const settings = readDenSettings();
    const orgId = settings.activeOrgId?.trim();
    const token = settings.authToken?.trim();
    const isCurrent = () => !disposed && options.providerFilterSyncFixEnabled?.() === true
      && contextKey === getCloudProviderSyncContextKey();
    if (!orgId || !token || !isCurrent() || !isProviderAllowedByDesktopPolicy({
      providerId: shared.inferenceProviderId,
      restrictToCloud: options.checkDesktopAppRestriction({ restriction: "allowCustomProviders" }),
      checkRestriction: options.checkDesktopAppRestriction,
    })) return { status: "pending" };
    try {
      await runCloudProviderSync("manual", { fresh: true, throwOnError: true });
      if (!isCurrent()) return { status: "pending" };
      const den = createDenClient({ baseUrl: settings.baseUrl, token });
      return await confirmSharedGatewayProvider({
        providerId, inferenceProviderId: shared.inferenceProviderId, isCurrent,
        isListed: () => state.liveGatewayProviders !== null
          ? state.liveGatewayProviders.some((provider) => provider.id === shared.inferenceProviderId)
          : Boolean(state.importedCloudProviders[shared.inferenceProviderId])
            && state.cloudProviderServerSync?.lastRun?.status !== "failed"
            && state.cloudProviderServerSync?.reloadPending !== true,
        readGatewayProviders: async () => {
          const providers = await den.listOrgUsableGatewayProviders(orgId);
          if (isCurrent() && state.liveGatewayProviders !== null) setStateField("liveGatewayProviders", providers);
          return providers;
        },
        readEngineProviders: () => refreshProviders({ force: true }, isCurrent),
        wait: () => new Promise((resolve) => setTimeout(resolve, 500)),
      });
    } catch {
      return { status: "pending" };
    }
  }

  async function runCloudProviderSync(reason: CloudProviderSyncReason, syncOptions?: { fresh?: boolean; throwOnError?: boolean }): Promise<void | { outcome: "handled_server_side" | "handled_live" }> {
    if (disposed) return;
    const delivery = syncDenSessionDelivery();
    const contextKey = getCloudProviderSyncContextKey();
    const usageScope = readGatewayUsageScope();
    const isCurrent = () => !disposed && usageScope === readGatewayUsageScope()
      && contextKey === getCloudProviderSyncContextKey();
    const refreshUsageOnly = () => {
      if (!usageScope.token || !usageScope.organizationId) return Promise.resolve();
      return enqueueGlobalCloudProviderSync(
        `usage:${contextKey}`,
        async () => { void refreshGatewayUsageAfterCloudSync(usageScope); },
        isCurrent,
      ).catch(() => {});
    };
    if (!hasCloudProviderSyncPrerequisites()) {
      await refreshUsageOnly();
      if (!isCurrent()) return;
      if (reason === "settings_cloud_opened") {
        setStateField("providerAuthError", null);
      }
      if (delivery && !getOpenworkGatewayOrigin()) {
        try {
          await pushDenSession("identity");
        } catch (error) {
          if (isCurrentDenSessionDelivery(delivery)) logCloudProviderSyncError(reason, error);
        }
      }
      return;
    }
    if (getOpenworkGatewayOrigin()) {
      await refreshUsageOnly();
      if (!isCurrent()) return;
      if (!loggedGatewayCloudProviderSyncSkip) {
        loggedGatewayCloudProviderSyncSkip = true;
        console.info(
          `[cloud-provider-sync:${reason}] Provider materialization is handled server-side in gateway mode.`,
        );
      }
      if (reason === "manual" || reason === "settings_cloud_opened") {
        await refreshProvidersAfterCloudSync({ force: true }, isCurrent);
      }
      return { outcome: "handled_server_side" };
    }

    if (serverHandlesProviderSync()) {
      const isCurrent = () => isCurrentDenSessionDelivery(delivery) && usageScope === readGatewayUsageScope()
        && contextKey === getCloudProviderSyncContextKey();
      try {
        const result = await enqueueGlobalCloudProviderSync(
          `server:${contextKey}${syncOptions?.fresh ? `:fresh:${++freshCloudProviderSyncGeneration}` : ""}`,
          async () => {
            if (!isCurrent()) return;
            const openworkClient = options.openworkServer.getSnapshot().openworkServerClient;
            if (!openworkClient) throw new Error("OpenWork server unavailable.");
            if (!await pushDenSession() || !isCurrent()) return;
            if (isOpencodeV2BaseUrl(options.providerBaseUrl())) {
              const status = await openworkClient.getEngineV2PreviewStatus().catch(() => null);
              if (!isCurrent()) return;
              const baseUrl = options.providerBaseUrl();
              const queryClient = getReactQueryClient();
              const key = liveProviderSyncStatusQueryKey(baseUrl);
              const previouslyLive = usesLiveProviderSync({ baseUrl, status: queryClient.getQueryData<LiveProviderSyncStatus>(key) });
              if (status) queryClient.setQueryData(key, status);
              if (usesLiveProviderSync({ baseUrl, status })) {
                if (syncOptions?.fresh && options.providerFilterSyncFixEnabled?.()) {
                  await openworkClient.refreshGatewayProviderCatalog(delivery?.controller.signal);
                  if (!isCurrent()) return;
                }
                if (!previouslyLive) dispatchProviderCatalogChanged({
                  baseUrl, directory: options.selectedWorkspaceRoot(), reason: "reconnect",
                });
                void refreshGatewayUsageAfterCloudSync(usageScope);
                return { status: "live" as const };
              }
            }
            let result = await openworkClient.runCloudProviderSyncNow(reason, delivery?.controller.signal);
            if (!isCurrent()) return;
            if (result.status === "no_session") {
              if (!await pushDenSession("sync", true) || !isCurrent()) return;
              result = await openworkClient.runCloudProviderSyncNow(reason, delivery?.controller.signal);
            }
            if (isCurrent()) void refreshGatewayUsageAfterCloudSync(usageScope);
            return result;
          },
          isCurrent,
        );
        if (!isCurrent()) return;
        if (!result) throw new Error("Cloud provider sync returned no result.");
        if (result.status === "live") {
          await refreshImportedCloudProviders();
          if (!isCurrent()) return;
          await refreshLiveGatewayProviders(isCurrent);
          if (!isCurrent()) return;
          return { outcome: "handled_live" };
        }
        if (state.liveGatewayProviders !== null) setStateField("liveGatewayProviders", null);
        if (result.status === "failed" || result.status === "no_session") {
          verifiedGatewayUsageContext = "";
          setStateField("gatewayUsageProviderScope", null);
        }
        await refreshImportedCloudProviders({
          verifiedScope: result.status === "applied" || result.status === "noop" ? usageScope.generation : undefined,
        });
        if (!isCurrent()) return;
        if (result.status === "failed" || result.status === "no_session") {
          const message = logCloudProviderSyncError(
            reason,
            new Error(result.message ?? "Cloud provider sync failed."),
          );
          publishSettingsCloudProviderSyncError(reason, message);
          if (syncOptions?.throwOnError) throw new Error(message);
          return;
        }
        await refreshProvidersAfterCloudSync({ force: true }, isCurrent);
        if (!isCurrent()) return;
        return { outcome: "handled_server_side" };
      } catch (error) {
        if (!isCurrent()) return;
        const message = logCloudProviderSyncError(reason, error);
        publishSettingsCloudProviderSyncError(reason, message);
        if (syncOptions?.throwOnError) throw error;
        return;
      }
    }

    await enqueueGlobalCloudProviderSync(
      `client:${contextKey}${syncOptions?.fresh ? `:fresh:${++freshCloudProviderSyncGeneration}` : ""}`,
      async () => {
        try {
          await performCloudProviderSync(reason);
        } finally {
          if (isCurrent()) void refreshGatewayUsageAfterCloudSync(usageScope);
        }
      },
      isCurrent,
    ).catch((error) => {
      if (!isCurrent()) return;
      const message = logCloudProviderSyncError(reason, error);
      publishSettingsCloudProviderSyncError(reason, message);
      if (syncOptions?.throwOnError) throw error;
    });
  }

  async function disconnectProvider(providerId: string) {
    if (providerId === CLAUDE_AGENT_PROVIDER_ID) return runClaudeAction("disconnect");
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

    const workspaceKey = currentWorkspaceKey();
    const baseUrl = options.providerBaseUrl();
    const isCurrentWorkspace = () => !disposed
      && workspaceKey === currentWorkspaceKey()
      && baseUrl === options.providerBaseUrl();
    const requireDiscovery = (updated: ProviderListResponse | null, requireDisconnected = false) => {
      if (!isCurrentWorkspace() || !updated || !Array.isArray(updated.all) || !Array.isArray(updated.connected)
        || (requireDisconnected && updated.connected.includes(resolved))) {
        throw new Error(t("providers.disconnect_unverified"));
      }
      return updated;
    };

    try {
      if (resolved.toLowerCase() === DESKTOP_RESTRICTION_OPENCODE_PROVIDER_ID) {
        try {
          await removeProviderAuthCredentials(resolved);
        } catch {
        }
        if (!isCurrentWorkspace()) throw new Error(t("providers.disconnect_unverified"));
        const configChanged = await ensureProjectProviderDisabledState(resolved, true);
        requireDiscovery(await refreshProviders({ dispose: true, configChanged }, isCurrentWorkspace), true);
        removeProviderFromState(resolved);
        return `${t("providers.disconnected_prefix")} ${resolved}`;
      }

      await removeProviderAuthCredentials(resolved);
      const updated = requireDiscovery(await refreshProviders({ dispose: true }, isCurrentWorkspace));
      if (updated.connected.includes(resolved)) {
        const stillConnected = updated.all.find((provider) => provider.id === resolved);
        if (stillConnected && stillConnected.source !== "env") {
          const configChanged = await ensureProjectProviderDisabledState(resolved, true);
          requireDiscovery(await refreshProviders({ dispose: true, configChanged }, isCurrentWorkspace), true);
          removeProviderFromState(resolved);
          return `${t("providers.disconnected_prefix")} ${resolved}`;
        }
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

  async function enableProvider(providerId: string) {
    setStateField("providerAuthError", null);
    const resolved = providerId.trim();
    if (!resolved) {
      throw new Error(t("providers.provider_id_required"));
    }
    assertProviderAllowedByDesktopPolicy(resolved);
    const workspaceKey = currentWorkspaceKey();
    const baseUrl = options.providerBaseUrl();
    const isCurrentWorkspace = () => !disposed
      && workspaceKey === currentWorkspaceKey()
      && baseUrl === options.providerBaseUrl();
    try {
      const configChanged = await ensureProjectProviderDisabledState(resolved, false);
      await refreshProviders({ dispose: true, configChanged }, isCurrentWorkspace);
      return `${t("providers.enabled_prefix")} ${resolved}`;
    } catch (error) {
      const message = describeProviderError(error, t("providers.enable_failed"));
      setStateField("providerAuthError", message);
      throw error instanceof Error ? error : new Error(message);
    }
  }

  async function disableProvider(providerId: string) {
    setStateField("providerAuthError", null);
    const resolved = providerId.trim();
    if (!resolved) {
      throw new Error(t("providers.provider_id_required"));
    }
    const workspaceKey = currentWorkspaceKey();
    const baseUrl = options.providerBaseUrl();
    const isCurrentWorkspace = () => !disposed
      && workspaceKey === currentWorkspaceKey()
      && baseUrl === options.providerBaseUrl();
    try {
      const configChanged = await ensureProjectProviderDisabledState(resolved, true);
      await refreshProviders({ dispose: true, configChanged }, isCurrentWorkspace);
      return `${t("providers.disconnected_prefix")} ${resolved}`;
    } catch (error) {
      const message = describeProviderError(error, t("providers.disconnect_failed"));
      setStateField("providerAuthError", message);
      throw error instanceof Error ? error : new Error(message);
    }
  }

  function isProviderAddRestricted(providerId?: string | null) {
    return isProviderAddRestrictedByDesktopPolicy({
      providerId,
      checkRestriction: options.checkDesktopAppRestriction,
    });
  }

  async function openProviderAuthModal(optionsArg?: {
    returnFocusTarget?: ProviderReturnFocusTarget;
    preferredProviderId?: string;
  }) {
    if (isProviderAddRestricted(optionsArg?.preferredProviderId)) {
      const message = t("providers.custom_providers_disabled");
      mutateState((current) => ({
        ...current,
        providerAuthReturnFocusTarget: "none",
        providerAuthPreferredProviderId: null,
        providerAuthBusy: false,
        providerAuthModalOpen: false,
        providerAuthError: message,
      }));
      throw new Error(message);
    }

    mutateState((current) => ({
      ...current,
      providerAuthReturnFocusTarget: optionsArg?.returnFocusTarget ?? "none",
      providerAuthPreferredProviderId: optionsArg?.preferredProviderId?.trim() || null,
      providerAuthBusy: true,
      providerAuthError: null,
    }));

    try {
      const methods = await loadProviderAuthMethods();
      mutateState((current) => ({
        ...current,
        providerAuthMethods: methods,
        providerAuthModalOpen: true,
      }));
    } catch (error) {
      const message = describeProviderError(error, t("providers.load_failed"));
      if (!options.client()) {
        mutateState((current) => ({
          ...current,
          providerAuthPreferredProviderId: null,
          providerAuthReturnFocusTarget: "none",
          providerAuthError: message,
        }));
        throw error;
      }
      mutateState((current) => ({
        ...current,
        providerAuthMethods: {},
        providerAuthPreferredProviderId: null,
        providerAuthModalOpen: true,
        providerAuthError: message,
      }));
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
    if (disposed) return;
    const delivery = syncDenSessionDelivery();
    const workspaceId = options.runtimeWorkspaceId();
    if (workspaceId && options.providerBaseUrl().trim()) useProviderCredentialHealth.getState().bindWorkspace(workspaceId, providerCredentialScope(options.providerBaseUrl()));
    const workspaceKey = currentWorkspaceKey();
    const workspaceChanged = workspaceKey !== lastWorkspaceKey;
    lastWorkspaceKey = workspaceKey;
    if (claudeAvailable() && !claudeBusy && claudeContext !== nativeContext()) {
      void runClaudeAction("read").catch(() => undefined);
    }
    refreshSnapshot();
    emitChange();
    if (workspaceChanged) {
      setStateField("lastSyncError", {});
      void refreshImportedCloudProviders();
    }
    if (serverHandlesProviderSync()) {
      const nextSyncContextKey = getCloudProviderSyncContextKey();
      if (nextSyncContextKey === cloudProviderSyncContextKey) return;
      cloudProviderSyncContextKey = nextSyncContextKey;
      void runCloudProviderSync("app_launch").then((result) => {
        if (!result && isCurrentDenSessionDelivery(delivery) && cloudProviderSyncContextKey === nextSyncContextKey) {
          cloudProviderSyncContextKey = "";
        }
      });
      return;
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
    disposed = false;
    started = true;
    lastWorkspaceKey = currentWorkspaceKey();
    if (typeof window !== "undefined") {
      const handleDenSessionUpdate = (event: Event) => {
        const detail = (event as CustomEvent<DenSessionUpdatedDetail>).detail;
        if (detail?.status !== "success" && detail?.status !== "signed_out") return;

        cloudOrgProvidersGeneration += 1;
        cloudOrgProvidersLoadKey = "";
        cloudOrgProvidersInFlightKey = "";
        cloudOrgProvidersInFlight = null;

        if (detail.status === "success") {
          mutateState((current) => ({
            ...current,
            cloudOrgProviders: [],
            providerAuthMethods: {},
            providerAuthError: null,
            cloudProviderServerSync: null,
            liveGatewayProviders: null,
            lastSyncError: {},
          }));
          void refreshCloudOrgProviders({ force: true }).catch(() => undefined);
          void runCloudProviderSync("sign_in");
        } else {
          invalidateDenSessionDelivery();
          forgetDeliveredDenSession();
          const connectedProviderIdsBeforeLogout = options.providerConnectedIds();
          const logoutProviderIds = [...new Set([
            ...Object.values(state.importedCloudProviders).map((provider) => provider.providerId),
            ...state.cloudOrgProviders.map(getCloudManagedProviderId),
          ])];
          clearProviderListQueries(getReactQueryClient());
          for (const providerId of logoutProviderIds) {
            removeProviderFromState(providerId);
          }
          if (
            logoutProviderIds.some(
              (providerId) => providerId === readStoredDefaultModel().providerID,
            )
          ) {
            writeStoredDefaultModel(DEFAULT_MODEL);
          }
          mutateState((current) => ({
            ...current,
            cloudOrgProviders: [],
            providerAuthMethods: {},
            providerAuthError: null,
            cloudProviderServerSync: null,
            liveGatewayProviders: null,
            lastSyncError: {},
          }));
          if (serverHandlesProviderSync()) {
            const workspaceKey = currentWorkspaceKey();
            const generation = cloudOrgProvidersGeneration;
            const isCurrent = () => !disposed && generation === cloudOrgProvidersGeneration && workspaceKey === currentWorkspaceKey();
            setStateField("importedCloudProviders", {});
            void (async () => {
              const cleared = await options.openworkServer.getSnapshot().openworkServerClient?.deleteDenSession().then(() => true, () => false);
              if (!isCurrent()) return;
              if (isDesktopRuntime()) {
                await engineRestart({ diagnosticsCause: "provider-auth" }).catch(() => undefined);
              }
              if (!cleared) return;
              const providers = await refreshProviders({ force: true }, isCurrent);
              const defaultProviderId = readStoredDefaultModel().providerID;
              if (
                providers &&
                connectedProviderIdsBeforeLogout.includes(defaultProviderId) &&
                isCloudManagedProviderKey(defaultProviderId) &&
                !providers.connected.includes(defaultProviderId)
              ) {
                writeStoredDefaultModel(DEFAULT_MODEL);
              }
            })();
            return;
          }
          const importedProviders = { ...state.importedCloudProviders };
          const importedIds = Object.keys(importedProviders);

          void (async () => {
            for (const cloudId of importedIds) {
              try {
                await removeCloudProviderInternal(cloudId, { silent: true });
              } catch {
              }
            }
            try {
              const orphans = await sweepOrphanCloudProvidersFromConfig();
              for (const providerId of orphans) {
                try {
                  await removeProviderAuthCredentials(providerId);
                } catch {
                }
              }
              if (orphans.length > 0) {
                options.markOpencodeConfigReloadRequired();
              }
            } catch {
            }
            mutateState((current) => ({
              ...current,
              cloudOrgProviders: [],
              providerAuthMethods: {},
              providerAuthError: null,
              importedCloudProviders: {},
              cloudProviderServerSync: null,
              liveGatewayProviders: null,
              lastSyncError: {},
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
      const handleDenSettingsChange = () => {
        syncFromOptions();
        void refreshCloudOrgProviders({ force: true }).catch(() => undefined);
      };
      window.addEventListener(
        denSettingsChangedEvent,
        handleDenSettingsChange,
      );
      denSessionCleanup = () => {
        window.removeEventListener(
          denSessionUpdatedEvent,
          handleDenSessionUpdate as EventListener,
        );
        window.removeEventListener(
          denSettingsChangedEvent,
          handleDenSettingsChange,
        );
      };
    }
    void refreshCloudOrgProviders().catch(() => undefined);
    const importRefreshGeneration = cloudOrgProvidersGeneration;
    const importRefreshContextKey = getCloudProviderSyncContextKey();
    const importRefreshWorkspaceKey = cloudImportWorkspaceKey();
    void refreshImportedCloudProviders().then((imported) => {
      if (
        disposed || importRefreshGeneration !== cloudOrgProvidersGeneration ||
        importRefreshContextKey !== getCloudProviderSyncContextKey() || importRefreshWorkspaceKey !== cloudImportWorkspaceKey()
      ) return;
      if (serverHandlesProviderSync()) {
        if (!readDenSettings().authToken?.trim()) {
          void options.openworkServer.getSnapshot().openworkServerClient?.deleteDenSession().catch(() => undefined);
        }
        return;
      }
      if (!hasCloudProviderSyncPrerequisites()) {
        void (async () => {
          if (imported && Object.keys(imported).length > 0) {
            for (const cloudId of Object.keys(imported)) {
              try {
                await removeCloudProviderInternal(cloudId, { silent: true });
              } catch {}
            }
          }
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
            cloudProviderServerSync: null,
            liveGatewayProviders: null,
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
    invalidateDenSessionDelivery();
    started = false;
    denSessionCleanup?.();
    denSessionCleanup = null;
    if (claudeFollowUp) { clearTimeout(claudeFollowUp); claudeFollowUp = null; }
    for (const resolve of claudeIdleWaiters.splice(0)) resolve();
    claudeSignInRun += 1;
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
    refreshImportedCloudProviders: (input?: { strict?: boolean }) => refreshImportedCloudProviders({ strict: input?.strict }),
    runCloudProviderSync,
    refreshLiveGatewaySignIns,
    startGatewayProviderOAuth,
    shareDeviceProvider,
    syncSharedDeviceProvider,
    isGatewayModelAvailable,
    startProviderAuth,
    connectClaudeAgent: () => runClaudeAction("connect"),
    signInClaudeAgent: () => signInWithClaudeCode(),
    cancelClaudeAgentSignIn: () => cancelClaudeSignIn(),
    checkClaudeAgentInstalled: () => checkClaudeInstalled(),
    refreshProviders,
    completeProviderAuthOAuth,
    submitProviderApiKey,
    connectCloudProvider,
    removeCloudProvider,
    disconnectProvider,
    enableProvider,
    disableProvider,
    ensureProjectProviderDisabledState,
    isProviderAddRestricted,
    openProviderAuthModal,
    closeProviderAuthModal,
  };
}

export function useProviderAuthStoreSnapshot(store: ProviderAuthStore) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
