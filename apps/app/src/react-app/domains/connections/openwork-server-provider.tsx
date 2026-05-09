/** @jsxImportSource react */
import {
  createContext,
  use,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import type { OpenworkServerStore } from "./openwork-server-store";

const OpenworkServerContext = createContext<OpenworkServerStore | null>(null);

export function OpenworkServerProvider(props: {
  store: OpenworkServerStore;
  children: ReactNode;
}) {
  return (
    <OpenworkServerContext.Provider value={props.store}>
      {props.children}
    </OpenworkServerContext.Provider>
  );
}

export function useOpenworkServer() {
  const store = use(OpenworkServerContext);
  if (!store) {
    throw new Error("useOpenworkServer must be used within an OpenworkServerProvider");
  }

  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  return store;
}
