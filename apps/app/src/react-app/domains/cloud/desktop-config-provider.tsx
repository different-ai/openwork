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
import { useDenAuth } from "./den-auth-provider";
import {
  bootstrapBrandingFromDesktopConfig,
  bootstrapBrandingNeedsSync,
  brandIconReconcileAction,
} from "./workspace-branding-restart";

export type DesktopConfigStore = {
  config: DenDesktopConfig;
  loading: boolean;
  refresh: () => Promise<void>;
  refreshFresh: () => Promise<DenDesktopConfig>;
  /**
   * Stable checker function that matches the `DesktopAppRestrictionChecker`
   * shape Solid passes to its stores. Useful when wiring restriction gates
   * from non-hook code paths.
   */
  checkRestriction: DesktopAppRestrictionChecker;
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
  "connectEnabled",
  "onboardingPrompts",
  "onboardingPromptDescriptions",
] as const satisfies readonly (keyof DenDesktopConfig)[];

export function resolveConnectStateToPush(config: DenDesktopConfig): boolean | null {
  return typeof config.connectEnabled === "boolean" ? config.connectEnabled : null;
}

export const CONNECT_STATE_PUSH_RETRY_DELAY_MS = 3_000;
export const CONNECT_STATE_PUSH_MAX_ATTEMPTS = 20;

/**
 * Push the Connect switch to the local server until it is actually accepted.
 * On a fresh install the local server (or its host token) may not be ready
 * when the first push fires; dropping that push would strand the on-disk
 * default (`connectEnabled: false`) forever. Resolves true once delivered.
 */
export async function deliverConnectState(
  attempt: () => Promise<boolean>,
  wait: (delayMs: number) => Promise<void>,
  isCancelled: () => boolean,
): Promise<boolean> {
  for (let attemptIndex = 0; attemptIndex < CONNECT_STATE_PUSH_MAX_ATTEMPTS; attemptIndex += 1) {
    if (isCancelled()) return false;
    try {
      if (await attempt()) return true;
    } catch {
      // The local server may still be starting; retry below.
    }
    if (isCancelled()) return false;
    await wait(CONNECT_STATE_PUSH_RETRY_DELAY_MS);
  }

  return false;
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
  });
  const { config, loading } = desktopConfigState;
  // Bumped whenever the browser tells us the Den session or settings changed.
  const [settingsVersion, bumpSettingsVersion] = useReducer((value: number) => value + 1, 0);
  // Monotonic run id — same guard-against-stale-resolution pattern as DenAuthProvider.
  const refreshRunRef = useRef(0);
  const lastPushedConnectEnabledRef = useRef<boolean | null>(null);
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
      setDesktopConfigState((current) => ({ ...current, loading: false }));
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

    if (!isSignedIn) {
      applyDesktopConfigActions(DEFAULT_DESKTOP_CONFIG);
      setDesktopConfigState((current) => ({ ...current, loading: false }));
      return;
    }

    const cacheKey = getDenDesktopConfigCacheKey();
    const cached = readCachedDenDesktopConfig(cacheKey);
    applyDesktopConfigActions(cached ?? DEFAULT_DESKTOP_CONFIG);
    setDesktopConfigState((current) => ({ ...current, loading: !cached }));
    void desktopConfigHandler();
  }, [applyDesktopConfigActions, desktopConfigHandler, isSignedIn, settingsVersion]);

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
    }, DESKTOP_CONFIG_REFRESH_MS);

    return () => {
      window.removeEventListener(denSessionUpdatedEvent, handleSettingsChanged);
      window.removeEventListener(denSettingsChangedEvent, handleSettingsChanged);
      window.clearInterval(interval);
    };
  }, [desktopConfigHandler, isSignedIn]);

  const connectEnabled = resolveConnectStateToPush(config);

  useEffect(() => {
    if (loading) return;
    if (connectEnabled === null) return;
    if (lastPushedConnectEnabledRef.current === connectEnabled) return;
    let cancelled = false;

    void deliverConnectState(
      async () => {
        const connection = await resolveOpenworkConnection();
        if (!connection.normalizedBaseUrl || !connection.resolvedHostToken) return false;
        await createOpenworkServerClient({
          baseUrl: connection.normalizedBaseUrl,
          token: connection.resolvedToken,
          hostToken: connection.resolvedHostToken,
        }).setConnectState(connectEnabled);
        return true;
      },
      (delayMs) => new Promise((resolveWait) => window.setTimeout(resolveWait, delayMs)),
      () => cancelled,
    ).then((delivered) => {
      if (delivered && !cancelled) {
        lastPushedConnectEnabledRef.current = connectEnabled;
      }
    }).catch(() => null);

    return () => {
      cancelled = true;
    };
  }, [connectEnabled, loading]);

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

  const value = useMemo<DesktopConfigStore>(() => {
    // Bind the checker to the latest `config` so callers see the most
    // recent org restrictions without having to recompute every render.
    const checkRestriction: DesktopAppRestrictionChecker = ({ restriction }) =>
      checkDesktopAppRestriction({ config, restriction });
    return { config, loading, refresh, refreshFresh, checkRestriction };
  }, [config, loading, refresh, refreshFresh]);

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
