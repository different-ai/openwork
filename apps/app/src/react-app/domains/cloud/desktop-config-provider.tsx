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
import { desktopPolicyKeys } from "@openwork/types/den/desktop-policies";

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
  /**
   * Stable checker function that matches the `DesktopAppRestrictionChecker`
   * shape Solid passes to its stores. Useful when wiring restriction gates
   * from non-hook code paths.
   */
  checkRestriction: DesktopAppRestrictionChecker;
  /**
   * Sanitized convergence state of the organization Connect policy against
   * the local runtime. Informational only — nothing gates on it, so local
   * work continues while reconciliation is pending or stalled.
   */
  connectPolicySync: ConnectPolicySyncState;
};

const DesktopConfigContext = createContext<DesktopConfigStore | undefined>(
  undefined,
);

const DEFAULT_DESKTOP_CONFIG: DenDesktopConfig = {};
const DESKTOP_CONFIG_REFRESH_MS = 60 * 60 * 1000;
const DESKTOP_CONFIG_ITEMS = [
  ...desktopPolicyKeys,
  "allowedDesktopVersions",
  "brandAppName",
  "brandLogoUrl",
  "brandIconUrl",
  "brandAccentColor",
  "automationsEnabled",
  "dashboardEnabled",
  "connectEnabled",
  "onboardingPrompts",
  "onboardingPromptDescriptions",
] as const satisfies readonly (keyof DenDesktopConfig)[];

export function resolveConnectStateToPush(config: DenDesktopConfig): boolean | null {
  return typeof config.connectEnabled === "boolean" ? config.connectEnabled : null;
}

/**
 * Resolve the current local-runtime target for the Connect policy. The target
 * key identifies one runtime lifetime: the desktop bridge reports a monotonic
 * per-start generation (ports and tokens are sticky across restarts), so
 * after a restart or a workspace switch the key changes and the policy must
 * be reapplied to the new generation.
 */
export async function resolveConnectPolicyTarget(): Promise<ConnectPolicyTarget | null> {
  const connection = await resolveOpenworkConnection();
  if (!connection.normalizedBaseUrl || !connection.resolvedHostToken) return null;
  const { normalizedBaseUrl, resolvedToken, resolvedHostToken } = connection;
  // The desktop runtime reports a monotonic per-start generation; remote or
  // stored connections identify a lifetime by URL and host token instead.
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

  return previousValue === nextValue;
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

// Rewrites desktop-bootstrap.json branding to match `normalizedConfig` so a
// cleared wordmark/icon cannot resurrect from the install/connect snapshot on
// the next relaunch. No-op when the bootstrap already matches.
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

// Level-based safety net behind the edge-triggered config diff: the shell
// (Electron main) restores its cached/bootstrap brand icon on every launch,
// so when a clear's edge is missed (stale localStorage cache, failed IPC,
// org/base-URL switch changing the cache key), nothing would ever tell the
// shell to reset and the branded icon would persist forever. After every
// fresh config fetch, compare the shell's applied state to the config and
// re-assert the expected icon plus the bootstrap branding snapshot.
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
};

/**
 * React port of the Solid `DesktopConfigProvider`
 * (`apps/app/src/app/cloud/desktop-config-provider.tsx` on dev).
 *
 * Fetches the org-scoped desktop policy config
 * (`packages/types/den/desktop-policies.ts` shape) and caches it in
 * localStorage so gates like `allowZenModel` can apply immediately on the
 * next boot without waiting for the HTTP round-trip. Re-fetches on Den
 * session / settings events and on a one-hour interval.
 */
export function DesktopConfigProvider({ children }: DesktopConfigProviderProps) {
  const denAuth = useDenAuth();
  const [desktopConfigState, setDesktopConfigState] = useState<DesktopConfigState>({
    config: DEFAULT_DESKTOP_CONFIG,
    loading: true,
    freshConfigStatus: "pending",
  });
  const { config, freshConfigStatus, loading } = desktopConfigState;
  // Bumped whenever the browser tells us the Den session or settings changed.
  const [settingsVersion, bumpSettingsVersion] = useReducer((value: number) => value + 1, 0);
  // Monotonic run id — same guard-against-stale-resolution pattern as DenAuthProvider.
  const refreshRunRef = useRef(0);
  const connectPolicyReconcilerRef = useRef<ConnectPolicyReconciler | null>(null);
  const [connectPolicySync, setConnectPolicySync] = useState<ConnectPolicySyncState>({ state: "idle" });
  // Safe in-memory copy of the last config we actually applied. State drives
  // rendering, while this ref lets the handler compare without stale closures.
  const currentDesktopConfigRef = useRef<DenDesktopConfig>(DEFAULT_DESKTOP_CONFIG);
  const devRefreshDesktopConfigRef = useRef<DenDesktopConfig | null>(null);
  const isSignedIn = denAuth.isSignedIn;

  const applyDesktopConfigActions = useCallback((latestConfig: DenDesktopConfig) => {
    const normalizedConfig = normalizeDenDesktopConfig(latestConfig);
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

    const brandAppNameAction = actions.find((action) => action.item === "brandAppName");
    if (brandAppNameAction) {
      const appName = typeof brandAppNameAction.nextValue === "string" ? brandAppNameAction.nextValue : null;
      document.title = appName ?? "OpenWork";
      void applyBrandAppName(appName).catch(() => null);
    }

    // Keep desktop-bootstrap.json aligned so a cleared wordmark/icon cannot
    // resurrect from the install/connect snapshot on the next relaunch.
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
      const nextConfig = devRefreshDesktopConfigRef.current;
      applyDesktopConfigActions(nextConfig);
      setDesktopConfigState((current) => ({ ...current, freshConfigStatus: "ready" }));
      void reconcileShellBranding(nextConfig).catch(() => undefined);
      return nextConfig;
    }

    const currentRun = ++refreshRunRef.current;
    const settings = readDenSettings();
    const token = settings.authToken?.trim() ?? "";
    const activeOrgId = settings.activeOrgId?.trim() ?? "";
    const cacheKey = getDenDesktopConfigCacheKey();

    if (!isSignedIn || !token || !activeOrgId) {
      applyDesktopConfigActions(DEFAULT_DESKTOP_CONFIG);
      setDesktopConfigState((current) => ({
        ...current,
        freshConfigStatus: "failed",
        loading: false,
      }));
      return DEFAULT_DESKTOP_CONFIG;
    }

    const cached = readCachedDenDesktopConfig(cacheKey);
    if (cached) {
      applyDesktopConfigActions(cached);
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
      applyDesktopConfigActions(nextConfig);
      setDesktopConfigState((current) => ({ ...current, freshConfigStatus: "ready" }));
      void reconcileShellBranding(nextConfig).catch(() => undefined);
      return nextConfig;
    } catch (error) {
      if (currentRun !== refreshRunRef.current) {
        if (requireFresh) throw error;
        return cached ?? DEFAULT_DESKTOP_CONFIG;
      }

      // If the server says the active org doesn't exist, re-sync Better Auth
      // so the next refresh hits a valid org. Same recovery path as Solid.
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
      setDesktopConfigState((current) => ({ ...current, freshConfigStatus: "failed" }));
      if (requireFresh) throw error;
      return fallbackConfig;
    } finally {
      if (currentRun === refreshRunRef.current) {
        setDesktopConfigState((current) => ({ ...current, loading: false }));
      }
    }
  }, [applyDesktopConfigActions, isSignedIn]);

  const refresh = useCallback(
    async () => {
      await desktopConfigHandler();
    },
    [desktopConfigHandler],
  );
  const refreshFresh = useCallback(
    () => desktopConfigHandler(true),
    [desktopConfigHandler],
  );

  // Re-run whenever auth flips or Den settings change. Read the cache
  // synchronously so gated UI never flickers through "unrestricted" just
  // because we haven't finished the HTTP call yet.
  useEffect(() => {
    // settingsVersion is read to tie this effect to settings-change events.
    void settingsVersion;

    if (denAuth.status === "checking") {
      setDesktopConfigState((current) => ({
        ...current,
        freshConfigStatus: "pending",
        loading: true,
      }));
      return;
    }

    if (!isSignedIn) {
      applyDesktopConfigActions(DEFAULT_DESKTOP_CONFIG);
      setDesktopConfigState((current) => ({
        ...current,
        freshConfigStatus: "failed",
        loading: false,
      }));
      return;
    }

    const cacheKey = getDenDesktopConfigCacheKey();
    const cached = readCachedDenDesktopConfig(cacheKey);
    applyDesktopConfigActions(cached ?? DEFAULT_DESKTOP_CONFIG);
    setDesktopConfigState((current) => ({
      ...current,
      freshConfigStatus: "pending",
      loading: !cached,
    }));
    void desktopConfigHandler();
  }, [applyDesktopConfigActions, denAuth.status, desktopConfigHandler, isSignedIn, settingsVersion]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleSettingsChanged = () => {
      bumpSettingsVersion();
    };

    window.addEventListener(denSessionUpdatedEvent, handleSettingsChanged);
    window.addEventListener(denSettingsChangedEvent, handleSettingsChanged);

    const interval = window.setInterval(() => {
      if (!isSignedIn) return;
      void desktopConfigHandler();
      // Level-based safety net behind the event-driven reconciler: if a
      // runtime-generation observation was ever missed, the hourly tick
      // re-checks convergence (one target resolution; no request when the
      // recorded tuple already matches).
      connectPolicyReconcilerRef.current?.notifyTargetChanged();
    }, DESKTOP_CONFIG_REFRESH_MS);

    return () => {
      window.removeEventListener(denSessionUpdatedEvent, handleSettingsChanged);
      window.removeEventListener(denSettingsChangedEvent, handleSettingsChanged);
      window.clearInterval(interval);
    };
  }, [desktopConfigHandler, isSignedIn]);

  const connectEnabled = resolveConnectStateToPush(config);

  // Reconciler lifecycle: created once per mount and rearmed by runtime
  // observations. Every renderer path that (re)publishes the local server —
  // boot, engine reload, workspace reconnect, debug restart — dispatches
  // "openwork-server-settings-changed", which is the runtime-generation
  // observation channel.
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

  // Desired-state feed: reconcile whenever the effective Connect policy or
  // its source (the active organization) changes. `settingsVersion` ties this
  // to Den session/settings events so an organization switch re-reconciles
  // even when both organizations desire the same switch value.
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

  // Dev-only: expose a bridge so evals can inject config directly without
  // requiring a cloud sign-in. This simply applies the config to React state.
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

/**
 * Convenience hook that returns the raw desktop policy flags
 * (e.g. `{ allowZenModel: true }`). Callers usually just want the flags,
 * not the loading state — feature gates should read through this.
 */
export function useOrgRestrictions(): DenDesktopConfig {
  return useDesktopConfig().config;
}

export function useConnectEnabled(): boolean | undefined {
  return useDesktopConfig().config.connectEnabled;
}

/**
 * Hook variant that returns the stable `checkRestriction` function so
 * feature sites that already receive a "checker" (e.g. helpers ported
 * from Solid stores) can call it directly without reshaping.
 */
export function useCheckDesktopRestriction(): DesktopAppRestrictionChecker {
  return useDesktopConfig().checkRestriction;
}

/**
 * Single-restriction hook — returns true/false for a specific key.
 * Use this at feature sites that only care about one flag
 * (e.g. `useDesktopRestriction("allowMultipleWorkspaces")`).
 */
export function useDesktopRestriction(
  restriction: Parameters<DesktopAppRestrictionChecker>[0]["restriction"],
): boolean {
  return useDesktopConfig().checkRestriction({ restriction });
}
