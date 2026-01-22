import { createContext, useContext, type ParentProps } from "solid-js";
import { createStore, type SetStoreFunction, type Store } from "solid-js/store";

import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client";

import type { TodoItem } from "../types";

export type WorkspaceState = {
  status: "idle" | "loading" | "partial" | "ready";
  session: Session[];
  session_status: Record<string, string>;
  message: Record<string, Message[]>;
  part: Record<string, Part[]>;
  todo: Record<string, TodoItem[]>;
};

type WorkspaceStore = [Store<WorkspaceState>, SetStoreFunction<WorkspaceState>];

type GlobalSyncContextValue = {
  data: Store<{ ready: boolean; error?: string }>;
  child: (directory: string) => WorkspaceStore;
};

const GlobalSyncContext = createContext<GlobalSyncContextValue | undefined>(undefined);

const createWorkspaceState = (): WorkspaceState => ({
  status: "idle",
  session: [],
  session_status: {},
  message: {},
  part: {},
  todo: {},
});

export function GlobalSyncProvider(props: ParentProps) {
  const [globalStore] = createStore({ ready: true, error: undefined as string | undefined });
  const children = new Map<string, WorkspaceStore>();

  const child = (directory: string): WorkspaceStore => {
    const key = directory || "global";
    const existing = children.get(key);
    if (existing) return existing;
    const store = createStore<WorkspaceState>(createWorkspaceState());
    children.set(key, store);
    return store;
  };

  const value: GlobalSyncContextValue = {
    data: globalStore,
    child,
  };

  return <GlobalSyncContext.Provider value={value}>{props.children}</GlobalSyncContext.Provider>;
}

export function useGlobalSync() {
  const context = useContext(GlobalSyncContext);
  if (!context) {
    throw new Error("Global sync context is missing");
  }
  return context;
}
