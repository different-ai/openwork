import { createContext, createEffect, createSignal, onCleanup, onMount, useContext, type Accessor, type ParentProps } from "solid-js";
import { createDenClient, DenApiError, ensureDenActiveOrganization, type DenDesktopConfig, normalizeDenDesktopConfig, readDenSettings } from "../lib/den";
import { denSessionUpdatedEvent, denSettingsChangedEvent } from "../lib/den-session-events";
import { useDenAuth } from "./den-auth-provider";
import { checkDesktopAppRestriction, type DesktopAppRestrictionChecker } from "./desktop-app-restrictions";

type DesktopConfigStore = {
  config: Accessor<DenDesktopConfig>;
  loading: Accessor<boolean>;
  refresh: () => Promise<void>;
  checkRestriction: DesktopAppRestrictionChecker;
};

const DesktopConfigContext = createContext<DesktopConfigStore>();

const DEFAULT_DESKTOP_CONFIG: DenDesktopConfig = {};
const DESKTOP_CONFIG_REFRESH_MS = 60 * 60 * 1000;
const DESKTOP_CONFIG_CACHE_PREFIX = "openwork.den.desktopConfig:";

function getDesktopConfigCacheKey() {
  const settings = readDenSettings();
  const baseUrl = settings.baseUrl.trim();
  const activeOrgId = settings.activeOrgId?.trim() ?? "";
  if (!baseUrl) return "";
  return `${DESKTOP_CONFIG_CACHE_PREFIX}${baseUrl}::${activeOrgId}`;
}

function readCachedDesktopConfig(key: string): DenDesktopConfig | null {
  if (typeof window === "undefined" || !key) {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return null;
    }
    return normalizeDenDesktopConfig(JSON.parse(raw));
  } catch {
    return null;
  }
}

function writeCachedDesktopConfig(key: string, config: DenDesktopConfig) {
  if (typeof window === "undefined" || !key) {
    return;
  }

  try {
    window.localStorage.setItem(key, JSON.stringify(normalizeDenDesktopConfig(config)));
  } catch {
    // ignore
  }
}

export function DesktopConfigProvider(props: ParentProps) {
  const denAuth = useDenAuth();
  const [config, setConfig] = createSignal<DenDesktopConfig>(DEFAULT_DESKTOP_CONFIG);
  const [loading, setLoading] = createSignal(false);
  const [settingsVersion, setSettingsVersion] = createSignal(0);
  let refreshRunId = 0;

  const refresh = async () => {
    const currentRun = ++refreshRunId;
    const settings = readDenSettings();
    const token = settings.authToken?.trim() ?? "";
    const cacheKey = getDesktopConfigCacheKey();

    if (!denAuth.isSignedIn() || !token || !settings.activeOrgId?.trim()) {
      setConfig(DEFAULT_DESKTOP_CONFIG);
      setLoading(false);
      return;
    }

    const cached = readCachedDesktopConfig(cacheKey);
    if (!cached) {
      setLoading(true);
    }

    try {
      const nextConfig = await createDenClient({
        baseUrl: settings.baseUrl,
        apiBaseUrl: settings.apiBaseUrl,
        token,
      }).getDesktopConfig();

      if (currentRun !== refreshRunId) {
        return;
      }

      writeCachedDesktopConfig(cacheKey, nextConfig);
      setConfig(nextConfig);
    } catch (error) {
      if (currentRun !== refreshRunId) {
        return;
      }

      if (
        error instanceof DenApiError &&
        error.status === 404 &&
        error.code === "organization_not_found"
      ) {
        await ensureDenActiveOrganization({ forceServerSync: true }).catch(() => null);
      }

      setConfig(cached ?? DEFAULT_DESKTOP_CONFIG);
    } finally {
      if (currentRun === refreshRunId) {
        setLoading(false);
      }
    }
  };

  createEffect(() => {
    settingsVersion();

    if (!denAuth.isSignedIn()) {
      setConfig(DEFAULT_DESKTOP_CONFIG);
      setLoading(false);
      return;
    }

    const cacheKey = getDesktopConfigCacheKey();
    const cached = readCachedDesktopConfig(cacheKey);
    setConfig(cached ?? DEFAULT_DESKTOP_CONFIG);
    setLoading(!cached);
    void refresh();
  });

  onMount(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handleSettingsChanged = () => {
      setSettingsVersion((value) => value + 1);
    };

    window.addEventListener(denSessionUpdatedEvent, handleSettingsChanged);
    window.addEventListener(denSettingsChangedEvent, handleSettingsChanged);

    const interval = window.setInterval(() => {
      if (!denAuth.isSignedIn()) {
        return;
      }
      void refresh();
    }, DESKTOP_CONFIG_REFRESH_MS);

    onCleanup(() => {
      window.removeEventListener(denSessionUpdatedEvent, handleSettingsChanged);
      window.removeEventListener(denSettingsChangedEvent, handleSettingsChanged);
      window.clearInterval(interval);
    });
  });

  const store: DesktopConfigStore = {
    config,
    loading,
    refresh,
    checkRestriction(input) {
      return checkDesktopAppRestriction({
        config: config(),
        restriction: input.restriction,
      });
    },
  };

  return (
    <DesktopConfigContext.Provider value={store}>
      {props.children}
    </DesktopConfigContext.Provider>
  );
}

export function useDesktopConfig() {
  const context = useContext(DesktopConfigContext);
  if (!context) {
    throw new Error("useDesktopConfig must be used within a DesktopConfigProvider");
  }
  return context;
}
