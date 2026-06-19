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
  normalizeDenDesktopConfig,
  readDenSettings,
  type DenDesktopConfig,
} from "../../../app/lib/den";
import {
  denSessionUpdatedEvent,
  denSettingsChangedEvent,
} from "../../../app/lib/den-session-events";
import { useDenAuth } from "./den-auth-provider";

export type DesktopConfigStore = {
  config: DenDesktopConfig;
  loading: boolean;
  refresh: () => Promise<void>;
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
const DESKTOP_CONFIG_CACHE_PREFIX = "openwork.den.desktopConfig:";
const DESKTOP_CONFIG_ITEMS = [
  ...desktopPolicyKeys,
  "allowedDesktopVersions",
] as const satisfies readonly (keyof DenDesktopConfig)[];

type DesktopConfigItem = (typeof DESKTOP_CONFIG_ITEMS)[number];
type DesktopConfigAction = {
  item: DesktopConfigItem;
  nextValue: DenDesktopConfig[DesktopConfigItem];
  previousValue: DenDesktopConfig[DesktopConfigItem];
};

function getDesktopConfigCacheKey(): string {
  const settings = readDenSettings();
  const baseUrl = settings.baseUrl.trim();
  const activeOrgId = settings.activeOrgId?.trim() ?? "";
  if (!baseUrl) return "";
  return `${DESKTOP_CONFIG_CACHE_PREFIX}${baseUrl}::${activeOrgId}`;
}

function readCachedDesktopConfig(key: string): DenDesktopConfig | null {
  if (typeof window === "undefined" || !key) return null;

  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    return normalizeDenDesktopConfig(JSON.parse(raw));
  } catch {
    return null;
  }
}

function writeCachedDesktopConfig(key: string, config: DenDesktopConfig) {
  if (typeof window === "undefined" || !key) return;
  try {
    window.localStorage.setItem(
      key,
      JSON.stringify(normalizeDenDesktopConfig(config)),
    );
  } catch {
    // Quota / private-browsing failures are non-fatal — we just miss the cache next boot.
  }
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
    loading: false,
  });
  const { config, loading } = desktopConfigState;
  // Bumped whenever the browser tells us the Den session or settings changed.
  const [settingsVersion, bumpSettingsVersion] = useReducer((value: number) => value + 1, 0);
  // Monotonic run id — same guard-against-stale-resolution pattern as DenAuthProvider.
  const refreshRunRef = useRef(0);
  // Safe in-memory copy of the last config we actually applied. State drives
  // rendering, while this ref lets the handler compare without stale closures.
  const currentDesktopConfigRef = useRef<DenDesktopConfig>(DEFAULT_DESKTOP_CONFIG);
  const isSignedIn = denAuth.isSignedIn;

  const applyDesktopConfigActions = useCallback((latestConfig: DenDesktopConfig) => {
    const normalizedConfig = normalizeDenDesktopConfig(latestConfig);
    const actions = getDesktopConfigActions({
      currentConfig: currentDesktopConfigRef.current,
      latestConfig: normalizedConfig,
    });

    if (actions.length === 0) return false;

    currentDesktopConfigRef.current = normalizedConfig;
    setDesktopConfigState((current) => ({
      ...current,
      config: normalizedConfig,
    }));
    return true;
  }, []);

  const desktopConfigHandler = useCallback(async () => {
    const currentRun = ++refreshRunRef.current;
    const settings = readDenSettings();
    const token = settings.authToken?.trim() ?? "";
    const cacheKey = getDesktopConfigCacheKey();

    if (!isSignedIn || !token || !settings.activeOrgId?.trim()) {
      applyDesktopConfigActions(DEFAULT_DESKTOP_CONFIG);
      setDesktopConfigState((current) => ({ ...current, loading: false }));
      return;
    }

    const cached = readCachedDesktopConfig(cacheKey);
    if (cached) {
      applyDesktopConfigActions(cached);
    }

    if (!cached) {
      setDesktopConfigState((current) => ({ ...current, loading: true }));
    }

    try {
      const nextConfig = await createDenClient({
        baseUrl: settings.baseUrl,
        apiBaseUrl: settings.apiBaseUrl,
        token,
      }).getDesktopConfig();

      if (currentRun !== refreshRunRef.current) return;

      writeCachedDesktopConfig(cacheKey, nextConfig);
      applyDesktopConfigActions(nextConfig);
    } catch (error) {
      if (currentRun !== refreshRunRef.current) return;

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

      applyDesktopConfigActions(cached ?? DEFAULT_DESKTOP_CONFIG);
    } finally {
      if (currentRun === refreshRunRef.current) {
        setDesktopConfigState((current) => ({ ...current, loading: false }));
      }
    }
  }, [applyDesktopConfigActions, isSignedIn]);

  const refresh = desktopConfigHandler;

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

    const cacheKey = getDesktopConfigCacheKey();
    const cached = readCachedDesktopConfig(cacheKey);
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

  const value = useMemo<DesktopConfigStore>(() => {
    // Bind the checker to the latest `config` so callers see the most
    // recent org restrictions without having to recompute every render.
    const checkRestriction: DesktopAppRestrictionChecker = ({ restriction }) =>
      checkDesktopAppRestriction({ config, restriction });
    return { config, loading, refresh, checkRestriction };
  }, [config, loading, refresh]);

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
