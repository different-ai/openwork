/** @jsxImportSource react */
import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";

import type { SessionActionsStore } from "./actions-store";

const SessionActionsContext = createContext<SessionActionsStore | null>(null);

type SessionActionsProviderProps = {
  store: SessionActionsStore;
  children: ReactNode;
};

export function SessionActionsProvider({
  store,
  children,
}: SessionActionsProviderProps) {
  return (
    <SessionActionsContext.Provider value={store}>
      {children}
    </SessionActionsContext.Provider>
  );
}

export function useSessionActions(): SessionActionsStore {
  const context = useContext(SessionActionsContext);
  if (!context) {
    throw new Error("useSessionActions must be used within a SessionActionsProvider");
  }

  useSyncExternalStore(context.subscribe, context.getSnapshot, context.getSnapshot);

  return context;
}
