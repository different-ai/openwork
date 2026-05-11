/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { UIMessage } from "ai";
import { useQuery } from "@tanstack/react-query";
import type { SessionStatus } from "@opencode-ai/sdk/v2/client";

import { createClient, unwrap } from "../../../../app/lib/opencode";
import { abortSessionSafe } from "../../../../app/lib/opencode-session";
import { readWorkspaceCloudImports, type CloudImportedPlugin } from "../../../../app/cloud/import-state";
import type {
  OpenworkServerClient,
  OpenworkSessionSnapshot,
} from "../../../../app/lib/openwork-server";
import type {
  ComposerAttachment,
  ComposerDraft,
  ComposerPart,
  McpServerEntry,
  McpStatusMap,
  ModelRef,
  SkillCard,
} from "../../../../app/types";
import {
  publishInspectorSlice,
  recordInspectorEvent,
} from "../../../shell/app-inspector";
import { useControlAction, type OpenworkControlAction } from "../../../shell/control/control-provider";
import { getReactQueryClient } from "../../../infra/query-client";
import { ReactSessionComposer } from "./composer/composer";
import { DevProfiler } from "../../../shell/dev-profiler";
import { OwDotTicker } from "../../../shell/dot-ticker";
import { useReactRenderWatchdog } from "../../../shell/react-render-watchdog";
import type { ReactComposerNotice } from "./composer/notice";
import { SessionDebugPanel } from "./debug-panel";
import { deriveRenderedSessionMessages, resolveRenderedSessionSnapshot } from "./session-render-state";
import { SessionTranscript } from "./message-list";
import { useLocal } from "../../../kernel/local-provider";
import { deriveSessionRenderModel } from "../sync/transition-controller";
import { useSessionScrollController } from "./scroll-controller";
import {
  seedSessionState,
  statusKey as reactStatusKey,
  transcriptKey as reactTranscriptKey,
} from "../sync/session-sync";

const EMPTY_TRANSCRIPT: UIMessage[] = [];
const IDLE_STATUS: SessionStatus = { type: "idle" };
const DEFAULT_COMPOSER_CONTROL_TEXT = "Help me outline the next OpenWork task.";

type SessionError = {
  message: string;
  kind?: "model-not-found" | "generic";
  /** For model-not-found: the model that failed. */
  failedModel?: { providerID: string; modelID: string };
  /** For model-not-found: suggested replacements from the backend. */
  suggestions?: Array<{ providerID: string; modelID: string }>;
};

export type SessionSurfaceProps = {
  client: OpenworkServerClient;
  workspaceId: string;
  workspaceRoot: string;
  sessionId: string;
  opencodeBaseUrl: string;
  openworkToken: string;
  developerMode: boolean;
  modelLabel: string;
  onModelClick: () => void;
  modelPickerOpen: boolean;
  selectedModel: ModelRef;
  onModelPickerOpenChange: (open: boolean) => void;
  onModelChange: (model: ModelRef) => void;
  onSendDraft: (draft: ComposerDraft) => void;
  onDraftChange: (draft: ComposerDraft) => void;
  attachmentsEnabled: boolean;
  attachmentsDisabledReason: string | null;
  modelVariantLabel: string;
  modelVariant: string | null;
  modelBehaviorOptions?: { value: string | null; label: string }[];
  onModelVariantChange: (value: string | null) => void;
  agentLabel: string;
  selectedAgent: string | null;
  listAgents: () => Promise<import("@opencode-ai/sdk/v2/client").Agent[]>;
  onSelectAgent: (agent: string | null) => void;
  listCommands: () => Promise<import("../../../../app/types").SlashCommandOption[]>;
  recentFiles: string[];
  searchFiles: (query: string) => Promise<string[]>;
  isRemoteWorkspace: boolean;
  isSandboxWorkspace: boolean;
  onChangeModel?: (model: { providerID: string; modelID: string }) => void;
  onUploadInboxFiles?: ((files: File[], options?: { notify?: boolean }) => void | Promise<unknown>) | null;
  onOpenSettingsSection?: ((section: "commands" | "skills" | "mcps" | "plugins") => void) | undefined;
};

function messageToReadableText(message: UIMessage) {
  const header = message.role === "user" ? "You" : message.role === "assistant" ? "OpenWork" : message.role;
  const body = message.parts
    .flatMap((part) => {
      if (part.type === "text") return [part.text];
      if (part.type === "reasoning") return [part.text];
      if (part.type === "dynamic-tool") {
        if (part.state === "output-error") return [`[tool:${part.toolName}] ${part.errorText}`];
        if (part.state === "output-available") return [`[tool:${part.toolName}] ${JSON.stringify(part.output)}`];
        return [`[tool:${part.toolName}] ${JSON.stringify(part.input)}`];
      }
      return [];
    })
    .join("\n\n");
  return `${header}\n${body}`.trim();
}

function transcriptToText(messages: UIMessage[]) {
  return messages
    .flatMap((message) => {
      const text = messageToReadableText(message);
      return text ? [text] : [];
    })
    .join("\n\n---\n\n");
}

function statusLabel(snapshot: OpenworkSessionSnapshot | undefined, busy: boolean) {
  if (busy) return "Running...";
  if (snapshot?.status.type === "busy") return "Running...";
  if (snapshot?.status.type === "retry") return `Retrying: ${snapshot.status.message}`;
  return "Ready";
}

function controlTextArgument(args: unknown) {
  if (typeof args === "string") return args;
  if (args && typeof args === "object" && "text" in args) {
    const text = (args as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return DEFAULT_COMPOSER_CONTROL_TEXT;
}

const waitForControl = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

function useSharedQueryState<T>(queryKey: readonly unknown[], fallback: T) {
  const queryClient = getReactQueryClient();
  // useSyncExternalStore requires getSnapshot to return the same reference
  // while the external store has not changed. Callers must pass stable
  // fallbacks for empty cache states.
  return useSyncExternalStore(
    (callback) => queryClient.getQueryCache().subscribe(callback),
    () => (queryClient.getQueryData<T>(queryKey) ?? fallback),
    () => fallback,
  );
}

function messageHasVisibleAssistantOutput(message: UIMessage) {
  if (message.role !== "assistant") return false;
  return message.parts.some((part) => {
    if ("text" in part && typeof part.text === "string") return part.text.trim().length > 0;
    return part.type === "dynamic-tool" || part.type === "file";
  });
}

function AssistantWaitingCard() {
  return (
    <div className="flex justify-start py-2" role="status" aria-live="polite">
      <div className="inline-flex items-center gap-3 rounded-full px-3 py-1.5 text-[12px] text-dls-secondary">
        <OwDotTicker size="sm" />
        <span>Thinking</span>
      </div>
    </div>
  );
}

function parseSessionError(thrown: unknown): SessionError {
  const raw = thrown instanceof Error ? thrown.message : String(thrown);
  // Try to detect ProviderModelNotFoundError from the SDK error shape.
  // The error message may be a JSON string from our serializer in session-route.
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.name === "ProviderModelNotFoundError" && parsed?.data) {
      const { providerID, modelID, suggestions } = parsed.data;
      return {
        message: `Model ${providerID}/${modelID} is not available.`,
        kind: "model-not-found",
        failedModel: { providerID, modelID },
        suggestions: Array.isArray(suggestions) ? suggestions : [],
      };
    }
  } catch {
    // Not JSON — fall through to plain message
  }
  // Check if the raw string mentions model-not-found patterns
  if (/ProviderModelNotFoundError/i.test(raw) || /model.*not found/i.test(raw)) {
    return { message: raw, kind: "model-not-found" };
  }
  return { message: raw || "Failed to send prompt." };
}

function SessionErrorCard({ error, onDismiss, onChangeModel, onOpenModelPicker }: {
  error: SessionError;
  onDismiss: () => void;
  onChangeModel?: (model: { providerID: string; modelID: string }) => void;
  onOpenModelPicker?: () => void;
}) {
  return (
    <div className="mx-auto max-w-[720px] px-3 py-3 sm:px-5">
      <div className="rounded-2xl border border-red-6/30 bg-red-3/15 px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-red-11">{error.message}</div>
            {error.kind === "model-not-found" ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {error.suggestions && error.suggestions.length > 0 ? (
                  error.suggestions.map((s) => (
                    <button
                      key={`${s.providerID}/${s.modelID}`}
                      type="button"
                      className="rounded-full border border-dls-border bg-dls-surface px-3 py-1.5 text-xs font-medium text-dls-text transition-colors hover:bg-dls-hover"
                      onClick={() => {
                        onChangeModel?.(s);
                        onDismiss();
                      }}
                    >
                      Use {s.providerID}/{s.modelID}
                    </button>
                  ))
                ) : null}
                <button
                  type="button"
                  className="rounded-full border border-dls-border bg-dls-surface px-3 py-1.5 text-xs font-medium text-dls-text transition-colors hover:bg-dls-hover"
                  onClick={() => {
                    onOpenModelPicker?.();
                    onDismiss();
                  }}
                >
                  Change model
                </button>
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="shrink-0 rounded-full p-1 text-red-10 transition-colors hover:bg-red-3 hover:text-red-11"
            onClick={onDismiss}
            aria-label="Dismiss error"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          </button>
        </div>
      </div>
    </div>
  );
}

function revokeAttachmentPreview(attachment: { previewUrl?: string | undefined }) {
  if (!attachment.previewUrl) return;
  URL.revokeObjectURL(attachment.previewUrl);
}

export function SessionSurface(props: SessionSurfaceProps) {
  const local = useLocal();
  const showThinking = local.prefs.showThinking;
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [mentions, setMentions] = useState<Record<string, "agent" | "file">>({});
  const [pasteParts, setPasteParts] = useState<Array<{ id: string; label: string; text: string; lines: number }>>([]);
  const [notice, setNotice] = useState<ReactComposerNotice | null>(null);
  const [error, setError] = useState<SessionError | null>(null);
  const [sending, setSending] = useState(false);
  const [showDelayedLoading, setShowDelayedLoading] = useState(false);
  const [awaitingAssistantBaseline, setAwaitingAssistantBaseline] = useState<number | null>(null);
  const [rendered, setRendered] = useState<{ sessionId: string; snapshot: OpenworkSessionSnapshot } | null>(null);
  const [toolSkills, setToolSkills] = useState<SkillCard[]>([]);
  const [toolMcpServers, setToolMcpServers] = useState<McpServerEntry[]>([]);
  const [toolMcpStatus, setToolMcpStatus] = useState<string | null>(null);
  const [toolMcpStatuses, setToolMcpStatuses] = useState<McpStatusMap>({});
  const [toolImportedPlugins, setToolImportedPlugins] = useState<CloudImportedPlugin[]>([]);
  const composerShellRef = useRef<HTMLDivElement>(null);
  const hydratedKeyRef = useRef<string | null>(null);
  const attachmentsRef = useRef<ComposerAttachment[]>([]);
  attachmentsRef.current = attachments;
  const opencodeClient = useMemo(
    () => createClient(props.opencodeBaseUrl, undefined, { token: props.openworkToken, mode: "openwork" }),
    [props.opencodeBaseUrl, props.openworkToken],
  );

  const snapshotQueryKey = useMemo(
    () => ["react-session-snapshot", props.workspaceId, props.sessionId],
    [props.workspaceId, props.sessionId],
  );
  const transcriptQueryKey = useMemo(
    () => reactTranscriptKey(props.workspaceId, props.sessionId),
    [props.workspaceId, props.sessionId],
  );
  const statusQueryKey = useMemo(
    () => reactStatusKey(props.workspaceId, props.sessionId),
    [props.workspaceId, props.sessionId],
  );
  const snapshotQuery = useQuery<OpenworkSessionSnapshot>({
    queryKey: snapshotQueryKey,
    queryFn: async () => (await props.client.getSessionSnapshot(props.workspaceId, props.sessionId, { limit: 140 })).item,
    staleTime: 500,
  });

  const currentSnapshot = snapshotQuery.data?.session.id === props.sessionId ? snapshotQuery.data : null;
  const transcriptState = useSharedQueryState<UIMessage[]>(transcriptQueryKey, EMPTY_TRANSCRIPT);
  const statusState = useSharedQueryState(statusQueryKey, currentSnapshot?.status ?? IDLE_STATUS);

  useEffect(() => {
    if (!currentSnapshot) return;
    setRendered({ sessionId: props.sessionId, snapshot: currentSnapshot });
  }, [props.sessionId, currentSnapshot]);

  useEffect(() => {
    hydratedKeyRef.current = null;
    setError(null);
    setSending(false);
    setShowDelayedLoading(false);
    setAwaitingAssistantBaseline(null);
    // Clear draft + attachments + mentions on session change so typed text
    // doesn't bleed across sessions (and across workspaces). The sessionId
    // effectively changes when the workspace changes too because the route
    // navigates to the remembered session id for that workspace.
    setDraft("");
    setAttachments((current) => {
      current.forEach(revokeAttachmentPreview);
      return [];
    });
    setMentions({});
    setPasteParts([]);
    setNotice(null);
  }, [props.sessionId]);

  useEffect(() => {
    return () => {
      attachmentsRef.current.forEach(revokeAttachmentPreview);
    };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(null), 2400);
    return () => window.clearTimeout(id);
  }, [notice]);

  // Publish a composer inspector slice so external drivers can read draft
  // state, attachments, mentions, and sending status from the running app.
  useEffect(() => {
    const dispose = publishInspectorSlice("composer", () => ({
      workspaceId: props.workspaceId,
      sessionId: props.sessionId,
      draft,
      draftLength: draft.length,
      attachments: attachments.map((attachment) => ({
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.size,
        kind: attachment.kind,
      })),
      mentions,
      pasteParts: pasteParts.map((part) => ({
        id: part.id,
        label: part.label,
        lines: part.lines,
      })),
      sending,
      error,
      hasNotice: Boolean(notice),
    }));
    return dispose;
  }, [
    attachments,
    draft,
    error,
    mentions,
    notice,
    pasteParts,
    props.sessionId,
    props.workspaceId,
    sending,
  ]);

  useEffect(() => {
    recordInspectorEvent("session.mounted", {
      workspaceId: props.workspaceId,
      sessionId: props.sessionId,
    });
  }, [props.sessionId, props.workspaceId]);

  useEffect(() => {
    if (!currentSnapshot) return;
    seedSessionState(props.workspaceId, currentSnapshot);
  }, [currentSnapshot, props.sessionId, props.workspaceId]);

  useEffect(() => {
    if (!currentSnapshot) return;
    const key = `${props.sessionId}:${currentSnapshot.session.time?.updated ?? currentSnapshot.session.time?.created ?? 0}:${currentSnapshot.messages.length}`;
    if (hydratedKeyRef.current === key) return;
    hydratedKeyRef.current = key;
    seedSessionState(props.workspaceId, currentSnapshot);
  }, [props.sessionId, currentSnapshot, props.workspaceId]);

  const snapshot = resolveRenderedSessionSnapshot({
    sessionId: props.sessionId,
    currentSnapshot,
    cachedRendered: rendered,
  });
  const liveStatus = statusState ?? snapshot?.status ?? IDLE_STATUS;
  const chatStreaming = sending || liveStatus.type === "busy" || liveStatus.type === "retry";
  const renderedMessages = useMemo(
    () => deriveRenderedSessionMessages({ transcriptState, snapshot }),
    [snapshot, transcriptState],
  );
  const pendingSessionLoad = !snapshot && snapshotQuery.isLoading && renderedMessages.length === 0;
  const assistantOutputAfterAwaitStart = useMemo(() => {
    if (awaitingAssistantBaseline === null) return false;
    return renderedMessages
      .slice(awaitingAssistantBaseline)
      .some(messageHasVisibleAssistantOutput);
  }, [awaitingAssistantBaseline, renderedMessages]);
  const showAssistantWaitState = awaitingAssistantBaseline !== null && !assistantOutputAfterAwaitStart;
  useReactRenderWatchdog("SessionSurface", {
    sessionId: props.sessionId,
    workspaceId: props.workspaceId,
    messageCount: renderedMessages.length,
    liveStatus: liveStatus.type,
    sending,
    pendingSessionLoad,
    showAssistantWaitState,
    hasSnapshot: Boolean(snapshot),
  });

  useEffect(() => {
    if (!pendingSessionLoad) {
      setShowDelayedLoading(false);
      return;
    }
    const id = window.setTimeout(() => setShowDelayedLoading(true), 2000);
    return () => window.clearTimeout(id);
  }, [pendingSessionLoad]);

  useEffect(() => {
    if (awaitingAssistantBaseline === null) return;
    if (assistantOutputAfterAwaitStart) {
      setAwaitingAssistantBaseline(null);
      return;
    }
    if (sending || liveStatus.type !== "idle" || renderedMessages.length <= awaitingAssistantBaseline) return;
    const id = window.setTimeout(() => setAwaitingAssistantBaseline(null), 1200);
    return () => window.clearTimeout(id);
  }, [assistantOutputAfterAwaitStart, awaitingAssistantBaseline, liveStatus.type, renderedMessages.length, sending]);

  const model = deriveSessionRenderModel({
    intendedSessionId: props.sessionId,
    renderedSessionId: renderedMessages.length > 0 || snapshot ? props.sessionId : null,
    hasSnapshot: Boolean(snapshot) || renderedMessages.length > 0,
    isFetching: snapshotQuery.isFetching,
    isError: snapshotQuery.isError || Boolean(error),
  });

  const buildDraft = useCallback((text: string, nextAttachments: ComposerAttachment[]): ComposerDraft => {
    const trimmed = text.trim();
    const slashMatch = trimmed.match(/^\/([^\s]+)\s*(.*)$/);
    const parts: ComposerPart[] = text.split(/(\[pasted text [^\]]+\]|@[^\s@]+)/).flatMap((segment) => {
      if (!segment) return [] as ComposerDraft["parts"];
      const pasteMatch = segment.match(/^\[pasted text (.+)\]$/);
      if (pasteMatch) {
        const target = pasteParts.find((item) => item.label === pasteMatch[1]);
        if (target) {
          return [{ type: "paste", id: target.id, label: target.label, text: target.text, lines: target.lines }];
        }
      }
      if (segment.startsWith("@")) {
        const value = segment.slice(1);
        const kind = mentions[value];
        if (kind === "agent") return [{ type: "agent", name: value } satisfies ComposerDraft["parts"][number]];
        if (kind === "file") return [{ type: "file", path: value, label: value } satisfies ComposerDraft["parts"][number]];
      }
      return [{ type: "text", text: segment } satisfies ComposerDraft["parts"][number]];
    });
    // Expand paste placeholders in resolvedText so the model receives
    // the actual pasted content instead of "[pasted text <label>]".
    let resolved = text;
    for (const part of pasteParts) {
      resolved = resolved.replace(`[pasted text ${part.label}]`, part.text);
    }
    return {
      mode: "prompt",
      parts,
      attachments: nextAttachments,
      text,
      resolvedText: resolved,
      command: slashMatch ? { name: slashMatch[1] ?? "", arguments: slashMatch[2] ?? "" } : undefined,
    };
  }, [mentions, pasteParts]);

  const handleCopyTranscript = async () => {
    try {
      await navigator.clipboard.writeText(transcriptToText(renderedMessages));
    } catch (nextError) {
      setError({ message: nextError instanceof Error ? nextError.message : "Failed to copy transcript." });
    }
  };

  const handleSend = useCallback(async () => {
    const text = draft.trim();
    if (!text && attachments.length === 0) return;
    // Intentionally allow sending while the assistant is still streaming.
    // OpenCode accepts follow-up user turns mid-run and queues them; if the
    // backend can't accept the follow-up it'll surface an error via the
    // catch below. This restores the "append a prompt while it's still
    // talking" behavior that the Solid composer had.
    setError(null);
    setSending(true);
    setAwaitingAssistantBaseline(renderedMessages.length);
    try {
      const nextDraft = buildDraft(text, attachments);
      await props.onSendDraft(nextDraft);
      setDraft("");
      attachments.forEach(revokeAttachmentPreview);
      setAttachments([]);
      props.onDraftChange(buildDraft("", []));
      setSending(false);
    } catch (nextError) {
      const parsed = parseSessionError(nextError);
      setError(parsed);
      setDraft("");
      setAwaitingAssistantBaseline(null);
      setSending(false);
    }
  }, [attachments, buildDraft, draft, props.onDraftChange, props.onSendDraft, renderedMessages.length]);

  const handleAbort = useCallback(async () => {
    if (!chatStreaming) return;
    setError(null);
    try {
      await abortSessionSafe(opencodeClient, props.sessionId);
      await snapshotQuery.refetch();
    } catch (nextError) {
      setError({ message: nextError instanceof Error ? nextError.message : "Failed to stop run." });
    }
  }, [chatStreaming, opencodeClient, props.sessionId, snapshotQuery.refetch]);

  useEffect(() => {
    if (liveStatus.type === "idle") {
      setSending(false);
    }
  }, [liveStatus.type]);

  useEffect(() => {
    props.onDraftChange(buildDraft(draft, attachments));
  }, [attachments, buildDraft, draft, props.onDraftChange]);

  const handleAttachFiles = (files: File[]) => {
    if (!props.attachmentsEnabled) {
      setNotice({ title: props.attachmentsDisabledReason ?? "Attachments are unavailable.", tone: "warning" });
      return;
    }
    const oversized = files.filter((file) => file.size > 25 * 1024 * 1024);
    const accepted = files.filter((file) => file.size <= 25 * 1024 * 1024);
    if (oversized.length) {
      setNotice({
        title: oversized.length === 1 ? `${oversized[0]?.name ?? "File"} is too large` : `${oversized.length} files are too large`,
        description: "Files over 25 MB were skipped.",
        tone: "warning",
      });
    }
    if (!accepted.length) return;
    const next = accepted.map((file) => ({
      id: `${file.name}-${file.lastModified}-${Math.random().toString(36).slice(2)}`,
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      size: file.size,
      kind: file.type.startsWith("image/") ? "image" as const : "file" as const,
      file,
      previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
    }));
    setAttachments((current) => [...current, ...next]);
    setNotice({
      title: next.length === 1 ? `Attached ${next[0]?.name ?? "file"}` : `Attached ${next.length} files`,
      tone: "success",
    });
  };

  const handleRemoveAttachment = (id: string) => {
    setAttachments((current) => {
      const target = current.find((item) => item.id === id);
      if (target?.previewUrl) {
        URL.revokeObjectURL(target.previewUrl);
      }
      return current.filter((item) => item.id !== id);
    });
  };

  const handleInsertMention = (kind: "agent" | "file", value: string) => {
    setDraft((current) => current.replace(/@([^\s@]*)$/, `@${value} `));
    setMentions((current) => ({ ...current, [value]: kind }));
  };

  const handlePasteText = (text: string) => {
    const id = `paste-${Math.random().toString(36).slice(2)}`;
    const label = `${id.slice(-4)} · ${text.split(/\r?\n/).length} lines`;
    setPasteParts((current) => [...current, { id, label, text, lines: text.split(/\r?\n/).length }]);
    setDraft((current) => `${current}[pasted text ${label}]`);
  };

  const handleRevealPastedText = (id: string) => {
    const part = pasteParts.find((item) => item.id === id);
    if (!part) return;
    setNotice({
      title: `Pasted text · ${part.label}`,
      description: part.text.slice(0, 800),
      tone: "info",
    });
  };

  const handleRemovePastedText = (id: string) => {
    setPasteParts((current) => {
      const target = current.find((item) => item.id === id);
      if (!target) return current;
      setDraft((draftValue) => draftValue.replace(`[pasted text ${target.label}]`, ""));
      return current.filter((item) => item.id !== id);
    });
  };

  const handleUnsupportedFileLinks = (links: string[]) => {
    if (!links.length) return;
    setDraft((current) => `${current}${current && !current.endsWith("\n") ? "\n" : ""}${links.join("\n")}`);
  };

  const typeComposerText = useCallback(async (text: string) => {
    window.dispatchEvent(new Event("openwork:focusPrompt"));
    setDraft(text);
    await waitForControl(40);
  }, []);

  const composerSetTextControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "composer.set_text",
    label: "Type into the composer",
    description: "Replace the current session draft and type the supplied text visibly.",
    sideEffect: "none",
    requiresArgs: true,
    args: [{ name: "text", type: "string", required: true, description: "Prompt text to place in the composer." }],
    previewArgs: { text: DEFAULT_COMPOSER_CONTROL_TEXT },
    targetRef: composerShellRef,
    execute: async (args, helpers) => {
      const text = controlTextArgument(args);
      helpers.setNarration(`Typing ${text.length.toLocaleString()} characters into the composer…`);
      await typeComposerText(text);
      props.onDraftChange(buildDraft(text, attachments));
      return { draftLength: text.length };
    },
  }), [attachments, buildDraft, props.onDraftChange, typeComposerText]);
  useControlAction(composerSetTextControlAction);

  const composerSendControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "composer.send",
    label: "Send the composer prompt",
    description: "Send the currently visible composer draft to the active session.",
    sideEffect: "mutation",
    disabled: (!draft.trim() && attachments.length === 0) || model.transitionState !== "idle",
    targetRef: composerShellRef,
    execute: async () => {
      await handleSend();
      return true;
    },
  }), [attachments.length, draft, handleSend, model.transitionState]);
  useControlAction(composerSendControlAction);

  const composerStopControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "composer.stop",
    label: "Stop the current run",
    description: "Stop the current streaming session run.",
    sideEffect: "mutation",
    disabled: !chatStreaming,
    targetRef: composerShellRef,
    execute: async () => {
      await handleAbort();
      return true;
    },
  }), [chatStreaming, handleAbort]);
  useControlAction(composerStopControlAction);

  const listSkills = async (): Promise<SkillCard[]> => {
    const response = await props.client.listSkills(props.workspaceId, { includeGlobal: true });
    const next = (response.items ?? []).map((skill) => ({
      name: skill.name,
      path: skill.path,
      description: skill.description,
      trigger: skill.trigger,
    } satisfies SkillCard));
    setToolSkills(next);
    return next;
  };

  const listMcp = async (): Promise<{ servers: McpServerEntry[]; statuses: McpStatusMap; status: string | null }> => {
    const response = await props.client.listMcp(props.workspaceId);
    const servers = (response.items ?? []).map((entry) => ({
      name: entry.name,
      config: entry.config as McpServerEntry["config"],
    } satisfies McpServerEntry));

    let statuses: McpStatusMap = {};
    try {
      if (props.workspaceRoot.trim()) {
        statuses = unwrap(await opencodeClient.mcp.status({ directory: props.workspaceRoot.trim() })) as McpStatusMap;
      }
    } catch {
      statuses = {};
    }

    const status = servers.length ? null : "No MCP servers loaded.";
    setToolMcpServers(servers);
    setToolMcpStatuses(statuses);
    setToolMcpStatus(status);
    return { servers, statuses, status };
  };

  const listImportedPlugins = async (): Promise<CloudImportedPlugin[]> => {
    const response = await props.client.getConfig(props.workspaceId);
    const plugins = Object.values(readWorkspaceCloudImports(response.openwork).plugins)
      .sort((left, right) => left.name.localeCompare(right.name));
    setToolImportedPlugins(plugins);
    return plugins;
  };

  const handleUploadInboxFiles = async (files: File[], options?: { notify?: boolean }) => {
    const input = files.filter(Boolean);
    if (!input.length) return;
    try {
      const results = await Promise.all(input.map((file) => props.client.uploadInbox(props.workspaceId, file)));
      if (options?.notify !== false) {
        const summary = results.map((item) => item.path.split("/").filter(Boolean).slice(-1)[0] ?? item.path).join(", ");
        setNotice({
          title: input.length === 1 ? "Uploaded to the shared folder." : `Uploaded ${input.length} files to the shared folder.`,
          description: summary || undefined,
          tone: "success",
        });
      }
      return results;
    } catch (nextError) {
      setNotice({
        title: nextError instanceof Error ? nextError.message : "Shared folder upload failed",
        tone: "warning",
      });
      throw nextError;
    }
  };

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const sessionScroll = useSessionScrollController({
    selectedSessionId: props.sessionId,
    renderedMessages,
    containerRef: scrollRef,
    contentRef,
  });

  const sessionScrollTopControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "session.scroll_top",
    label: "Go to the top of the session",
    description: "Scroll the visible session transcript to the first messages.",
    sideEffect: "none",
    execute: () => {
      const container = scrollRef.current;
      if (!container) return { ok: false, error: "Session transcript is not mounted" };
      container.scrollTo({ top: 0, behavior: "smooth" });
      return { ok: true, position: "top" };
    },
  }), []);
  useControlAction(sessionScrollTopControlAction);

  const sessionScrollBottomControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "session.scroll_bottom",
    label: "Go to the bottom of the session",
    description: "Scroll the visible session transcript to the newest messages and composer area.",
    sideEffect: "none",
    execute: () => {
      sessionScroll.jumpToLatest("smooth");
      return { ok: true, position: "bottom" };
    },
  }), [sessionScroll.jumpToLatest]);
  useControlAction(sessionScrollBottomControlAction);

  const sessionLatestMessageControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "session.latest_message",
    label: "Read the latest session message",
    description: "Return the latest visible message in the current session transcript.",
    sideEffect: "none",
    execute: () => {
      const message = renderedMessages[renderedMessages.length - 1];
      if (!message) return { ok: false, error: "No messages are visible in this session" };
      return {
        ok: true,
        sessionId: props.sessionId,
        index: renderedMessages.length - 1,
        role: message.role,
        text: messageToReadableText(message),
      };
    },
  }), [props.sessionId, renderedMessages]);
  useControlAction(sessionLatestMessageControlAction);

  const sessionReadTranscriptControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "session.read_transcript",
    label: "Read the current session transcript",
    description: "Return the last messages from the current session transcript as readable text, including the session ID, title, and message count.",
    sideEffect: "none",
    args: [{ name: "count", type: "number", required: false, description: "Number of recent messages to return, from 1 to 30. Defaults to 10." }],
    execute: (args) => {
      const count = typeof args === "object" && args !== null && "count" in args && typeof (args as { count?: unknown }).count === "number"
        ? Math.min(Math.max(1, (args as { count: number }).count), 30)
        : 10;
      const total = renderedMessages.length;
      const slice = renderedMessages.slice(-count);
      if (!slice.length) return { ok: false, error: "No messages in this session" };
      return {
        ok: true,
        sessionId: props.sessionId,
        messageCount: total,
        returned: slice.length,
        messages: slice.map((message, index) => ({
          index: total - slice.length + index,
          role: message.role,
          text: messageToReadableText(message),
        })),
      };
    },
  }), [props.sessionId, renderedMessages]);
  useControlAction(sessionReadTranscriptControlAction);

  return (
    <DevProfiler id="SessionSurface">
    <div className="flex h-full min-h-0 flex-col">
      {model.transitionState === "switching" && showDelayedLoading ? (
        <div className="flex justify-center px-6 pt-4">
          <div className="rounded-full border border-dls-border bg-dls-hover/80 px-3 py-1 text-xs text-dls-secondary">
            {model.renderSource === "cache" ? "Switching session from cache..." : "Switching session..."}
          </div>
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onWheel={(event) => {
            sessionScroll.markScrollGesture(event.target);
          }}
          onTouchStart={(event) => {
            sessionScroll.markScrollGesture(event.target);
          }}
          onTouchMove={(event) => {
            sessionScroll.markScrollGesture(event.target);
          }}
          onPointerDown={(event) => {
            if (event.target !== event.currentTarget) return;
            sessionScroll.markScrollGesture(event.currentTarget);
          }}
          onScroll={sessionScroll.handleScroll}
          className="absolute inset-0 overflow-x-hidden overflow-y-auto overscroll-y-contain px-3 py-4 sm:px-5"
        >
          {/* Chat column: tighter than the composer (800px) so messages
               keep a comfortable reading width and don't feel "too big". */}
          <div ref={contentRef} className="mx-auto w-full max-w-[720px]">
            {showDelayedLoading && pendingSessionLoad ? (
              <div className="px-6 py-16">
                <div className="mx-auto max-w-sm rounded-3xl border border-dls-border bg-dls-hover/60 px-8 py-10 text-center">
                  <div className="text-sm text-dls-secondary">Opening session…</div>
                </div>
              </div>
            ) : (snapshotQuery.isError || error) && !snapshot && renderedMessages.length === 0 ? (
              <div className="px-6 py-8">
                {error ? (
                  <SessionErrorCard
                    error={error}
                    onDismiss={() => setError(null)}
                    onChangeModel={props.onChangeModel}
                    onOpenModelPicker={props.onModelClick}
                  />
                ) : (
                  <div className="mx-auto max-w-xl rounded-3xl border border-red-6/40 bg-red-3/20 px-6 py-5 text-sm text-red-11">
                    {snapshotQuery.error instanceof Error ? snapshotQuery.error.message : "Failed to load session."}
                  </div>
                )}
              </div>
            ) : renderedMessages.length === 0 && showAssistantWaitState ? (
              <div className="px-6 py-12">
                <AssistantWaitingCard />
              </div>
            ) : renderedMessages.length === 0 && snapshot && snapshot.messages.length === 0 ? (
              error ? (
                <SessionErrorCard
                  error={error}
                  onDismiss={() => setError(null)}
                  onChangeModel={props.onChangeModel}
                  onOpenModelPicker={props.onModelClick}
                />
              ) : (
                <div className="flex flex-1 flex-col items-center justify-end px-6 pb-4">
                  <div className="w-full max-w-[640px]">
                    <p className="mb-3 text-xs text-dls-secondary">Try one of these:</p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className="flex flex-1 items-start gap-2.5 rounded-xl border border-dls-border bg-dls-surface p-3 text-left transition-colors hover:bg-dls-hover"
                        onClick={() => void typeComposerText("Create a sample CSV file with 20 rows of fake customer data (name, email, company, revenue). Then show me a summary of the data.")}
                      >
                        <img src="https://cdn.simpleicons.org/googlesheets" alt="" width={16} height={16} className="mt-0.5 shrink-0" />
                        <div>
                          <div className="text-[12px] font-medium text-dls-text">Edit a CSV</div>
                          <div className="text-[11px] text-dls-secondary">Create a sample spreadsheet</div>
                        </div>
                      </button>
                      <button
                        type="button"
                        className="flex flex-1 items-start gap-2.5 rounded-xl border border-dls-border bg-dls-surface p-3 text-left transition-colors hover:bg-dls-hover"
                        onClick={() => void typeComposerText("Open craigslist.org in the browser and search for couches for sale. Show me the top 5 results with prices.")}
                      >
                        <img src="https://cdn.simpleicons.org/googlechrome" alt="" width={16} height={16} className="mt-0.5 shrink-0" />
                        <div>
                          <div className="text-[12px] font-medium text-dls-text">Browse the web</div>
                          <div className="text-[11px] text-dls-secondary">Search Craigslist for couches</div>
                        </div>
                      </button>
                      <button
                        type="button"
                        className="flex flex-1 items-start gap-2.5 rounded-xl border border-dls-border bg-dls-surface p-3 text-left transition-colors hover:bg-dls-hover"
                        onClick={() => props.onOpenSettingsSection?.("mcps")}
                      >
                        <img src="https://cdn.simpleicons.org/hackthebox" alt="" width={16} height={16} className="mt-0.5 shrink-0" />
                        <div>
                          <div className="text-[12px] font-medium text-dls-text">Connect an extension</div>
                          <div className="text-[11px] text-dls-secondary">Add MCPs and integrations</div>
                        </div>
                      </button>
                    </div>
                  </div>
                </div>
              )
            ) : (
              <DevProfiler id="SessionTranscript">
                <>
                  <SessionTranscript
                    messages={renderedMessages}
                    isStreaming={chatStreaming}
                    developerMode={props.developerMode}
                    showThinking={showThinking}
                    scrollElement={() => scrollRef.current}
                  />
                  {error ? (
                    <SessionErrorCard
                      error={error}
                      onDismiss={() => setError(null)}
                      onChangeModel={props.onChangeModel}
                      onOpenModelPicker={props.onModelClick}
                    />
                  ) : null}
                  {showAssistantWaitState ? <AssistantWaitingCard /> : null}
                </>
              </DevProfiler>
            )}
          </div>
        </div>
        {!sessionScroll.isAtBottom || sessionScroll.topClippedMessageId ? (
          <div className="pointer-events-none absolute bottom-2 left-1/2 z-30 flex -translate-x-1/2 justify-center">
            <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-dls-border bg-dls-surface/95 p-1 shadow-[var(--dls-card-shadow)] backdrop-blur-md">
              {sessionScroll.topClippedMessageId ? (
                <button
                  type="button"
                  className="rounded-full px-3 py-1.5 text-xs text-dls-text transition-colors hover:bg-dls-hover"
                  onClick={() => {
                    sessionScroll.jumpToStartOfMessage("smooth");
                  }}
                >
                  Jump to start
                </button>
              ) : null}
              {!sessionScroll.isAtBottom ? (
                <button
                  type="button"
                  className="rounded-full px-3 py-1.5 text-xs text-dls-text transition-colors hover:bg-dls-hover"
                  onClick={() => {
                    sessionScroll.jumpToLatest("smooth");
                  }}
                >
                  Jump to latest
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      <div ref={composerShellRef} className="shrink-0 border-t border-dls-border/70 px-0 pb-3 pt-3">
        <DevProfiler id="SessionComposer">
        <ReactSessionComposer
          draft={draft}
          mentions={mentions}
          onDraftChange={setDraft}
        onSend={handleSend}
        onStop={handleAbort}
        busy={chatStreaming}
        disabled={model.transitionState !== "idle"}
        statusLabel={statusLabel(snapshot ?? undefined, chatStreaming)}
        modelPickerOpen={props.modelPickerOpen}
        selectedModel={props.selectedModel}
        onModelPickerOpenChange={props.onModelPickerOpenChange}
        onModelChange={props.onModelChange}
        attachments={attachments}
        onAttachFiles={handleAttachFiles}
        onRemoveAttachment={handleRemoveAttachment}
        attachmentsEnabled={props.attachmentsEnabled}
        attachmentsDisabledReason={props.attachmentsDisabledReason}
        modelVariantLabel={props.modelVariantLabel}
        modelVariant={props.modelVariant}
        modelBehaviorOptions={props.modelBehaviorOptions}
        onModelVariantChange={props.onModelVariantChange}
        agentLabel={props.agentLabel}
        selectedAgent={props.selectedAgent}
        listAgents={props.listAgents}
        onSelectAgent={props.onSelectAgent}
        listCommands={props.listCommands}
        listSkills={listSkills}
        skills={toolSkills}
        listMcp={listMcp}
        mcpServers={toolMcpServers}
        mcpStatus={toolMcpStatus}
        mcpStatuses={toolMcpStatuses}
        listImportedPlugins={listImportedPlugins}
        importedPlugins={toolImportedPlugins}
        onOpenSettingsSection={props.onOpenSettingsSection}
        recentFiles={props.recentFiles}
        searchFiles={props.searchFiles}
        onInsertMention={handleInsertMention}
        notice={notice}
        onNotice={setNotice}
        onPasteText={handlePasteText}
        onUnsupportedFileLinks={handleUnsupportedFileLinks}
        pastedText={pasteParts}
        onRevealPastedText={handleRevealPastedText}
        onRemovePastedText={handleRemovePastedText}
        isRemoteWorkspace={props.isRemoteWorkspace}
          isSandboxWorkspace={props.isSandboxWorkspace}
          onUploadInboxFiles={props.onUploadInboxFiles ?? handleUploadInboxFiles}
        />
        </DevProfiler>
      </div>
      {/* Error display moved inline into the session conversation area */}
      {props.developerMode ? <SessionDebugPanel model={model} snapshot={snapshot} /> : null}
    </div>
    </DevProfiler>
  );
}
