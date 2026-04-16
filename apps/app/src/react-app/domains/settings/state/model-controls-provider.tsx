/** @jsxImportSource react */
import { createContext, useContext, type ReactNode } from "react";

import type { ModelControlsStore } from "./model-controls-store";

const ModelControlsContext = createContext<ModelControlsStore | null>(null);

type ModelControlsProviderProps = {
  store: ModelControlsStore;
  children: ReactNode;
};

export function ModelControlsProvider({
  store,
  children,
}: ModelControlsProviderProps) {
  return (
    <ModelControlsContext.Provider value={store}>
      {children}
    </ModelControlsContext.Provider>
  );
}

export function useModelControls(): ModelControlsStore {
  const context = useContext(ModelControlsContext);
  if (!context) {
    throw new Error("useModelControls must be used within a ModelControlsProvider");
  }
  return context;
}
