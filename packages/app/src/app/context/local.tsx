import { createContext, useContext, type ParentProps } from "solid-js";
import { createStore, type SetStoreFunction, type Store } from "solid-js/store";

import type { DashboardTab, ModelRef, View } from "../types";
import { Persist, persisted } from "../utils/persist";

type LocalUIState = {
  view: View;
  tab: DashboardTab;
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
      view: "onboarding",
      tab: "home",
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
