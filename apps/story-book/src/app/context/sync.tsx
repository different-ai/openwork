import { createContext, useContext, type ParentProps } from "solid-js";
import type { SetStoreFunction, Store } from "solid-js/store";

import { useGlobalSync, type WorkspaceState } from "./global-sync";

type SyncContextValue = {
  directory: string;
  data: Store<WorkspaceState>;
  set: SetStoreFunction<WorkspaceState>;
};

const SyncContext = createContext<SyncContextValue | undefined>(undefined);

export function SyncProvider(props: ParentProps & { directory: string }) {
  const globalSync = useGlobalSync();
  const [store, setStore] = globalSync.child(props.directory);

  const value: SyncContextValue = {
    directory: props.directory,
    data: store,
    set: setStore,
  };

  return <SyncContext.Provider value={value}>{props.children}</SyncContext.Provider>;
}

export function useSync() {
  const context = useContext(SyncContext);
  if (!context) {
    throw new Error("Sync context is missing");
  }
  return context;
}
