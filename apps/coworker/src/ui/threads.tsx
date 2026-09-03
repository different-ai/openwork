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
import type { HeadlessThreadModel } from "@openwork/headless-threads";
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
import { describeProgress, describeWorkStep, summarizeWork, technicalSections, type ProgressPhase, type WorkStep } from "@/lib/work-receipt";
import { isServerTool, toolRefPath } from "@/lib/apps-tools";
import { openPanelRoute } from "@/lib/panel-route";
import { describeTurnFailure } from "@/lib/turn-failure";
import { useAutoGrow } from "@/ui/use-auto-grow";
import { InteractionCards } from "@/ui/interactions";
import { CoworkerAvatar } from "@/ui/coworker-avatar";
import { InlineLoader } from "@/ui/brand";
import { AlertIcon, Button, Empty, ErrorNote, PlusIcon, StatusDot, ThoughtIcon, ToolIcon } from "@/ui/kit";
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
  text: string;
  /** When the engine recorded the message; null for optimistic entries not yet committed. */
  createdAt: number | null;
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

function AssignmentsLink({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <Button variant="ghost" onClick={onClick} title={`Work handed over to own${count ? ` · ${count}` : ""}`}>
      Assignments{count ? ` · ${count}` : ""}
    </Button>
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
  /** The one-off assignment threads as this column lists them, so the panel's Assignments can show the same ones. */
  onAssignmentsChange?: (items: ThreadListItem[]) => void;
  headerSlots: HeaderSlots;
  /** Coworker settings, opened at the AI model section — the first recovery step after a model failure. */
  onOpenModelSettings: () => void;
  /** The OpenWork account section — where a provider is reconnected. */
  onOpenAccount: () => void;
  onActivityChange: (activity: CoworkerActivity | null) => void;
  documents?: DocumentHooks;
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
  const [items, setItems] = useState<ThreadListItem[]>([]);
  const [discussions, setDiscussions] = useState<ThreadListItem[]>([]);
  const [attentionBySession, setAttentionBySession] = useState<Record<string, string>>({});
  const [openThreadId, setOpenThreadId] = useState("");
  const [view, setView] = useState<"discussion" | "assignments">("discussion");
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
    setView("discussion");
    setPendingAssignment(assignmentDraft);
  }, [assignmentDraft]);

  useEffect(() => {
    if (!discussionDraft) return;
    setOpenThreadId("");
    setView("discussion");
  }, [discussionDraft]);

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
      const [all, pending, workers] = await Promise.all([
        threads.listAllThreads(),
        threads.listPendingInteractions().catch((): PendingInteractions => ({ permissions: [], questions: [] })),
        coworkerBridge.workers.list(coworker.slug).catch(() => []),
      ]);
      const workerIds = workers.map((worker) => worker.threadId).filter(Boolean);
      setWorkerThreadIds((current) => (current.length === workerIds.length && current.every((id, index) => id === workerIds[index]) ? current : workerIds));
      setWorkerRecords((current) => (current.length === workers.length && current.every((worker, index) => worker.id === workers[index]?.id && worker.updatedAt === workers[index]?.updatedAt) ? current : workers));
      const split = classifyThreads(all, { discussions: discussionThreadIds, workers: workerIds });
      setItems(split.assignments);
      onAssignmentsChange?.(split.assignments);
      setDiscussions(split.discussions);
      const attention: Record<string, string> = {};
      for (const permission of pending.permissions) {
        attention[permission.sessionID] ??= describeInteractions({ permissions: [permission], questions: [] });
      }
      for (const question of pending.questions) {
        attention[question.sessionID] ??= describeInteractions({ permissions: [], questions: [question] });
      }
      setAttentionBySession(attention);
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
      setView("discussion");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [startDiscussion]);

  /** Return to an earlier discussion; it becomes the coworker's open one. */
  const openDiscussion = useCallback(async (threadId: string) => {
    if (!threadId || threadId === discussionThreadId) {
      setOpenThreadId("");
      setView("discussion");
      return;
    }
    try {
      const updated = await coworkerBridge.coworkers.update(coworker.slug, { conversationThreadId: threadId });
      setDiscussionThreadId(threadId);
      onCoworkerChanged(updated);
      setOpenThreadId("");
      setView("discussion");
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
    setView("discussion");
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
        assignmentCount={items.length}
        headerSlots={headerSlots}
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
        onCoworkerChanged={onCoworkerChanged}
        documents={documents}
      />
    );
  }

  if (view === "assignments") {
    return (
      <AssignmentOverview
        coworker={coworker}
        headerSlots={headerSlots}
        problem={workspaceProblem}
        warmingUp={warmingUp}
        onRetry={() => void refresh()}
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
        headerSlots={headerSlots}
        problem={workspaceProblem}
        warmingUp={warmingUp}
        onRetry={() => void refresh()}
        assignmentCount={items.length}
        assignmentDraft={pendingAssignment}
        onShowAssignments={() => setView("assignments")}
        onStartDiscussion={async (text) => {
          const threadId = await ensureDiscussion();
          setQueuedTurn({ id: Date.now(), threadId, prompt: text, messageId: newMessageId() });
        }}
        onCreateAssignment={createAssignment}
        onAssignmentDraftHandled={() => setPendingAssignment(null)}
        discussionDraft={discussionDraft}
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
      headerSlots={headerSlots}
      assignmentDraft={pendingAssignment}
      discussionDraft={discussionDraft}
      initialTurn={queuedTurn?.threadId === discussionThreadId ? queuedTurn : null}
      discussions={discussions}
      onOpenDiscussion={(threadId) => void openDiscussion(threadId)}
      onNewDiscussion={() => void openNewDiscussion()}
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
      onCoworkerChanged={onCoworkerChanged}
      documents={documents}
      workers={workerRecords}
      onWorkersChanged={() => void refresh()}
    />
  );
}

function DiscussionWelcome({
  coworker,
  problem,
  warmingUp,
  onRetry,
  assignmentCount,
  assignmentDraft,
  onStartDiscussion,
  onCreateAssignment,
  onShowAssignments,
  onAssignmentDraftHandled,
  discussionDraft,
  headerSlots,
}: {
  coworker: CoworkerSummary;
  problem: WorkspaceProblem | null;
  warmingUp: boolean;
  onRetry: () => void;
  assignmentCount: number;
  assignmentDraft?: AssignmentDraft;
  discussionDraft?: AssignmentDraft;
  headerSlots: HeaderSlots;
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
        actions={<AssignmentsLink count={assignmentCount} onClick={onShowAssignments} />}
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
      />
    </section>
  );
}

function AssignmentOverview({
  coworker,
  items,
  attentionBySession,
  problem,
  warmingUp,
  onRetry,
  onOpen,
  onBack,
  onNewAssignment,
  headerSlots,
}: {
  coworker: CoworkerSummary;
  items: ThreadListItem[];
  attentionBySession: Record<string, string>;
  problem: WorkspaceProblem | null;
  warmingUp: boolean;
  onRetry: () => void;
  onOpen: (threadId: string) => void;
  onBack: () => void;
  onNewAssignment: () => void;
  headerSlots: HeaderSlots;
}) {
  return (
    <section className="flex h-full min-h-0 flex-col bg-ink" data-testid="coworker-assignments-view">
      <HeaderContent
        slots={headerSlots}
        title={<span className="truncate">Assignments · work {coworker.name} owns</span>}
        actions={(
          <>
            <Button variant="ghost" onClick={onBack} title="Back to discussion">Back</Button>
            <Button variant="primary" onClick={onNewAssignment}>New assignment</Button>
          </>
        )}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {problem ? <WorkspaceProblemNote problem={problem} onRetry={onRetry} /> : null}
        {items.length === 0 && warmingUp ? (
          <div className="py-10 text-center text-xs text-mist"><InlineLoader label={`Getting ${coworker.name} ready`} /></div>
        ) : null}
        {items.length === 0 && !problem && !warmingUp ? (
          <div className="mx-auto flex h-full max-w-md flex-col items-center justify-center text-center">
            <h3 className="text-base font-semibold text-snow">No assignments yet</h3>
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
  assignmentCount,
  assignmentDraft,
  discussionDraft,
  initialTurn,
  discussions = [],
  onOpenDiscussion,
  onNewDiscussion,
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
  onCoworkerChanged,
  headerSlots,
  documents,
  workers = [],
  onWorkersChanged,
}: {
  threads: NonNullable<ReturnType<typeof createCoworkerThreads>>;
  threadId: string;
  coworker: CoworkerSummary;
  runtime: RuntimeInfo;
  /** `worker`: a Worker's own thread, shown read-only; steering and stopping live in the Workers view. */
  kind: "discussion" | "assignment" | "worker";
  assignmentCount: number;
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
  onShowAssignments: () => void;
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
  /** The far-off retry already cancelled for this thread (by its scheduled time), and why it stalled. */
  const stallRef = useRef<{ next: number; reason: string } | null>(null);
  const clearStall = () => {
    stallRef.current = null;
  };
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
      }
      setStatusLabel(stall ? "idle" : status.type);
      setTerminalError(
        pendingTurnRef.current
          ? ""
          : stall ?? stallRef.current?.reason ?? (transcript.terminalError
            ? `${transcript.terminalError.name}: ${transcript.terminalError.message}`
            : ""),
      );
      setMessages(
        transcript.messages.map((message) => ({
          id: message.id,
          role: message.role,
          text: message.text,
          createdAt: message.createdAt,
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

  const submitTurn = useCallback(async (prompt: string, messageId: string, modelOverride?: HeadlessThreadModel, failedModels: readonly string[] = []) => {
    if (pendingTurnRef.current) return;
    /** The model this turn actually ran on, so a failure can be attributed and, if it was the app's pick, replaced. */
    let turnModelId = modelOverride ? `${modelOverride.providerId}/${modelOverride.modelId}` : coworker.model;
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
        window.setTimeout(() => void submitTurn(prompt, messageId, nextModel, excluded), 0);
        return true;
      } catch {
        return false;
      }
    };
    const nextPending: PendingTurn = { messageId, prompt, phase: "accepting" };
    pendingTurnRef.current = nextPending;
    setPendingTurn(nextPending);
    if (kind === "discussion" && !firstPromptRef.current && (!titleLoadedRef.current || title.trim() === defaultDiscussionTitle)) {
      firstPromptRef.current = prompt;
      if (titleLoadedRef.current) {
        const renamed = titleDiscussionAfterFirstMessage(title);
        if (renamed) setTitle(renamed);
      }
    }
    clearStall();
    setTurnIssue(null);
    setTerminalError("");
    setError("");
    setProviderRefreshNote("");
    stopRequestedRef.current = false;
    onActivityChange({
      state: "working",
      label: "Working",
      detail: kind === "discussion" ? "Replying in your discussion" : kind === "worker" ? workerNameFromTitle(title) : title,
      updatedAt: Date.now(),
      threadId,
    });
    let refreshTimer: number | undefined;
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
      const acceptance = await threads.client.sendTurn(threadId, {
        prompt,
        messageId,
        model: turnModel,
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
        if (!(await fallBack(failure))) setTurnIssue({ kind: "failed", message: failure, messageId, prompt });
      } else if (result.outcome === "timeout") {
        setTurnIssue({
          kind: "timeout",
          message: "No response arrived within two minutes. The conversation is still saved, and you can retry this turn without sending it twice.",
          messageId,
          prompt,
        });
      } else if (result.outcome === "aborted" && stallRef.current && !stopRequestedRef.current) {
        // The wait ended because the engine's far-off retry was cancelled: the model is unavailable.
        const failure = stallRef.current.reason;
        if (!(await fallBack(failure))) setTurnIssue({ kind: "failed", message: failure, messageId, prompt });
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
      if (!(await fallBack(message))) setTurnIssue({ kind: "failed", message, messageId, prompt });
    } finally {
      if (refreshTimer !== undefined) window.clearInterval(refreshTimer);
      waitControllerRef.current = null;
      if (pendingTurnRef.current?.messageId === messageId) {
        pendingTurnRef.current = null;
        setPendingTurn(null);
      }
    }
  }, [coworker.model, coworker.modelVariant, coworker.name, coworker.slug, defaultDiscussionTitle, kind, onActivityChange, onCoworkerChanged, refresh, session, threadId, threads, title, titleDiscussionAfterFirstMessage]);

  // After a model-related failure, find a different connected model that can use tools.
  useEffect(() => {
    if (turnIssue?.kind !== "failed" && !terminalError) {
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
  }, [coworker.model, terminalError, threads, turnIssue]);

  /** Switch this coworker to the recommended model and retry the failed message. */
  async function useRecommendedModel() {
    const failed = turnIssue;
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
    if (failed?.prompt) void submitTurn(failed.prompt, failed.messageId, model);
  }

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
        ? [...messages, { id: optimisticTurn.messageId, role: "user", text: optimisticTurn.prompt, createdAt: null, reasoning: "", model: null, toolCalls: [] }]
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
    ? [...messages, { id: optimisticTurn.messageId, role: "user", text: optimisticTurn.prompt, createdAt: null, reasoning: "", model: null, toolCalls: [] }]
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
        detail: kind === "discussion" ? "Discussion turn stopped" : kind === "worker" ? workerNameFromTitle(title) : title,
        updatedAt: Date.now(),
        threadId,
      });
      return;
    }
    if (working) {
      onActivityChange({
        state: statusLabel === "retry" ? "retrying" : "working",
        label: workingLabel,
        detail: activeToolLabel ?? (kind === "discussion" ? "Replying in your discussion" : kind === "worker" ? workerNameFromTitle(title) : title),
        updatedAt: Date.now(),
        threadId,
      });
      return;
    }
    // A turn accepted in this same effect pass (the first message of a new discussion) has
    // already announced itself; clearing here would leave the header on Ready for one frame.
    if (pendingTurnRef.current) return;
    onActivityChange(null);
  }, [activeToolLabel, coworker.name, displayedFailure, kind, needsYou, onActivityChange, pending, statusLabel, stopped, threadId, title, turnIssue, working, workingLabel]);

  const currentDiscussion: ThreadListItem = discussions.find((item) => item.id === threadId)
    ?? { id: threadId, title, createdAt: 0, updatedAt: 0, status: "idle" };
  const freshDiscussion = kind === "discussion" && visibleMessages.length === 0 && !working && !needsYou && !error && !displayedFailure;

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
            {kind !== "discussion" ? <Button variant="ghost" onClick={onBack} title="Back to discussion">Back</Button> : null}
            {(working || needsYou) && kind !== "worker" ? <Button variant="ghost" onClick={() => void stop()}>Stop</Button> : null}
            {kind === "discussion" ? <AssignmentsLink count={assignmentCount} onClick={onShowAssignments} /> : null}
          </>
        )}
      />
      {/* Progress and problems show inline in the conversation; this keeps the turn state readable to assistive tech and tests. */}
      <p data-testid="coworker-thread-status" className="sr-only" aria-live="polite" data-state={needsYou ? "needs-you" : working ? "working" : "idle"}>
        {kind === "discussion" && !working && !needsYou && !turnNeedsAttention && !stopped ? "Ready" : readableStatus}
      </p>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <div className="mx-auto max-w-3xl space-y-3">
          {freshDiscussion ? <QuietEmptyConversation coworker={coworker} /> : null}
          {conversationBlocks(visibleMessages, (message, index) => working && message.role === "assistant" && index === lastAssistantIndex).map((block) =>
            block.kind === "actions" ? (
              <ActionLine key={block.id} review={block.review} reasoning={block.reasoning} calls={block.calls} client={mcpClient} />
            ) : (
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
              </Fragment>
            ),
          )}
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
          {working ? (
            <WorkIndicator
              coworker={coworker}
              messages={visibleMessages}
              label={workingLabel}
            />
          ) : null}
          {visibleMessages.length === 0 && !error && !working && kind !== "discussion" ? (
            <Empty><InlineLoader label={kind === "worker" ? "Loading the Worker's thread" : "Loading assignment"} /></Empty>
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
              recommendedModel={recommendedModel}
              onUseRecommended={() => void useRecommendedModel()}
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
      ) : kind === "worker" ? (
        <p className="border-t border-line px-5 py-3 text-center text-[11px] text-mist" data-testid="coworker-worker-readonly">
          This is the Worker's own work. Steer, pause, or stop it from the Workers view.
        </p>
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

type ConversationBlock =
  | { kind: "actions"; id: string; review: WorkerReview | null; reasoning: string; calls: TranscriptToolCall[] }
  | { kind: "message"; message: TranscriptMessage; previous: TranscriptMessage | undefined; active: boolean; continued: boolean; tail: boolean; calls: TranscriptToolCall[] };

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
  if (label === "Working") return "writing";
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
 * changes only when the phase changes — never on a timer.
 */
function WorkIndicator({
  coworker,
  messages,
  label,
}: {
  coworker: CoworkerSummary;
  messages: TranscriptMessage[];
  label: string;
}) {
  const step = activeWorkStep(messages);
  const phase = progressPhase(label, step !== null);
  return (
    <div className="flex items-center gap-2.5 px-1 py-1.5 text-xs text-mist" data-testid="coworker-working" data-phase={phase}>
      <CoworkerAvatar animated working={phase === "tool"} color={coworker.avatarColor} glasses={coworker.avatarGlasses} name={coworker.name} size={22} />
      <TypingDots />
      <span data-testid="coworker-progress-phrase">{describeProgress(coworker.name, phase, step)}</span>
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
  recommendedModel = null,
  onUseRecommended,
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
  /** A different tool-capable model to switch to and retry with, when one is connected. */
  recommendedModel?: EngineModelOption | null;
  onUseRecommended?: () => void;
}) {
  const failure = kind === "failed"
    ? describeTurnFailure(message, coworkerName)
    : { headline: "The reply is taking too long", detail: message, technical: "", modelRelated: false };
  return (
    <div className="rounded-xl border border-rose/25 bg-rose/5 px-3 py-3" data-testid={`coworker-turn-${kind}`}>
      <div className="flex items-start gap-2.5">
        <AlertIcon className="mt-0.5 size-4 shrink-0 text-rose" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-snow" data-testid="coworker-turn-headline">{failure.headline}</p>
          {failure.detail ? <p className="mt-1 break-words text-xs leading-relaxed text-mist">{failure.detail}</p> : null}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {failure.modelRelated && recommendedModel && onUseRecommended && canRetry ? (
              <Button variant="primary" onClick={onUseRecommended} title={`Switch to ${recommendedModel.label} and retry`} data-testid="coworker-use-recommended-model">
                Use {recommendedModel.modelLabel}
              </Button>
            ) : null}
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
                      onClick={() => openPanelRoute({ view: "capabilities", path: toolRefPath(call.tool, step.label) })}
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
  waiting,
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
  /** Why sending has to wait a moment (for example, the workspace is still starting); typing stays possible. */
  waiting?: string;
  error?: string;
  coworkerName: string;
}) {
  const value = assignmentMode ? assignment : message;
  const submit = assignmentMode ? onCreateAssignment : onSend;
  const held = busy || Boolean(waiting);
  const canSubmit = !held && Boolean(value.trim());
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(fieldRef, value);
  const modeLabel = assignmentMode ? "Back to chat" : "Create assignment";
  const submitLabel = busy ? "Working…" : assignmentMode ? "Create assignment" : "Send";
  return (
    <div className="bg-ink px-5 pb-2 pt-2" data-testid="coworker-composer">
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
            <SendButton label={submitLabel} busy={busy} disabled={!canSubmit} title={waiting} onClick={submit} />
          </div>
        </div>
        <div className="mt-1.5 flex items-center justify-between gap-3 px-12 text-[9px] text-mist/65">
          <span className="hidden sm:inline" data-testid="coworker-composer-hint">
            {waiting && !busy ? `${waiting}…` : `Enter to ${assignmentMode ? "create" : "send"} · Shift Enter for a new line`}
          </span>
          <span className="shrink-0 font-medium tracking-[0.06em]">Powered by OpenWork</span>
        </div>
      </div>
    </div>
  );
}

/** The round send control shared by every composer: our accent when it can send, quiet otherwise. */
export function SendButton({ label, busy, disabled, title, onClick, testId = "coworker-send" }: { label: string; busy: boolean; disabled: boolean; title?: string; onClick: () => void; testId?: string }) {
  return (
    <button
      type="button"
      aria-busy={busy}
      disabled={disabled}
      title={title || label}
      data-testid={testId}
      className={`mb-0.5 flex size-7 shrink-0 items-center justify-center rounded-full transition-colors ${
        disabled ? "bg-white/8 text-mist/60" : "bg-spark text-white hover:bg-spark/90"
      } disabled:cursor-not-allowed`}
      onClick={onClick}
    >
      {busy ? (
        <span aria-hidden="true" className="block size-3 animate-spin rounded-full border-2 border-white/30 border-t-white" />
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
  busy,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  busy: boolean;
  placeholder: string;
}) {
  const canSubmit = !busy && Boolean(value.trim());
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(fieldRef, value);
  return (
    <div className="bg-ink px-5 pb-2 pt-2" data-testid="coworker-composer">
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
          <SendButton label={busy ? "Working…" : "Send"} busy={busy} disabled={!canSubmit} onClick={onSubmit} />
        </div>
        <div className="mt-1.5 flex items-center justify-end px-1 text-[9px] text-mist/65">
          <span className="font-medium tracking-[0.06em]">Powered by OpenWork</span>
        </div>
      </div>
    </div>
  );
}
