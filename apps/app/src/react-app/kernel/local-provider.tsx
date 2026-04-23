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

import { THINKING_PREF_KEY } from "../../app/constants";
import { coerceReleaseChannel } from "../../app/lib/release-channels";
import type { ModelRef, ReleaseChannel, SettingsTab, View } from "../../app/types";
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
   * Release channel the desktop app is subscribed to. Defaults to
   * "stable". Alpha is only honored on macOS; the updater helper falls
   * back to stable elsewhere.
   */
  releaseChannel: ReleaseChannel;
  featureFlags: {
    microsandboxCreateSandbox: boolean;
  };
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
const PREFS_STORAGE_KEY = "openwork.preferences";

const INITIAL_UI: LocalUIState = { view: "settings", tab: "general" };
const INITIAL_PREFS: LocalPreferences = {
  showThinking: false,
  modelVariant: null,
  defaultModel: null,
  releaseChannel: "stable",
  featureFlags: { microsandboxCreateSandbox: false },
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
    const persisted = readPersisted(PREFS_STORAGE_KEY, INITIAL_PREFS);
    if (persisted.defaultModel) {
      return persisted;
    }
    return {
      ...persisted,
      defaultModel: readStoredDefaultModel(),
    };
  });
  const [ready, setReady] = useState(false);
  const migratedThinkingRef = useRef(false);

  useEffect(() => {
    writePersisted(UI_STORAGE_KEY, ui);
  }, [ui]);

  useEffect(() => {
    writePersisted(PREFS_STORAGE_KEY, prefs);
  }, [prefs]);

  useEffect(() => {
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
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
  }, [ready]);

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
  const context = useContext(LocalContext);
  if (!context) {
    throw new Error("Local context is missing");
  }
  return context;
}
