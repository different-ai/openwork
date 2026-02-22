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
  PendingQuestion,
  PlaceholderAssistantMessage,
  ReloadReason,
  ReloadTrigger,
  TodoItem,
} from "../types";
import {
  addOpencodeCacheHint,
  modelFromUserMessage,
  normalizeDirectoryPath,
  normalizeEvent,
  normalizeSessionStatus,
  safeStringify,
} from "../utils";
import { unwrap } from "../lib/opencode";
import { finishPerf, perfNow, recordPerfLog } from "../lib/perf-log";

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
  pendingQuestions: PendingQuestion[];
  events: OpencodeEvent[];
};

const sortById = <T extends { id: string }>(list: T[]) =>
  list.slice().sort((a, b) => a.id.localeCompare(b.id));

const sessionActivity = (session: Session) =>
  session.time?.updated ?? session.time?.created ?? 0;

const sortSessionsByActivity = (list: Session[]) =>
  list
    .slice()
    .sort((a, b) => {
      const delta = sessionActivity(b) - sessionActivity(a);
      if (delta !== 0) return delta;
      return a.id.localeCompare(b.id);
    });

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
  if (index === -1) return sortSessionsByActivity([...list, next]);
  const copy = list.slice();
  copy[index] = next;
  return sortSessionsByActivity(copy);
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
  activeWorkspaceRoot: () => string;
  selectedSessionId: () => string | null;
  setSelectedSessionId: (id: string | null) => void;
  sessionModelState: () => SessionModelState;
  setSessionModelState: (updater: (current: SessionModelState) => SessionModelState) => SessionModelState;
  lastUserModelFromMessages: (messages: MessageWithParts[]) => ModelRef | null;
  developerMode: () => boolean;
  setError: (message: string | null) => void;
  setSseConnected: (connected: boolean) => void;
  markReloadRequired?: (reason: ReloadReason, trigger?: ReloadTrigger) => void;
  onHotReloadApplied?: () => void;
}) {

  const sessionDebugEnabled = () => options.developerMode();

  const sessionDebug = (label: string, payload?: unknown) => {
    if (!sessionDebugEnabled()) return;
    try {
      if (payload === undefined) {
        console.log(`[WSDBG] ${label}`);
      } else {
        console.log(`[WSDBG] ${label}`, payload);
      }
    } catch {
      // ignore
    }
  };
  const MAX_RELOAD_DETECTION_KEYS = 5000;

  const [store, setStore] = createStore<StoreState>({
    sessions: [],
    sessionStatus: {},
    messages: {},
    parts: {},
    todos: {},
    pendingPermissions: [],
    pendingQuestions: [],
    events: [],
  });
  const [permissionReplyBusy, setPermissionReplyBusy] = createSignal(false);
  const reloadDetectionSet = new Set<string>();
  const invalidToolDetectionSet = new Set<string>();

  const skillPathPattern = /[\\/]\.opencode[\\/](skill|skills)[\\/]/i;
  const skillNamePattern = /[\\/]\.opencode[\\/](?:skill|skills)[\\/]+([^\\/]+)/i;
  const commandPathPattern = /[\\/]\.opencode[\\/](command|commands)[\\/]/i;
  const commandNamePattern = /[\\/]\.opencode[\\/](?:command|commands)[\\/]+([^\\/]+)/i;
  const agentPathPattern = /[\\/]\.opencode[\\/](agent|agents)[\\/]/i;
  const agentNamePattern = /[\\/]\.opencode[\\/](?:agent|agents)[\\/]+([^\\/]+)/i;
  const opencodeConfigPattern = /(?:^|[\\/])opencode\.jsonc?\b/i;
  const opencodePathPattern = /(?:^|[\\/])\.opencode[\\/]/i;
  const openworkConfigPattern = /[\\/]\.opencode[\\/]openwork\.json\b/i;
  const mutatingTools = new Set(["write", "edit", "apply_patch"]);

  const extractSearchText = (value: unknown) => {
    if (!value) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number") return String(value);
    return safeStringify(value);
  };

  const detectReloadReason = (value: unknown): ReloadReason | null => {
    const text = extractSearchText(value);
    if (!text) return null;
    if (openworkConfigPattern.test(text)) return null;
    if (skillPathPattern.test(text)) return "skills";
    if (commandPathPattern.test(text)) return "commands";
    if (agentPathPattern.test(text)) return "agents";
    if (opencodeConfigPattern.test(text)) return "config";
    if (opencodePathPattern.test(text)) return "config";
    return null;
  };

  const detectReloadTriggerFromText = (text: string): ReloadTrigger | null => {
    if (openworkConfigPattern.test(text)) {
      return null;
    }
    if (skillPathPattern.test(text)) {
      const match = text.match(skillNamePattern);
      return {
        type: "skill",
        name: match?.[1],
        action: "updated",
        path: match?.[0],
      };
    }

    if (commandPathPattern.test(text)) {
      const match = text.match(commandNamePattern);
      const raw = match?.[1];
      const name = raw ? raw.replace(/\.md$/i, "") : undefined;
      return {
        type: "command",
        name,
        action: "updated",
        path: match?.[0],
      };
    }

    if (agentPathPattern.test(text)) {
      const match = text.match(agentNamePattern);
      return {
        type: "agent",
        name: match?.[1],
        action: "updated",
        path: match?.[0],
      };
    }

    if (opencodeConfigPattern.test(text) || opencodePathPattern.test(text)) {
      return {
        type: "config",
        action: "updated",
      };
    }
    return null;
  };

  const detectReloadReasonDeep = (value: unknown): ReloadReason | null => {
    if (!value) return null;
    if (typeof value === "string" || typeof value === "number") {
      return detectReloadReason(value);
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        const reason = detectReloadReasonDeep(entry);
        if (reason) return reason;
      }
      return null;
    }
    if (typeof value === "object") {
      for (const entry of Object.values(value as Record<string, unknown>)) {
        const reason = detectReloadReasonDeep(entry);
        if (reason) return reason;
      }
    }
    return null;
  };

  const detectReloadTriggerDeep = (value: unknown): ReloadTrigger | null => {
    if (!value) return null;
    if (typeof value === "string" || typeof value === "number") {
      return detectReloadTriggerFromText(String(value));
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        const trigger = detectReloadTriggerDeep(entry);
        if (trigger) return trigger;
      }
      return null;
    }
    if (typeof value === "object") {
      for (const entry of Object.values(value as Record<string, unknown>)) {
        const trigger = detectReloadTriggerDeep(entry);
        if (trigger) return trigger;
      }
    }
    return null;
  };

  const detectReloadFromPart = (part: Part): { reason: ReloadReason; trigger?: ReloadTrigger } | null => {
    if (part.type !== "tool") return null;
    const record = part as Record<string, unknown>;
    const toolName = typeof record.tool === "string" ? record.tool : "";
    if (!mutatingTools.has(toolName)) return null;
    const state = (record.state ?? {}) as Record<string, unknown>;
    const reason =
      detectReloadReasonDeep(state.input) ||
      detectReloadReasonDeep(state.patch) ||
      detectReloadReasonDeep(state.diff);
    if (!reason) return null;
    const trigger =
      detectReloadTriggerDeep(state.input) ||
      detectReloadTriggerDeep(state.patch) ||
      detectReloadTriggerDeep(state.diff);
    return { reason, trigger: trigger ?? undefined };
  };

  const maybeMarkReloadRequired = (part: Part) => {
    if (!options.markReloadRequired) return;
    if (!part?.id || !part.messageID) return;

    const root = normalizeDirectoryPath(options.activeWorkspaceRoot());
    if (root) {
      const session = store.sessions.find((candidate) => candidate.id === part.sessionID) ?? null;
      const sessionRoot = normalizeDirectoryPath(session?.directory ?? "");
      if (!sessionRoot || sessionRoot !== root) {
        return;
      }
    }

    const key = `${part.messageID}:${part.id}`;
    if (reloadDetectionSet.has(key)) return;
    const detection = detectReloadFromPart(part);
    if (!detection) return;
    reloadDetectionSet.add(key);
    options.markReloadRequired(detection.reason, detection.trigger);
  };

  const toolErrorText = (part: Part) => {
    if (part.type !== "tool") return "";
    const record = part as any;
    const state = (record.state ?? {}) as Record<string, unknown>;
    const title = typeof state.title === "string" ? state.title : "";
    const error = typeof state.error === "string" ? state.error : "";
    const detail = typeof state.detail === "string" ? state.detail : "";
    return [title, error, detail].filter(Boolean).join("\n");
  };

  const isInvalidToolError = (part: Part) => {
    if (part.type !== "tool") return false;
    const haystack = toolErrorText(part).toLowerCase();
    if (!haystack) return false;
    return (
      haystack.includes("invalid tool") ||
      haystack.includes("model tried to call") ||
      haystack.includes("unavailable tool") ||
      haystack.includes("unknown tool") ||
      haystack.includes("tool not found")
    );
  };

  const invalidToolNextStepHint = (part: Part) => {
    const record = part as any;
    const name = typeof record.tool === "string" ? record.tool : "";
    const lower = name.toLowerCase();
    if (lower.includes("browser") || lower.includes("chrome") || lower.includes("devtools")) {
      return "OpenWork browser automation isn't set up yet. Go to Plugins and ensure the browser plugin/extension is installed and connected, then retry.";
    }
    return "Try again, or switch to an agent/prompt that only uses available tools in this worker.";
  };

  const maybeHandleInvalidToolError = (part: Part) => {
    if (!options.setError) return;
    if (!isInvalidToolError(part)) return;
    if (!part?.id || !part.messageID) return;

    const key = `${part.messageID}:${part.id}`;
    if (invalidToolDetectionSet.has(key)) return;
    invalidToolDetectionSet.add(key);

    // Ensure the UI doesn't get stuck in a "Responding" state when the model
    // tries to call a tool that isn't available.
    if (part.sessionID) {
      setStore("sessionStatus", part.sessionID, "idle");
    }

    const record = part as any;
    const tool = typeof record.tool === "string" && record.tool.trim() ? record.tool.trim() : "(unknown tool)";
    const hint = invalidToolNextStepHint(part);
    options.setError(`Invalid tool call: ${tool}.\n\n${hint}`);
  };

  const addError = (error: unknown, fallback = "Unknown error") => {
    const message = error instanceof Error ? error.message : fallback;
    if (!message) return;
    options.setError(addOpencodeCacheHint(message));
  };

  const truncateErrorField = (value: unknown, max = 500) => {
    if (typeof value !== "string") return null;
    const text = value.trim();
    if (!text) return null;
    if (text.length <= max) return text;
    return `${text.slice(0, Math.max(0, max - 3))}...`;
  };

  const inferHttpStatus = (value: string | null) => {
    if (!value) return null;
    const match = value.match(/\b(?:status|code|http)\s*(?:=|:)?\s*(401|403|429)\b/i) ||
      value.match(/\b(401|403|429)\b/);
    if (!match) return null;
    const parsed = Number.parseInt(match[1], 10);
    if (!Number.isFinite(parsed)) return null;
    return parsed;
  };

  const getNestedRecords = (source: Record<string, unknown>) => {
    const records: Record<string, unknown>[] = [source];
    const data = source.data;
    if (data && typeof data === "object") records.push(data as Record<string, unknown>);
    const cause = source.cause;
    if (cause && typeof cause === "object") {
      const causeRecord = cause as Record<string, unknown>;
      records.push(causeRecord);
      const causeData = causeRecord.data;
      if (causeData && typeof causeData === "object") records.push(causeData as Record<string, unknown>);
    }
    return records;
  };

  const firstStringField = (records: Record<string, unknown>[], keys: string[]) => {
    for (const record of records) {
      for (const key of keys) {
        const value = truncateErrorField(record[key], 800);
        if (value) return value;
      }
    }
    return null;
  };

  const firstNumberField = (records: Record<string, unknown>[], keys: string[]) => {
    for (const record of records) {
      for (const key of keys) {
        const value = record[key];
        if (typeof value !== "number" || !Number.isFinite(value)) continue;
        return value;
      }
    }
    return null;
  };

  const firstBooleanField = (records: Record<string, unknown>[], keys: string[]) => {
    for (const record of records) {
      for (const key of keys) {
        const value = record[key];
        if (typeof value !== "boolean") continue;
        return value;
      }
    }
    return null;
  };

  const formatSessionError = (errorObj: Record<string, unknown>) => {
    const records = getNestedRecords(errorObj);
    const errorName = typeof errorObj.name === "string" ? errorObj.name : "UnknownError";
    const rawMessage = firstStringField(records, ["message", "detail", "reason"]);
    const responseBody = firstStringField(records, ["responseBody", "body", "response"]);
    const providerID = firstStringField(records, ["providerID", "providerId", "provider"]);
    const code = firstStringField(records, ["code", "errorCode"]);
    const statusCode = firstNumberField(records, ["statusCode", "status"]);
    const inferred = inferHttpStatus(rawMessage) ?? inferHttpStatus(responseBody);
    const effectiveStatus = statusCode ?? inferred;
    const isRetryable = firstBooleanField(records, ["isRetryable", "retryable"]);

    const heading = (() => {
      if (errorName === "ProviderAuthError") return `Provider auth error${providerID ? ` (${providerID})` : ""}`;
      if (errorName === "APIError") {
        if (effectiveStatus === 401 || effectiveStatus === 403) return "Authentication failed";
        if (effectiveStatus === 429) return "Rate limit exceeded";
        return `API error${effectiveStatus ? ` (${effectiveStatus})` : ""}`;
      }
      if (effectiveStatus === 401 || effectiveStatus === 403) return "Authentication failed";
      if (effectiveStatus === 429) return "Rate limit exceeded";
      if (errorName === "MessageOutputLengthError") return "Output length limit exceeded";
      return errorName.replace(/([a-z])([A-Z])/g, "$1 $2");
    })();

    const lines = [heading];
    if (rawMessage && rawMessage !== heading) lines.push(rawMessage);
    if (providerID && errorName !== "ProviderAuthError") lines.push(`Provider: ${providerID}`);
    if (effectiveStatus && errorName !== "APIError") lines.push(`Status: ${effectiveStatus}`);
    if (code) lines.push(`Code: ${code}`);
    if (isRetryable !== null) lines.push(`Retryable: ${isRetryable ? "yes" : "no"}`);
    if (responseBody) lines.push(`Response: ${responseBody}`);
    return lines.join("\n");
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

  let selectRunCounter = 0;
  let selectVersion = 0;
  const selectInFlightBySession = new Map<string, Promise<void>>();

  const sessions = () => store.sessions;
  const sessionStatusById = () => store.sessionStatus;
  const pendingPermissions = () => store.pendingPermissions;
  const pendingQuestions = () => store.pendingQuestions;
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

    // IMPORTANT: OpenCode's session.list() supports server-side filtering by directory.
    // Use it to avoid fetching every session across every workspace root.
    //
    // Note: We intentionally normalize slashes + trailing separators but do NOT
    // lowercase on Windows for the query value because the server does strict
    // string equality against the stored session.directory.
    const queryDirectory = (() => {
      const trimmed = (scopeRoot ?? "").trim();
      if (!trimmed) return undefined;
      const unified = trimmed.replace(/\\/g, "/");
      const withoutTrailing = unified.replace(/\/+$/, "");
      return withoutTrailing || "/";
    })();

    const start = Date.now();
    sessionDebug("sessions:load:start", { scopeRoot: scopeRoot ?? null, queryDirectory: queryDirectory ?? null });
    const list = unwrap(await c.session.list({ directory: queryDirectory, roots: true }));
    sessionDebug("sessions:load:raw", { count: list.length, ms: Date.now() - start });

    // Defensive client-side filter in case the server returns sessions spanning
    // multiple roots (e.g. older servers or proxies).
    const root = normalizeDirectoryPath(scopeRoot);
    const filtered = root
      ? list.filter((session) => normalizeDirectoryPath(session.directory) === root)
      : list;
    sessionDebug("sessions:load:filtered", { root: root || null, count: filtered.length });
    setStore("sessions", reconcile(sortSessionsByActivity(filtered), { key: "id" }));
  }

  async function renameSession(sessionID: string, title: string) {
    const c = options.client();
    if (!c) return;
    const trimmed = title.trim();
    if (!trimmed) {
      throw new Error("Session name is required");
    }
    const next = unwrap(await c.session.update({ sessionID, title: trimmed }));
    setStore("sessions", (current) => upsertSession(current, next));
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

  async function refreshPendingQuestions() {
    const c = options.client();
    if (!c) return;
    const list = unwrap(await c.question.list());
    const now = Date.now();
    const byId = new Map(store.pendingQuestions.map((q) => [q.id, q] as const));
    const next = list.map((q) => ({ ...q, receivedAt: byId.get(q.id)?.receivedAt ?? now }));
    setStore("pendingQuestions", next);
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

    const perfEnabled = options.developerMode();
    options.setSelectedSessionId(sessionID);
    options.setError(null);

    const existing = selectInFlightBySession.get(sessionID);
    if (existing) {
      recordPerfLog(perfEnabled, "session.select", "dedupe join", {
        sessionID,
      });
      return existing;
    }

    const runId = ++selectRunCounter;
    const version = ++selectVersion;
    const startedAt = perfNow();
    const mark = (event: string, payload?: Record<string, unknown>) => {
      const elapsedMs = Math.round((perfNow() - startedAt) * 100) / 100;
      recordPerfLog(perfEnabled, "session.select", event, {
        runId,
        sessionID,
        elapsedMs,
        ...(payload ?? {}),
      });
    };
    const isStale = () => version !== selectVersion || options.selectedSessionId() !== sessionID;
    const abortIfStale = (reason: string) => {
      if (!isStale()) return false;
      mark(`aborting: ${reason}`);
      return true;
    };

    const run = (async () => {
      mark("start");

      mark("checking health");
      try {
        await withTimeout(c.global.health(), 3000, "health");
        mark("health ok");
      } catch (error) {
        mark("health FAILED", {
          error: error instanceof Error ? error.message : safeStringify(error),
        });
        throw new Error("Server connection lost. Please reload.");
      }
      if (abortIfStale("selection changed after health")) return;

      mark("calling session.messages");
      const msgs = unwrap(await withTimeout(c.session.messages({ sessionID }), 12000, "session.messages"));
      mark("session.messages done");
      if (abortIfStale("selection changed before messages applied")) return;
      setMessagesForSession(sessionID, msgs);

      const model = options.lastUserModelFromMessages(msgs);
      if (model) {
        if (abortIfStale("selection changed before model applied")) return;
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
        if (abortIfStale("selection changed before todos applied")) return;
        setStore("todos", sessionID, list);
      } catch (error) {
        mark("session.todo failed/timeout", {
          error: error instanceof Error ? error.message : safeStringify(error),
        });
        if (abortIfStale("selection changed before todo fallback")) return;
        setStore("todos", sessionID, []);
      }

      try {
        mark("calling permission.list");
        await withTimeout(refreshPendingPermissions(), 6000, "permission.list");
        mark("permission.list done");
        if (abortIfStale("selection changed before permissions applied")) return;
      } catch (error) {
        mark("permission.list failed/timeout", {
          error: error instanceof Error ? error.message : safeStringify(error),
        });
        if (abortIfStale("selection changed after permission failure")) return;
      }

      finishPerf(perfEnabled, "session.select", "complete", startedAt, {
        runId,
        sessionID,
        messageCount: msgs.length,
        todoCount: (store.todos[sessionID] ?? []).length,
      });
    })();

    selectInFlightBySession.set(sessionID, run);
    try {
      await run;
    } finally {
      if (selectInFlightBySession.get(sessionID) === run) {
        selectInFlightBySession.delete(sessionID);
      }
    }
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

  async function respondQuestion(requestID: string, answers: string[][]) {
    const c = options.client();
    if (!c || questionReplyBusy()) return;

    setQuestionReplyBusy(true);
    options.setError(null);

    try {
      unwrap(await c.question.reply({ requestID, answers }));
      await refreshPendingQuestions();
    } catch (e) {
      addError(e);
    } finally {
      setQuestionReplyBusy(false);
    }
  }

  async function rejectQuestion(requestID: string) {
    const c = options.client();
    if (!c || questionReplyBusy()) return;

    setQuestionReplyBusy(true);
    options.setError(null);

    try {
      unwrap(await c.question.reject({ requestID }));
      await refreshPendingQuestions();
    } catch (e) {
      addError(e);
    } finally {
      setQuestionReplyBusy(false);
    }
  }

  const setSessions = (next: Session[]) => {
    setStore("sessions", reconcile(sortSessionsByActivity(next), { key: "id" }));
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

  const setPendingQuestions = (next: PendingQuestion[]) => {
    setStore("pendingQuestions", next);
  };

  const activePermission = createMemo(() => {
    const id = options.selectedSessionId();
    if (id) {
      return store.pendingPermissions.find((perm) => perm.sessionID === id) ?? null;
    }
    return store.pendingPermissions[0] ?? null;
  });

  const activeQuestion = createMemo(() => {
    const id = options.selectedSessionId();
    if (id) {
      return store.pendingQuestions.find((q) => q.sessionID === id) ?? null;
    }
    return store.pendingQuestions[0] ?? null;
  });

  const [questionReplyBusy, setQuestionReplyBusy] = createSignal(false);
  let lastPartDebugEventAt = 0;
  let suppressedPartDebugEvents = 0;

  const appendDebugEvent = (event: { type: string; properties?: unknown }) => {
    setStore("events", (current) => {
      const next = [event, ...current];
      return next.slice(0, 150);
    });
  };

  const compactDebugEvent = (event: OpencodeEvent) => {
    if (event.type === "message.part.updated") {
      const record = event.properties as Record<string, unknown> | undefined;
      const part = record?.part as Part | undefined;
      const delta = typeof record?.delta === "string" ? record.delta : "";
      const textLength =
        part?.type === "text" && typeof (part as { text?: unknown }).text === "string"
          ? String((part as { text?: string }).text).length
          : null;
      return {
        type: event.type,
        properties: {
          sessionID: part?.sessionID ?? null,
          messageID: part?.messageID ?? null,
          partID: part?.id ?? null,
          partType: part?.type ?? null,
          deltaLength: delta.length,
          textLength,
        },
      };
    }

    return {
      type: event.type,
      properties: event.properties,
    };
  };

  const applyEvent = async (event: OpencodeEvent) => {
    if (event.type === "server.connected") {
      options.setSseConnected(true);
    }

    if (options.developerMode()) {
      const compact = compactDebugEvent(event);
      if (event.type === "message.part.updated") {
        const now = Date.now();
        if (now - lastPartDebugEventAt < 250) {
          suppressedPartDebugEvents += 1;
        } else {
          lastPartDebugEventAt = now;
          if (suppressedPartDebugEvents > 0) {
            compact.properties = {
              ...(compact.properties ?? {}),
              suppressed: suppressedPartDebugEvents,
            };
            suppressedPartDebugEvents = 0;
          }
          appendDebugEvent(compact);
        }
      } else {
        if (suppressedPartDebugEvents > 0) {
          appendDebugEvent({
            type: "message.part.updated.sample",
            properties: { suppressed: suppressedPartDebugEvents },
          });
          suppressedPartDebugEvents = 0;
        }
        appendDebugEvent(compact);
      }
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
          const normalized = normalizeSessionStatus(record.status);
          setStore("sessionStatus", sessionID, normalized);
          if (sessionID === options.selectedSessionId() && normalized !== "idle") {
            options.setError(null);
          }
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

    if (event.type === "opencode.hotreload.applied") {
      options.onHotReloadApplied?.();
    }

    if (event.type === "session.error") {
      if (event.properties && typeof event.properties === "object") {
        const record = event.properties as Record<string, unknown>;
        const sessionID = typeof record.sessionID === "string" ? record.sessionID : null;
        if (sessionID) {
          setStore("sessionStatus", sessionID, "idle");
        }
        const errorObj = record.error as Record<string, unknown> | undefined;
        if (sessionID && sessionID !== options.selectedSessionId()) {
          return;
        }
        if (errorObj) {
          const errorName = typeof errorObj.name === "string" ? errorObj.name : "UnknownError";
          if (errorName === "MessageAbortedError") {
            // Cancellation is a user-driven control flow. Don't treat it as a
            // fatal error banner; the session UI already provides local UX.
            options.setError(null);
            return;
          }
          options.setError(addOpencodeCacheHint(formatSessionError(errorObj)));
          return;
        }

        const fallback = truncateErrorField(record.error, 700) ?? "An unexpected error occurred";
        options.setError(addOpencodeCacheHint(fallback));
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
          const partUpdatedStartedAt = perfNow();

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
          const partUpdatedMs = Math.round((perfNow() - partUpdatedStartedAt) * 100) / 100;
          if (sessionDebugEnabled() && (partUpdatedMs >= 8 || (delta?.length ?? 0) >= 120)) {
            const textLength =
              part.type === "text" && typeof (part as { text?: unknown }).text === "string"
                ? String((part as { text?: string }).text).length
                : null;
            recordPerfLog(true, "session.event", "message.part.updated", {
              sessionID: part.sessionID,
              messageID: part.messageID,
              partID: part.id,
              partType: part.type,
              deltaLength: delta?.length ?? 0,
              textLength,
              ms: partUpdatedMs,
            });
          }
          maybeMarkReloadRequired(part);
          maybeHandleInvalidToolError(part);
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

    if (
      event.type === "question.asked" ||
      event.type === "question.replied" ||
      event.type === "question.rejected"
    ) {
      try {
        await refreshPendingQuestions();
      } catch {
        // ignore
      }
    }
  };

  createEffect(() => {
    const c = options.client();
    if (!c) return;

    let cancelled = false;
    let reconnectAttempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    let queue: Array<OpencodeEvent | undefined> = [];
    const coalesced = new Map<string, number>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = 0;
    let queueStartedAt = 0;
    let peakQueueDepth = 0;
    let queueHasPartUpdates = false;
    let coalescedReplaced = 0;

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

      const queueWaitMs = queueStartedAt > 0 ? Date.now() - queueStartedAt : 0;
      queueStartedAt = 0;
      const peakDepth = peakQueueDepth;
      peakQueueDepth = 0;
      queueHasPartUpdates = false;
      const replaced = coalescedReplaced;
      coalescedReplaced = 0;

      last = Date.now();
      const startedAt = perfNow();
      let applied = 0;
      let partUpdates = 0;
      let messageUpdates = 0;
      batch(() => {
        for (const event of eventsToApply) {
          if (!event) continue;
          if (event.type === "message.part.updated") partUpdates += 1;
          if (event.type === "message.updated") messageUpdates += 1;
          applied += 1;
          void applyEvent(event);
        }
      });

      const elapsedMs = Math.round((perfNow() - startedAt) * 100) / 100;
      const dropped = eventsToApply.length - applied;
      if (
        sessionDebugEnabled() &&
        (elapsedMs >= 10 || queueWaitMs >= 40 || peakDepth >= 25 || applied >= 30 || dropped >= 12)
      ) {
        recordPerfLog(true, "session.sse", "flush", {
          queued: eventsToApply.length,
          applied,
          dropped,
          queueWaitMs,
          peakQueueDepth: peakDepth,
          coalescedReplaced: replaced,
          messageUpdates,
          partUpdates,
          ms: elapsedMs,
        });
      }
    };

    const schedule = () => {
      if (timer) return;
      const elapsed = Date.now() - last;
      const interval = queueHasPartUpdates ? 48 : 16;
      timer = setTimeout(flush, Math.max(0, interval - elapsed));
    };

    const connectSse = async (controller: AbortController) => {
      try {
        const sub = await c.event.subscribe(undefined, { signal: controller.signal });
        let yielded = Date.now();
        let lastArrivalAt = Date.now();

        // Reset reconnect counter on successful connection
        reconnectAttempt = 0;
        recordPerfLog(sessionDebugEnabled(), "session.sse", "connected");

        for await (const raw of sub.stream) {
          if (cancelled) break;

          const event = normalizeEvent(raw);
          if (!event) continue;

          const arrivedAt = Date.now();
          const arrivalGapMs = arrivedAt - lastArrivalAt;
          lastArrivalAt = arrivedAt;
          if (sessionDebugEnabled() && arrivalGapMs >= 220) {
            recordPerfLog(true, "session.sse", "arrival-gap", {
              ms: arrivalGapMs,
              type: event.type,
            });
          }

          const key = keyForEvent(event);
          if (key) {
            const existing = coalesced.get(key);
            if (existing !== undefined) {
              if (queue[existing] !== undefined) {
                coalescedReplaced += 1;
              }
              queue[existing] = undefined;
            }
            coalesced.set(key, queue.length);
          }

          if (queue.length === 0) {
            queueStartedAt = Date.now();
          }
          if (event.type === "message.part.updated") {
            queueHasPartUpdates = true;
          }
          queue.push(event);
          if (queue.length > peakQueueDepth) {
            peakQueueDepth = queue.length;
          }
          schedule();

          if (Date.now() - yielded < 8) continue;
          yielded = Date.now();
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }

        // Stream ended normally - attempt reconnect unless cancelled
        if (!cancelled) {
          options.setSseConnected(false);
          recordPerfLog(sessionDebugEnabled(), "session.sse", "stream-ended");
          scheduleReconnect(controller);
        }
      } catch (e) {
        if (cancelled) return;

        const message = e instanceof Error ? e.message : String(e);
        if (message.toLowerCase().includes("abort")) return;

        // Mark SSE as disconnected and schedule reconnect
        options.setSseConnected(false);
        recordPerfLog(sessionDebugEnabled(), "session.sse", "stream-error", {
          error: message,
        });
        scheduleReconnect(controller);
      }
    };

    const scheduleReconnect = (oldController: AbortController) => {
      if (cancelled) return;
      oldController.abort();

      // Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
      reconnectAttempt++;
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempt - 1), 30000);
      recordPerfLog(sessionDebugEnabled(), "session.sse", "reconnect-scheduled", {
        attempt: reconnectAttempt,
        delayMs: delay,
      });

      reconnectTimer = setTimeout(() => {
        if (cancelled) return;
        const newController = new AbortController();
        void connectSse(newController);
      }, delay);
    };

    const controller = new AbortController();
    void connectSse(controller);

    onCleanup(() => {
      cancelled = true;
      controller.abort();
      if (reconnectTimer) clearTimeout(reconnectTimer);
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
    pendingQuestions,
    activeQuestion,
    questionReplyBusy,
    events,
    activePermission,
    loadSessions,
    refreshPendingPermissions,
    refreshPendingQuestions,
    selectSession,
    renameSession,
    respondPermission,
    respondQuestion,
    rejectQuestion,
    setSessions,
    setSessionStatusById,
    setMessages,
    setTodos,
    setPendingPermissions,
    setPendingQuestions,
  };
}
