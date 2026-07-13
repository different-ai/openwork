/** @jsxImportSource react */
import {
  createContext,
  useCallback,
  use,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { THINKING_PREF_KEY } from "../../app/constants";
import { coerceReleaseChannel } from "../../app/lib/release-channels";
import type { ModelRef, ReleaseChannel, SettingsTab, View } from "../../app/types";
import {
  DEFAULT_DESKTOP_NOTIFICATION_PREFERENCE,
  isDesktopNotificationPreference,
  type DesktopNotificationPreference,
} from "./desktop-notification-preferences";
import { LOCAL_PREFERENCES_KEY } from "./local-preferences-storage";
import { readStoredDefaultModel } from "./model-config";

export type LocalUIState = {
  view: View;
  tab: SettingsTab;
};

export type LocalPreferences = {
  showThinking: boolean;
  modelVariant: string | null;
  defaultModel: ModelRef | null;
  /**
   * Name of the opencode agent used for new prompts (null = the server's
   * default, usually "build"). Persisted so a reload does not silently
   * fall back to the default agent (#2101).
   */
  selectedAgent: string | null;
  /**
   * Release channel the desktop app is subscribed to. Defaults to
   * "stable". Alpha is only honored on macOS; the updater helper falls
   * back to stable elsewhere.
   */
  releaseChannel: ReleaseChannel;
  featureFlags: {
    microsandboxCreateSandbox: boolean;
    /**
     * Memory Bank preview. Client-only, per-device, never synced. Gates desktop
     * UI surfacing (the management panel + copy-prompt affordance); the routes
     * stay callable (owner-scoped + authz'd). Off by default — opt-in preview.
     */
    memory: boolean;
  };
  /**
   * Set to true after the user completes the welcome/onboarding flow
   * (creates or connects their first workspace). When false and the
   * workspace list is empty, the app redirects to /welcome.
   */
  hasCompletedOnboarding: boolean;
  /**
   * One-shot provider selection shown on the user's first send when no
   * user-added provider is connected. True once completed or skipped.
   */
  providerStepCompleted: boolean;
  /**
   * Anonymous product analytics (PostHog). On by default with a visible
   * opt-out in Settings -> Preferences. Never includes message content.
   */
  analyticsEnabled: boolean;
  /**
   * Native OS notifications from the desktop app. Off by default so upgrading
   * users are not surprised by system popups.
   */
  desktopNotifications: DesktopNotificationPreference;
};

type LocalContextValue = {
  ui: LocalUIState;
  setUi: (updater: (previous: LocalUIState) => LocalUIState) => void;
  prefs: LocalPreferences;
  setPrefs: (updater: (previous: LocalPreferences) => LocalPreferences) => void;
  ready: boolean;
};

const LocalContext = createContext<LocalContextValue | undefined>(undefined);

const UI_STORAGE_KEY = "openwork.ui";
export const DEFAULT_SHOW_THINKING = true;

const INITIAL_UI: LocalUIState = { view: "settings", tab: "general" };
const INITIAL_PREFS: LocalPreferences = {
  showThinking: DEFAULT_SHOW_THINKING,
  modelVariant: null,
  defaultModel: null,
  selectedAgent: null,
  releaseChannel: "stable",
  featureFlags: { microsandboxCreateSandbox: true, memory: false },
  hasCompletedOnboarding: false,
  providerStepCompleted: false,
  analyticsEnabled: true,
  desktopNotifications: DEFAULT_DESKTOP_NOTIFICATION_PREFERENCE,
};

function readPersisted<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      return { ...fallback, ...(parsed as Record<string, unknown>) } as T;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

function writePersisted(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore quota errors
  }
}

type LocalProviderProps = {
  children: ReactNode;
};

export function LocalProvider({ children }: LocalProviderProps) {
  const [ui, setUiRaw] = useState<LocalUIState>(() =>
    readPersisted(UI_STORAGE_KEY, INITIAL_UI),
  );
  const [prefs, setPrefsRaw] = useState<LocalPreferences>(() => {
    const persisted = readPersisted(LOCAL_PREFERENCES_KEY, INITIAL_PREFS);
    persisted.desktopNotifications = isDesktopNotificationPreference(persisted.desktopNotifications)
      ? persisted.desktopNotifications
      : DEFAULT_DESKTOP_NOTIFICATION_PREFERENCE;
    // Back-fill: users who onboarded before the agent-screen-first flow have
    // already picked a provider path. Only fires while the new key is absent
    // from storage (first write persists it).
    try {
      const raw = JSON.parse(window.localStorage.getItem(LOCAL_PREFERENCES_KEY) ?? "{}") as Record<string, unknown>;
      if (raw.hasCompletedOnboarding === true && raw.providerStepCompleted === undefined) {
        persisted.providerStepCompleted = true;
      }
    } catch {
      // ignore parse failures; defaults apply
    }
    if (persisted.defaultModel) {
      return persisted;
    }
    return {
      ...persisted,
      defaultModel: readStoredDefaultModel(),
    };
  });
  const ready = true;
  const migratedThinkingRef = useRef(false);

  useEffect(() => {
    writePersisted(UI_STORAGE_KEY, ui);
  }, [ui]);

  useEffect(() => {
    writePersisted(LOCAL_PREFERENCES_KEY, prefs);
  }, [prefs]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (migratedThinkingRef.current) return;
    migratedThinkingRef.current = true;

    const raw = window.localStorage.getItem(THINKING_PREF_KEY);
    if (raw == null) return;

    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "boolean") {
        setPrefsRaw((previous) => ({ ...previous, showThinking: parsed }));
      }
    } catch {
      // ignore invalid legacy values
    }

    try {
      window.localStorage.removeItem(THINKING_PREF_KEY);
    } catch {
      // ignore
    }
  }, []);

  const setUi = useCallback(
    (updater: (previous: LocalUIState) => LocalUIState) => {
      setUiRaw(updater);
    },
    [],
  );

  const setPrefs = useCallback(
    (updater: (previous: LocalPreferences) => LocalPreferences) => {
      setPrefsRaw(updater);
    },
    [],
  );

  const value = useMemo<LocalContextValue>(
    () => ({ ui, setUi, prefs, setPrefs, ready }),
    [prefs, ready, setPrefs, setUi, ui],
  );

  return <LocalContext.Provider value={value}>{children}</LocalContext.Provider>;
}

export function useLocal(): LocalContextValue {
  const context = use(LocalContext);
  if (!context) {
    throw new Error("Local context is missing");
  }
  return context;
}
