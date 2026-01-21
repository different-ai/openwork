import { batch, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";

import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client";

import type {
  Client,
  MessageInfo,
  MessageWithParts,
  ModelRef,
  OpencodeEvent,
  PendingPermission,
  PlaceholderAssistantMessage,
  TodoItem,
} from "../types";
import { addOpencodeCacheHint, modelFromUserMessage, normalizeEvent, normalizeSessionStatus } from "../utils";
import { unwrap } from "../lib/opencode";

export type SessionModelState = {
  overrides: Record<string, ModelRef>;
  resolved: Record<string, ModelRef>;
};

export type SessionStore = ReturnType<typeof createSessionStore>;

type StoreState = {
  sessions: Session[];
  sessionStatus: Record<string, string>;
  messages: Record<string, MessageInfo[]>;
  parts: Record<string, Part[]>;
  todos: Record<string, TodoItem[]>;
  pendingPermissions: PendingPermission[];
  events: OpencodeEvent[];
};

const sortById = <T extends { id: string }>(list: T[]) =>
  list.slice().sort((a, b) => a.id.localeCompare(b.id));

const createPlaceholderMessage = (part: Part): PlaceholderAssistantMessage => ({
  id: part.messageID,
  sessionID: part.sessionID,
  role: "assistant",
  time: { created: Date.now() },
  parentID: "",
  modelID: "",
  providerID: "",
  mode: "",
  agent: "",
  path: { cwd: "", root: "" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
});

const upsertSession = (list: Session[], next: Session) => {
  const index = list.findIndex((session) => session.id === next.id);
  if (index === -1) return sortById([...list, next]);
  const copy = list.slice();
  copy[index] = next;
  return copy;
};

const removeSession = (list: Session[], sessionID: string) => list.filter((session) => session.id !== sessionID);

const upsertMessageInfo = (list: MessageInfo[], next: MessageInfo) => {
  const index = list.findIndex((message) => message.id === next.id);
  if (index === -1) return sortById([...list, next]);
  const copy = list.slice();
  copy[index] = next;
  return copy;
};

const removeMessageInfo = (list: MessageInfo[], messageID: string) =>
  list.filter((message) => message.id !== messageID);

const upsertPartInfo = (list: Part[], next: Part) => {
  const index = list.findIndex((part) => part.id === next.id);
  if (index === -1) return sortById([...list, next]);
  const copy = list.slice();
  copy[index] = next;
  return copy;
};

const removePartInfo = (list: Part[], partID: string) => list.filter((part) => part.id !== partID);

export function createSessionStore(options: {
  client: () => Client | null;
  selectedSessionId: () => string | null;
  setSelectedSessionId: (id: string | null) => void;
  sessionModelState: () => SessionModelState;
  setSessionModelState: (updater: (current: SessionModelState) => SessionModelState) => SessionModelState;
  lastUserModelFromMessages: (messages: MessageWithParts[]) => ModelRef | null;
  developerMode: () => boolean;
  setError: (message: string | null) => void;
  setSseConnected: (connected: boolean) => void;
}) {
  const [store, setStore] = createStore<StoreState>({
    sessions: [],
    sessionStatus: {},
    messages: {},
    parts: {},
    todos: {},
    pendingPermissions: [],
    events: [],
  });
  const [permissionReplyBusy, setPermissionReplyBusy] = createSignal(false);

  const addError = (error: unknown, fallback = "Unknown error") => {
    const message = error instanceof Error ? error.message : fallback;
    if (!message) return;
    options.setError(addOpencodeCacheHint(message));
  };

  const withTimeout = async <T,>(promise: Promise<T>, ms: number, label: string) => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), ms);
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  };

  const sessions = () => store.sessions;
  const sessionStatusById = () => store.sessionStatus;
  const pendingPermissions = () => store.pendingPermissions;
  const events = () => store.events;

  const selectedSession = createMemo(() => {
    const id = options.selectedSessionId();
    if (!id) return null;
    return store.sessions.find((session) => session.id === id) ?? null;
  });

  const selectedSessionStatus = createMemo(() => {
    const id = options.selectedSessionId();
    if (!id) return "idle";
    return store.sessionStatus[id] ?? "idle";
  });

  const messages = createMemo<MessageWithParts[]>(() => {
    const id = options.selectedSessionId();
    if (!id) return [];
    const list = store.messages[id] ?? [];
    return list.map((info) => ({ info, parts: store.parts[info.id] ?? [] }));
  });

  const todos = createMemo<TodoItem[]>(() => {
    const id = options.selectedSessionId();
    if (!id) return [];
    return store.todos[id] ?? [];
  });

  async function loadSessions(scopeRoot?: string) {
    const c = options.client();
    if (!c) return;
    const list = unwrap(await c.session.list());
    const root = (scopeRoot ?? "").trim();
    const filtered = root ? list.filter((session) => session.directory === root) : list;
    setStore("sessions", reconcile(sortById(filtered), { key: "id" }));
  }

  async function refreshPendingPermissions() {
    const c = options.client();
    if (!c) return;
    const list = unwrap(await c.permission.list());
    const now = Date.now();
    const byId = new Map(store.pendingPermissions.map((perm) => [perm.id, perm] as const));
    const next = list.map((perm) => ({ ...perm, receivedAt: byId.get(perm.id)?.receivedAt ?? now }));
    setStore("pendingPermissions", next);
  }

  function setMessagesForSession(sessionID: string, list: MessageWithParts[]) {
    const infos = list
      .map((msg) => msg.info)
      .filter((info) => !!info?.id)
      .map((info) => info as MessageInfo);

    batch(() => {
      setStore("messages", sessionID, reconcile(sortById(infos), { key: "id" }));
      for (const message of list) {
        const parts = message.parts.filter((part) => !!part?.id);
        setStore("parts", message.info.id, reconcile(sortById(parts), { key: "id" }));
      }
    });
  }

  async function selectSession(sessionID: string) {
    const c = options.client();
    if (!c) return;

    const runId = (() => {
      const key = "__openwork_select_session_run__";
      const w = window as typeof window & { [key]?: number };
      w[key] = (w[key] ?? 0) + 1;
      return w[key];
    })();
    const mark = (() => {
      const start = Date.now();
      return (label: string) => console.log(`[selectSession run ${runId}] ${label} (+${Date.now() - start}ms)`);
    })();

    mark("start");
    options.setSelectedSessionId(sessionID);
    options.setError(null);

    mark("checking health");
    try {
      await withTimeout(c.global.health(), 3000, "health");
      mark("health ok");
    } catch {
      mark("health FAILED");
      throw new Error("Server connection lost. Please reload.");
    }

    mark("calling session.messages");
    const msgs = unwrap(await withTimeout(c.session.messages({ sessionID }), 12000, "session.messages"));
    mark("session.messages done");
    if (options.selectedSessionId() !== sessionID) {
      mark("aborting: selection changed before messages applied");
      return;
    }
    setMessagesForSession(sessionID, msgs);

    const model = options.lastUserModelFromMessages(msgs);
    if (model) {
      if (options.selectedSessionId() !== sessionID) {
        mark("aborting: selection changed before model applied");
        return;
      }
      options.setSessionModelState((current) => ({
        overrides: current.overrides,
        resolved: { ...current.resolved, [sessionID]: model },
      }));

      options.setSessionModelState((current) => {
        if (!current.overrides[sessionID]) return current;
        const copy = { ...current.overrides };
        delete copy[sessionID];
        return { ...current, overrides: copy };
      });
    }

    try {
      mark("calling session.todo");
      const list = unwrap(await withTimeout(c.session.todo({ sessionID }), 8000, "session.todo"));
      mark("session.todo done");
      if (options.selectedSessionId() !== sessionID) {
        mark("aborting: selection changed before todos applied");
        return;
      }
      setStore("todos", sessionID, list);
    } catch {
      mark("session.todo failed/timeout");
      setStore("todos", sessionID, []);
    }

    try {
      mark("calling permission.list");
      await withTimeout(refreshPendingPermissions(), 6000, "permission.list");
      mark("permission.list done");
      if (options.selectedSessionId() !== sessionID) {
        mark("aborting: selection changed before permissions applied");
        return;
      }
    } catch {
      mark("permission.list failed/timeout");
    }

    mark("selectSession complete");
  }

  async function respondPermission(requestID: string, reply: "once" | "always" | "reject") {
    const c = options.client();
    if (!c || permissionReplyBusy()) return;

    setPermissionReplyBusy(true);
    options.setError(null);

    try {
      unwrap(await c.permission.reply({ requestID, reply }));
      await refreshPendingPermissions();
    } catch (e) {
      addError(e);
    } finally {
      setPermissionReplyBusy(false);
    }
  }

  const setSessions = (next: Session[]) => {
    setStore("sessions", reconcile(sortById(next), { key: "id" }));
  };

  const setSessionStatusById = (next: Record<string, string>) => {
    setStore("sessionStatus", next);
  };

  const setMessages = (next: MessageWithParts[]) => {
    const id = options.selectedSessionId();
    if (!id) return;
    setMessagesForSession(id, next);
  };

  const setTodos = (next: TodoItem[]) => {
    const id = options.selectedSessionId();
    if (!id) return;
    setStore("todos", id, next);
  };

  const setPendingPermissions = (next: PendingPermission[]) => {
    setStore("pendingPermissions", next);
  };

  const activePermission = createMemo(() => {
    const id = options.selectedSessionId();
    if (id) {
      return store.pendingPermissions.find((perm) => perm.sessionID === id) ?? null;
    }
    return store.pendingPermissions[0] ?? null;
  });

  const applyEvent = async (event: OpencodeEvent) => {
    if (event.type === "server.connected") {
      options.setSseConnected(true);
    }

    if (options.developerMode()) {
      setStore("events", (current) => {
        const next = [{ type: event.type, properties: event.properties }, ...current];
        return next.slice(0, 150);
      });
    }

    if (event.type === "session.updated" || event.type === "session.created") {
      if (event.properties && typeof event.properties === "object") {
        const record = event.properties as Record<string, unknown>;
        if (record.info && typeof record.info === "object") {
          const info = record.info as Session;
          setStore("sessions", (current) => upsertSession(current, info));
        }
      }
    }

    if (event.type === "session.deleted") {
      if (event.properties && typeof event.properties === "object") {
        const record = event.properties as Record<string, unknown>;
        const info = record.info as Session | undefined;
        if (info?.id) {
          setStore("sessions", (current) => removeSession(current, info.id));
        }
      }
    }

    if (event.type === "session.status") {
      if (event.properties && typeof event.properties === "object") {
        const record = event.properties as Record<string, unknown>;
        const sessionID = typeof record.sessionID === "string" ? record.sessionID : null;
        if (sessionID) {
          setStore("sessionStatus", sessionID, normalizeSessionStatus(record.status));
        }
      }
    }

    if (event.type === "session.idle") {
      if (event.properties && typeof event.properties === "object") {
        const record = event.properties as Record<string, unknown>;
        const sessionID = typeof record.sessionID === "string" ? record.sessionID : null;
        if (sessionID) {
          setStore("sessionStatus", sessionID, "idle");
        }
      }
    }

    if (event.type === "message.updated") {
      if (event.properties && typeof event.properties === "object") {
        const record = event.properties as Record<string, unknown>;
        if (record.info && typeof record.info === "object") {
          const info = record.info as Message;
          const model = modelFromUserMessage(info as MessageInfo);
          if (model) {
            options.setSessionModelState((current) => ({
              overrides: current.overrides,
              resolved: { ...current.resolved, [info.sessionID]: model },
            }));

            options.setSessionModelState((current) => {
              if (!current.overrides[info.sessionID]) return current;
              const copy = { ...current.overrides };
              delete copy[info.sessionID];
              return { ...current, overrides: copy };
            });
          }

          setStore("messages", info.sessionID, (current = []) => upsertMessageInfo(current, info));
        }
      }
    }

    if (event.type === "message.removed") {
      if (event.properties && typeof event.properties === "object") {
        const record = event.properties as Record<string, unknown>;
        const sessionID = typeof record.sessionID === "string" ? record.sessionID : null;
        const messageID = typeof record.messageID === "string" ? record.messageID : null;
        if (sessionID && messageID) {
          setStore("messages", sessionID, (current = []) => removeMessageInfo(current, messageID));
          setStore("parts", messageID, []);
        }
      }
    }

    if (event.type === "message.part.updated") {
      if (event.properties && typeof event.properties === "object") {
        const record = event.properties as Record<string, unknown>;
        if (record.part && typeof record.part === "object") {
          const part = record.part as Part;
          const delta = typeof record.delta === "string" ? record.delta : null;

          setStore(
            produce((draft: StoreState) => {
              const list = draft.messages[part.sessionID] ?? [];
              if (!list.find((message) => message.id === part.messageID)) {
                draft.messages[part.sessionID] = upsertMessageInfo(list, createPlaceholderMessage(part));
              }

              const parts = draft.parts[part.messageID] ?? [];
              const existingIndex = parts.findIndex((item) => item.id === part.id);

              if (delta && part.type === "text" && existingIndex !== -1) {
                const existing = parts[existingIndex] as Part & { text?: string };
                if (typeof existing.text === "string" && !existing.text.endsWith(delta)) {
                  const next = { ...existing, text: `${existing.text}${delta}` } as Part;
                  parts[existingIndex] = next;
                  draft.parts[part.messageID] = parts;
                  return;
                }
              }

              draft.parts[part.messageID] = upsertPartInfo(parts, part);
            }),
          );
        }
      }
    }

    if (event.type === "message.part.removed") {
      if (event.properties && typeof event.properties === "object") {
        const record = event.properties as Record<string, unknown>;
        const messageID = typeof record.messageID === "string" ? record.messageID : null;
        const partID = typeof record.partID === "string" ? record.partID : null;
        if (messageID && partID) {
          setStore("parts", messageID, (current = []) => removePartInfo(current, partID));
        }
      }
    }

    if (event.type === "todo.updated") {
      if (event.properties && typeof event.properties === "object") {
        const record = event.properties as Record<string, unknown>;
        const sessionID = typeof record.sessionID === "string" ? record.sessionID : null;
        if (sessionID && Array.isArray(record.todos)) {
          setStore("todos", sessionID, record.todos as TodoItem[]);
        }
      }
    }

    if (event.type === "permission.asked" || event.type === "permission.replied") {
      try {
        await refreshPendingPermissions();
      } catch {
        // ignore
      }
    }
  };

  createEffect(() => {
    const c = options.client();
    if (!c) return;

    const controller = new AbortController();
    let cancelled = false;

    let queue: Array<OpencodeEvent | undefined> = [];
    const coalesced = new Map<string, number>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = 0;

    const keyForEvent = (event: OpencodeEvent) => {
      if (event.type === "session.status" || event.type === "session.idle") {
        const record = event.properties as Record<string, unknown> | undefined;
        const sessionID = typeof record?.sessionID === "string" ? record.sessionID : "";
        return sessionID ? `${event.type}:${sessionID}` : undefined;
      }
      if (event.type === "message.part.updated") {
        const record = event.properties as Record<string, unknown> | undefined;
        const part = record?.part as Part | undefined;
        if (part?.messageID && part.id) {
          return `message.part.updated:${part.messageID}:${part.id}`;
        }
      }
      if (event.type === "todo.updated") {
        const record = event.properties as Record<string, unknown> | undefined;
        const sessionID = typeof record?.sessionID === "string" ? record.sessionID : "";
        return sessionID ? `todo.updated:${sessionID}` : undefined;
      }
      return undefined;
    };

    const flush = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;

      const eventsToApply = queue;
      queue = [];
      coalesced.clear();
      if (eventsToApply.length === 0) return;

      last = Date.now();
      batch(() => {
        for (const event of eventsToApply) {
          if (!event) continue;
          void applyEvent(event);
        }
      });
    };

    const schedule = () => {
      if (timer) return;
      const elapsed = Date.now() - last;
      timer = setTimeout(flush, Math.max(0, 16 - elapsed));
    };

    (async () => {
      try {
        const sub = await c.event.subscribe(undefined, { signal: controller.signal });
        let yielded = Date.now();

        for await (const raw of sub.stream) {
          if (cancelled) break;

          const event = normalizeEvent(raw);
          if (!event) continue;

          const key = keyForEvent(event);
          if (key) {
            const existing = coalesced.get(key);
            if (existing !== undefined) {
              queue[existing] = undefined;
            }
            coalesced.set(key, queue.length);
          }

          queue.push(event);
          schedule();

          if (Date.now() - yielded < 8) continue;
          yielded = Date.now();
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      } catch (e) {
        if (cancelled) return;

        const message = e instanceof Error ? e.message : String(e);
        if (message.toLowerCase().includes("abort")) return;
        options.setError(message);
      }
    })();

    onCleanup(() => {
      cancelled = true;
      controller.abort();
      flush();
    });
  });

  return {
    sessions,
    sessionStatusById,
    selectedSession,
    selectedSessionStatus,
    messages,
    todos,
    pendingPermissions,
    permissionReplyBusy,
    events,
    activePermission,
    loadSessions,
    refreshPendingPermissions,
    selectSession,
    respondPermission,
    setSessions,
    setSessionStatusById,
    setMessages,
    setTodos,
    setPendingPermissions,
  };
}
