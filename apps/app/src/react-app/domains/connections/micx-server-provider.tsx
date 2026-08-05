/** @jsxImportSource react */
import {
  createContext,
  use,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import type { MicxServerStore } from "./micx-server-store";

const MicxServerContext = createContext<MicxServerStore | null>(null);

export function MicxServerProvider(props: {
  store: MicxServerStore;
  children: ReactNode;
}) {
  return (
    <MicxServerContext.Provider value={props.store}>
      {props.children}
    </MicxServerContext.Provider>
  );
}

export function useMicxServer() {
  const store = use(MicxServerContext);
  if (!store) {
    throw new Error("useMicxServer must be used within an MicxServerProvider");
  }

  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  return store;
}
