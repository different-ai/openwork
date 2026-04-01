"use client";

import type {
  Message,
  Part,
  PermissionRequest as ApiPermissionRequest,
  ProviderListResponse,
  QuestionRequest,
  Session,
} from "@opencode-ai/sdk/v2/client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ensureRecord,
  mergeAuthorizedFoldersIntoExternalDirectory,
  normalizeAuthorizedFolderPath,
  readAuthorizedFoldersFromConfig,
  type LabCapabilities,
  type LabConfigSnapshot,
  type LabConnectionStateResponse,
  type LabStatusSnapshot,
  type LabWorkspaceSummary,
  workspaceLabel,
} from "../../../lib/openwork-lab-shared";
import { createLabOpencodeClient, unwrap } from "../_lib/opencode-client";

export type MessageWithParts = {
  info: Message;
  parts: Part[];
};

export type LabModelOption = {
  providerID: string;
  modelID: string;
  label: string;
};

type LabContextValue = {
  booting: boolean;
  connection: LabConnectionStateResponse | null;
  connectionError: string | null;
  selectedWorkspace: LabWorkspaceSummary | null;
  workspaceName: string;
  workspaceRoot: string;
  status: LabStatusSnapshot | null;
  capabilities: LabCapabilities | null;
  sessions: Session[];
  sessionsLoading: boolean;
  selectedSessionId: string | null;
  selectedSession: Session | null;
  selectedMessages: MessageWithParts[];
  selectedTodos: unknown[];
  searchQuery: string;
  setSearchQuery: (value: string) => void;
  matchingMessageIds: Set<string>;
  prompt: string;
  setPrompt: (value: string) => void;
  sending: boolean;
  createSession: () => Promise<string | null>;
  selectSession: (sessionId: string) => Promise<void>;
  loadEarlierMessages: () => Promise<void>;
  hasEarlierMessages: boolean;
  sendPrompt: () => Promise<void>;
  providers: ProviderListResponse["all"];
  modelOptions: LabModelOption[];
  selectedModelKey: string;
  setSelectedModelKey: (value: string) => void;
  pendingPermissions: ApiPermissionRequest[];
  pendingQuestions: QuestionRequest[];
  replyPermission: (requestId: string, reply: "once" | "always" | "reject") => Promise<void>;
  replyQuestion: (requestId: string, answers: string[][]) => Promise<void>;
  rejectQuestion: (requestId: string) => Promise<void>;
  filePath: string;
  setFilePath: (value: string) => void;
  fileContent: string;
  setFileContent: (value: string) => void;
  fileLoading: boolean;
  fileSaving: boolean;
  fileStatus: string | null;
  fileError: string | null;
  loadFile: (path?: string) => Promise<void>;
  saveFile: () => Promise<void>;
  config: LabConfigSnapshot | null;
  configLoading: boolean;
  configError: string | null;
  reloadEngine: () => Promise<void>;
  reloadBusy: boolean;
  reloadStatus: string | null;
  authorizedFolders: string[];
  authorizedFolderDraft: string;
  setAuthorizedFolderDraft: (value: string) => void;
  addAuthorizedFolder: () => Promise<void>;
  removeAuthorizedFolder: (folder: string) => Promise<void>;
  refreshAll: () => Promise<void>;
  disconnect: () => Promise<void>;
};

const LabContext = createContext<LabContextValue | undefined>(undefined);

function sortSessions(sessions: Session[]) {
  return [...sessions].sort((left, right) => {
    const leftUpdated = left.time?.updated ?? left.time?.created ?? 0;
    const rightUpdated = right.time?.updated ?? right.time?.created ?? 0;
    return rightUpdated - leftUpdated;
  });
}

function summarizeWorkspaceRoot(workspace: LabWorkspaceSummary | null | undefined) {
  return (
    workspace?.opencode?.directory?.trim() ||
    workspace?.directory?.trim() ||
    workspace?.path?.trim() ||
    ""
  );
}

function buildOptimisticSession(workspaceRoot: string) {
  const now = Date.now();
  return {
    id: `local-${now}`,
    title: "Starting new session…",
    directory: workspaceRoot || undefined,
    time: {
      created: now,
      updated: now,
    },
  } as unknown as Session;
}

function extractErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : JSON.stringify(error);
}

function buildModelOptions(providers: ProviderListResponse["all"]) {
  const options: LabModelOption[] = [];
  for (const provider of providers ?? []) {
    for (const model of Object.values(provider.models ?? {})) {
      if ((model as { status?: string }).status === "deprecated") continue;
      const modelId = String((model as { id?: string }).id ?? "").trim();
      if (!modelId) continue;
      options.push({
        providerID: provider.id,
        modelID: modelId,
        label: `${provider.name?.trim() || provider.id} / ${(model as { name?: string }).name?.trim() || modelId}`,
      });
    }
  }
  return options;
}

async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      ...(init?.body ? { "content-type": "application/json" } : {}),
    },
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(payload?.error || `Request failed (${response.status})`);
  }
  return payload as T;
}

export function LabProvider({
  children,
  initialState,
}: {
  children: React.ReactNode;
  initialState: LabConnectionStateResponse | null;
}) {
  const [booting, setBooting] = useState(!initialState);
  const [connection, setConnection] = useState<LabConnectionStateResponse | null>(initialState);
  const [connectionError, setConnectionError] = useState<string | null>(initialState?.error ?? null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [messagesBySession, setMessagesBySession] = useState<Record<string, MessageWithParts[]>>({});
  const [todosBySession, setTodosBySession] = useState<Record<string, unknown[]>>({});
  const [messageLimitBySession, setMessageLimitBySession] = useState<Record<string, number>>({});
  const [messageCompleteBySession, setMessageCompleteBySession] = useState<Record<string, boolean>>({});
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [providers, setProviders] = useState<ProviderListResponse["all"]>([]);
  const [selectedModelKey, setSelectedModelKey] = useState("");
  const [pendingPermissions, setPendingPermissions] = useState<ApiPermissionRequest[]>([]);
  const [pendingQuestions, setPendingQuestions] = useState<QuestionRequest[]>([]);
  const [filePath, setFilePath] = useState("README.md");
  const [fileContent, setFileContent] = useState("");
  const [fileLoading, setFileLoading] = useState(false);
  const [fileSaving, setFileSaving] = useState(false);
  const [fileStatus, setFileStatus] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileBaseUpdatedAt, setFileBaseUpdatedAt] = useState<number | null>(null);
  const [config, setConfig] = useState<LabConfigSnapshot | null>(null);
  const [configLoading, setConfigLoading] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [reloadBusy, setReloadBusy] = useState(false);
  const [reloadStatus, setReloadStatus] = useState<string | null>(null);
  const [authorizedFolders, setAuthorizedFolders] = useState<string[]>([]);
  const [authorizedFolderDraft, setAuthorizedFolderDraft] = useState("");

  const selectedSessionIdRef = useRef<string | null>(null);
  const refreshTimerRef = useRef<number | null>(null);
  const refreshProvidersRef = useRef<() => Promise<void>>(async () => undefined);
  const refreshSessionsRef = useRef<() => Promise<void>>(async () => undefined);
  const refreshPermissionsRef = useRef<() => Promise<void>>(async () => undefined);
  const refreshQuestionsRef = useRef<() => Promise<void>>(async () => undefined);
  const refreshConfigRef = useRef<() => Promise<void>>(async () => undefined);
  const refreshSessionRef = useRef<(sessionId: string, limit?: number) => Promise<void>>(async () => undefined);

  useEffect(() => {
    selectedSessionIdRef.current = selectedSessionId;
  }, [selectedSessionId]);

  const selectedWorkspace = useMemo(() => connection?.selectedWorkspace ?? null, [connection]);
  const workspaceName = useMemo(() => workspaceLabel(selectedWorkspace), [selectedWorkspace]);
  const workspaceRoot = useMemo(() => summarizeWorkspaceRoot(selectedWorkspace), [selectedWorkspace]);
  const status = useMemo(() => connection?.status ?? null, [connection]);
  const capabilities = useMemo(() => connection?.capabilities ?? null, [connection]);
  const workspaceId = connection?.connection?.workspaceId ?? selectedWorkspace?.id ?? null;
  const opencodeBaseUrl = selectedWorkspace?.opencode?.baseUrl?.trim() || selectedWorkspace?.baseUrl?.trim() || null;
  const opencodeClient = useMemo(
    () =>
      opencodeBaseUrl
        ? createLabOpencodeClient(opencodeBaseUrl, {
            username: selectedWorkspace?.opencode?.username,
            password: selectedWorkspace?.opencode?.password,
          })
        : null,
    [opencodeBaseUrl, selectedWorkspace?.opencode?.password, selectedWorkspace?.opencode?.username],
  );

  const openworkFetchJson = useCallback(
    async <T,>(path: string, init?: RequestInit) => {
      return fetchJson<T>(`/api/openwork${path}`, init);
    },
    [],
  );

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId) ?? null,
    [selectedSessionId, sessions],
  );

  const selectedMessages = useMemo(
    () => (selectedSessionId ? messagesBySession[selectedSessionId] ?? [] : []),
    [messagesBySession, selectedSessionId],
  );
  const selectedTodos = useMemo(
    () => (selectedSessionId ? todosBySession[selectedSessionId] ?? [] : []),
    [selectedSessionId, todosBySession],
  );

  const modelOptions = useMemo(() => buildModelOptions(providers), [providers]);
  const selectedModel = useMemo(() => {
    if (!selectedModelKey) return null;
    const [providerID, modelID] = selectedModelKey.split("/");
    if (!providerID || !modelID) return null;
    return { providerID, modelID };
  }, [selectedModelKey]);

  const matchingMessageIds = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return new Set<string>();

    const out = new Set<string>();
    for (const message of selectedMessages) {
      const id = message.info.id;
      const haystack = [
        JSON.stringify(message.info),
        ...message.parts.map((part) => JSON.stringify(part)),
      ]
        .join("\n")
        .toLowerCase();
      if (haystack.includes(query)) out.add(id);
    }
    return out;
  }, [searchQuery, selectedMessages]);

  const refreshConnection = useCallback(async () => {
    const next = await fetchJson<LabConnectionStateResponse>("/api/lab/connection");
    setConnection(next);
    setConnectionError(next.error ?? null);
    if (!next.connected) {
      setSessions([]);
      setSelectedSessionId(null);
      setMessagesBySession({});
      setTodosBySession({});
      setProviders([]);
      setPendingPermissions([]);
      setPendingQuestions([]);
      setConfig(null);
      setAuthorizedFolders([]);
    }
    return next;
  }, []);

  const refreshProviders = useCallback(async () => {
    if (!opencodeClient) return;
    try {
      const providerList = unwrap(await opencodeClient.provider.list());
      setProviders(providerList.all ?? []);
      const options = buildModelOptions(providerList.all ?? []);
      if (!options.length) {
        setSelectedModelKey("");
        return;
      }

      if (!selectedModelKey || !options.some((option) => `${option.providerID}/${option.modelID}` === selectedModelKey)) {
        const defaults = providerList.default ?? {};
        const preferred = options.find((option) => defaults[option.providerID] === option.modelID) ?? options[0];
        setSelectedModelKey(`${preferred.providerID}/${preferred.modelID}`);
      }
    } catch {
      // leave provider UI soft-failing for the lab app
    }
  }, [opencodeClient, selectedModelKey]);

  useEffect(() => {
    refreshProvidersRef.current = refreshProviders;
  }, [refreshProviders]);

  const refreshPermissions = useCallback(async () => {
    if (!opencodeClient) return;
    try {
      setPendingPermissions(unwrap(await opencodeClient.permission.list()) ?? []);
    } catch {
      setPendingPermissions([]);
    }
  }, [opencodeClient]);

  useEffect(() => {
    refreshPermissionsRef.current = refreshPermissions;
  }, [refreshPermissions]);

  const refreshQuestions = useCallback(async () => {
    if (!opencodeClient) return;
    try {
      setPendingQuestions(unwrap(await opencodeClient.question.list()) ?? []);
    } catch {
      setPendingQuestions([]);
    }
  }, [opencodeClient]);

  useEffect(() => {
    refreshQuestionsRef.current = refreshQuestions;
  }, [refreshQuestions]);

  const refreshSession = useCallback(
    async (sessionId: string, limit = messageLimitBySession[sessionId] ?? 140) => {
      if (!opencodeClient || !sessionId) return;

      const [sessionInfo, messages, todos] = await Promise.all([
        opencodeClient.session.get({ sessionID: sessionId }),
        opencodeClient.session.messages({ sessionID: sessionId, limit }),
        opencodeClient.session.todo({ sessionID: sessionId }).catch(() => ({ data: [] })),
      ]);

      const nextSession = unwrap(sessionInfo);
      const nextMessages = unwrap(messages);
      const nextTodos = unwrap(todos as { data: unknown[] });

      setSessions((current) => sortSessions(current.some((item) => item.id === nextSession.id)
        ? current.map((item) => (item.id === nextSession.id ? nextSession : item))
        : [nextSession, ...current]));
      setMessagesBySession((current) => ({ ...current, [sessionId]: nextMessages }));
      setTodosBySession((current) => ({ ...current, [sessionId]: nextTodos ?? [] }));
      setMessageLimitBySession((current) => ({ ...current, [sessionId]: limit }));
      setMessageCompleteBySession((current) => ({ ...current, [sessionId]: nextMessages.length < limit }));
    },
    [messageLimitBySession, opencodeClient],
  );

  useEffect(() => {
    refreshSessionRef.current = refreshSession;
  }, [refreshSession]);

  const refreshSessions = useCallback(async () => {
    if (!opencodeClient) return;
    setSessionsLoading(true);
    try {
      const nextSessions = sortSessions(
        unwrap(
          await opencodeClient.session.list({
            directory: workspaceRoot || undefined,
            roots: true,
          }),
        ),
      );
      setSessions(nextSessions);
      setSelectedSessionId((current) => {
        if (current && nextSessions.some((session) => session.id === current)) return current;
        return nextSessions[0]?.id ?? null;
      });
    } finally {
      setSessionsLoading(false);
    }
  }, [opencodeClient, workspaceRoot]);

  useEffect(() => {
    refreshSessionsRef.current = refreshSessions;
  }, [refreshSessions]);

  const refreshConfig = useCallback(async () => {
    if (!workspaceId || capabilities?.config?.read === false) return;
      setConfigLoading(true);
      setConfigError(null);
      try {
      const next = await openworkFetchJson<LabConfigSnapshot>(`/workspace/${encodeURIComponent(workspaceId)}/config`);
      setConfig(next);
      const folders = readAuthorizedFoldersFromConfig(ensureRecord(next.opencode)).folders;
      setAuthorizedFolders(folders);
    } catch (error) {
      setConfigError(extractErrorMessage(error));
    } finally {
      setConfigLoading(false);
    }
  }, [capabilities?.config?.read, openworkFetchJson, workspaceId]);

  useEffect(() => {
    refreshConfigRef.current = refreshConfig;
  }, [refreshConfig]);

  const loadFile = useCallback(
    async (pathOverride?: string) => {
      if (!workspaceId) return;
      const targetPath = (pathOverride ?? filePath).trim() || "README.md";
      setFileLoading(true);
      setFileError(null);
      try {
        const next = await fetchJson<{ path: string; content: string; updatedAt: number }>(
          `/api/openwork/workspace/${encodeURIComponent(workspaceId)}/files/content?path=${encodeURIComponent(targetPath)}`,
        );
        setFilePath(next.path || targetPath);
        setFileContent(next.content ?? "");
        setFileBaseUpdatedAt(next.updatedAt ?? null);
        setFileStatus(`Loaded ${next.path}.`);
      } catch (error) {
        setFileError(extractErrorMessage(error));
      } finally {
        setFileLoading(false);
      }
    },
    [filePath, workspaceId],
  );

  const saveFile = useCallback(async () => {
    if (!workspaceId) return;
    setFileSaving(true);
    setFileError(null);
    try {
      const next = await openworkFetchJson<{ updatedAt?: number | null }>(
        `/workspace/${encodeURIComponent(workspaceId)}/files/content`,
        {
          method: "POST",
          body: JSON.stringify({
            path: filePath.trim() || "README.md",
            content: fileContent,
            baseUpdatedAt: fileBaseUpdatedAt,
          }),
        },
      );
      setFileBaseUpdatedAt(next.updatedAt ?? Date.now());
      setFileStatus(`Saved ${filePath.trim() || "README.md"}.`);
      await refreshConfig();
    } catch (error) {
      setFileError(extractErrorMessage(error));
    } finally {
      setFileSaving(false);
    }
  }, [fileBaseUpdatedAt, fileContent, filePath, openworkFetchJson, refreshConfig, workspaceId]);

  const createSession = useCallback(async () => {
    if (!opencodeClient) return null;
    const optimistic = buildOptimisticSession(workspaceRoot);
    setSessions((current) => sortSessions([optimistic, ...current.filter((item) => item.id !== optimistic.id)]));
    setSelectedSessionId(optimistic.id);
    try {
      const nextSession = unwrap(
        await opencodeClient.session.create({
          directory: workspaceRoot || undefined,
        }),
      );
      setSessions((current) =>
        sortSessions(
          [nextSession, ...current.filter((item) => item.id !== nextSession.id && item.id !== optimistic.id)],
        ),
      );
      setSelectedSessionId(nextSession.id);
      await refreshSession(nextSession.id);
      return nextSession.id;
    } catch (error) {
      setSessions((current) => current.filter((item) => item.id !== optimistic.id));
      setSelectedSessionId((current) => (current === optimistic.id ? null : current));
      throw error;
    }
  }, [opencodeClient, refreshSession, workspaceRoot]);

  const selectSession = useCallback(
    async (sessionId: string) => {
      setSelectedSessionId(sessionId);
      if (messagesBySession[sessionId]?.length) {
        void Promise.all([
          refreshSession(sessionId),
          refreshPermissions(),
          refreshQuestions(),
        ]);
        return;
      }
      await refreshSession(sessionId);
      await Promise.all([refreshPermissions(), refreshQuestions()]);
    },
    [messagesBySession, refreshPermissions, refreshQuestions, refreshSession],
  );

  const loadEarlierMessages = useCallback(async () => {
    if (!selectedSessionId) return;
    const currentLimit = messageLimitBySession[selectedSessionId] ?? 140;
    await refreshSession(selectedSessionId, currentLimit + 120);
  }, [messageLimitBySession, refreshSession, selectedSessionId]);

  const sendPrompt = useCallback(async () => {
    if (!opencodeClient) return;
    const content = prompt.trim();
    if (!content) return;
    setSending(true);
    setConnectionError(null);

    try {
      let sessionId = selectedSessionId;
      if (!sessionId) {
        sessionId = await createSession();
      }
      if (!sessionId) return;

      unwrap(
        await opencodeClient.session.promptAsync({
          sessionID: sessionId,
          model: selectedModel ?? undefined,
          parts: [{ type: "text", text: content }] as any,
        }),
      );
      setPrompt("");
      await Promise.all([refreshSession(sessionId), refreshSessions()]);
    } catch (error) {
      setConnectionError(extractErrorMessage(error));
    } finally {
      setSending(false);
    }
  }, [createSession, opencodeClient, prompt, refreshSession, refreshSessions, selectedModel, selectedSessionId]);

  const replyPermission = useCallback(
    async (requestId: string, reply: "once" | "always" | "reject") => {
      if (!opencodeClient) return;
      unwrap(await opencodeClient.permission.reply({ requestID: requestId, reply }));
      await refreshPermissions();
    },
    [opencodeClient, refreshPermissions],
  );

  const replyQuestion = useCallback(
    async (requestId: string, answers: string[][]) => {
      if (!opencodeClient) return;
      unwrap(await opencodeClient.question.reply({ requestID: requestId, answers }));
      await refreshQuestions();
    },
    [opencodeClient, refreshQuestions],
  );

  const rejectQuestion = useCallback(
    async (requestId: string) => {
      if (!opencodeClient) return;
      unwrap(await opencodeClient.question.reject({ requestID: requestId }));
      await refreshQuestions();
    },
    [opencodeClient, refreshQuestions],
  );

  const persistAuthorizedFolders = useCallback(
    async (nextFolders: string[]) => {
      if (!workspaceId || !config) return;

      const currentAuthorizedFolders = readAuthorizedFoldersFromConfig(ensureRecord(config.opencode));
      await openworkFetchJson(`/workspace/${encodeURIComponent(workspaceId)}/config`, {
        method: "PATCH",
        body: JSON.stringify({
          opencode: {
            permission: {
              external_directory: mergeAuthorizedFoldersIntoExternalDirectory(
                nextFolders,
                currentAuthorizedFolders.hiddenEntries,
              ),
            },
          },
        }),
      });
      setAuthorizedFolders(nextFolders);
      await refreshConfig();
    },
    [config, openworkFetchJson, refreshConfig, workspaceId],
  );

  const addAuthorizedFolder = useCallback(async () => {
    const normalized = normalizeAuthorizedFolderPath(authorizedFolderDraft);
    if (!normalized || authorizedFolders.includes(normalized)) return;
    setAuthorizedFolderDraft("");
    await persistAuthorizedFolders([...authorizedFolders, normalized]);
  }, [authorizedFolderDraft, authorizedFolders, persistAuthorizedFolders]);

  const removeAuthorizedFolder = useCallback(
    async (folder: string) => {
      await persistAuthorizedFolders(authorizedFolders.filter((item) => item !== folder));
    },
    [authorizedFolders, persistAuthorizedFolders],
  );

  const reloadEngine = useCallback(async () => {
    if (!workspaceId) return;
    setReloadBusy(true);
    setReloadStatus(null);
    try {
      await openworkFetchJson(`/workspace/${encodeURIComponent(workspaceId)}/engine/reload`, {
        method: "POST",
      });
      setReloadStatus("Reloaded the workspace engine.");
      await Promise.all([refreshConnection(), refreshSessions()]);
    } catch (error) {
      setReloadStatus(extractErrorMessage(error));
    } finally {
      setReloadBusy(false);
    }
  }, [openworkFetchJson, refreshConnection, refreshSessions, workspaceId]);

  const refreshAll = useCallback(async () => {
    const nextConnection = await refreshConnection();
    if (!nextConnection.connected) return;
    await Promise.all([refreshProviders(), refreshSessions(), refreshPermissions(), refreshQuestions(), refreshConfig()]);
    if (selectedSessionIdRef.current) {
      await refreshSession(selectedSessionIdRef.current);
    }
  }, [refreshConfig, refreshConnection, refreshPermissions, refreshProviders, refreshQuestions, refreshSession, refreshSessions]);

  const disconnect = useCallback(async () => {
    await fetchJson("/api/lab/connection", { method: "DELETE" });
    setConnection(null);
    setSessions([]);
    setSelectedSessionId(null);
    setMessagesBySession({});
    setTodosBySession({});
    setProviders([]);
    setPendingPermissions([]);
    setPendingQuestions([]);
    setConfig(null);
    setAuthorizedFolders([]);
    window.location.href = "/connect";
  }, []);

  useEffect(() => {
    void refreshConnection().finally(() => setBooting(false));
  }, [refreshConnection]);

  useEffect(() => {
    if (!connection?.connected || !opencodeBaseUrl) return;
    void Promise.all([
      refreshProvidersRef.current(),
      refreshSessionsRef.current(),
      refreshPermissionsRef.current(),
      refreshQuestionsRef.current(),
      refreshConfigRef.current(),
    ]);
  }, [connection?.connected, opencodeBaseUrl]);

  useEffect(() => {
    if (!selectedSessionId) return;
    if (messagesBySession[selectedSessionId]?.length) return;
    void refreshSessionRef.current(selectedSessionId);
  }, [messagesBySession, selectedSessionId]);

  useEffect(() => {
    if (!workspaceId) return;
    void loadFile("README.md");
  }, [loadFile, workspaceId]);

  useEffect(() => {
    if (!opencodeClient || !workspaceId) return;

    const intervalId = window.setInterval(() => {
      void Promise.all([
        refreshSessionsRef.current(),
        refreshPermissionsRef.current(),
        refreshQuestionsRef.current(),
        selectedSessionIdRef.current ? refreshSessionRef.current(selectedSessionIdRef.current) : Promise.resolve(),
      ]);
    }, 2500);

    return () => {
      window.clearInterval(intervalId);
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [opencodeClient, workspaceId]);

  const value = useMemo<LabContextValue>(
    () => ({
      booting,
      connection,
      connectionError,
      selectedWorkspace,
      workspaceName,
      workspaceRoot,
      status,
      capabilities,
      sessions,
      sessionsLoading,
      selectedSessionId,
      selectedSession,
      selectedMessages,
      selectedTodos,
      searchQuery,
      setSearchQuery,
      matchingMessageIds,
      prompt,
      setPrompt,
      sending,
      createSession,
      selectSession,
      loadEarlierMessages,
      hasEarlierMessages: selectedSessionId ? !(messageCompleteBySession[selectedSessionId] ?? false) : false,
      sendPrompt,
      providers,
      modelOptions,
      selectedModelKey,
      setSelectedModelKey,
      pendingPermissions,
      pendingQuestions,
      replyPermission,
      replyQuestion,
      rejectQuestion,
      filePath,
      setFilePath,
      fileContent,
      setFileContent,
      fileLoading,
      fileSaving,
      fileStatus,
      fileError,
      loadFile,
      saveFile,
      config,
      configLoading,
      configError,
      reloadEngine,
      reloadBusy,
      reloadStatus,
      authorizedFolders,
      authorizedFolderDraft,
      setAuthorizedFolderDraft,
      addAuthorizedFolder,
      removeAuthorizedFolder,
      refreshAll,
      disconnect,
    }),
    [
      addAuthorizedFolder,
      authorizedFolderDraft,
      authorizedFolders,
      booting,
      capabilities,
      config,
      configError,
      configLoading,
      connection,
      connectionError,
      createSession,
      disconnect,
      fileContent,
      fileError,
      fileLoading,
      filePath,
      fileSaving,
      fileStatus,
      loadEarlierMessages,
      loadFile,
      matchingMessageIds,
      messageCompleteBySession,
      modelOptions,
      pendingPermissions,
      pendingQuestions,
      prompt,
      providers,
      refreshAll,
      reloadBusy,
      reloadEngine,
      reloadStatus,
      removeAuthorizedFolder,
      replyPermission,
      replyQuestion,
      saveFile,
      searchQuery,
      selectedMessages,
      selectedModelKey,
      selectedSession,
      selectedSessionId,
      selectedTodos,
      selectedWorkspace,
      sending,
      sessions,
      sessionsLoading,
      setAuthorizedFolderDraft,
      setPrompt,
      setSearchQuery,
      setSelectedModelKey,
      setFileContent,
      setFilePath,
      selectSession,
      status,
      workspaceName,
      workspaceRoot,
      rejectQuestion,
      sendPrompt,
    ],
  );

  return <LabContext.Provider value={value}>{children}</LabContext.Provider>;
}

export function useLab() {
  const context = useContext(LabContext);
  if (!context) {
    throw new Error("useLab must be used inside LabProvider");
  }
  return context;
}
