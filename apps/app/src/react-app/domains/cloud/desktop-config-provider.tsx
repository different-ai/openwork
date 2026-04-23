/** @jsxImportSource react */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

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

type DesktopConfigProviderProps = {
  children: ReactNode;
};

/**
 * React port of the Solid `DesktopConfigProvider`
 * (`apps/app/src/app/cloud/desktop-config-provider.tsx` on dev).
 *
 * Fetches the org-scoped "desktop app restrictions" config (new
 * `packages/types/den/desktop-app-restrictions.ts` shape) and caches it in
 * localStorage so gates like `blockZenModel` can apply immediately on the
 * next boot without waiting for the HTTP round-trip. Re-fetches on Den
 * session / settings events and on a one-hour interval.
 */
export function DesktopConfigProvider({ children }: DesktopConfigProviderProps) {
  const denAuth = useDenAuth();
  const [config, setConfig] = useState<DenDesktopConfig>(DEFAULT_DESKTOP_CONFIG);
  const [loading, setLoading] = useState(false);
  // Bumped whenever the browser tells us the Den session or settings changed.
  const [settingsVersion, setSettingsVersion] = useState(0);
  // Monotonic run id — same guard-against-stale-resolution pattern as DenAuthProvider.
  const refreshRunRef = useRef(0);
  const isSignedIn = denAuth.isSignedIn;

  const refresh = useCallback(async () => {
    const currentRun = ++refreshRunRef.current;
    const settings = readDenSettings();
    const token = settings.authToken?.trim() ?? "";
    const cacheKey = getDesktopConfigCacheKey();

    if (!isSignedIn || !token || !settings.activeOrgId?.trim()) {
      setConfig(DEFAULT_DESKTOP_CONFIG);
      setLoading(false);
      return;
    }

    const cached = readCachedDesktopConfig(cacheKey);
    if (!cached) setLoading(true);

    try {
      const nextConfig = await createDenClient({
        baseUrl: settings.baseUrl,
        apiBaseUrl: settings.apiBaseUrl,
        token,
      }).getDesktopConfig();

      if (currentRun !== refreshRunRef.current) return;

      writeCachedDesktopConfig(cacheKey, nextConfig);
      setConfig(nextConfig);
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

      setConfig(cached ?? DEFAULT_DESKTOP_CONFIG);
    } finally {
      if (currentRun === refreshRunRef.current) {
        setLoading(false);
      }
    }
  }, [isSignedIn]);

  // Re-run whenever auth flips or Den settings change. Read the cache
  // synchronously so gated UI never flickers through "unrestricted" just
  // because we haven't finished the HTTP call yet.
  useEffect(() => {
    // settingsVersion is read to tie this effect to settings-change events.
    void settingsVersion;

    if (!isSignedIn) {
      setConfig(DEFAULT_DESKTOP_CONFIG);
      setLoading(false);
      return;
    }

    const cacheKey = getDesktopConfigCacheKey();
    const cached = readCachedDesktopConfig(cacheKey);
    setConfig(cached ?? DEFAULT_DESKTOP_CONFIG);
    setLoading(!cached);
    void refresh();
  }, [isSignedIn, refresh, settingsVersion]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleSettingsChanged = () => {
      setSettingsVersion((value) => value + 1);
    };

    window.addEventListener(denSessionUpdatedEvent, handleSettingsChanged);
    window.addEventListener(denSettingsChangedEvent, handleSettingsChanged);

    const interval = window.setInterval(() => {
      if (!isSignedIn) return;
      void refresh();
    }, DESKTOP_CONFIG_REFRESH_MS);

    return () => {
      window.removeEventListener(denSessionUpdatedEvent, handleSettingsChanged);
      window.removeEventListener(denSettingsChangedEvent, handleSettingsChanged);
      window.clearInterval(interval);
    };
  }, [isSignedIn, refresh]);

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
  const context = useContext(DesktopConfigContext);
  if (!context) {
    throw new Error("useDesktopConfig must be used within a DesktopConfigProvider");
  }
  return context;
}

/**
 * Convenience hook that returns the raw `DesktopAppRestrictions` flags
 * (e.g. `{ blockZenModel: true }`). Callers usually just want the flags,
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
 * (e.g. `useDesktopRestriction("blockMultipleWorkspaces")`).
 */
export function useDesktopRestriction(
  restriction: Parameters<DesktopAppRestrictionChecker>[0]["restriction"],
): boolean {
  return useDesktopConfig().checkRestriction({ restriction });
}
