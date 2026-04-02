import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client";

import {
  createLabsClient,
  describeError,
  normalizeLabsEvent,
  normalizeOpencodeBaseUrl,
  unwrap,
  workspaceNameFromUrl,
} from "./opencode";
import type {
  ConnectionSnapshot,
  LabsState,
  LabsTemplateProfile,
  LabsWorkspace,
  MessageWithParts,
  PersistedLabsState,
  SeedMessage,
  SessionRunStatus,
  WorkspaceTemplateBinding,
} from "./types";

const STORAGE_KEY = "openwork.labs.state.v1";
const HEALTH_POLL_MS = 20_000;
const SESSION_LIMIT = 200;
const WORKSPACE_COLORS = [
  "#3b82f6",
  "#f97316",
  "#14b8a6",
  "#eab308",
  "#ef4444",
  "#8b5cf6",
  "#22c55e",
  "#06b6d4",
];

const isDesktopRuntime = () =>
  typeof window !== "undefined" && Boolean(window.openworkLabsDesktop?.isDesktop);

type Action =
  | { type: "app/set-error"; error: string | null }
  | { type: "workspace/upsert"; workspace: LabsWorkspace }
  | { type: "workspace/remove"; workspaceId: string }
  | { type: "workspace/set-active"; workspaceId: string | null }
  | { type: "workspace/set-connection"; workspaceId: string; connection: ConnectionSnapshot }
  | { type: "workspace/set-sessions"; workspaceId: string; sessions: Session[] }
  | { type: "workspace/upsert-session"; workspaceId: string; session: Session }
  | { type: "workspace/remove-session"; workspaceId: string; sessionId: string }
  | { type: "workspace/set-selected-session"; workspaceId: string; sessionId: string | null }
  | { type: "workspace/clear-unread"; workspaceId: string }
  | { type: "workspace/increment-unread"; workspaceId: string }
  | {
      type: "workspace/bind-template";
      workspaceId: string;
      template: WorkspaceTemplateBinding;
    }
  | {
      type: "workspace/record-materialized";
      workspaceId: string;
      templateId: string;
      sessionId: string;
    }
  | { type: "session/set-loading"; sessionId: string; loading: boolean }
  | { type: "session/set-status"; sessionId: string; status: SessionRunStatus }
  | { type: "session/set-messages"; sessionId: string; messages: MessageWithParts[] }
  | { type: "session/upsert-message"; sessionId: string; message: Message }
  | { type: "session/remove-message"; sessionId: string; messageId: string }
  | { type: "session/upsert-part"; sessionId: string; part: Part }
  | {
      type: "session/append-part-delta";
      sessionId: string;
      messageId: string;
      partId: string;
      field: string;
      delta: string;
    }
  | { type: "session/remove-part"; sessionId: string; messageId: string; partId: string }
  | { type: "session/set-seed-messages"; sessionId: string; messages: SeedMessage[] }
  | { type: "template/upsert"; template: LabsTemplateProfile };

type WorkspaceInput = {
  id?: string | null;
  name?: string | null;
  baseUrl: string;
  token?: string | null;
};

type Controller = {
  state: LabsState;
  activeWorkspace: LabsWorkspace | null;
  activeSessions: Session[];
  selectedSessionId: string | null;
  saveWorkspace: (input: WorkspaceInput) => string;
  removeWorkspace: (workspaceId: string) => void;
  setActiveWorkspace: (workspaceId: string) => void;
  selectSession: (workspaceId: string, sessionId: string) => Promise<void>;
  createSession: (workspaceId: string, options?: { title?: string; seedMessages?: SeedMessage[] }) => Promise<string | null>;
  sendPrompt: (workspaceId: string, sessionId: string | null, prompt: string) => Promise<string | null>;
  abortSession: (workspaceId: string, sessionId: string | null) => Promise<void>;
  applyTemplateToWorkspace: (workspaceId: string, template: LabsTemplateProfile) => Promise<void>;
  clearError: () => void;
  openTemplateActionForStarter: (workspaceId: string, action: string | undefined) => string | null;
  refreshWorkspace: (workspaceId: string) => Promise<void>;
};

type WorkspaceConnectionEntry = {
  cleanup: () => void;
  configKey: string;
};

function randomId() {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `labs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function sessionActivity(session: Session) {
  return session.time?.updated ?? session.time?.created ?? 0;
}

function sortSessions(list: Session[] | unknown) {
  const safeList = Array.isArray(list) ? list : [];
  return safeList
    .slice()
    .sort((left, right) => {
      const delta = sessionActivity(right) - sessionActivity(left);
      if (delta !== 0) return delta;
      return left.id.localeCompare(right.id);
    });
}

function upsertSession(list: Session[], next: Session) {
  const existingIndex = list.findIndex((session) => session.id === next.id);
  if (existingIndex === -1) return sortSessions([...list, next]);
  const copy = list.slice();
  copy[existingIndex] = next;
  return sortSessions(copy);
}

function sortMessages(list: MessageWithParts[] | unknown) {
  const safeList = Array.isArray(list) ? list : [];
  return safeList
    .slice()
    .sort((left, right) => {
      const delta = (left.info.time?.created ?? 0) - (right.info.time?.created ?? 0);
      if (delta !== 0) return delta;
      return left.info.id.localeCompare(right.info.id);
    });
}

function upsertMessage(list: MessageWithParts[], next: Message) {
  const existing = list.find((entry) => entry.info.id === next.id);
  if (!existing) {
    return sortMessages([...list, { info: next, parts: [] }]);
  }

  return list.map((entry) =>
    entry.info.id === next.id
      ? {
          ...entry,
          info: next,
        }
      : entry,
  );
}

function removeMessage(list: MessageWithParts[], messageId: string) {
  return list.filter((entry) => entry.info.id !== messageId);
}

function upsertPart(list: MessageWithParts[], part: Part) {
  return list.map((entry) => {
    if (entry.info.id !== part.messageID) return entry;

    const existingIndex = entry.parts.findIndex((candidate) => candidate.id === part.id);
    if (existingIndex === -1) {
      return {
        ...entry,
        parts: [...entry.parts, part],
      };
    }

    const nextParts = entry.parts.slice();
    nextParts[existingIndex] = part;
    return {
      ...entry,
      parts: nextParts,
    };
  });
}

function appendPartDelta(
  list: MessageWithParts[],
  messageId: string,
  partId: string,
  field: string,
  delta: string,
) {
  if (!delta) return list;

  return list.map((entry) => {
    if (entry.info.id !== messageId) return entry;
    return {
      ...entry,
      parts: entry.parts.map((part) => {
        if (part.id !== partId) return part;

        const current = (part as Record<string, unknown>)[field];
        const nextValue = `${typeof current === "string" ? current : ""}${delta}`;
        return {
          ...(part as Record<string, unknown>),
          [field]: nextValue,
        } as Part;
      }),
    };
  });
}

function removePart(list: MessageWithParts[], messageId: string, partId: string) {
  return list.map((entry) =>
    entry.info.id === messageId
      ? {
          ...entry,
          parts: entry.parts.filter((part) => part.id !== partId),
        }
      : entry,
  );
}

function pickWorkspaceColor(seed: string) {
  const hash = seed.split("").reduce((total, char) => total + char.charCodeAt(0), 0);
  return WORKSPACE_COLORS[hash % WORKSPACE_COLORS.length];
}

function createInitialState(): LabsState {
  if (typeof window === "undefined") {
    return {
      workspaces: [],
      activeWorkspaceId: null,
      sessionsByWorkspaceId: {},
      selectedSessionIdByWorkspaceId: {},
      messagesBySessionId: {},
      statusBySessionId: {},
      connectionByWorkspaceId: {},
      seedMessagesBySessionId: {},
      loadingMessagesBySessionId: {},
      unreadByWorkspaceId: {},
      templates: [],
      error: null,
    };
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<PersistedLabsState>) : null;
    const workspaces = Array.isArray(parsed?.workspaces) ? parsed!.workspaces! : [];

    return {
      workspaces,
      activeWorkspaceId: parsed?.activeWorkspaceId ?? workspaces[0]?.id ?? null,
      sessionsByWorkspaceId: {},
      selectedSessionIdByWorkspaceId: parsed?.selectedSessionIdByWorkspaceId ?? {},
      messagesBySessionId: {},
      statusBySessionId: {},
      connectionByWorkspaceId: {},
      seedMessagesBySessionId: parsed?.seedMessagesBySessionId ?? {},
      loadingMessagesBySessionId: {},
      unreadByWorkspaceId: {},
      templates: Array.isArray(parsed?.templates) ? parsed!.templates! : [],
      error: null,
    };
  } catch {
    return {
      workspaces: [],
      activeWorkspaceId: null,
      sessionsByWorkspaceId: {},
      selectedSessionIdByWorkspaceId: {},
      messagesBySessionId: {},
      statusBySessionId: {},
      connectionByWorkspaceId: {},
      seedMessagesBySessionId: {},
      loadingMessagesBySessionId: {},
      unreadByWorkspaceId: {},
      templates: [],
      error: null,
    };
  }
}

function reducer(state: LabsState, action: Action): LabsState {
  switch (action.type) {
    case "app/set-error":
      return {
        ...state,
        error: action.error,
      };

    case "workspace/upsert": {
      const existingIndex = state.workspaces.findIndex((workspace) => workspace.id === action.workspace.id);
      const nextWorkspaces =
        existingIndex === -1
          ? [...state.workspaces, action.workspace]
          : state.workspaces.map((workspace) =>
              workspace.id === action.workspace.id ? action.workspace : workspace,
            );
      return {
        ...state,
        workspaces: nextWorkspaces,
        activeWorkspaceId: state.activeWorkspaceId ?? action.workspace.id,
      };
    }

    case "workspace/remove": {
      const nextWorkspaces = state.workspaces.filter((workspace) => workspace.id !== action.workspaceId);
      const nextSessionsByWorkspaceId = { ...state.sessionsByWorkspaceId };
      const removedSessions = nextSessionsByWorkspaceId[action.workspaceId] ?? [];
      delete nextSessionsByWorkspaceId[action.workspaceId];

      const nextSelectedSessionIdByWorkspaceId = { ...state.selectedSessionIdByWorkspaceId };
      delete nextSelectedSessionIdByWorkspaceId[action.workspaceId];

      const nextUnreadByWorkspaceId = { ...state.unreadByWorkspaceId };
      delete nextUnreadByWorkspaceId[action.workspaceId];

      const nextConnectionByWorkspaceId = { ...state.connectionByWorkspaceId };
      delete nextConnectionByWorkspaceId[action.workspaceId];

      const nextMessagesBySessionId = { ...state.messagesBySessionId };
      const nextStatusBySessionId = { ...state.statusBySessionId };
      const nextSeedMessagesBySessionId = { ...state.seedMessagesBySessionId };
      const nextLoadingMessagesBySessionId = { ...state.loadingMessagesBySessionId };
      removedSessions.forEach((session) => {
        delete nextMessagesBySessionId[session.id];
        delete nextStatusBySessionId[session.id];
        delete nextSeedMessagesBySessionId[session.id];
        delete nextLoadingMessagesBySessionId[session.id];
      });

      return {
        ...state,
        workspaces: nextWorkspaces,
        activeWorkspaceId:
          state.activeWorkspaceId === action.workspaceId
            ? nextWorkspaces[0]?.id ?? null
            : state.activeWorkspaceId,
        sessionsByWorkspaceId: nextSessionsByWorkspaceId,
        selectedSessionIdByWorkspaceId: nextSelectedSessionIdByWorkspaceId,
        messagesBySessionId: nextMessagesBySessionId,
        statusBySessionId: nextStatusBySessionId,
        connectionByWorkspaceId: nextConnectionByWorkspaceId,
        seedMessagesBySessionId: nextSeedMessagesBySessionId,
        loadingMessagesBySessionId: nextLoadingMessagesBySessionId,
        unreadByWorkspaceId: nextUnreadByWorkspaceId,
      };
    }

    case "workspace/set-active":
      return {
        ...state,
        activeWorkspaceId: action.workspaceId,
      };

    case "workspace/set-connection":
      return {
        ...state,
        connectionByWorkspaceId: {
          ...state.connectionByWorkspaceId,
          [action.workspaceId]: action.connection,
        },
      };

    case "workspace/set-sessions":
      return {
        ...state,
        sessionsByWorkspaceId: {
          ...state.sessionsByWorkspaceId,
          [action.workspaceId]: sortSessions(action.sessions),
        },
      };

    case "workspace/upsert-session":
      return {
        ...state,
        sessionsByWorkspaceId: {
          ...state.sessionsByWorkspaceId,
          [action.workspaceId]: upsertSession(
            state.sessionsByWorkspaceId[action.workspaceId] ?? [],
            action.session,
          ),
        },
      };

    case "workspace/remove-session": {
      const nextSessions = (state.sessionsByWorkspaceId[action.workspaceId] ?? []).filter(
        (session) => session.id !== action.sessionId,
      );
      const nextMessages = { ...state.messagesBySessionId };
      delete nextMessages[action.sessionId];

      const nextStatuses = { ...state.statusBySessionId };
      delete nextStatuses[action.sessionId];

      const nextSeedMessages = { ...state.seedMessagesBySessionId };
      delete nextSeedMessages[action.sessionId];

      const nextLoading = { ...state.loadingMessagesBySessionId };
      delete nextLoading[action.sessionId];

      return {
        ...state,
        sessionsByWorkspaceId: {
          ...state.sessionsByWorkspaceId,
          [action.workspaceId]: nextSessions,
        },
        selectedSessionIdByWorkspaceId: {
          ...state.selectedSessionIdByWorkspaceId,
          [action.workspaceId]:
            state.selectedSessionIdByWorkspaceId[action.workspaceId] === action.sessionId
              ? nextSessions[0]?.id ?? null
              : state.selectedSessionIdByWorkspaceId[action.workspaceId] ?? null,
        },
        messagesBySessionId: nextMessages,
        statusBySessionId: nextStatuses,
        seedMessagesBySessionId: nextSeedMessages,
        loadingMessagesBySessionId: nextLoading,
      };
    }

    case "workspace/set-selected-session":
      return {
        ...state,
        selectedSessionIdByWorkspaceId: {
          ...state.selectedSessionIdByWorkspaceId,
          [action.workspaceId]: action.sessionId,
        },
      };

    case "workspace/clear-unread":
      return {
        ...state,
        unreadByWorkspaceId: {
          ...state.unreadByWorkspaceId,
          [action.workspaceId]: 0,
        },
      };

    case "workspace/increment-unread":
      return {
        ...state,
        unreadByWorkspaceId: {
          ...state.unreadByWorkspaceId,
          [action.workspaceId]: (state.unreadByWorkspaceId[action.workspaceId] ?? 0) + 1,
        },
      };

    case "workspace/bind-template":
      return {
        ...state,
        workspaces: state.workspaces.map((workspace) =>
          workspace.id === action.workspaceId
            ? {
                ...workspace,
                template: action.template,
              }
            : workspace,
        ),
      };

    case "workspace/record-materialized":
      return {
        ...state,
        workspaces: state.workspaces.map((workspace) => {
          if (workspace.id !== action.workspaceId || !workspace.template) return workspace;
          const existing = workspace.template.blueprint.materialized.find(
            (item) => item.templateId === action.templateId,
          );
          const materialized = existing
            ? workspace.template.blueprint.materialized.map((item) =>
                item.templateId === action.templateId
                  ? { templateId: action.templateId, sessionId: action.sessionId }
                  : item,
              )
            : [
                ...workspace.template.blueprint.materialized,
                { templateId: action.templateId, sessionId: action.sessionId },
              ];
          return {
            ...workspace,
            template: {
              ...workspace.template,
              blueprint: {
                ...workspace.template.blueprint,
                materialized,
              },
            },
          };
        }),
      };

    case "session/set-loading":
      return {
        ...state,
        loadingMessagesBySessionId: {
          ...state.loadingMessagesBySessionId,
          [action.sessionId]: action.loading,
        },
      };

    case "session/set-status":
      return {
        ...state,
        statusBySessionId: {
          ...state.statusBySessionId,
          [action.sessionId]: action.status,
        },
      };

    case "session/set-messages":
      return {
        ...state,
        messagesBySessionId: {
          ...state.messagesBySessionId,
          [action.sessionId]: sortMessages(action.messages),
        },
      };

    case "session/upsert-message":
      return {
        ...state,
        messagesBySessionId: {
          ...state.messagesBySessionId,
          [action.sessionId]: upsertMessage(
            state.messagesBySessionId[action.sessionId] ?? [],
            action.message,
          ),
        },
      };

    case "session/remove-message":
      return {
        ...state,
        messagesBySessionId: {
          ...state.messagesBySessionId,
          [action.sessionId]: removeMessage(
            state.messagesBySessionId[action.sessionId] ?? [],
            action.messageId,
          ),
        },
      };

    case "session/upsert-part":
      return {
        ...state,
        messagesBySessionId: {
          ...state.messagesBySessionId,
          [action.sessionId]: upsertPart(
            state.messagesBySessionId[action.sessionId] ?? [],
            action.part,
          ),
        },
      };

    case "session/append-part-delta":
      return {
        ...state,
        messagesBySessionId: {
          ...state.messagesBySessionId,
          [action.sessionId]: appendPartDelta(
            state.messagesBySessionId[action.sessionId] ?? [],
            action.messageId,
            action.partId,
            action.field,
            action.delta,
          ),
        },
      };

    case "session/remove-part":
      return {
        ...state,
        messagesBySessionId: {
          ...state.messagesBySessionId,
          [action.sessionId]: removePart(
            state.messagesBySessionId[action.sessionId] ?? [],
            action.messageId,
            action.partId,
          ),
        },
      };

    case "session/set-seed-messages":
      return {
        ...state,
        seedMessagesBySessionId: {
          ...state.seedMessagesBySessionId,
          [action.sessionId]: action.messages,
        },
      };

    case "template/upsert": {
      const existingIndex = state.templates.findIndex((template) => template.id === action.template.id);
      const templates =
        existingIndex === -1
          ? [action.template, ...state.templates]
          : state.templates.map((template) =>
              template.id === action.template.id ? action.template : template,
            );
      return {
        ...state,
        templates,
      };
    }

    default:
      return state;
  }
}

function persistState(state: LabsState) {
  if (typeof window === "undefined") return;

  const next: PersistedLabsState = {
    workspaces: state.workspaces,
    activeWorkspaceId: state.activeWorkspaceId,
    selectedSessionIdByWorkspaceId: state.selectedSessionIdByWorkspaceId,
    seedMessagesBySessionId: state.seedMessagesBySessionId,
    templates: state.templates,
  };

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage failures.
  }
}

export function useLabsApp(): Controller {
  const [state, dispatch] = useReducer(reducer, undefined, createInitialState);
  const stateRef = useRef(state);
  const clientsRef = useRef(new Map<string, ReturnType<typeof createLabsClient>>());
  const connectionsRef = useRef(new Map<string, WorkspaceConnectionEntry>());
  const activeWorkspaceIdRef = useRef(state.activeWorkspaceId);

  useEffect(() => {
    stateRef.current = state;
    activeWorkspaceIdRef.current = state.activeWorkspaceId;
    persistState(state);
  }, [state]);

  const getWorkspace = useCallback((workspaceId: string) => {
    return stateRef.current.workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
  }, []);

  const getClient = useCallback((workspaceId: string) => {
    return clientsRef.current.get(workspaceId) ?? null;
  }, []);

  const loadSessionMessages = useCallback(async (workspaceId: string, sessionId: string) => {
    const client = getClient(workspaceId);
    if (!client) return;

    dispatch({ type: "session/set-loading", sessionId, loading: true });

    try {
      const messages = unwrap<MessageWithParts[]>(
        await client.session.messages({ sessionID: sessionId, limit: SESSION_LIMIT }),
      );
      dispatch({ type: "session/set-messages", sessionId, messages });
    } catch (error) {
      dispatch({ type: "app/set-error", error: describeError(error) });
    } finally {
      dispatch({ type: "session/set-loading", sessionId, loading: false });
    }
  }, [getClient]);

  const loadWorkspaceSessions = useCallback(async (workspaceId: string) => {
    const client = getClient(workspaceId);
    if (!client) return;

    try {
      const sessions = unwrap<Session[]>(
        await client.session.list({ roots: false, limit: SESSION_LIMIT }),
      );
      dispatch({ type: "workspace/set-sessions", workspaceId, sessions });

      const current = stateRef.current.selectedSessionIdByWorkspaceId[workspaceId] ?? null;
      const nextSelected = current || sessions[0]?.id || null;
      if (nextSelected) {
        dispatch({
          type: "workspace/set-selected-session",
          workspaceId,
          sessionId: nextSelected,
        });

        if (stateRef.current.activeWorkspaceId === workspaceId) {
          await loadSessionMessages(workspaceId, nextSelected);
        }
      }
    } catch (error) {
      dispatch({
        type: "workspace/set-connection",
        workspaceId,
        connection: {
          status: "disconnected",
          message: describeError(error),
        },
      });
    }
  }, [getClient, loadSessionMessages]);

  const refreshWorkspace = useCallback(async (workspaceId: string) => {
    const client = getClient(workspaceId);
    if (!client) return;

    dispatch({
      type: "workspace/set-connection",
      workspaceId,
      connection: {
        status: "connecting",
        message: "Checking server status...",
      },
    });

    try {
      const health = unwrap<{ healthy?: boolean }>(await client.global.health());
      if (health?.healthy === false) {
        throw new Error("Server reported unhealthy state.");
      }

      dispatch({
        type: "workspace/set-connection",
        workspaceId,
        connection: {
          status: "connected",
          message: "Connected",
        },
      });
      await loadWorkspaceSessions(workspaceId);
    } catch (error) {
      dispatch({
        type: "workspace/set-connection",
        workspaceId,
        connection: {
          status: "disconnected",
          message: describeError(error),
        },
      });
    }
  }, [getClient, loadWorkspaceSessions]);

  const handleEvent = useCallback((workspaceId: string, event: { type: string; properties?: unknown }) => {
    if (event.type === "session.updated" || event.type === "session.created") {
      const info = (event.properties as { info?: Session } | undefined)?.info;
      if (info?.id) {
        dispatch({ type: "workspace/upsert-session", workspaceId, session: info });
      }
      return;
    }

    if (event.type === "session.deleted") {
      const info = (event.properties as { info?: Session } | undefined)?.info;
      if (info?.id) {
        dispatch({ type: "workspace/remove-session", workspaceId, sessionId: info.id });
      }
      return;
    }

    if (event.type === "session.status" || event.type === "session.idle") {
      const sessionId =
        event.type === "session.idle"
          ? (event.properties as { sessionID?: string } | undefined)?.sessionID
          : (event.properties as { sessionID?: string } | undefined)?.sessionID;
      if (sessionId) {
        dispatch({
          type: "session/set-status",
          sessionId,
          status:
            event.type === "session.idle" ||
            (event.properties as { status?: string } | undefined)?.status === "idle"
              ? "idle"
              : "busy",
        });
      }
      return;
    }

    if (event.type === "message.updated") {
      const message = (event.properties as { info?: Message } | undefined)?.info;
      if (!message?.id || !message.sessionID) return;

      dispatch({ type: "session/upsert-message", sessionId: message.sessionID, message });

      const current = stateRef.current;
      if (
        message.role === "assistant" &&
        (current.activeWorkspaceId !== workspaceId ||
          current.selectedSessionIdByWorkspaceId[workspaceId] !== message.sessionID)
      ) {
        dispatch({ type: "workspace/increment-unread", workspaceId });
      }
      return;
    }

    if (event.type === "message.removed") {
      const properties = event.properties as { sessionID?: string; messageID?: string } | undefined;
      if (properties?.sessionID && properties.messageID) {
        dispatch({
          type: "session/remove-message",
          sessionId: properties.sessionID,
          messageId: properties.messageID,
        });
      }
      return;
    }

    if (event.type === "message.part.updated") {
      const part = (event.properties as { part?: Part } | undefined)?.part;
      if (part?.id && part.sessionID && part.messageID) {
        dispatch({ type: "session/upsert-part", sessionId: part.sessionID, part });
      }
      return;
    }

    if (event.type === "message.part.delta") {
      const properties = event.properties as
        | {
            sessionID?: string;
            messageID?: string;
            partID?: string;
            field?: string;
            delta?: string;
          }
        | undefined;
      if (
        properties?.sessionID &&
        properties.messageID &&
        properties.partID &&
        properties.field &&
        typeof properties.delta === "string"
      ) {
        dispatch({
          type: "session/append-part-delta",
          sessionId: properties.sessionID,
          messageId: properties.messageID,
          partId: properties.partID,
          field: properties.field,
          delta: properties.delta,
        });
      }
      return;
    }

    if (event.type === "message.part.removed") {
      const properties = event.properties as
        | {
            sessionID?: string;
            messageID?: string;
            partID?: string;
          }
        | undefined;
      if (properties?.sessionID && properties.messageID && properties.partID) {
        dispatch({
          type: "session/remove-part",
          sessionId: properties.sessionID,
          messageId: properties.messageID,
          partId: properties.partID,
        });
      }
    }
  }, []);

  const connectWorkspace = useCallback((workspace: LabsWorkspace) => {
    if (!isDesktopRuntime()) {
      dispatch({
        type: "workspace/set-connection",
        workspaceId: workspace.id,
        connection: {
          status: "disconnected",
          message: "Web preview is visual-only. Use the Electron app for live connections.",
        },
      });
      return;
    }

    const normalizedBaseUrl = normalizeOpencodeBaseUrl(workspace.baseUrl);
    const configKey = `${normalizedBaseUrl}::${workspace.token?.trim() ?? ""}`;
    const existing = connectionsRef.current.get(workspace.id);
    if (existing && existing.configKey === configKey) {
      return;
    }

    existing?.cleanup();
    connectionsRef.current.delete(workspace.id);
    clientsRef.current.delete(workspace.id);

    if (!normalizedBaseUrl) {
      dispatch({
        type: "workspace/set-connection",
        workspaceId: workspace.id,
        connection: {
          status: "disconnected",
          message: "Enter a valid server URL.",
        },
      });
      return;
    }

    const client = createLabsClient({
      ...workspace,
      baseUrl: normalizedBaseUrl,
    });
    clientsRef.current.set(workspace.id, client);

    dispatch({
      type: "workspace/set-connection",
      workspaceId: workspace.id,
      connection: {
        status: "connecting",
        message: "Connecting...",
      },
    });

    const controller = new AbortController();
    let healthTimer = 0;
    let cancelled = false;

    const runHealthCheck = async () => {
      if (cancelled) return;
      await refreshWorkspace(workspace.id);
    };

    void runHealthCheck();
    healthTimer = window.setInterval(() => {
      void runHealthCheck();
    }, HEALTH_POLL_MS);

    void (async () => {
      let reconnectDelay = 1_000;
      while (!controller.signal.aborted) {
        try {
          const subscription = await client.event.subscribe(undefined, { signal: controller.signal });
          reconnectDelay = 1_000;
          for await (const raw of subscription.stream) {
            if (controller.signal.aborted) return;
            const event = normalizeLabsEvent(raw);
            if (event) handleEvent(workspace.id, event);
          }
        } catch (error) {
          if (controller.signal.aborted) return;
          dispatch({
            type: "workspace/set-connection",
            workspaceId: workspace.id,
            connection: {
              status: "disconnected",
              message: describeError(error),
            },
          });
          await new Promise((resolve) => setTimeout(resolve, reconnectDelay));
          reconnectDelay = Math.min(reconnectDelay * 2, 8_000);
        }
      }
    })();

    connectionsRef.current.set(workspace.id, {
      configKey,
      cleanup: () => {
        cancelled = true;
        controller.abort();
        window.clearInterval(healthTimer);
      },
    });
  }, [handleEvent, refreshWorkspace]);

  useEffect(() => {
    const nextIds = new Set(state.workspaces.map((workspace) => workspace.id));

    for (const [workspaceId, entry] of connectionsRef.current.entries()) {
      if (!nextIds.has(workspaceId)) {
        entry.cleanup();
        connectionsRef.current.delete(workspaceId);
        clientsRef.current.delete(workspaceId);
      }
    }

    state.workspaces.forEach((workspace) => connectWorkspace(workspace));

    return () => {
      for (const entry of connectionsRef.current.values()) {
        entry.cleanup();
      }
      connectionsRef.current.clear();
      clientsRef.current.clear();
    };
  }, [connectWorkspace, state.workspaces]);

  useEffect(() => {
    const workspaceId = state.activeWorkspaceId;
    if (!workspaceId) return;

    dispatch({ type: "workspace/clear-unread", workspaceId });

    const selectedSessionId =
      state.selectedSessionIdByWorkspaceId[workspaceId] ?? state.sessionsByWorkspaceId[workspaceId]?.[0]?.id ?? null;
    if (!selectedSessionId) return;

    if (!state.messagesBySessionId[selectedSessionId] && !state.loadingMessagesBySessionId[selectedSessionId]) {
      void loadSessionMessages(workspaceId, selectedSessionId);
    }
  }, [
    loadSessionMessages,
    state.activeWorkspaceId,
    state.loadingMessagesBySessionId,
    state.messagesBySessionId,
    state.selectedSessionIdByWorkspaceId,
    state.sessionsByWorkspaceId,
  ]);

  const saveWorkspace = useCallback((input: WorkspaceInput) => {
    const normalizedBaseUrl = normalizeOpencodeBaseUrl(input.baseUrl);
    const name = input.name?.trim() || workspaceNameFromUrl(normalizedBaseUrl) || "Untitled workspace";
    const id = input.id?.trim() || `workspace-${randomId()}`;
    const existing = stateRef.current.workspaces.find((workspace) => workspace.id === id) ?? null;

    const workspace: LabsWorkspace = {
      id,
      name,
      baseUrl: normalizedBaseUrl,
      token: input.token?.trim() || null,
      color: existing?.color ?? pickWorkspaceColor(id),
      template: existing?.template ?? null,
    };

    dispatch({ type: "workspace/upsert", workspace });
    dispatch({ type: "workspace/set-active", workspaceId: id });
    return id;
  }, []);

  const removeWorkspace = useCallback((workspaceId: string) => {
    const existing = connectionsRef.current.get(workspaceId);
    existing?.cleanup();
    connectionsRef.current.delete(workspaceId);
    clientsRef.current.delete(workspaceId);
    dispatch({ type: "workspace/remove", workspaceId });
  }, []);

  const setActiveWorkspace = useCallback((workspaceId: string) => {
    dispatch({ type: "workspace/set-active", workspaceId });
  }, []);

  const selectSession = useCallback(async (workspaceId: string, sessionId: string) => {
    dispatch({ type: "workspace/set-selected-session", workspaceId, sessionId });
    dispatch({ type: "workspace/clear-unread", workspaceId });
    await loadSessionMessages(workspaceId, sessionId);
  }, [loadSessionMessages]);

  const createSession = useCallback(async (
    workspaceId: string,
    options?: { title?: string; seedMessages?: SeedMessage[] },
  ) => {
    const client = getClient(workspaceId);
    if (!client) {
      dispatch({ type: "app/set-error", error: "Add a valid workspace URL before creating a chat." });
      return null;
    }

    try {
      const created = unwrap<Session>(await client.session.create({}));
      let session = created;
      const nextTitle = options?.title?.trim();
      if (nextTitle) {
        try {
          session = unwrap<Session>(await client.session.update({ sessionID: created.id, title: nextTitle }));
        } catch {
          session = {
            ...created,
            title: nextTitle,
          } as Session;
        }
      }

      dispatch({ type: "workspace/upsert-session", workspaceId, session });
      dispatch({ type: "workspace/set-selected-session", workspaceId, sessionId: session.id });
      dispatch({ type: "workspace/set-active", workspaceId });
      dispatch({ type: "session/set-messages", sessionId: session.id, messages: [] });

      if (options?.seedMessages?.length) {
        dispatch({
          type: "session/set-seed-messages",
          sessionId: session.id,
          messages: options.seedMessages,
        });
      }

      return session.id;
    } catch (error) {
      dispatch({ type: "app/set-error", error: describeError(error) });
      return null;
    }
  }, [getClient]);

  const sendPrompt = useCallback(async (
    workspaceId: string,
    sessionId: string | null,
    prompt: string,
  ) => {
    const trimmed = prompt.trim();
    if (!trimmed) return sessionId;

    const client = getClient(workspaceId);
    if (!client) {
      dispatch({ type: "app/set-error", error: "Connect a workspace before sending a prompt." });
      return null;
    }

    let resolvedSessionId = sessionId;
    if (!resolvedSessionId) {
      resolvedSessionId = await createSession(workspaceId);
    }
    if (!resolvedSessionId) return null;

    dispatch({ type: "session/set-status", sessionId: resolvedSessionId, status: "busy" });

    try {
      await unwrap(
        await client.session.promptAsync({
          sessionID: resolvedSessionId,
          parts: [{ type: "text", text: trimmed }],
        }),
      );
      return resolvedSessionId;
    } catch (error) {
      dispatch({ type: "session/set-status", sessionId: resolvedSessionId, status: "idle" });
      dispatch({ type: "app/set-error", error: describeError(error) });
      return null;
    }
  }, [createSession, getClient]);

  const abortSession = useCallback(async (workspaceId: string, sessionId: string | null) => {
    if (!sessionId) return;
    const client = getClient(workspaceId);
    if (!client) return;

    try {
      await client.session.abort({ sessionID: sessionId });
      dispatch({ type: "session/set-status", sessionId, status: "idle" });
    } catch (error) {
      dispatch({ type: "app/set-error", error: describeError(error) });
    }
  }, [getClient]);

  const applyTemplateToWorkspace = useCallback(async (workspaceId: string, template: LabsTemplateProfile) => {
    dispatch({ type: "template/upsert", template });

    const binding: WorkspaceTemplateBinding = {
      id: template.id,
      source: template.source,
      sourceUrl: template.sourceUrl,
      dataUrl: template.dataUrl,
      name: template.name,
      description: template.description,
      preset: template.preset,
      recommendedDefaults: template.recommendedDefaults,
      importedAt: Date.now(),
      blueprint: {
        ...template.blueprint,
        materialized: [],
      },
    };

    dispatch({
      type: "workspace/bind-template",
      workspaceId,
      template: binding,
    });

    const client = getClient(workspaceId);
    if (!client) {
      dispatch({
        type: "app/set-error",
        error: "Template saved. Connect the workspace to materialize the starter chats.",
      });
      return;
    }

    const existingWorkspace = getWorkspace(workspaceId);
    const existingMaterialized = existingWorkspace?.template?.blueprint.materialized ?? [];
    const createdOrExisting: Array<{ templateId: string; sessionId: string }> = [];

    for (const templateSession of template.blueprint.sessions) {
      const existing = existingMaterialized.find((item) => item.templateId === templateSession.id);
      if (existing) {
        createdOrExisting.push(existing);
        continue;
      }

      const sessionId = await createSession(workspaceId, {
        title: templateSession.title,
        seedMessages: templateSession.messages,
      });
      if (!sessionId) continue;

      dispatch({
        type: "workspace/record-materialized",
        workspaceId,
        templateId: templateSession.id,
        sessionId,
      });
      createdOrExisting.push({ templateId: templateSession.id, sessionId });
    }

    const preferredTemplate =
      template.blueprint.sessions.find((session) => session.openOnFirstLoad) ??
      template.blueprint.sessions[0] ??
      null;

    if (preferredTemplate) {
      const preferred = createdOrExisting.find((item) => item.templateId === preferredTemplate.id);
      if (preferred) {
        await selectSession(workspaceId, preferred.sessionId);
      }
    }
  }, [createSession, getClient, getWorkspace, selectSession]);

  const clearError = useCallback(() => {
    dispatch({ type: "app/set-error", error: null });
  }, []);

  const openTemplateActionForStarter = useCallback(
    (_workspaceId: string, action: string | undefined) => {
      if (!action) return null;
      if (action === "open-template-library") return "template-library";
      return null;
    },
    [],
  );

  const activeWorkspace = useMemo(
    () => state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId) ?? null,
    [state.activeWorkspaceId, state.workspaces],
  );

  return {
    state,
    activeWorkspace,
    activeSessions: activeWorkspace ? state.sessionsByWorkspaceId[activeWorkspace.id] ?? [] : [],
    selectedSessionId: activeWorkspace
      ? state.selectedSessionIdByWorkspaceId[activeWorkspace.id] ?? null
      : null,
    saveWorkspace,
    removeWorkspace,
    setActiveWorkspace,
    selectSession,
    createSession,
    sendPrompt,
    abortSession,
    applyTemplateToWorkspace,
    clearError,
    openTemplateActionForStarter,
    refreshWorkspace,
  };
}
