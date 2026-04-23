/** @jsxImportSource react */
import { createContext, useContext, useEffect, type ReactNode } from "react";

import { useAutomationsStoreSnapshot, type AutomationsStore } from "./automations-store";

const AutomationsContext = createContext<AutomationsStore | null>(null);

type AutomationsProviderProps = {
  store: AutomationsStore;
  children: ReactNode;
};

export function AutomationsProvider({ store, children }: AutomationsProviderProps) {
  useEffect(() => {
    store.start();
    store.syncFromOptions();
    return () => {
      store.dispose();
    };
  }, [store]);

  useEffect(() => {
    store.syncFromOptions();
  });

  return <AutomationsContext.Provider value={store}>{children}</AutomationsContext.Provider>;
}

export function useAutomations(): AutomationsStore {
  const context = useContext(AutomationsContext);
  if (!context) {
    throw new Error("useAutomations must be used within an AutomationsProvider");
  }

  useAutomationsStoreSnapshot(context);

  return context;
}
