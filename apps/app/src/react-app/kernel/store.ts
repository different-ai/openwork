import { create } from "zustand";

import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client";

import type {
  MessageInfo,
  MessageWithParts,
  PendingPermission,
  PendingQuestion,
  TodoItem,
} from "../../app/types";
import {
  buildOpenworkWorkspaceBaseUrl,
  createOpenworkServerClient,
  hydrateOpenworkServerSettingsFromEnv,
  normalizeOpenworkServerUrl,
  readOpenworkConnectInviteFromSearch,
  readOpenworkServerSettings,
  stripOpenworkConnectInviteFromUrl,
  writeOpenworkServerSettings,
  type OpenworkServerCapabilities,
  type OpenworkServerDiagnostics,
  type OpenworkWorkspaceInfo,
} from "../../app/lib/openwork-server";
import { createClient, unwrap } from "../../app/lib/opencode";
import { abortSession as abortSessionInClient } from "../../app/lib/opencode-session";
import { resolveScopedClientDirectory } from "../../app/lib/session-scope";
import {
  normalizeEvent,
  normalizeSessionStatus,
  normalizeDirectoryPath,
  safeStringify,
} from "../../app/utils";

type ServerState = {
  url: string;
  token: string;
  status: "idle" | "connecting" | "connected" | "error";
  error: string | null;
  version: string | null;
  capabilities: OpenworkServerCapabilities | null;
  diagnostics: OpenworkServerDiagnostics | null;
};

type WorkspaceStatus = "idle" | "loading" | "ready" | "error";

type SessionLoadStatus = "idle" | "loading" | "ready" | "error";

export type WorkerProfile = {
  id: string;
  displayName: string;
  hostUrl: string;
  token: string;
  workspaceId?: string | null;
  workspaceName?: string | null;
  directory?: string | null;
  source: "manual" | "cloud";
};

type OpenworkStore = {
  bootstrapping: boolean;
  server: ServerState;
  workerProfiles: WorkerProfile[];
  activeWorkerProfileId: string | null;
  workspaces: OpenworkWorkspaceInfo[];
  workspacesStatus: WorkspaceStatus;
  sessions: Session[];
  sessionsStatus: SessionLoadStatus;
  activeWorkspaceId: string | null;
  selectedSessionId: string | null;
  messagesBySessionId: Record<string, MessageWithParts[]>;
  todosBySessionId: Record<string, TodoItem[]>;
  messageLimitBySessionId: Record<string, number>;
  sessionCompleteById: Record<string, boolean>;
  loadingMoreBySessionId: Record<string, boolean>;
  sessionStatusById: Record<string, string>;
  pendingPermissions: PendingPermission[];
  pendingQuestions: PendingQuestion[];
  connectedToEvents: boolean;
  sending: boolean;
  errorBanner: string | null;
  logs: string[];
  bootstrap: () => Promise<void>;
  connectToServer: (input: { url: string; token?: string }) => Promise<void>;
  connectRemoteWorkspace: (input: {
    openworkHostUrl: string;
    openworkToken: string;
    directory?: string | null;
    displayName?: string | null;
    workspaceId?: string | null;
    source?: WorkerProfile["source"];
  }) => Promise<boolean>;
  connectWorkerProfile: (profileId: string) => Promise<boolean>;
  removeWorkerProfile: (profileId: string) => void;
  refreshServer: () => Promise<void>;
  selectWorkspace: (workspaceId: string, options?: { skipActivation?: boolean }) => Promise<void>;
  refreshSessions: (workspaceId?: string | null) => Promise<void>;
  selectSession: (sessionId: string | null) => Promise<void>;
  ensureSessionLoaded: (sessionId: string) => Promise<void>;
  createSession: (initialPrompt?: string) => Promise<string | null>;
  sendPrompt: (prompt: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  abortSession: (sessionId?: string | null) => Promise<void>;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  loadEarlierMessages: (sessionId: string) => Promise<void>;
  replyPermission: (requestId: string, reply: "once" | "always" | "reject") => Promise<void>;
  replyQuestion: (requestId: string, answers: string[][]) => Promise<void>;
  rejectQuestion: (requestId: string) => Promise<void>;
  clearErrorBanner: () => void;
};

const ACTIVE_WORKSPACE_KEY = "openwork.react.activeWorkspace";
const SESSION_BY_WORKSPACE_KEY = "openwork.react.sessionByWorkspace";
const WORKER_PROFILES_KEY = "openwork.react.workerProfiles";

let eventAbortController: AbortController | null = null;
const EMPTY_MESSAGES: MessageWithParts[] = [];
const EMPTY_TODOS: TodoItem[] = [];
const EMPTY_PERMISSIONS: PendingPermission[] = [];

const readStoredWorkerProfiles = () => {
  if (typeof window === "undefined") return [] as WorkerProfile[];
  try {
    const raw = window.localStorage.getItem(WORKER_PROFILES_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(parsed)) return [] as WorkerProfile[];
    return parsed.filter((item): item is WorkerProfile => {
      if (!item || typeof item !== "object") return false;
      const record = item as Record<string, unknown>;
      return typeof record.id === "string" && typeof record.displayName === "string" && typeof record.hostUrl === "string" && typeof record.token === "string";
    });
  } catch {
    return [] as WorkerProfile[];
  }
};

const writeStoredWorkerProfiles = (profiles: WorkerProfile[]) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(WORKER_PROFILES_KEY, JSON.stringify(profiles));
  } catch {
    // ignore
  }
};

const now = () => Date.now();

const sessionActivity = (session: Session) => session.time?.updated ?? session.time?.created ?? 0;

const sortSessions = (sessions: Session[]) =>
  sessions.slice().sort((a, b) => {
    const delta = sessionActivity(b) - sessionActivity(a);
    if (delta !== 0) return delta;
    return a.id.localeCompare(b.id);
  });

const messageTime = (message: MessageWithParts) => message.info.time?.created ?? 0;

const messageIdFromInfo = (info: MessageInfo) => String((info as { id?: string }).id ?? "");

const sortMessages = (messages: MessageWithParts[]) =>
  messages.slice().sort((a, b) => {
    const delta = messageTime(a) - messageTime(b);
    if (delta !== 0) return delta;
    return messageIdFromInfo(a.info).localeCompare(messageIdFromInfo(b.info));
  });

const sortParts = (parts: Part[]) => parts.slice().sort((a, b) => a.id.localeCompare(b.id));

const readStoredActiveWorkspaceId = () => {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(ACTIVE_WORKSPACE_KEY) || null;
  } catch {
    return null;
  }
};

const writeStoredActiveWorkspaceId = (workspaceId: string | null) => {
  if (typeof window === "undefined") return;
  try {
    if (workspaceId) {
      window.localStorage.setItem(ACTIVE_WORKSPACE_KEY, workspaceId);
    } else {
      window.localStorage.removeItem(ACTIVE_WORKSPACE_KEY);
    }
  } catch {
    // ignore
  }
};

const readStoredSessionsByWorkspace = () => {
  if (typeof window === "undefined") return {} as Record<string, string>;
  try {
    const raw = window.localStorage.getItem(SESSION_BY_WORKSPACE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    if (!parsed || typeof parsed !== "object") return {} as Record<string, string>;
    return Object.entries(parsed as Record<string, unknown>).reduce<Record<string, string>>((acc, [key, value]) => {
      if (typeof value === "string" && value.trim()) {
        acc[key] = value;
      }
      return acc;
    }, {});
  } catch {
    return {} as Record<string, string>;
  }
};

const writeStoredSessionForWorkspace = (workspaceId: string, sessionId: string | null) => {
  if (typeof window === "undefined") return;
  try {
    const current = readStoredSessionsByWorkspace();
    if (sessionId) {
      current[workspaceId] = sessionId;
    } else {
      delete current[workspaceId];
    }
    window.localStorage.setItem(SESSION_BY_WORKSPACE_KEY, JSON.stringify(current));
  } catch {
    // ignore
  }
};

const normalizeWorkspaceItems = (payload: unknown): { items: OpenworkWorkspaceInfo[]; activeId: string | null } => {
  if (!payload || typeof payload !== "object") {
    return { items: [], activeId: null };
  }

  const record = payload as Record<string, unknown>;
  const rawItems = Array.isArray(record.items)
    ? record.items
    : Array.isArray(record.workspaces)
      ? record.workspaces
      : [];
  const items = rawItems.filter((item): item is OpenworkWorkspaceInfo => Boolean(item && typeof item === "object"));
  const activeId =
    typeof record.activeId === "string"
      ? record.activeId
      : typeof record.selectedId === "string"
        ? record.selectedId
        : null;
  return { items, activeId };
};

const resolveOpenworkHost = async (input: {
  hostUrl: string;
  token?: string | null;
  workspaceId?: string | null;
  directoryHint?: string | null;
}) => {
  let normalizedHostUrl = normalizeOpenworkServerUrl(input.hostUrl) ?? "";
  if (!normalizedHostUrl) {
    throw new Error("OpenWork host URL is required.");
  }

  let inferredWorkspaceId: string | null = null;
  try {
    const url = new URL(normalizedHostUrl);
    const segments = url.pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1] ?? "";
    const prev = segments[segments.length - 2] ?? "";
    if (prev === "w" && last) {
      inferredWorkspaceId = decodeURIComponent(last);
      const baseSegments = segments.slice(0, -2);
      url.pathname = `/${baseSegments.join("/")}`;
      normalizedHostUrl = url.toString().replace(/\/+$/, "");
    }
  } catch {
    // ignore
  }

  const trimmedToken = input.token?.trim() ?? "";
  if (!trimmedToken) {
    throw new Error("Access token required for OpenWork server.");
  }

  const requestedWorkspaceId = (input.workspaceId?.trim() || inferredWorkspaceId || "").trim();
  const workspaceBaseUrl = buildOpenworkWorkspaceBaseUrl(normalizedHostUrl, requestedWorkspaceId) ?? normalizedHostUrl;
  const client = createOpenworkServerClient({ baseUrl: workspaceBaseUrl, token: trimmedToken });

  const health = await client.health();
  if (!health?.ok) {
    throw new Error("OpenWork server unavailable. Check the URL and token.");
  }

  const response = await client.listWorkspaces();
  const items = Array.isArray(response.items) ? response.items : [];
  const hint = normalizeDirectoryPath(input.directoryHint ?? "");
  const workspaceById = requestedWorkspaceId ? items.find((item) => item.id === requestedWorkspaceId) : undefined;
  if (requestedWorkspaceId && !workspaceById) {
    throw new Error("OpenWork worker not found on that host.");
  }

  const workspaceByHint = hint
    ? items.find((item) => {
        const entryPath = normalizeDirectoryPath((item.opencode?.directory as string | undefined) ?? item.path ?? "");
        return Boolean(entryPath && entryPath === hint);
      })
    : undefined;

  const workspace = workspaceById ?? workspaceByHint ?? items[0];
  if (!workspace?.id) {
    throw new Error("OpenWork server did not return a worker.");
  }

  return {
    hostUrl: normalizedHostUrl,
    workspace,
    directory: workspace.opencode?.directory?.trim() ?? workspace.directory?.trim() ?? input.directoryHint?.trim() ?? "",
  };
};

const createPlaceholderMessage = (part: Part): MessageWithParts => ({
  info: {
    id: part.messageID,
    sessionID: part.sessionID,
    role: "assistant",
    time: { created: now() },
    parentID: "",
    modelID: "",
    providerID: "",
    mode: "",
    agent: "",
    path: { cwd: "", root: "" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  },
  parts: [part],
});

const upsertMessage = (messages: MessageWithParts[], info: MessageInfo) => {
  const id = messageIdFromInfo(info);
  const index = messages.findIndex((message) => messageIdFromInfo(message.info) === id);
  if (index === -1) {
    return sortMessages([...messages, { info, parts: [] }]);
  }
  const next = messages.slice();
  next[index] = { ...next[index], info };
  return sortMessages(next);
};

const upsertPart = (parts: Part[], nextPart: Part, delta?: string | null) => {
  const index = parts.findIndex((part) => part.id === nextPart.id);
  if (index === -1) {
    return sortParts([...parts, nextPart]);
  }

  const next = parts.slice();
  if (delta && nextPart.type === "text") {
    const current = next[index] as Part & { text?: string };
    if (typeof current.text === "string" && !current.text.endsWith(delta)) {
      next[index] = { ...current, text: `${current.text}${delta}` } as Part;
      return sortParts(next);
    }
  }
  next[index] = nextPart;
  return sortParts(next);
};

const upsertPartInMessages = (messages: MessageWithParts[], part: Part, delta?: string | null) => {
  const next = messages.slice();
  const index = next.findIndex((message) => messageIdFromInfo(message.info) === part.messageID);
  if (index === -1) {
    return sortMessages([...next, createPlaceholderMessage(part)]);
  }
  const existing = next[index];
  next[index] = { ...existing, parts: upsertPart(existing.parts, part, delta) };
  return sortMessages(next);
};

const appendPartDeltaInMessages = (
  messages: MessageWithParts[],
  messageId: string,
  partId: string,
  field: string,
  delta: string,
) => {
  return messages.map((message) => {
    if (messageIdFromInfo(message.info) !== messageId) return message;
    return {
      ...message,
      parts: message.parts.map((part) => {
        if (part.id !== partId) return part;
        const record = part as Part & Record<string, unknown>;
        const current = record[field];
        if (current !== undefined && typeof current !== "string") return part;
        return { ...record, [field]: `${typeof current === "string" ? current : ""}${delta}` } as Part;
      }),
    };
  });
};

const removePartFromMessages = (messages: MessageWithParts[], messageId: string, partId: string) =>
  messages.map((message) => {
    if (messageIdFromInfo(message.info) !== messageId) return message;
    return { ...message, parts: message.parts.filter((part) => part.id !== partId) };
  });

const removeMessageFromMessages = (messages: MessageWithParts[], messageId: string) =>
  messages.filter((message) => messageIdFromInfo(message.info) !== messageId);

const summarizeError = (error: unknown) => {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  const serialized = safeStringify(error);
  return serialized && serialized !== "{}" ? serialized : "Unexpected error";
};

const workspaceRoot = (workspace: OpenworkWorkspaceInfo | null | undefined) =>
  workspace?.directory?.trim() || workspace?.path?.trim() || "";

const scopedDirectory = (workspace: OpenworkWorkspaceInfo | null | undefined) =>
  resolveScopedClientDirectory({
    directory: workspace?.directory,
    targetRoot: workspace?.path,
    workspaceType: workspace?.workspaceType,
  });

const createWorkspaceClient = (state: OpenworkStore, workspaceId?: string | null) => {
  const mounted = buildOpenworkWorkspaceBaseUrl(state.server.url, workspaceId ?? state.activeWorkspaceId);
  if (!mounted) return null;
  return createClient(`${mounted}/opencode`, undefined, {
    token: state.server.token || undefined,
    mode: "openwork",
  });
};

const createServerClient = (state: OpenworkStore) => {
  const url = state.server.url.trim();
  if (!url) return null;
  return createOpenworkServerClient({
    baseUrl: url,
    token: state.server.token || undefined,
  });
};

const disconnectEventStream = () => {
  if (!eventAbortController) return;
  eventAbortController.abort();
  eventAbortController = null;
};

export const useOpenworkStore = create<OpenworkStore>((set, get) => {
  const refreshPendingPermissions = async () => {
    const client = createWorkspaceClient(get());
    if (!client || !(client.permission as any)?.list) return;
    const list = unwrap(await (client.permission as any).list());
    const currentById = new Map(get().pendingPermissions.map((item) => [item.id, item.receivedAt] as const));
    set({
      pendingPermissions: (Array.isArray(list) ? list : []).map((item) => ({
        ...item,
        receivedAt: currentById.get(item.id) ?? now(),
      })),
    });
  };

  const refreshPendingQuestions = async () => {
    const client = createWorkspaceClient(get());
    if (!client || !(client.question as any)?.list) return;
    const list = unwrap(await (client.question as any).list());
    const currentById = new Map(get().pendingQuestions.map((item) => [item.id, item.receivedAt] as const));
    set({
      pendingQuestions: (Array.isArray(list) ? list : []).map((item) => ({
        ...item,
        receivedAt: currentById.get(item.id) ?? now(),
      })),
    });
  };

  const ensureSessionLoaded = async (sessionId: string) => {
    const state = get();
    const trimmed = sessionId.trim();
    if (!trimmed) return;
    if (state.messagesBySessionId[trimmed]) return;

    const client = createWorkspaceClient(state);
    if (!client) return;

    try {
      const [infoResult, messagesResult, todoResult] = await Promise.allSettled([
        client.session.get({ sessionID: trimmed }),
        client.session.messages({ sessionID: trimmed, limit: 160 }),
        (client.session as any).todo ? (client.session as any).todo({ sessionID: trimmed }) : Promise.resolve({ data: [] }),
      ]);

      const nextInfo = infoResult.status === "fulfilled" ? unwrap(infoResult.value) : null;
      const nextMessages = messagesResult.status === "fulfilled" ? unwrap(messagesResult.value) : [];
      const nextTodos = todoResult.status === "fulfilled" ? unwrap(todoResult.value) : [];

      set((current) => ({
        sessions: nextInfo
          ? sortSessions(
              current.sessions.some((session) => session.id === nextInfo.id)
                ? current.sessions.map((session) => (session.id === nextInfo.id ? nextInfo : session))
                : [...current.sessions, nextInfo],
            )
          : current.sessions,
        messagesBySessionId: {
          ...current.messagesBySessionId,
          [trimmed]: sortMessages(Array.isArray(nextMessages) ? nextMessages : []),
        },
        todosBySessionId: {
          ...current.todosBySessionId,
          [trimmed]: Array.isArray(nextTodos) ? nextTodos : [],
        },
        messageLimitBySessionId: {
          ...current.messageLimitBySessionId,
          [trimmed]: 160,
        },
        sessionCompleteById: {
          ...current.sessionCompleteById,
          [trimmed]: (Array.isArray(nextMessages) ? nextMessages.length : 0) < 160,
        },
      }));

      await Promise.allSettled([refreshPendingPermissions(), refreshPendingQuestions()]);
    } catch (error) {
      set({ errorBanner: summarizeError(error) });
    }
  };

  const refreshSessions = async (workspaceId?: string | null) => {
    const state = get();
    const activeWorkspaceId = workspaceId ?? state.activeWorkspaceId;
    if (!activeWorkspaceId) {
      set({ sessions: [], sessionsStatus: "idle", selectedSessionId: null });
      return;
    }

    const workspace = state.workspaces.find((item) => item.id === activeWorkspaceId) ?? null;
    const client = createWorkspaceClient(state, activeWorkspaceId);
    if (!client) {
      set({ sessions: [], sessionsStatus: "error", errorBanner: "OpenCode proxy is not configured." });
      return;
    }

    set({ sessionsStatus: "loading", errorBanner: null });

    try {
      const directory = scopedDirectory(workspace) || undefined;
      const list = directory
        ? unwrap(await client.session.list({ directory, roots: true }))
        : unwrap(await client.session.list({ roots: true }));
      const nextSessions = sortSessions(Array.isArray(list) ? list : []);
      const storedMap = readStoredSessionsByWorkspace();
      const currentSelection = storedMap[activeWorkspaceId] ?? null;
      const nextSelection =
        nextSessions.find((session) => session.id === currentSelection)?.id ?? nextSessions[0]?.id ?? null;

      set({
        sessions: nextSessions,
        sessionsStatus: "ready",
        selectedSessionId: nextSelection,
      });

      if (nextSelection) {
        writeStoredSessionForWorkspace(activeWorkspaceId, nextSelection);
        await ensureSessionLoaded(nextSelection);
      }
    } catch (error) {
      set({ sessions: [], sessionsStatus: "error", errorBanner: summarizeError(error) });
    }
  };

  const connectEventStream = async (workspaceId: string) => {
    disconnectEventStream();

    const client = createWorkspaceClient(get(), workspaceId);
    if (!client || !(client.event as any)?.subscribe) {
      set({ connectedToEvents: false });
      return;
    }

    const controller = new AbortController();
    eventAbortController = controller;
    set({ connectedToEvents: false });

    try {
      const subscription = await (client.event as any).subscribe(undefined, { signal: controller.signal });
      set({ connectedToEvents: true });

      for await (const raw of subscription.stream as AsyncIterable<unknown>) {
        if (controller.signal.aborted) {
          break;
        }

        const event = normalizeEvent(raw);
        if (!event) continue;

        if (event.type === "server.connected") {
          set({ connectedToEvents: true });
          continue;
        }

        if (event.type === "session.created" || event.type === "session.updated") {
          const info = (event.properties as { info?: Session } | undefined)?.info;
          if (info?.id) {
            set((state) => ({
              sessions: sortSessions(
                state.sessions.some((session) => session.id === info.id)
                  ? state.sessions.map((session) => (session.id === info.id ? info : session))
                  : [...state.sessions, info],
              ),
            }));
          }
          continue;
        }

        if (event.type === "session.deleted") {
          const info = (event.properties as { info?: Session } | undefined)?.info;
          if (info?.id) {
            set((state) => ({
              sessions: state.sessions.filter((session) => session.id !== info.id),
              messagesBySessionId: Object.fromEntries(
                Object.entries(state.messagesBySessionId).filter(([key]) => key !== info.id),
              ),
              todosBySessionId: Object.fromEntries(
                Object.entries(state.todosBySessionId).filter(([key]) => key !== info.id),
              ),
              selectedSessionId:
                state.selectedSessionId === info.id
                  ? state.sessions.filter((session) => session.id !== info.id)[0]?.id ?? null
                  : state.selectedSessionId,
            }));
          }
          continue;
        }

        if (event.type === "session.status" || event.type === "session.idle") {
          const record = (event.properties as Record<string, unknown> | undefined) ?? {};
          const sessionId = typeof record.sessionID === "string" ? record.sessionID : null;
          if (sessionId) {
            set((state) => ({
              sessionStatusById: {
                ...state.sessionStatusById,
                [sessionId]: event.type === "session.idle" ? "idle" : normalizeSessionStatus(record.status),
              },
            }));
          }
          continue;
        }

        if (event.type === "session.error") {
          const record = (event.properties as Record<string, unknown> | undefined) ?? {};
          const sessionId = typeof record.sessionID === "string" ? record.sessionID : null;
          set((state) => ({
            sessionStatusById: sessionId
              ? { ...state.sessionStatusById, [sessionId]: "idle" }
              : state.sessionStatusById,
            errorBanner: summarizeError(record.error),
          }));
          continue;
        }

        if (event.type === "message.updated") {
          const info = (event.properties as { info?: Message } | undefined)?.info as MessageInfo | undefined;
          if (info?.sessionID) {
            set((state) => ({
              messagesBySessionId: {
                ...state.messagesBySessionId,
                [info.sessionID]: upsertMessage(state.messagesBySessionId[info.sessionID] ?? [], info),
              },
            }));
          }
          continue;
        }

        if (event.type === "message.removed") {
          const record = (event.properties as Record<string, unknown> | undefined) ?? {};
          const sessionId = typeof record.sessionID === "string" ? record.sessionID : null;
          const messageId = typeof record.messageID === "string" ? record.messageID : null;
          if (sessionId && messageId) {
            set((state) => ({
              messagesBySessionId: {
                ...state.messagesBySessionId,
                [sessionId]: removeMessageFromMessages(state.messagesBySessionId[sessionId] ?? [], messageId),
              },
            }));
          }
          continue;
        }

        if (event.type === "message.part.updated") {
          const record = (event.properties as Record<string, unknown> | undefined) ?? {};
          const part = record.part as Part | undefined;
          const delta = typeof record.delta === "string" ? record.delta : null;
          if (part?.sessionID) {
            set((state) => ({
              messagesBySessionId: {
                ...state.messagesBySessionId,
                [part.sessionID]: upsertPartInMessages(state.messagesBySessionId[part.sessionID] ?? [], part, delta),
              },
            }));
          }
          continue;
        }

        if (event.type === "message.part.delta") {
          const record = (event.properties as Record<string, unknown> | undefined) ?? {};
          const sessionId = typeof record.sessionID === "string" ? record.sessionID : null;
          const messageId = typeof record.messageID === "string" ? record.messageID : null;
          const partId = typeof record.partID === "string" ? record.partID : null;
          const field = typeof record.field === "string" ? record.field : null;
          const delta = typeof record.delta === "string" ? record.delta : null;
          if (sessionId && messageId && partId && field && delta) {
            set((state) => ({
              messagesBySessionId: {
                ...state.messagesBySessionId,
                [sessionId]: appendPartDeltaInMessages(
                  state.messagesBySessionId[sessionId] ?? [],
                  messageId,
                  partId,
                  field,
                  delta,
                ),
              },
            }));
          }
          continue;
        }

        if (event.type === "message.part.removed") {
          const record = (event.properties as Record<string, unknown> | undefined) ?? {};
          const sessionId = typeof record.sessionID === "string" ? record.sessionID : null;
          const messageId = typeof record.messageID === "string" ? record.messageID : null;
          const partId = typeof record.partID === "string" ? record.partID : null;
          if (sessionId && messageId && partId) {
            set((state) => ({
              messagesBySessionId: {
                ...state.messagesBySessionId,
                [sessionId]: removePartFromMessages(state.messagesBySessionId[sessionId] ?? [], messageId, partId),
              },
            }));
          }
          continue;
        }

        if (event.type === "todo.updated") {
          const record = (event.properties as Record<string, unknown> | undefined) ?? {};
          const sessionId = typeof record.sessionID === "string" ? record.sessionID : null;
          const todos = Array.isArray(record.todos) ? (record.todos as TodoItem[]) : null;
          if (sessionId && todos) {
            set((state) => ({
              todosBySessionId: {
                ...state.todosBySessionId,
                [sessionId]: todos,
              },
            }));
          }
          continue;
        }

        if (event.type === "permission.asked" || event.type === "permission.replied") {
          void refreshPendingPermissions();
          continue;
        }

        if (event.type === "question.asked" || event.type === "question.replied" || event.type === "question.rejected") {
          void refreshPendingQuestions();
        }
      }
    } catch (error) {
      if (!(error instanceof Error) || !/abort/i.test(error.message)) {
        set({ connectedToEvents: false, logs: [summarizeError(error), ...get().logs].slice(0, 24) });
      }
    } finally {
      if (eventAbortController === controller) {
        eventAbortController = null;
        set({ connectedToEvents: false });
      }
    }
  };

  return {
    bootstrapping: true,
    server: {
      url: "",
      token: "",
      status: "idle",
      error: null,
      version: null,
      capabilities: null,
      diagnostics: null,
    },
    workerProfiles: readStoredWorkerProfiles(),
    activeWorkerProfileId: null,
    workspaces: [],
    workspacesStatus: "idle",
    sessions: [],
    sessionsStatus: "idle",
    activeWorkspaceId: null,
    selectedSessionId: null,
    messagesBySessionId: {},
    todosBySessionId: {},
    messageLimitBySessionId: {},
    sessionCompleteById: {},
    loadingMoreBySessionId: {},
    sessionStatusById: {},
    pendingPermissions: [],
    pendingQuestions: [],
    connectedToEvents: false,
    sending: false,
    errorBanner: null,
    logs: [],
    clearErrorBanner: () => set({ errorBanner: null }),
    connectToServer: async ({ url, token }) => {
      const normalized = normalizeOpenworkServerUrl(url) ?? "";
      const trimmedToken = token?.trim() ?? "";
      writeOpenworkServerSettings({
        ...readOpenworkServerSettings(),
        urlOverride: normalized || undefined,
        token: trimmedToken || undefined,
      });
      set((state) => ({
        server: { ...state.server, url: normalized, token: trimmedToken, status: normalized ? "connecting" : "idle", error: null },
        activeWorkerProfileId: null,
        bootstrapping: false,
      }));
      await get().refreshServer();
    },
    connectRemoteWorkspace: async (input) => {
      const hostUrl = input.openworkHostUrl.trim();
      const token = input.openworkToken.trim();
      if (!hostUrl || !token) {
        set({ errorBanner: "Worker URL and token are required." });
        return false;
      }

      try {
        const resolved = await resolveOpenworkHost({
          hostUrl,
          token,
          workspaceId: input.workspaceId,
          directoryHint: input.directory,
        });

        const nextProfile: WorkerProfile = {
          id: `remote:${resolved.hostUrl}:${resolved.workspace.id}:${resolved.directory || ""}`,
          displayName: input.displayName?.trim() || resolved.workspace.name || resolved.hostUrl,
          hostUrl: resolved.hostUrl,
          token,
          workspaceId: resolved.workspace.id,
          workspaceName: resolved.workspace.name,
          directory: resolved.directory || null,
          source: input.source ?? "manual",
        };

        const nextProfiles = [
          nextProfile,
          ...get().workerProfiles.filter((profile) => profile.id !== nextProfile.id),
        ];
        writeStoredWorkerProfiles(nextProfiles);
        set({ workerProfiles: nextProfiles, activeWorkerProfileId: nextProfile.id });

        await get().connectToServer({ url: resolved.hostUrl, token });
        await get().selectWorkspace(resolved.workspace.id, { skipActivation: false });
        set({ activeWorkerProfileId: nextProfile.id });
        return true;
      } catch (error) {
        set({ errorBanner: summarizeError(error) });
        return false;
      }
    },
    connectWorkerProfile: async (profileId) => {
      const profile = get().workerProfiles.find((item) => item.id === profileId) ?? null;
      if (!profile) return false;
      const ok = await get().connectRemoteWorkspace({
        openworkHostUrl: profile.hostUrl,
        openworkToken: profile.token,
        directory: profile.directory,
        displayName: profile.displayName,
        workspaceId: profile.workspaceId,
        source: profile.source,
      });
      if (ok) {
        set({ activeWorkerProfileId: profile.id });
      }
      return ok;
    },
    removeWorkerProfile: (profileId) => {
      const next = get().workerProfiles.filter((profile) => profile.id !== profileId);
      writeStoredWorkerProfiles(next);
      set((state) => ({
        workerProfiles: next,
        activeWorkerProfileId: state.activeWorkerProfileId === profileId ? null : state.activeWorkerProfileId,
      }));
    },
    bootstrap: async () => {
      hydrateOpenworkServerSettingsFromEnv();
      const settings = readOpenworkServerSettings();
      let url = settings.urlOverride?.trim() ?? "";
      let token = settings.token?.trim() ?? "";

      if (typeof window !== "undefined") {
        const invite = readOpenworkConnectInviteFromSearch(window.location.search);
        if (invite?.url) {
          url = invite.url;
          token = invite.token?.trim() || token;
          writeOpenworkServerSettings({
            ...settings,
            urlOverride: url,
            token: token || undefined,
          });
          try {
            window.history.replaceState({}, document.title, stripOpenworkConnectInviteFromUrl(window.location.href));
          } catch {
            // ignore
          }
        }
      }

      set((state) => ({
        bootstrapping: false,
        server: { ...state.server, url, token, status: url ? "connecting" : "idle", error: null },
      }));

      if (url) {
        await get().refreshServer();
      }
    },
    refreshServer: async () => {
      const state = get();
      const client = createServerClient(state);
      if (!client) {
        disconnectEventStream();
        set((current) => ({
          server: { ...current.server, status: "idle", error: null, capabilities: null, diagnostics: null },
          workspaces: [],
          sessions: [],
          activeWorkspaceId: null,
          selectedSessionId: null,
          messageLimitBySessionId: {},
          sessionCompleteById: {},
          loadingMoreBySessionId: {},
        }));
        return;
      }

      set((current) => ({
        server: { ...current.server, status: "connecting", error: null },
        workspacesStatus: "loading",
        errorBanner: null,
      }));

      const [healthResult, capabilitiesResult, diagnosticsResult, workspacesResult] = await Promise.allSettled([
        client.health(),
        client.capabilities(),
        client.status(),
        client.listWorkspaces(),
      ]);

      const health = healthResult.status === "fulfilled" ? healthResult.value : null;
      const capabilities = capabilitiesResult.status === "fulfilled" ? capabilitiesResult.value : null;
      const diagnostics = diagnosticsResult.status === "fulfilled" ? diagnosticsResult.value : null;

      if (workspacesResult.status === "rejected") {
        disconnectEventStream();
        set((current) => ({
          server: {
            ...current.server,
            status: "error",
            error: summarizeError(workspacesResult.reason),
            version: health?.version ?? diagnostics?.version ?? current.server.version,
            capabilities,
            diagnostics,
          },
          workspaces: [],
          workspacesStatus: "error",
          sessions: [],
          sessionsStatus: "idle",
          activeWorkspaceId: null,
          selectedSessionId: null,
        }));
        return;
      }

      const workspacePayload = normalizeWorkspaceItems(workspacesResult.value);
      const storedActive = readStoredActiveWorkspaceId();
      const preferredActive =
        workspacePayload.items.find((workspace) => workspace.id === storedActive)?.id ??
        workspacePayload.activeId ??
        workspacePayload.items[0]?.id ??
        null;

      set((current) => ({
        server: {
          ...current.server,
          status: "connected",
          error: null,
          version: health?.version ?? diagnostics?.version ?? null,
          capabilities,
          diagnostics,
        },
        workspaces: workspacePayload.items,
        workspacesStatus: "ready",
        activeWorkspaceId: preferredActive,
      }));

      writeStoredActiveWorkspaceId(preferredActive);

      if (preferredActive) {
        await get().selectWorkspace(preferredActive, { skipActivation: workspacePayload.activeId === preferredActive });
      } else {
        disconnectEventStream();
        set({ sessions: [], sessionsStatus: "idle", selectedSessionId: null });
      }
    },
    selectWorkspace: async (workspaceId, options) => {
      const state = get();
      const trimmed = workspaceId.trim();
      if (!trimmed) return;

      const serverClient = createServerClient(state);
      if (!serverClient) return;

      if (!options?.skipActivation) {
        try {
          await serverClient.activateWorkspace(trimmed);
        } catch (error) {
          set({ errorBanner: summarizeError(error) });
          return;
        }
      }

      writeStoredActiveWorkspaceId(trimmed);
      set({
        activeWorkspaceId: trimmed,
        sessions: [],
        selectedSessionId: null,
        messagesBySessionId: {},
        todosBySessionId: {},
        messageLimitBySessionId: {},
        sessionCompleteById: {},
        loadingMoreBySessionId: {},
        sessionStatusById: {},
      });

      await Promise.all([get().refreshSessions(trimmed), connectEventStream(trimmed)]);
    },
    refreshSessions,
    selectSession: async (sessionId) => {
      const trimmed = sessionId?.trim() || null;
      set({ selectedSessionId: trimmed });
      if (trimmed && get().activeWorkspaceId) {
        writeStoredSessionForWorkspace(get().activeWorkspaceId as string, trimmed);
        await ensureSessionLoaded(trimmed);
      }
    },
    ensureSessionLoaded,
    createSession: async (initialPrompt) => {
      const state = get();
      const workspace = state.workspaces.find((item) => item.id === state.activeWorkspaceId) ?? null;
      const client = createWorkspaceClient(state);
      if (!client) {
        set({ errorBanner: "OpenCode proxy is not connected." });
        return null;
      }

      try {
        const directory = scopedDirectory(workspace) || undefined;
        const session = directory ? unwrap(await client.session.create({ directory })) : unwrap(await client.session.create({}));
        set((current) => ({
          sessions: sortSessions([session, ...current.sessions.filter((item) => item.id !== session.id)]),
          selectedSessionId: session.id,
        }));
        if (state.activeWorkspaceId) {
          writeStoredSessionForWorkspace(state.activeWorkspaceId, session.id);
        }
        await ensureSessionLoaded(session.id);
        if (initialPrompt?.trim()) {
          await get().sendPrompt(initialPrompt);
        }
        return session.id;
      } catch (error) {
        set({ errorBanner: summarizeError(error) });
        return null;
      }
    },
    sendPrompt: async (prompt) => {
      const content = prompt.trim();
      if (!content) return;

      let sessionId = get().selectedSessionId;
      if (!sessionId) {
        sessionId = await get().createSession();
      }
      if (!sessionId) return;

      const client = createWorkspaceClient(get());
      if (!client) {
        set({ errorBanner: "OpenCode proxy is not connected." });
        return;
      }

      set((state) => ({
        sending: true,
        errorBanner: null,
        sessionStatusById: {
          ...state.sessionStatusById,
          [sessionId as string]: "running",
        },
      }));

      try {
        const api = client.session as any;
        const result = await api.promptAsync({
          sessionID: sessionId,
          parts: [{ type: "text", text: content }],
        });
        if (result?.error) {
          throw result.error;
        }
        await ensureSessionLoaded(sessionId);
      } catch (error) {
        set((state) => ({
          errorBanner: summarizeError(error),
          sessionStatusById: {
            ...state.sessionStatusById,
            [sessionId as string]: "idle",
          },
        }));
      } finally {
        set({ sending: false });
      }
    },
    deleteSession: async (sessionId) => {
      const trimmed = sessionId.trim();
      if (!trimmed) return;

      const state = get();
      const client = createWorkspaceClient(state);
      const workspace = state.workspaces.find((item) => item.id === state.activeWorkspaceId) ?? null;
      if (!client) return;

      try {
        const directory = scopedDirectory(workspace);
        const params = directory ? { sessionID: trimmed, directory } : { sessionID: trimmed };
        unwrap(await client.session.delete(params));
        set((current) => {
          const nextSessions = current.sessions.filter((session) => session.id !== trimmed);
          const fallbackSelection = nextSessions[0]?.id ?? null;
          return {
            sessions: nextSessions,
            selectedSessionId: current.selectedSessionId === trimmed ? fallbackSelection : current.selectedSessionId,
            messagesBySessionId: Object.fromEntries(
              Object.entries(current.messagesBySessionId).filter(([key]) => key !== trimmed),
            ),
            todosBySessionId: Object.fromEntries(
              Object.entries(current.todosBySessionId).filter(([key]) => key !== trimmed),
            ),
            messageLimitBySessionId: Object.fromEntries(
              Object.entries(current.messageLimitBySessionId).filter(([key]) => key !== trimmed),
            ),
            sessionCompleteById: Object.fromEntries(
              Object.entries(current.sessionCompleteById).filter(([key]) => key !== trimmed),
            ),
            loadingMoreBySessionId: Object.fromEntries(
              Object.entries(current.loadingMoreBySessionId).filter(([key]) => key !== trimmed),
            ),
          };
        });
        if (state.activeWorkspaceId) {
          writeStoredSessionForWorkspace(state.activeWorkspaceId, get().selectedSessionId);
        }
      } catch (error) {
        set({ errorBanner: summarizeError(error) });
      }
    },
    abortSession: async (sessionId) => {
      const targetId = sessionId?.trim() || get().selectedSessionId;
      if (!targetId) return;
      const client = createWorkspaceClient(get());
      if (!client) return;
      try {
        await abortSessionInClient(client, targetId);
        set((state) => ({
          sessionStatusById: {
            ...state.sessionStatusById,
            [targetId]: "idle",
          },
        }));
      } catch (error) {
        set({ errorBanner: summarizeError(error) });
      }
    },
    renameSession: async (sessionId, title) => {
      const trimmedId = sessionId.trim();
      const trimmedTitle = title.trim();
      if (!trimmedId || !trimmedTitle) return;
      const client = createWorkspaceClient(get());
      if (!client) return;
      try {
        const next = unwrap(await client.session.update({ sessionID: trimmedId, title: trimmedTitle }));
        set((state) => ({
          sessions: sortSessions(
            state.sessions.some((session) => session.id === trimmedId)
              ? state.sessions.map((session) => (session.id === trimmedId ? next : session))
              : [...state.sessions, next],
          ),
        }));
      } catch (error) {
        set({ errorBanner: summarizeError(error) });
      }
    },
    loadEarlierMessages: async (sessionId) => {
      const trimmedId = sessionId.trim();
      if (!trimmedId) return;
      const state = get();
      if (state.loadingMoreBySessionId[trimmedId]) return;
      if (state.sessionCompleteById[trimmedId]) return;
      const client = createWorkspaceClient(state);
      if (!client) return;

      const currentCount = state.messagesBySessionId[trimmedId]?.length ?? 0;
      const nextLimit = Math.max(160, state.messageLimitBySessionId[trimmedId] ?? currentCount, currentCount) + 120;

      set((current) => ({
        loadingMoreBySessionId: {
          ...current.loadingMoreBySessionId,
          [trimmedId]: true,
        },
      }));

      try {
        const messages = unwrap(await client.session.messages({ sessionID: trimmedId, limit: nextLimit }));
        set((current) => ({
          messagesBySessionId: {
            ...current.messagesBySessionId,
            [trimmedId]: sortMessages(Array.isArray(messages) ? messages : []),
          },
          messageLimitBySessionId: {
            ...current.messageLimitBySessionId,
            [trimmedId]: nextLimit,
          },
          sessionCompleteById: {
            ...current.sessionCompleteById,
            [trimmedId]: (Array.isArray(messages) ? messages.length : 0) < nextLimit,
          },
        }));
      } catch (error) {
        set({ errorBanner: summarizeError(error) });
      } finally {
        set((current) => ({
          loadingMoreBySessionId: {
            ...current.loadingMoreBySessionId,
            [trimmedId]: false,
          },
        }));
      }
    },
    replyPermission: async (requestId, reply) => {
      const client = createWorkspaceClient(get());
      if (!client || !(client.permission as any)?.reply) return;
      try {
        unwrap(await (client.permission as any).reply({ requestID: requestId, reply }));
        await refreshPendingPermissions();
      } catch (error) {
        set({ errorBanner: summarizeError(error) });
      }
    },
    replyQuestion: async (requestId, answers) => {
      const client = createWorkspaceClient(get());
      if (!client || !(client.question as any)?.reply) return;
      try {
        unwrap(await (client.question as any).reply({ requestID: requestId, answers }));
        await refreshPendingQuestions();
      } catch (error) {
        set({ errorBanner: summarizeError(error) });
      }
    },
    rejectQuestion: async (requestId) => {
      const client = createWorkspaceClient(get());
      if (!client || !(client.question as any)?.reject) return;
      try {
        unwrap(await (client.question as any).reject({ requestID: requestId }));
        await refreshPendingQuestions();
      } catch (error) {
        set({ errorBanner: summarizeError(error) });
      }
    },
  };
});

export const selectActiveWorkspace = (state: OpenworkStore) =>
  state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId) ?? null;

export const selectSelectedSession = (state: OpenworkStore) =>
  state.sessions.find((session) => session.id === state.selectedSessionId) ?? null;

export const selectSelectedMessages = (state: OpenworkStore) =>
  state.selectedSessionId ? state.messagesBySessionId[state.selectedSessionId] ?? EMPTY_MESSAGES : EMPTY_MESSAGES;

export const selectSelectedTodos = (state: OpenworkStore) =>
  state.selectedSessionId ? state.todosBySessionId[state.selectedSessionId] ?? EMPTY_TODOS : EMPTY_TODOS;

export const selectSelectedHasEarlierMessages = (state: OpenworkStore) =>
  state.selectedSessionId ? !state.sessionCompleteById[state.selectedSessionId] : false;

export const selectSelectedLoadingEarlierMessages = (state: OpenworkStore) =>
  state.selectedSessionId ? Boolean(state.loadingMoreBySessionId[state.selectedSessionId]) : false;

export const selectSelectedStatus = (state: OpenworkStore) =>
  state.selectedSessionId ? state.sessionStatusById[state.selectedSessionId] ?? "idle" : "idle";

export const selectScopedPermissions = (state: OpenworkStore) => {
  const sessionId = state.selectedSessionId;
  if (!sessionId) return state.pendingPermissions.length ? state.pendingPermissions : EMPTY_PERMISSIONS;
  const scoped = state.pendingPermissions.filter((item) => item.sessionID === sessionId);
  return scoped.length ? scoped : EMPTY_PERMISSIONS;
};

export const selectScopedQuestions = (state: OpenworkStore) => {
  const sessionId = state.selectedSessionId;
  if (!sessionId) return state.pendingQuestions;
  return state.pendingQuestions.filter((item) => item.sessionID === sessionId);
};

export const selectServerHostLabel = (state: OpenworkStore) => {
  const value = normalizeOpenworkServerUrl(state.server.url) ?? "";
  if (!value) return "Not connected";
  try {
    const url = new URL(value);
    return url.host;
  } catch {
    return value.replace(/^https?:\/\//, "");
  }
};

export const selectWorkspaceScopeLabel = (workspace: OpenworkWorkspaceInfo | null) => {
  if (!workspace) return "No workspace selected";
  const root = workspaceRoot(workspace);
  if (!root) return workspace.workspaceType === "remote" ? "Remote workspace" : "Workspace ready";
  const normalized = normalizeDirectoryPath(root);
  return normalized || root;
};
