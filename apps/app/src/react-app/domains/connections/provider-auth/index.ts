import {
  createContext,
  createElement,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import type { ProviderAuthStore } from "./store";

export { createProviderAuthStore, useProviderAuthStoreSnapshot } from "./store";
export type {
  ProviderAuthMethod,
  ProviderAuthProvider,
  ProviderAuthStoreSnapshot,
  ProviderOAuthStartResult,
  ProviderAuthStore,
} from "./store";
export { default as ProviderAuthModal } from "./provider-auth-modal";

const ProviderAuthContext = createContext<ProviderAuthStore | null>(null);

type ProviderAuthStoreProviderProps = {
  store: ProviderAuthStore;
  children: ReactNode;
};

export function ProviderAuthStoreProvider({
  store,
  children,
}: ProviderAuthStoreProviderProps) {
  return createElement(ProviderAuthContext.Provider, { value: store }, children);
}

export function useProviderAuth() {
  const store = useContext(ProviderAuthContext);
  if (!store) {
    throw new Error("useProviderAuth must be used within a ProviderAuthStoreProvider");
  }

  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  return store;
}
