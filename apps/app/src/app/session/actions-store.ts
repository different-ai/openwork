import { createMemo, createSignal } from "solid-js";

import type {
  Agent,
  AgentPartInput,
  FilePartInput,
  Session,
  SubtaskPartInput,
  TextPartInput,
} from "@opencode-ai/sdk/v2/client";

import { t, currentLocale } from "../../i18n";
import { unwrap } from "../lib/opencode";
import {
  abortSession as abortSessionTyped,
  abortSessionSafe,
  compactSession as compactSessionTyped,
  listCommands as listCommandsTyped,
  revertSession,
  shellInSession,
  unrevertSession,
} from "../lib/opencode-session";
import { finishPerf, perfNow, recordPerfLog } from "../lib/perf-log";
import { toSessionTransportDirectory } from "../lib/session-scope";
import type {
  Client,
  ComposerAttachment,
  ComposerDraft,
  ComposerPart,
  MessageWithParts,
  ModelRef,
} from "../types";
import { addOpencodeCacheHint, safeStringify } from "../utils";
import type { createModelConfigStore } from "../context/model-config";
import { clearSessionDraft, saveSessionDraft } from "./draft-store";

export type SessionActionsStore = ReturnType<typeof createSessionActionsStore>;

const FLUSH_PROMPT_EVENT = "openwork:flushPromptDraft";

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

export function createSessionActionsStore(options: {
  client: () => Client | null;
  baseUrl: () => string;
  developerMode: () => boolean;
  prompt: () => string;
  setPrompt: (value: string) => void;
  selectedSessionId: () => string | null;
  selectedSession: () => Session | null;
  sessions: () => Session[];
  messages: () => MessageWithParts[];
  setSessions: (value: Session[]) => void;
  sessionStatusById: () => Record<string, string>;
  setSessionStatusById: (value: Record<string, string>) => void;
  setBusy: (value: boolean) => void;
  setBusyLabel: (value: string | null) => void;
  setBusyStartedAt: (value: number | null) => void;
  setCreatingSession: (value: boolean) => void;
  setError: (value: string | null) => void;
  selectWorkspace: (workspaceId: string) => Promise<boolean> | boolean | void;
  workspaceRootForId: (workspaceId: string) => string;
  selectedWorkspaceId: () => string;
  selectedWorkspaceRoot: () => string;
  runtimeWorkspaceRoot: () => string;
  ensureWorkspaceRuntime: (workspaceId: string) => Promise<boolean>;
  selectSession: (id: string, options?: { skipHealthCheck?: boolean; source?: string }) => Promise<void>;
  refreshSidebarWorkspaceSessions: (workspaceId: string) => Promise<void>;
  abortRefreshes: () => void;
  modelConfig: ReturnType<typeof createModelConfigStore>;
  selectedSessionModel: () => ModelRef;
  modelVariant: () => string | null;
  sanitizeModelVariantForRef: (ref: ModelRef, value: string | null) => string | null;
  resolveCodexReasoningEffort: (modelId: string, variant: string | null) => string | undefined;
  messageIdFromInfo: (message: MessageWithParts) => string;
  restorePromptFromUserMessage: (message: MessageWithParts) => void;
  upsertLocalSession: (session: Session | null | undefined) => void;
  readSessionByWorkspace: () => Record<string, string>;
  writeSessionByWorkspace: (map: Record<string, string>) => void;
  setSelectedSessionId: (value: string | null) => void;
  locationPath: () => string;
  navigate: (path: string, options?: { replace?: boolean }) => void;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  appendSessionErrorTurn: (sessionId: string, message: string) => void;
}) {
  const [lastPromptSent, setLastPromptSent] = createSignal("");
  const [sessionAgentById, setSessionAgentById] = createSignal<Record<string, string>>({});

  type PartInput = TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput;

  const attachmentToFilePart = async (attachment: ComposerAttachment): Promise<FilePartInput> => ({
    type: "file",
    url: await fileToDataUrl(attachment.file),
    filename: attachment.name,
    mime: attachment.mimeType,
  });

  const buildPromptParts = async (draft: ComposerDraft): Promise<PartInput[]> => {
    const parts: PartInput[] = [];
    const text = draft.resolvedText ?? draft.text;
    parts.push({ type: "text", text } as TextPartInput);

    const root = options.runtimeWorkspaceRoot().trim() || options.selectedWorkspaceRoot().trim();
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
    const root = options.runtimeWorkspaceRoot().trim() || options.selectedWorkspaceRoot().trim();

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

  const describeProviderError = (error: unknown, fallback: string) => {
    const readString = (value: unknown, max = 700) => {
      if (typeof value !== "string") return null;
      const trimmed = value.trim();
      if (!trimmed) return null;
      if (trimmed.length <= max) return trimmed;
      return `${trimmed.slice(0, Math.max(0, max - 3))}...`;
    };

    const records: Record<string, unknown>[] = [];
    const root = error && typeof error === "object" ? (error as Record<string, unknown>) : null;
    if (root) {
      records.push(root);
      if (root.data && typeof root.data === "object") records.push(root.data as Record<string, unknown>);
      if (root.cause && typeof root.cause === "object") {
        const cause = root.cause as Record<string, unknown>;
        records.push(cause);
        if (cause.data && typeof cause.data === "object") records.push(cause.data as Record<string, unknown>);
      }
    }

    const firstString = (keys: string[]) => {
      for (const record of records) {
        for (const key of keys) {
          const value = readString(record[key]);
          if (value) return value;
        }
      }
      return null;
    };

    const firstNumber = (keys: string[]) => {
      for (const record of records) {
        for (const key of keys) {
          const value = record[key];
          if (typeof value === "number" && Number.isFinite(value)) return value;
        }
      }
      return null;
    };

    const status = firstNumber(["statusCode", "status"]);
    const provider = firstString(["providerID", "providerId", "provider"]);
    const code = firstString(["code", "errorCode"]);
    const response = firstString(["responseBody", "body", "response"]);
    const raw =
      (error instanceof Error ? readString(error.message) : null) ||
      firstString(["message", "detail", "reason", "error"]) ||
      (typeof error === "string" ? readString(error) : null);

    const generic = raw && /^unknown\s+error$/i.test(raw);
    const heading = (() => {
      if (status === 401 || status === 403) return t("app.error_auth_failed", currentLocale());
      if (status === 429) return t("app.error_rate_limit", currentLocale());
      if (provider) return `Provider error (${provider})`;
      return fallback;
    })();

    const lines = [heading];
    if (raw && !generic && raw !== heading) lines.push(raw);
    if (status && !heading.includes(String(status))) lines.push(`Status: ${status}`);
    if (provider && !heading.includes(provider)) lines.push(`Provider: ${provider}`);
    if (code) lines.push(`Code: ${code}`);
    if (response) lines.push(`Response: ${response}`);
    if (lines.length > 1) return lines.join("\n");

    if (raw && !generic) return raw;
    if (error && typeof error === "object") {
      const serialized = safeStringify(error);
      if (serialized && serialized !== "{}") return serialized;
    }
    return fallback;
  };

  const assertNoClientError = (result: unknown) => {
    const maybe = result as { error?: unknown } | null | undefined;
    if (!maybe || maybe.error === undefined) return;
    throw new Error(describeProviderError(maybe.error, t("app.error_request_failed", currentLocale())));
  };

  const selectedSessionAgent = createMemo(() => {
    const id = options.selectedSessionId();
    if (!id) return null;
    return sessionAgentById()[id] ?? null;
  });

  const sessionRevertMessageId = createMemo(() => options.selectedSession()?.revert?.messageID ?? null);

  async function createReadySession(workspaceId: string, initialPrompt?: string) {
    const id = workspaceId.trim();
    if (!id) return undefined;
    const c = options.client();
    if (!c) {
      return undefined;
    }

    const workspaceRoot = options.workspaceRootForId(id).trim() || options.selectedWorkspaceRoot().trim();

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
      workspace: workspaceRoot || null,
      workspaceId: id,
    });

    options.abortRefreshes();
    await new Promise((resolve) => setTimeout(resolve, 50));

    options.setBusy(true);
    options.setBusyLabel("status.creating_task");
    options.setBusyStartedAt(Date.now());
    options.setCreatingSession(true);
    options.setError(null);

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
          error: healthErr instanceof Error ? healthErr.message : safeStringify(healthErr),
        });
        throw new Error("Connection lost");
      }

      let rawResult: Awaited<ReturnType<typeof c.session.create>>;
      try {
        const directory = toSessionTransportDirectory(workspaceRoot) || undefined;
        mark("session:create:start");
        rawResult = await c.session.create({ directory });
        mark("session:create:ok");
      } catch (createErr) {
        mark("session:create:error", {
          error: createErr instanceof Error ? createErr.message : safeStringify(createErr),
        });
        throw createErr;
      }

      const session = unwrap(rawResult);
      if (initialPrompt) {
        saveSessionDraft(id, session.id, {
          text: initialPrompt,
          mode: "prompt",
        });
      } else {
        clearSessionDraft(id, session.id);
      }

      options.setBusyLabel("status.loading_session");
      mark("session:select:start", { sessionID: session.id });
      await options.selectSession(session.id, { skipHealthCheck: true, source: "create-ready-session" });
      mark("session:select:ok", { sessionID: session.id });

      options.modelConfig.applyPendingSessionChoice(session.id);

      const currentStoreSessions = options.sessions();
      if (!currentStoreSessions.some((s) => s.id === session.id)) {
        options.setSessions([session, ...currentStoreSessions]);
      }

      await options.refreshSidebarWorkspaceSessions(id).catch(() => undefined);

      options.navigate(`/session/${session.id}`);

      finishPerf(perfEnabled, "session.create", "done", startedAt, {
        runId,
        sessionID: session.id,
        workspaceId: id,
      });
      return session.id;
    } catch (e) {
      finishPerf(perfEnabled, "session.create", "error", startedAt, {
        runId,
        error: e instanceof Error ? e.message : safeStringify(e),
        workspaceId: id,
      });
      const message = e instanceof Error ? e.message : t("app.unknown_error", currentLocale());
      options.setError(addOpencodeCacheHint(message));
      return undefined;
    } finally {
      options.setCreatingSession(false);
      options.setBusy(false);
      options.setBusyLabel(null);
      options.setBusyStartedAt(null);
    }
  }

  async function createSessionInWorkspace(workspaceId: string, initialPrompt?: string) {
    const id = workspaceId.trim();
    if (!id) return undefined;
    if (options.selectedWorkspaceId().trim() !== id) {
      const selected = await Promise.resolve(options.selectWorkspace(id));
      if (!selected) return undefined;
    }
    const ready = await options.ensureWorkspaceRuntime(id);
    if (!ready) {
      return undefined;
    }
    return await createReadySession(id, initialPrompt);
  }

  async function createSessionAndOpen(initialPrompt?: string) {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(FLUSH_PROMPT_EVENT));
    }
    const workspaceId = options.selectedWorkspaceId().trim();
    if (!workspaceId) {
      return undefined;
    }
    return await createSessionInWorkspace(workspaceId, initialPrompt);
  }

  async function sendPrompt(draft?: ComposerDraft) {
    const hasExplicitDraft = Boolean(draft);
    const fallbackText = options.prompt().trim();
    const resolvedDraft: ComposerDraft = draft ?? {
      mode: "prompt",
      parts: fallbackText ? [{ type: "text", text: fallbackText } as ComposerPart] : [],
      attachments: [] as ComposerAttachment[],
      text: fallbackText,
    };
    const content = (resolvedDraft.resolvedText ?? resolvedDraft.text).trim();
    if (!content && !resolvedDraft.attachments.length) return;

    const workspaceId = options.selectedWorkspaceId().trim();
    if (!workspaceId) return;

    const ready = await options.ensureWorkspaceRuntime(workspaceId);
    if (!ready) return;

    const c = options.client();
    if (!c) return;

    const compactShortcut = /^\/compact(?:\s+.*)?$/i.test(content);
    const compactCommand = resolvedDraft.command?.name === "compact" || compactShortcut;
    const commandName = compactCommand ? "compact" : (resolvedDraft.command?.name ?? null);
    if (compactCommand && !options.selectedSessionId()) {
      options.setError(t("app.error_compact_no_session", currentLocale()));
      return;
    }

    let sessionID = options.selectedSessionId();
    if (!sessionID) {
      await createSessionInWorkspace(workspaceId);
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
      clearSessionDraft(options.selectedWorkspaceId().trim(), sessionID);
      if (!hasExplicitDraft) {
        options.setPrompt("");
      }

      const model = options.selectedSessionModel();
      const agent = selectedSessionAgent();
      const parts = await buildPromptParts(resolvedDraft);
      const selectedVariant = options.sanitizeModelVariantForRef(model, options.modelVariant()) ?? undefined;
      const reasoningEffort = options.resolveCodexReasoningEffort(model.modelID, selectedVariant ?? null);
      const requestVariant = reasoningEffort ? undefined : selectedVariant;
      const promptOverrides = reasoningEffort ? ({ reasoning_effort: reasoningEffort } as const) : undefined;

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
          throw new Error(t("app.error_command_not_resolved", currentLocale()));
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

        options.modelConfig.setSessionModelById((current) => ({
          ...current,
          [sessionID]: model,
        }));

        options.modelConfig.clearSessionModelOverride(sessionID);
      }

      finishPerf(perfEnabled, "session.prompt", "done", startedAt, {
        sessionID,
        mode: resolvedDraft.mode,
        command: commandName,
      });
    } catch (e) {
      finishPerf(perfEnabled, "session.prompt", "error", startedAt, {
        sessionID,
        mode: resolvedDraft.mode,
        command: commandName,
        error: e instanceof Error ? e.message : safeStringify(e),
      });
      const message = e instanceof Error ? e.message : safeStringify(e);
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
      throw new Error(t("app.error_not_connected", currentLocale()));
    }

    const sessionID = (sessionIdOverride ?? options.selectedSessionId() ?? "").trim();
    if (!sessionID) {
      throw new Error(t("app.error_compact_no_session_id", currentLocale()));
    }

    const visible = options.messages();
    if (!visible.length) {
      throw new Error(t("app.error_compact_empty", currentLocale()));
    }

    const model = options.selectedSessionModel();
    const startedAt = perfNow();
    const modelLabel = `${model.providerID}/${model.modelID}`;
    recordPerfLog(options.developerMode(), "session.compact", "start", {
      sessionID,
      messageCount: visible.length,
      model: modelLabel,
      variant: options.sanitizeModelVariantForRef(model, options.modelVariant()) ?? null,
    });

    try {
      await compactSessionTyped(c, sessionID, model, {
        directory: options.runtimeWorkspaceRoot().trim() || options.selectedWorkspaceRoot().trim() || undefined,
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
        error: error instanceof Error ? error.message : safeStringify(error),
      });
      throw error;
    }
  }

  async function undoLastUserMessage() {
    const c = options.client();
    const sessionID = (options.selectedSessionId() ?? "").trim();
    if (!c || !sessionID) return;

    await abortSessionSafe(c, sessionID);

    const users = options.messages().filter((message) => {
      const role = (message.info as { role?: string }).role;
      return role === "user";
    });
    const target = users[users.length - 1];
    if (!target) return;

    const messageID = options.messageIdFromInfo(target);
    if (!messageID) return;

    const nextSession = await revertSession(c, sessionID, messageID);
    options.upsertLocalSession(nextSession);

    if (users.length > 1) {
      options.restorePromptFromUserMessage(users[users.length - 2]);
      return;
    }

    options.setPrompt("");
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
      const id = options.messageIdFromInfo(message);
      return Boolean(id) && id > revertMessageID;
    });

    if (!next) {
      const session = await unrevertSession(c, sessionID);
      options.upsertLocalSession(session);
      options.setPrompt("");
      return;
    }

    const messageID = options.messageIdFromInfo(next);
    if (!messageID) return;

    const nextSession = await revertSession(c, sessionID, messageID);
    options.upsertLocalSession(nextSession);

    let prior: MessageWithParts | null = null;
    for (let idx = users.length - 1; idx >= 0; idx -= 1) {
      const candidate = users[idx];
      const id = options.messageIdFromInfo(candidate);
      if (id && id < messageID) {
        prior = candidate;
        break;
      }
    }

    if (prior) {
      options.restorePromptFromUserMessage(prior);
      return;
    }

    options.setPrompt("");
  }

  async function renameSessionTitle(sessionID: string, title: string) {
    const trimmed = title.trim();
    if (!trimmed) {
      throw new Error(t("app.error_session_name_required", currentLocale()));
    }

    await options.renameSession(sessionID, trimmed);
    await options.refreshSidebarWorkspaceSessions(options.selectedWorkspaceId()).catch(() => undefined);
  }

  async function deleteSessionById(sessionID: string) {
    const trimmed = sessionID.trim();
    if (!trimmed) return;
    const c = options.client();
    if (!c) {
      throw new Error(t("app.error_not_connected", currentLocale()));
    }

    const root = options.selectedWorkspaceRoot().trim();
    const directory = toSessionTransportDirectory(root);
    const params = directory ? { sessionID: trimmed, directory } : { sessionID: trimmed };
    unwrap(await c.session.delete(params));
    clearSessionDraft(options.selectedWorkspaceId().trim(), trimmed);

    options.setSessions(options.sessions().filter((s) => s.id !== trimmed));
    const activeWsId = options.selectedWorkspaceId();
    await options.refreshSidebarWorkspaceSessions(activeWsId).catch(() => undefined);

    try {
      const path = options.locationPath().toLowerCase();
      if (path === `/session/${trimmed.toLowerCase()}`) {
        options.navigate("/session", { replace: true });
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

  async function listAgents(): Promise<Agent[]> {
    const c = options.client();
    if (!c) return [];
    const list = unwrap(await c.app.agents());
    return list.filter((agent) => !agent.hidden && agent.mode !== "subagent");
  }

  const BUILTIN_COMPACT_COMMAND = {
    id: "builtin:compact",
    name: "compact",
    description: t("app.compact_command_desc", currentLocale()),
    source: "command" as const,
  };

  async function listCommands(): Promise<{ id: string; name: string; description?: string; source?: "command" | "mcp" | "skill" }[]> {
    const c = options.client();
    if (!c) return [];
    const directory = options.runtimeWorkspaceRoot().trim() || options.selectedWorkspaceRoot().trim() || undefined;
    const list = await listCommandsTyped(c, directory);
    if (list.some((entry) => entry.name === "compact")) {
      return list;
    }
    return [BUILTIN_COMPACT_COMMAND, ...list];
  }

  function setSessionAgent(sessionID: string, agent: string | null) {
    const trimmed = agent?.trim() ?? "";
    setSessionAgentById((current) => {
      const next = { ...current };
      if (!trimmed) {
        delete next[sessionID];
        return next;
      }
      next[sessionID] = trimmed;
      return next;
    });
  }

  const searchWorkspaceFiles = async (query: string) => {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const activeClient = options.client();
    if (!activeClient) return [];
    try {
      const directory = options.runtimeWorkspaceRoot().trim() || options.selectedWorkspaceRoot().trim();
      const result = unwrap(
        await activeClient.find.files({
          query: trimmed,
          dirs: "true",
          limit: 50,
          directory: directory || undefined,
        }),
      );
      return result;
    } catch {
      return [];
    }
  };

  return {
    lastPromptSent,
    selectedSessionAgent,
    sessionRevertMessageId,
    createSessionInWorkspace,
    createSessionAndOpen,
    sendPrompt,
    abortSession,
    retryLastPrompt,
    compactCurrentSession,
    undoLastUserMessage,
    redoLastUserMessage,
    renameSessionTitle,
    deleteSessionById,
    listAgents,
    listCommands,
    setSessionAgent,
    searchWorkspaceFiles,
  };
}
