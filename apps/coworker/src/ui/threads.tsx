import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { coworkerBridge, type CoworkerSummary, type ProviderSyncRun, type RuntimeInfo } from "@/lib/bridge";
import type { DenSession } from "@/lib/den";
import {
  artifactKindLabel,
  artifactsForToolCall,
  type CoworkerArtifactKind,
} from "@/lib/artifacts";
import {
  assignmentPrompt,
  assignmentTitle,
  discussionTitle,
  type DiscussionMessage,
} from "@/lib/conversation";
import {
  createCoworkerMcpClient,
  gatewayMcpAppLaunch,
  preservedMcpAppResult,
  type CoworkerMcpAppResource,
  type CoworkerMcpClient,
  type PreservedMcpAppResult,
} from "@/lib/mcp";
import {
  createCoworkerThreads,
  describeInteractions,
  hasPendingInteractions,
  modelSourceLabel,
  parseModelPreference,
  type CoworkerActivity,
  type EngineModelOption,
  type PendingInteractions,
  type ThreadListItem,
} from "@/lib/threads";
import { describeTurnFailure } from "@/lib/turn-failure";
import { InteractionCards } from "@/ui/interactions";
import { CoworkerAvatar } from "@/ui/coworker-avatar";
import { useWorkingSaying } from "@/ui/use-working-saying";
import { CoworkerMark, InlineLoader } from "@/ui/brand";
import { Button, Empty, ErrorNote, StatusDot } from "@/ui/kit";
import { McpAppFrame } from "@/ui/mcp-app-frame";

type TranscriptToolCall = {
  partId: string;
  tool: string;
  status: string;
  input: Record<string, unknown>;
  output: unknown;
  error: string | null;
  metadata: Record<string, unknown>;
};

type TranscriptMessage = {
  id: string;
  role: string;
  text: string;
  reasoning: string;
  /** Provider/model the engine attributed this reply to; null for user turns and unbound replies. */
  model: { providerId: string; modelId: string } | null;
  toolCalls: TranscriptToolCall[];
};

export type AssignmentDraft = { id: number; text: string } | null;

type QueuedTurn = {
  id: number;
  threadId: string;
  prompt: string;
  messageId: string;
};

type PendingTurn = {
  messageId: string;
  prompt: string;
  phase: "accepting" | "waiting";
};

type TurnIssue = {
  kind: "failed" | "timeout" | "stopped";
  message: string;
  messageId: string;
  prompt: string;
};

const DISCUSSION_STARTERS = [
  "What should we focus on today?",
  "Help me think through a decision.",
  "Catch me up on what you remember.",
];

function newMessageId(): string {
  return `msg_coworker_${Date.now().toString(36)}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function relativeTime(timestamp: number): string {
  if (!timestamp) return "Not started";
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function threadTone(status: ThreadListItem["status"]): "spark" | "amber" | "mint" {
  if (status === "busy") return "spark";
  if (status === "retry") return "amber";
  return "mint";
}

export function ThreadsPanel({
  runtime,
  session,
  coworker,
  onCoworkerChanged,
  onRefreshRuntime,
  onSyncProviders,
  assignmentDraft,
  openThreadRequest,
  onOpenModelSettings,
  onOpenAccount,
  onActivityChange,
}: {
  runtime: RuntimeInfo;
  session: DenSession | null;
  coworker: CoworkerSummary;
  onCoworkerChanged: (coworker: CoworkerSummary) => void;
  onRefreshRuntime: () => Promise<void>;
  onSyncProviders: () => Promise<ProviderSyncRun>;
  assignmentDraft?: AssignmentDraft;
  /** Set by the context rail to jump straight into a thread; the id makes repeat requests distinct. */
  openThreadRequest?: { id: number; threadId: string } | null;
  /** Coworker settings, opened at the AI model section — the first recovery step after a model failure. */
  onOpenModelSettings: () => void;
  /** The OpenWork account section — where a provider is reconnected. */
  onOpenAccount: () => void;
  onActivityChange: (activity: CoworkerActivity | null) => void;
}) {
  const threads = useMemo(
    () =>
      coworker.workspaceId
        ? createCoworkerThreads({
            serverUrl: runtime.serverUrl,
            workspaceId: coworker.workspaceId,
            token: runtime.ownerToken,
            model: coworker.model,
            modelVariant: coworker.modelVariant,
            conversationThreadId: coworker.conversationThreadId,
          })
        : null,
    [runtime.serverUrl, runtime.ownerToken, coworker.workspaceId, coworker.model, coworker.modelVariant, coworker.conversationThreadId],
  );
  const [items, setItems] = useState<ThreadListItem[]>([]);
  const [attentionBySession, setAttentionBySession] = useState<Record<string, string>>({});
  const [openThreadId, setOpenThreadId] = useState("");
  const [discussionThreadId, setDiscussionThreadId] = useState(coworker.conversationThreadId);
  const [view, setView] = useState<"discussion" | "assignments">("discussion");
  const [pendingAssignment, setPendingAssignment] = useState<AssignmentDraft>(assignmentDraft ?? null);
  const [queuedTurn, setQueuedTurn] = useState<QueuedTurn | null>(null);
  const [error, setError] = useState("");
  // While the AI service is unavailable the header note already says so; a raw
  // listing error underneath it would only repeat the fact in technical words.
  const visibleError = runtime.engineManaged ? error : "";

  useEffect(() => {
    setDiscussionThreadId(coworker.conversationThreadId);
  }, [coworker.conversationThreadId]);

  useEffect(() => {
    if (!assignmentDraft) return;
    setOpenThreadId("");
    setView("discussion");
    setPendingAssignment(assignmentDraft);
  }, [assignmentDraft]);

  useEffect(() => {
    if (!openThreadRequest?.threadId) return;
    if (openThreadRequest.threadId === discussionThreadId) {
      setOpenThreadId("");
      setView("discussion");
      return;
    }
    setOpenThreadId(openThreadRequest.threadId);
  }, [discussionThreadId, openThreadRequest]);

  const refresh = useCallback(async () => {
    if (!threads) return;
    try {
      const [list, pending] = await Promise.all([
        threads.listThreads(),
        threads.listPendingInteractions().catch((): PendingInteractions => ({ permissions: [], questions: [] })),
      ]);
      setItems(list);
      const attention: Record<string, string> = {};
      for (const permission of pending.permissions) {
        attention[permission.sessionID] ??= describeInteractions({ permissions: [permission], questions: [] });
      }
      for (const question of pending.questions) {
        attention[question.sessionID] ??= describeInteractions({ permissions: [], questions: [question] });
      }
      setAttentionBySession(attention);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [threads]);

  useEffect(() => {
    void refresh();
    if (!threads) return;
    const unsubscribe = threads.subscribe(() => void refresh());
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => {
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [threads, refresh]);

  const ensureDiscussion = useCallback(async () => {
    if (!threads) throw new Error("This coworker needs a workspace before it can chat.");
    if (discussionThreadId) return discussionThreadId;
    const discussion = await threads.client.createThread({ title: discussionTitle(coworker.name) });
    const updated = await coworkerBridge.coworkers.update(coworker.slug, { conversationThreadId: discussion.id });
    setDiscussionThreadId(discussion.id);
    onCoworkerChanged(updated);
    return discussion.id;
  }, [coworker.name, coworker.slug, discussionThreadId, onCoworkerChanged, threads]);

  const createAssignment = useCallback(async (outcome: string, messages: ReadonlyArray<DiscussionMessage>) => {
    if (!threads) throw new Error("This coworker needs a workspace before it can take an assignment.");
    const thread = await threads.client.createThread({
      title: assignmentTitle(outcome),
    });
    setQueuedTurn({
      id: Date.now(),
      threadId: thread.id,
      prompt: assignmentPrompt(outcome, messages),
      messageId: newMessageId(),
    });
    setPendingAssignment(null);
    setOpenThreadId(thread.id);
    setView("discussion");
    void refresh();
  }, [refresh, threads]);

  if (!threads) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-sm space-y-4 text-center">
          <Empty>This coworker needs a workspace before it can start.</Empty>
          {visibleError ? <ErrorNote>{visibleError}</ErrorNote> : null}
          <Button
            variant="primary"
            onClick={() => {
              void (async () => {
                try {
                  const repaired = await coworkerBridge.coworkers.ensureWorkspace(coworker.slug);
                  await onRefreshRuntime();
                  onCoworkerChanged(repaired);
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : String(cause));
                }
              })();
            }}
          >
            Prepare workspace
          </Button>
        </div>
      </div>
    );
  }

  if (openThreadId) {
    return (
      <ThreadView
        key={openThreadId}
        threads={threads}
        threadId={openThreadId}
        coworker={coworker}
        runtime={runtime}
        kind="assignment"
        assignmentCount={items.length}
        initialTurn={queuedTurn?.threadId === openThreadId ? queuedTurn : null}
        onBack={() => {
          setOpenThreadId("");
          setView("discussion");
          void refresh();
        }}
        onShowAssignments={() => setView("assignments")}
        onInitialTurnHandled={(id) => setQueuedTurn((current) => current?.id === id ? null : current)}
        onOpenModelSettings={onOpenModelSettings}
        onOpenAccount={onOpenAccount}
        session={session}
        onSyncProviders={onSyncProviders}
        onActivityChange={onActivityChange}
      />
    );
  }

  if (view === "assignments") {
    return (
      <AssignmentOverview
        coworker={coworker}
        error={visibleError}
        items={items}
        attentionBySession={attentionBySession}
        onOpen={setOpenThreadId}
        onBack={() => setView("discussion")}
        onNewAssignment={() => {
          setPendingAssignment({ id: Date.now(), text: "" });
          setView("discussion");
        }}
      />
    );
  }

  if (!discussionThreadId) {
    return (
      <DiscussionWelcome
        coworker={coworker}
        error={visibleError}
        assignmentCount={items.length}
        assignmentDraft={pendingAssignment}
        onShowAssignments={() => setView("assignments")}
        onStartDiscussion={async (text) => {
          const threadId = await ensureDiscussion();
          setQueuedTurn({ id: Date.now(), threadId, prompt: text, messageId: newMessageId() });
        }}
        onCreateAssignment={createAssignment}
        onAssignmentDraftHandled={() => setPendingAssignment(null)}
      />
    );
  }

  return (
    <ThreadView
      key={discussionThreadId}
      threads={threads}
      threadId={discussionThreadId}
      coworker={coworker}
      runtime={runtime}
      kind="discussion"
      assignmentCount={items.length}
      assignmentDraft={pendingAssignment}
      initialTurn={queuedTurn?.threadId === discussionThreadId ? queuedTurn : null}
      onBack={() => undefined}
      onShowAssignments={() => setView("assignments")}
      onCreateAssignment={createAssignment}
      onAssignmentDraftHandled={() => setPendingAssignment(null)}
      onInitialTurnHandled={(id) => setQueuedTurn((current) => current?.id === id ? null : current)}
      onOpenModelSettings={onOpenModelSettings}
      onOpenAccount={onOpenAccount}
      session={session}
      onSyncProviders={onSyncProviders}
      onActivityChange={onActivityChange}
    />
  );
}

function DiscussionWelcome({
  coworker,
  error,
  assignmentCount,
  assignmentDraft,
  onStartDiscussion,
  onCreateAssignment,
  onShowAssignments,
  onAssignmentDraftHandled,
}: {
  coworker: CoworkerSummary;
  error: string;
  assignmentCount: number;
  assignmentDraft?: AssignmentDraft;
  onStartDiscussion: (text: string) => Promise<void>;
  onCreateAssignment: (outcome: string, messages: ReadonlyArray<DiscussionMessage>) => Promise<void>;
  onShowAssignments: () => void;
  onAssignmentDraftHandled: () => void;
}) {
  const [message, setMessage] = useState("");
  const [assignmentText, setAssignmentText] = useState("");
  const [assignmentMode, setAssignmentMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [composerError, setComposerError] = useState("");

  useEffect(() => {
    if (!assignmentDraft) return;
    setAssignmentMode(true);
    setAssignmentText(assignmentDraft.text);
  }, [assignmentDraft]);

  async function send() {
    const text = message.trim();
    if (!text) return;
    setBusy(true);
    setComposerError("");
    try {
      await onStartDiscussion(text);
      setMessage("");
    } catch (cause) {
      setComposerError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function assign() {
    const text = assignmentText.trim();
    if (!text) return;
    setBusy(true);
    setComposerError("");
    try {
      await onCreateAssignment(text, []);
      setAssignmentText("");
      setAssignmentMode(false);
      onAssignmentDraftHandled();
    } catch (cause) {
      setComposerError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex h-full min-h-0 flex-col bg-ink">
      <header className="flex items-center justify-between gap-4 border-b border-line px-6 py-3">
        <h2 className="text-sm font-semibold text-snow">Discussion with {coworker.name}</h2>
        <Button variant="ghost" onClick={onShowAssignments}>Assignments{assignmentCount ? ` · ${assignmentCount}` : ""}</Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        {!error ? (
          <div className="mx-auto flex h-full max-w-xl flex-col justify-center text-center">
            <CoworkerAvatar animated color={coworker.avatarColor} glasses={coworker.avatarGlasses} name={coworker.name} size={88} />
            <h3 className="mt-3 text-xl font-semibold tracking-[-0.03em] text-snow">Start with a conversation</h3>
            <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-mist">
              Ask, explore, or think something through. Nothing becomes assigned work until you choose to create an assignment.
            </p>
            <div className="mt-6 grid gap-2 text-left">
              {DISCUSSION_STARTERS.map((starter) => (
                <button key={starter} className="rounded-xl border border-line bg-panel/50 px-4 py-3 text-sm text-snow transition-colors hover:bg-panel" onClick={() => setMessage(starter)}>
                  {starter}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      <DiscussionComposer
        message={message}
        onMessageChange={setMessage}
        onSend={() => void send()}
        assignmentMode={assignmentMode}
        onAssignmentModeChange={setAssignmentMode}
        assignment={assignmentText}
        onAssignmentChange={setAssignmentText}
        onCreateAssignment={() => void assign()}
        busy={busy}
        error={composerError}
        coworkerName={coworker.name}
      />
    </section>
  );
}

function AssignmentOverview({
  coworker,
  items,
  attentionBySession,
  error,
  onOpen,
  onBack,
  onNewAssignment,
}: {
  coworker: CoworkerSummary;
  items: ThreadListItem[];
  attentionBySession: Record<string, string>;
  error: string;
  onOpen: (threadId: string) => void;
  onBack: () => void;
  onNewAssignment: () => void;
}) {
  return (
    <section className="flex h-full min-h-0 flex-col bg-ink">
      <header className="flex items-center gap-3 border-b border-line px-5 py-3">
        <Button variant="ghost" className="px-2" onClick={onBack} title="Back to discussion">←</Button>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-snow">Assignments</h2>
          <p className="text-xs text-mist">Outcome-driven work created from your discussion with {coworker.name}.</p>
        </div>
        <Button variant="primary" onClick={onNewAssignment}>New assignment</Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        {items.length === 0 && !error ? (
          <div className="mx-auto flex h-full max-w-md flex-col items-center justify-center text-center">
            <CoworkerMark size={42} />
            <h3 className="mt-3 text-base font-semibold text-snow">No assignments yet</h3>
            <p className="mt-1 text-sm leading-relaxed text-mist">Talk things through first, then turn a clear outcome into work.</p>
            <Button className="mt-4" onClick={onNewAssignment}>Create from discussion</Button>
          </div>
        ) : null}
        {items.length > 0 ? (
          <div className="mx-auto max-w-3xl">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-mist">Current and recent</h3>
              <span className="text-xs text-mist">{items.length} assignment{items.length === 1 ? "" : "s"}</span>
            </div>
            <ul className="space-y-1.5">
              {items.map((item) => (
                <li key={item.id}>
                  <button className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-panel" onClick={() => onOpen(item.id)}>
                    <StatusDot tone={attentionBySession[item.id] ? "amber" : threadTone(item.status)} />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-snow">{item.title}</span>
                    <span className={`shrink-0 text-xs ${attentionBySession[item.id] ? "font-medium text-amber" : "text-mist"}`} title={attentionBySession[item.id] || undefined}>
                      {attentionBySession[item.id]
                        ? "Needs you"
                        : item.status === "busy"
                          ? "Working"
                          : item.status === "retry"
                            ? "Retrying"
                            : relativeTime(item.updatedAt)}
                    </span>
                    <span className="text-mist" aria-hidden="true">›</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ThreadView({
  threads,
  threadId,
  coworker,
  runtime,
  kind,
  assignmentCount,
  assignmentDraft,
  initialTurn,
  onBack,
  onShowAssignments,
  onCreateAssignment,
  onAssignmentDraftHandled,
  onInitialTurnHandled,
  onOpenModelSettings,
  onOpenAccount,
  session,
  onSyncProviders,
  onActivityChange,
}: {
  threads: NonNullable<ReturnType<typeof createCoworkerThreads>>;
  threadId: string;
  coworker: CoworkerSummary;
  runtime: RuntimeInfo;
  kind: "discussion" | "assignment";
  assignmentCount: number;
  assignmentDraft?: AssignmentDraft;
  initialTurn: QueuedTurn | null;
  onBack: () => void;
  onShowAssignments: () => void;
  onCreateAssignment?: (outcome: string, messages: ReadonlyArray<DiscussionMessage>) => Promise<void>;
  onAssignmentDraftHandled?: () => void;
  onInitialTurnHandled: (id: number) => void;
  onOpenModelSettings: () => void;
  onOpenAccount: () => void;
  session: DenSession | null;
  onSyncProviders: () => Promise<ProviderSyncRun>;
  onActivityChange: (activity: CoworkerActivity | null) => void;
}) {
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [title, setTitle] = useState("Work thread");
  const [statusLabel, setStatusLabel] = useState("idle");
  const [terminalError, setTerminalError] = useState("");
  const [pending, setPending] = useState<PendingInteractions>({ permissions: [], questions: [] });
  const [reply, setReply] = useState("");
  const [assignmentMode, setAssignmentMode] = useState(false);
  const [assignmentText, setAssignmentText] = useState("");
  const [error, setError] = useState("");
  const [assignmentBusy, setAssignmentBusy] = useState(false);
  const [pendingTurn, setPendingTurn] = useState<PendingTurn | null>(null);
  const [turnIssue, setTurnIssue] = useState<TurnIssue | null>(null);
  const [providerRefreshNote, setProviderRefreshNote] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const pendingTurnRef = useRef<PendingTurn | null>(null);
  const waitControllerRef = useRef<AbortController | null>(null);
  const stopRequestedRef = useRef(false);
  const handledInitialTurnRef = useRef<number | null>(null);
  const mcpClient = useMemo(
    () => createCoworkerMcpClient({
      serverUrl: runtime.serverUrl,
      workspaceId: coworker.workspaceId,
      token: runtime.ownerToken,
    }),
    [coworker.workspaceId, runtime.ownerToken, runtime.serverUrl],
  );

  const refresh = useCallback(async () => {
    try {
      const [transcript, interactions] = await Promise.all([
        threads.client.exportTranscript(threadId),
        threads.listThreadInteractions(threadId).catch((): PendingInteractions => ({ permissions: [], questions: [] })),
      ]);
      setPending(interactions);
      setTitle(transcript.title ?? "Work thread");
      setStatusLabel(transcript.status.type);
      setTerminalError(
        pendingTurnRef.current
          ? ""
          : transcript.terminalError
            ? `${transcript.terminalError.name}: ${transcript.terminalError.message}`
            : "",
      );
      setMessages(
        transcript.messages.map((message) => ({
          id: message.id,
          role: message.role,
          text: message.text,
          reasoning: message.reasoning,
          model: message.model,
          toolCalls: message.toolCalls.map((call) => ({
            partId: call.partId,
            tool: call.name,
            status: call.status ?? "working",
            input: call.input,
            output: call.output,
            error: call.error,
            metadata: call.metadata,
          })),
        })),
      );
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [threads, threadId]);

  useEffect(() => {
    if (kind !== "discussion" || !assignmentDraft) return;
    setAssignmentMode(true);
    setAssignmentText(assignmentDraft.text);
  }, [assignmentDraft, kind]);

  useEffect(() => {
    void refresh();
    const unsubscribe = threads.subscribe(() => void refresh());
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => {
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [threads, refresh]);

  useEffect(() => () => waitControllerRef.current?.abort(), []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, pendingTurn, statusLabel, pending.permissions.length, pending.questions.length]);

  const submitTurn = useCallback(async (prompt: string, messageId: string) => {
    if (pendingTurnRef.current) return;
    const nextPending: PendingTurn = { messageId, prompt, phase: "accepting" };
    pendingTurnRef.current = nextPending;
    setPendingTurn(nextPending);
    setTurnIssue(null);
    setTerminalError("");
    setError("");
    setProviderRefreshNote("");
    stopRequestedRef.current = false;
    onActivityChange({
      state: "working",
      label: "Working",
      detail: kind === "discussion" ? "Replying in your discussion" : title,
      updatedAt: Date.now(),
      threadId,
    });
    let refreshTimer: number | undefined;
    try {
      const savedModel = parseModelPreference(coworker.model);
      if (savedModel) {
        const catalog = await threads.listModelCatalog();
        if (!catalog.models.some((model) => model.id === coworker.model)) {
          throw new Error(describeUnavailableModel(coworker.model, catalog.models, session));
        }
      }
      const acceptance = await threads.client.sendTurn(threadId, {
        prompt,
        messageId,
        model: savedModel ? { ...savedModel, ...(coworker.modelVariant.trim() ? { variant: coworker.modelVariant.trim() } : {}) } : undefined,
      });
      const waiting: PendingTurn = { messageId, prompt, phase: "waiting" };
      pendingTurnRef.current = waiting;
      setPendingTurn(waiting);
      await refresh();

      const controller = new AbortController();
      waitControllerRef.current = controller;
      refreshTimer = window.setInterval(() => void refresh(), 600);
      const result = await threads.client.waitForThread(threadId, {
        timeoutMs: 120_000,
        pollIntervalMs: 500,
        since: acceptance,
        signal: controller.signal,
      });
      await refresh();
      // Keep the optimistic working state through the transcript commit. Without
      // this paint boundary, the header can briefly return to Ready before the
      // completed assistant message becomes visible.
      await new Promise<void>((resolvePaint) => {
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolvePaint()));
      });

      if (result.outcome === "failed") {
        const failure = result.terminalError
          ? `${result.terminalError.name}: ${result.terminalError.message}`
          : "The model stopped before producing a response.";
        setTurnIssue({ kind: "failed", message: failure, messageId, prompt });
      } else if (result.outcome === "timeout") {
        setTurnIssue({
          kind: "timeout",
          message: "No response arrived within two minutes. The conversation is still saved, and you can retry this turn without sending it twice.",
          messageId,
          prompt,
        });
      } else if (result.outcome === "aborted" && stopRequestedRef.current) {
        setTurnIssue({
          kind: "stopped",
          message: "Stopped. The conversation and everything completed so far are still saved.",
          messageId,
          prompt,
        });
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setTurnIssue({ kind: "failed", message, messageId, prompt });
    } finally {
      if (refreshTimer !== undefined) window.clearInterval(refreshTimer);
      waitControllerRef.current = null;
      if (pendingTurnRef.current?.messageId === messageId) {
        pendingTurnRef.current = null;
        setPendingTurn(null);
      }
    }
  }, [coworker.model, coworker.modelVariant, kind, onActivityChange, refresh, session, threadId, threads, title]);

  useEffect(() => {
    if (!initialTurn || handledInitialTurnRef.current === initialTurn.id) return;
    handledInitialTurnRef.current = initialTurn.id;
    void submitTurn(initialTurn.prompt, initialTurn.messageId)
      .finally(() => onInitialTurnHandled(initialTurn.id));
  }, [initialTurn, onInitialTurnHandled, submitTurn]);

  function send() {
    const text = reply.trim();
    if (!text || pendingTurnRef.current) return;
    setReply("");
    void submitTurn(text, newMessageId());
  }

  /**
   * Recovery without leaving the conversation: re-read the account's
   * providers, then retry the same message id if the saved model came back.
   */
  async function refreshProvidersAndRetry() {
    const failed = turnIssue;
    setProviderRefreshNote("Refreshing your OpenWork providers…");
    try {
      const run = await onSyncProviders();
      if (run.status === "failed") {
        setProviderRefreshNote(`OpenWork provider refresh failed: ${run.message || "unknown error"}`);
        return;
      }
      const catalog = await threads.listModelCatalog();
      const available = !coworker.model.trim() || catalog.models.some((model) => model.id === coworker.model);
      if (!available) {
        setProviderRefreshNote(`Providers refreshed, but "${coworker.model}" is still unavailable. Choose another AI model in Coworker settings.`);
        return;
      }
      setProviderRefreshNote("");
      if (failed?.prompt) void submitTurn(failed.prompt, failed.messageId);
    } catch (cause) {
      setProviderRefreshNote(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function stop() {
    const active = pendingTurnRef.current;
    stopRequestedRef.current = true;
    waitControllerRef.current?.abort();
    setPendingTurn(null);
    setTurnIssue({
      kind: "stopped",
      message: "Stopped. The conversation and everything completed so far are still saved.",
      messageId: active?.messageId ?? "",
      prompt: active?.prompt ?? "",
    });
    try {
      await threads.client.abortThread(threadId);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function createAssignmentFromDiscussion() {
    const outcome = assignmentText.trim();
    if (!outcome || !onCreateAssignment) return;
    setAssignmentBusy(true);
    setError("");
    try {
      const optimisticTurn = pendingTurn ?? (turnIssue?.messageId && turnIssue.prompt ? turnIssue : null);
      const visibleMessages = optimisticTurn && !messages.some((message) => message.id === optimisticTurn.messageId)
        ? [...messages, { id: optimisticTurn.messageId, role: "user", text: optimisticTurn.prompt, reasoning: "", model: null, toolCalls: [] }]
        : messages;
      await onCreateAssignment(outcome, visibleMessages.map(({ role, text }) => ({ role, text })));
      setAssignmentText("");
      setAssignmentMode(false);
      onAssignmentDraftHandled?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAssignmentBusy(false);
    }
  }

  const needsYou = hasPendingInteractions(pending);
  const engineWorking = statusLabel !== "idle";
  const turnNeedsAttention = turnIssue?.kind === "failed" || turnIssue?.kind === "timeout" || Boolean(terminalError);
  const stopped = turnIssue?.kind === "stopped";
  const working = (pendingTurn !== null || engineWorking) && !needsYou && !turnNeedsAttention && !stopped;
  const optimisticTurn = pendingTurn ?? (turnIssue?.messageId && turnIssue.prompt ? turnIssue : null);
  const visibleMessages = optimisticTurn && !messages.some((message) => message.id === optimisticTurn.messageId)
    ? [...messages, { id: optimisticTurn.messageId, role: "user", text: optimisticTurn.prompt, reasoning: "", model: null, toolCalls: [] }]
    : messages;
  const lastAssistantIndex = visibleMessages.findLastIndex((message) => message.role === "assistant");
  const displayedFailure = turnIssue?.kind === "failed" ? turnIssue.message : terminalError;
  const activeToolLabel = activeToolCallLabel(visibleMessages);
  // The reply for this turn has started only when the newest message is an
  // assistant message with text; an older reply must not read as progress.
  const newestMessage = visibleMessages.at(-1);
  const replyStarted = newestMessage?.role === "assistant" && newestMessage.text.length > 0;
  const workingLabel = pendingTurn?.phase === "accepting"
    ? "Sending"
    : statusLabel === "retry"
      ? "Retrying"
      : activeToolLabel
        ? "Using a tool"
        : replyStarted
          ? "Working"
          : "Thinking";

  const readableStatus = needsYou
    ? pending.permissions.length > 0 ? "Waiting for permission" : "Waiting for an answer"
    : turnNeedsAttention
      ? turnIssue?.kind === "timeout" ? "Response delayed" : "Reply failed"
      : stopped
        ? "Stopped"
    : working
      ? workingLabel
      : "Ready";

  useEffect(() => {
    if (needsYou) {
      onActivityChange({
        state: "attention",
        label: pending.permissions.length > 0 ? "Waiting for permission" : "Waiting for an answer",
        detail: describeInteractions(pending),
        updatedAt: Date.now(),
        threadId,
      });
      return;
    }
    if (turnIssue?.kind === "failed" || turnIssue?.kind === "timeout") {
      onActivityChange({
        state: "attention",
        label: turnIssue.kind === "timeout" ? "Response delayed" : "Reply failed",
        detail: describeTurnFailure(turnIssue.message, coworker.name).headline,
        updatedAt: Date.now(),
        threadId,
      });
      return;
    }
    if (displayedFailure) {
      onActivityChange({
        state: "attention",
        label: "Reply failed",
        detail: describeTurnFailure(displayedFailure, coworker.name).headline,
        updatedAt: Date.now(),
        threadId,
      });
      return;
    }
    if (stopped) {
      onActivityChange({
        state: "recent",
        label: "Stopped",
        detail: kind === "discussion" ? "Discussion turn stopped" : title,
        updatedAt: Date.now(),
        threadId,
      });
      return;
    }
    if (working) {
      onActivityChange({
        state: statusLabel === "retry" ? "retrying" : "working",
        label: workingLabel,
        detail: activeToolLabel ?? (kind === "discussion" ? "Replying in your discussion" : title),
        updatedAt: Date.now(),
        threadId,
      });
      return;
    }
    onActivityChange(null);
  }, [activeToolLabel, coworker.name, displayedFailure, kind, needsYou, onActivityChange, pending, statusLabel, stopped, threadId, title, turnIssue, working, workingLabel]);

  return (
    <section className="flex h-full min-h-0 flex-col bg-ink">
      <header className="flex items-center gap-3 border-b border-line px-5 py-3">
        {kind === "assignment" ? <Button variant="ghost" className="px-2" onClick={onBack} title="Back to discussion">←</Button> : null}
        {kind === "discussion" ? (
          <CoworkerAvatar animated color={coworker.avatarColor} glasses={coworker.avatarGlasses} name={coworker.name} size={30} />
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-sm font-semibold text-snow">{kind === "discussion" ? `Discussion with ${coworker.name}` : title}</h2>
            {kind === "assignment" ? <span className="rounded-full border border-spark/20 bg-spark/8 px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-[0.08em] text-spark">Assignment</span> : null}
          </div>
          <p data-testid="coworker-thread-status" className={`text-xs ${needsYou ? "text-amber" : working ? "text-spark" : "text-mist"}`}>
            {kind === "discussion" && !working && !needsYou && !turnNeedsAttention && !stopped
              ? "A continuing conversation — messages are not assignments"
              : readableStatus}
          </p>
        </div>
        <Button variant="ghost" onClick={onShowAssignments}>Assignments{assignmentCount ? ` · ${assignmentCount}` : ""}</Button>
        {working || needsYou ? (
          <Button variant="ghost" onClick={() => void stop()}>
            Stop
          </Button>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <div className="mx-auto max-w-3xl space-y-3">
          {visibleMessages.map((message, index) => (
            <MessageBubble
              key={message.id}
              message={message}
              coworker={coworker}
              mcpClient={mcpClient}
              active={working && message.role === "assistant" && index === lastAssistantIndex}
            />
          ))}
          <InteractionCards
            coworker={coworker}
            pending={pending}
            onPermission={async (permission, decision) => {
              await threads.replyPermission(permission, decision);
              void refresh();
            }}
            onAnswer={async (question, answers) => {
              await threads.replyQuestion(question, answers);
              void refresh();
            }}
            onSkip={async (question) => {
              await threads.rejectQuestion(question);
              void refresh();
            }}
          />
          {working ? (
            <WorkIndicator
              coworker={coworker}
              threadId={threadId}
              messages={visibleMessages}
              label={workingLabel}
            />
          ) : null}
          {visibleMessages.length === 0 && !error && !working ? (
            <Empty>{kind === "discussion" ? `Start a conversation with ${coworker.name}.` : <InlineLoader label="Loading assignment" />}</Empty>
          ) : null}
          {displayedFailure ? (
            <TurnIssueNote
              kind="failed"
              message={displayedFailure}
              coworkerName={coworker.name}
              canRetry={Boolean(turnIssue?.prompt)}
              session={session}
              onRetry={() => {
                if (turnIssue?.prompt) void submitTurn(turnIssue.prompt, turnIssue.messageId);
              }}
              onOpenModelSettings={onOpenModelSettings}
              onOpenAccount={onOpenAccount}
              onRefreshProviders={() => void refreshProvidersAndRetry()}
            />
          ) : null}
          {turnIssue?.kind === "timeout" ? (
            <TurnIssueNote
              kind="timeout"
              message={turnIssue.message}
              coworkerName={coworker.name}
              canRetry
              session={session}
              onRetry={() => void submitTurn(turnIssue.prompt, turnIssue.messageId)}
              onOpenModelSettings={onOpenModelSettings}
              onOpenAccount={onOpenAccount}
              onStop={() => void stop()}
            />
          ) : null}
          {providerRefreshNote ? (
            <p className="px-1 text-[11px] leading-relaxed text-mist" data-testid="coworker-provider-refresh">{providerRefreshNote}</p>
          ) : null}
          {turnIssue?.kind === "stopped" ? (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-panel/45 px-3 py-2.5 text-xs text-mist" data-testid="coworker-turn-stopped">
              <span>{turnIssue.message}</span>
              {turnIssue.prompt ? <Button variant="ghost" onClick={() => void submitTurn(turnIssue.prompt, turnIssue.messageId)}>Retry</Button> : null}
            </div>
          ) : null}
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          <div ref={endRef} />
        </div>
      </div>
      {kind === "discussion" ? (
        <DiscussionComposer
          message={reply}
          onMessageChange={setReply}
          onSend={() => void send()}
          assignmentMode={assignmentMode}
          onAssignmentModeChange={setAssignmentMode}
          assignment={assignmentText}
          onAssignmentChange={setAssignmentText}
          onCreateAssignment={() => void createAssignmentFromDiscussion()}
          busy={pendingTurn !== null || assignmentBusy}
          coworkerName={coworker.name}
        />
      ) : (
        <MessageComposer
          value={reply}
          onChange={setReply}
          onSubmit={() => void send()}
          busy={pendingTurn !== null}
          placeholder={`Follow up with ${coworker.name}…`}
        />
      )}
    </section>
  );
}

function MessageBubble({
  message,
  coworker,
  mcpClient,
  active,
}: {
  message: TranscriptMessage;
  coworker: CoworkerSummary;
  mcpClient: CoworkerMcpClient;
  active: boolean;
}) {
  const user = message.role === "user";
  if (user) {
    return (
      <article className="flex justify-end" data-message-role="user">
        <div className="max-w-[82%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-snow px-4 py-3 text-sm leading-relaxed text-ink">
          {message.text || "…"}
        </div>
      </article>
    );
  }

  return (
    <article className="flex items-start gap-2.5" data-message-role="assistant">
      <CoworkerAvatar animated={active} color={coworker.avatarColor} glasses={coworker.avatarGlasses} name={coworker.name} size={30} />
      <div className="min-w-0 max-w-[88%] flex-1 pt-0.5">
        <p className="mb-1.5 text-[11px] font-semibold text-mist">
          {/* The answering model stays available on hover and to assistive tech, not as everyday copy. */}
          <span title={message.model ? `Answered by ${message.model.providerId}/${message.model.modelId}` : undefined}>{coworker.name}</span>
          {message.model ? (
            <span className="sr-only" data-testid="coworker-reply-model">
              Answered by {message.model.providerId}/{message.model.modelId}
            </span>
          ) : null}
        </p>
        {message.reasoning ? <ThinkingDisclosure text={message.reasoning} active={active} /> : null}
        {message.toolCalls.length > 0 ? (
          <ul className={`${message.reasoning ? "mt-2" : ""} space-y-1.5`}>
            {message.toolCalls.map((call) => <ToolReceipt key={call.partId} call={call} client={mcpClient} />)}
          </ul>
        ) : null}
        {message.text ? (
          <div className={`${message.reasoning || message.toolCalls.length ? "mt-2.5" : ""} whitespace-pre-wrap text-sm leading-relaxed text-snow`}>
            {message.text}
          </div>
        ) : !message.reasoning && message.toolCalls.length === 0 ? <span className="text-sm text-mist">…</span> : null}
      </div>
    </article>
  );
}

function ThinkingDisclosure({ text, active }: { text: string; active: boolean }) {
  return (
    <details className="group rounded-xl border border-white/7 bg-white/[0.025] px-2.5 py-2" data-testid="coworker-thinking">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-xs text-mist marker:hidden">
        <CoworkerMark loading={active} size={18} />
        <span className={`flex-1 ${active ? "animate-pulse" : ""}`}>{active ? "Thinking…" : "Thought through"}</span>
        <span className="text-mist/60 transition-transform group-open:rotate-90" aria-hidden="true">›</span>
      </summary>
      <p className="mt-2 whitespace-pre-wrap border-t border-white/7 pt-2 text-xs leading-relaxed text-mist">{text}</p>
    </details>
  );
}

/** "Using <tool>" while a tool call is still running; null when the model is only thinking or writing. */
function activeToolCallLabel(messages: TranscriptMessage[]): string | null {
  const activeCall = messages
    .flatMap((message) => message.toolCalls)
    .findLast((call) => !["completed", "success", "error", "failed"].includes(call.status));
  return activeCall ? toolPresentation(activeCall).label.replace(/^(Searched|Used|Ran) /, "Using ") : null;
}

function WorkIndicator({
  coworker,
  threadId,
  messages,
  label,
}: {
  coworker: CoworkerSummary;
  threadId: string;
  messages: TranscriptMessage[];
  label: string;
}) {
  const tool = activeToolCallLabel(messages);
  const saying = useWorkingSaying(coworker.personality, `${coworker.slug}:${threadId}`, true);
  const text = tool
    ? `${tool}…`
    : label === "Sending"
      ? "Sending…"
      : saying
        ? `${saying}…`
        : `${coworker.name} is ${label.toLowerCase()}…`;
  return (
    <div className="flex items-center gap-2.5 px-1 py-2 text-xs text-mist" data-testid="coworker-working">
      <CoworkerAvatar animated color={coworker.avatarColor} glasses={coworker.avatarGlasses} name={coworker.name} size={24} />
      <span className="animate-pulse">{text}</span>
      {tool && saying ? <span className="truncate text-mist/60" data-testid="coworker-saying">{saying}…</span> : null}
    </div>
  );
}

/**
 * Why a saved model cannot run right now, in terms the user can act on:
 * which provider it belongs to, whether that provider is connected at all,
 * and whether the account (not this Mac) is the place to fix it.
 */
function describeUnavailableModel(model: string, available: EngineModelOption[], session: DenSession | null): string {
  const separator = model.indexOf("/");
  const providerId = separator > 0 ? model.slice(0, separator) : model;
  const providerModels = available.filter((option) => option.providerId === providerId);
  if (providerModels.length > 0) {
    const sample = providerModels[0];
    return `The saved model "${model}" is not offered by ${sample?.providerLabel ?? providerId} (${modelSourceLabel(sample?.source ?? "local")}) any more. Choose one of its ${providerModels.length} available AI model${providerModels.length === 1 ? "" : "s"}.`;
  }
  const cloudManaged = /^lpr_/i.test(providerId) || providerId === "openwork";
  if (cloudManaged) {
    return session
      ? `The saved model "${model}" belongs to an OpenWork Cloud provider that is not available right now. Refresh your OpenWork providers or choose another AI model.`
      : `The saved model "${model}" belongs to an OpenWork Cloud provider, but no OpenWork account is signed in here. Continue with OpenWork or choose an AI model from this Mac.`;
  }
  return `The saved model "${model}" is not available: provider "${providerId}" is not connected on this Mac. Choose another AI model or connect that provider in OpenWork.`;
}

function TurnIssueNote({
  kind,
  message,
  coworkerName,
  canRetry,
  session,
  onRetry,
  onOpenModelSettings,
  onOpenAccount,
  onRefreshProviders,
  onStop,
}: {
  kind: "failed" | "timeout";
  message: string;
  coworkerName: string;
  canRetry: boolean;
  session: DenSession | null;
  onRetry: () => void;
  onOpenModelSettings: () => void;
  onOpenAccount: () => void;
  /** Re-read the account's providers, then retry; only offered while signed in. */
  onRefreshProviders?: () => void;
  onStop?: () => void;
}) {
  const failure = kind === "failed"
    ? describeTurnFailure(message, coworkerName)
    : { headline: "The reply is taking too long", detail: message, technical: "", modelRelated: false };
  return (
    <div className="rounded-xl border border-rose/25 bg-rose/5 px-3 py-3" data-testid={`coworker-turn-${kind}`}>
      <div className="flex items-start gap-2.5">
        <CoworkerMark className="mt-0.5 shrink-0" size={20} />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-snow" data-testid="coworker-turn-headline">{failure.headline}</p>
          {failure.detail ? <p className="mt-1 break-words text-xs leading-relaxed text-mist">{failure.detail}</p> : null}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {canRetry ? <Button variant="ghost" onClick={onRetry}>Retry</Button> : null}
            {onStop ? <Button variant="ghost" onClick={onStop}>Stop</Button> : null}
            <Button variant="ghost" onClick={onOpenModelSettings}>Choose AI model</Button>
            {kind === "failed" && session && onRefreshProviders ? (
              <Button variant="ghost" onClick={onRefreshProviders}>Refresh providers</Button>
            ) : null}
            {kind === "failed" ? (
              <Button variant="ghost" onClick={onOpenAccount}>{session ? "Open account settings" : "Continue with OpenWork"}</Button>
            ) : null}
          </div>
          {failure.technical ? (
            <details className="mt-2 text-[11px] text-mist" data-testid="coworker-turn-technical">
              <summary className="cursor-pointer select-none">Technical details</summary>
              <p className="mt-1 break-words font-mono">{failure.technical}</p>
            </details>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function toolPresentation(call: TranscriptToolCall): { label: string; source: string } {
  const normalized = call.tool.toLowerCase();
  const source = call.tool.includes("_") ? call.tool.split("_")[0] || "OpenWork" : "OpenWork";
  if (normalized.endsWith("search_capabilities")) {
    const query = typeof call.input.query === "string" ? call.input.query.trim() : "";
    return { label: query ? `Searched for “${query}”` : "Searched connected capabilities", source: "OpenWork Connect" };
  }
  if (normalized.endsWith("execute_capability")) {
    const selected = typeof call.input.name === "string" ? call.input.name.trim() : "";
    return { label: selected ? `Used ${selected}` : "Ran a connected capability", source: "OpenWork Connect" };
  }
  return {
    label: call.tool.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase()),
    source,
  };
}

function ToolReceipt({ call, client }: { call: TranscriptToolCall; client: CoworkerMcpClient }) {
  const nextResult = preservedMcpAppResult({ output: call.output, metadata: call.metadata });
  const resultSignature = JSON.stringify(nextResult);
  const resultRef = useRef<{ signature: string; value: PreservedMcpAppResult | null }>({
    signature: resultSignature,
    value: nextResult,
  });
  if (resultRef.current.signature !== resultSignature) {
    resultRef.current = { signature: resultSignature, value: nextResult };
  }
  const result = resultRef.current.value;
  const launch = useMemo(() => gatewayMcpAppLaunch(result?._meta), [result]);
  const inputSignature = JSON.stringify(launch?.arguments ?? call.input);
  const inputRef = useRef<{ signature: string; value: Record<string, unknown> }>({
    signature: inputSignature,
    value: launch?.arguments ?? call.input,
  });
  if (inputRef.current.signature !== inputSignature) {
    inputRef.current = { signature: inputSignature, value: launch?.arguments ?? call.input };
  }
  const [app, setApp] = useState<CoworkerMcpAppResource | null>(null);
  const [appError, setAppError] = useState("");
  const presentation = toolPresentation(call);
  const artifacts = artifactsForToolCall(call);
  const failed = call.status === "error" || call.status === "failed";
  const complete = call.status === "completed" || call.status === "success";

  useEffect(() => {
    let cancelled = false;
    setApp(null);
    setAppError("");
    if (!result || !complete) return;
    void client.resolveApp(call.tool, launch ?? undefined)
      .then(({ app: resolved }) => {
        if (!cancelled) setApp(resolved);
      })
      .catch((cause) => {
        if (!cancelled) setAppError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => { cancelled = true; };
  }, [call.tool, client, complete, launch, result]);

  return (
    <li className="rounded-xl border border-line bg-ink/70 px-2.5 py-2 text-xs text-snow">
      <div className="flex items-center gap-2">
        <span className="relative shrink-0">
          <CoworkerMark loading={!failed && !complete} size={19} />
          <span className="absolute -bottom-0.5 -right-0.5 flex rounded-full ring-2 ring-ink">
            <StatusDot tone={failed ? "rose" : complete ? "mint" : "spark"} />
          </span>
        </span>
        <span className="min-w-0 flex-1 truncate">{presentation.label}</span>
        <span className="shrink-0 text-[10px] text-mist">{failed ? "Failed" : complete ? "Done" : "Working"}</span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-3 pl-4 text-[9px] text-mist/75">
        <span className="truncate">{presentation.source}</span>
        <details className="shrink-0">
          <summary className="cursor-pointer select-none">Details</summary>
          <p className="mt-1 max-w-64 break-all text-right font-mono">{call.tool}</p>
        </details>
      </div>
      {call.error ? <p className="mt-2 pl-4 text-[10px] text-rose">{call.error}</p> : null}
      {complete && artifacts.length > 0 ? (
        <div className="mt-2 space-y-1.5 border-t border-line pt-2" data-testid="coworker-artifacts">
          {artifacts.map((artifact) => (
            <div key={`${artifact.kind}:${artifact.value}`} className="flex items-center gap-2 rounded-lg bg-white/[0.035] px-2.5 py-2">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-white/8 bg-ink text-mist">
                <ArtifactIcon kind={artifact.kind} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[9px] font-semibold uppercase tracking-[0.1em] text-mist">{artifactKindLabel(artifact.kind)}</span>
                <span className="mt-0.5 block truncate text-[11px] font-medium text-snow" title={artifact.value}>{artifact.label}</span>
              </span>
              {artifact.openUrl ? (
                <button
                  type="button"
                  className="rounded-lg border border-white/9 px-2 py-1 text-[10px] font-medium text-mist transition-colors hover:bg-white/6 hover:text-snow"
                  onClick={() => void coworkerBridge.openExternal(artifact.openUrl ?? "")}
                >
                  Open
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {app && result ? (
        <div className="mt-2">
          <McpAppFrame
            client={client}
            app={app}
            toolName={call.tool}
            input={inputRef.current.value}
            result={result}
            onClose={() => setApp(null)}
          />
        </div>
      ) : null}
      {appError ? <p className="mt-2 pl-4 text-[10px] text-mist">Interactive view unavailable. {appError}</p> : null}
    </li>
  );
}

function ArtifactIcon({ kind }: { kind: CoworkerArtifactKind }) {
  if (kind === "browser") {
    return (
      <svg aria-hidden="true" viewBox="0 0 20 20" className="size-3.5 fill-none stroke-current" strokeWidth="1.4">
        <circle cx="10" cy="10" r="6.7" />
        <path d="M3.6 8h12.8M3.6 12h12.8M10 3.3c1.8 1.8 2.7 4 2.7 6.7s-.9 4.9-2.7 6.7M10 3.3C8.2 5.1 7.3 7.3 7.3 10s.9 4.9 2.7 6.7" />
      </svg>
    );
  }
  if (kind === "image") {
    return (
      <svg aria-hidden="true" viewBox="0 0 20 20" className="size-3.5 fill-none stroke-current" strokeWidth="1.4">
        <rect x="3" y="3.5" width="14" height="13" rx="2" />
        <circle cx="7.2" cy="7.4" r="1.2" /><path d="m4.5 14 3.8-3.8 2.4 2.4 1.7-1.7 3.1 3.1" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="size-3.5 fill-none stroke-current" strokeWidth="1.4">
      <path d="M5 2.8h6l4 4v10.4H5z" /><path d="M11 2.8v4h4M7.5 10h5M7.5 13h5" />
    </svg>
  );
}

function DiscussionComposer({
  message,
  onMessageChange,
  onSend,
  assignmentMode,
  onAssignmentModeChange,
  assignment,
  onAssignmentChange,
  onCreateAssignment,
  busy,
  error,
  coworkerName,
}: {
  message: string;
  onMessageChange: (value: string) => void;
  onSend: () => void;
  assignmentMode: boolean;
  onAssignmentModeChange: (active: boolean) => void;
  assignment: string;
  onAssignmentChange: (value: string) => void;
  onCreateAssignment: () => void;
  busy: boolean;
  error?: string;
  coworkerName: string;
}) {
  const value = assignmentMode ? assignment : message;
  const submit = assignmentMode ? onCreateAssignment : onSend;
  return (
    <div className="border-t border-line bg-ink px-5 pb-2.5 pt-3">
      <div className="mx-auto max-w-3xl">
        {error ? <div className="mb-2"><ErrorNote>{error}</ErrorNote></div> : null}
        <div className="rounded-2xl border border-line bg-panel/80 p-2 transition-colors focus-within:border-spark/45">
          <div className="mb-1 flex items-center justify-between gap-3 px-1.5 pt-0.5">
            <span className="text-[10px] font-medium text-mist">
              {assignmentMode ? "A bounded outcome, separate from this discussion" : `Chat with ${coworkerName}`}
            </span>
            <button
              type="button"
              className="rounded-lg px-2 py-1 text-[10px] font-medium text-spark transition-colors hover:bg-spark/10"
              onClick={() => onAssignmentModeChange(!assignmentMode)}
            >
              {assignmentMode ? "Back to chat" : "Create assignment"}
            </button>
          </div>
          <div className="flex items-end gap-2">
            <textarea
              aria-label={assignmentMode ? "Assignment outcome" : `Message ${coworkerName}`}
              className="max-h-40 min-h-11 min-w-0 flex-1 resize-none bg-transparent px-2 py-2 text-sm leading-relaxed text-snow outline-none placeholder:text-mist/65"
              placeholder={assignmentMode ? `What should ${coworkerName} own?` : `Message ${coworkerName}…`}
              value={value}
              onChange={(event) => assignmentMode ? onAssignmentChange(event.target.value) : onMessageChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
                event.preventDefault();
                if (!busy && value.trim()) submit();
              }}
            />
            <Button aria-busy={busy} variant="primary" className="rounded-xl" disabled={busy || !value.trim()} onClick={submit}>
              {busy ? "Working…" : assignmentMode ? "Create assignment" : "Send"}
            </Button>
          </div>
        </div>
        <div className="mt-1.5 flex items-center justify-between gap-3 px-1 text-[9px] text-mist/65">
          <span className="hidden sm:inline">Enter to {assignmentMode ? "create" : "send"} · Shift Enter for a new line</span>
          <span className="shrink-0 font-medium tracking-[0.06em]">Powered by OpenWork</span>
        </div>
      </div>
    </div>
  );
}

function MessageComposer({
  value,
  onChange,
  onSubmit,
  busy,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  busy: boolean;
  placeholder: string;
}) {
  return (
    <div className="border-t border-line bg-ink px-5 pb-2.5 pt-3">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-end gap-2 rounded-2xl border border-line bg-panel/80 p-2 transition-colors focus-within:border-spark/45">
          <textarea
            aria-label={placeholder.replace("…", "")}
            className="max-h-40 min-h-11 min-w-0 flex-1 resize-none bg-transparent px-2 py-2 text-sm leading-relaxed text-snow outline-none placeholder:text-mist/65"
            placeholder={placeholder}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              if (!busy && value.trim()) onSubmit();
            }}
          />
          <Button aria-busy={busy} variant="primary" className="rounded-xl" disabled={busy || !value.trim()} onClick={onSubmit}>
            {busy ? "Working…" : "Send"}
          </Button>
        </div>
        <div className="mt-1.5 flex items-center justify-end px-1 text-[9px] text-mist/65">
          <span className="font-medium tracking-[0.06em]">Powered by OpenWork</span>
        </div>
      </div>
    </div>
  );
}
