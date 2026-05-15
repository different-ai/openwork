/** @jsxImportSource react */
import { createContext, use, useSyncExternalStore, type ReactNode } from "react";

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
  const context = use(SessionActionsContext);
  if (!context) {
    throw new Error("useSessionActions must be used within a SessionActionsProvider");
  }

  useSyncExternalStore(context.subscribe, context.getSnapshot, context.getSnapshot);

  return context;
}
