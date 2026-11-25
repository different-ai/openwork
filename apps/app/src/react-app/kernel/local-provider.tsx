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

import { MODEL_PREF_KEY, THINKING_PREF_KEY } from "../../app/constants";
import { coerceReleaseChannel } from "../../app/lib/release-channels";
import type { ModelRef, ReleaseChannel, SettingsTab, View } from "../../app/types";
import {
  DEFAULT_DESKTOP_NOTIFICATION_PREFERENCE,
  isDesktopNotificationPreference,
  type DesktopNotificationPreference,
} from "./desktop-notification-preferences";
import { DEFAULT_SHOW_THINKING, isFollowUpDefault, isLinkOpenDestination, LOCAL_PREFERENCES_KEY, needsShowThinkingReset, type FollowUpDefault, type LinkOpenDestination } from "./local-preferences-storage";
import {
  readStoredDefaultModel,
  storedDefaultModelChangedEvent,
  writeStoredDefaultModel,
} from "./model-config";

export type LocalUIState = {
  view: View;
  tab: SettingsTab;
};

export type LocalPreferences = {
  showThinking: boolean;
  showThinkingResetToOff: boolean;
  modelVariant: string | null;
  defaultModel: ModelRef | null;
  selectedAgent: string | null;
  releaseChannel: ReleaseChannel;
  featureFlags: {
    workspaceRunMode: boolean;
  };
  hasCompletedOnboarding: boolean;
  analyticsEnabled: boolean;
  desktopNotifications: DesktopNotificationPreference;
  linkOpenDestination: LinkOpenDestination;
  askBeforeOpeningLinks: boolean;
  keepAwake: boolean;
  followUpDefault: FollowUpDefault;
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
export { DEFAULT_SHOW_THINKING };

const INITIAL_UI: LocalUIState = { view: "settings", tab: "general" };
const INITIAL_PREFS: LocalPreferences = {
  showThinking: DEFAULT_SHOW_THINKING,
  showThinkingResetToOff: true,
  modelVariant: null,
  defaultModel: null,
  selectedAgent: null,
  releaseChannel: "stable",
  featureFlags: { workspaceRunMode: false },
  hasCompletedOnboarding: false,
  analyticsEnabled: true,
  desktopNotifications: DEFAULT_DESKTOP_NOTIFICATION_PREFERENCE,
  linkOpenDestination: "openwork",
  askBeforeOpeningLinks: true,
  keepAwake: true,
  followUpDefault: "queue",
};

function readStored(key: string): unknown {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

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
    if (needsShowThinkingReset(readStored(LOCAL_PREFERENCES_KEY))) persisted.showThinking = false;
    persisted.showThinkingResetToOff = true;
    persisted.askBeforeOpeningLinks = persisted.askBeforeOpeningLinks !== false;
    persisted.linkOpenDestination = isLinkOpenDestination(persisted.linkOpenDestination)
      ? persisted.linkOpenDestination
      : "openwork";
    persisted.followUpDefault = isFollowUpDefault(persisted.followUpDefault) ? persisted.followUpDefault : "queue";
    persisted.desktopNotifications = isDesktopNotificationPreference(persisted.desktopNotifications)
      ? persisted.desktopNotifications
      : DEFAULT_DESKTOP_NOTIFICATION_PREFERENCE;
    try {
      if (window.localStorage.getItem(MODEL_PREF_KEY) !== null) {
        return { ...persisted, defaultModel: readStoredDefaultModel() };
      }
    } catch {
    }
    if (persisted.defaultModel) return persisted;
    return {
      ...persisted,
      defaultModel: readStoredDefaultModel(),
    };
  });
  const prefsRef = useRef(prefs);
  const setPrefs = useCallback(
    (updater: (previous: LocalPreferences) => LocalPreferences) => {
      const previous = prefsRef.current;
      const next = updater(previous);
      prefsRef.current = next;
      setPrefsRaw(next);
      if (next.defaultModel && (
        next.defaultModel.providerID !== previous.defaultModel?.providerID ||
        next.defaultModel.modelID !== previous.defaultModel?.modelID
      )) writeStoredDefaultModel(next.defaultModel);
    },
    [],
  );
  const ready = true;
  const migratedThinkingRef = useRef(false);

  useEffect(() => {
    writePersisted(UI_STORAGE_KEY, ui);
  }, [ui]);

  useEffect(() => {
    writePersisted(LOCAL_PREFERENCES_KEY, prefs);
  }, [prefs]);

  useEffect(() => {
    const updateDefaultModel = () => {
      const model = readStoredDefaultModel();
      setPrefs((previous) => {
        if (
          previous.defaultModel?.providerID === model.providerID &&
          previous.defaultModel.modelID === model.modelID
        ) {
          return previous;
        }

        return {
          ...previous,
          defaultModel: model,
          modelVariant: null,
        };
      });
    };

    window.addEventListener(storedDefaultModelChangedEvent, updateDefaultModel);
    try {
      if (window.localStorage.getItem(MODEL_PREF_KEY) === null && prefsRef.current.defaultModel) {
        writeStoredDefaultModel(prefsRef.current.defaultModel);
      }
    } catch {
    }
    updateDefaultModel();
    return () => window.removeEventListener(storedDefaultModelChangedEvent, updateDefaultModel);
  }, [setPrefs]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (migratedThinkingRef.current) return;
    migratedThinkingRef.current = true;

    try {
      window.localStorage.removeItem(THINKING_PREF_KEY);
    } catch {
    }
  }, []);

  const setUi = useCallback(
    (updater: (previous: LocalUIState) => LocalUIState) => {
      setUiRaw(updater);
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
