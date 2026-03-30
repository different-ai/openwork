import { createContext, createEffect, useContext, type ParentProps } from "solid-js";
import { createStore, type SetStoreFunction, type Store } from "solid-js/store";

import { THINKING_PREF_KEY } from "../constants";
import type { ModelRef, SettingsTab, View } from "../types";
import { Persist, persisted } from "../utils/persist";

type LocalUIState = {
  view: View;
  tab: SettingsTab;
};

type LocalPreferences = {
  showThinking: boolean;
  modelVariant: string | null;
  defaultModel: ModelRef | null;
};

type LocalContextValue = {
  ui: Store<LocalUIState>;
  setUi: SetStoreFunction<LocalUIState>;
  prefs: Store<LocalPreferences>;
  setPrefs: SetStoreFunction<LocalPreferences>;
  ready: () => boolean;
};

const LocalContext = createContext<LocalContextValue | undefined>(undefined);

export function LocalProvider(props: ParentProps) {
  const [ui, setUi, , uiReady] = persisted(
    Persist.global("local.ui", ["openwork.ui"]),
    createStore<LocalUIState>({
      view: "settings",
      tab: "general",
    }),
  );

  const [prefs, setPrefs, , prefsReady] = persisted(
    Persist.global("local.preferences", ["openwork.preferences"]),
    createStore<LocalPreferences>({
      showThinking: false,
      modelVariant: null,
      defaultModel: null,
    }),
  );

  const ready = () => uiReady() && prefsReady();

  createEffect(() => {
    if (!prefsReady()) return;
    if (typeof window === "undefined") return;

    const raw = window.localStorage.getItem(THINKING_PREF_KEY);
    if (raw == null) return;

    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "boolean") {
        setPrefs("showThinking", parsed);
      }
    } catch {
      // ignore invalid legacy values
    }

    try {
      window.localStorage.removeItem(THINKING_PREF_KEY);
    } catch {
      // ignore
    }
  });

  const value: LocalContextValue = {
    ui,
    setUi,
    prefs,
    setPrefs,
    ready,
  };

  return <LocalContext.Provider value={value}>{props.children}</LocalContext.Provider>;
}

export function useLocal() {
  const context = useContext(LocalContext);
  if (!context) {
    throw new Error("Local context is missing");
  }
  return context;
}
