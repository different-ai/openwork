/** @jsxImportSource react */
import {
  createContext,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import type { ConnectionsStore } from "./store";

const ConnectionsContext = createContext<ConnectionsStore | null>(null);

export function ConnectionsProvider(props: {
  store: ConnectionsStore;
  children: ReactNode;
}) {
  return (
    <ConnectionsContext.Provider value={props.store}>
      {props.children}
    </ConnectionsContext.Provider>
  );
}

export function useConnections() {
  const store = useContext(ConnectionsContext);
  if (!store) {
    throw new Error("useConnections must be used within a ConnectionsProvider");
  }

  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  return store;
}
