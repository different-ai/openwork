import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
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
  parseAssignmentBrief,
  timeLabelBetween,
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
  stalledRetry,
  hasPendingInteractions,
  modelSourceLabel,
  parseModelPreference,
  recommendModel,
  type CoworkerActivity,
  type EngineModelOption,
  type PendingInteractions,
  type ThreadListItem,
} from "@/lib/threads";
import { isRunning, type HeadlessThreadModel, type HeadlessTurnAcceptance } from "@openwork/headless-threads";
import {
  classifyThreads,
  configureDiscussionStore,
  discussionIds,
  discussionLabel,
  discussionLooksUsed,
  discussionTitleFromPrompt,
  loadDiscussionRegistry,
  registerDiscussion,
  rememberWorkspaceSlug,
} from "@/lib/discussions";
import { markAutoPicked, wasAutoPicked } from "@/lib/model-choice";
import { describeReview, parseWorkerReview, parseWorkerTurn, workerNameFromTitle, type WorkerReview, type WorkerSummary } from "@/lib/workers";
import { WorkerDecisionCards } from "@/ui/worker-decision";
import { coworkerToolName } from "@/lib/coworker-tools";
import { GLIMPSE_MS, describeGlimpse, describeProgress, describeWorkStep, summarizeWork, technicalSections, type ProgressPhase, type WorkStep } from "@/lib/work-receipt";
import { isServerTool, toolRefPath } from "@/lib/apps-tools";
import { openPanelRoute } from "@/lib/panel-route";
import { appsToolsRoute } from "@/lib/panel-views";
import type { CoworkerSummaryLine, SummaryKind } from "@/lib/coworker-summary";
import {
  EMPTY_THREAD_TURNS,
  beginPending,
  clearPending,
  configureTurnStore,
  dequeue,
  enqueue,
  loadThreadTurns,
  markStopped,
  removeQueued,
  saveThreadTurns,
  takeQueued,
  type QueuedMessage,
  type ThreadTurnState,
} from "@/lib/thread-queue";
import {
  NO_REPLY,
  RETRY_LINE,
  WAIT_BUDGET_MS,
  deriveTurnOutcome,
  type TurnChoice,
  type TurnEngineStatus,
  type TurnOutcome,
  type TurnReplyState,
} from "@/lib/turn-outcome";
import { describeTurnFailure } from "@/lib/turn-failure";
import { classifyFailure, retryDelayMs } from "@/lib/turn-retry";
import { applyStreamEvent, type LiveStream } from "@/lib/live-stream";
import { useAutoGrow } from "@/ui/use-auto-grow";
import { InteractionCard, InteractionCards, LETTERS, OptionRow, typingInField } from "@/ui/interactions";
import { CoworkerAvatar } from "@/ui/coworker-avatar";
import { InlineLoader } from "@/ui/brand";
import { Button, Empty, ErrorNote, PlusIcon, StatusDot, ThoughtIcon, ToolIcon } from "@/ui/kit";
import { Markdown } from "@/ui/markdown";
import { DocumentCard } from "@/ui/documents";
import { documentCardsFromCalls, isDocumentTool, shouldFoldReply, splitReplyLead } from "@/lib/documents";
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
  /** The user message a reply answers; null for user messages and optimistic entries. */
  parentId: string | null;
  text: string;
  /** When the engine recorded the message; null for optimistic entries not yet committed. */
  createdAt: number | null;
  /** When the engine closed a reply; null while it is being written, or when it was cut off. */
  completedAt: number | null;
  /** Why a reply ended without an answer; null when it did not fail. */
  error: { name: string; message: string; retryable: boolean | null } | null;
  reasoning: string;
  /** Provider/model the engine attributed this reply to; null for user turns and unbound replies. */
  model: { providerId: string; modelId: string } | null;
  toolCalls: TranscriptToolCall[];
};

export type AssignmentDraft = { id: number; text: string } | null;

/** How the conversation reaches the Documents view: open a document there, or beside the chat when the window allows. */
export type DocumentHooks = {
  onOpenDocument: (documentId: string) => void;
  onOpenDocumentBeside: (documentId: string) => void;
  canOpenBeside: boolean;
};

type QueuedTurn = {
  id: number;
  threadId: string;
  prompt: string;
  messageId: string;
};

/** A turn this view is driving: which message, and whether the engine has accepted it yet. */
type ActiveTurn = {
  messageId: string;
  prompt: string;
  phase: "accepting" | "waiting";
};

/** How a turn is (re)sent: a fresh message, or the same message id run again after a failure, a stop, or a cut-off. */
type TurnSend = { mode: "send" } | { mode: "retry"; attempt: number; switchedTo?: string };

/** One quiet line's worth of history for a reply that ended without words, kept in the transcript. */
function endedWithoutWords(message: TranscriptMessage): "stopped" | "failed" | null {
  if (message.role !== "assistant" || message.text || !message.error) return null;
  return /abort/i.test(message.error.name) || /abort/i.test(message.error.message) ? "stopped" : "failed";
}

/** The optimistic user message for a turn the transcript does not carry yet. */
function optimisticMessage(turn: { messageId: string; prompt: string }): TranscriptMessage {
  return { id: turn.messageId, role: "user", parentId: null, text: turn.prompt, createdAt: null, completedAt: null, error: null, reasoning: "", model: null, toolCalls: [] };
}

/** How the engine's reply to one message stands: none yet, still being written, finished, or ended in an error. */
function replyStateFor(messages: readonly TranscriptMessage[], messageId: string): TurnReplyState {
  const last = messages.filter((message) => message.role === "assistant" && message.parentId === messageId).at(-1);
  if (!last) return NO_REPLY;
  if (last.error) {
    return {
      state: "error",
      error: `${last.error.name}: ${last.error.message}`,
      retryable: last.error.retryable,
      aborted: /abort/i.test(last.error.name) || /abort/i.test(last.error.message),
    };
  }
  return { state: last.completedAt === null ? "writing" : "complete", error: "", retryable: null, aborted: false };
}

function newQueuedId(): string {
  return `next_${Date.now().toString(36)}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

/** How long a freshly (re)started AI service may stay silent before it is a problem worth naming. */
const WORKSPACE_WARMUP_MS = 45_000;

export const NO_TOOL_MODEL_MESSAGE =
  "No connected AI model can use tools. Connect an AI provider in OpenWork, or choose an AI model in Coworker settings.";

type WorkspaceProblem = { message: string; technical: string };

/** A workspace that stopped answering, in plain words, with the raw reason folded away. */
function WorkspaceProblemNote({ problem, onRetry }: { problem: WorkspaceProblem; onRetry: () => void }) {
  return (
    <div className="mx-auto max-w-xl rounded-xl border border-rose/25 bg-rose/5 px-3 py-3" data-testid="coworker-workspace-problem">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="min-w-0 flex-1 text-xs font-semibold text-snow">{problem.message}</p>
        <Button variant="ghost" className="text-xs" onClick={onRetry}>Try again</Button>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-mist">If this keeps happening, restart the AI service from AI &amp; local setup.</p>
      <details className="mt-2 text-[11px] text-mist">
        <summary className="cursor-pointer select-none">Technical details</summary>
        <p className="mt-1 break-words font-mono">{problem.technical}</p>
      </details>
    </div>
  );
}

/** An empty conversation says who is here and one quiet line; the composer does the rest. */
function QuietEmptyConversation({ coworker, warmingUp = false }: { coworker: CoworkerSummary; warmingUp?: boolean }) {
  return (
    <div className="mx-auto flex h-full max-w-md flex-col items-center justify-center py-10 text-center" data-testid="coworker-discussion-empty">
      <CoworkerAvatar animated color={coworker.avatarColor} glasses={coworker.avatarGlasses} name={coworker.name} size={44} />
      <p className="mt-3 text-sm font-semibold text-snow">{coworker.name}</p>
      {coworker.role ? <p className="mt-0.5 text-xs text-mist">{coworker.role}</p> : null}
      <p className="mt-4 text-sm text-mist">What should we work through?</p>
      {warmingUp ? (
        <div className="mt-3 text-xs text-mist" data-testid="coworker-workspace-warming">
          <InlineLoader label={`Getting ${coworker.name} ready`} />
        </div>
      ) : null}
    </div>
  );
}

// The discussion registry lives beside the coworker record; the bridge is the only way to reach it.
configureDiscussionStore({
  readFile: (slug, path) => coworkerBridge.files.read(slug, path),
  writeFile: (slug, path, content) => coworkerBridge.files.write(slug, path, content),
  listCoworkers: () => coworkerBridge.coworkers.list(),
});
// The turn in flight and the messages waiting as Next live beside it, written by the main process.
configureTurnStore({
  readFile: (slug, path) => coworkerBridge.files.read(slug, path),
  writeFile: (slug, path, content) => coworkerBridge.files.write(slug, path, content),
});

/** Where the one conversation header lets a view place its title line and its actions. */
export type HeaderSlots = { title: HTMLElement | null; actions: HTMLElement | null };

function HeaderContent({ slots, title, actions }: { slots: HeaderSlots; title: ReactNode; actions?: ReactNode }) {
  return (
    <>
      {slots.title ? createPortal(title, slots.title) : null}
      {slots.actions && actions ? createPortal(actions, slots.actions) : null}
    </>
  );
}

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
  discussionDraft,
  openThreadRequest,
  onAssignmentsChange,
  headerSlots,
  onOpenModelSettings,
  onOpenAccount,
  onActivityChange,
  documents,
  summary = null,
  onOpenSummary,
}: {
  runtime: RuntimeInfo;
  session: DenSession | null;
  coworker: CoworkerSummary;
  onCoworkerChanged: (coworker: CoworkerSummary) => void;
  onRefreshRuntime: () => Promise<void>;
  onSyncProviders: () => Promise<ProviderSyncRun>;
  assignmentDraft?: AssignmentDraft;
  /** A ready-to-send discussion message (for example, "explain this run"); the id makes repeats distinct. */
  discussionDraft?: AssignmentDraft;
  /** Set by the context rail to jump straight into a thread; the id makes repeat requests distinct. */
  openThreadRequest?: { id: number; threadId: string } | null;
  /** The one-off assignment threads as this column lists them, and what each waits on the person for, so the panel's Assignments show the same ones. */
  onAssignmentsChange?: (items: ThreadListItem[], attention: Record<string, string>) => void;
  headerSlots: HeaderSlots;
  /** Coworker settings, opened at the AI model section — the first recovery step after a model failure. */
  onOpenModelSettings: () => void;
  /** The OpenWork account section — where a provider is reconnected. */
  onOpenAccount: () => void;
  onActivityChange: (activity: CoworkerActivity | null) => void;
  documents?: DocumentHooks;
  /** What the coworker holds, for the quiet line under the composer; null hides the line. */
  summary?: CoworkerSummaryLine | null;
  /** A part of that line was chosen: open the matching level of Activity. */
  onOpenSummary?: (kind: SummaryKind) => void;
}) {
  const [discussionThreadId, setDiscussionThreadId] = useState(coworker.conversationThreadId);
  /** Thread ids registered as discussions in `discussions.json`; the open one is added even when unregistered. */
  const [registeredDiscussions, setRegisteredDiscussions] = useState<string[]>([]);
  const discussionThreadIds = useMemo(
    () => discussionIds(registeredDiscussions, discussionThreadId),
    [registeredDiscussions, discussionThreadId],
  );
  /** Threads that belong to the coworker's Workers (main process registry); never discussions or assignments. */
  const [workerThreadIds, setWorkerThreadIds] = useState<string[]>([]);
  /** The Workers themselves, for the decision cards in the discussion. */
  const [workerRecords, setWorkerRecords] = useState<WorkerSummary[]>([]);
  const threads = useMemo(
    () =>
      coworker.workspaceId
        ? createCoworkerThreads({
            serverUrl: runtime.serverUrl,
            workspaceId: coworker.workspaceId,
            token: runtime.ownerToken,
            model: coworker.model,
            modelVariant: coworker.modelVariant,
            conversationThreadId: discussionThreadId,
            discussionThreadIds,
            workerThreadIds,
          })
        : null,
    [runtime.serverUrl, runtime.ownerToken, coworker.workspaceId, coworker.model, coworker.modelVariant, discussionThreadId, discussionThreadIds, workerThreadIds],
  );
  const [discussions, setDiscussions] = useState<ThreadListItem[]>([]);
  const [openThreadId, setOpenThreadId] = useState("");
  const [pendingAssignment, setPendingAssignment] = useState<AssignmentDraft>(assignmentDraft ?? null);
  const [queuedTurn, setQueuedTurn] = useState<QueuedTurn | null>(null);
  const [error, setError] = useState("");
  // When the workspace first stops answering; cleared by the next successful read.
  const [failingSince, setFailingSince] = useState<number | null>(null);
  const [lastFailureAt, setLastFailureAt] = useState(0);
  // The AI service restarts to pick up a new workspace and takes a moment to
  // answer. That is a warm-up, not a problem: show a calm getting-ready state
  // and only speak up when the workspace still does not answer after a while.
  const warmingUp = Boolean(error) && runtime.engineManaged && failingSince !== null && lastFailureAt - failingSince < WORKSPACE_WARMUP_MS;
  // While the AI service is unavailable the header note already says so; a raw
  // listing error underneath it would only repeat the fact in technical words.
  const workspaceProblem: WorkspaceProblem | null = error && runtime.engineManaged && !warmingUp
    ? { message: `${coworker.name}'s workspace is not answering right now.`, technical: error }
    : null;

  useEffect(() => {
    setDiscussionThreadId(coworker.conversationThreadId);
  }, [coworker.conversationThreadId]);

  useEffect(() => {
    let cancelled = false;
    rememberWorkspaceSlug(coworker.workspaceId, coworker.slug);
    loadDiscussionRegistry(coworker.slug)
      .then((ids) => {
        if (!cancelled) setRegisteredDiscussions(ids);
      })
      .catch(() => {
        // Without the registry the open discussion is still known; older ones read as assignments until it loads.
      });
    return () => {
      cancelled = true;
    };
  }, [coworker.slug, coworker.workspaceId]);

  useEffect(() => {
    if (!assignmentDraft) return;
    setOpenThreadId("");
    setPendingAssignment(assignmentDraft);
  }, [assignmentDraft]);

  useEffect(() => {
    if (!discussionDraft) return;
    setOpenThreadId("");
  }, [discussionDraft]);

  useEffect(() => {
    if (!openThreadRequest?.threadId) return;
    if (openThreadRequest.threadId === discussionThreadId) {
      setOpenThreadId("");
      return;
    }
    setOpenThreadId(openThreadRequest.threadId);
  }, [discussionThreadId, openThreadRequest]);

  const refresh = useCallback(async () => {
    if (!threads) return;
    try {
      const [all, pending, workers] = await Promise.all([
        threads.listAllThreads(),
        threads.listPendingInteractions().catch((): PendingInteractions => ({ permissions: [], questions: [] })),
        coworkerBridge.workers.list(coworker.slug).catch(() => []),
      ]);
      const workerIds = workers.map((worker) => worker.threadId).filter(Boolean);
      setWorkerThreadIds((current) => (current.length === workerIds.length && current.every((id, index) => id === workerIds[index]) ? current : workerIds));
      setWorkerRecords((current) => (current.length === workers.length && current.every((worker, index) => worker.id === workers[index]?.id && worker.updatedAt === workers[index]?.updatedAt) ? current : workers));
      const split = classifyThreads(all, { discussions: discussionThreadIds, workers: workerIds });
      setDiscussions(split.discussions);
      const attention: Record<string, string> = {};
      for (const permission of pending.permissions) {
        attention[permission.sessionID] ??= describeInteractions({ permissions: [permission], questions: [] });
      }
      for (const question of pending.questions) {
        attention[question.sessionID] ??= describeInteractions({ permissions: [], questions: [question] });
      }
      onAssignmentsChange?.(split.assignments, attention);
      setError("");
      setFailingSince(null);
    } catch (cause) {
      const now = Date.now();
      setError(cause instanceof Error ? cause.message : String(cause));
      setFailingSince((current) => current ?? now);
      setLastFailureAt(now);
    }
  }, [coworker.slug, discussionThreadIds, onAssignmentsChange, threads]);

  // Re-read quickly while the workspace is not answering so the view heals as soon as it does.
  const failing = Boolean(error);
  useEffect(() => {
    void refresh();
    if (!threads) return;
    const unsubscribe = threads.subscribe(() => void refresh());
    const timer = window.setInterval(() => void refresh(), failing ? 1_500 : 5_000);
    return () => {
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [failing, threads, refresh]);

  // The moment the AI service is back, drop any listing error it caused and re-read.
  useEffect(() => {
    if (!runtime.engineManaged) return;
    setError("");
    setFailingSince(null);
    void refresh();
  }, [refresh, runtime.engineManaged]);

  /** Open a new native thread as this coworker's current discussion and register it. */
  const startDiscussion = useCallback(async () => {
    if (!threads) throw new Error("This coworker needs a workspace before it can chat.");
    const discussion = await threads.client.createThread({ title: discussionTitle(coworker.name) });
    // The thread exists now. Whatever else fails, it must never read as an assignment, so the
    // view treats it as a discussion at once and records it in both places as far as they allow.
    setRegisteredDiscussions((current) => (current.includes(discussion.id) ? current : [...current, discussion.id]));
    setDiscussionThreadId(discussion.id);
    const [registered, updated] = await Promise.allSettled([
      registerDiscussion(coworker.slug, discussion.id),
      coworkerBridge.coworkers.update(coworker.slug, { conversationThreadId: discussion.id }),
    ]);
    if (registered.status === "fulfilled") setRegisteredDiscussions(registered.value);
    if (updated.status === "fulfilled") onCoworkerChanged(updated.value);
    if (registered.status === "rejected" && updated.status === "rejected") {
      throw updated.reason instanceof Error ? updated.reason : new Error(String(updated.reason));
    }
    return discussion.id;
  }, [coworker.name, coworker.slug, onCoworkerChanged, threads]);

  const ensureDiscussion = useCallback(async () => {
    if (discussionThreadId) return discussionThreadId;
    return startDiscussion();
  }, [discussionThreadId, startDiscussion]);

  const openNewDiscussion = useCallback(async () => {
    try {
      await startDiscussion();
      setOpenThreadId("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [startDiscussion]);

  /** Return to an earlier discussion; it becomes the coworker's open one. */
  const openDiscussion = useCallback(async (threadId: string) => {
    if (!threadId || threadId === discussionThreadId) {
      setOpenThreadId("");
      return;
    }
    try {
      const updated = await coworkerBridge.coworkers.update(coworker.slug, { conversationThreadId: threadId });
      setDiscussionThreadId(threadId);
      onCoworkerChanged(updated);
      setOpenThreadId("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [coworker.slug, discussionThreadId, onCoworkerChanged]);

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
    void refresh();
  }, [refresh, threads]);

  if (!threads) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-sm space-y-4 text-center">
          <Empty>This coworker needs a workspace before it can start.</Empty>
          {workspaceProblem ? <WorkspaceProblemNote problem={workspaceProblem} onRetry={() => void refresh()} /> : null}
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
        kind={workerThreadIds.includes(openThreadId) ? "worker" : "assignment"}
        headerSlots={headerSlots}
        initialTurn={queuedTurn?.threadId === openThreadId ? queuedTurn : null}
        onBack={() => {
          setOpenThreadId("");
          void refresh();
        }}
        onInitialTurnHandled={(id) => setQueuedTurn((current) => current?.id === id ? null : current)}
        onOpenModelSettings={onOpenModelSettings}
        onOpenAccount={onOpenAccount}
        session={session}
        onSyncProviders={onSyncProviders}
        onActivityChange={onActivityChange}
        onCoworkerChanged={onCoworkerChanged}
        documents={documents}
        summary={summary}
        onOpenSummary={onOpenSummary}
      />
    );
  }

  if (!discussionThreadId) {
    return (
      <DiscussionWelcome
        coworker={coworker}
        headerSlots={headerSlots}
        problem={workspaceProblem}
        warmingUp={warmingUp}
        onRetry={() => void refresh()}
        assignmentDraft={pendingAssignment}
        onStartDiscussion={async (text) => {
          const threadId = await ensureDiscussion();
          setQueuedTurn({ id: Date.now(), threadId, prompt: text, messageId: newMessageId() });
        }}
        onCreateAssignment={createAssignment}
        onAssignmentDraftHandled={() => setPendingAssignment(null)}
        discussionDraft={discussionDraft}
        summary={summary}
        onOpenSummary={onOpenSummary}
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
      headerSlots={headerSlots}
      assignmentDraft={pendingAssignment}
      discussionDraft={discussionDraft}
      initialTurn={queuedTurn?.threadId === discussionThreadId ? queuedTurn : null}
      discussions={discussions}
      onOpenDiscussion={(threadId) => void openDiscussion(threadId)}
      onNewDiscussion={() => void openNewDiscussion()}
      onBack={() => undefined}
      onCreateAssignment={createAssignment}
      onAssignmentDraftHandled={() => setPendingAssignment(null)}
      onInitialTurnHandled={(id) => setQueuedTurn((current) => current?.id === id ? null : current)}
      onOpenModelSettings={onOpenModelSettings}
      onOpenAccount={onOpenAccount}
      session={session}
      onSyncProviders={onSyncProviders}
      onActivityChange={onActivityChange}
      onCoworkerChanged={onCoworkerChanged}
      documents={documents}
      workers={workerRecords}
      onWorkersChanged={() => void refresh()}
      summary={summary}
      onOpenSummary={onOpenSummary}
    />
  );
}

function DiscussionWelcome({
  coworker,
  problem,
  warmingUp,
  onRetry,
  assignmentDraft,
  onStartDiscussion,
  onCreateAssignment,
  onAssignmentDraftHandled,
  discussionDraft,
  headerSlots,
  summary,
  onOpenSummary,
}: {
  coworker: CoworkerSummary;
  problem: WorkspaceProblem | null;
  warmingUp: boolean;
  onRetry: () => void;
  assignmentDraft?: AssignmentDraft;
  discussionDraft?: AssignmentDraft;
  headerSlots: HeaderSlots;
  onStartDiscussion: (text: string) => Promise<void>;
  onCreateAssignment: (outcome: string, messages: ReadonlyArray<DiscussionMessage>) => Promise<void>;
  onAssignmentDraftHandled: () => void;
  summary?: CoworkerSummaryLine | null;
  onOpenSummary?: (kind: SummaryKind) => void;
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

  useEffect(() => {
    if (!discussionDraft) return;
    setAssignmentMode(false);
    setMessage(discussionDraft.text);
  }, [discussionDraft]);

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
    <section className="flex h-full min-h-0 flex-col bg-ink" data-testid="coworker-discussion-view">
      <HeaderContent
        slots={headerSlots}
        title={<span className="truncate">New discussion</span>}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
        {problem ? <WorkspaceProblemNote problem={problem} onRetry={onRetry} /> : null}
        {!problem ? <QuietEmptyConversation coworker={coworker} warmingUp={warmingUp} /> : null}
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
        // A first message fired at a workspace that is still starting would fail on the way in
        // and leave a stray thread behind; hold it until the workspace answers.
        waiting={warmingUp ? `Getting ${coworker.name} ready` : undefined}
        error={composerError}
        coworkerName={coworker.name}
        summary={summary}
        onOpenSummary={onOpenSummary}
      />
    </section>
  );
}

/**
 * The discussion row's title doubles as the way to move between this
 * coworker's discussions. Each one runs on its own native thread, so a reply
 * in progress keeps going while another discussion is open.
 */
function DiscussionSwitcher({
  current,
  currentUsed,
  discussions,
  defaultTitle,
  onOpen,
  onNew,
}: {
  current: ThreadListItem;
  /** Whether the open discussion already holds messages (its list entry may not say so yet). */
  currentUsed: boolean;
  discussions: ThreadListItem[];
  defaultTitle: string;
  onOpen: (threadId: string) => void;
  /** Start another discussion; the open one stays in the list. */
  onNew?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const listed = discussions.some((item) => item.id === current.id) ? discussions : [current, ...discussions];
  const label = discussionLabel(current.title, defaultTitle, currentUsed);

  return (
    <div ref={rootRef} className="relative -ml-2 min-w-0">
      <button
        type="button"
        data-testid="coworker-discussion-switcher"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Switch discussion"
        className="flex max-w-full items-center gap-1 rounded-md px-2 py-0.5 text-left transition-colors hover:bg-panel hover:text-snow"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="truncate text-xs text-mist">{label}</span>
        <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true" className="shrink-0 text-mist">
          <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {listed.length > 1 ? <span className="shrink-0 text-[11px] text-mist">{listed.length}</span> : null}
      </button>
      {open ? (
        <div
          role="menu"
          aria-label="Discussions"
          data-testid="coworker-discussion-menu"
          className="absolute left-2 top-full z-20 mt-1 w-80 max-w-[70vw] rounded-xl border border-line bg-ink/95 p-1.5 shadow-2xl backdrop-blur"
        >
          {onNew ? (
            <button
              type="button"
              role="menuitem"
              data-testid="coworker-new-discussion"
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-snow transition-colors hover:bg-panel"
              onClick={() => {
                setOpen(false);
                onNew();
              }}
            >
              <span className="flex size-4 items-center justify-center text-mist" aria-hidden="true">+</span>
              New discussion
            </button>
          ) : null}
          <p className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-mist">Discussions</p>
          <ul className="max-h-72 overflow-y-auto">
            {listed.map((item) => {
              const active = item.id === current.id;
              const meta = item.status === "busy" ? "Replying" : item.status === "retry" ? "Retrying" : item.updatedAt ? relativeTime(item.updatedAt) : "";
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={active}
                    data-thread-id={item.id}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-panel ${active ? "bg-panel/70" : ""}`}
                    onClick={() => {
                      setOpen(false);
                      onOpen(item.id);
                    }}
                  >
                    <StatusDot tone={threadTone(item.status)} />
                    <span className={`min-w-0 flex-1 truncate text-sm ${active ? "font-semibold text-snow" : "text-snow"}`}>
                      {discussionLabel(item.title, defaultTitle, active ? currentUsed : discussionLooksUsed(item))}
                    </span>
                    <span className={`shrink-0 text-xs ${item.status === "busy" || item.status === "retry" ? "text-spark" : "text-mist"}`}>{meta}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function ThreadView({
  threads,
  threadId,
  coworker,
  runtime,
  kind,
  assignmentDraft,
  discussionDraft,
  initialTurn,
  discussions = [],
  onOpenDiscussion,
  onNewDiscussion,
  onBack,
  onCreateAssignment,
  onAssignmentDraftHandled,
  onInitialTurnHandled,
  onOpenModelSettings,
  onOpenAccount,
  session,
  onSyncProviders,
  onActivityChange,
  onCoworkerChanged,
  headerSlots,
  documents,
  workers = [],
  onWorkersChanged,
  summary = null,
  onOpenSummary,
}: {
  threads: NonNullable<ReturnType<typeof createCoworkerThreads>>;
  threadId: string;
  coworker: CoworkerSummary;
  runtime: RuntimeInfo;
  /** `worker`: a Worker's own thread, shown read-only; steering and stopping live in the Workers view. */
  kind: "discussion" | "assignment" | "worker";
  headerSlots: HeaderSlots;
  /** The coworker's Workers; one waiting for a decision asks for it here, in the discussion. */
  workers?: WorkerSummary[];
  onWorkersChanged?: () => void;
  assignmentDraft?: AssignmentDraft;
  discussionDraft?: AssignmentDraft;
  initialTurn: QueuedTurn | null;
  /** Every discussion this coworker holds, newest first; lets the header switch between them. */
  discussions?: ThreadListItem[];
  onOpenDiscussion?: (threadId: string) => void;
  onNewDiscussion?: () => void;
  onBack: () => void;
  onCreateAssignment?: (outcome: string, messages: ReadonlyArray<DiscussionMessage>) => Promise<void>;
  onAssignmentDraftHandled?: () => void;
  onInitialTurnHandled: (id: number) => void;
  onOpenModelSettings: () => void;
  onOpenAccount: () => void;
  session: DenSession | null;
  onSyncProviders: () => Promise<ProviderSyncRun>;
  onActivityChange: (activity: CoworkerActivity | null) => void;
  onCoworkerChanged: (coworker: CoworkerSummary) => void;
  documents?: DocumentHooks;
  /** What the coworker holds, for the quiet line under the composer; null hides it. */
  summary?: CoworkerSummaryLine | null;
  onOpenSummary?: (kind: SummaryKind) => void;
}) {
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  /** Long replies already reported this mount; the store also refuses a repeat by message id. */
  const longRepliesRecorded = useRef(new Set<string>());
  const recordLongReply = useCallback((messageId: string, chars: number) => {
    if (longRepliesRecorded.current.has(messageId)) return;
    longRepliesRecorded.current.add(messageId);
    void coworkerBridge.documents.recordLongReply(coworker.slug, messageId, chars).catch(() => undefined);
  }, [coworker.slug]);
  /** A different connected, tool-capable model to fall back to after a model-related failure. */
  const [recommendedModel, setRecommendedModel] = useState<EngineModelOption | null>(null);
  const defaultDiscussionTitle = discussionTitle(coworker.name);
  // Until the transcript answers, a discussion carries its default title (which reads as "New
  // discussion" while empty); only an assignment falls back to the generic placeholder.
  const [title, setTitle] = useState(kind === "discussion" ? defaultDiscussionTitle : kind === "worker" ? "Worker" : "Work thread");
  /** The first message sent here, kept until the thread carries a title of its own. */
  const firstPromptRef = useRef("");
  const titleLoadedRef = useRef(false);
  /** What the engine reports for this thread: idle, busy, or retrying (with its next attempt). */
  const [engineStatus, setEngineStatus] = useState<TurnEngineStatus>({ type: "unknown" });
  const [pending, setPending] = useState<PendingInteractions>({ permissions: [], questions: [] });
  const [reply, setReply] = useState("");
  const [assignmentMode, setAssignmentMode] = useState(false);
  const [assignmentText, setAssignmentText] = useState("");
  const [error, setError] = useState("");
  const [assignmentBusy, setAssignmentBusy] = useState(false);
  /** The turn in flight or left unresolved, and the messages waiting as Next — the record turns.json keeps. */
  const [turnState, setTurnState] = useState<ThreadTurnState>(EMPTY_THREAD_TURNS);
  const turnStateRef = useRef<ThreadTurnState>(EMPTY_THREAD_TURNS);
  const [turnsLoaded, setTurnsLoaded] = useState(false);
  /** The pending turn was read back from disk: a quit or reload happened while it ran. */
  const [recovered, setRecovered] = useState(false);
  /** The turn this view is driving right now; null between turns. */
  const [activeTurn, setActiveTurn] = useState<ActiveTurn | null>(null);
  const activeTurnRef = useRef<ActiveTurn | null>(null);
  /** A failure the app met itself, before or beside the engine: a model not connected, a refused send, a stalled retry. */
  const [failure, setFailure] = useState("");
  /** An automatic attempt scheduled after a transient failure, and the timer that fires it. */
  const [appRetry, setAppRetry] = useState<{ attempt: number; nextAt: number } | null>(null);
  const appRetryTimerRef = useRef<number | null>(null);
  /** One quiet receipt for a turn that replied only after a retry with another model. */
  const [resolution, setResolution] = useState<{ messageId: string; note: string } | null>(null);
  /** The words of the reply as they arrive, for a glimpse from the live row; the transcript owns what has landed. */
  const [liveStream, setLiveStream] = useState<LiveStream | null>(null);
  /** Re-derive the outcome every second while a turn is unresolved: "still working" and the retry count are live. */
  const [now, setNow] = useState(() => Date.now());
  const [providerRefreshNote, setProviderRefreshNote] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  /** The far-off retry already cancelled for this thread (by its scheduled time), and why it stalled. */
  const stallRef = useRef<{ next: number; reason: string } | null>(null);
  const clearStall = () => {
    stallRef.current = null;
  };
  const waitControllerRef = useRef<AbortController | null>(null);
  const handledInitialTurnRef = useRef<number | null>(null);
  const mcpClient = useMemo(
    () => createCoworkerMcpClient({
      serverUrl: runtime.serverUrl,
      workspaceId: coworker.workspaceId,
      token: runtime.ownerToken,
    }),
    [coworker.workspaceId, runtime.ownerToken, runtime.serverUrl],
  );

  /**
   * A discussion takes its title from the first message sent in it. The
   * engine keeps the custom title we gave it at creation, so this rename is
   * the only place the title changes; assignments keep their outcome title.
   */
  const titleDiscussionAfterFirstMessage = useCallback((currentTitle: string): string | undefined => {
    if (kind !== "discussion" || !firstPromptRef.current) return undefined;
    if (currentTitle.trim() !== defaultDiscussionTitle) {
      firstPromptRef.current = "";
      return undefined;
    }
    const nextTitle = discussionTitleFromPrompt(firstPromptRef.current);
    if (!nextTitle) return undefined;
    firstPromptRef.current = "";
    void threads.renameThread(threadId, nextTitle).catch(() => undefined);
    return nextTitle;
  }, [defaultDiscussionTitle, kind, threadId, threads]);

  const refresh = useCallback(async () => {
    try {
      const [transcript, interactions] = await Promise.all([
        threads.client.exportTranscript(threadId),
        threads.listThreadInteractions(threadId).catch((): PendingInteractions => ({ permissions: [], questions: [] })),
      ]);
      setPending(interactions);
      const loadedTitle = transcript.title ?? "Work thread";
      titleLoadedRef.current = true;
      setTitle(titleDiscussionAfterFirstMessage(loadedTitle) ?? loadedTitle);
      // A retry the engine pushed hours away is a stall, not progress: cancel it so the turn ends
      // now, and tell the person why in the provider's words with a way to choose another model.
      const status = transcript.status;
      const retryStatus = status.type === "retry" ? status : null;
      const stall = retryStatus ? stalledRetry({ next: retryStatus.next, message: retryStatus.message }) : null;
      if (stall && retryStatus && stallRef.current?.next !== retryStatus.next) {
        stallRef.current = { next: retryStatus.next, reason: stall };
        void threads.client.abortThread(threadId).catch(() => undefined);
        waitControllerRef.current?.abort();
        // A stall found while no turn of this view is in flight (after a reload, say) is still a failure to name.
        if (!activeTurnRef.current) setFailure(stall);
      }
      setEngineStatus(status);
      setMessages(
        transcript.messages.map((message) => ({
          id: message.id,
          role: message.role,
          parentId: message.parentId,
          text: message.text,
          createdAt: message.createdAt,
          completedAt: message.completedAt,
          error: message.error,
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
  }, [threads, threadId, titleDiscussionAfterFirstMessage]);

  useEffect(() => {
    if (kind !== "discussion" || !assignmentDraft) return;
    setAssignmentMode(true);
    setAssignmentText(assignmentDraft.text);
  }, [assignmentDraft, kind]);

  useEffect(() => {
    if (kind !== "discussion" || !discussionDraft) return;
    setAssignmentMode(false);
    setReply(discussionDraft.text);
  }, [discussionDraft, kind]);

  useEffect(() => {
    void refresh();
    const unsubscribe = threads.subscribe(
      () => void refresh(),
      (event) => setLiveStream((current) => applyStreamEvent(current, event, threadId)),
    );
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => {
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [threadId, threads, refresh]);

  useEffect(() => () => {
    waitControllerRef.current?.abort();
    if (appRetryTimerRef.current !== null) window.clearTimeout(appRetryTimerRef.current);
  }, []);

  // What this thread still owes, read back from the coworker home: a turn cut off by a quit or
  // reload, or messages that waited as Next. Anything pending at this point was not sent by this view.
  useEffect(() => {
    let cancelled = false;
    void loadThreadTurns(coworker.slug, threadId)
      .then((state) => {
        if (cancelled) return;
        // A turn sent from this window before the file answered already knows more than the disk did.
        const known = turnStateRef.current;
        const merged: ThreadTurnState = known === EMPTY_THREAD_TURNS
          ? state
          : { pending: known.pending ?? state.pending, next: [...state.next, ...known.next.filter((item) => !state.next.some((other) => other.id === item.id))] };
        turnStateRef.current = merged;
        setTurnState(merged);
        setRecovered(merged.pending !== null && known.pending === null);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setTurnsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [coworker.slug, threadId]);

  /** Change the thread's turn record: the cache updates at once, the file follows through the main process. */
  const commitTurnState = useCallback((update: (state: ThreadTurnState) => ThreadTurnState): ThreadTurnState => {
    const next = update(turnStateRef.current);
    if (next === turnStateRef.current) return next;
    turnStateRef.current = next;
    setTurnState(next);
    void saveThreadTurns(coworker.slug, threadId, next).catch(() => undefined);
    return next;
  }, [coworker.slug, threadId]);

  const pendingTurn = turnState.pending;
  const engineRunning = engineStatus.type === "busy" || engineStatus.type === "retry";

  // A second hand for the words that move: "still working" after the wait budget, the retry count.
  const wordsMove = (pendingTurn !== null && pendingTurn.stoppedAt === null && (engineRunning || activeTurn !== null)) || appRetry !== null;
  useEffect(() => {
    if (!wordsMove) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [wordsMove]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, activeTurn, engineStatus.type, pending.permissions.length, pending.questions.length, turnState.next.length]);

  /**
   * Run one turn to its end: send (or re-send) the message, follow the engine
   * until it replies, fails, is stopped, or is cut off, and record each step
   * in the thread's turn record so the outcome can be derived at any moment —
   * and after a reload. The wait budget is not a deadline: when it passes while
   * the engine is still busy, the wait simply continues and the conversation
   * says "still working". Only the engine going idle without a reply ends the
   * turn without one.
   */
  const submitTurn = useCallback(async (prompt: string, messageId: string, send: TurnSend, modelOverride?: HeadlessThreadModel, failedModels: readonly string[] = []) => {
    if (activeTurnRef.current) return;
    /** The model this turn actually ran on, so a failure can be attributed and, if it was the app's pick, replaced. */
    let turnModelId = modelOverride ? `${modelOverride.providerId}/${modelOverride.modelId}` : coworker.model;
    const attempt = send.mode === "retry" ? send.attempt : 0;
    /**
     * When a model the app chose by itself cannot answer, move to the next
     * recommendation and try the same message again, once or twice, telling
     * the person what happened. A model the person chose is never swapped.
     */
    const fallBack = async (message: string): Promise<boolean> => {
      if (!wasAutoPicked(coworker.slug, turnModelId) || failedModels.length >= 2) return false;
      if (!describeTurnFailure(message, coworker.name).modelRelated) return false;
      try {
        const excluded = [...failedModels, turnModelId];
        const next = recommendModel(await threads.listModelCatalog(), { exclude: excluded });
        const nextModel = next ? parseModelPreference(next.id) : undefined;
        if (!next || !nextModel) return false;
        markAutoPicked(coworker.slug, next.id);
        onCoworkerChanged(await coworkerBridge.coworkers.update(coworker.slug, { model: next.id, modelVariant: "" }));
        setProviderRefreshNote(`${turnModelId} could not answer, so ${coworker.name} is trying ${next.modelLabel} instead.`);
        window.setTimeout(() => void submitTurn(prompt, messageId, { mode: "retry", attempt, switchedTo: next.modelLabel }, nextModel, excluded), 0);
        return true;
      } catch {
        return false;
      }
    };
    /**
     * A transient failure (the network, a busy provider, a 5xx) is tried again
     * by the app itself, visibly and at most three times, under the same
     * message id. Anything hard waits for the person.
     */
    const retryLater = (message: string, retryable: boolean | null): boolean => {
      if (classifyFailure(message, retryable) !== "transient") return false;
      const delay = retryDelayMs(attempt + 1);
      if (delay === null) return false;
      const nextAt = Date.now() + delay;
      setAppRetry({ attempt: attempt + 1, nextAt });
      appRetryTimerRef.current = window.setTimeout(() => {
        appRetryTimerRef.current = null;
        setAppRetry(null);
        void submitTurn(prompt, messageId, { mode: "retry", attempt: attempt + 1 }, modelOverride, failedModels);
      }, delay);
      return true;
    };
    const active: ActiveTurn = { messageId, prompt, phase: "accepting" };
    activeTurnRef.current = active;
    setActiveTurn(active);
    if (kind === "discussion" && !firstPromptRef.current && (!titleLoadedRef.current || title.trim() === defaultDiscussionTitle)) {
      firstPromptRef.current = prompt;
      if (titleLoadedRef.current) {
        const renamed = titleDiscussionAfterFirstMessage(title);
        if (renamed) setTitle(renamed);
      }
    }
    clearStall();
    setFailure("");
    setAppRetry(null);
    setRecovered(false);
    setLiveStream(null);
    setError("");
    setProviderRefreshNote("");
    if (resolution?.messageId !== messageId) setResolution(null);
    commitTurnState((state) => beginPending(state, { messageId, prompt, startedAt: Date.now() }));
    onActivityChange({
      state: "working",
      label: "Working",
      detail: kind === "discussion" ? "Replying in your discussion" : kind === "worker" ? workerNameFromTitle(title) : title,
      updatedAt: Date.now(),
      threadId,
    });
    let refreshTimer: number | undefined;
    /** The turn ended without a reply: settle what the person sees, in this order — fall back, retry later, or say so. */
    const settleFailure = async (message: string, retryable: boolean | null, engineKnows: boolean) => {
      if (await fallBack(message)) return;
      if (retryLater(message, retryable)) return;
      // The engine's own reply carries the words; only a failure it never saw needs remembering here.
      if (!engineKnows) setFailure(message);
    };
    try {
      let turnModel: HeadlessThreadModel | undefined = modelOverride;
      if (!turnModel) {
        const savedModel = parseModelPreference(coworker.model);
        if (savedModel) {
          const catalog = await threads.listModelCatalog();
          if (!catalog.models.some((model) => model.id === coworker.model)) {
            throw new Error(describeUnavailableModel(coworker.model, catalog.models, session));
          }
          turnModel = { ...savedModel, ...(coworker.modelVariant.trim() ? { variant: coworker.modelVariant.trim() } : {}) };
        } else {
          // Nobody chose a model yet: start on a connected model that can use tools and keep it.
          const pick = recommendModel(await threads.listModelCatalog(), { exclude: failedModels });
          if (!pick) throw new Error(NO_TOOL_MODEL_MESSAGE);
          const chosen = parseModelPreference(pick.id);
          if (chosen) turnModel = chosen;
          turnModelId = pick.id;
          markAutoPicked(coworker.slug, pick.id);
          void coworkerBridge.coworkers.update(coworker.slug, { model: pick.id, modelVariant: "" })
            .then(onCoworkerChanged)
            .catch(() => undefined);
        }
      }
      // A re-send waits for the engine to let go of the earlier attempt (a stop is still settling, say).
      if (send.mode === "retry") await threads.client.waitUntilIdle(threadId, { timeoutMs: 15_000, pollIntervalMs: 300 });
      const acceptance: HeadlessTurnAcceptance = send.mode === "retry"
        ? await threads.client.retryTurn(threadId, { prompt, messageId, model: turnModel })
        : await threads.client.sendTurn(threadId, { prompt, messageId, model: turnModel });
      const waiting: ActiveTurn = { messageId, prompt, phase: "waiting" };
      activeTurnRef.current = waiting;
      setActiveTurn(waiting);
      await refresh();
      // Stop pressed while the message was still on its way: the engine had nothing to abort then.
      // Now that it has the turn, abort it as soon as it runs, until it lets go or the turn is over.
      if (turnStateRef.current.pending?.messageId === messageId && turnStateRef.current.pending.stoppedAt !== null) {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const snapshot = await threads.client.getThreadSnapshot(threadId);
          const reply = snapshot.messages.filter((message) => message.role === "assistant" && message.parentId === messageId).at(-1);
          if (reply && (reply.error !== null || reply.completedAt !== null)) break;
          if (isRunning(snapshot.status)) await threads.client.abortThread(threadId).catch(() => undefined);
          await new Promise<void>((resolveWait) => window.setTimeout(resolveWait, 300));
        }
      }

      const controller = new AbortController();
      waitControllerRef.current = controller;
      refreshTimer = window.setInterval(() => void refresh(), 600);
      let result = await threads.client.waitForThread(threadId, { timeoutMs: WAIT_BUDGET_MS, pollIntervalMs: 500, since: acceptance, signal: controller.signal });
      // The budget passing is not the reply failing: while the engine still owns the turn, keep waiting.
      while (result.outcome === "timeout" && isRunning(result.snapshot.status)) {
        result = await threads.client.waitForThread(threadId, { timeoutMs: WAIT_BUDGET_MS, pollIntervalMs: 500, since: acceptance, signal: controller.signal });
      }
      await refresh();
      // Keep the optimistic working state through the transcript commit. Without
      // this paint boundary, the header can briefly return to Ready before the
      // completed assistant message becomes visible.
      await new Promise<void>((resolvePaint) => {
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolvePaint()));
      });

      // A stop or a budget that ran out after the reply had already landed changes nothing: the turn replied.
      const landed = result.outcome !== "settled" && replyStateFor(result.snapshot.messages.map((message) => ({
        id: message.id,
        role: message.role,
        parentId: message.parentId,
        text: "",
        createdAt: message.createdAt,
        completedAt: message.completedAt,
        error: message.error,
        reasoning: "",
        model: null,
        toolCalls: [],
      })), messageId).state === "complete" && !isRunning(result.snapshot.status);
      if (result.outcome === "settled" || landed) {
        if (send.mode === "retry" && send.switchedTo) setResolution({ messageId, note: `Retried with ${send.switchedTo}` });
        commitTurnState(clearPending);
      } else if (result.outcome === "failed") {
        const failureText = result.terminalError
          ? `${result.terminalError.name}: ${result.terminalError.message}`
          : "The model stopped before producing a response.";
        await settleFailure(failureText, result.terminalError?.retryable ?? null, result.terminalError !== null);
      } else if (result.outcome === "timeout") {
        // The engine went idle without a reply or an error: the turn ended in silence.
        await settleFailure("The model stopped before producing a response.", false, false);
      } else if (result.outcome === "aborted") {
        // The wait ended because the engine's far-off retry was cancelled: the model is unavailable.
        // A stop by the person is already in the record instead; the outcome reads it from there.
        const stall = stallRef.current;
        if (stall && turnStateRef.current.pending?.stoppedAt === null) await settleFailure(stall.reason, false, false);
      }
    } catch (cause) {
      // A stop by the person may surface as the wait's own abort: the record already says Stopped.
      const stopped = turnStateRef.current.pending?.messageId === messageId && turnStateRef.current.pending.stoppedAt !== null;
      if (!stopped) await settleFailure(cause instanceof Error ? cause.message : String(cause), null, false);
    } finally {
      if (refreshTimer !== undefined) window.clearInterval(refreshTimer);
      waitControllerRef.current = null;
      if (activeTurnRef.current?.messageId === messageId) {
        activeTurnRef.current = null;
        setActiveTurn(null);
      }
    }
  }, [commitTurnState, coworker.model, coworker.modelVariant, coworker.name, coworker.slug, defaultDiscussionTitle, kind, onActivityChange, onCoworkerChanged, refresh, resolution?.messageId, session, threadId, threads, title, titleDiscussionAfterFirstMessage]);

  /**
   * After a quit or reload the engine may still be on the turn. Follow it to
   * its end the same way, without sending anything, so Next can drain after it.
   */
  const followTurn = useCallback(async (turn: { messageId: string; prompt: string }) => {
    if (activeTurnRef.current) return;
    const active: ActiveTurn = { messageId: turn.messageId, prompt: turn.prompt, phase: "waiting" };
    activeTurnRef.current = active;
    setActiveTurn(active);
    setRecovered(false);
    let refreshTimer: number | undefined;
    try {
      const controller = new AbortController();
      waitControllerRef.current = controller;
      refreshTimer = window.setInterval(() => void refresh(), 600);
      const since = { messageCountBefore: 0, messageId: turn.messageId };
      let result = await threads.client.waitForThread(threadId, { timeoutMs: WAIT_BUDGET_MS, pollIntervalMs: 500, since, signal: controller.signal });
      while (result.outcome === "timeout" && isRunning(result.snapshot.status)) {
        result = await threads.client.waitForThread(threadId, { timeoutMs: WAIT_BUDGET_MS, pollIntervalMs: 500, since, signal: controller.signal });
      }
      await refresh();
      if (result.outcome === "settled") commitTurnState(clearPending);
      // Anything else is in the transcript now; the outcome names it (a failure, a stop, a cut-off).
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (refreshTimer !== undefined) window.clearInterval(refreshTimer);
      waitControllerRef.current = null;
      if (activeTurnRef.current?.messageId === turn.messageId) {
        activeTurnRef.current = null;
        setActiveTurn(null);
      }
    }
  }, [commitTurnState, refresh, threadId, threads]);

  // A turn read back from disk with the engine still on it: pick the wait up where the last window left it.
  useEffect(() => {
    if (!turnsLoaded || !recovered || !pendingTurn || pendingTurn.stoppedAt !== null || engineStatus.type === "unknown") return;
    if (engineStatus.type === "busy" || engineStatus.type === "retry") void followTurn(pendingTurn);
  }, [engineStatus.type, followTurn, pendingTurn, recovered, turnsLoaded]);

  // After a model-related failure, find a different connected model that can use tools.
  const needsModelFallback = failure !== "" || (pendingTurn !== null && replyStateFor(messages, pendingTurn.messageId).state === "error");
  useEffect(() => {
    if (!needsModelFallback) {
      setRecommendedModel(null);
      return;
    }
    let cancelled = false;
    void threads.listModelCatalog()
      .then((catalog) => {
        if (!cancelled) setRecommendedModel(recommendModel(catalog, { exclude: coworker.model }));
      })
      .catch(() => {
        if (!cancelled) setRecommendedModel(null);
      });
    return () => { cancelled = true; };
  }, [coworker.model, needsModelFallback, threads]);

  /** The moment the turn this view is driving lets go (its wait has ended and its record is settled). */
  const untilTurnReleased = useCallback(() => new Promise<void>((resolve) => {
    const startedAt = Date.now();
    const check = () => {
      if (!activeTurnRef.current || Date.now() - startedAt > 10_000) resolve();
      else window.setTimeout(check, 100);
    };
    check();
  }), []);

  /** Run the unresolved turn again under its own message id, on another model when one was chosen. */
  const retryPending = useCallback(async (switched?: { model: HeadlessThreadModel; label: string }) => {
    // A Retry pressed the moment after Stop waits for the stopped turn to let go rather than being lost.
    await untilTurnReleased();
    const turn = turnStateRef.current.pending;
    if (!turn) return;
    void submitTurn(turn.prompt, turn.messageId, { mode: "retry", attempt: 0, ...(switched ? { switchedTo: switched.label } : {}) }, switched?.model);
  }, [submitTurn, untilTurnReleased]);

  /** Switch this coworker to the recommended model and retry the failed message. */
  async function useRecommendedModel() {
    const pick = recommendedModel;
    if (!pick) return;
    const model = parseModelPreference(pick.id);
    if (!model) return;
    try {
      onCoworkerChanged(await coworkerBridge.coworkers.update(coworker.slug, { model: pick.id, modelVariant: "" }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    void retryPending({ model, label: pick.modelLabel });
  }

  useEffect(() => {
    if (!initialTurn || handledInitialTurnRef.current === initialTurn.id) return;
    handledInitialTurnRef.current = initialTurn.id;
    void submitTurn(initialTurn.prompt, initialTurn.messageId, { mode: "send" })
      .finally(() => onInitialTurnHandled(initialTurn.id));
  }, [initialTurn, onInitialTurnHandled, submitTurn]);

  /** Send what is next in line, one at a time, once nothing is in flight and nothing unresolved holds the queue. */
  const drainNext = useCallback(() => {
    if (activeTurnRef.current || turnStateRef.current.pending) return;
    const { state, message } = dequeue(turnStateRef.current);
    if (!message) return;
    commitTurnState(() => state);
    void submitTurn(message.text, newMessageId(), { mode: "send" });
  }, [commitTurnState, submitTurn]);

  useEffect(() => {
    if (!turnsLoaded || activeTurn || pendingTurn || appRetry || turnState.next.length === 0) return;
    // Nothing pending and nothing in flight: whatever waited as Next goes now.
    if (engineStatus.type === "idle") drainNext();
  }, [activeTurn, appRetry, drainNext, engineStatus.type, pendingTurn, turnState.next.length, turnsLoaded]);

  /**
   * The composer never holds. A message typed while the coworker works waits as
   * Next and steers the reply that follows; otherwise it is the next turn.
   */
  function send() {
    const text = reply.trim();
    if (!text) return;
    setReply("");
    if (activeTurnRef.current || turnStateRef.current.pending || appRetry || engineRunning) {
      commitTurnState((state) => enqueue(state, { id: newQueuedId(), text, queuedAt: Date.now() }));
      return;
    }
    void submitTurn(text, newMessageId(), { mode: "send" });
  }

  /** Put a waiting message back in the field to change it. */
  function editQueued(id: string) {
    const { state, message } = takeQueued(turnStateRef.current, id);
    if (!message) return;
    commitTurnState(() => state);
    setAssignmentMode(false);
    setReply((current) => (current.trim() ? `${message.text}\n${current}` : message.text));
  }

  /** Stop the reply in progress and send this waiting message right away. */
  async function sendQueuedNow(id: string) {
    const { state, message } = takeQueued(turnStateRef.current, id);
    if (!message) return;
    commitTurnState(() => state);
    if (activeTurnRef.current || appRetry || engineRunning) {
      await stop();
      await untilTurnReleased();
      await threads.client.waitUntilIdle(threadId, { timeoutMs: 15_000, pollIntervalMs: 300 }).catch(() => undefined);
    }
    // The stopped turn keeps its line in the transcript; the record moves on to this message.
    commitTurnState(clearPending);
    void submitTurn(message.text, newMessageId(), { mode: "send" });
  }

  /**
   * Recovery without leaving the conversation: re-read the account's
   * providers, then retry the same message id if the saved model came back.
   */
  async function refreshProvidersAndRetry() {
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
      void retryPending();
    } catch (cause) {
      setProviderRefreshNote(cause instanceof Error ? cause.message : String(cause));
    }
  }

  /** Stop: the engine's turn, an automatic attempt still waiting, or the wait — whichever is going. Next stays. */
  async function stop() {
    if (appRetryTimerRef.current !== null) {
      window.clearTimeout(appRetryTimerRef.current);
      appRetryTimerRef.current = null;
    }
    setAppRetry(null);
    commitTurnState((state) => markStopped(state, Date.now()));
    waitControllerRef.current?.abort();
    try {
      await threads.client.abortThread(threadId);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  /** Let a cut-off turn go: nothing is sent again, and whatever waited as Next moves on. */
  function discardPending() {
    setFailure("");
    commitTurnState(clearPending);
  }

  function chooseTurnAction(choice: TurnChoice) {
    switch (choice.id) {
      case "retry":
      case "continue":
        void retryPending();
        return;
      case "use-model":
        void useRecommendedModel();
        return;
      case "choose-model":
        onOpenModelSettings();
        return;
      case "continue-with-openwork":
        onOpenAccount();
        return;
      case "refresh-providers":
        void refreshProvidersAndRetry();
        return;
      case "stop":
        void stop();
        return;
      case "discard":
        discardPending();
        return;
      default:
        return;
    }
  }

  async function createAssignmentFromDiscussion() {
    const outcome = assignmentText.trim();
    if (!outcome || !onCreateAssignment) return;
    setAssignmentBusy(true);
    setError("");
    try {
      const optimisticTurn = turnStateRef.current.pending;
      const visibleMessages = optimisticTurn && !messages.some((message) => message.id === optimisticTurn.messageId)
        ? [...messages, optimisticMessage(optimisticTurn)]
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
  // The one value every surface reads: derived from the record, the engine, the reply, and the clock.
  const outcome = deriveTurnOutcome({
    coworkerName: coworker.name,
    now,
    turn: pendingTurn ? { ...pendingTurn, recovered } : null,
    engine: engineStatus,
    // While this view is still driving the turn it has not concluded anything yet: a reply the
    // transcript already shows as failed may be about to be retried, so only the engine speaks.
    reply: pendingTurn && !activeTurn ? replyStateFor(messages, pendingTurn.messageId) : NO_REPLY,
    needsYou,
    failure,
    appRetry,
    waitBudgetMs: WAIT_BUDGET_MS,
    signedIn: session !== null,
    recommendedModel: recommendedModel?.modelLabel ?? "",
  });
  // A reply that landed while this view was not driving the turn (after a reload) settles the record.
  useEffect(() => {
    if (outcome?.kind === "replied" && !activeTurnRef.current) commitTurnState(clearPending);
  }, [commitTurnState, outcome?.kind]);

  const turnRunning = outcome?.kind === "working" || outcome?.kind === "slow" || outcome?.kind === "retrying";
  // The engine can be busy on a turn this view never sent (a Worker's review, a scheduled run): still working.
  const working = turnRunning || (outcome === null && !needsYou && engineRunning) || (activeTurn !== null && outcome === null);
  const visibleMessages = pendingTurn && !messages.some((message) => message.id === pendingTurn.messageId)
    ? [...messages, optimisticMessage(pendingTurn)]
    : messages;
  const lastAssistantIndex = visibleMessages.findLastIndex((message) => message.role === "assistant");
  const activeToolLabel = activeToolCallLabel(visibleMessages);
  // The reply for this turn has started only when the newest message is an
  // assistant message with text; an older reply must not read as progress.
  const newestMessage = visibleMessages.at(-1);
  const replyStarted = newestMessage?.role === "assistant" && newestMessage.text.length > 0;
  const workingLabel = activeTurn?.phase === "accepting"
    ? "Sending"
    : outcome?.kind === "retrying"
      ? "Retrying"
      : outcome?.kind === "slow"
        ? "Still working"
        : activeToolLabel
          ? "Using a tool"
          : replyStarted
            ? "Working"
            : "Thinking";

  const readableStatus = outcome && outcome.kind !== "working" && outcome.kind !== "replied"
    ? outcome.label
    : working
      ? workingLabel
      : "Ready";
  const settledWord = outcome?.kind === "stopped-by-you" || outcome?.kind === "cut-off";
  const failed = outcome?.kind === "failed";

  useEffect(() => {
    if (needsYou) {
      onActivityChange({
        state: "attention",
        label: "Needs you",
        detail: describeInteractions(pending),
        summary: describeInteractions(pending),
        updatedAt: Date.now(),
        threadId,
      });
      return;
    }
    const subject = kind === "discussion" ? "Replying in your discussion" : kind === "worker" ? workerNameFromTitle(title) : title;
    if (outcome?.kind === "failed") {
      onActivityChange({ state: "attention", label: outcome.label, detail: subject, summary: outcome.line, updatedAt: Date.now(), threadId });
      return;
    }
    if (outcome?.kind === "retrying") {
      onActivityChange({ state: "retrying", label: outcome.label, detail: subject, summary: `${RETRY_LINE} Trying again…`, updatedAt: Date.now(), threadId });
      return;
    }
    if (outcome?.kind === "slow") {
      onActivityChange({ state: "working", label: outcome.label, detail: subject, summary: "Still working on it", updatedAt: Date.now(), threadId });
      return;
    }
    if (outcome?.kind === "stopped-by-you" || outcome?.kind === "cut-off") {
      onActivityChange({ state: "recent", label: outcome.label, detail: subject, summary: outcome.line, updatedAt: Date.now(), threadId });
      return;
    }
    if (working) {
      onActivityChange({
        state: "working",
        label: workingLabel,
        detail: activeToolLabel ?? subject,
        updatedAt: Date.now(),
        threadId,
      });
      return;
    }
    // A turn accepted in this same effect pass (the first message of a new discussion) has
    // already announced itself; clearing here would leave the header on Ready for one frame.
    if (activeTurnRef.current) return;
    onActivityChange(null);
  }, [activeToolLabel, kind, needsYou, onActivityChange, outcome?.kind, outcome?.label, outcome?.line, pending, threadId, title, working, workingLabel]);

  const currentDiscussion: ThreadListItem = discussions.find((item) => item.id === threadId)
    ?? { id: threadId, title, createdAt: 0, updatedAt: 0, status: "idle" };
  const freshDiscussion = kind === "discussion" && visibleMessages.length === 0 && !working && !needsYou && !error && !outcome;
  const composerWorking = turnRunning || activeTurn !== null || (engineRunning && !needsYou);

  return (
    <section className="flex h-full min-h-0 flex-col bg-ink" data-testid={kind === "discussion" ? "coworker-discussion-view" : kind === "worker" ? "coworker-worker-view" : "coworker-assignment-view"}>
      {/* The one header above carries the coworker; the view places its title line and actions there. */}
      <HeaderContent
        slots={headerSlots}
        title={kind === "discussion" ? (
          <DiscussionSwitcher
            current={{ ...currentDiscussion, title }}
            currentUsed={visibleMessages.length > 0}
            discussions={discussions}
            defaultTitle={defaultDiscussionTitle}
            onOpen={(id) => onOpenDiscussion?.(id)}
            onNew={onNewDiscussion}
          />
        ) : (
          <>
            <span className="truncate">{kind === "worker" ? workerNameFromTitle(title) : title}</span>
            <span className="shrink-0 rounded-full border border-spark/20 bg-spark/8 px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-[0.08em] text-spark">{kind === "worker" ? "Worker" : "Assignment"}</span>
          </>
        )}
        actions={(
          <>
            {kind !== "discussion" ? <Button variant="ghost" onClick={onBack}>Back</Button> : null}
            {(working || needsYou) && kind !== "worker" ? <Button variant="ghost" onClick={() => void stop()}>Stop</Button> : null}
          </>
        )}
      />
      {/* Progress and problems show inline in the conversation; this keeps the turn state readable to assistive tech and tests. */}
      <p data-testid="coworker-thread-status" className="sr-only" aria-live="polite" data-state={needsYou ? "needs-you" : working ? "working" : "idle"} data-outcome={outcome?.kind ?? ""}>
        {kind === "discussion" && !working && !needsYou && !failed && !settledWord ? "Ready" : readableStatus}
      </p>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <div className="mx-auto max-w-3xl space-y-3">
          {freshDiscussion ? <QuietEmptyConversation coworker={coworker} /> : null}
          {conversationBlocks(visibleMessages, (message, index) => working && message.role === "assistant" && index === lastAssistantIndex).map((block) => {
            if (block.kind === "actions") {
              return <ActionLine key={block.id} review={block.review} reasoning={block.reasoning} calls={block.calls} client={mcpClient} />;
            }
            // A reply that ended without words stays in the transcript as one quiet line; the turn still
            // unresolved is told by the outcome below instead, with its actions.
            if (block.kind === "ended") {
              if (block.message.parentId === pendingTurn?.messageId) return null;
              return <QuietLine key={block.message.id} outcome={block.ended} text={block.ended === "stopped" ? "Stopped." : describeTurnFailure(block.message.error?.message ?? "", coworker.name).headline} />;
            }
            return (
              <Fragment key={block.message.id}>
                <TimeLabel label={timeLabelBetween(block.previous?.createdAt, block.message.createdAt)} />
                <MessageBubble
                  message={block.message}
                  coworker={coworker}
                  mcpClient={mcpClient}
                  active={block.active}
                  continued={block.continued}
                  tail={block.tail}
                  kind={kind}
                  turnCalls={block.calls}
                  documents={documents}
                  onLongReply={block.message.id === visibleMessages[lastAssistantIndex]?.id ? recordLongReply : undefined}
                />
                {resolution && block.message.id === resolution.messageId ? <QuietLine outcome="retried" text={resolution.note} /> : null}
              </Fragment>
            );
          })}
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
          {kind === "discussion" ? (
            <WorkerDecisionCards coworker={coworker} workers={workers} onAnswered={() => onWorkersChanged?.()} />
          ) : null}
          {working && outcome?.kind !== "retrying" ? (
            <WorkIndicator
              coworker={coworker}
              messages={visibleMessages}
              stream={liveStream}
              label={workingLabel}
              stillWorking={outcome?.kind === "slow" ? outcome.line : ""}
              onStop={outcome?.kind === "slow" ? () => void stop() : undefined}
            />
          ) : null}
          {visibleMessages.length === 0 && !error && !working && kind !== "discussion" ? (
            <Empty><InlineLoader label={kind === "worker" ? "Loading the Worker's thread" : "Loading assignment"} /></Empty>
          ) : null}
          {outcome?.kind === "retrying" || outcome?.kind === "stopped-by-you" || outcome?.kind === "cut-off" ? (
            <QuietLine outcome={outcome.kind} text={outcome.line} choices={outcome.choices} onChoose={chooseTurnAction} />
          ) : null}
          {outcome?.kind === "failed" ? (
            <TurnFailureBubble coworkerName={coworker.name} outcome={outcome} onChoose={chooseTurnAction} />
          ) : null}
          {providerRefreshNote ? (
            <p className="px-1 text-[11px] leading-relaxed text-mist" data-testid="coworker-provider-refresh">{providerRefreshNote}</p>
          ) : null}
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          <div ref={endRef} />
        </div>
      </div>
      {kind !== "worker" && turnState.next.length > 0 ? (
        <NextRows items={turnState.next} onEdit={editQueued} onRemove={(id) => commitTurnState((state) => removeQueued(state, id))} onSendNow={(id) => void sendQueuedNow(id)} />
      ) : null}
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
          busy={assignmentBusy}
          working={composerWorking}
          onStop={() => void stop()}
          coworkerName={coworker.name}
          summary={summary}
          onOpenSummary={onOpenSummary}
        />
      ) : kind === "worker" ? (
        <p className="border-t border-line px-5 py-3 text-center text-[11px] text-mist" data-testid="coworker-worker-readonly">
          This is the Worker's own work. Steer, pause, or stop it from the Workers view.
        </p>
      ) : (
        <MessageComposer
          value={reply}
          onChange={setReply}
          onSubmit={() => void send()}
          working={composerWorking}
          onStop={() => void stop()}
          placeholder={`Follow up with ${coworker.name}…`}
          summary={summary}
          onOpenSummary={onOpenSummary}
        />
      )}
    </section>
  );
}

type ConversationBlock =
  | { kind: "actions"; id: string; review: WorkerReview | null; reasoning: string; calls: TranscriptToolCall[] }
  | { kind: "message"; message: TranscriptMessage; previous: TranscriptMessage | undefined; active: boolean; continued: boolean; tail: boolean; calls: TranscriptToolCall[] }
  /** A reply that ended without words — stopped or failed — kept as one quiet line where it happened. */
  | { kind: "ended"; message: TranscriptMessage; ended: "stopped" | "failed" };

/** The app's own turn that wakes the coworker with its Workers' updates; never a bubble from the person. */
function reviewTurn(message: TranscriptMessage): WorkerReview | null {
  return message.role === "user" ? parseWorkerReview(message.text) : null;
}

/**
 * Lay a transcript out as bubbles with the coworker's thinking and actions gathered into one
 * small line between them. Consecutive replies that only did work (no words) fold into the
 * line before the next bubble, so two action lines never sit one after the other. A reply
 * still in progress keeps its thinking out of the line until it has finished. The turn that
 * hands the coworker its Workers' updates joins the same line as what it then did about them.
 */
export function conversationBlocks(
  messages: readonly TranscriptMessage[],
  isActive: (message: TranscriptMessage, index: number) => boolean,
): ConversationBlock[] {
  const blocks: ConversationBlock[] = [];
  let review: WorkerReview | null = null;
  let reasoning: string[] = [];
  let calls: TranscriptToolCall[] = [];
  let pendingId = "";
  const flush = () => {
    if (!review && reasoning.length === 0 && calls.length === 0) return;
    blocks.push({ kind: "actions", id: `actions-${pendingId}`, review, reasoning: reasoning.join("\n\n"), calls });
    review = null;
    reasoning = [];
    calls = [];
  };
  // Bubbles decide grouping: a reply with no visible words never counts as a neighbour, nor does a review turn.
  const bubbles = messages.filter((message, index) =>
    message.role === "assistant" ? Boolean(message.text) || isActive(message, index) : !reviewTurn(message),
  );
  messages.forEach((message, index) => {
    const active = isActive(message, index);
    const reviewed = reviewTurn(message);
    if (reviewed) {
      if (!pendingId) pendingId = message.id;
      review = review ? { updates: [...review.updates, ...reviewed.updates] } : reviewed;
      return;
    }
    if (message.role === "assistant") {
      if (!pendingId) pendingId = message.id;
      if (message.reasoning && !active) reasoning.push(message.reasoning);
      if (message.toolCalls.length > 0) calls = [...calls, ...message.toolCalls];
      const ended = active ? null : endedWithoutWords(message);
      if (ended) {
        // Whatever it thought or did before it ended stays on its own line; the ending is one more.
        flush();
        pendingId = "";
        blocks.push({ kind: "ended", message, ended });
        return;
      }
      if (!message.text && !active) return;
    }
    // The bubble keeps its own turn's calls too, so it can end with a document card.
    const turnCalls = message.role === "assistant" ? calls : [];
    flush();
    pendingId = "";
    const position = bubbles.indexOf(message);
    const previous = position > 0 ? bubbles[position - 1] : undefined;
    const next = position >= 0 ? bubbles[position + 1] : undefined;
    blocks.push({
      kind: "message",
      message,
      previous: messages[index - 1],
      active,
      continued: Boolean(previous && previous.role === message.role),
      tail: !next || next.role !== message.role,
      calls: turnCalls,
    });
  });
  flush();
  return blocks;
}

/** One small centered line between bubbles: what the coworker thought through and did. */
function ActionLine({ review, reasoning, calls, client }: { review: WorkerReview | null; reasoning: string; calls: TranscriptToolCall[]; client: CoworkerMcpClient }) {
  return (
    <div className="flex justify-center py-0.5" data-testid="coworker-action-line">
      <div className="flex max-w-[80%] flex-wrap items-start justify-center gap-x-4 gap-y-1">
        {review ? <ReviewDisclosure review={review} /> : null}
        {reasoning ? <ThinkingDisclosure text={reasoning} /> : null}
        {calls.length > 0 ? <WorkReceipt calls={calls} client={client} /> : null}
      </div>
    </div>
  );
}

const REVIEW_KIND_WORDS = { finding: "reported", decision: "needs a decision", done: "finished", failed: "didn't finish" } as const;

/** "Reviewed 2 updates from Workers", opening into what each Worker said. */
function ReviewDisclosure({ review }: { review: WorkerReview }) {
  return (
    <details className="group text-[11px] text-mist" data-testid="coworker-worker-review">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 py-0.5 marker:hidden hover:text-snow">
        <span>{describeReview(review)}</span>
        <span className="text-mist/60 transition-transform group-open:rotate-90" aria-hidden="true">›</span>
      </summary>
      <ul className="mt-1 space-y-1.5 border-l border-line pl-3 leading-relaxed">
        {review.updates.map((update, index) => (
          <li key={index} className="whitespace-pre-wrap">
            <span className="font-semibold text-snow/80">{update.worker}</span> {REVIEW_KIND_WORDS[update.kind]}: {update.text}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** A quiet centered time label above a message, shown only when enough time has passed. */
function TimeLabel({ label }: { label: string | null }) {
  if (!label) return null;
  return <p className="pb-1 pt-2 text-center text-[11px] font-medium text-mist/80" data-testid="coworker-time-label">{label}</p>;
}

function MessageBubble({
  message,
  coworker,
  mcpClient,
  active,
  continued = false,
  tail = true,
  kind = "discussion",
  turnCalls = [],
  documents,
  onLongReply,
}: {
  message: TranscriptMessage;
  coworker: CoworkerSummary;
  mcpClient: CoworkerMcpClient;
  active: boolean;
  /** The next message is from someone else (or this is the last one): the bubble gets its tail. */
  tail?: boolean;
  /** The previous message is from the same speaker: no avatar or name again, tighter spacing. */
  continued?: boolean;
  /** Every tool call of this reply's turn: the bubble ends with a card per document it wrote, and knows whether a long reply had one behind it. */
  turnCalls?: TranscriptToolCall[];
  documents?: DocumentHooks;
  /** A finished reply ran long with no document behind it; reported once so the coworker is reminded next turn. */
  onLongReply?: (messageId: string, chars: number) => void;
  kind?: "discussion" | "assignment" | "worker";
}) {
  const user = message.role === "user";
  if (user) {
    // In a Worker's thread the person never spoke: each user turn is the app's frame plus what it
    // asked for, so only that ask is shown, as one quiet line.
    const workerTurn = kind === "worker" ? parseWorkerTurn(message.text) : null;
    if (workerTurn) {
      return (
        <article className="flex justify-center py-0.5" data-message-role="user" data-worker-turn="true">
          <p className="max-w-[80%] whitespace-pre-wrap text-center text-[11px] leading-relaxed text-mist" data-testid="coworker-worker-turn">{workerTurn.body}</p>
        </article>
      );
    }
    // The message that opens an assignment carries scaffolding for the model; the person sees
    // the outcome they asked for, with the discussion it came from behind a small disclosure.
    const brief = kind === "assignment" ? parseAssignmentBrief(message.text) : null;
    if (brief) {
      return (
        <article className={`flex justify-end ${continued ? "-mt-1.5" : ""}`} data-message-role="user" data-assignment-brief="true">
          <div className={`bubble bubble-user max-w-[76%] ${tail ? "bubble-tail-right" : ""}`}>
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-white/70">Assignment for {coworker.name}</p>
            <p className="mt-1 whitespace-pre-wrap" data-testid="coworker-assignment-outcome">{brief.outcome}</p>
            {brief.context.length > 0 ? (
              <details className="group mt-2 text-xs text-white/80" data-testid="coworker-assignment-context">
                <summary className="flex cursor-pointer list-none items-center gap-1 marker:hidden hover:text-white">
                  <span>From your discussion · {brief.context.length} message{brief.context.length === 1 ? "" : "s"}</span>
                  <span className="transition-transform group-open:rotate-90" aria-hidden="true">›</span>
                </summary>
                <ol className="mt-1.5 space-y-1.5 border-l border-white/25 pl-2.5">
                  {brief.context.map((entry, index) => (
                    <li key={index} className="whitespace-pre-wrap">
                      <span className="font-semibold">{entry.speaker === "you" ? "You" : coworker.name}:</span> {entry.text}
                    </li>
                  ))}
                </ol>
              </details>
            ) : null}
          </div>
        </article>
      );
    }
    return (
      <article className={`flex justify-end ${continued ? "-mt-1.5" : ""}`} data-message-role="user" data-continued={continued ? "true" : "false"}>
        <div className={`bubble bubble-user max-w-[72%] whitespace-pre-wrap ${tail ? "bubble-tail-right" : ""}`} title={message.createdAt ? new Date(message.createdAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : undefined}>
          {message.text || "…"}
        </div>
      </article>
    );
  }

  // A 1:1 chat reads like Messages: the coworker is named once in the header, so each reply is a
  // plain gray bubble. Thinking and tool work are shown as one small line between bubbles
  // (see conversationBlocks), never inside or stacked.
  return (
    <article className={`flex flex-col items-start ${continued ? "-mt-1" : ""}`} data-message-role="assistant" data-continued={continued ? "true" : "false"}>
      <p className="sr-only">
        {coworker.name}
        {message.model ? (
          <span data-testid="coworker-reply-model">
            {" "}Answered by {message.model.providerId}/{message.model.modelId}
          </span>
        ) : null}
      </p>
      {message.text ? (
        <div
          className={`bubble bubble-coworker max-w-[76%] ${tail ? "bubble-tail-left" : ""}`}
          title={message.model ? `Answered by ${message.model.providerId}/${message.model.modelId}` : undefined}
        >
          <ReplyText message={message} active={active} turnCalls={turnCalls} onLongReply={onLongReply} />
          {documentCardsFromCalls(turnCalls).map((card) => (
            <DocumentCard
              key={card.id}
              card={card}
              onOpen={() => documents?.onOpenDocument(card.id)}
              canOpenBeside={documents?.canOpenBeside ?? false}
              onOpenBeside={() => documents?.onOpenDocumentBeside(card.id)}
            />
          ))}
        </div>
      ) : !active && !message.reasoning && message.toolCalls.length === 0 ? (
        <div className={`bubble bubble-coworker ${tail ? "bubble-tail-left" : ""} text-mist`}>…</div>
      ) : null}
    </article>
  );
}

/**
 * A reply's words. A finished reply that runs long with no document behind it
 * shows its first paragraph and a quiet "Show the rest" fold — nothing is cut,
 * only hidden — and is reported once so the coworker's next turn carries a
 * reminder of how it talks.
 */
function ReplyText({ message, active, turnCalls, onLongReply }: { message: TranscriptMessage; active: boolean; turnCalls: TranscriptToolCall[]; onLongReply?: (messageId: string, chars: number) => void }) {
  const [open, setOpen] = useState(false);
  const folded = !active && shouldFoldReply(message.text, turnCalls);
  useEffect(() => {
    if (folded && onLongReply) onLongReply(message.id, message.text.length);
  }, [folded, message.id, message.text.length, onLongReply]);
  if (!folded) return <Markdown text={message.text} />;
  const { lead, rest } = splitReplyLead(message.text);
  return (
    <div data-testid="reply-fold" data-open={open ? "true" : "false"}>
      <div data-testid="reply-fold-lead"><Markdown text={lead} /></div>
      {open ? <Markdown text={rest} className="mt-2" /> : null}
      <button
        type="button"
        className="mt-2 text-[11px] font-medium text-mist underline decoration-mist/40 underline-offset-2 hover:text-snow"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        data-testid="reply-fold-toggle"
      >
        {open ? "Show less" : "Show the rest"}
      </button>
    </div>
  );
}

/** Provider-returned thinking, folded to one quiet line once the reply is complete. Only what the transcript makes available is shown. */
function ThinkingDisclosure({ text }: { text: string }) {
  return (
    <details className="group text-[11px] text-mist" data-testid="coworker-thinking">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 py-0.5 marker:hidden hover:text-snow">
        <ThoughtIcon className="size-3.5 shrink-0" />
        <span>Thought through</span>
        <span className="text-mist/60 transition-transform group-open:rotate-90" aria-hidden="true">›</span>
      </summary>
      <p className="mt-1 whitespace-pre-wrap border-l border-line pl-3 leading-relaxed">{text}</p>
    </details>
  );
}

/** The step the coworker is on right now, or null when it is only thinking or writing. */
function activeWorkStep(messages: TranscriptMessage[]): WorkStep | null {
  const activeCall = messages
    .flatMap((message) => message.toolCalls)
    .findLast((call) => !["completed", "success", "error", "failed"].includes(call.status));
  return activeCall ? describeWorkStep(activeCall) : null;
}

/** "Editing index.md" for the header and sidebar while a tool runs. */
function activeToolCallLabel(messages: TranscriptMessage[]): string | null {
  const step = activeWorkStep(messages);
  if (!step) return null;
  return step.doing.charAt(0).toUpperCase() + step.doing.slice(1);
}

function progressPhase(label: string, hasActiveStep: boolean): ProgressPhase {
  if (label === "Sending") return "sending";
  if (label === "Retrying") return "retrying";
  if (hasActiveStep) return "tool";
  if (label === "Working" || label === "Still working") return "writing";
  return "thinking";
}

/** Three quiet dots; still under reduced motion. */
function TypingDots() {
  return (
    <span className="flex items-center gap-[3px]" aria-hidden="true">
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className="size-1 rounded-full bg-mist/70 motion-safe:animate-pulse"
          style={{ animationDelay: `${index * 180}ms`, animationDuration: "1.1s" }}
        />
      ))}
    </span>
  );
}

/**
 * One live row per active turn: a small avatar, three dots, and one phrase that
 * changes only when the phase changes — never on a timer. Past the wait budget
 * the phrase softens to "still working on it" and gains one inline Stop; a
 * long wait is not a problem, and nothing rose or card-shaped appears.
 *
 * A person who gets impatient can tap the phrase: one discreet gray line below
 * shows the end of what is streaming right now — the words being written, the
 * thinking, or the tool step — live, and goes away by itself after a moment so
 * the row is discreet again. Tapping again hides it at once.
 */
function WorkIndicator({
  coworker,
  messages,
  stream = null,
  label,
  stillWorking = "",
  onStop,
}: {
  coworker: CoworkerSummary;
  messages: TranscriptMessage[];
  /** The words arriving this moment, when the engine is streaming any. */
  stream?: LiveStream | null;
  label: string;
  /** The softened phrase once the wait budget has passed; empty while the phase phrase applies. */
  stillWorking?: string;
  onStop?: () => void;
}) {
  const step = activeWorkStep(messages);
  const phase = progressPhase(label, step !== null);
  const [peekUntil, setPeekUntil] = useState<number | null>(null);
  useEffect(() => {
    if (peekUntil === null) return;
    const timer = window.setTimeout(() => setPeekUntil(null), Math.max(0, peekUntil - Date.now()));
    return () => window.clearTimeout(timer);
  }, [peekUntil]);
  const writing = messages.findLast((message) => message.role === "assistant");
  const glimpse = peekUntil === null ? "" : describeGlimpse({ live: stream?.text ?? "", text: writing?.text ?? "", reasoning: writing?.reasoning ?? "", step });
  return (
    <div className="px-1 py-1.5 text-xs text-mist" data-testid="coworker-working" data-phase={phase} data-outcome={stillWorking ? "slow" : "working"} data-peek={peekUntil === null ? "false" : "true"}>
      <div className="flex items-center gap-2.5">
        <CoworkerAvatar animated working={phase === "tool"} color={coworker.avatarColor} glasses={coworker.avatarGlasses} name={coworker.name} size={22} />
        <TypingDots />
        <button
          type="button"
          className="text-left hover:text-snow"
          title={peekUntil === null ? `See what ${coworker.name} is doing right now` : "Hide"}
          aria-expanded={peekUntil !== null}
          data-testid="coworker-progress-phrase"
          onClick={() => setPeekUntil((current) => (current === null ? Date.now() + GLIMPSE_MS : null))}
        >
          {stillWorking || describeProgress(coworker.name, phase, step)}
        </button>
        {stillWorking && onStop ? <InlineAction label="Stop" choice="stop" onClick={onStop} /> : null}
      </div>
      {peekUntil !== null ? (
        <p className="mt-1 truncate pl-[3.75rem] text-[11px] text-mist/60" data-testid="coworker-working-peek" aria-live="polite">
          {glimpse || `Nothing to show yet — ${coworker.name} hasn't started writing.`}
        </p>
      ) : null}
    </div>
  );
}

/** One underlined word inside a quiet line or the live row. */
function InlineAction({ label, choice, onClick }: { label: string; choice: TurnChoice["id"]; onClick: () => void }) {
  return (
    <button
      type="button"
      className="font-medium text-snow/80 underline-offset-2 hover:underline"
      data-testid="coworker-turn-choice"
      data-choice={choice}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

/**
 * One small centered line between bubbles for a turn that did not simply
 * reply — stopped, cut off, trying again — with at most two underlined
 * actions beside it. Never a card, never two in a row.
 */
function QuietLine({ outcome, text, choices = [], onChoose }: { outcome: string; text: string; choices?: TurnChoice[]; onChoose?: (choice: TurnChoice) => void }) {
  return (
    <p
      className="flex flex-wrap items-center justify-center gap-x-3 px-12 text-center text-[11px] text-mist"
      data-testid="coworker-turn-line"
      data-outcome={outcome}
    >
      <span>{text}</span>
      {choices.length > 0 && onChoose ? (
        <span className="flex items-center gap-x-3">
          {choices.slice(0, 2).map((choice) => <InlineAction key={choice.id} label={choice.label} choice={choice.id} onClick={() => onChoose(choice)} />)}
        </span>
      ) : null}
    </p>
  );
}

/**
 * A failure is a message from the coworker's side of the conversation: one
 * headline in its voice, one line of explanation, then the lettered ways out
 * (never more than three), with the raw text folded away. It sits at the
 * transcript's bubble width, never across the whole column.
 */
function TurnFailureBubble({ coworkerName, outcome, onChoose }: { coworkerName: string; outcome: TurnOutcome; onChoose: (choice: TurnChoice) => void }) {
  const [busy, setBusy] = useState("");
  useEffect(() => {
    setBusy("");
  }, [outcome.since]);
  const choose = (choice: TurnChoice) => {
    if (busy) return;
    setBusy(choice.id);
    onChoose(choice);
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (busy || typingInField(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      const choice = outcome.choices.find((item) => item.letter === event.key.toUpperCase());
      if (!choice) return;
      event.preventDefault();
      choose(choice);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });
  return (
    <div className="flex justify-start" data-testid="coworker-turn-outcome" data-outcome="failed">
      <InteractionCard
        label={`${coworkerName} could not reply`}
        testId="coworker-turn-failed"
        title={outcome.line}
        titleTestId="coworker-turn-headline"
        detail={outcome.detail || undefined}
        needsYou
      >
        <div className="mt-3 divide-y divide-line/70 rounded-xl border border-line/70" role="listbox" aria-label="What to do">
          {outcome.choices.map((choice, index) => (
            <OptionRow
              key={choice.id}
              letter={choice.letter ?? LETTERS[index] ?? String(index + 1)}
              label={busy === choice.id ? `${choice.label}…` : choice.label}
              disabled={busy !== ""}
              testId="coworker-turn-choice"
              choice={choice.id}
              onChoose={() => choose(choice)}
            />
          ))}
        </div>
        {outcome.technical ? (
          <details className="mt-2 text-[11px] text-mist" data-testid="coworker-turn-technical">
            <summary className="cursor-pointer select-none">Technical details</summary>
            <p className="mt-1 break-words font-mono">{outcome.technical}</p>
          </details>
        ) : null}
      </InteractionCard>
    </div>
  );
}

/**
 * What the person said while the coworker was working, waiting between the
 * transcript and the field. Each row is the message on one line with Edit,
 * Remove, and Send now; the first says what Next means. Rows go one at a
 * time, in order, as turns settle.
 */
function NextRows({ items, onEdit, onRemove, onSendNow }: { items: QueuedMessage[]; onEdit: (id: string) => void; onRemove: (id: string) => void; onSendNow: (id: string) => void }) {
  return (
    <div className="bg-ink px-5 pt-1" data-testid="coworker-next">
      <div className="mx-auto max-w-3xl space-y-1 px-12">
        {items.map((item, index) => (
          <div key={item.id} className="flex items-center gap-2 text-[11px] text-mist" data-testid="coworker-next-row" data-queued-id={item.id}>
            <span className="shrink-0 font-medium text-snow/70">
              Next
              {index === 0 ? <span className="font-normal text-mist/70"> · steers the reply that follows</span> : null}
            </span>
            <span className="min-w-0 flex-1 truncate" title={item.text}>{item.text}</span>
            <span className="flex shrink-0 items-center gap-x-3">
              <button type="button" className="font-medium text-snow/80 underline-offset-2 hover:underline" data-testid="coworker-next-edit" onClick={() => onEdit(item.id)}>Edit</button>
              <button type="button" className="font-medium text-snow/80 underline-offset-2 hover:underline" data-testid="coworker-next-remove" onClick={() => onRemove(item.id)}>Remove</button>
              <button type="button" className="font-medium text-snow/80 underline-offset-2 hover:underline" data-testid="coworker-next-send-now" onClick={() => onSendNow(item.id)}>Send now</button>
            </span>
          </div>
        ))}
      </div>
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

/**
 * One receipt for all the tool work behind a reply. Collapsed, it is one line
 * ("Edited index.md", "Worked with your files and Calendar · 3 steps"); open,
 * it lists each step in plain words with the tool name behind Technical
 * details. A step that is still running or did not finish keeps the receipt
 * open so it never disappears into the fold. Documents and Apps the work
 * produced stay first-class as compact attachments beneath.
 */
function WorkReceipt({ calls, client }: { calls: TranscriptToolCall[]; client: CoworkerMcpClient }) {
  const steps = calls.map((call) => describeWorkStep(call));
  const unsettled = steps.some((step) => step.state !== "done");
  const [open, setOpen] = useState(false);
  const expanded = open || unsettled;
  const summary = summarizeWork(steps);
  const tone = steps.some((step) => step.state === "failed") ? "rose" : unsettled ? "spark" : "mint";
  return (
    <div className="min-w-0 text-[11px]" data-testid="coworker-work-receipt" data-state={tone === "rose" ? "failed" : unsettled ? "working" : "done"}>
      <button
        type="button"
        className="group mx-auto flex max-w-full items-center gap-1.5 py-0.5 text-left text-mist hover:text-snow"
        aria-expanded={expanded}
        onClick={() => setOpen((value) => !value)}
        data-testid="coworker-work-summary"
      >
        <ToolIcon className={`size-3.5 shrink-0 ${unsettled ? "motion-safe:animate-pulse" : ""}`} />
        <span className="min-w-0 flex-1 truncate">{summary}</span>
        <StatusDot tone={tone} />
        <span className={`text-mist/60 transition-transform ${expanded ? "rotate-90" : ""}`} aria-hidden="true">›</span>
      </button>
      {expanded ? (
        // One card of steady width holds the steps; each step can open its technical view.
        <ol className="mt-1.5 w-[min(100%,560px)] divide-y divide-line/60 overflow-hidden rounded-xl border border-line/70 bg-panel/50 text-left" data-testid="coworker-work-steps">
          {calls.map((call) => {
            const step = describeWorkStep(call);
            return (
              <li key={call.partId} className="px-3 py-2" data-testid="coworker-work-step" data-state={step.state}>
                <div className="flex items-center gap-2">
                  <StatusDot tone={step.state === "failed" ? "rose" : step.state === "done" ? "mint" : "spark"} />
                  {isServerTool(call.tool) ? (
                    // A step that used one of the coworker's tools or Apps opens that item in Apps & tools.
                    <button
                      type="button"
                      className={`min-w-0 flex-1 truncate text-left hover:underline ${step.state === "failed" ? "text-rose" : "text-snow"}`}
                      title="Open in Apps & tools"
                      data-testid="coworker-work-step-open"
                      onClick={() => openPanelRoute(appsToolsRoute(toolRefPath(call.tool, step.label)))}
                    >
                      {step.label}
                    </button>
                  ) : (
                    <span className={`min-w-0 flex-1 truncate ${step.state === "failed" ? "text-rose" : "text-snow"}`}>{step.label}</span>
                  )}
                  <span className="shrink-0 text-mist">{step.state === "failed" ? "Didn't finish" : step.state === "done" ? "Done" : "Working on it"}</span>
                </div>
                <TechnicalDetails call={call} />
              </li>
            );
          })}
        </ol>
      ) : null}
      <ToolAttachments calls={calls} client={client} />
    </div>
  );
}

/**
 * The technical view of one step: the tool's name, then labelled blocks (Command, Input,
 * Result, Error) in a steady, readable layout. Closed by default; the error line stays visible.
 */
function TechnicalDetails({ call }: { call: TranscriptToolCall }) {
  const sections = technicalSections(call);
  return (
    <div className="pl-4">
      {call.error ? <p className="mt-1 break-words text-rose">{call.error}</p> : null}
      <details className="group/tech mt-0.5 text-[10px] text-mist/75" data-testid="coworker-work-technical">
        <summary className="flex cursor-pointer select-none items-center gap-1 hover:text-mist">
          <span className="text-mist/60 transition-transform group-open/tech:rotate-90" aria-hidden="true">›</span>
          Technical details
        </summary>
        <dl className="mt-1.5 space-y-1.5 rounded-lg bg-ink/70 p-2.5">
          <div className="flex items-baseline gap-2">
            <dt className="w-14 shrink-0 text-mist/60">Tool</dt>
            <dd className="min-w-0 break-all font-mono text-mist">{call.tool}</dd>
          </div>
          {sections.map((section) => (
            <div key={section.label} className="flex items-baseline gap-2">
              <dt className={`w-14 shrink-0 ${section.label === "Error" ? "text-rose/80" : "text-mist/60"}`}>{section.label}</dt>
              <dd className="min-w-0 flex-1">
                <pre className={`max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono leading-relaxed ${section.label === "Error" ? "text-rose" : "text-snow/85"}`}>{section.text}</pre>
              </dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}

/** Documents and Apps produced by the work, once, beneath the receipt. */
function ToolAttachments({ calls, client }: { calls: TranscriptToolCall[]; client: CoworkerMcpClient }) {
  const seen = new Set<string>();
  const artifacts = calls
    .filter((call) => call.status === "completed" || call.status === "success")
    .flatMap((call) => artifactsForToolCall(call))
    .filter((artifact) => {
      const identity = `${artifact.kind}:${artifact.value}`;
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
  return (
    <>
      {artifacts.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1.5" data-testid="coworker-artifacts">
          {artifacts.map((artifact) => {
            const chip = (
              <>
                <span className="flex size-4 shrink-0 items-center justify-center text-mist"><ArtifactIcon kind={artifact.kind} /></span>
                <span className="max-w-56 truncate text-[11px] font-medium text-snow">{artifact.label}</span>
              </>
            );
            const title = `${artifactKindLabel(artifact.kind)} · ${artifact.value}`;
            return artifact.openUrl ? (
              <button
                key={`${artifact.kind}:${artifact.value}`}
                type="button"
                className="flex items-center gap-1.5 rounded-lg border border-white/8 bg-white/[0.03] px-2 py-1 transition-colors hover:bg-white/6"
                title={`Open ${title}`}
                onClick={() => void coworkerBridge.openExternal(artifact.openUrl ?? "")}
              >
                {chip}
              </button>
            ) : (
              <span key={`${artifact.kind}:${artifact.value}`} className="flex items-center gap-1.5 rounded-lg border border-white/8 bg-white/[0.03] px-2 py-1" title={title}>
                {chip}
              </span>
            );
          })}
        </div>
      ) : null}
      {/* The coworker's own tools — documents, assignments, memory — answer in the bubble or the panel, never as an App. */}
      {calls.filter((call) => !isDocumentTool(call.tool) && !coworkerToolName(call.tool)).map((call) => <ToolAppFrame key={call.partId} call={call} client={client} />)}
    </>
  );
}

/** The standard MCP App a tool call returned, mounted in the existing sandboxed host. */
function ToolAppFrame({ call, client }: { call: TranscriptToolCall; client: CoworkerMcpClient }) {
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

  if (app && result) {
    return (
      <div className="mt-1.5">
        <McpAppFrame
          client={client}
          app={app}
          toolName={call.tool}
          input={inputRef.current.value}
          result={result}
          onClose={() => setApp(null)}
        />
      </div>
    );
  }
  if (appError) return <p className="mt-1 text-[10px] text-mist">Interactive view unavailable. {appError}</p>;
  return null;
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
  working = false,
  onStop,
  waiting,
  error,
  coworkerName,
  summary = null,
  onOpenSummary,
}: {
  message: string;
  onMessageChange: (value: string) => void;
  onSend: () => void;
  assignmentMode: boolean;
  onAssignmentModeChange: (active: boolean) => void;
  assignment: string;
  onAssignmentChange: (value: string) => void;
  onCreateAssignment: () => void;
  /** An assignment is being created from the field; the field waits for it. */
  busy: boolean;
  /** A reply is in progress: the field stays open, Enter puts the message on Next, and the round control stops when the field is empty. */
  working?: boolean;
  onStop?: () => void;
  /** Why sending has to wait a moment (for example, the workspace is still starting); typing stays possible. */
  waiting?: string;
  error?: string;
  coworkerName: string;
  summary?: CoworkerSummaryLine | null;
  onOpenSummary?: (kind: SummaryKind) => void;
}) {
  const value = assignmentMode ? assignment : message;
  const submit = assignmentMode ? onCreateAssignment : onSend;
  const held = busy || Boolean(waiting);
  const canSubmit = !held && Boolean(value.trim());
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(fieldRef, value);
  const modeLabel = assignmentMode ? "Back to chat" : "Create assignment";
  const stopping = working && !assignmentMode && !value.trim() && Boolean(onStop);
  const submitLabel = busy ? "Working…" : assignmentMode ? "Create assignment" : working ? "Next" : "Send";
  return (
    <div className="bg-ink px-5 pb-2 pt-2" data-testid="coworker-composer" data-working={working ? "true" : "false"}>
      <div className="mx-auto max-w-3xl">
        {error ? <div className="mb-2"><ErrorNote>{error}</ErrorNote></div> : null}
        {assignmentMode ? (
          <p className="mb-1.5 px-12 text-[11px] text-mist" data-testid="coworker-assignment-mode">
            Something {coworkerName} should own, separate from this chat
          </p>
        ) : null}
        <div className="flex items-end gap-2">
          {/* One quiet control beside the field: turn the message into an assignment, or come back to chat. */}
          <button
            type="button"
            aria-pressed={assignmentMode}
            className={`mb-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border text-lg leading-none transition-colors ${
              assignmentMode ? "border-spark/50 bg-spark/15 text-spark" : "border-line text-mist hover:border-spark/40 hover:text-snow"
            }`}
            title={modeLabel}
            onClick={() => onAssignmentModeChange(!assignmentMode)}
          >
            <PlusIcon className={`size-4 transition-transform ${assignmentMode ? "rotate-45" : ""}`} />
            <span className="sr-only">{modeLabel}</span>
          </button>
          <div className={`flex min-w-0 flex-1 items-end gap-1 rounded-[20px] border bg-panel/60 py-1 pl-4 pr-1 transition-colors focus-within:border-spark/50 ${assignmentMode ? "border-spark/35" : "border-line"}`}>
            <textarea
              ref={fieldRef}
              aria-label={assignmentMode ? "Assignment outcome" : `Message ${coworkerName}`}
              rows={1}
              className="min-h-[30px] min-w-0 flex-1 resize-none bg-transparent py-1 text-sm leading-relaxed text-snow outline-none placeholder:text-mist/65"
              placeholder={assignmentMode ? `What should ${coworkerName} own?` : `Message ${coworkerName}`}
              value={value}
              onChange={(event) => assignmentMode ? onAssignmentChange(event.target.value) : onMessageChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
                event.preventDefault();
                if (canSubmit) submit();
              }}
            />
            {stopping && onStop ? (
              <SendButton label="Stop" busy={false} disabled={false} stop onClick={onStop} />
            ) : (
              <SendButton label={submitLabel} busy={busy} disabled={!canSubmit} title={waiting} onClick={submit} />
            )}
          </div>
        </div>
        <div className="mt-1.5 flex items-center justify-between gap-3 px-12 text-[9px] text-mist/65">
          <span className="hidden sm:inline" data-testid="coworker-composer-hint">
            {waiting && !busy
              ? `${waiting}…`
              : working && !assignmentMode
                ? "Enter sends it next · Shift Enter for a new line"
                : `Enter to ${assignmentMode ? "create" : "send"} · Shift Enter for a new line`}
          </span>
          <SummaryLine summary={summary} onOpen={onOpenSummary} />
        </div>
      </div>
    </div>
  );
}

/**
 * One discreet line about what the coworker holds — "2 assignments · 1 Worker ·
 * 3 documents" — at the foot of the conversation. Each part opens its level of
 * Activity; a dot after "documents" marks ones changed since the person looked.
 */
export function SummaryLine({ summary, onOpen }: { summary: CoworkerSummaryLine | null; onOpen?: (kind: SummaryKind) => void }) {
  if (!summary) return null;
  if (summary.parts.length === 0) {
    return <span className="shrink-0 truncate" data-testid="coworker-summary-line">{summary.text}</span>;
  }
  return (
    <span className="flex min-w-0 shrink-0 items-center gap-1" data-testid="coworker-summary-line">
      {summary.parts.map((part, index) => (
        <Fragment key={part.kind}>
          {index > 0 ? <span aria-hidden="true">·</span> : null}
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded px-0.5 text-mist/80 transition-colors hover:text-snow focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-spark/60"
            onClick={() => onOpen?.(part.kind)}
            disabled={!onOpen}
            data-testid={`summary-part-${part.kind}`}
            data-count={part.count}
          >
            {part.label}
            {part.changed > 0 ? <span className="size-1 rounded-full bg-spark" aria-hidden="true" data-testid="documents-changed-dot" /> : null}
          </button>
        </Fragment>
      ))}
    </span>
  );
}

/**
 * The round control shared by every composer: our accent when it can send,
 * quiet otherwise. While a reply runs and the field is empty it turns into a
 * stop control, so Stop is always one click away.
 */
export function SendButton({ label, busy, disabled, title, onClick, testId = "coworker-send", stop = false }: { label: string; busy: boolean; disabled: boolean; title?: string; onClick: () => void; testId?: string; stop?: boolean }) {
  return (
    <button
      type="button"
      aria-busy={busy}
      disabled={disabled}
      title={title || label}
      data-testid={testId}
      data-role={stop ? "stop" : "send"}
      className={`mb-0.5 flex size-7 shrink-0 items-center justify-center rounded-full transition-colors ${
        disabled ? "bg-white/8 text-mist/60" : stop ? "bg-white/12 text-snow hover:bg-white/18" : "bg-spark text-white hover:bg-spark/90"
      } disabled:cursor-not-allowed`}
      onClick={onClick}
    >
      {busy ? (
        <span aria-hidden="true" className="block size-3 animate-spin rounded-full border-2 border-white/30 border-t-white" />
      ) : stop ? (
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="currentColor" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M8 13V3.5M3.8 7.7 8 3.5l4.2 4.2" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      <span className="sr-only">{label}</span>
    </button>
  );
}

function MessageComposer({
  value,
  onChange,
  onSubmit,
  working = false,
  onStop,
  placeholder,
  summary = null,
  onOpenSummary,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  /** A reply is in progress: the field stays open, Enter puts the message on Next, and the round control stops when the field is empty. */
  working?: boolean;
  onStop?: () => void;
  placeholder: string;
  summary?: CoworkerSummaryLine | null;
  onOpenSummary?: (kind: SummaryKind) => void;
}) {
  const canSubmit = Boolean(value.trim());
  const stopping = working && !value.trim() && Boolean(onStop);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(fieldRef, value);
  return (
    <div className="bg-ink px-5 pb-2 pt-2" data-testid="coworker-composer" data-working={working ? "true" : "false"}>
      <div className="mx-auto max-w-3xl">
        <div className="flex min-w-0 items-end gap-1 rounded-[20px] border border-line bg-panel/60 py-1 pl-4 pr-1 transition-colors focus-within:border-spark/50">
          <textarea
            ref={fieldRef}
            aria-label={placeholder.replace("…", "")}
            rows={1}
            className="min-h-[30px] min-w-0 flex-1 resize-none bg-transparent py-1 text-sm leading-relaxed text-snow outline-none placeholder:text-mist/65"
            placeholder={placeholder}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              if (canSubmit) onSubmit();
            }}
          />
          {stopping && onStop ? (
            <SendButton label="Stop" busy={false} disabled={false} stop onClick={onStop} />
          ) : (
            <SendButton label={working ? "Next" : "Send"} busy={false} disabled={!canSubmit} onClick={onSubmit} />
          )}
        </div>
        {summary ? (
          <div className="mt-1.5 flex items-center justify-end px-1 text-[9px] text-mist/65">
            <SummaryLine summary={summary} onOpen={onOpenSummary} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
