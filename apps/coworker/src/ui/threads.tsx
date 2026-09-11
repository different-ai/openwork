import { ActionMenu } from "@/ui/kit";
import { Fragment, Suspense, createContext, lazy, memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
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
  parseReferralBrief,
  timeLabelBetween,
} from "@/lib/conversation";
import {
  createCoworkerMcpClient,
  gatewayMcpAppLaunch,
  preservedMcpAppResult,
  type CoworkerMcpAppResource,
  type CoworkerMcpAppContext,
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
import { isRunning, toTranscript, type HeadlessThreadModel, type HeadlessThreadUsage } from "@openwork/headless-threads";
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
import type { EffortStop } from "@/lib/effort";
import { EffortDial } from "@/ui/effort-dial";
import { PopoverDisclosure, TechnicalText } from "@/ui/details-popover";
import { carryVariant, chooseFallbackModel, describeModelChoice, markAutoPicked, resolveDiscussionModel, wasAutoPicked, type ModelLane } from "@/lib/model-choice";
import { usesAppConversationDefault, type ModelDefaults } from "@/lib/model-defaults";
import { describeReview, parseWorkerReview, parseWorkerTurn, workerNameFromTitle, type WorkerReview, type WorkerSummary } from "@/lib/workers";
import { WorkerDecisionCards } from "@/ui/worker-decision";
import { WorkersPanel } from "@/ui/workers";
import { coworkerToolName } from "@/lib/coworker-tools";
import { EXECUTION_KINDS, executionMetadata, executionState, safeWorkLabel, summarizeWorkerReceipt } from "@/lib/work-receipt";
import { executionProgress, type ExecutionActivity } from "@/lib/progress-activity";
import { PROGRESS_LIMITS } from "@/lib/progress-config";
import type { ProgressObservation } from "@/lib/progress-service";
import { livePhase, phaseWord, safeLiveMarkdown, writingText, type LivePhase } from "@/lib/live-phase";
import { describeSpeed, firstWordsFor, rememberFirstWords } from "@/lib/turn-speed";
import { LiveRow } from "@/ui/live-row";
import type { CoworkerSummaryLine, SummaryKind } from "@/lib/coworker-summary";
import {
  EMPTY_THREAD_TURNS,
  beginPending,
  clearPending,
  configureTurnStore,
  backendOwnsTurns,
  dequeue,
  enqueue,
  loadThreadTurns,
  markStopped,
  removeQueued,
  runThreadStop,
  saveThreadTurns,
  subscribeThreadStops,
  takeQueued,
  threadStop,
  type QueuedMessage,
  type ThreadTurnState,
} from "@/lib/thread-queue";
import {
  NO_REPLY,
  WAIT_BUDGET_MS,
  choiceNavigates,
  deriveTurnOutcome,
  retrySummary,
  type TurnChoice,
  type TurnEngineStatus,
  type TurnOutcome,
  type TurnReplyState,
} from "@/lib/turn-outcome";
import { describeTurnFailure, failureText } from "@/lib/turn-failure";
import { useComposerDraft } from "@/ui/use-composer-draft";
import { classifyFailure, retryDelayMs } from "@/lib/turn-retry";
import { applyStreamEvent, type LivePart, type LiveStream } from "@/lib/live-stream";
import { waitForGroup as waitForObservation } from "@/lib/group-continuity";
import { useAutoGrow } from "@/ui/use-auto-grow";
import { JumpToLatest, useConversationScroll } from "@/ui/use-conversation-scroll";
import { InteractionCard, InteractionCards, LETTERS, OptionRow, typingInField } from "@/ui/interactions";
import { acknowledgeCoworker, CoworkerAvatar } from "@/ui/coworker-avatar";
import { InlineLoader } from "@/ui/brand";
import { Button, Empty, ErrorNote, PlusIcon, StatusDot, ToolIcon } from "@/ui/kit";
import { Markdown } from "@/ui/markdown";
import { DocumentCard } from "@/ui/documents";
import { documentCardsFromCalls, isDocumentTool, shouldFoldReply, splitReplyLead } from "@/lib/documents";
import { newcomerLine, teamCardsFromCalls } from "@/lib/team";
import { TeamCardsForTurn, type TeamHooks } from "@/ui/team-cards";
import { WorkPopover, workPopoverPlacement, type WorkPopoverPlacement } from "@/ui/work-popover";
import { appendVoiceDraft, privateVoiceReply, type VoiceExpectation } from "@/lib/voice";
import { useVoice, type VoiceActivation, type VoiceController, type VoicePreparation } from "@/ui/use-voice";
import { VoicePanel, VoiceToggle } from "@/ui/voice";

// Computer, browser and interactive app hosts are discussion-time features;
// their views (and the MCP app bridge) load when a discussion first needs them.
const ComputerControl = lazy(() => import("@/ui/computer-control").then((module) => ({ default: module.ComputerControl })));
const DiscussionBrowser = lazy(() => import("@/ui/browser-panel").then((module) => ({ default: module.DiscussionBrowser })));
const McpAppFrame = lazy(() => import("@/ui/mcp-app-frame").then((module) => ({ default: module.McpAppFrame })));

type TranscriptToolCall = {
  partId: string;
  tool: string;
  status: string;
  input: Record<string, unknown>;
  output: unknown;
  error: string | null;
  metadata: Record<string, unknown>;
  startedAt?: number | null;
  completedAt?: number | null;
};

type TranscriptMessage = {
  id: string;
  role: string;
  /** The user message a reply answers; null for user messages and optimistic entries. */
  parentId: string | null;
  text: string;
  parts: LivePart[];
  /** When the engine recorded the message; null for optimistic entries not yet committed. */
  createdAt: number | null;
  /** When the engine closed a reply; null while it is being written, or when it was cut off. */
  completedAt: number | null;
  /** Why a reply ended without an answer; null when it did not fail. */
  error: { name: string; message: string; retryable: boolean | null; providerError: string | null } | null;
  /** Provider/model the engine attributed this reply to; null for user turns and unbound replies. */
  model: { providerId: string; modelId: string } | null;
  /** What the reply cost in tokens as the engine reported it; null for user turns and until it reports. */
  usage: HeadlessThreadUsage | null;
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
type PreparedVoiceDiscussion = { threadId: string; draft: string; activation: VoiceActivation };

/** A turn this view is driving: which message, and whether the engine has accepted it yet. */
type ActiveTurn = {
  messageId: string;
  prompt: string;
  phase: "accepting" | "waiting";
};

/** How a turn is (re)sent: a fresh message, or the same message id run again after a failure, a stop, or a cut-off. */
type TurnSend = ({ mode: "send" } | { mode: "retry"; attempt: number; switchedTo?: string; byPerson?: boolean }) & { voice?: VoiceExpectation | null };

/** Retry policy travels with the model pin, never today's app defaults. */
type TurnModelSelection = {
  owner: CoworkerSummary;
  defaults: ModelDefaults;
  automatic: boolean;
  allowFallback: boolean;
  lane: ModelLane;
  anchor: string;
};

/** One quiet line's worth of history for a reply that ended without words, kept in the transcript. */
function endedWithoutWords(message: TranscriptMessage): "stopped" | "failed" | null {
  if (message.role !== "assistant" || message.text || !message.error) return null;
  return /abort/i.test(message.error.name) || /abort/i.test(message.error.message) ? "stopped" : "failed";
}

/** The optimistic user message for a turn the transcript does not carry yet. */
function optimisticMessage(turn: { messageId: string; prompt: string }): TranscriptMessage {
  return { id: turn.messageId, role: "user", parentId: null, text: turn.prompt, parts: [], createdAt: null, completedAt: null, error: null, model: null, usage: null, toolCalls: [] };
}

const EMPTY_REPLY_MESSAGE = "The model stopped before producing a response.";
// Reconcile the transcript frequently even though a genuinely long turn is
// allowed to keep working. In particular, a retry reuses its message id and
// some engine versions do not report that replacement as a fresh settlement.
const TURN_OBSERVER_SLICE_MS = 5_000;
const EMPTY_EXECUTIONS: ExecutionActivity[] = [];

/** A reply the engine closed with neither words nor work behind it: the provider went quiet, not an answer. */
function endedEmpty(message: Pick<TranscriptMessage, "text" | "toolCalls" | "completedAt" | "error">): boolean {
  return message.completedAt !== null && message.error === null && !message.text.trim() && message.toolCalls.length === 0;
}

/** How the engine's reply to one message stands: none yet, still being written, finished, or ended in an error. */
function replyStateFor(messages: readonly TranscriptMessage[], messageId: string): TurnReplyState {
  const replies = messages.filter((message) => message.role === "assistant" && message.parentId === messageId);
  const last = replies.at(-1);
  if (!last) return NO_REPLY;
  if (last.error) {
    return {
      state: "error",
      error: failureText(last.error),
      retryable: last.error.retryable,
      aborted: /abort/i.test(last.error.name) || /abort/i.test(last.error.message),
    };
  }
  // The engine records a stream that ended without a word as finished; to the person it is a reply that never came.
  if (endedEmpty(last) && replies.every((reply) => !reply.text.trim() && reply.toolCalls.length === 0)) {
    return { state: "error", error: EMPTY_REPLY_MESSAGE, retryable: false, aborted: false };
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
      <TechnicalText text={problem.technical} testId="coworker-workspace-problem-technical" />
    </div>
  );
}

/** An empty conversation says who is here and one quiet line; the composer does the rest. A newcomer a teammate proposed says why it is here. */
function QuietEmptyConversation({ coworker, warmingUp = false, proposerName = "" }: { coworker: CoworkerSummary; warmingUp?: boolean; proposerName?: string }) {
  const fromTeammate = newcomerLine(coworker, proposerName);
  return (
    <div className="mx-auto flex h-full max-w-md flex-col items-center justify-center py-10 text-center" data-testid="coworker-discussion-empty">
      <CoworkerAvatar identity={coworker.slug} animated={false} motion="quiet" gaze={false} color={coworker.avatarColor} glasses={coworker.avatarGlasses} name={coworker.name} size={44} />
      <p className="mt-3 text-sm font-semibold text-snow">{coworker.name}</p>
      {coworker.role ? <p className="mt-0.5 text-xs text-mist">{coworker.role}</p> : null}
      <p className="mt-4 text-sm text-mist" data-testid="coworker-discussion-empty-line">{fromTeammate || "What should we work through?"}</p>
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
  excludedThreads: (slug) => coworkerBridge.collaboration.excludedThreads(slug),
});
// The turn in flight and the messages waiting as Next live beside it, written by the main process.
configureTurnStore({
  readFile: (slug, path) => coworkerBridge.files.read(slug, path),
  writeFile: (slug, path, content) => coworkerBridge.files.write(slug, path, content),
  readState: (slug, threadId) => coworkerBridge.turns.state(slug, threadId),
  updateState: (slug, threadId, previous, next) => coworkerBridge.turns.update(slug, threadId, previous, next),
});

/** Conversation-owned content in the header and the discussion-tools sidebar. */
export type HeaderSlots = { title: HTMLElement | null; actions: HTMLElement | null; tools: HTMLElement | null };

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

function threadTone(status: ThreadListItem["status"]): "spark" | "amber" | "ready" {
  if (status === "busy") return "spark";
  if (status === "retry") return "amber";
  return "ready";
}

export function ThreadsPanel({
  active,
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
  onOpenProviders,
  onActivityChange,
  documents,
  summary = null,
  onOpenSummary,
  team,
  turnRequest,
}: {
  active: boolean;
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
  /** A message to send in the open discussion as soon as it exists (a request passed from a teammate); the id makes repeats distinct. */
  turnRequest?: { id: number; prompt: string } | null;
  /** How the conversation answers a coworker's offers about the team. */
  team?: TeamHooks;
  headerSlots: HeaderSlots;
  /** Coworker settings, opened at the AI model section — the first recovery step after a model failure. */
  onOpenModelSettings: () => void;
  /** The OpenWork account section — where a provider is reconnected. */
  onOpenAccount: () => void;
  /** OpenWork › AI models — where the person connects their own AI provider when the free model is busy. */
  onOpenProviders: () => void;
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
  const [preparedVoice, setPreparedVoice] = useState<PreparedVoiceDiscussion | null>(null);
  const [error, setError] = useState("");
  // When the workspace first stops answering; cleared by the next successful read.
  const [failingSince, setFailingSince] = useState<number | null>(null);
  const [lastFailureAt, setLastFailureAt] = useState(0);
  const listingGeneration = useRef(0);
  const listingActive = useRef(true);
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
    if (!threads || !listingActive.current) return;
    const generation = ++listingGeneration.current;
    try {
      const [all, pending, workers, excluded] = await Promise.all([
        threads.listAllThreads(),
        threads.listPendingInteractions().catch((): PendingInteractions => ({ permissions: [], questions: [] })),
        coworkerBridge.workers.list(coworker.slug).catch(() => []),
        coworkerBridge.collaboration.excludedThreads(coworker.slug),
      ]);
      if (generation !== listingGeneration.current) return;
      const workerIds = workers.map((worker) => worker.threadId).filter(Boolean);
      setWorkerThreadIds((current) => (current.length === workerIds.length && current.every((id, index) => id === workerIds[index]) ? current : workerIds));
      setWorkerRecords((current) => (current.length === workers.length && current.every((worker, index) => worker.id === workers[index]?.id && worker.updatedAt === workers[index]?.updatedAt) ? current : workers));
      const split = classifyThreads(all.filter((thread) => !excluded.includes(thread.id)), { discussions: discussionThreadIds, workers: workerIds });
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
      if (generation !== listingGeneration.current) return;
      const now = Date.now();
      setError(cause instanceof Error ? cause.message : String(cause));
      setFailingSince((current) => current ?? now);
      setLastFailureAt(now);
    }
  }, [coworker.slug, discussionThreadIds, onAssignmentsChange, threads]);

  // Re-read quickly while the workspace is not answering so the view heals as soon as it does.
  const failing = Boolean(error);
  useEffect(() => {
    listingActive.current = true;
    void refresh();
    if (!threads) return;
    const unsubscribe = threads.subscribe(() => void refresh());
    const timer = window.setInterval(() => void refresh(), failing ? 1_500 : 5_000);
    return () => {
      listingActive.current = false;
      listingGeneration.current += 1;
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
  const startDiscussion = useCallback(async (prepare?: { isCurrent: () => boolean; beforeOpen: (threadId: string) => void }) => {
    if (!threads) throw new Error("This coworker needs a workspace before it can chat.");
    const discussion = await threads.client.createThread({ title: discussionTitle(coworker.name) });
    if (prepare && !prepare.isCurrent()) {
      // Keep a late-created empty discussion recoverable without navigating or activating voice.
      const registered = await registerDiscussion(coworker.slug, discussion.id);
      setRegisteredDiscussions(registered);
      return discussion.id;
    }
    prepare?.beforeOpen(discussion.id);
    // The open thread already counts as a discussion through discussionThreadIds.
    // Native browser/computer controls must wait for the saved registry, not an
    // optimistic ID that can race their first binding against the file write.
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

  // A request passed from a teammate arrives as the person's next message in the open discussion.
  const handledTurnRequestRef = useRef(0);
  useEffect(() => {
    if (!turnRequest || handledTurnRequestRef.current === turnRequest.id) return;
    handledTurnRequestRef.current = turnRequest.id;
    void ensureDiscussion()
      .then((threadId) => {
        setQueuedTurn({ id: turnRequest.id, threadId, prompt: turnRequest.prompt, messageId: newMessageId() });
        setOpenThreadId("");
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [ensureDiscussion, turnRequest]);

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
        active={active}
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
        onOpenProviders={onOpenProviders}
        session={session}
        onSyncProviders={onSyncProviders}
        onActivityChange={onActivityChange}
        onCoworkerChanged={onCoworkerChanged}
        documents={documents}
        summary={summary}
        onOpenSummary={onOpenSummary}
        team={team}
      />
    );
  }

  if (!discussionThreadId) {
    return (
      <DiscussionWelcome
        active={active}
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
        onPrepareVoice={async (request, takeDraft) => {
          await startDiscussion({
            isCurrent: request.isCurrent,
            beforeOpen: (threadId) => {
              const focused = document.activeElement;
              const focus: VoiceActivation["focus"] = request.origin && focused === request.origin
                ? { origin: request.origin, target: "panel", start: 0, end: 0 }
                : request.field && focused === request.field
                  ? { origin: request.field, target: "draft", start: request.field.selectionStart, end: request.field.selectionEnd }
                  : null;
              setPreparedVoice({ threadId, draft: takeDraft(), activation: { accountKey: request.accountKey, scope: `${coworker.slug}:${threadId}`, focus } });
            },
          });
        }}
        onCreateAssignment={createAssignment}
        onAssignmentDraftHandled={() => setPendingAssignment(null)}
        discussionDraft={discussionDraft}
        summary={summary}
        onOpenSummary={onOpenSummary}
        onCoworkerChanged={onCoworkerChanged}
        proposerName={team?.coworkers.find((member) => member.slug === coworker.suggestedBy?.slug)?.name ?? ""}
      />
    );
  }

  return (
    <ThreadView
      key={discussionThreadId}
      active={active}
      threads={threads}
      threadId={discussionThreadId}
      coworker={coworker}
      runtime={runtime}
      kind="discussion"
      preparedVoice={preparedVoice?.threadId === discussionThreadId ? preparedVoice : undefined}
      onVoicePreparedHandled={() => setPreparedVoice((current) => current?.threadId === discussionThreadId ? null : current)}
      browserEligible={registeredDiscussions.includes(discussionThreadId)}
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
      onOpenProviders={onOpenProviders}
      session={session}
      onSyncProviders={onSyncProviders}
      onActivityChange={onActivityChange}
      onCoworkerChanged={onCoworkerChanged}
      documents={documents}
      team={team}
      workers={workerRecords}
      onWorkersChanged={() => void refresh()}
      summary={summary}
      onOpenSummary={onOpenSummary}
    />
  );
}

function DiscussionWelcome({
  active,
  coworker,
  problem,
  warmingUp,
  onRetry,
  assignmentDraft,
  onStartDiscussion,
  onPrepareVoice,
  onCreateAssignment,
  onAssignmentDraftHandled,
  discussionDraft,
  headerSlots,
  summary,
  onOpenSummary,
  onCoworkerChanged,
  proposerName = "",
}: {
  active: boolean;
  coworker: CoworkerSummary;
  problem: WorkspaceProblem | null;
  warmingUp: boolean;
  onRetry: () => void;
  /** The effort dial writes the coworker's preference; the record comes back through here. */
  onCoworkerChanged: (coworker: CoworkerSummary) => void;
  assignmentDraft?: AssignmentDraft;
  discussionDraft?: AssignmentDraft;
  headerSlots: HeaderSlots;
  /** The teammate who proposed this coworker, when one did: its empty conversation says so. */
  proposerName?: string;
  onStartDiscussion: (text: string) => Promise<void>;
  onPrepareVoice: (request: VoicePreparation, takeDraft: () => string) => Promise<void>;
  onCreateAssignment: (outcome: string, messages: ReadonlyArray<DiscussionMessage>) => Promise<void>;
  onAssignmentDraftHandled: () => void;
  summary?: CoworkerSummaryLine | null;
  onOpenSummary?: (kind: SummaryKind) => void;
}) {
  const [message, setMessage] = useComposerDraft(`${coworker.slug}:${coworker.createdAt}:new`);
  const [assignmentText, setAssignmentText] = useComposerDraft(`${coworker.slug}:${coworker.createdAt}:new-assignment`);
  const [assignmentMode, setAssignmentMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [composerError, setComposerError] = useState("");
  const latestDraft = useRef(message);
  latestDraft.current = message;
  const voice = useVoice({
    active: active && !assignmentMode && !busy,
    scope: `${coworker.slug}:new`,
    onTranscript: (text) => setMessage((draft) => appendVoiceDraft(draft, text)),
    onReady: (request) => onPrepareVoice(request, () => { const draft = latestDraft.current; setMessage(""); return draft; }),
  });

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
    voice.stop("");
    setBusy(true);
    setComposerError("");
    try {
      await onStartDiscussion(text);
      acknowledgeCoworker(coworker.slug);
      setMessage((current) => current === message ? "" : current);
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
      setAssignmentText((current) => current === assignmentText ? "" : current);
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
        title={<span className="whitespace-normal">New discussion</span>}
        actions={<Button variant="ghost" disabled title="No active work to stop" data-testid="coworker-stop">Stop</Button>}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
        {problem ? <WorkspaceProblemNote problem={problem} onRetry={onRetry} /> : null}
        {!problem ? <QuietEmptyConversation coworker={coworker} warmingUp={warmingUp} proposerName={proposerName} /> : null}
      </div>
      <DiscussionComposer
        voice={voice}
        message={message}
        onMessageChange={setMessage}
        onSend={() => void send()}
        assignmentMode={assignmentMode}
        onAssignmentModeChange={setAssignmentMode}
        assignment={assignmentText}
        onAssignmentChange={setAssignmentText}
        onCreateAssignment={() => void assign()}
        busy={busy}
        offerStartingPoints={!problem}
        // A first message fired at a workspace that is still starting would fail on the way in
        // and leave a stray thread behind; hold it until the workspace answers.
        waiting={warmingUp ? `Getting ${coworker.name} ready` : undefined}
        error={composerError}
        coworkerName={coworker.name}
        summary={summary}
        onOpenSummary={onOpenSummary}
        effortStop={coworker.effortPreference}
        fixedVariant={coworker.modelVariant}
        onEffortChange={(stop) => void coworkerBridge.coworkers.update(coworker.slug, { effortPreference: stop }).then(onCoworkerChanged).catch(() => undefined)}
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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const edge = useRef<"first" | "last">("first");

  useEffect(() => {
    if (!open) return;
    const items = menuRef.current?.querySelectorAll<HTMLButtonElement>("[role^='menuitem']");
    (edge.current === "last" ? items?.[items.length - 1] : items?.[0])?.focus({ preventScroll: true });
    const onPointerDown = (event: MouseEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open]);

  const listed = discussions.some((item) => item.id === current.id) ? discussions : [current, ...discussions];
  const label = discussionLabel(current.title, defaultTitle, currentUsed);

  return (
    <div ref={rootRef} className="relative -ml-2 min-w-0" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
      <button
        ref={triggerRef}
        type="button"
        data-testid="coworker-discussion-switcher"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title="Switch discussion"
        className="flex max-w-full items-center gap-1 rounded-md px-2 py-0.5 text-left transition-colors hover:bg-panel hover:text-snow"
        onClick={() => { edge.current = "first"; setOpen((value) => !value); }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
          event.preventDefault();
          edge.current = event.key === "ArrowUp" ? "last" : "first";
          setOpen(true);
        }}
      >
        <span className="min-w-0 whitespace-normal text-xs text-mist [overflow-wrap:anywhere]">{label}</span>
        <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true" className="shrink-0 text-mist">
          <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {listed.length > 1 ? <span className="shrink-0 text-[11px] text-mist">{listed.length}</span> : null}
      </button>
      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label="Discussions"
          data-testid="coworker-discussion-menu"
          className="absolute left-2 top-full z-20 mt-1 w-80 max-w-[70vw] rounded-xl border border-line bg-ink/95 p-1.5 shadow-2xl backdrop-blur"
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Escape" || event.key === "Tab") {
              if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); }
              triggerRef.current?.focus({ preventScroll: true });
              setOpen(false);
              return;
            }
            const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[role^='menuitem']"));
            const index = items.findIndex((item) => item === document.activeElement);
            const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : event.key === "ArrowDown" ? (index + 1) % items.length : event.key === "ArrowUp" ? (index - 1 + items.length) % items.length : -1;
            if (next < 0) return;
            event.preventDefault();
            items[next]?.focus({ preventScroll: true });
            items[next]?.scrollIntoView({ block: "nearest" });
          }}
        >
          {onNew ? (
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              data-testid="coworker-new-discussion"
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-snow transition-colors hover:bg-panel"
              onClick={() => {
                setOpen(false);
                triggerRef.current?.focus({ preventScroll: true });
                onNew();
              }}
            >
              <span className="flex size-4 items-center justify-center text-mist" aria-hidden="true">+</span>
              New discussion
            </button>
          ) : null}
          <p className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-mist">Discussions</p>
          <ul role="none" className="max-h-72 overflow-y-auto">
            {listed.map((item) => {
              const active = item.id === current.id;
              const meta = item.status === "busy" ? "Replying" : item.status === "retry" ? "Retrying" : item.updatedAt ? relativeTime(item.updatedAt) : "";
              return (
                <li key={item.id} role="none">
                  <button
                    type="button"
                    role="menuitemradio"
                    tabIndex={-1}
                    aria-checked={active}
                    data-thread-id={item.id}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-panel ${active ? "bg-panel/70" : ""}`}
                    onClick={() => {
                      setOpen(false);
                      triggerRef.current?.focus({ preventScroll: true });
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
  active,
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
  onOpenProviders,
  session,
  onSyncProviders,
  onActivityChange,
  onCoworkerChanged,
  headerSlots,
  documents,
  team,
  workers = [],
  onWorkersChanged,
  summary = null,
  onOpenSummary,
  browserEligible = false,
  preparedVoice,
  onVoicePreparedHandled,
}: {
  active: boolean;
  threads: NonNullable<ReturnType<typeof createCoworkerThreads>>;
  threadId: string;
  coworker: CoworkerSummary;
  runtime: RuntimeInfo;
  /** `worker`: a Worker's own thread, shown read-only; steering and stopping live in the Workers view. */
  kind: "discussion" | "assignment" | "worker";
  browserEligible?: boolean;
  preparedVoice?: PreparedVoiceDiscussion;
  onVoicePreparedHandled?: () => void;
  headerSlots: HeaderSlots;
  /** How the conversation answers a coworker's offers about the team; absent in Worker and assignment threads. */
  team?: TeamHooks;
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
  onOpenProviders: () => void;
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
  const [transcriptLoaded, setTranscriptLoaded] = useState(false);
  const [readErrors, setReadErrors] = useState<Record<string, string>>({});
  const refreshGeneration = useRef(0);
  const turnRevision = useRef(0);
  const turnWrites = useRef(0);
  const viewMounted = useRef(true);
  const refreshScope = useMemo(() => ({ active: true, reads: new Map<string, { promise: Promise<void>; again?: () => void }>() }), [threads, threadId, coworker.slug]);
  const refreshReads = refreshScope.reads;
  const knownMessages = useRef(new Map<string, { role: string; parentId: string | null; ended: boolean }>());
  const retiredReplies = useRef(new Set<string>());
  const observedTurn = useRef("");
  const observedTurnAt = useRef(0);
  const streamTurn = useRef("");
  const { scrollRef, contentRef, away, jumpToLatest } = useConversationScroll(`${coworker.slug}:${coworker.createdAt}:${threadId}`, active, transcriptLoaded);
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
  const [reply, setReply] = useComposerDraft(`${coworker.slug}:${coworker.createdAt}:${threadId}`, preparedVoice?.draft);
  const transferredDraftId = useRef(preparedVoice ? discussionDraft?.id : undefined);
  const voiceRef = useRef<VoiceController | null>(null);
  const [assignmentMode, setAssignmentMode] = useState(false);
  const [assignmentText, setAssignmentText] = useComposerDraft(`${coworker.slug}:${coworker.createdAt}:${threadId}:assignment`);
  const [error, setError] = useState("");
  const [assignmentBusy, setAssignmentBusy] = useState(false);
  /** The turn in flight or left unresolved, and the messages waiting as Next — the record turns.json keeps. */
  const [turnState, setTurnState] = useState<ThreadTurnState>(EMPTY_THREAD_TURNS);
  const turnStateRef = useRef<ThreadTurnState>(EMPTY_THREAD_TURNS);
  const stopScope = JSON.stringify([coworker.slug, coworker.createdAt, threadId]);
  const stopAttempt = useSyncExternalStore(subscribeThreadStops, () => threadStop(stopScope));
  const stopPending = stopAttempt?.state === "pending";
  const stopLabel = stopPending ? "Stopping..." : stopAttempt ? "Retry stop" : "Stop";
  const [turnsLoaded, setTurnsLoaded] = useState(false);
  const [collaborationReceipts, setCollaborationReceipts] = useState<import("@/lib/bridge").CollaborationReceipt[]>([]);
  const [nativeActivity, setNativeActivity] = useState<{ scope: string; executions: ExecutionActivity[] }>({ scope: "", executions: [] });
  const activityScope = `${coworker.slug}:${threadId}`;
  const executions = nativeActivity.scope === activityScope ? nativeActivity.executions : EMPTY_EXECUTIONS;
  useEffect(() => {
    let disposed = false;
    let reading = false;
    const read = async () => {
      if (reading) return;
      reading = true;
      try {
        const executions = await waitForObservation(coworkerBridge.turns.activity(coworker.slug, threadId));
        if (!disposed) {
          setNativeActivity({ scope: activityScope, executions });
          setReadErrors((current) => current.activity ? { ...current, activity: "" } : current);
        }
      } catch {
        // An unavailable activity read cannot erase already observed work.
        if (!disposed) {
          setNativeActivity((current) => ({ ...current, executions: current.executions.map((entry) => ({ ...entry, available: false })) }));
          setReadErrors((current) => ({ ...current, activity: "Activity could not be refreshed." }));
        }
      } finally { reading = false; }
    };
    void read();
    const timer = window.setInterval(() => void read(), PROGRESS_LIMITS.activityPollMs);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [activityScope, coworker.slug, threadId]);
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
  /** In Automatic mode, which lane and model this turn runs on when it is not the standard one ("quick reply on GPT-5 mini"); empty otherwise. */
  /** Re-derive the outcome every second while a turn is unresolved: "still working" and the retry count are live. */
  const [now, setNow] = useState(() => Date.now());
  const [providerRefreshNote, setProviderRefreshNote] = useState("");
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
    if (!viewMounted.current || !refreshScope.active) return;
    const generation = refreshGeneration.current;
    const observe = <T,>(name: string, read: () => Promise<T>, apply: (value: T) => void): Promise<void> => {
      const running = refreshReads.get(name);
      if (running) { running.again = () => { void observe(name, read, apply); }; return running.promise; }
      const revision = turnRevision.current;
      const request = waitForObservation(Promise.resolve().then(read)).then((value) => {
        if (refreshGeneration.current !== generation || turnRevision.current !== revision) return;
        apply(value);
        setReadErrors((current) => current[name] ? { ...current, [name]: "" } : current);
      }).catch(() => {
        if (refreshGeneration.current !== generation || turnRevision.current !== revision) return;
        setReadErrors((current) => ({ ...current, [name]: name === "transcript" ? "Conversation could not be refreshed. Shown messages are kept." : "Some activity could not be refreshed. Shown messages and queued work are kept." }));
      }).finally(() => {
        const entry = refreshReads.get(name);
        if (entry?.promise !== request) return;
        refreshReads.delete(name);
        if (generation === refreshGeneration.current) entry.again?.();
      });
      refreshReads.set(name, { promise: request });
      return request;
    };
    // Ancillary IPC reads never hold a healthy transcript behind their latency or failure.
    void observe("receipts", () => coworkerBridge.collaboration.receipts({ slug: coworker.slug, threadId }), setCollaborationReceipts);
    const knownTurns = turnStateRef.current;
    const writingTurns = turnWrites.current > 0;
    void observe("turns", () => loadThreadTurns(coworker.slug, threadId), (savedTurns) => {
      if (!writingTurns && turnWrites.current === 0 && !activeTurnRef.current && (!threadStop(stopScope) || knownTurns === EMPTY_THREAD_TURNS)) {
        turnStateRef.current = savedTurns;
        setTurnState(savedTurns);
        if (knownTurns === EMPTY_THREAD_TURNS) setRecovered(savedTurns.pending !== null);
      }
      setTurnsLoaded(true);
    });
    void observe("interactions", () => threads.listThreadInteractions(threadId), setPending);
    return observe("transcript", () => threads.client.getThreadSnapshot(threadId, { signal: AbortSignal.timeout(10_000) }), (snapshot) => {
      const transcript = toTranscript(snapshot);
      const nativeMessages = new Map(snapshot.messages.map((message) => [message.id, message]));
      for (const message of snapshot.messages) knownMessages.current.set(message.id, { role: message.role, parentId: message.parentId, ended: knownMessages.current.get(message.id)?.ended || message.completedAt !== null || message.error !== null });
      const lastUser = snapshot.messages.findLast((message) => message.role === "user");
      if (lastUser && (!observedTurn.current || (lastUser.createdAt ?? 0) >= observedTurnAt.current)) {
        observedTurn.current = lastUser.id;
        observedTurnAt.current = lastUser.createdAt ?? 0;
      }
      const target = activeTurnRef.current?.messageId ?? turnStateRef.current.pending?.messageId ?? observedTurn.current;
      if (streamTurn.current !== target) { streamTurn.current = target; setLiveStream(null); }
      setLiveStream((current) => {
        let next = current;
        for (const message of snapshot.messages) {
          if (message.role !== "assistant" || message.parentId !== target || retiredReplies.current.has(message.id)) continue;
          for (const part of message.parts) {
            if (part.type !== "text") continue;
            next = applyStreamEvent(next, { kind: "part", threadId, messageId: message.id, partId: part.id, type: "text", text: part.text ?? "", ended: message.completedAt !== null || message.error !== null, synthetic: part.synthetic, ignored: part.ignored }, threadId);
          }
        }
        return next;
      });
      const loadedTitle = transcript.title ?? "Work thread";
      titleLoadedRef.current = true;
      setTitle(titleDiscussionAfterFirstMessage(loadedTitle) ?? loadedTitle);
      // A read can report a stalled retry, but only the execution owner or an explicit Stop may cancel it.
      const status = transcript.status;
      const retryStatus = status.type === "retry" ? status : null;
      const stall = retryStatus ? stalledRetry(retryStatus) : null;
      if (stall && retryStatus && stallRef.current?.next !== retryStatus.next) {
        stallRef.current = { next: retryStatus.next, reason: stall };
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
          parts: (nativeMessages.get(message.id)?.parts ?? []).filter((part) => part.type === "text").map((part) => ({ messageId: message.id, partId: part.id, type: part.synthetic || part.ignored ? "hidden" : "text", text: part.synthetic || part.ignored ? "" : part.text ?? "", ended: message.completedAt !== null || message.error !== null })),
          createdAt: message.createdAt,
          completedAt: message.completedAt,
          error: message.error,
          model: message.model,
          usage: message.usage,
          toolCalls: message.toolCalls.map((call) => ({
            partId: call.partId,
            tool: call.name,
            status: call.status ?? "working",
            input: call.input,
            output: call.output,
            error: call.error,
            metadata: call.metadata,
            startedAt: call.startedAt,
            completedAt: call.completedAt,
          })),
        })),
      );
      setTranscriptLoaded(true);
    });
  }, [coworker.slug, refreshReads, refreshScope, stopScope, threads, threadId, titleDiscussionAfterFirstMessage]);

  useEffect(() => {
    if (kind !== "discussion" || !assignmentDraft) return;
    setAssignmentMode(true);
    setAssignmentText(assignmentDraft.text);
  }, [assignmentDraft, kind]);

  useEffect(() => {
    if (kind !== "discussion" || !discussionDraft || discussionDraft.id === transferredDraftId.current) return;
    setAssignmentMode(false);
    setReply(discussionDraft.text);
  }, [discussionDraft, kind]);

  useEffect(() => {
    viewMounted.current = true;
    refreshScope.active = true;
    const generation = ++refreshGeneration.current;
    const controller = new AbortController();
    let eventTimer: number | undefined;
    void refresh();
    const client = createOpencodeClient({ baseUrl: `${runtime.serverUrl}/workspace/${encodeURIComponent(coworker.workspaceId)}/opencode`, headers: { Authorization: `Bearer ${runtime.ownerToken}` }, redirect: "error" });
    void (async () => {
      try {
        const subscription = await client.event.subscribe(undefined, { signal: controller.signal });
        for await (const event of subscription.stream) {
          if (controller.signal.aborted) return;
          if (event.type === "message.updated") {
            const info = event.properties.info;
            if (info.sessionID !== threadId) continue;
            knownMessages.current.set(info.id, { role: info.role, parentId: info.role === "assistant" ? info.parentID : null, ended: knownMessages.current.get(info.id)?.ended || (info.role === "assistant" && (info.time.completed !== undefined || Boolean(info.error))) });
            if (info.role === "user" && info.time.created >= observedTurnAt.current) { observedTurn.current = info.id; observedTurnAt.current = info.time.created; }
          }
          if (event.type === "message.part.updated" || event.type === "message.part.delta") {
            const part = event.type === "message.part.updated" ? event.properties.part : event.properties;
            const target = activeTurnRef.current?.messageId ?? turnStateRef.current.pending?.messageId ?? observedTurn.current;
            const owner = knownMessages.current.get(part.messageID);
            if (part.sessionID !== threadId || !target || owner?.role !== "assistant" || owner.parentId !== target || retiredReplies.current.has(part.messageID)) continue;
            if (streamTurn.current !== target) { streamTurn.current = target; setLiveStream(null); }
            if (event.type === "message.part.updated") {
              const part = event.properties.part;
              if (part.type === "text") setLiveStream((current) => applyStreamEvent(current, { kind: "part", threadId, messageId: part.messageID, partId: part.id, type: part.type, text: part.text, ended: part.time?.end !== undefined, synthetic: part.synthetic, ignored: part.ignored }, threadId));
            } else if (event.properties.field === "text" && !owner.ended) {
              const part = event.properties;
              setLiveStream((current) => applyStreamEvent(current, { kind: "delta", threadId, messageId: part.messageID, partId: part.partID, delta: part.delta }, threadId));
            }
          }
          // Part updates coalesce; status and human decisions still refresh promptly.
          if (event.type.startsWith("message.")) {
            if (eventTimer === undefined) eventTimer = window.setTimeout(() => { eventTimer = undefined; void refresh(); }, 600);
          } else if (event.type.startsWith("session.") || event.type.startsWith("permission.") || event.type.startsWith("question.")) void refresh();
        }
      } catch { /* Snapshot polling remains the reconnect path. */ }
    })();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => {
      refreshScope.active = false;
      if (refreshGeneration.current === generation) refreshGeneration.current += 1;
      refreshReads.clear();
      controller.abort();
      window.clearTimeout(eventTimer);
      window.clearInterval(timer);
    };
  }, [coworker.workspaceId, refresh, refreshReads, refreshScope, runtime.ownerToken, runtime.serverUrl, threadId]);

  useEffect(() => {
    viewMounted.current = true;
    return () => {
      viewMounted.current = false;
      waitControllerRef.current?.abort();
      if (appRetryTimerRef.current !== null) window.clearTimeout(appRetryTimerRef.current);
    };
  }, []);

  /** Change the thread's turn record: the cache updates at once, the file follows through the main process. */
  const commitTurnState = useCallback((update: (state: ThreadTurnState) => ThreadTurnState): ThreadTurnState => {
    const previous = turnStateRef.current;
    const next = update(previous);
    // A completed observer must not release Next while cancellation is unresolved.
    if (previous.pending && !next.pending && threadStop(stopScope)) return previous;
    if (next === previous) return next;
    turnRevision.current += 1;
    turnStateRef.current = next;
    setTurnState(next);
    turnWrites.current += 1;
    void saveThreadTurns(coworker.slug, threadId, next, previous).catch((cause) => setError(`Could not keep this turn: ${cause instanceof Error ? cause.message : String(cause)}`)).finally(() => { turnWrites.current -= 1; });
    return next;
  }, [coworker.slug, stopScope, threadId]);

  const pendingTurn = turnState.pending;
  const engineRunning = engineStatus.type === "busy" || engineStatus.type === "retry";

  /**
   * Make a stop stick. The engine takes a moment to register a turn after
   * accepting the message, so one abort can land on nothing and the turn then
   * runs to its end. Keep aborting while the engine reports the turn running,
   * until the reply for this message has ended, for at most ten seconds.
   */
  const abortUntilQuiet = useCallback(async (messageId: string) => {
    const deadline = Date.now() + 10_000;
    const signal = AbortSignal.timeout(10_000);
    while (Date.now() < deadline) {
      const snapshot = await threads.client.getThreadSnapshot(threadId, { signal }).catch(() => null);
      if (!snapshot) return;
      const reply = snapshot.messages.filter((message) => message.role === "assistant" && message.parentId === messageId).at(-1);
      if (reply && (reply.error !== null || reply.completedAt !== null)) return;
      if (isRunning(snapshot.status)) await threads.client.abortThread(threadId, { signal }).catch(() => undefined);
      await new Promise<void>((resolveWait) => window.setTimeout(resolveWait, 300));
    }
  }, [threadId, threads]);

  // A second hand for the words that move: "still working" after the wait budget, the retry count.
  const wordsMove = (pendingTurn !== null && pendingTurn.stoppedAt === null && (engineRunning || activeTurn !== null)) || appRetry !== null;
  useEffect(() => {
    if (!wordsMove) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [wordsMove]);

  useEffect(() => {
    const pendingId = turnState.pending?.messageId;
    if (pendingId && liveStream?.type === "text" && liveStream.text.trim()) rememberFirstWords(window.localStorage, pendingId, Date.now());
  }, [liveStream, turnState.pending?.messageId]);

  /**
   * Run one turn to its end: send (or re-send) the message, follow the engine
   * until it replies, fails, is stopped, or is cut off, and record each step
   * in the thread's turn record so the outcome can be derived at any moment —
   * and after a reload. The wait budget is not a deadline: when it passes while
   * the engine is still busy, the wait simply continues and the conversation
   * says "still working". Only the engine going idle without a reply ends the
   * turn without one.
   */
  const submitTurn = useCallback(async (prompt: string, messageId: string, send: TurnSend, modelOverride?: HeadlessThreadModel, failedModels: readonly string[] = [], originalSelection?: TurnModelSelection) => {
    if (activeTurnRef.current || threadStop(stopScope) || (send.mode === "retry" && !send.byPerson && turnStateRef.current.pending?.stoppedAt != null)) { voiceRef.current?.abandonReply(send.voice ?? null); return; }
    let voiceIntent = send.voice ?? null;
    let voiceFollowup = false;
    let turnModel: HeadlessThreadModel | undefined = modelOverride;
    /** The model this turn actually ran on, so a failure can be attributed and, if it was the app's pick, replaced. */
    let turnModelId = modelOverride ? `${modelOverride.providerId}/${modelOverride.modelId}` : coworker.model;
    let selection = originalSelection;
    const attempt = send.mode === "retry" ? send.attempt : 0;
    let continued = false;
    /**
     * When a model the app chose by itself cannot answer, move to the next
     * choice and try the same message again once, telling the
     * person what happened. In Automatic mode every pick is the app's: a lane
     * pick that fails steps back towards the standard model, and only the
     * standard model failing changes what is saved. A model the person chose
     * is never swapped.
     */
    const fallBack = async (message: string): Promise<boolean> => {
      if (!viewMounted.current || threadStop(stopScope) || turnStateRef.current.pending?.stoppedAt != null) return false;
      if (!selection?.allowFallback || failedModels.length >= 1) return false;
      if (!describeTurnFailure(message, coworker.name).modelRelated) return false;
      try {
        const { owner, defaults, automatic, lane, anchor } = selection;
        const excluded = [...failedModels, turnModelId];
        const catalog = await threads.listModelCatalog();
        if (threadStop(stopScope) || turnStateRef.current.pending?.stoppedAt != null) return false;
        const next = chooseFallbackModel(catalog, lane, { standard: anchor, exclude: excluded, ...(automatic ? { preferences: owner.modelSelectionPreferences } : {}) });
        const nextModel = next ? parseModelPreference(next.id) : undefined;
        if (!next || !nextModel) return false;
        const fallbackDecision = resolveDiscussionModel({ models: [next] }, { ...owner, model: next.id }, prompt, defaults);
        if (!fallbackDecision.model) return false;
        const variant = fallbackDecision.variant;
        markAutoPicked(coworker.slug, next.id);
        // In Automatic mode a lane model that failed is simply not chosen again this turn; the saved standard model changes only when it was the one that failed.
        if (!usesAppConversationDefault(owner) && (!automatic || turnModelId === owner.model || !owner.model)) {
          onCoworkerChanged(await coworkerBridge.coworkers.update(coworker.slug, { model: next.id, modelVariant: carryVariant(owner.modelVariant, next), modelChosenBy: "app", useAppModelDefaults: false }));
        }
        setProviderRefreshNote(`${turnModelId} could not answer, so ${coworker.name} is trying ${next.modelLabel} instead.`);
        voiceFollowup = true;
        window.setTimeout(() => void submitTurn(prompt, messageId, { mode: "retry", attempt, switchedTo: next.modelLabel, voice: voiceIntent }, { ...nextModel, ...(variant ? { variant } : {}) }, excluded, selection), 0);
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
      if (!viewMounted.current || threadStop(stopScope) || turnStateRef.current.pending?.stoppedAt != null) return false;
      if (classifyFailure(message, retryable) !== "transient") return false;
      const delay = retryDelayMs(attempt + 1);
      if (delay === null) return false;
      const nextAt = Date.now() + delay;
      voiceFollowup = true;
      setAppRetry({ attempt: attempt + 1, nextAt });
      appRetryTimerRef.current = window.setTimeout(() => {
        appRetryTimerRef.current = null;
        setAppRetry(null);
        // A deferred admission keeps the selected model's receipt. It does not
        // inherit permission to undo a later person-initiated cancellation.
        void submitTurn(prompt, messageId, { mode: "retry", attempt: attempt + 1, voice: voiceIntent, ...(send.mode === "retry" && send.switchedTo ? { switchedTo: send.switchedTo } : {}) }, turnModel, failedModels, selection);
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
    for (const [id, message] of knownMessages.current) {
      if (message.role === "assistant" && (message.parentId !== messageId || send.mode === "retry")) retiredReplies.current.add(id);
    }
    streamTurn.current = messageId;
    setLiveStream(null);
    setError("");
    if (send.mode !== "retry" || !send.switchedTo) setProviderRefreshNote("");
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
      // Cancelling an exhausted allowance can settle as an abort, an error, or
      // a timeout. Keep the reason we cancelled instead of the transport result.
      const stall = stallRef.current;
      if (stall && turnStateRef.current.pending?.stoppedAt === null) {
        setFailure(stall.reason);
        return;
      }
      // The execution owner may have stopped an exhausted allowance before a
      // screen poll saw its retry state. Keep that reason, not the abort it caused.
      const recorded = await coworkerBridge.turns.activity(coworker.slug, threadId).catch(() => []);
      const ownedFailure = recorded.find((entry) => entry.messageId === messageId)?.failure;
      if (ownedFailure) { message = ownedFailure; engineKnows = false; }
      const snapshot = await threads.client.getThreadSnapshot(threadId).catch(() => null);
      // Never schedule a replay after tool work, including after a provider failure.
      if (!snapshot || snapshot.messages.some((entry) => entry.parentId === messageId && entry.parts.some((part) => part.type === "tool"))) {
        setFailure(message);
        return;
      }
      if (await fallBack(message)) return;
      if (retryLater(message, retryable)) return;
      // The engine's own reply carries the words; only a failure it never saw needs remembering here.
      if (!engineKnows) setFailure(message);
    };
    try {
      if (!turnModel) {
        const selectionOwner = kind === "discussion" ? coworker : { ...coworker, useAppModelDefaults: false };
        const inherited = usesAppConversationDefault(selectionOwner);
        const [catalog, settings] = await Promise.all([threads.listModelCatalog(), coworkerBridge.settings.get()]);
        const modelDefaults = settings.modelDefaults;
        const automatic = inherited ? !modelDefaults.conversation.model : coworker.modelMode === "auto";
        const standardId = coworker.model || recommendModel(catalog)?.id || "";
        // One resolver serves this discussion and native group/review turns.
        const decision = resolveDiscussionModel(catalog, selectionOwner, prompt, modelDefaults);
        if (!decision.model) {
          // This is a selection-policy refusal, not a failed provider attempt.
          // Do not retry it through the model-failure fallback path.
          const unavailable = inherited ? modelDefaults.conversation.model : coworker.model;
          setFailure(unavailable && !catalog.models.some((model) => model.id === unavailable) ? describeUnavailableModel(unavailable, catalog.models, session) : decision.reason);
          return;
        }
        const pick = decision.model;
        turnModelId = pick.id;
        selection = { owner: selectionOwner, defaults: modelDefaults, automatic, allowFallback: automatic || (!inherited && wasAutoPicked(coworker, pick.id)), lane: decision.lane, anchor: standardId || pick.id };
        turnModel = { providerId: pick.providerId, modelId: pick.modelId, ...(decision.variant ? { variant: decision.variant } : {}) };
        if (automatic && pick.id !== standardId) {
          markAutoPicked(coworker.slug, pick.id);
          onActivityChange({ state: "working", label: "Working", detail: describeModelChoice(decision.lane, pick, { tense: "detail" }), updatedAt: Date.now(), threadId });
        }
      }
      // A re-send waits for the engine to let go of the earlier attempt (a stop is still settling, say).
      const acceptance = await coworkerBridge.turns.send({ slug: coworker.slug, threadId, kind, prompt, messageId, model: turnModel, retry: send.mode === "retry", retryByPerson: send.mode === "retry" && send.byPerson === true, retryLabel: send.mode === "retry" ? send.switchedTo : undefined });
      voiceIntent = voiceRef.current?.rebindExpected(voiceIntent, acceptance.messageId || messageId) ?? null;
      if (acceptance.messageId && acceptance.messageId !== messageId) {
        continued = true;
        messageId = acceptance.messageId;
        prompt = acceptance.prompt;
        commitTurnState((state) => beginPending(state, { messageId, prompt, startedAt: acceptance.acceptedAt }));
      }
      // Keep the selected retry model when admission is confirmed. Its receipt
      // is displayed only once the correlated reply actually completes.
      if (send.mode === "retry" && send.switchedTo) setResolution({ messageId, note: `${continued ? "Continued" : "Retried"} with ${send.switchedTo}` });
      const waiting: ActiveTurn = { messageId, prompt, phase: "waiting" };
      activeTurnRef.current = waiting;
      setActiveTurn(waiting);
      await refresh();
      // Stop pressed while the message was still on its way: the engine had nothing to abort then.
      // Now that it has the turn, abort it as soon as it runs, until it lets go or the turn is over.
      if (turnStateRef.current.pending?.messageId === messageId && turnStateRef.current.pending.stoppedAt !== null) {
        await abortUntilQuiet(messageId);
      }

      const controller = new AbortController();
      waitControllerRef.current = controller;
      refreshTimer = window.setInterval(() => void refresh(), 600);
      let result = await threads.client.waitForThread(threadId, { timeoutMs: TURN_OBSERVER_SLICE_MS, pollIntervalMs: 500, since: acceptance, signal: controller.signal });
      // An observation slice ending is not the reply failing: while the engine
      // still owns the turn, keep watching. The separate clock above decides
      // when the conversation says "Still working".
      while (result.outcome === "timeout" && isRunning(result.snapshot.status)) {
        result = await threads.client.waitForThread(threadId, { timeoutMs: TURN_OBSERVER_SLICE_MS, pollIntervalMs: 500, since: acceptance, signal: controller.signal });
      }
      await refresh();
      // Keep the optimistic working state through the transcript commit. Without
      // this paint boundary, the header can briefly return to Ready before the
      // completed assistant message becomes visible.
      await new Promise<void>((resolvePaint) => {
        // Hidden or minimized windows may suspend animation frames. Settling a
        // turn and draining Next must still complete while the app is behind.
        const timer = window.setTimeout(resolvePaint, 150);
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
          window.clearTimeout(timer);
          resolvePaint();
        }));
      });

      // A stop or a budget that ran out after the reply had already landed changes nothing: the turn replied.
      const settledReplies = result.snapshot.messages.filter((message) => message.role === "assistant" && message.parentId === messageId);
      const lastReply = settledReplies.at(-1);
      // The observation deadline can pass just before its final snapshot records
      // a completed reply or provider error. Honor that snapshot instead of
      // treating a recoverable error (or an answer) as a silent timeout.
      const quiet = !isRunning(result.snapshot.status);
      const landed = result.outcome !== "settled" && quiet && lastReply?.error === null && lastReply.completedAt !== null;
      const terminalError = result.terminalError ?? (quiet ? lastReply?.error : null);
      const emptyReply = (result.outcome === "settled" || landed)
        && settledReplies.length > 0
        && settledReplies.every((message) => message.parts.every((part) => part.type !== "tool" && !(part.type === "text" && part.text?.trim())));
      if (emptyReply) {
        // The stream closed without a word: the person hears that the reply never came and can retry it.
        await settleFailure(EMPTY_REPLY_MESSAGE, false, true);
      } else if (result.outcome === "settled" || landed) {
        if (send.mode === "retry" && send.switchedTo) setResolution({ messageId, note: `${continued ? "Continued" : "Retried"} with ${send.switchedTo}` });
        commitTurnState((state) => state.pending?.messageId === messageId ? clearPending(state) : state);
      } else if (result.outcome === "failed" || (result.outcome === "timeout" && terminalError)) {
        // The same raw text the transcript's failure reads, so the retry decision sees the provider's own error type too.
        const terminal = terminalError ? failureText(terminalError) : "The model stopped before producing a response.";
        await settleFailure(terminal, terminalError?.retryable ?? null, Boolean(terminalError));
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
      const message = cause instanceof Error ? cause.message : String(cause);
      await settleFailure(message, null, false);
    } finally {
      if (!voiceIntent?.admitted && !voiceFollowup) voiceRef.current?.abandonReply(voiceIntent);
      if (refreshTimer !== undefined) window.clearInterval(refreshTimer);
      waitControllerRef.current = null;
      if (activeTurnRef.current?.messageId === messageId) {
        activeTurnRef.current = null;
        setActiveTurn(null);
      }
    }
  }, [abortUntilQuiet, commitTurnState, coworker.effortPreference, coworker.model, coworker.modelChosenBy, coworker.modelMode, coworker.modelSelectionPreferences, coworker.modelVariant, coworker.useAppModelDefaults, coworker.name, coworker.slug, defaultDiscussionTitle, kind, onActivityChange, onCoworkerChanged, refresh, resolution?.messageId, session, stopScope, threadId, threads, title, titleDiscussionAfterFirstMessage]);

  /**
   * After a quit or reload the engine may still be on the turn. Follow it to
   * its end the same way, without sending anything, so Next can drain after it.
   */
  const followTurn = useCallback(async (turn: { messageId: string; prompt: string }) => {
    if (activeTurnRef.current) return;
    const active: ActiveTurn = { messageId: turn.messageId, prompt: turn.prompt, phase: "waiting" };
    activeTurnRef.current = active;
    setActiveTurn(active);
    let refreshTimer: number | undefined;
    try {
      const controller = new AbortController();
      waitControllerRef.current = controller;
      refreshTimer = window.setInterval(() => void refresh(), 600);
      const since = { messageCountBefore: 0, messageId: turn.messageId };
      let result = await threads.client.waitForThread(threadId, { timeoutMs: TURN_OBSERVER_SLICE_MS, pollIntervalMs: 500, since, signal: controller.signal });
      while (result.outcome === "timeout" && isRunning(result.snapshot.status)) {
        result = await threads.client.waitForThread(threadId, { timeoutMs: TURN_OBSERVER_SLICE_MS, pollIntervalMs: 500, since, signal: controller.signal });
      }
      await refresh();
      if (result.outcome === "settled") commitTurnState((state) => state.pending?.messageId === turn.messageId ? clearPending(state) : state);
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
  const pendingReply = useMemo(() => pendingTurn ? replyStateFor(messages, pendingTurn.messageId) : NO_REPLY, [messages, pendingTurn?.messageId]);
  const needsModelFallback = failure !== "" || pendingReply.state === "error";
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

  /** The backend retries tool-free work or creates a new continuation after tool work. */
  const retryPending = useCallback(async (switched?: { model: HeadlessThreadModel; label: string }, requestedVoice?: VoiceExpectation | null) => {
    const requested = turnStateRef.current.pending;
    if (!requested) return;
    jumpToLatest();
    // Arm on the person's gesture, before waiting for a stopped attempt to release.
    const voiceIntent = requestedVoice === undefined ? voiceRef.current?.expectReply(requested.messageId) ?? null : requestedVoice;
    // A Retry pressed the moment after Stop waits for the stopped turn to let go rather than being lost.
    await untilTurnReleased();
    const turn = turnStateRef.current.pending;
    if (!turn || turn.messageId !== requested.messageId || (voiceIntent && voiceIntent.turnId !== turn.messageId)) { voiceRef.current?.abandonReply(voiceIntent); return; }
    void submitTurn(turn.prompt, turn.messageId, { mode: "retry", attempt: 0, byPerson: true, voice: voiceIntent, ...(switched ? { switchedTo: switched.label } : {}) }, switched?.model);
  }, [jumpToLatest, submitTurn, untilTurnReleased]);

  /** Switch this coworker to the recommended model and retry the failed message. */
  async function useRecommendedModel() {
    const pick = recommendedModel;
    if (!pick) return;
    const model = parseModelPreference(pick.id);
    if (!model) return;
    // The person's thinking effort stays when the new model offers it; the retry runs with it too.
    const modelVariant = carryVariant(coworker.modelVariant, pick);
    const voiceIntent = voice.expectReply(turnStateRef.current.pending?.messageId ?? null);
    try {
      onCoworkerChanged(await coworkerBridge.coworkers.update(coworker.slug, { model: pick.id, modelVariant, modelChosenBy: "person" }));
    } catch (cause) {
      voice.abandonReply(voiceIntent);
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    void retryPending({ model: { ...model, ...(modelVariant ? { variant: modelVariant } : {}) }, label: pick.modelLabel }, voiceIntent);
  }

  useEffect(() => {
    if (!initialTurn || handledInitialTurnRef.current === initialTurn.id) return;
    handledInitialTurnRef.current = initialTurn.id;
    jumpToLatest();
    voice.stop("");
    void submitTurn(initialTurn.prompt, initialTurn.messageId, { mode: "send" })
      .finally(() => onInitialTurnHandled(initialTurn.id));
  }, [initialTurn, jumpToLatest, onInitialTurnHandled, submitTurn]);

  /** Send what is next in line, one at a time, once nothing is in flight and nothing unresolved holds the queue. */
  const drainNext = useCallback(() => {
    if (backendOwnsTurns()) return;
    if (activeTurnRef.current || turnStateRef.current.pending || threadStop(stopScope)) return;
    const { state, message } = dequeue(turnStateRef.current);
    if (!message) return;
    commitTurnState(() => state);
    void submitTurn(message.text, newMessageId(), { mode: "send" });
  }, [commitTurnState, stopScope, submitTurn]);

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
    sendText(text);
  }

  /** Words that become the person's next message without passing through the field: a pill the person tapped. */
  const sendText = useCallback((words: string) => {
    const text = words.trim();
    if (!text) return;
    jumpToLatest();
    acknowledgeCoworker(coworker.slug);
    if (activeTurnRef.current || turnStateRef.current.pending || appRetry || engineRunning || threadStop(stopScope)) {
      voiceRef.current?.expectReply(null);
      commitTurnState((state) => enqueue(state, { id: newQueuedId(), text, queuedAt: Date.now() }));
      return;
    }
    const messageId = newMessageId();
    const voiceIntent = voiceRef.current?.expectReply(messageId);
    void submitTurn(text, messageId, { mode: "send", voice: voiceIntent });
  }, [appRetry, commitTurnState, coworker.slug, engineRunning, jumpToLatest, stopScope, submitTurn]);

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
    if (threadStop(stopScope)) return;
    const message = turnStateRef.current.next.find((item) => item.id === id);
    if (!message) return;
    jumpToLatest();
    voice.stop("");
    if (activeTurnRef.current || appRetry || engineRunning) {
      if (!await stop()) return;
      await untilTurnReleased();
    }
    if (!viewMounted.current || threadStop(stopScope) || !turnStateRef.current.next.some((item) => item.id === id)) return;
    // The stopped turn keeps its line in the transcript; the record moves on to this message.
    commitTurnState((state) => clearPending(removeQueued(state, id)));
    void submitTurn(message.text, newMessageId(), { mode: "send" });
  }

  /**
   * Recovery without leaving the conversation: re-read the account's
   * providers, then retry the same message id if the saved model came back.
   */
  async function refreshProvidersAndRetry() {
    const voiceIntent = voice.expectReply(turnStateRef.current.pending?.messageId ?? null);
    setProviderRefreshNote("Refreshing your OpenWork providers…");
    try {
      const run = await onSyncProviders();
      if (run.status === "failed") {
        voice.abandonReply(voiceIntent);
        setProviderRefreshNote(`OpenWork provider refresh failed: ${run.message || "unknown error"}`);
        return;
      }
      const catalog = await threads.listModelCatalog();
      const available = !coworker.model.trim() || catalog.models.some((model) => model.id === coworker.model);
      if (!available) {
        voice.abandonReply(voiceIntent);
        setProviderRefreshNote(`Providers refreshed, but "${coworker.model}" is still unavailable. Choose another AI model in Coworker settings.`);
        return;
      }
      setProviderRefreshNote("");
      void retryPending(undefined, voiceIntent);
    } catch (cause) {
      voice.abandonReply(voiceIntent);
      setProviderRefreshNote(cause instanceof Error ? cause.message : String(cause));
    }
  }

  /** Stop: the engine's turn, an automatic attempt still waiting, or the wait — whichever is going. Next stays. */
  function stop(): Promise<boolean> {
    const messageId = threadStop(stopScope)?.messageId ?? turnStateRef.current.pending?.messageId ?? activeTurnRef.current?.messageId;
    return runThreadStop(stopScope, async () => {
      voice.stop("Audio stopped. Your text conversation is kept.");
      if (appRetryTimerRef.current !== null) {
        window.clearTimeout(appRetryTimerRef.current);
        appRetryTimerRef.current = null;
      }
      setAppRetry(null);
      // This is the durable cancellation intent/queue fence, not confirmation.
      commitTurnState((state) => state.pending?.messageId === messageId ? markStopped(state, Date.now()) : state);
      waitControllerRef.current?.abort();
      if (!messageId) throw new Error("The current message could not be identified. Refresh this conversation before trying Stop again.");
      const cancelled = await waitForObservation(coworkerBridge.turns.cancel(coworker.slug, threadId, messageId));
      if (!cancelled.ok) throw new Error("Cancellation was not confirmed. Try Stop again before continuing.");
      await threads.client.abortThread(threadId, { signal: AbortSignal.timeout(10_000) });
      // The message may still be on its way to the engine's run; keep the stop in force until the turn has ended.
      if (activeTurnRef.current?.phase !== "accepting") await abortUntilQuiet(messageId);
      await untilTurnReleased();
      if (activeTurnRef.current) throw new Error("The pending send has not finished stopping. Try Stop again before continuing.");
      const result = await threads.client.waitUntilIdle(threadId, { timeoutMs: 10_000, pollIntervalMs: 300, signal: AbortSignal.timeout(10_000) });
      if (result.outcome !== "settled" || isRunning(result.snapshot.status)) throw new Error("The conversation is still stopping. Try Stop again before continuing.");
      await refresh();
    }, messageId);
  }

  /** Let a cut-off turn go: nothing is sent again, and whatever waited as Next moves on. */
  function discardPending() {
    setFailure("");
    commitTurnState(clearPending);
  }

  function chooseTurnAction(choice: TurnChoice) {
    if (threadStop(stopScope) && choice.id !== "stop") return;
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
      case "connect-provider":
        onOpenProviders();
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
      setAssignmentText((current) => current === assignmentText ? "" : current);
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
  const rawOutcome = deriveTurnOutcome({
    coworkerName: coworker.name,
    now,
    turn: pendingTurn ? { ...pendingTurn, recovered } : null,
    engine: engineStatus,
    reply: pendingReply,
    needsYou,
    failure,
    appRetry,
    attemptActive: activeTurn !== null,
    waitBudgetMs: WAIT_BUDGET_MS,
    signedIn: session !== null,
    recommendedModel: recommendedModel?.modelLabel ?? "",
  });
  const needsContinuation = pendingTurn && messages.some((message) => message.parentId === pendingTurn.messageId && message.toolCalls.length > 0);
  const outcome = stopAttempt ? null : rawOutcome && needsContinuation && ["failed", "stopped-by-you", "cut-off"].includes(rawOutcome.kind)
    ? { ...rawOutcome, detail: "Earlier actions and their history are kept. Continue performs only missing work, using a new message in this discussion.", choices: rawOutcome.choices.map((choice): TurnChoice => choice.id === "retry" || choice.id === "continue" ? { ...choice, id: "continue", label: "Continue" } : choice) }
    : rawOutcome;
  // A reply that landed while this view was not driving the turn (after a reload) settles the record.
  useEffect(() => {
    if (outcome?.kind === "replied" && !activeTurnRef.current) commitTurnState(clearPending);
  }, [commitTurnState, outcome?.kind]);

  const turnRunning = outcome?.kind === "working" || outcome?.kind === "slow" || outcome?.kind === "retrying";
  // The engine can be busy on a turn this view never sent (a Worker's review, a scheduled run): still working.
  const working = !stopAttempt && (turnRunning || (outcome === null && !needsYou && engineRunning) || (activeTurn !== null && outcome === null));
  const voiceSettled = !stopAttempt && engineStatus.type === "idle" && !activeTurn && !appRetry && !working && !needsYou && !error && !Object.values(readErrors).some(Boolean);
  const voiceReply = useMemo(() => privateVoiceReply(messages, voiceSettled && !failure && (!outcome || outcome.kind === "replied")), [messages, voiceSettled, failure, outcome?.kind]);
  const voice = useVoice({
    active: active && kind === "discussion" && !assignmentMode && !assignmentBusy,
    scope: `${coworker.slug}:${threadId}`,
    onTranscript: (text) => setReply((draft) => appendVoiceDraft(draft, text)),
    reply: voiceReply,
    endedTurn: voiceSettled ? outcome?.messageId ?? messages.findLast((message) => message.role === "user")?.id : null,
    activation: preparedVoice?.activation,
    onActivationHandled: () => { setReply(reply); onVoicePreparedHandled?.(); },
  });
  voiceRef.current = voice;
  const executionsByMessage = useMemo(() => new Map(executions.map((entry) => [entry.messageId, entry])), [executions]);
  const timedMessages = useMemo(() => messages.map((message) => {
    const execution = message.parentId ? executionsByMessage.get(message.parentId) : undefined;
    if (!execution || !message.toolCalls.length) return message;
    const timings = new Map(execution.tools.map((tool) => [tool.partId, tool]));
    return { ...message, toolCalls: message.toolCalls.map((call) => {
      const timing = timings.get(call.partId);
      return timing ? { ...call, startedAt: timing.startedAt, completedAt: timing.completedAt } : call;
    }) };
  }), [messages, executionsByMessage]);
  const visibleMessages = useMemo(() => {
    const visible = [...timedMessages];
    const ids = new Set(visible.map((message) => message.id));
    if (pendingTurn && !ids.has(pendingTurn.messageId)) visible.push(optimisticMessage(pendingTurn));
    // A new assistant message can stream before the first snapshot carries it.
    for (const part of liveStream?.parts ?? []) {
      if (part.type !== "text" || ids.has(part.messageId)) continue;
      ids.add(part.messageId);
      visible.push({ ...optimisticMessage({ messageId: part.messageId, prompt: "" }), role: "assistant", parentId: streamTurn.current });
    }
    return visible;
  }, [timedMessages, pendingTurn, liveStream]);
  const messagePositions = useMemo(() => new Map(visibleMessages.map((message, index) => [message.id, index])), [visibleMessages]);
  const lastAssistantIndex = visibleMessages.findLastIndex((message) => message.role === "assistant");
  /** A team tile's pills stay open only until the person writes again. */
  const lastPersonIndex = visibleMessages.findLastIndex((message) => message.role === "user");
  const currentMessageId = activeTurn?.messageId ?? pendingTurn?.messageId ?? executions.find((entry) => entry.state === "running")?.messageId ?? visibleMessages.findLast((message) => message.role === "user")?.id;
  const currentExecution = currentMessageId ? executionsByMessage.get(currentMessageId) : undefined;
  const currentReplies = useMemo(() => visibleMessages.filter((message) => message.role === "assistant" && message.parentId === currentMessageId), [visibleMessages, currentMessageId]);
  const activeReply = currentReplies.at(-1) ?? null;
  const activeCall = currentReplies.flatMap((message) => message.toolCalls).findLast((call) => ["running", "pending"].includes(executionState(call.status)))
    ?? currentExecution?.tools.findLast((call) => ["running", "pending"].includes(executionState(call.status))) ?? null;
  const activeToolLabel = activeCall ? EXECUTION_KINDS[executionMetadata(activeCall).kind] : null;
  const activeStep = activeToolLabel ? { doing: activeToolLabel } : null;
  const correlatedStream = streamTurn.current === currentMessageId ? liveStream : null;
  const currentWords = useMemo(() => writingText(correlatedStream, activeReply), [correlatedStream, activeReply]);
  const streamingMessageIds = useMemo(() => new Set(correlatedStream?.parts.filter((part) => part.type === "text").map((part) => part.messageId)), [correlatedStream]);
  const blocks = useMemo(() => conversationBlocks(visibleMessages, (message, index) => working && message.role === "assistant" && (index === lastAssistantIndex || streamingMessageIds.has(message.id))), [visibleMessages, working, lastAssistantIndex, streamingMessageIds]);
  // What the coworker is doing this moment comes from what is streaming, not from a label:
  // a reasoning part is thinking, a text part is writing, an unsettled tool call is a tool.
  const phase: LivePhase = livePhase({
    label: activeTurn?.phase === "accepting" ? "Sending" : outcome?.kind === "retrying" ? "Retrying" : "",
    stream: working ? correlatedStream : null,
    activeStep,
    landedWords: working ? currentWords : "",
  });
  const workingLabel = outcome?.kind === "slow" ? "Still working" : phaseWord(phase);
  /** Words of the reply have arrived this turn — streaming now, or landed by an earlier step of the same turn. */
  const wordsArrived = Boolean(currentWords) || phase === "writing"
    || currentReplies.some((message) => message.text.trim() !== "");
  const progress: ProgressObservation = currentExecution ? {
    ...executionProgress(currentExecution, wordsArrived && phase === "writing"),
    ...(phase === "retrying" ? { status: "retrying" } : {}),
  } : {
    executionId: `${activityScope}:${currentMessageId ?? "unobserved"}`,
    status: !currentMessageId ? "unknown" : phase === "thinking" ? "preparing" : phase === "writing" ? "streaming" : phase,
    startedAt: pendingTurn?.startedAt ?? visibleMessages.find((message) => message.id === currentMessageId)?.createdAt ?? null,
    tool: activeCall,
    completedSteps: currentReplies.flatMap((reply) => reply.toolCalls).filter((call) => executionState(call.status) === "completed").length,
    failedSteps: currentReplies.flatMap((reply) => reply.toolCalls).filter((call) => executionState(call.status) === "failed").length,
  };

  const readableStatus = stopAttempt ? stopPending ? "Stopping..." : "Stop not confirmed" : !transcriptLoaded ? "Loading conversation" : outcome && outcome.kind !== "working" && outcome.kind !== "replied"
    ? outcome.label
    : working
      ? workingLabel
      : "Ready";
  const settledWord = outcome?.kind === "stopped-by-you" || outcome?.kind === "cut-off";
  const failed = outcome?.kind === "failed";

  useEffect(() => {
    if (stopAttempt) {
      onActivityChange({ state: stopPending ? "working" : "attention", label: stopPending ? "Stopping..." : "Stop not confirmed", detail: "Stopping work in this conversation", summary: stopPending ? "Stopping..." : "Stop not confirmed. Try Stop again before continuing.", updatedAt: Date.now(), threadId });
      return;
    }
    if (!transcriptLoaded) return;
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
      onActivityChange({ state: "retrying", label: outcome.label, detail: subject, summary: retrySummary(outcome.retry?.reason ?? null), updatedAt: Date.now(), threadId });
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
  }, [activeToolLabel, kind, needsYou, onActivityChange, outcome?.kind, outcome?.label, outcome?.line, pending, stopAttempt, stopPending, threadId, title, transcriptLoaded, working, workingLabel]);

  const currentDiscussion: ThreadListItem = discussions.find((item) => item.id === threadId)
    ?? { id: threadId, title, createdAt: 0, updatedAt: 0, status: "idle" };
  const freshDiscussion = transcriptLoaded && turnsLoaded && kind === "discussion" && visibleMessages.length === 0 && !working && !needsYou && !error && !outcome;
  const composerWorking = Boolean(stopAttempt) || turnRunning || activeTurn !== null || (engineRunning && !needsYou);
  const [controlStatusSlot, setControlStatusSlot] = useState<HTMLDivElement | null>(null);
  const [floatingSlot, setFloatingSlot] = useState<HTMLDivElement | null>(null);
  const [computerOpenRequest, setComputerOpenRequest] = useState(0);
  const [browserOpenRequest, setBrowserOpenRequest] = useState(0);

  return (
    <section className="flex h-full min-h-0 flex-col bg-ink" data-active={active} data-testid={kind === "discussion" ? "coworker-discussion-view" : kind === "worker" ? "coworker-worker-view" : "coworker-assignment-view"}>
      {/* The one header above carries the coworker; the view places its title line and actions there. */}
      <HeaderContent
        slots={headerSlots}
        title={kind === "discussion" ? (
          <DiscussionSwitcher
            current={{ ...currentDiscussion, title: transcriptLoaded ? title : "Loading conversation" }}
            currentUsed={visibleMessages.length > 0}
            discussions={discussions}
            defaultTitle={defaultDiscussionTitle}
            onOpen={(id) => onOpenDiscussion?.(id)}
            onNew={onNewDiscussion}
          />
        ) : (
          <>
             <span className="min-w-0 whitespace-normal [overflow-wrap:anywhere]">{kind === "worker" ? workerNameFromTitle(title) : title}</span>
            <span className="shrink-0 rounded-full border border-spark/20 bg-spark/8 px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-[0.08em] text-spark">{kind === "worker" ? "Worker" : "Assignment"}</span>
          </>
        )}
        actions={(
          <>
            {kind !== "discussion" ? <Button variant="ghost" onClick={onBack}>Back</Button> : null}
            {kind !== "worker" ? (
              <Button variant="ghost" disabled={!active || stopPending || (!working && !needsYou && !stopAttempt)} title={working || needsYou || stopAttempt ? "Stop work in this conversation" : "No active work to stop"} data-testid="coworker-stop" onClick={() => void stop()}>{stopLabel}</Button>
            ) : null}
          </>
        )}
      />
      {active && kind === "discussion" && browserEligible && headerSlots.tools ? createPortal(<Suspense fallback={null}><ComputerControl key={`${coworker.slug}:${threadId}`} slug={coworker.slug} threadId={threadId} statusSlot={controlStatusSlot} floatingSlot={floatingSlot} openRequest={computerOpenRequest} onOpenRequestHandled={() => setComputerOpenRequest(0)} onBackToConversation={() => voice.fieldRef.current?.focus()} /></Suspense>, headerSlots.tools) : null}
      {/* Progress and problems show inline in the conversation; this keeps the turn state readable to assistive tech and tests. */}
      <div className="@container/discussion min-h-0 min-w-0 flex-1">
      <div className="flex h-full min-h-0 min-w-0 flex-col @min-[760px]/discussion:flex-row">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="coworker-conversation-column">
      <p data-testid="coworker-thread-status" className="sr-only" aria-live="polite" data-state={stopAttempt ? stopPending ? "stopping" : "stop-unconfirmed" : needsYou ? "needs-you" : working ? "working" : "idle"} data-outcome={outcome?.kind ?? ""}>
        {transcriptLoaded && kind === "discussion" && !stopAttempt && !working && !needsYou && !failed && !settledWord ? "Ready" : readableStatus}
      </p>
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto px-5 py-5"
        style={{ overflowAnchor: "none" }}
      >
        <div ref={contentRef} className="mx-auto max-w-3xl space-y-3">
          {!transcriptLoaded && !readErrors.transcript ? <p role="status" className="text-xs text-mist">Loading conversation...</p> : null}
          {freshDiscussion ? <QuietEmptyConversation coworker={coworker} proposerName={team?.coworkers.find((member) => member.slug === coworker.suggestedBy?.slug)?.name ?? ""} /> : null}
          <TranscriptAppContext.Provider value={{ sessionId: threadId, engine: "v1", readOnly: !active || kind !== "discussion" }}>
          {blocks.map((block) => {
            const retriedWith = block.kind === "message" ? executionsByMessage.get(block.message.id)?.retryLabel : undefined;
            if (block.kind === "actions") {
               return <ActionLine key={block.id} review={block.review} calls={block.calls} client={mcpClient} />;
            }
            // A reply that ended without words stays in the transcript as one quiet line; the turn still
            // unresolved is told by the outcome below instead, with its actions.
            if (block.kind === "ended") {
              if (block.message.parentId === pendingTurn?.messageId) return null;
              return <QuietLine key={block.message.id} outcome={block.ended} text={block.ended === "stopped" ? "Stopped." : describeTurnFailure(block.message.error ? failureText(block.message.error) : "", coworker.name).headline} />;
            }
            return (
              <div key={block.message.id} data-scroll-anchor={block.message.id}>
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
                  team={kind === "discussion" ? team : undefined}
                  laterPersonMessage={(messagePositions.get(block.message.id) ?? -1) < lastPersonIndex}
                  conversation={visibleMessages}
                  onSendReply={sendText}
                  onLongReply={block.message.id === visibleMessages[lastAssistantIndex]?.id ? recordLongReply : undefined}
                  liveStream={block.message.role === "assistant" && block.message.parentId === currentMessageId ? correlatedStream : null}
                  sentAt={block.message.parentId ? visibleMessages[messagePositions.get(block.message.parentId) ?? -1]?.createdAt ?? null : null}
                />
                {retriedWith ? <QuietLine outcome="retried" text={`Retried with ${safeWorkLabel(retriedWith, "the selected model")}`} /> : resolution && block.message.id === resolution.messageId && replyStateFor(visibleMessages, resolution.messageId).state === "complete" ? <QuietLine outcome="retried" text={resolution.note} /> : null}
              </div>
            );
          })}
          </TranscriptAppContext.Provider>
          <CollaborationReceipts receipts={collaborationReceipts} />
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
            <WorkerDecisionCards coworker={coworker} threadId={threadId} workers={workers} onAnswered={() => onWorkersChanged?.()} />
          ) : null}
          <LiveRowSlot open={working && outcome?.kind !== "retrying" && !["completed", "failed", "cancelled"].includes(progress.status)}>
            {phase === "writing" && !activeReply ? (
              // The words are arriving: the bubble is the live view. It renders in the transcript
              // once the engine has the reply; until then the words stand in here, in the same shape.
              <article className="flex flex-col items-start" data-message-role="assistant" data-live="true">
                 <div className="bubble bubble-coworker max-w-[76%]" data-testid="coworker-live-bubble"><Markdown text={safeLiveMarkdown(writingText(correlatedStream, null))} /></div>
              </article>
            ) : null}
             <LiveRow
               key={progress.executionId}
               coworker={coworker}
               phase={phase}
               progress={progress}
               stream={correlatedStream}
               reply={activeReply ? { text: activeReply.text } : null}
              wordsArrived={wordsArrived}
              sentAt={pendingTurn?.startedAt ?? null}
              stillWorking={outcome?.kind === "slow" ? outcome.line : ""}
              onStop={outcome?.kind === "slow" ? () => void stop() : undefined}
            />
          </LiveRowSlot>
          {stopAttempt ? <div role="status" aria-live="polite" data-testid="coworker-stop-feedback">
            <QuietLine outcome={stopPending ? "stopping" : "stop-unconfirmed"} text={stopPending ? "Stopping..." : `Stop not confirmed. ${stopAttempt.error ?? "Try Stop again before continuing."}`} choices={stopPending ? [] : [{ id: "stop", label: "Retry stop" }]} onChoose={chooseTurnAction} />
          </div> : null}
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
          {Object.values(readErrors).some(Boolean) ? <p role="status" className="px-1 text-xs text-mist">{readErrors.transcript || "Some activity could not be refreshed. Shown messages and queued work are kept."} <button type="button" className="underline" onClick={() => void refresh()}>Try again</button></p> : null}
        </div>
      </div>
      {kind === "discussion" ? (
        <div ref={setFloatingSlot} className="pointer-events-none absolute inset-0 overflow-hidden" data-testid="coworker-browser-float-slot" />
      ) : null}
      {active && transcriptLoaded && away ? <JumpToLatest onClick={jumpToLatest} /> : null}
      </div>
      {kind !== "worker" && turnState.next.length > 0 ? (
        <NextRows items={turnState.next} onEdit={editQueued} onRemove={(id) => commitTurnState((state) => removeQueued(state, id))} onSendNow={(id) => void sendQueuedNow(id)} />
      ) : null}
      {kind === "discussion" && browserEligible ? <WorkersPanel coworker={coworker} threadId={threadId} compact onOpenComputer={() => setComputerOpenRequest((value) => value + 1)} onOpenBrowser={() => setBrowserOpenRequest((value) => value + 1)} /> : null}
      {kind === "discussion" ? (
        <div ref={setControlStatusSlot} className="shrink-0 space-y-2 px-5 pt-2 empty:hidden" data-testid="coworker-control-status" />
      ) : null}
      {kind === "discussion" ? (
        <DiscussionComposer
          voice={voice}
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
          stopPending={stopPending}
          stopLabel={stopLabel}
          onStop={() => void stop()}
          offerStartingPoints={freshDiscussion}
          coworkerName={coworker.name}
          summary={summary}
          onOpenSummary={onOpenSummary}
          effortStop={coworker.effortPreference}
          fixedVariant={coworker.modelVariant}
          onEffortChange={(stop) => void coworkerBridge.coworkers.update(coworker.slug, { effortPreference: stop }).then(onCoworkerChanged).catch(() => undefined)}
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
          stopPending={stopPending}
          stopLabel={stopLabel}
          onStop={() => void stop()}
          placeholder={`Follow up with ${coworker.name}…`}
          summary={summary}
          onOpenSummary={onOpenSummary}
        />
      )}
      </div>
      {kind === "discussion" && browserEligible ? <Suspense fallback={null}><DiscussionBrowser key={`${coworker.slug}:${threadId}`} active={active} slug={coworker.slug} threadId={threadId} actionsSlot={headerSlots.tools} statusSlot={controlStatusSlot} floatingSlot={floatingSlot} openRequest={browserOpenRequest} /></Suspense> : null}
      </div>
      </div>
    </section>
  );
}

type ConversationBlock =
  | { kind: "actions"; id: string; review: WorkerReview | null; calls: TranscriptToolCall[] }
  | { kind: "message"; message: TranscriptMessage; previous: TranscriptMessage | undefined; active: boolean; continued: boolean; tail: boolean; calls: TranscriptToolCall[] }
  /** A reply that ended without words — stopped or failed — kept as one quiet line where it happened. */
  | { kind: "ended"; message: TranscriptMessage; ended: "stopped" | "failed" };

/** Safe conversation-scoped facts only; progress inspection is a separate surface. */
export function CollaborationReceipts({ receipts, canRetry, retryUnavailable }: { receipts: import("@/lib/bridge").CollaborationReceipt[]; canRetry?: (receipt: import("@/lib/bridge").CollaborationReceipt) => boolean; retryUnavailable?: ReactNode }) {
  const [error, setError] = useState("");
  const act = async (action: () => Promise<unknown>) => {
    setError("");
    try { await action(); } catch { setError("That request could not be completed. The existing work has been kept."); }
  };
  return <div className="space-y-2" data-testid="collaboration-receipts" aria-live="polite">
    {receipts.slice(-12).map((receipt) => <div key={receipt.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 text-[11px] text-mist [overflow-wrap:anywhere]" data-testid="collaboration-receipt" data-work-id={receipt.id} data-state={receipt.state}>
      <span>{receipt.state === "waiting" || receipt.state === "waiting-person" ? "Waiting for requested work" : receipt.state === "resumption-queued" ? "Results ready; follow-up queued" : receipt.state === "resuming" ? "Following up on the results" : receipt.state === "succeeded" ? "Follow-up completed" : receipt.state === "cancelled" ? "Collaboration stopped" : receipt.state === "running" ? "Requested work is running" : "Collaboration needs attention"}</span>
      {receipt.dependencies.slice(0, 3).map((dependency) => {
        const name = safeWorkLabel(dependency.label, dependency.kind === "worker" ? "Worker" : "Coworker");
        const label = `${name}: ${dependency.state === "succeeded" ? "received" : dependency.state === "failed" ? "failed" : dependency.state === "cancelled" ? "cancelled" : dependency.state === "waiting-person" ? "needs your input" : "pending"}`;
        return dependency.groupId ? <button key={dependency.id} type="button" className="underline underline-offset-2" onClick={() => window.dispatchEvent(new CustomEvent("coworker:open-group", { detail: dependency.groupId }))}>{label}</button> : <span key={dependency.id}>{label}</span>;
      })}
      {!["succeeded", "failed", "cancelled"].includes(receipt.state) ? <button type="button" className="underline underline-offset-2" title="Stop this task, its delegated work, and its automatic follow-up" onClick={() => void act(() => coworkerBridge.collaboration.cancel(receipt.id))}>Stop task</button> : null}
      {receipt.state === "failed" ? canRetry?.(receipt) === false ? retryUnavailable : <button type="button" className="underline underline-offset-2" onClick={() => void act(() => coworkerBridge.collaboration.retry(receipt.id))}>Continue with available results</button> : null}
    </div>)}
    {error ? <p role="alert" className="text-xs text-mist">{error}</p> : null}
  </div>;
}

/** The app's own turn that wakes the coworker with its Workers' updates; never a bubble from the person. */
function reviewTurn(message: TranscriptMessage): WorkerReview | null {
  return message.role === "user" ? parseWorkerReview(message.text) : null;
}

/**
 * Lay a transcript out as bubbles with observed actions gathered into one
 * small line between them. Consecutive replies that only did work (no words) fold into the
 * line before the next bubble, so two action lines never sit one after the other. A reply
 * carries no reasoning into this projection. The turn that
 * hands the coworker its Workers' updates joins the same line as what it then did about them.
 */
export function conversationBlocks(
  messages: readonly TranscriptMessage[],
  isActive: (message: TranscriptMessage, index: number) => boolean,
): ConversationBlock[] {
  const blocks: ConversationBlock[] = [];
  let review: WorkerReview | null = null;
  let calls: TranscriptToolCall[] = [];
  let pendingId = "";
  const flush = () => {
    if (review || calls.length > 0) blocks.push({ kind: "actions", id: `actions-${pendingId}`, review, calls });
    review = null;
    calls = [];
  };
  // Bubbles decide grouping: a reply with no visible words never counts as a neighbour, nor does a review turn.
  const continuation = (message: TranscriptMessage) => message.role === "user" && (message.text.startsWith("Continue the original task using these requested results.") || message.text.startsWith("Continue the earlier private request."));
  const bubbles = messages.filter((message, index) =>
    message.role === "assistant" ? Boolean(message.text) || isActive(message, index) : !reviewTurn(message) && !continuation(message),
  );
  const bubblePositions = new Map(bubbles.map((message, index) => [message.id, index]));
  const lastReplies = new Map<string, number>();
  messages.forEach((message, index) => { if (message.role === "assistant" && message.parentId) lastReplies.set(message.parentId, index); });
  messages.forEach((message, index) => {
    if (continuation(message)) return;
    const active = isActive(message, index);
    const reviewed = reviewTurn(message);
    if (reviewed) {
      if (!pendingId) pendingId = message.id;
      review = review ? { updates: [...review.updates, ...reviewed.updates] } : reviewed;
      return;
    }
    if (message.role === "assistant") {
      if (!pendingId) pendingId = message.id;
      calls.push(...message.toolCalls);
      const superseded = message.parentId !== null && lastReplies.get(message.parentId) !== index;
      const ended = active || superseded ? null : endedWithoutWords(message);
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
    const position = bubblePositions.get(message.id) ?? -1;
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

/** One small centered line between bubbles: observed work and Worker reports. */
const ActionLine = memo(function ActionLine({ review, calls, client }: { review: WorkerReview | null; calls: TranscriptToolCall[]; client: CoworkerMcpClient }) {
  return (
    <div className="flex justify-center py-0.5" data-testid="coworker-action-line">
      <div className="flex max-w-[80%] flex-wrap items-start justify-center gap-x-4 gap-y-1">
        {review ? <ReviewDisclosure review={review} /> : null}
        {calls.length > 0 ? <WorkReceipt calls={calls} client={client} /> : null}
      </div>
    </div>
  );
});

const REVIEW_KIND_WORDS = { finding: "reported", decision: "needs a decision", done: "finished", failed: "didn't finish" } as const;

/** "Reviewed 2 updates from Workers", opening into what each Worker said. */
function ReviewDisclosure({ review }: { review: WorkerReview }) {
  return (
    <PopoverDisclosure label={describeReview(review)} title="What the Workers reported" testId="coworker-worker-review" className="text-[11px] text-mist">
      <ul className="space-y-1.5">
        {review.updates.map((update, index) => (
          <li key={index} className="whitespace-pre-wrap">
            <span className="font-semibold text-snow/80">{update.worker}</span> {REVIEW_KIND_WORDS[update.kind]}: {update.text}
          </li>
        ))}
      </ul>
    </PopoverDisclosure>
  );
}

/** A quiet centered time label above a message, shown only when enough time has passed. */
function TimeLabel({ label }: { label: string | null }) {
  if (!label) return null;
  return <p className="pb-1 pt-2 text-center text-[11px] font-medium text-mist/80" data-testid="coworker-time-label">{label}</p>;
}

const MessageBubble = memo(function MessageBubble({
  message,
  coworker,
  mcpClient,
  active,
  continued = false,
  tail = true,
  kind = "discussion",
  turnCalls = [],
  documents,
  team,
  laterPersonMessage = false,
  conversation = [],
  onSendReply,
  onLongReply,
  liveStream = null,
  sentAt = null,
}: {
  message: TranscriptMessage;
  coworker: CoworkerSummary;
  mcpClient: CoworkerMcpClient;
  active: boolean;
  /** The words of this reply as they arrive, while it is the one being written; the bubble shows them before they land. */
  liveStream?: LiveStream | null;
  /** When the person sent the message this reply answers, for the speed line in the tooltip. */
  sentAt?: number | null;
  /** The next message is from someone else (or this is the last one): the bubble gets its tail. */
  tail?: boolean;
  /** The previous message is from the same speaker: no avatar or name again, tighter spacing. */
  continued?: boolean;
  /** Every tool call of this reply's turn: the bubble ends with a card per document it wrote, and knows whether a long reply had one behind it. */
  turnCalls?: TranscriptToolCall[];
  documents?: DocumentHooks;
  /** The team tiles a reply ends with (a proposed teammate, an offer to pass the request on) and how the person answers them. */
  team?: TeamHooks;
  /** The person wrote again after this reply: a tile's pills are closed. */
  laterPersonMessage?: boolean;
  /** The visible conversation, for the brief a hand-over carries. */
  conversation?: ReadonlyArray<{ role: string; text: string }>;
  /** Send words as the person's next message (a pill the person tapped). */
  onSendReply?: (text: string) => void;
  /** A finished reply ran long with no document behind it; reported once so the coworker is reminded next turn. */
  onLongReply?: (messageId: string, chars: number) => void;
  kind?: "discussion" | "assignment" | "worker";
}) {
  const user = message.role === "user";
  // How fast a reply came, for its tooltip only: from Send to the first words on screen and to the
  // close. Read once per landed reply, not on every render.
  const speed = useMemo(() => {
    if (user || active || !message.completedAt) return "";
    return describeSpeed({
      sentAt,
      firstWordsAt: message.parentId ? firstWordsFor(window.localStorage, message.parentId) : null,
      completedAt: message.completedAt,
      reasoningTokens: message.usage?.reasoningTokens ?? null,
    });
  }, [active, message.completedAt, message.parentId, message.usage?.reasoningTokens, sentAt, user]);
  if (user) {
    // A request a teammate passed on carries a brief for the model; the person sees their own
    // words as their bubble, with one small line saying where it came from.
    const passed = kind === "discussion" ? parseReferralBrief(message.text) : null;
    if (passed) {
      return (
        <article className={`flex flex-col items-end ${continued ? "-mt-1.5" : ""}`} data-message-role="user" data-passed-from={passed.from}>
          <p className="mb-0.5 pr-1 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-mist/80" data-testid="coworker-passed-from">Passed from {passed.from}</p>
          <div className={`bubble bubble-user max-w-[72%] whitespace-pre-wrap ${tail ? "bubble-tail-right" : ""}`} title={message.createdAt ? new Date(message.createdAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : undefined}>
            {passed.message}
          </div>
        </article>
      );
    }
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
              <PopoverDisclosure
                label={`From your discussion · ${brief.context.length} message${brief.context.length === 1 ? "" : "s"}`}
                title="From your discussion"
                testId="coworker-assignment-context"
                className="mt-2 text-xs text-white/80"
              >
                <ol className="space-y-1.5">
                  {brief.context.map((entry, index) => (
                    <li key={index} className="whitespace-pre-wrap">
                      <span className="font-semibold text-snow/80">{entry.speaker === "you" ? "You" : coworker.name}:</span> {entry.text}
                    </li>
                  ))}
                </ol>
              </PopoverDisclosure>
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
  // (see conversationBlocks), never inside or stacked. A team tile (a proposed teammate, an
  // offer to pass the request on) follows the bubble as its own rounded tile, like a shared contact.
  const teamCards = team ? teamCardsFromCalls(turnCalls) : [];
  // While this reply is being written, its words come from the stream before they land: the
  // bubble is the live view, in the same place and shape it keeps once the text has landed.
  const liveWords = liveStream ? writingText(liveStream, message) : message.text;
  const live = liveWords !== message.text;
  const answeredBy = message.model ? `Answered by ${message.model.providerId}/${message.model.modelId}` : "";
  const tooltip = [answeredBy, speed].filter(Boolean).join(" · ");
  return (
    <article className={`flex flex-col items-start gap-2 ${continued ? "-mt-1" : ""}`} data-message-role="assistant" data-continued={continued ? "true" : "false"} {...(live ? { "data-live": "true" } : {})}>
      <p className="sr-only">
        {coworker.name}
        {message.model ? (
          <span data-testid="coworker-reply-model">
            {" "}{answeredBy}
          </span>
        ) : null}
        {speed ? <span data-testid="coworker-reply-speed">{" "}{speed}</span> : null}
      </p>
      {live ? (
        <div className="bubble bubble-coworker max-w-[76%]" data-testid="coworker-live-bubble">
          <Markdown text={safeLiveMarkdown(liveWords)} />
        </div>
      ) : message.text ? (
        <div
          className={`bubble bubble-coworker max-w-[76%] ${tail && (active || teamCards.length === 0) ? "bubble-tail-left" : ""}`}
          title={tooltip || undefined}
          data-testid="coworker-reply-bubble"
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
      ) : !active && message.toolCalls.length === 0 && teamCards.length === 0 ? (
        <div className={`bubble bubble-coworker ${tail ? "bubble-tail-left" : ""} text-mist`}>…</div>
      ) : null}
      {team && teamCards.length > 0 && !active ? (
        <TeamCardsForTurn
          cards={teamCards}
          coworker={coworker}
          team={team}
          laterPersonMessage={laterPersonMessage}
          recent={conversation.map((entry) => ({ role: entry.role, text: entry.text }))}
          onSendReply={onSendReply ?? (() => undefined)}
        />
      ) : null}
    </article>
  );
});

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

/**
 * The place at the end of the transcript where the live row sits. The slot is
 * always there, one row tall, whether or not a turn is running: the transcript
 * is anchored to its bottom, so a row appearing or leaving must not change
 * its height — that is exactly what made the reply that had just landed slide
 * down as the row went. The row leaves the moment the turn ends (nothing keeps
 * reporting "working" once it is not); the slot keeps its place.
 */
function LiveRowSlot({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div className="live-row-slot" data-open={open ? "true" : "false"} data-testid="live-row-slot">
      {open ? children : null}
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
    // Opening a screen is not acting on the turn: the card stays ready for the person's return.
    if (!choiceNavigates(choice.id)) setBusy(choice.id);
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
        {outcome.technical ? <TechnicalText text={outcome.technical} testId="coworker-turn-technical" /> : null}
      </InteractionCard>
    </div>
  );
}

/** Queued messages remain in order; secondary actions live in one menu per row. */
function NextRows({ items, onEdit, onRemove, onSendNow }: { items: QueuedMessage[]; onEdit: (id: string) => void; onRemove: (id: string) => void; onSendNow: (id: string) => void }) {
  return (
    <div className="bg-ink px-5 pt-2" data-testid="coworker-next">
      <div className="mx-auto max-w-3xl pl-10 sm:pl-12">
        <p className="mb-1 text-[10px] text-mist" data-testid="coworker-next-label">Up next · {items.length} {items.length === 1 ? "message" : "messages"} · sent after this reply</p>
        <ol className="rounded-xl border border-line bg-panel/40 px-2 py-1" aria-label="Queued messages">
          {items.map((item, index) => (
            <li key={item.id} className="flex min-w-0 items-center gap-2 py-0.5 text-xs text-mist" data-testid="coworker-next-row" data-queued-id={item.id}>
              <span className="w-4 shrink-0 text-center text-[10px] text-mist/70" aria-label={`Position ${index + 1}`}>{index + 1}</span>
              <span className="min-w-0 flex-1 truncate text-snow/85" title={item.text}>{item.text}</span>
              <ActionMenu label={`Actions for queued message ${index + 1}`} side="above" items={[
                { label: "Edit message", testId: "coworker-next-edit", onSelect: () => onEdit(item.id) },
                { label: "Send now", testId: "coworker-next-send-now", onSelect: () => onSendNow(item.id) },
                { label: "Remove from queue", testId: "coworker-next-remove", tone: "danger", onSelect: () => onRemove(item.id) },
              ]} />
            </li>
          ))}
        </ol>
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

/** Only safe categories and observed states appear in either level of the receipt. */
function WorkReceipt({ calls, client }: { calls: TranscriptToolCall[]; client: CoworkerMcpClient }) {
  const steps = calls.map(executionMetadata);
  const unsettled = steps.some((step) => step.status === "running" || step.status === "pending");
  const [open, setOpen] = useState<WorkPopoverPlacement | null>(null);
  const lineRef = useRef<HTMLButtonElement | null>(null);
  const line = summarizeWorkerReceipt(calls);
  const tone = steps.some((step) => step.status === "failed") ? "rose" : unsettled ? "spark" : "mist";
  const toggle = () => {
    if (open) {
      setOpen(null);
      return;
    }
    const rect = lineRef.current?.getBoundingClientRect();
    setOpen(rect ? workPopoverPlacement(rect, window.innerHeight) : "below");
  };
  return (
    <div className="relative min-w-0 text-[11px]" data-testid="coworker-work-receipt" data-state={tone === "rose" ? "failed" : unsettled ? "working" : steps.every((step) => step.status === "completed") ? "done" : steps.some((step) => step.status === "cancelled") ? "cancelled" : "unknown"}>
      <button
        ref={lineRef}
        type="button"
        className="group mx-auto flex max-w-full items-center gap-1.5 py-0.5 text-left text-mist hover:text-snow"
        title={open ? "Hide the steps" : "See the steps"}
        aria-expanded={open !== null}
        aria-haspopup="dialog"
        onClick={toggle}
        data-testid="coworker-work-summary"
      >
        <ToolIcon className={`size-3.5 shrink-0 ${unsettled ? "motion-safe:animate-pulse" : ""}`} />
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{line}</span>
        <StatusDot tone={tone} />
        <span className={`text-mist/60 transition-transform ${open ? "rotate-90" : ""}`} aria-hidden="true">›</span>
      </button>
      {open ? <WorkPopover calls={calls} anchor={lineRef.current} placement={open} onClose={() => setOpen(null)} /> : null}
      <ToolAttachments calls={calls} client={client} />
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
            const title = `${artifactKindLabel(artifact.kind)} · ${artifact.label}`;
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
const TranscriptAppContext = createContext<CoworkerMcpAppContext>({ sessionId: null, engine: "v1", readOnly: true });

function ToolAppFrame({ call, client }: { call: TranscriptToolCall; client: CoworkerMcpClient }) {
  const { sessionId, engine, readOnly } = useContext(TranscriptAppContext);
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
  const [resolvedApp, setApp] = useState<{ app: CoworkerMcpAppResource; client: CoworkerMcpClient } | null>(null);
  const app = resolvedApp?.client === client
    && resolvedApp.app.context.sessionId === sessionId
    && resolvedApp.app.context.engine === engine
    && resolvedApp.app.context.readOnly === readOnly ? resolvedApp.app : null;
  const [appError, setAppError] = useState("");
  const complete = call.status === "completed" || call.status === "success";
  const releaseRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    let cancelled = false;
    let launchId: string | undefined;
    const release = () => {
      if (launchId) void client.releaseApp(launchId).catch(() => undefined);
      launchId = undefined;
    };
    releaseRef.current = release;
    setApp(null);
    setAppError("");
    if (!result || !complete) return;
    void client.resolveApp(call.tool, { sessionId, engine, readOnly }, launch ?? undefined)
      .then(({ app: resolved }) => {
        launchId = resolved?.launchId;
        if (cancelled) release();
        else setApp(resolved ? { app: resolved, client } : null);
      })
      .catch((cause) => {
        if (!cancelled) setAppError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
      release();
      if (releaseRef.current === release) releaseRef.current = null;
    };
  }, [call.tool, client, complete, launch, result, sessionId, engine, readOnly]);

  if (app && result) {
    return (
      <div className="mt-1.5">
        <Suspense fallback={null}>
          <McpAppFrame
            client={client}
            app={app}
            toolName={call.tool}
            input={inputRef.current.value}
            result={result}
            onClose={() => { releaseRef.current?.(); setApp(null); }}
          />
        </Suspense>
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
  voice,
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
  stopPending = false,
  stopLabel = "Stop",
  onStop,
  waiting,
  error,
  coworkerName,
  summary = null,
  onOpenSummary,
  effortStop,
  fixedVariant = "",
  onEffortChange,
  offerStartingPoints = false,
}: {
  voice: VoiceController;
  offerStartingPoints?: boolean;
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
  stopPending?: boolean;
  stopLabel?: string;
  onStop?: () => void;
  /** Why sending has to wait a moment (for example, the workspace is still starting); typing stays possible. */
  waiting?: string;
  error?: string;
  coworkerName: string;
  summary?: CoworkerSummaryLine | null;
  onOpenSummary?: (kind: SummaryKind) => void;
  /** The effort dial's stop, and the change the person makes on it; absent, no dial is shown. */
  effortStop?: EffortStop;
  fixedVariant?: string;
  onEffortChange?: (stop: EffortStop) => void;
}) {
  const value = assignmentMode ? assignment : message;
  const submit = assignmentMode ? onCreateAssignment : onSend;
  const held = busy || Boolean(waiting);
  const canSubmit = !held && Boolean(value.trim());
  const fieldRef = voice.fieldRef;
  useAutoGrow(fieldRef, value);
  const modeLabel = assignmentMode ? "Back to chat" : "Create assignment";
  const stopping = working && !assignmentMode && !value.trim() && Boolean(onStop);
  const submitLabel = busy ? "Working…" : assignmentMode ? "Create assignment" : working ? "Next" : "Send";
  return (
    <div className="shrink-0 bg-ink px-5 pb-2 pt-2" data-testid="coworker-composer" data-working={working ? "true" : "false"}>
      <div className="mx-auto max-w-3xl">
        {error ? <div className="mb-2"><ErrorNote>{error}</ErrorNote></div> : null}
        {assignmentMode ? (
          <p className="mb-2 px-2 text-[11px] text-mist" data-testid="coworker-assignment-mode">
            Something {coworkerName} should own, separate from this chat
          </p>
        ) : null}
        <div className={`rounded-[24px] border bg-panel/60 p-3 transition-colors focus-within:border-spark/50 ${assignmentMode ? "border-spark/35" : "border-line"}`} data-testid="coworker-input-surface">
          {!assignmentMode ? <VoicePanel voice={voice} /> : null}
          <textarea
            ref={fieldRef}
            aria-label={assignmentMode ? "Assignment outcome" : `Message ${coworkerName}`}
            rows={1}
            className="block min-h-[56px] w-full resize-none bg-transparent px-1 pb-3 pt-1 text-sm leading-relaxed text-snow outline-none placeholder:text-mist/65"
            placeholder={assignmentMode ? `What should ${coworkerName} own?` : `Message ${coworkerName}`}
            value={value}
            onChange={(event) => assignmentMode ? onAssignmentChange(event.target.value) : onMessageChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.repeat || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              event.preventDefault();
              if (canSubmit) submit();
            }}
          />
          <div className="flex items-end gap-2" data-testid="coworker-composer-actions">
            <button
              type="button"
              aria-pressed={assignmentMode}
              className={`flex size-8 shrink-0 items-center justify-center rounded-full border text-lg leading-none transition-colors ${
                assignmentMode ? "border-spark/50 bg-spark/15 text-spark" : "border-line text-mist hover:border-spark/40 hover:text-snow"
              }`}
              title={modeLabel}
              onClick={() => onAssignmentModeChange(!assignmentMode)}
            >
              <PlusIcon className={`size-4 transition-transform ${assignmentMode ? "rotate-45" : ""}`} />
              <span className="sr-only">{modeLabel}</span>
            </button>
            {!assignmentMode ? <VoiceToggle voice={voice} disabled={held} /> : null}
            <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-x-3 gap-y-2 pb-0.5">
              {offerStartingPoints && !assignmentMode && !held && !working && !value.trim() ? (
                <PopoverDisclosure label="Starting points" title="A useful first step" testId="coworker-starting-points" align="start" className="mr-auto text-[11px] text-mist">
                  {[
                    { label: "Turn a goal into a plan", prompt: "Help me turn a goal into a practical plan. Ask what I want to achieve and when I need it, then help me create a short working document with next steps." },
                    { label: "Work through a document", prompt: "Help me improve a document. Ask me to share it and tell you who it is for, then identify the most useful changes before drafting a revision." },
                    { label: "Take recurring work off my plate", prompt: "Help me choose one recurring task you can take off my plate. Ask about the task, the apps it needs, and when I want the result. Propose a responsibility for me to review before scheduling it." },
                  ].map((starter) => <button key={starter.label} type="button" className="block w-full rounded-lg px-2 py-2 text-left text-xs text-snow hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-spark/45" onClick={() => { onMessageChange(starter.prompt); fieldRef.current?.focus(); }}>{starter.label}</button>)}
                  <p className="pt-2 text-[11px] text-mist">Choose a starting point, edit it, then send.</p>
                </PopoverDisclosure>
              ) : null}
              {effortStop && onEffortChange ? <EffortDial stop={effortStop} onChange={onEffortChange} coworkerName={coworkerName} fixedVariant={fixedVariant} /> : null}
            </div>
            {stopping && onStop ? (
              <SendButton label={stopLabel} busy={stopPending} disabled={stopPending} stop onClick={onStop} />
            ) : (
              <SendButton label={submitLabel} busy={busy} disabled={!canSubmit} title={waiting} onClick={submit} />
            )}
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-2 text-[10px] text-mist/65">
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
      className={`flex size-8 shrink-0 items-center justify-center rounded-full transition-colors ${
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
  stopPending = false,
  stopLabel = "Stop",
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
  stopPending?: boolean;
  stopLabel?: string;
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
        <div className="rounded-[24px] border border-line bg-panel/60 p-3 transition-colors focus-within:border-spark/50">
          <textarea
            ref={fieldRef}
            aria-label={placeholder.replace("…", "")}
            rows={1}
            className="block min-h-[56px] w-full resize-none bg-transparent px-1 pb-3 pt-1 text-sm leading-relaxed text-snow outline-none placeholder:text-mist/65"
            placeholder={placeholder}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.repeat || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              event.preventDefault();
              if (canSubmit) onSubmit();
            }}
          />
          <div className="flex justify-end" data-testid="coworker-composer-actions">
            {stopping && onStop ? (
              <SendButton label={stopLabel} busy={stopPending} disabled={stopPending} stop onClick={onStop} />
            ) : (
              <SendButton label={working ? "Next" : "Send"} busy={false} disabled={!canSubmit} onClick={onSubmit} />
            )}
          </div>
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
