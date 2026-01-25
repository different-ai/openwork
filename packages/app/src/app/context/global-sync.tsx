import { createContext, createEffect, useContext, type ParentProps } from "solid-js";
import { createStore, type SetStoreFunction, type Store } from "solid-js/store";

import type {
  Command,
  Config,
  ConfigProvidersResponse,
  Event,
  GlobalHealthResponse,
  LspStatus,
  Project,
  ProviderListResponse,
  ProviderAuthResponse,
  Message,
  Part,
  Session,
  VcsInfo,
} from "@opencode-ai/sdk/v2/client";

import type { McpStatusMap, TodoItem } from "../types";
import { unwrap } from "../lib/opencode";
import { safeStringify } from "../utils";
import { useGlobalSDK } from "./global-sdk";

export type WorkspaceState = {
  status: "idle" | "loading" | "partial" | "ready";
  session: Session[];
  session_status: Record<string, string>;
  message: Record<string, Message[]>;
  part: Record<string, Part[]>;
  todo: Record<string, TodoItem[]>;
};

type WorkspaceStore = [Store<WorkspaceState>, SetStoreFunction<WorkspaceState>];

type ProjectMeta = {
  name?: string;
  icon?: Project["icon"];
  commands?: Project["commands"];
};

type GlobalState = {
  ready: boolean;
  error?: string;
  serverVersion?: string;
  config: Config;
  provider: ProviderListResponse;
  providerAuth: ProviderAuthResponse;
  command: Record<string, Command[]>;
  mcp: Record<string, McpStatusMap>;
  lsp: Record<string, LspStatus[]>;
  project: Project[];
  projectMeta: Record<string, ProjectMeta>;
  vcs: Record<string, VcsInfo | null>;
};

type GlobalSyncContextValue = {
  data: Store<GlobalState>;
  set: SetStoreFunction<GlobalState>;
  child: (directory: string) => WorkspaceStore;
  refresh: () => Promise<void>;
  refreshDirectory: (directory: string) => Promise<void>;
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
  const globalSDK = useGlobalSDK();
  const defaultProvider: ProviderListResponse = { all: [], connected: [], default: {} };
  const [globalStore, setGlobalStore] = createStore<GlobalState>({
    ready: false,
    error: undefined,
    serverVersion: undefined,
    config: {},
    provider: defaultProvider,
    providerAuth: {},
    command: {},
    mcp: {},
    lsp: {},
    project: [],
    projectMeta: {},
    vcs: {},
  });
  const children = new Map<string, WorkspaceStore>();
  const subscriptions = new Map<string, () => void>();

  const keyFor = (directory: string) => directory || "global";

  const setError = (error: unknown) => {
    const message = error instanceof Error ? error.message : safeStringify(error);
    setGlobalStore("error", message || "Unknown error");
  };

  const setProjectMeta = (projects: Project[]) => {
    const next: Record<string, ProjectMeta> = {};
    for (const project of projects) {
      if (!project?.worktree) continue;
      next[project.worktree] = {
        name: project.name,
        icon: project.icon,
        commands: project.commands,
      };
    }
    setGlobalStore("projectMeta", next);
  };

  const refreshConfig = async () => {
    const result = unwrap(await globalSDK.client().config.get());
    setGlobalStore("config", result);
  };

  const refreshProviders = async () => {
    try {
      const result = unwrap(await globalSDK.client().provider.list());
      setGlobalStore("provider", result);
    } catch {
      const fallback = unwrap(await globalSDK.client().config.providers()) as ConfigProvidersResponse;
      setGlobalStore("provider", {
        all: fallback.providers as ProviderListResponse["all"],
        connected: [],
        default: fallback.default,
      });
    }
  };

  const refreshProviderAuth = async () => {
    try {
      const result = await globalSDK.client().provider.auth();
      setGlobalStore("providerAuth", result.data ?? {});
    } catch {
      setGlobalStore("providerAuth", {});
    }
  };

  const refreshCommands = async (directory?: string) => {
    const result = unwrap(await globalSDK.client().command.list({ directory })) as Command[];
    setGlobalStore("command", keyFor(directory ?? ""), result);
  };

  const refreshMcp = async (directory?: string) => {
    const result = unwrap(await globalSDK.client().mcp.status({ directory })) as McpStatusMap;
    setGlobalStore("mcp", keyFor(directory ?? ""), result as McpStatusMap);
  };

  const refreshLsp = async (directory?: string) => {
    const result = unwrap(await globalSDK.client().lsp.status({ directory })) as LspStatus[];
    setGlobalStore("lsp", keyFor(directory ?? ""), result as LspStatus[]);
  };

  const refreshVcs = async (directory: string) => {
    try {
      const result = unwrap(await globalSDK.client().vcs.get({ directory })) as VcsInfo;
      setGlobalStore("vcs", keyFor(directory), result ?? null);
    } catch {
      setGlobalStore("vcs", keyFor(directory), null);
    }
  };

  const refreshProjects = async () => {
    const projects = unwrap(await globalSDK.client().project.list()) as Project[];
    setGlobalStore("project", projects);
    setProjectMeta(projects);
    await Promise.allSettled(
      projects
        .map((project) => project.worktree)
        .filter((worktree): worktree is string => typeof worktree === "string" && worktree.length > 0)
        .map((worktree) => refreshVcs(worktree)),
    );
  };

  const refreshDirectory = async (directory: string) => {
    if (!directory) return;
    await Promise.allSettled([
      refreshCommands(directory),
      refreshMcp(directory),
      refreshLsp(directory),
      refreshVcs(directory),
    ]);
  };

  const refresh = async () => {
    setGlobalStore("ready", false);
    setGlobalStore("error", undefined);

    try {
      const health = unwrap(await globalSDK.client().global.health()) as GlobalHealthResponse;
      if (!health?.healthy) {
        setGlobalStore("error", "Server reported unhealthy status.");
        return;
      }

      if (globalStore.serverVersion && health.version !== globalStore.serverVersion) {
        setGlobalStore("command", {});
        setGlobalStore("mcp", {});
        setGlobalStore("lsp", {});
        setGlobalStore("project", []);
        setGlobalStore("projectMeta", {});
        setGlobalStore("vcs", {});
      }
      setGlobalStore("serverVersion", health.version);
    } catch (error) {
      setError(error);
      return;
    }

    const results = await Promise.allSettled([
      refreshConfig(),
      refreshProviders(),
      refreshProviderAuth(),
      refreshCommands(),
      refreshMcp(),
      refreshLsp(),
      refreshProjects(),
    ]);

    for (const result of results) {
      if (result.status === "rejected") {
        setError(result.reason);
      }
    }

    setGlobalStore("ready", true);
  };

  const child = (directory: string): WorkspaceStore => {
    const key = keyFor(directory);
    const existing = children.get(key);
    if (existing) return existing;
    const store = createStore<WorkspaceState>(createWorkspaceState());
    children.set(key, store);
    void refreshDirectory(directory);
    if (!subscriptions.has(key)) {
      const unsubscribe = globalSDK.event.listen(key, (event: Event) => {
        if (event.type === "lsp.updated") {
          void refreshLsp(directory);
        }
        if (event.type === "mcp.tools.changed") {
          void refreshMcp(directory);
        }
      });
      subscriptions.set(key, unsubscribe);
    }
    return store;
  };

  const value: GlobalSyncContextValue = {
    data: globalStore,
    set: setGlobalStore,
    child,
    refresh,
    refreshDirectory,
  };

  createEffect(() => {
    const url = globalSDK.url();
    if (!url) return;
    void refresh();
  });

  const globalKey = keyFor("");
  if (!subscriptions.has(globalKey)) {
    const unsubscribe = globalSDK.event.listen(globalKey, (event: Event) => {
      if (event.type === "lsp.updated") {
        void refreshLsp();
      }
      if (event.type === "mcp.tools.changed") {
        void refreshMcp();
      }
    });
    subscriptions.set(globalKey, unsubscribe);
  }

  return <GlobalSyncContext.Provider value={value}>{props.children}</GlobalSyncContext.Provider>;
}

export function useGlobalSync() {
  const context = useContext(GlobalSyncContext);
  if (!context) {
    throw new Error("Global sync context is missing");
  }
  return context;
}
