/** @jsxImportSource react */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  Config,
  ConfigProvidersResponse,
  Event,
  GlobalHealthResponse,
  LspStatus,
  Message,
  Part,
  Project,
  ProviderAuthResponse,
  ProviderListResponse,
  Session,
  VcsInfo,
} from "@opencode-ai/sdk/v2/client";

import { currentLocale, t } from "../../i18n";
import { unwrap } from "../../app/lib/opencode";
import type { McpStatusMap, TodoItem } from "../../app/types";
import { safeStringify } from "../../app/utils";
import {
  filterProviderList,
  mapConfigProvidersToList,
} from "../../app/utils/providers";

import { useGlobalSDK } from "./global-sdk-provider";

export type WorkspaceState = {
  status: "idle" | "loading" | "partial" | "ready";
  session: Session[];
  session_status: Record<string, string>;
  message: Record<string, Message[]>;
  part: Record<string, Part[]>;
  todo: Record<string, TodoItem[]>;
};

type ProjectMeta = {
  name?: string;
  icon?: Project["icon"];
};

export type GlobalState = {
  ready: boolean;
  error?: string;
  serverVersion?: string;
  config: Config;
  provider: ProviderListResponse;
  providerAuth: ProviderAuthResponse;
  mcp: Record<string, McpStatusMap>;
  lsp: Record<string, LspStatus[]>;
  project: Project[];
  projectMeta: Record<string, ProjectMeta>;
  vcs: Record<string, VcsInfo | null>;
};

type GlobalSyncContextValue = {
  data: GlobalState;
  setData: (updater: (previous: GlobalState) => GlobalState) => void;
  refresh: () => Promise<void>;
  refreshDirectory: (directory: string) => Promise<void>;
  getWorkspace: (directory: string) => WorkspaceState;
  setWorkspace: (
    directory: string,
    updater: (previous: WorkspaceState) => WorkspaceState,
  ) => void;
};

const GlobalSyncContext = createContext<GlobalSyncContextValue | undefined>(
  undefined,
);

const DEFAULT_PROVIDER: ProviderListResponse = {
  all: [],
  connected: [],
  default: {},
};

const INITIAL_GLOBAL_STATE: GlobalState = {
  ready: false,
  error: undefined,
  serverVersion: undefined,
  config: {},
  provider: DEFAULT_PROVIDER,
  providerAuth: {},
  mcp: {},
  lsp: {},
  project: [],
  projectMeta: {},
  vcs: {},
};

const createWorkspaceState = (): WorkspaceState => ({
  status: "idle",
  session: [],
  session_status: {},
  message: {},
  part: {},
  todo: {},
});

const keyFor = (directory: string) => directory || "global";

type GlobalSyncProviderProps = {
  children: ReactNode;
};

export function GlobalSyncProvider({ children }: GlobalSyncProviderProps) {
  const globalSDK = useGlobalSDK();
  const [state, setState] = useState<GlobalState>(INITIAL_GLOBAL_STATE);
  const workspacesRef = useRef(new Map<string, WorkspaceState>());
  const subscriptionsRef = useRef(new Map<string, () => void>());
  const latestStateRef = useRef<GlobalState>(state);
  latestStateRef.current = state;

  const setField = useCallback(
    <K extends keyof GlobalState>(key: K, value: GlobalState[K]) => {
      setState((previous) => ({ ...previous, [key]: value }));
    },
    [],
  );

  const setError = useCallback((error: unknown) => {
    const message =
      error instanceof Error ? error.message : safeStringify(error);
    setState((previous) => ({
      ...previous,
      error: message || t("app.unknown_error", currentLocale()),
    }));
  }, []);

  const setProjectMetaForProjects = useCallback((projects: Project[]) => {
    const next: Record<string, ProjectMeta> = {};
    for (const project of projects) {
      if (!project?.worktree) continue;
      next[project.worktree] = {
        name: project.name,
        icon: project.icon,
      };
    }
    setField("projectMeta", next);
  }, [setField]);

  const refreshConfig = useCallback(async () => {
    const result = unwrap(await globalSDK.client.config.get());
    setField("config", result);
  }, [globalSDK.client, setField]);

  const refreshProviders = useCallback(async () => {
    let disabledProviders =
      latestStateRef.current.config.disabled_providers ?? [];
    try {
      const config = unwrap(await globalSDK.client.config.get());
      disabledProviders = Array.isArray(config.disabled_providers)
        ? config.disabled_providers
        : [];
    } catch {
      // ignore config read failures
    }
    try {
      const result = filterProviderList(
        unwrap(await globalSDK.client.provider.list()),
        disabledProviders,
      );
      setField("provider", result);
    } catch {
      const fallback = unwrap(
        await globalSDK.client.config.providers(),
      ) as ConfigProvidersResponse;
      setField(
        "provider",
        filterProviderList(
          {
            all: mapConfigProvidersToList(fallback.providers),
            connected: [],
            default: fallback.default,
          },
          disabledProviders,
        ),
      );
    }
  }, [globalSDK.client, setField]);

  const refreshProviderAuth = useCallback(async () => {
    try {
      const result = await globalSDK.client.provider.auth();
      setField("providerAuth", result.data ?? {});
    } catch {
      setField("providerAuth", {});
    }
  }, [globalSDK.client, setField]);

  const refreshMcp = useCallback(
    async (directory?: string) => {
      const result = unwrap(
        await globalSDK.client.mcp.status({ directory }),
      ) as McpStatusMap;
      setState((previous) => ({
        ...previous,
        mcp: { ...previous.mcp, [keyFor(directory ?? "")]: result },
      }));
    },
    [globalSDK.client],
  );

  const refreshLsp = useCallback(
    async (directory?: string) => {
      const result = unwrap(
        await globalSDK.client.lsp.status({ directory }),
      ) as LspStatus[];
      setState((previous) => ({
        ...previous,
        lsp: { ...previous.lsp, [keyFor(directory ?? "")]: result },
      }));
    },
    [globalSDK.client],
  );

  const refreshVcs = useCallback(
    async (directory: string) => {
      try {
        const result = unwrap(
          await globalSDK.client.vcs.get({ directory }),
        ) as VcsInfo;
        setState((previous) => ({
          ...previous,
          vcs: { ...previous.vcs, [keyFor(directory)]: result ?? null },
        }));
      } catch {
        setState((previous) => ({
          ...previous,
          vcs: { ...previous.vcs, [keyFor(directory)]: null },
        }));
      }
    },
    [globalSDK.client],
  );

  const refreshProjects = useCallback(async () => {
    const projects = unwrap(
      await globalSDK.client.project.list(),
    ) as Project[];
    setField("project", projects);
    setProjectMetaForProjects(projects);
    await Promise.allSettled(
      projects
        .map((project) => project.worktree)
        .filter(
          (worktree): worktree is string =>
            typeof worktree === "string" && worktree.length > 0,
        )
        .map((worktree) => refreshVcs(worktree)),
    );
  }, [globalSDK.client, refreshVcs, setField, setProjectMetaForProjects]);

  const refreshDirectory = useCallback(
    async (directory: string) => {
      if (!directory) return;
      await Promise.allSettled([
        refreshMcp(directory),
        refreshLsp(directory),
        refreshVcs(directory),
      ]);
    },
    [refreshLsp, refreshMcp, refreshVcs],
  );

  const refresh = useCallback(async () => {
    setState((previous) => ({ ...previous, ready: false, error: undefined }));
    try {
      const health = unwrap(
        await globalSDK.client.global.health(),
      ) as GlobalHealthResponse;
      if (!health?.healthy) {
        setField("error", "Server reported unhealthy status.");
        return;
      }
      const previousVersion = latestStateRef.current.serverVersion;
      if (previousVersion && health.version !== previousVersion) {
        setState((previous) => ({
          ...previous,
          mcp: {},
          lsp: {},
          project: [],
          projectMeta: {},
          vcs: {},
        }));
      }
      setField("serverVersion", health.version);
    } catch (error) {
      setError(error);
      return;
    }

    const results = await Promise.allSettled([
      refreshConfig(),
      refreshProviders(),
      refreshProviderAuth(),
      refreshMcp(),
      refreshLsp(),
      refreshProjects(),
    ]);

    for (const result of results) {
      if (result.status === "rejected") {
        setError(result.reason);
      }
    }

    setField("ready", true);
  }, [
    globalSDK.client,
    refreshConfig,
    refreshLsp,
    refreshMcp,
    refreshProjects,
    refreshProviderAuth,
    refreshProviders,
    setError,
    setField,
  ]);

  useEffect(() => {
    if (!globalSDK.url) return;
    void refresh();
  }, [globalSDK.url, refresh]);

  // Listen for directory-scoped change events and refresh the matching slices.
  useEffect(() => {
    const globalKey = keyFor("");
    if (subscriptionsRef.current.has(globalKey)) return;
    const unsubscribe = globalSDK.event.on(globalKey, (payload: Event) => {
      if (payload.type === "lsp.updated") void refreshLsp();
      if (payload.type === "mcp.tools.changed") void refreshMcp();
    });
    subscriptionsRef.current.set(globalKey, unsubscribe);
    return () => {
      subscriptionsRef.current.delete(globalKey);
      unsubscribe();
    };
  }, [globalSDK.event, refreshLsp, refreshMcp]);

  const getWorkspace = useCallback((directory: string) => {
    const key = keyFor(directory);
    const existing = workspacesRef.current.get(key);
    if (existing) return existing;
    const next = createWorkspaceState();
    workspacesRef.current.set(key, next);
    void refreshDirectory(directory);
    if (!subscriptionsRef.current.has(key)) {
      const unsubscribe = globalSDK.event.on(key, (payload: Event) => {
        if (payload.type === "lsp.updated") void refreshLsp(directory);
        if (payload.type === "mcp.tools.changed") void refreshMcp(directory);
      });
      subscriptionsRef.current.set(key, unsubscribe);
    }
    return next;
  }, [globalSDK.event, refreshDirectory, refreshLsp, refreshMcp]);

  const setWorkspace = useCallback(
    (
      directory: string,
      updater: (previous: WorkspaceState) => WorkspaceState,
    ) => {
      const key = keyFor(directory);
      const current =
        workspacesRef.current.get(key) ?? createWorkspaceState();
      const next = updater(current);
      workspacesRef.current.set(key, next);
    },
    [],
  );

  const value = useMemo<GlobalSyncContextValue>(
    () => ({
      data: state,
      setData: (updater) => setState(updater),
      refresh,
      refreshDirectory,
      getWorkspace,
      setWorkspace,
    }),
    [getWorkspace, refresh, refreshDirectory, setWorkspace, state],
  );

  return (
    <GlobalSyncContext.Provider value={value}>
      {children}
    </GlobalSyncContext.Provider>
  );
}

export function useGlobalSync(): GlobalSyncContextValue {
  const context = useContext(GlobalSyncContext);
  if (!context) {
    throw new Error("Global sync context is missing");
  }
  return context;
}
