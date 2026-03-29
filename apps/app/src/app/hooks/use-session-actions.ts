import { createSignal, type Accessor } from "solid-js";

import type {
  Agent,
  FilePartInput,
  Session,
  TextPartInput,
  AgentPartInput,
  SubtaskPartInput,
} from "@opencode-ai/sdk/v2/client";

import { currentLocale, t } from "../../i18n";
import { unwrap } from "../lib/opencode";
import {
  abortSession as abortSessionTyped,
  abortSessionSafe,
  compactSession as compactSessionTyped,
  revertSession,
  unrevertSession,
  shellInSession,
  listCommands as listCommandsTyped,
} from "../lib/opencode-session";
import { addOpencodeCacheHint } from "../utils";
import { describeDirectoryScope, toSessionTransportDirectory } from "../lib/session-scope";
import { finishPerf, perfNow, recordPerfLog } from "../lib/perf-log";
import type {
  Client,
  ComposerAttachment,
  ComposerDraft,
  ComposerPart,
  MessageWithParts,
  ModelRef,
} from "../types";

type PartInput = TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput;

type SignalSetter<T> = (value: T | ((current: T) => T)) => T;

type UseSessionActionsOptions = {
  client: Accessor<Client | null>;
  baseUrl: Accessor<string>;
  selectedSessionId: Accessor<string | null>;
  selectedSession: Accessor<Session | null>;
  selectedSessionModel: Accessor<ModelRef>;
  selectedSessionAgent: Accessor<string | null>;
  workspaceProjectDir: Accessor<string>;
  selectedWorkspaceId: Accessor<string>;
  selectedWorkspaceRoot: Accessor<string>;
  messages: Accessor<MessageWithParts[]>;
  sessions: Accessor<Session[]>;
  pendingSessionModel: Accessor<ModelRef | null>;
  developerMode: Accessor<boolean>;
  locationPathname: Accessor<string>;
  ensureSelectedWorkspaceRuntime: () => Promise<boolean>;
  createSessionRoute: (sessionId: string) => void;
  navigateToSessionList: () => void;
  selectSession: (sessionId: string) => Promise<void>;
  refreshSidebarWorkspaceSessions: (workspaceId: string) => Promise<unknown>;
  abortRefreshes: () => void;
  setBusy: (value: boolean) => void;
  setBusyLabel: (value: string | null) => void;
  setBusyStartedAt: (value: number | null) => void;
  setError: (value: string | null) => void;
  setCreatingSession: (value: boolean) => void;
  setSelectedSessionId: (value: string | null) => void;
  setSessions: (value: Session[]) => void;
  sessionStatusById: Accessor<Record<string, string>>;
  setSessionStatusById: (value: Record<string, string>) => void;
  setPendingSessionModel: (value: ModelRef | null) => void;
  setSessionModelById: SignalSetter<Record<string, ModelRef>>;
  setSessionModelOverrideById: SignalSetter<Record<string, ModelRef>>;
  readSessionByWorkspace: () => Record<string, string>;
  writeSessionByWorkspace: (value: Record<string, string>) => void;
  appendSessionErrorTurn: (sessionId: string, text: string) => void;
  describeProviderError: (error: unknown, fallback: string) => string;
  logWorkspaceScopeSnapshot: (label: string, payload?: unknown) => void;
  safeStringify: (value: unknown) => string;
  getVariantFor: (ref: ModelRef) => string | null;
  sanitizeModelVariantForRef: (ref: ModelRef, value: string | null) => string | null;
  resolveCodexReasoningEffort: (modelID: string, variant: string | null) => string | undefined;
};

const BUILTIN_COMPACT_COMMAND = {
  id: "builtin:compact",
  name: "compact",
  description: "Summarize this session to reduce context size.",
  source: "command" as const,
};

const fileToDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Failed to read attachment: ${file.name}`));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      resolve(result);
    };
    reader.readAsDataURL(file);
  });

function messageIdFromInfo(message: MessageWithParts) {
  const id = (message.info as { id?: string | number }).id;
  if (typeof id === "string") return id;
  if (typeof id === "number") return String(id);
  return "";
}

function downloadSessionExport(payload: unknown, fileName: string) {
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
  return fileName;
}

export function useSessionActions(options: UseSessionActionsOptions) {
  const [prompt, setPrompt] = createSignal("");
  const [lastPromptSent, setLastPromptSent] = createSignal("");

  const attachmentToFilePart = async (
    attachment: ComposerAttachment,
  ): Promise<FilePartInput> => ({
    type: "file",
    url: await fileToDataUrl(attachment.file),
    filename: attachment.name,
    mime: attachment.mimeType,
  });

  const buildPromptParts = async (draft: ComposerDraft): Promise<PartInput[]> => {
    const parts: PartInput[] = [];
    const text = draft.resolvedText ?? draft.text;
    parts.push({ type: "text", text } as TextPartInput);

    const root = options.workspaceProjectDir().trim();
    const toAbsolutePath = (path: string) => {
      const trimmed = path.trim();
      if (!trimmed) return "";
      if (trimmed.startsWith("/")) return trimmed;
      if (/^[a-zA-Z]:\\/.test(trimmed)) return trimmed;
      if (!root) return "";
      return (root + "/" + trimmed).replace("//", "/");
    };
    const filenameFromPath = (path: string) => {
      const normalized = path.replace(/\\/g, "/");
      const segments = normalized.split("/").filter(Boolean);
      return segments[segments.length - 1] ?? "file";
    };

    for (const part of draft.parts) {
      if (part.type === "agent") {
        parts.push({ type: "agent", name: part.name } as AgentPartInput);
        continue;
      }
      if (part.type === "file") {
        const absolute = toAbsolutePath(part.path);
        if (!absolute) continue;
        parts.push({
          type: "file",
          mime: "text/plain",
          url: `file://${absolute}`,
          filename: filenameFromPath(part.path),
        } as FilePartInput);
      }
    }

    parts.push(...(await Promise.all(draft.attachments.map(attachmentToFilePart))));
    return parts;
  };

  const buildCommandFileParts = async (draft: ComposerDraft): Promise<FilePartInput[]> => {
    const parts: FilePartInput[] = [];
    const root = options.workspaceProjectDir().trim();

    const toAbsolutePath = (path: string) => {
      const trimmed = path.trim();
      if (!trimmed) return "";
      if (trimmed.startsWith("/")) return trimmed;
      if (/^[a-zA-Z]:\\/.test(trimmed)) return trimmed;
      if (!root) return "";
      return (root + "/" + trimmed).replace("//", "/");
    };

    const filenameFromPath = (path: string) => {
      const normalized = path.replace(/\\/g, "/");
      const segments = normalized.split("/").filter(Boolean);
      return segments[segments.length - 1] ?? "file";
    };

    for (const part of draft.parts) {
      if (part.type !== "file") continue;
      const absolute = toAbsolutePath(part.path);
      if (!absolute) continue;
      parts.push({
        type: "file",
        mime: "text/plain",
        url: `file://${absolute}`,
        filename: filenameFromPath(part.path),
      } as FilePartInput);
    }

    parts.push(...(await Promise.all(draft.attachments.map(attachmentToFilePart))));
    return parts;
  };

  const assertNoClientError = (result: unknown) => {
    const maybe = result as { error?: unknown } | null | undefined;
    if (!maybe || maybe.error === undefined) return;
    throw new Error(options.describeProviderError(maybe.error, "Request failed"));
  };

  const upsertLocalSession = (next: Session | null | undefined) => {
    const id = (next as { id?: string } | null)?.id ?? "";
    if (!id) return;

    const current = options.sessions();
    const index = current.findIndex((session) => session.id === id);
    if (index === -1) {
      options.setSessions([...current, next as Session]);
      return;
    }
    const copy = current.slice();
    copy[index] = next as Session;
    options.setSessions(copy);
  };

  const restorePromptFromUserMessage = (message: MessageWithParts) => {
    const text = message.parts
      .filter((part) => part.type === "text" && typeof (part as { text?: string }).text === "string")
      .map((part) => String((part as { text?: string }).text ?? ""))
      .join("");
    setPrompt(text);
  };

  async function createSessionAndOpen() {
    const ready = await options.ensureSelectedWorkspaceRuntime();
    if (!ready) {
      return;
    }

    const c = options.client();
    if (!c) {
      return;
    }

    const perfEnabled = options.developerMode();
    const startedAt = perfNow();
    const runId = (() => {
      const key = "__openwork_create_session_run__";
      const w = window as typeof window & { [key]?: number };
      w[key] = (w[key] ?? 0) + 1;
      return w[key];
    })();

    const mark = (event: string, payload?: Record<string, unknown>) => {
      const elapsed = Math.round((perfNow() - startedAt) * 100) / 100;
      recordPerfLog(perfEnabled, "session.create", event, {
        runId,
        elapsedMs: elapsed,
        ...(payload ?? {}),
      });
    };

    mark("start", {
      baseUrl: options.baseUrl(),
      workspace: options.selectedWorkspaceRoot().trim() || null,
    });

    options.abortRefreshes();
    await new Promise((resolve) => setTimeout(resolve, 50));

    options.setBusy(true);
    options.setBusyLabel("status.creating_task");
    options.setBusyStartedAt(Date.now());
    options.setError(null);
    options.setCreatingSession(true);

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

    try {
      mark("health:start");
      try {
        await withTimeout(c.global.health(), 3_000, "health");
        mark("health:ok");
      } catch (healthErr) {
        mark("health:error", {
          error: healthErr instanceof Error ? healthErr.message : options.safeStringify(healthErr),
        });
        throw new Error(t("app.connection_lost", currentLocale()));
      }

      let rawResult: Awaited<ReturnType<typeof c.session.create>>;
      try {
        const directory = toSessionTransportDirectory(options.selectedWorkspaceRoot().trim()) || undefined;
        options.logWorkspaceScopeSnapshot("session:create:scope", {
          transportDirectory: directory ?? null,
          transportScope: describeDirectoryScope(directory ?? null),
        });
        mark("session:create:start");
        rawResult = await c.session.create({ directory });
        mark("session:create:ok");
      } catch (createErr) {
        mark("session:create:error", {
          error: createErr instanceof Error ? createErr.message : options.safeStringify(createErr),
        });
        throw createErr;
      }

      const session = unwrap(rawResult);
      const pendingModel = options.pendingSessionModel();
      options.setBusyLabel("status.loading_session");
      mark("session:select:start", { sessionID: session.id });
      await options.selectSession(session.id);
      mark("session:select:ok", { sessionID: session.id });

      if (pendingModel) {
        options.setSessionModelOverrideById((current) => ({
          ...current,
          [session.id]: pendingModel,
        }));
        options.setPendingSessionModel(null);
      }

      const currentStoreSessions = options.sessions();
      if (!currentStoreSessions.some((entry) => entry.id === session.id)) {
        options.setSessions([session, ...currentStoreSessions]);
      }

      const workspaceId = options.selectedWorkspaceId().trim();
      if (workspaceId) {
        await options.refreshSidebarWorkspaceSessions(workspaceId).catch(() => undefined);
      }

      options.createSessionRoute(session.id);
      finishPerf(perfEnabled, "session.create", "done", startedAt, {
        runId,
        sessionID: session.id,
      });
      return session.id;
    } catch (error) {
      finishPerf(perfEnabled, "session.create", "error", startedAt, {
        runId,
        error: error instanceof Error ? error.message : options.safeStringify(error),
      });
      const message =
        error instanceof Error ? error.message : t("app.unknown_error", currentLocale());
      options.setError(addOpencodeCacheHint(message));
      return undefined;
    } finally {
      options.setCreatingSession(false);
      options.setBusy(false);
    }
  }

  async function sendPrompt(draft?: ComposerDraft) {
    const hasExplicitDraft = Boolean(draft);
    const fallbackText = prompt().trim();
    const resolvedDraft: ComposerDraft = draft ?? {
      mode: "prompt",
      parts: fallbackText ? [{ type: "text", text: fallbackText } as ComposerPart] : [],
      attachments: [],
      text: fallbackText,
    };
    const content = (resolvedDraft.resolvedText ?? resolvedDraft.text).trim();
    if (!content && !resolvedDraft.attachments.length) return;

    const ready = await options.ensureSelectedWorkspaceRuntime();
    if (!ready) return;

    const c = options.client();
    if (!c) return;

    const compactShortcut = /^\/compact(?:\s+.*)?$/i.test(content);
    const compactCommand = resolvedDraft.command?.name === "compact" || compactShortcut;
    const commandName = compactCommand ? "compact" : (resolvedDraft.command?.name ?? null);
    if (compactCommand && !options.selectedSessionId()) {
      options.setError("Select a session with messages before running /compact.");
      return;
    }

    let sessionID = options.selectedSessionId();
    if (!sessionID) {
      await createSessionAndOpen();
      sessionID = options.selectedSessionId();
    }
    if (!sessionID) return;

    options.setBusy(true);
    options.setBusyLabel("status.running");
    options.setBusyStartedAt(Date.now());
    options.setError(null);

    const perfEnabled = options.developerMode();
    const startedAt = perfNow();
    const visible = options.messages();
    const visibleParts = visible.reduce((total, message) => total + message.parts.length, 0);
    recordPerfLog(perfEnabled, "session.prompt", "start", {
      sessionID,
      mode: resolvedDraft.mode,
      command: commandName,
      charCount: content.length,
      attachmentCount: resolvedDraft.attachments.length,
      messageCount: visible.length,
      partCount: visibleParts,
    });

    try {
      if (!compactCommand) {
        setLastPromptSent(content);
      }
      if (!hasExplicitDraft) {
        setPrompt("");
      }

      const model = options.selectedSessionModel();
      const agent = options.selectedSessionAgent();
      const parts = await buildPromptParts(resolvedDraft);
      const selectedVariant =
        options.sanitizeModelVariantForRef(model, options.getVariantFor(model)) ?? undefined;
      const reasoningEffort = options.resolveCodexReasoningEffort(
        model.modelID,
        selectedVariant ?? null,
      );
      const requestVariant = reasoningEffort ? undefined : selectedVariant;
      const promptOverrides = reasoningEffort
        ? ({ reasoning_effort: reasoningEffort } as const)
        : undefined;

      if (resolvedDraft.mode === "shell") {
        await shellInSession(c, sessionID, content);
      } else if (resolvedDraft.command || compactCommand) {
        if (compactCommand) {
          await compactCurrentSession(sessionID);
          finishPerf(perfEnabled, "session.prompt", "done", startedAt, {
            sessionID,
            mode: resolvedDraft.mode,
            command: commandName,
          });
          return;
        }

        const command = resolvedDraft.command;
        if (!command) {
          throw new Error("Command was not resolved.");
        }

        const modelString = `${model.providerID}/${model.modelID}`;
        const files = await buildCommandFileParts(resolvedDraft);

        unwrap(
          await c.session.command({
            sessionID,
            command: command.name,
            arguments: command.arguments,
            agent: agent ?? undefined,
            model: modelString,
            variant: requestVariant,
            ...(promptOverrides ?? {}),
            parts: files.length ? files : undefined,
          }),
        );
      } else {
        const result = await c.session.promptAsync({
          sessionID,
          model,
          agent: agent ?? undefined,
          variant: requestVariant,
          ...(promptOverrides ?? {}),
          parts,
        });
        assertNoClientError(result);

        options.setSessionModelById((current) => ({
          ...current,
          [sessionID]: model,
        }));

        options.setSessionModelOverrideById((current) => {
          if (!current[sessionID]) return current;
          const copy = { ...current };
          delete copy[sessionID];
          return copy;
        });
      }

      finishPerf(perfEnabled, "session.prompt", "done", startedAt, {
        sessionID,
        mode: resolvedDraft.mode,
        command: commandName,
      });
    } catch (error) {
      finishPerf(perfEnabled, "session.prompt", "error", startedAt, {
        sessionID,
        mode: resolvedDraft.mode,
        command: commandName,
        error: error instanceof Error ? error.message : options.safeStringify(error),
      });
      const message = error instanceof Error ? error.message : options.safeStringify(error);
      options.appendSessionErrorTurn(sessionID, addOpencodeCacheHint(message));
    } finally {
      options.setBusy(false);
      options.setBusyLabel(null);
      options.setBusyStartedAt(null);
    }
  }

  async function abortSession(sessionID?: string) {
    const c = options.client();
    if (!c) return;
    const id = (sessionID ?? options.selectedSessionId() ?? "").trim();
    if (!id) return;
    await abortSessionTyped(c, id);
  }

  function retryLastPrompt() {
    const text = lastPromptSent().trim();
    if (!text) return;
    void sendPrompt({
      mode: "prompt",
      text,
      parts: [{ type: "text", text }],
      attachments: [],
    });
  }

  async function compactCurrentSession(sessionIdOverride?: string) {
    const c = options.client();
    if (!c) {
      throw new Error("Not connected to a server");
    }

    const sessionID = (sessionIdOverride ?? options.selectedSessionId() ?? "").trim();
    if (!sessionID) {
      throw new Error("Select a session before compacting.");
    }

    const visible = options.messages();
    if (!visible.length) {
      throw new Error("Nothing to compact yet.");
    }

    const model = options.selectedSessionModel();
    const startedAt = perfNow();
    const modelLabel = `${model.providerID}/${model.modelID}`;
    recordPerfLog(options.developerMode(), "session.compact", "start", {
      sessionID,
      messageCount: visible.length,
      model: modelLabel,
      variant: options.sanitizeModelVariantForRef(model, options.getVariantFor(model)) ?? null,
    });

    try {
      await compactSessionTyped(c, sessionID, model, {
        directory: options.workspaceProjectDir().trim() || undefined,
      });
      finishPerf(options.developerMode(), "session.compact", "done", startedAt, {
        sessionID,
        messageCount: visible.length,
        model: modelLabel,
      });
    } catch (error) {
      finishPerf(options.developerMode(), "session.compact", "error", startedAt, {
        sessionID,
        messageCount: visible.length,
        model: modelLabel,
        error: error instanceof Error ? error.message : options.safeStringify(error),
      });
      throw error;
    }
  }

  async function undoLastUserMessage() {
    const c = options.client();
    const sessionID = (options.selectedSessionId() ?? "").trim();
    if (!c || !sessionID) return;

    await abortSessionSafe(c, sessionID);

    const revertMessageID = options.selectedSession()?.revert?.messageID ?? null;
    const users = options.messages().filter((message) => {
      const role = (message.info as { role?: string }).role;
      return role === "user";
    });

    let target: MessageWithParts | null = null;
    for (let idx = users.length - 1; idx >= 0; idx -= 1) {
      const candidate = users[idx];
      const id = messageIdFromInfo(candidate);
      if (!id) continue;
      if (!revertMessageID || id < revertMessageID) {
        target = candidate;
        break;
      }
    }

    if (!target) return;
    const messageID = messageIdFromInfo(target);
    if (!messageID) return;

    const next = await revertSession(c, sessionID, messageID);
    upsertLocalSession(next);
    restorePromptFromUserMessage(target);
  }

  async function redoLastUserMessage() {
    const c = options.client();
    const sessionID = (options.selectedSessionId() ?? "").trim();
    if (!c || !sessionID) return;

    await abortSessionSafe(c, sessionID);

    const revertMessageID = options.selectedSession()?.revert?.messageID ?? null;
    if (!revertMessageID) return;

    const users = options.messages().filter((message) => {
      const role = (message.info as { role?: string }).role;
      return role === "user";
    });

    const next = users.find((message) => {
      const id = messageIdFromInfo(message);
      return Boolean(id) && id > revertMessageID;
    });

    if (!next) {
      const session = await unrevertSession(c, sessionID);
      upsertLocalSession(session);
      setPrompt("");
      return;
    }

    const messageID = messageIdFromInfo(next);
    if (!messageID) return;

    const nextSession = await revertSession(c, sessionID, messageID);
    upsertLocalSession(nextSession);

    let prior: MessageWithParts | null = null;
    for (let idx = users.length - 1; idx >= 0; idx -= 1) {
      const candidate = users[idx];
      const id = messageIdFromInfo(candidate);
      if (id && id < messageID) {
        prior = candidate;
        break;
      }
    }

    if (prior) {
      restorePromptFromUserMessage(prior);
      return;
    }

    setPrompt("");
  }

  async function renameSession(sessionID: string, title: string) {
    const trimmed = title.trim();
    if (!trimmed) {
      throw new Error("Session name is required");
    }

    const c = options.client();
    if (!c) {
      throw new Error("Not connected to a server");
    }

    const next = unwrap(await c.session.update({ sessionID, title: trimmed }));
    upsertLocalSession(next);
    await options.refreshSidebarWorkspaceSessions(options.selectedWorkspaceId()).catch(() => undefined);
  }

  async function deleteSession(sessionID: string) {
    const trimmed = sessionID.trim();
    if (!trimmed) return;
    const c = options.client();
    if (!c) {
      throw new Error("Not connected to a server");
    }

    const root = options.selectedWorkspaceRoot().trim();
    const directory = toSessionTransportDirectory(root);
    const params = directory ? { sessionID: trimmed, directory } : { sessionID: trimmed };
    unwrap(await c.session.delete(params));

    options.setSessions(options.sessions().filter((session) => session.id !== trimmed));
    const activeWorkspaceId = options.selectedWorkspaceId();
    await options.refreshSidebarWorkspaceSessions(activeWorkspaceId).catch(() => undefined);

    try {
      const path = options.locationPathname().toLowerCase();
      if (path === `/session/${trimmed.toLowerCase()}`) {
        options.navigateToSessionList();
      }
    } catch {
      // ignore
    }

    if (options.selectedSessionId() === trimmed) {
      options.setSelectedSessionId(null);
      const activeWorkspace = options.selectedWorkspaceId().trim();
      if (activeWorkspace) {
        const map = options.readSessionByWorkspace();
        if (map[activeWorkspace] === trimmed) {
          const next = { ...map };
          delete next[activeWorkspace];
          options.writeSessionByWorkspace(next);
        }
      }
    }

    const nextStatus = { ...options.sessionStatusById() };
    if (nextStatus[trimmed]) {
      delete nextStatus[trimmed];
      options.setSessionStatusById(nextStatus);
    }
  }

  async function saveSessionExport(sessionID: string) {
    const c = options.client();
    if (!c) {
      throw new Error("Not connected to a server");
    }

    const session = unwrap(await c.session.get({ sessionID }));
    const messages = unwrap(await c.session.messages({ sessionID }));
    let todos: unknown[] = [];
    try {
      todos = unwrap(await c.session.todo({ sessionID }));
    } catch {
      // ignore
    }

    const payload = {
      session,
      messages,
      todos,
      exportedAt: new Date().toISOString(),
      source: "openwork",
    };

    const baseName = session.title || session.slug || session.id;
    const safeName = baseName
      .toLowerCase()
      .replace(/[^a-z0-9\-_.]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
    const fileName = `session-${safeName || session.id}.json`;
    return downloadSessionExport(payload, fileName);
  }

  async function listAgents(): Promise<Agent[]> {
    const c = options.client();
    if (!c) return [];
    const list = unwrap(await c.app.agents());
    return list.filter((agent) => !agent.hidden && agent.mode !== "subagent");
  }

  async function listCommands(): Promise<
    { id: string; name: string; description?: string; source?: "command" | "mcp" | "skill" }[]
  > {
    const c = options.client();
    if (!c) return [];
    const list = await listCommandsTyped(c, options.selectedWorkspaceRoot().trim() || undefined);
    if (list.some((entry) => entry.name === "compact")) {
      return list;
    }
    return [BUILTIN_COMPACT_COMMAND, ...list];
  }

  return {
    prompt,
    setPrompt,
    lastPromptSent,
    createSessionAndOpen,
    sendPrompt,
    abortSession,
    retryLastPrompt,
    compactCurrentSession,
    undoLastUserMessage,
    redoLastUserMessage,
    renameSession,
    deleteSession,
    saveSessionExport,
    listAgents,
    listCommands,
  };
}
