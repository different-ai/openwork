/** @jsxImportSource react */
import {
  createContext,
  useCallback,
  use,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { MCP_QUICK_CONNECT } from "../../../app/constants";
import { isOpenWorkExtensionEnabled, OPENWORK_EXTENSION_STATE_CHANGED } from "../settings/extension-state";
import { desktopCapabilityConfig, desktopPolicyKeys } from "@openwork/types/den/desktop-policies";

import {
  checkDesktopAppRestriction,
  type DesktopAppRestrictionChecker,
} from "../../../app/cloud/desktop-app-restrictions";
import {
  createDenClient,
  DenApiError,
  ensureDenActiveOrganization,
  getDenDesktopConfigCacheKey,
  normalizeDenDesktopConfig,
  readCachedDenDesktopConfig,
  readDenBootstrapConfig,
  readDenSettings,
  setDenBootstrapConfig,
  writeCachedDenDesktopConfig,
  type DenDesktopConfig,
} from "../../../app/lib/den";
import { applyBrandAppName, applyBrandIcon, getBrandIconState } from "../../../app/lib/desktop";
import { createOpenworkServerClient } from "../../../app/lib/openwork-server";
import {
  denSessionUpdatedEvent,
  denSettingsChangedEvent,
} from "../../../app/lib/den-session-events";
import { isDesktopRuntime } from "../../../app/lib/runtime-env";
import { resolveOpenworkConnection } from "../../shell/openwork-connection";
import {
  createConnectPolicyReconciler,
  type ConnectPolicyReconciler,
  type ConnectPolicySyncState,
  type ConnectPolicyTarget,
} from "./connect-policy-reconciler";
import { useDenAuth } from "./den-auth-provider";
import {
  bootstrapBrandingFromDesktopConfig,
  bootstrapBrandingNeedsSync,
  brandIconReconcileAction,
} from "./workspace-branding-restart";

export type DesktopConfigStore = {
  config: DenDesktopConfig;
  loading: boolean;
  freshConfigStatus: "pending" | "ready" | "failed";
  refresh: () => Promise<void>;
  refreshFresh: () => Promise<DenDesktopConfig>;
  checkRestriction: DesktopAppRestrictionChecker;
  connectPolicySync: ConnectPolicySyncState;
};

const DesktopConfigContext = createContext<DesktopConfigStore | undefined>(
  undefined,
);

const DEFAULT_DESKTOP_CONFIG: DenDesktopConfig = {};
const DESKTOP_CONFIG_REFRESH_MS = 5 * 60 * 1000;
const DESKTOP_CONFIG_ITEMS = [
  ...desktopPolicyKeys,
  "allowedDesktopVersions",
  "brandAppName",
  "brandLogoUrl",
  "brandIconUrl",
  "brandAccentColor",
  "automationsEnabled",
  "desktopAutomationsEnabled",
  "cloudAutomationsEnabled",
  "dashboardEnabled",
  "connectEnabled",
  "onboardingPrompts",
  "onboardingPromptDescriptions",
  "agentPermissions",
  "defaultModel",
] as const satisfies readonly (keyof DenDesktopConfig)[];

const CACHED_CONFIG_MEMBER_PREFIX = "openwork.den.desktopConfigMember:";

function cachedConfigFor(cacheKey: string, userId: string): boolean {
  try {
    return userId !== "" && window.localStorage.getItem(`${CACHED_CONFIG_MEMBER_PREFIX}${cacheKey}`) === userId;
  } catch {
    return false;
  }
}

function rememberCachedConfigMember(cacheKey: string, userId: string): void {
  try {
    if (userId) window.localStorage.setItem(`${CACHED_CONFIG_MEMBER_PREFIX}${cacheKey}`, userId);
  } catch {
  }
}

function denRefusedDesktopConfig(error: unknown): boolean {
  return error instanceof DenApiError
    && error.status >= 400 && error.status < 500
    && error.status !== 408 && error.status !== 429;
}

export function resolveConnectStateToPush(config: DenDesktopConfig): boolean | null {
  return typeof config.connectEnabled === "boolean" ? config.connectEnabled : null;
}

export async function resolveConnectPolicyTarget(): Promise<ConnectPolicyTarget | null> {
  const connection = await resolveOpenworkConnection();
  if (!connection.normalizedBaseUrl || !connection.resolvedHostToken) return null;
  const { normalizedBaseUrl, resolvedToken, resolvedHostToken } = connection;
  const generation = connection.hostInfo?.generation ?? null;
  return {
    key: `${normalizedBaseUrl}\u0000${resolvedHostToken}\u0000${generation ?? ""}`,
    apply: async (connectEnabled) => {
      await createOpenworkServerClient({
        baseUrl: normalizedBaseUrl,
        token: resolvedToken,
        hostToken: resolvedHostToken,
      }).setConnectState(connectEnabled);
    },
  };
}

type DesktopConfigItem = (typeof DESKTOP_CONFIG_ITEMS)[number];
type DesktopConfigAction = {
  item: DesktopConfigItem;
  nextValue: DenDesktopConfig[DesktopConfigItem];
  previousValue: DenDesktopConfig[DesktopConfigItem];
};

function isBootstrapBrandingActionItem(item: DesktopConfigItem): boolean {
  return item === "brandAppName" || item === "brandLogoUrl" || item === "brandIconUrl";
}

function desktopConfigItemMatches(
  previousValue: DenDesktopConfig[DesktopConfigItem],
  nextValue: DenDesktopConfig[DesktopConfigItem],
) {
  if (Array.isArray(previousValue) || Array.isArray(nextValue)) {
    if (!Array.isArray(previousValue) || !Array.isArray(nextValue)) return false;
    if (previousValue.length !== nextValue.length) return false;
    return previousValue.every((value, index) => value === nextValue[index]);
  }
  if (typeof previousValue === "object" || typeof nextValue === "object") {
    return JSON.stringify(previousValue ?? null) === JSON.stringify(nextValue ?? null);
  }

  return previousValue === nextValue;
}

async function refreshServerManagedPolicy(): Promise<void> {
  const connection = await resolveOpenworkConnection();
  if (!connection.normalizedBaseUrl || !connection.resolvedHostToken) return;
  await createOpenworkServerClient({
    baseUrl: connection.normalizedBaseUrl,
    token: connection.resolvedToken,
    hostToken: connection.resolvedHostToken,
  }).refreshManagedPolicy();
}

function getDesktopConfigActions(input: {
  currentConfig: DenDesktopConfig;
  latestConfig: DenDesktopConfig;
}): DesktopConfigAction[] {
  return DESKTOP_CONFIG_ITEMS.flatMap((item) => {
    const previousValue = input.currentConfig[item];
    const nextValue = input.latestConfig[item];

    if (desktopConfigItemMatches(previousValue, nextValue)) return [];

    return [{ item, previousValue, nextValue }];
  });
}

type DesktopConfigProviderProps = {
  children: ReactNode;
};

function syncBootstrapBranding(normalizedConfig: DenDesktopConfig): void {
  if (!isDesktopRuntime()) return;
  const bootstrap = readDenBootstrapConfig();
  if (!bootstrapBrandingNeedsSync(bootstrap, normalizedConfig)) return;
  const branding = bootstrapBrandingFromDesktopConfig(normalizedConfig);
  void setDenBootstrapConfig(
    {
      ...bootstrap,
      brandAppName: branding.brandAppName,
      brandLogoUrl: branding.brandLogoUrl,
      brandIconUrl: branding.brandIconUrl,
    },
    { dispatchSettingsChanged: false },
  ).catch(() => undefined);
}

async function reconcileShellBranding(latestConfig: DenDesktopConfig): Promise<void> {
  if (!isDesktopRuntime()) return;
  const normalizedConfig = normalizeDenDesktopConfig(latestConfig);
  syncBootstrapBranding(normalizedConfig);
  const action = brandIconReconcileAction(normalizedConfig, await getBrandIconState());
  if (!action) return;
  const result = await applyBrandIcon(action.apply);
  if (!result.ok) {
    console.warn(`[brand-icon] Desktop icon reconcile was not applied: ${result.reason ?? "unknown failure"}`);
  }
}

type DesktopConfigState = {
  config: DenDesktopConfig;
  loading: boolean;
  freshConfigStatus: "pending" | "ready" | "failed";
  known: boolean;
};

export function DesktopConfigProvider({ children }: DesktopConfigProviderProps) {
  const denAuth = useDenAuth();
  const [desktopConfigState, setDesktopConfigState] = useState<DesktopConfigState>({
    config: DEFAULT_DESKTOP_CONFIG,
    loading: true,
    freshConfigStatus: "pending",
    known: false,
  });
  const { config, freshConfigStatus, known, loading } = desktopConfigState;
  const [settingsVersion, bumpSettingsVersion] = useReducer((value: number) => value + 1, 0);
  const refreshRunRef = useRef(0);
  const connectPolicyReconcilerRef = useRef<ConnectPolicyReconciler | null>(null);
  const [connectPolicySync, setConnectPolicySync] = useState<ConnectPolicySyncState>({ state: "idle" });
  const currentDesktopConfigRef = useRef<DenDesktopConfig>(DEFAULT_DESKTOP_CONFIG);
  const devRefreshDesktopConfigRef = useRef<DenDesktopConfig | null>(null);
  const answeredSignInRef = useRef<string | null>(null);
  const isSignedIn = denAuth.isSignedIn;
  const userId = denAuth.user?.id?.trim() ?? "";

  useEffect(() => {
    const syncBrowserControl = () => {
      const browser = MCP_QUICK_CONNECT.find((item) => item.id === "openwork-browser");
      const enabled = !!browser && isOpenWorkExtensionEnabled(browser) && config.allowBuiltInExtensions !== false;
      void window.__OPENWORK_ELECTRON__?.browser?.setControlEnabled?.(enabled);
    };
    syncBrowserControl();
    window.addEventListener(OPENWORK_EXTENSION_STATE_CHANGED, syncBrowserControl);
    return () => window.removeEventListener(OPENWORK_EXTENSION_STATE_CHANGED, syncBrowserControl);
  }, [config.allowBuiltInExtensions]);

  const denUnreachable = freshConfigStatus === "failed";
  const websiteRules = useMemo(() => {
    if (!isSignedIn && denAuth.status !== "checking") return [];
    if (known) return (config.agentPermissions?.rules ?? []).filter((rule) => rule.action === "webfetch");
    if (denUnreachable) return [];
    const cached = readCachedDenDesktopConfig(getDenDesktopConfigCacheKey());
    return cached && cached.agentPermissions === undefined ? [] : null;
  }, [config.agentPermissions, denAuth.status, denUnreachable, isSignedIn, known]);
  useEffect(() => {
    void window.__OPENWORK_ELECTRON__?.browser?.setAgentPermissionRules?.(websiteRules);
  }, [websiteRules]);

  const applyDesktopConfigActions = useCallback((latestConfig: DenDesktopConfig) => {
    const normalizedConfig = desktopCapabilityConfig(normalizeDenDesktopConfig(latestConfig));
    const actions = getDesktopConfigActions({
      currentConfig: currentDesktopConfigRef.current,
      latestConfig: normalizedConfig,
    });

    if (actions.length === 0) return false;

    const brandIconAction = actions.find((action) => action.item === "brandIconUrl");
    if (brandIconAction) {
      void applyBrandIcon(
        typeof brandIconAction.nextValue === "string" ? brandIconAction.nextValue : null,
      ).then((result) => {
        if (!result.ok) {
          console.warn(`[brand-icon] Desktop icon was not applied: ${result.reason ?? "unknown failure"}`);
        }
      }).catch((error: unknown) => {
        console.warn("[brand-icon] Desktop icon apply request failed", error);
      });
    }

    if (actions.some((action) => action.item === "agentPermissions")) {
      void refreshServerManagedPolicy().catch(() => undefined);
    }

    const brandAppNameAction = actions.find((action) => action.item === "brandAppName");
    if (brandAppNameAction) {
      const appName = typeof brandAppNameAction.nextValue === "string" ? brandAppNameAction.nextValue : null;
      document.title = appName ?? "OpenWork";
      void applyBrandAppName(appName).catch(() => null);
    }

    const shouldSyncBootstrapBranding = actions.some((action) =>
      isBootstrapBrandingActionItem(action.item),
    );
    if (shouldSyncBootstrapBranding) {
      syncBootstrapBranding(normalizedConfig);
    }

    currentDesktopConfigRef.current = normalizedConfig;
    setDesktopConfigState((current) => ({
      ...current,
      config: normalizedConfig,
    }));
    return true;
  }, []);

  const desktopConfigHandler = useCallback(async (requireFresh = false): Promise<DenDesktopConfig> => {
    if (import.meta.env.DEV && requireFresh && devRefreshDesktopConfigRef.current) {
      const nextConfig = desktopCapabilityConfig(devRefreshDesktopConfigRef.current);
      applyDesktopConfigActions(nextConfig);
      setDesktopConfigState((current) => ({ ...current, freshConfigStatus: "ready", known: true }));
      void reconcileShellBranding(nextConfig).catch(() => undefined);
      return nextConfig;
    }

    const currentRun = ++refreshRunRef.current;
    const settings = readDenSettings();
    const token = settings.authToken?.trim() ?? "";
    const activeOrgId = settings.activeOrgId?.trim() ?? "";
    const cacheKey = getDenDesktopConfigCacheKey();

    if (!isSignedIn || !token || !activeOrgId) {
      answeredSignInRef.current = null;
      applyDesktopConfigActions(DEFAULT_DESKTOP_CONFIG);
      setDesktopConfigState((current) => ({
        ...current,
        freshConfigStatus: "failed",
        loading: false,
        known: true,
      }));
      return DEFAULT_DESKTOP_CONFIG;
    }

    const signIn = `${cacheKey}\u0000${userId}`;
    const cached = readCachedDenDesktopConfig(cacheKey);
    const cachedKnown = Boolean(cached) && cachedConfigFor(cacheKey, userId);
    if (cached) {
      applyDesktopConfigActions(cached);
      setDesktopConfigState((current) => ({ ...current, known: cachedKnown }));
    }

    if (!cached) {
      setDesktopConfigState((current) => ({ ...current, loading: true }));
    }

    try {
      const nextConfig = await createDenClient({
        baseUrl: settings.baseUrl,
        token,
      }).getDesktopConfig(activeOrgId);

      if (currentRun !== refreshRunRef.current) return nextConfig;

      writeCachedDenDesktopConfig(cacheKey, nextConfig);
      rememberCachedConfigMember(cacheKey, userId);
      answeredSignInRef.current = signIn;
      applyDesktopConfigActions(nextConfig);
      setDesktopConfigState((current) => ({ ...current, freshConfigStatus: "ready", known: true }));
      void reconcileShellBranding(nextConfig).catch(() => undefined);
      return nextConfig;
    } catch (error) {
      if (currentRun !== refreshRunRef.current) {
        if (requireFresh) throw error;
        return cached ?? DEFAULT_DESKTOP_CONFIG;
      }

      if (
        error instanceof DenApiError &&
        error.status === 404 &&
        error.code === "organization_not_found"
      ) {
        await ensureDenActiveOrganization({ forceServerSync: true }).catch(
          () => null,
        );
      }

      const fallbackConfig = cached ?? DEFAULT_DESKTOP_CONFIG;
      applyDesktopConfigActions(fallbackConfig);
      if (denRefusedDesktopConfig(error)) answeredSignInRef.current = null;
      const answered = answeredSignInRef.current === signIn;
      setDesktopConfigState((current) => ({
        ...current,
        freshConfigStatus: answered ? "ready" : "failed",
        known: cachedKnown,
      }));
      if (requireFresh) throw error;
      return fallbackConfig;
    } finally {
      if (currentRun === refreshRunRef.current) {
        setDesktopConfigState((current) => ({ ...current, loading: false }));
      }
    }
  }, [applyDesktopConfigActions, isSignedIn, userId]);

  const refresh = useCallback(
    async () => {
      await desktopConfigHandler();
    },
    [desktopConfigHandler],
  );
  const refreshFresh = useCallback(
    () => desktopConfigHandler(true)
      .catch(() => currentDesktopConfigRef.current)
      .then(desktopCapabilityConfig),
    [desktopConfigHandler],
  );

  useEffect(() => {
    void settingsVersion;

    if (denAuth.status === "checking") {
      setDesktopConfigState((current) => ({
        ...current,
        freshConfigStatus: "pending",
        loading: true,
        known: false,
      }));
      return;
    }

    if (!isSignedIn) {
      answeredSignInRef.current = null;
      applyDesktopConfigActions(DEFAULT_DESKTOP_CONFIG);
      setDesktopConfigState((current) => ({
        ...current,
        freshConfigStatus: "failed",
        loading: false,
        known: true,
      }));
      return;
    }

    const cacheKey = getDenDesktopConfigCacheKey();
    const cached = readCachedDenDesktopConfig(cacheKey);
    const answered = Boolean(cached) && answeredSignInRef.current === `${cacheKey}\u0000${userId}`;
    applyDesktopConfigActions(cached ?? DEFAULT_DESKTOP_CONFIG);
    setDesktopConfigState((current) => ({
      ...current,
      freshConfigStatus: answered ? "ready" : "pending",
      loading: !cached,
      known: Boolean(cached) && cachedConfigFor(cacheKey, userId),
    }));
    void desktopConfigHandler();
  }, [applyDesktopConfigActions, denAuth.status, desktopConfigHandler, isSignedIn, settingsVersion, userId]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleSettingsChanged = () => {
      bumpSettingsVersion();
    };

    const handleAppResume = () => {
      if (isSignedIn) void desktopConfigHandler();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") handleAppResume();
    };

    window.addEventListener(denSessionUpdatedEvent, handleSettingsChanged);
    window.addEventListener(denSettingsChangedEvent, handleSettingsChanged);
    window.addEventListener("focus", handleAppResume);
    window.addEventListener("online", handleAppResume);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    const interval = window.setInterval(() => {
      if (!isSignedIn) return;
      void desktopConfigHandler();
      connectPolicyReconcilerRef.current?.notifyTargetChanged();
    }, DESKTOP_CONFIG_REFRESH_MS);

    return () => {
      window.removeEventListener(denSessionUpdatedEvent, handleSettingsChanged);
      window.removeEventListener(denSettingsChangedEvent, handleSettingsChanged);
      window.removeEventListener("focus", handleAppResume);
      window.removeEventListener("online", handleAppResume);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.clearInterval(interval);
    };
  }, [desktopConfigHandler, isSignedIn]);

  const connectEnabled = resolveConnectStateToPush(config);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const reconciler = createConnectPolicyReconciler({
      resolveTarget: resolveConnectPolicyTarget,
      wait: (delayMs) => new Promise((resolveWait) => window.setTimeout(resolveWait, delayMs)),
      onStateChange: setConnectPolicySync,
    });
    connectPolicyReconcilerRef.current = reconciler;
    const handleRuntimeChanged = () => reconciler.notifyTargetChanged();
    window.addEventListener("openwork-server-settings-changed", handleRuntimeChanged);
    return () => {
      window.removeEventListener("openwork-server-settings-changed", handleRuntimeChanged);
      reconciler.dispose();
      if (connectPolicyReconcilerRef.current === reconciler) {
        connectPolicyReconcilerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (loading) return;
    const reconciler = connectPolicyReconcilerRef.current;
    if (!reconciler) return;
    if (connectEnabled === null) {
      reconciler.setDesired(null);
      return;
    }
    const activeOrgId = readDenSettings().activeOrgId?.trim() ?? "";
    reconciler.setDesired({ connectEnabled, revision: activeOrgId });
  }, [connectEnabled, loading, settingsVersion]);

  useEffect(() => {
    if (!import.meta.env.DEV || typeof window === "undefined") return;
    const bridge = (configPayload: unknown) => {
      applyDesktopConfigActions(
        normalizeDenDesktopConfig(configPayload),
      );
    };
    Object.defineProperty(window, "__openworkApplyDesktopConfig", { value: bridge, configurable: true });
    const refreshBridge = (configPayload: unknown) => {
      devRefreshDesktopConfigRef.current = normalizeDenDesktopConfig(configPayload);
    };
    Object.defineProperty(window, "__openworkSetDesktopConfigRefreshResult", {
      value: refreshBridge,
      configurable: true,
    });
    return () => {
      Object.defineProperty(window, "__openworkApplyDesktopConfig", { value: undefined, configurable: true });
      Object.defineProperty(window, "__openworkSetDesktopConfigRefreshResult", { value: undefined, configurable: true });
    };
  }, [applyDesktopConfigActions]);

  const configRef = useRef(config);
  configRef.current = config;
  const checkRestriction = useCallback<DesktopAppRestrictionChecker>(
    ({ restriction }) => checkDesktopAppRestriction({ config: configRef.current, restriction }),
    [],
  );
  const value = useMemo<DesktopConfigStore>(() => {
    return {
      config,
      freshConfigStatus,
      loading,
      refresh,
      refreshFresh,
      checkRestriction,
      connectPolicySync,
    };
  }, [checkRestriction, config, freshConfigStatus, loading, refresh, refreshFresh, connectPolicySync]);

  return (
    <DesktopConfigContext.Provider value={value}>
      {children}
    </DesktopConfigContext.Provider>
  );
}

export function useDesktopConfig(): DesktopConfigStore {
  const context = use(DesktopConfigContext);
  if (!context) {
    throw new Error("useDesktopConfig must be used within a DesktopConfigProvider");
  }
  return context;
}

export function useOrgRestrictions(): DenDesktopConfig {
  return useDesktopConfig().config;
}

export function useCheckDesktopRestriction(): DesktopAppRestrictionChecker {
  return useDesktopConfig().checkRestriction;
}

export function useDesktopRestriction(
  restriction: Parameters<DesktopAppRestrictionChecker>[0]["restriction"],
): boolean {
  return useDesktopConfig().checkRestriction({ restriction });
}
