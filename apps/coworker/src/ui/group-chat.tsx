import { useComposerDraft } from "@/ui/use-composer-draft";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentProps, type ReactNode } from "react";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { coworkerBridge, type CollaborationReceipt, type CoworkerGroupSummary, type CoworkerGroupTurn, type CoworkerSummary, type GroupInteraction, type GroupTimelineEvent, type RuntimeInfo } from "@/lib/bridge";
import { assignmentPrompt, assignmentTitle, timeLabelBetween, type DiscussionMessage } from "@/lib/conversation";
import { combineSummaryLines, describeCoworkerSummary, type CoworkerSummaryLine } from "@/lib/coworker-summary";
import { classifyThreads, discussionIds, loadDiscussionRegistry } from "@/lib/discussions";
import { lastDocumentsOpened } from "@/ui/documents";
import { GroupDocuments, type GroupDocumentsApi } from "@/ui/group-documents";
import {
  publishGroupRun,
  stopGroupRun,
  type QueuedGroupMessage,
} from "@/lib/group-runs";
import {
  chooseSpeakers,
  describeSpeakerFailure,
  listNames,
  mentionCandidates,
  parseMentions,
  unfinishedSpeakers,
  type GroupParticipant,
} from "@/lib/groups";
import { createCoworkerThreads } from "@/lib/threads";
import { executionProgress, type ExecutionActivity } from "@/lib/progress-activity";
import { describeGroupPresentation } from "@/lib/group-presentation";
import { changeGroupSends, groupConversationRows, groupMessageKey, groupReplyParts, groupSends, mergeGroupReplyParts, reconcileGroupActivity, runGroupAction, submitGroupSend, subscribeGroupSends, waitForGroup, type GroupActionAttempt, type GroupReplyPart, type GroupSend } from "@/lib/group-continuity";
import { PROGRESS_LIMITS } from "@/lib/progress-config";
import { safeLiveMarkdown } from "@/lib/live-phase";
import { LiveRow } from "@/ui/live-row";
import { Markdown } from "@/ui/markdown";
import { acknowledgeCoworker, CoworkerAvatar, GroupAvatars } from "@/ui/coworker-avatar";
import { InteractionCard, InteractionCards, LETTERS, OptionRow, typingInField } from "@/ui/interactions";
import { ActionMenu, Button, ErrorNote, PlusIcon } from "@/ui/kit";
import { CollaborationReceipts, SendButton, SummaryLine } from "@/ui/threads";
import { useAutoGrow } from "@/ui/use-auto-grow";
import { JumpToLatest, useConversationScroll } from "@/ui/use-conversation-scroll";
import { appendVoiceDraft, groupVoiceReply, type VoiceExpectation } from "@/lib/voice";
import { useVoice } from "@/ui/use-voice";
import { VoicePanel, VoiceToggle } from "@/ui/voice";

/** How long one coworker may take over one reply before the turn moves on. */
export const REPLY_TIMEOUT_MS = 180_000;

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function timeLabel(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** The `@handle` being typed just before the caret, if any. */
function mentionAtCaret(value: string, caret: number): { start: number; query: string } | null {
  const before = value.slice(0, caret);
  const match = /(^|[\s(\[])@([a-z0-9-]*)$/i.exec(before);
  if (!match) return null;
  return { start: before.length - (match[2] ?? "").length - 1, query: match[2] ?? "" };
}

type MentionOption = { handle: string; label: string; detail: string; member: CoworkerSummary | null };

/** How often the members' holdings are re-read for the composer's line; a group's line is informative, not live. */
const GROUP_HOLDINGS_POLL_MS = 15_000;

/**
 * What the members hold, added up for the composer's quiet line. Each member is
 * read the way its own home reads it — one-off assignments from its threads,
 * scheduled ones, live Workers, documents in play — so the numbers agree.
 * Null until the first read, and null when nobody holds anything.
 */
function useGroupHoldings(members: readonly CoworkerSummary[], runtime: RuntimeInfo): CoworkerSummaryLine | null {
  const [line, setLine] = useState<CoworkerSummaryLine | null>(null);
  useEffect(() => {
    let cancelled = false;
    let reading = false;
    const read = async () => {
      if (reading) return;
      reading = true;
      try {
        const lines = await Promise.all(members.map(async (member) => {
          const [workers, scheduled, documents, registry] = await Promise.all([
            waitForGroup(coworkerBridge.workers.list(member.slug)).catch(() => []),
            waitForGroup(coworkerBridge.localResponsibilities.list(member.slug)).catch(() => []),
            waitForGroup(coworkerBridge.documents.list(member.slug)).catch(() => []),
            waitForGroup(loadDiscussionRegistry(member.slug)).catch((): string[] => []),
          ]);
          const all = member.workspaceId && runtime.engineManaged
            ? await waitForGroup(createCoworkerThreads({ serverUrl: runtime.serverUrl, workspaceId: member.workspaceId, token: runtime.ownerToken }).listAllThreads()).catch(() => [])
            : [];
          const split = classifyThreads(all, {
            discussions: discussionIds(registry, member.conversationThreadId),
            workers: workers.map((worker) => worker.threadId).filter(Boolean),
          });
          return describeCoworkerSummary({
            assignments: split.assignments,
            scheduled,
            workers,
            documents,
            documentsSeenAt: lastDocumentsOpened(member.slug),
          });
        }));
        if (cancelled) return;
        const combined = combineSummaryLines(lines);
        setLine(combined.parts.length > 0 ? combined : null);
      } finally { reading = false; }
    };
    void read();
    const timer = window.setInterval(() => void read(), GROUP_HOLDINGS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [members, runtime.engineManaged, runtime.ownerToken, runtime.serverUrl]);
  return line;
}

/** One admitted native execution. Closing this observer only disconnects its event stream. */
const GroupExecutionRow = memo(function GroupExecutionRow({ activity, coworker, runtime, unavailable, waiting }: { activity: ExecutionActivity; coworker: CoworkerSummary; runtime: RuntimeInfo; unavailable: boolean; waiting: boolean }) {
  const currentRef = useRef(activity);
  currentRef.current = activity;
  const [streamed, setStreamed] = useState<GroupReplyPart[]>([]);
  const hiddenParts = useRef(new Set<string>());
  useEffect(() => {
    if (!coworker.workspaceId || !runtime.engineManaged) return;
    const controller = new AbortController();
    const approved = new Set<string>();
    let parts: GroupReplyPart[] = [];
    const client = createOpencodeClient({ baseUrl: `${runtime.serverUrl}/workspace/${encodeURIComponent(coworker.workspaceId)}/opencode`, headers: { Authorization: `Bearer ${runtime.ownerToken}` }, redirect: "error" });
    const accepts = (messageId: string) => approved.has(messageId) || currentRef.current.replies.some((reply) => reply.id === messageId && reply.parentId === activity.messageId);
    const keep = (part: GroupReplyPart) => {
      parts = mergeGroupReplyParts(parts, [part]);
      setStreamed(parts);
    };
    void (async () => {
      try {
        const subscription = await client.event.subscribe(undefined, { signal: controller.signal });
        for await (const event of subscription.stream) {
          if (controller.signal.aborted) return;
          if (event.type === "message.updated") {
            const info = event.properties.info;
            if (info.sessionID === activity.threadId && info.role === "assistant" && info.parentID === activity.messageId && approved.size < PROGRESS_LIMITS.maxReplyParts) approved.add(info.id);
          } else if (event.type === "message.part.updated") {
            const part = event.properties.part;
            if (part.sessionID !== activity.threadId || !accepts(part.messageID) || part.type !== "text") continue;
            if (part.synthetic || part.ignored) {
              hiddenParts.current.add(`${part.messageID}:${part.id}`);
              parts = parts.filter((item) => item.messageId !== part.messageID || item.id !== part.id);
              setStreamed(parts);
              continue;
            }
            keep({ messageId: part.messageID, id: part.id, text: part.text, ended: part.time?.end !== undefined });
          } else if (event.type === "message.part.delta") {
            const part = event.properties;
            if (part.sessionID !== activity.threadId || !accepts(part.messageID) || part.field !== "text") continue;
            // Deltas cannot establish that a part is visible text. Require an announced or projected text part.
            const known = parts.find((item) => item.messageId === part.messageID && item.id === part.partID) ?? currentRef.current.replies.find((reply) => reply.id === part.messageID)?.parts.find((item) => item.id === part.partID);
            if (known && !known.ended && !hiddenParts.current.has(`${part.messageID}:${part.partID}`)) keep({ messageId: part.messageID, id: part.partID, text: known.text + part.delta });
          }
        }
      } catch { /* The bounded snapshot poll remains authoritative when live events disconnect. */ }
    })();
    return () => { controller.abort(); };
  }, [activity.executionId, activity.messageId, activity.threadId, coworker.workspaceId, runtime.engineManaged, runtime.ownerToken, runtime.serverUrl]);

  const parts = mergeGroupReplyParts(streamed, groupReplyParts(activity)).filter((part) => !hiddenParts.current.has(`${part.messageId}:${part.id}`));
  let text = "";
  let messageId = "";
  for (const part of parts) {
    if (messageId && messageId !== part.messageId) text += "\n";
    text += part.text;
    messageId = part.messageId;
  }
  const progress = executionProgress({ ...activity, ...(waiting ? { state: "waiting-person" } : {}), ...(unavailable ? { available: false } : {}) }, Boolean(text.trim()));
  return <div className="min-w-0" data-scroll-anchor={`execution:${activity.executionId}`} data-testid="group-working" data-phase={activity.state} data-execution-id={activity.executionId} data-message-id={activity.messageId} data-thread-id={activity.threadId} data-speaker={activity.slug}>
    <p className="mb-1 px-2 text-[11px] font-medium text-mist [overflow-wrap:anywhere]" data-testid="group-speaker-name">{coworker.name}</p>
    {text ? <div className="flex min-w-0 items-end gap-2" data-message-role="assistant" data-live="true">
      <span className="shrink-0"><CoworkerAvatar identity={coworker.slug} animated={false} motion="quiet" gaze={false} color={coworker.avatarColor} glasses={coworker.avatarGlasses} name={coworker.name} size={24} /></span>
      <div className="bubble bubble-coworker bubble-tail-left min-w-0 max-w-[76%] [overflow-wrap:anywhere]" data-testid="group-live-reply"><Markdown text={safeLiveMarkdown(text)} className="overflow-x-auto" /></div>
    </div> : null}
    <LiveRow coworker={coworker} progress={progress} phase={progress.status === "streaming" ? "writing" : "thinking"} wordsArrived={Boolean(text)} />
  </div>;
});

/**
 * A group chat: the person and several coworkers in one conversation. Each
 * reply is a real turn in that coworker's own workspace on a group-specific
 * discussion thread; the group only ever sees the visible text. Every turn is
 * a record in the group's store, so the view renders what is persisted.
 */
export function GroupChat(props: ComponentProps<typeof GroupChatView>) {
  return <GroupChatView key={props.group.id} {...props} />;
}

const groupObservations = new Map<string, { groupId: string; timeline: GroupTimelineEvent[]; executions: ExecutionActivity[] }>();

function GroupChatView({
  group,
  coworkers,
  runtime,
  onGroupChanged,
  onGroupArchived,
  onActivityLine,
  onChooseModel,
  onOpenDetails,
  onOpenAssignment,
  active = true,
  introduction,
  event,
  onOpenEvent,
  documentRequest,
  documentsApi,
}: {
  documentsApi?: GroupDocumentsApi;
  active?: boolean;
  introduction?: ReactNode;
  event?: { id: string; title: string };
  onOpenEvent?: (id: string) => void;
  documentRequest?: { id: number; documentId: string } | null;
  group: CoworkerGroupSummary;
  coworkers: CoworkerSummary[];
  runtime: RuntimeInfo;
  onGroupChanged: (group: CoworkerGroupSummary) => void;
  onGroupArchived: (group: CoworkerGroupSummary) => void;
  /** One plain line describing the latest activity, for the rail. */
  onActivityLine: (id: string, line: string, activeSlugs: string[]) => void;
  /** Open one coworker's AI model setting, the fix for a model-related failure. */
  onChooseModel: (slug: string) => void;
  /** Open the group's details (members, facilitator, archive). */
  onOpenDetails?: () => void;
  /** Open an assignment a group created, in its owner's view. */
  onOpenAssignment?: (slug: string, threadId: string) => void;
}) {
  const eventId = event?.id ?? group.eventId;
  const [sharedDocument, setSharedDocument] = useState<{ groupId: string; id: string } | null>(null);
  useEffect(() => {
    if (documentRequest) setSharedDocument({ groupId: group.id, id: documentRequest.documentId });
  }, [documentRequest, group.id]);
  const [observed, setObserved] = useState(() => groupObservations.get(group.id) ?? { groupId: "", timeline: [], executions: [] });
  const events = observed.groupId === group.id ? observed.timeline : [];
  const executions = observed.groupId === group.id ? observed.executions : [];
  const [humanWaits, setHumanWaits] = useState<{ groupId: string; entries: GroupInteraction[] }>({ groupId: "", entries: [] });
  const interactions = humanWaits.groupId === group.id ? humanWaits.entries : [];
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useComposerDraft(`group:${group.id}`);
  const [live, setLive] = useState(false);
  const [liveTurn, setLiveTurn] = useState<CoworkerGroupTurn | null>(null);
  const [queue, setQueue] = useState<QueuedGroupMessage[]>([]);
  const [voiceBaseline, setVoiceBaseline] = useState<{ clientMessageId: string; updatedAt: number; eventIds: string[] } | null>(null);
  const [receipts, setReceipts] = useState<CollaborationReceipt[]>([]);
  const [receiptsLoaded, setReceiptsLoaded] = useState(false);
  const localSends = useSyncExternalStore(subscribeGroupSends, () => groupSends(group.id));
  const sending = localSends.some((item) => item.state === "pending" || item.state === "sending");
  const actionAttempts = useRef(new Map<string, GroupActionAttempt>());
  const [busyActions, setBusyActions] = useState<string[]>([]);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const submissionRevision = useRef(0);
  const errorRevision = useRef(0);
  const [activityError, setActivityError] = useState("");
  const [error, setError] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(group.name);
  const [mention, setMention] = useState<{ start: number; query: string; index: number } | null>(null);
  /** The composer turned towards an assignment: what someone should own, then who. */
  const [assignmentMode, setAssignmentMode] = useState(false);
  const [assignment, setAssignment] = useComposerDraft(`group:${group.id}:assignment`);
  const [pendingAssignment, setPendingAssignment] = useState<{ outcome: string; suggested: string } | null>(null);
  const [assignmentBusy, setAssignmentBusy] = useState("");
  const assignmentInFlight = useRef(false);
  const assignmentChoiceRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const groupRef = useRef(group);
  groupRef.current = group;
  const coworkersRef = useRef(coworkers);
  coworkersRef.current = coworkers;
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const { scrollRef, contentRef, away, jumpToLatest } = useConversationScroll(`group:${group.id}`, active && !pendingAssignment, observed.groupId === group.id);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const changedRef = useRef(onGroupChanged);
  changedRef.current = onGroupChanged;
  useAutoGrow(composerRef, assignmentMode ? assignment : message);

  const members = useMemo(
    () => group.participantSlugs.map((slug) => coworkers.find((coworker) => coworker.slug === slug)).filter((member): member is CoworkerSummary => Boolean(member)),
    [coworkers, group.participantSlugs],
  );
  const membersRef = useRef(members);
  membersRef.current = members;
  const holdings = useGroupHoldings(members, runtime);
  const nameFor = useCallback((slug: string) => coworkers.find((coworker) => coworker.slug === slug)?.name ?? slug, [coworkers]);

  function isEventPhaseRequest(clientMessageId?: string, turnId?: string): boolean {
    return Boolean(clientMessageId?.startsWith("event:") || (turnId && groupRef.current.turns.find((turn) => turn.id === turnId)?.clientMessageId.startsWith("event:")));
  }

  useEffect(() => {
    // Old replay receipts must not hold ordinary follow-ups behind an unresolvable send.
    changeGroupSends(group.id, (items) => items.map((item) => isEventPhaseRequest(item.clientMessageId, item.turnId) && ["pending", "sending", "uncertain"].includes(item.state)
      ? { ...item, state: "failed", error: "Event phases cannot be replayed. Inspect the event for its actual status." }
      : item));
  }, [group.id, group.turns, localSends]);

  useEffect(() => {
    if (!eventId) return;
    setAssignmentMode(false);
    setPendingAssignment(null);
  }, [eventId]);

  useEffect(() => {
    let cancelled = false;
    const current = () => !cancelled && groupRef.current.id === group.id;
    const failures = new Set<string>();
    setActivityError("");
    // Each observation has its own in-flight guard. Slow native activity must
    // not stop status, queue or receipt updates; timeline and executions stay paired.
    const poll = <T,>(name: string, read: () => Promise<T>, apply: (value: T) => void) => {
      let reading = false;
      const refresh = async () => {
        if (reading) return;
        reading = true;
        try {
          const revision = submissionRevision.current;
          const value = await waitForGroup(read());
          if (!current() || revision !== submissionRevision.current) return;
          apply(value);
          failures.delete(name);
        } catch {
          failures.add(name);
        } finally {
          reading = false;
          if (current()) setActivityError(failures.size ? "Reconnecting to group activity. Shown replies and send receipts are kept. Messages are not automatically resent." : "");
        }
      };
      void refresh();
      return window.setInterval(() => void refresh(), PROGRESS_LIMITS.activityPollMs);
    };
    const timers = [
      poll("status", () => coworkerBridge.groups.status(group.id), (status) => {
        setLive(status.active); setLiveTurn(status.turn); setQueue(status.queue); setLoaded(true);
        setHumanWaits({ groupId: group.id, entries: status.interactions });
        changeGroupSends(group.id, (items) => [...items, ...status.queue.filter((queued) => !items.some((item) => item.clientMessageId === queued.clientMessageId)).map((queued): GroupSend => ({ ...queued, at: Date.now(), state: "accepted" }))].flatMap((item): GroupSend[] => {
          const turn = groupRef.current.turns.find((turn) => turn.id === item.turnId);
          if (item.turnId && !status.active && turn && turn.updatedAt > (item.turnUpdatedAt ?? item.at)) return [];
          const known = status.queue.some((queued) => queued.clientMessageId === item.clientMessageId) || (!item.turnId && status.turn?.clientMessageId === item.clientMessageId) || (item.turnId === status.turn?.id && status.turn && status.turn.updatedAt > (item.turnUpdatedAt ?? item.at));
          return [known && (item.state !== "accepted" || item.error) ? { ...item, state: "accepted", error: undefined } : item];
        }));
        publishGroupRun({ groupId: group.id, active: status.active, ...(status.turn ? { turn: status.turn } : {}), done: !status.active });
      }),
      poll("activity", () => coworkerBridge.groups.activity(group.id), (activity) => {
        const speakerOrder = [...(groupRef.current.turns.at(-1)?.speakers ?? [])].sort((a, b) => a.order - b.order).map((speaker) => speaker.slug);
        const next = { groupId: group.id, ...reconcileGroupActivity(groupObservations.get(group.id) ?? { timeline: [], executions: [] }, activity, speakerOrder) };
        groupObservations.set(group.id, next);
        setObserved(next);
        changeGroupSends(group.id, (items) => items.filter((item) => item.turnId || !next.timeline.some((event) => event.kind === "user" && event.clientMessageId === item.clientMessageId)));
      }),
      poll("group", () => coworkerBridge.groups.get(group.id), (updated) => {
        if (updated.updatedAt > groupRef.current.updatedAt) changedRef.current(updated);
      }),
      poll("receipts", () => coworkerBridge.collaboration.receipts({ groupId: group.id }), (work) => {
        setReceipts(work); setReceiptsLoaded(true);
      }),
    ];
    return () => { cancelled = true; timers.forEach(window.clearInterval); };
  }, [group.id]);

  useEffect(() => {
    if (!loaded || !receiptsLoaded || observed.groupId !== group.id) return;
    const presentation = describeGroupPresentation({ events, executions, interactions, active: live, turn: liveTurn ?? group.turns.at(-1) ?? null, nameFor, unavailable: Boolean(activityError) });
    onActivityLine(group.id, presentation.line, presentation.activeSlugs);
  }, [events, executions, interactions, group.id, group.turns, observed.groupId, live, liveTurn, loaded, receiptsLoaded, activityError, nameFor, onActivityLine]);

  useLayoutEffect(() => {
    if (!active || !pendingAssignment) return;
    assignmentChoiceRef.current?.scrollIntoView({ block: "nearest", behavior: "instant" });
    assignmentChoiceRef.current?.focus({ preventScroll: true });
  }, [active, pendingAssignment]);

  function startTurn(text: string, clientMessageId: string, recovery?: { turn: CoworkerGroupTurn; only?: string }, voiceIntent: VoiceExpectation | null = null): void {
    const existing = groupSends(group.id).find((item) => item.clientMessageId === clientMessageId);
    if (isEventPhaseRequest(clientMessageId, recovery?.turn.id ?? existing?.turnId) || recovery?.turn.clientMessageId.startsWith("event:")) {
      voice.abandonReply(voiceIntent);
      setError("This event phase cannot be replayed. Use View event to inspect the run or explicitly start a new session.");
      return;
    }
    const receipt: GroupSend = existing ?? { text, clientMessageId, at: Date.now(), state: "pending",
      ...(recovery ? { turnId: recovery.turn.id, turnUpdatedAt: recovery.turn.updatedAt, only: recovery.only } : {}),
    };
    submissionRevision.current += 1;
    submitGroupSend(group.id, receipt, async () => {
      try {
      if (existing?.turnId) {
        const [status, recorded] = await Promise.all([waitForGroup(coworkerBridge.groups.status(group.id)), waitForGroup(coworkerBridge.groups.get(group.id))]);
        const turn = recorded.turns.find((turn) => turn.id === receipt.turnId);
        if (turn?.clientMessageId.startsWith("event:")) throw new Error("This event phase cannot be replayed. Use View event instead.");
        if (status.queue.some((item) => item.clientMessageId === receipt.clientMessageId) || (turn && turn.updatedAt > (receipt.turnUpdatedAt ?? receipt.at))) {
          voice.rebindExpected(voiceIntent, recovery?.turn.clientMessageId ?? receipt.clientMessageId);
          return { accepted: true };
        }
      }
      const result = await coworkerBridge.groups.submit(group.id, { text: receipt.text, clientMessageId: receipt.clientMessageId, context: receipt.context, turnId: receipt.turnId, only: receipt.only });
      submissionRevision.current += 1;
      if (result.accepted) voice.rebindExpected(voiceIntent, recovery?.turn.clientMessageId ?? receipt.clientMessageId);
      else voice.abandonReply(voiceIntent);
      return result;
      } catch (cause) {
        voice.abandonReply(voiceIntent);
        throw cause;
      }
    });
  }

  function resume(turn: CoworkerGroupTurn, only?: string): void {
    if (turn.clientMessageId.startsWith("event:")) {
      setError("This event phase cannot be replayed. Use View event instead.");
      return;
    }
    const existing = groupSends(group.id).find((item) => item.turnId === turn.id);
    if (existing && existing.state !== "failed" && existing.state !== "uncertain") return;
    jumpToLatest();
    setVoiceBaseline({ clientMessageId: turn.clientMessageId, updatedAt: turn.updatedAt, eventIds: events.filter((event) => event.turnId === turn.id).map((event) => event.id) });
    const voiceIntent = voice.expectReply(turn.clientMessageId);
    errorRevision.current += 1;
    setError("");
    startTurn(turn.prompt, existing?.clientMessageId ?? newId("resume"), { turn, only }, voiceIntent);
  }

  async function runAction<T>(key: string, action: () => Promise<T>, after?: (value: T) => void): Promise<void> {
    if (actionAttempts.current.get(key)?.state === "running") return;
    const revision = ++errorRevision.current;
    setError("");
    submissionRevision.current += 1;
    await runGroupAction(actionAttempts.current, key, action, (attempt) => {
      if (!mounted.current) return;
      setBusyActions((items) => [...items.filter((item) => item !== key), ...(attempt.state === "running" ? [key] : [])]);
      if (revision === errorRevision.current) setError(attempt.error ?? "");
    }, (value) => {
      submissionRevision.current += 1;
      after?.(value);
    });
  }

  function removeQueued(clientMessageId: string): void {
    if (isEventPhaseRequest(clientMessageId)) {
      setError("Use View event to inspect or cancel this event run; it is not an ordinary queued message.");
      return;
    }
    if (groupSends(group.id).find((item) => item.clientMessageId === clientMessageId)?.state === "pending") {
      changeGroupSends(group.id, (items) => items.map((item) => item.clientMessageId === clientMessageId ? { ...item, state: "cancelled" } : item));
      return;
    }
    if (!queue.some((item) => item.clientMessageId === clientMessageId)) return;
    void runAction(`remove:${clientMessageId}`, () => coworkerBridge.groups.removeQueued(group.id, clientMessageId), () => {
      changeGroupSends(group.id, (items) => items.map((item) => item.clientMessageId === clientMessageId ? { ...item, state: "cancelled", error: undefined } : item));
      setQueue((items) => items.filter((item) => item.clientMessageId !== clientMessageId));
    });
  }

  function send(): void {
    const text = message.trim();
    if (!active || !text || !runtime.engineManaged || group.archivedAt) return;
    if (members.length < (event || group.eventId ? 1 : 2)) {
      setError(event || group.eventId ? "This event needs a coworker who is still here." : "A group chat needs at least two coworkers who are still here.");
      return;
    }
    setMessage("");
    setMention(null);
    ++errorRevision.current;
    setError("");
    sendVoicedMessage(text, newId("m"));
    const mentions = parseMentions(text, members);
    for (const slug of mentions.everyone ? members.map((member) => member.slug) : mentions.slugs) acknowledgeCoworker(slug);
  }

  function sendVoicedMessage(text: string, clientMessageId: string): void {
    jumpToLatest();
    setVoiceBaseline(null);
    startTurn(text, clientMessageId, undefined, voice.expectReply(clientMessageId));
  }

  function rename(): void {
    const next = nameDraft.trim();
    setRenaming(false);
    if (!next || next === group.name) return;
    void runAction("rename", () => coworkerBridge.groups.update(group.id, { name: next }), (updated) => { if (mounted.current) onGroupChanged(updated); });
  }

  // --- an assignment from the group ------------------------------------------------
  /** Ask who should own it: the best match by role is proposed first; the person confirms. */
  function proposeAssignment(): void {
    if (eventId) { setError("Create this assignment in the owner's own chat. Event-chat assignment receipts are not supported yet."); return; }
    const outcome = assignment.trim();
    if (!active || group.archivedAt || !outcome || members.length === 0 || pendingAssignment || assignmentInFlight.current) return;
    setError("");
    setPendingAssignment({ outcome, suggested: chooseSpeakers(outcome, members, events)[0] ?? members[0]?.slug ?? "" });
  }

  /** Create the assignment in the owner's own workspace and link it from the timeline as one action line. */
  async function createAssignment(slug: string, outcome: string): Promise<void> {
    if (eventId || groupRef.current.eventId) { setError("Create this assignment in the owner's own chat. Event-chat assignment receipts are not supported yet."); return; }
    if (!activeRef.current || assignmentInFlight.current) return;
    const owner = coworkersRef.current.find((coworker) => coworker.slug === slug);
    if (!owner) return;
    assignmentInFlight.current = true;
    setAssignmentBusy(slug);
    setError("");
    try {
      const workspaceId = owner.workspaceId || (await coworkerBridge.coworkers.ensureWorkspace(slug)).workspaceId;
      if (!workspaceId) throw new Error(`${owner.name}'s workspace is not ready.`);
      const threads = createCoworkerThreads({ serverUrl: runtime.serverUrl, workspaceId, token: runtime.ownerToken, model: owner.model, modelVariant: owner.modelVariant });
      const title = assignmentTitle(outcome);
      const thread = await threads.client.createThread({ title });
      // The owner gets the visible group conversation, each line signed, never another coworker's reasoning or tools.
      const context: DiscussionMessage[] = eventsRef.current
        .filter((event) => event.kind === "user" || event.kind === "coworker")
        .map((event) => (event.kind === "user" ? { role: "user", text: event.text } : { role: "assistant", text: `${nameFor(event.slug ?? "")} said: ${event.text}` }));
      await threads.client.sendTurn(thread.id, { prompt: assignmentPrompt(outcome, context), messageId: newId("msg") });
      const line = await coworkerBridge.groups.appendEvent(group.id, { kind: "action", slug, action: "assignment", title, threadId: thread.id, text: `Assignment for ${owner.name} · ${title}` });
      publishGroupRun({ groupId: group.id, event: line });
      // Completion must not pull typing out of a document or another surface.
      if (activeRef.current && assignmentChoiceRef.current?.contains(document.activeElement)) composerRef.current?.focus({ preventScroll: true });
      setPendingAssignment(null);
      setAssignment((current) => current.trim() === outcome ? "" : current);
      setAssignmentMode(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      assignmentInFlight.current = false;
      setAssignmentBusy("");
    }
  }

  const ownerChoices = useMemo(() => {
    if (!pendingAssignment) return [];
    const ordered = [...members].sort((left, right) => Number(right.slug === pendingAssignment.suggested) - Number(left.slug === pendingAssignment.suggested));
    return ordered.map((member, index) => ({ letter: LETTERS[index] ?? String(index + 1), member, suggested: member.slug === pendingAssignment.suggested }));
  }, [members, pendingAssignment]);

  function dismissAssignment(): void {
    if (assignmentInFlight.current) return;
    setPendingAssignment(null);
    if (activeRef.current) composerRef.current?.focus();
  }

  useEffect(() => {
    if (!active || !pendingAssignment) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.repeat || assignmentInFlight.current || typingInField(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      if (!(event.target instanceof Node) || !assignmentChoiceRef.current?.contains(event.target)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        dismissAssignment();
        return;
      }
      const choice = ownerChoices.find((item) => item.letter === event.key.toUpperCase());
      if (!choice || assignmentBusy) return;
      event.preventDefault();
      void createAssignment(choice.member.slug, pendingAssignment.outcome);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  // --- @ mentions in the composer -------------------------------------------------
  const mentionOptions = useMemo((): MentionOption[] => {
    if (!mention) return [];
    const options: MentionOption[] = mentionCandidates(mention.query, members).map((member) => {
      const first = member.name.split(/\s+/)[0] ?? member.slug;
      const unique = members.filter((other) => (other.name.split(/\s+/)[0] ?? "").toLowerCase() === first.toLowerCase()).length === 1;
      return { handle: unique ? first : member.slug, label: member.name, detail: member.role, member: members.find((item) => item.slug === member.slug) ?? null };
    });
    if ("everyone".startsWith(mention.query.toLowerCase())) options.push({ handle: "everyone", label: "everyone", detail: "Ask all of them", member: null });
    return options;
  }, [members, mention]);

  function updateMention(value: string, caret: number): void {
    const found = mentionAtCaret(value, caret);
    setMention((current) => (found ? { start: found.start, query: found.query, index: current && current.start === found.start ? Math.min(current.index, Math.max(0, mentionCandidates(found.query, members).length)) : 0 } : null));
  }

  function insertMention(option: MentionOption): void {
    if (!mention) return;
    const field = composerRef.current;
    const caret = field?.selectionStart ?? message.length;
    const next = `${message.slice(0, mention.start)}@${option.handle} ${message.slice(caret)}`;
    setMessage(next);
    setMention(null);
    const position = mention.start + option.handle.length + 2;
    requestAnimationFrame(() => {
      if (activeRef.current && document.activeElement === field) field?.setSelectionRange(position, position);
    });
  }

  const latestTurn = group.turns.at(-1) ?? null;
  const voiceTurn = !live && !activityError && latestTurn && (!voiceBaseline || latestTurn.clientMessageId !== voiceBaseline.clientMessageId || latestTurn.updatedAt > voiceBaseline.updatedAt) ? latestTurn : null;
  const spokenReply = useMemo(() => groupVoiceReply(voiceTurn, events, nameFor, voiceBaseline?.eventIds), [voiceTurn, events, nameFor, voiceBaseline?.eventIds]);
  const voice = useVoice({
    active: active && !assignmentMode && !sharedDocument && !group.archivedAt,
    scope: `group:${group.id}`,
    onTranscript: (text) => { setMessage((draft) => appendVoiceDraft(draft, text)); setMention(null); },
    reply: spokenReply,
    endedTurn: voiceTurn && (["failed", "stopped"].includes(voiceTurn.status) || (["succeeded", "partial"].includes(voiceTurn.status) && (!voiceTurn.speakers.some((speaker) => speaker.status === "succeeded") || (!spokenReply && groupVoiceReply(voiceTurn, events, nameFor))))) ? voiceTurn.clientMessageId : null,
  });
  function stopGroup() { voice.stop("Audio stopped. Your text conversation is kept."); void runAction("stop", () => stopGroupRun(group.id)); }
  const recoveryBusy = localSends.some((item) => item.turnId && (item.state === "pending" || item.state === "sending" || item.state === "accepted"));
  const recoverable = loaded && !activityError && !live && latestTurn && unfinishedSpeakers(latestTurn).length > 0 ? latestTurn : null;
  const unfinished = recoverable ? unfinishedSpeakers(recoverable) : [];
  const eventPhaseRecovery = recoverable && isEventPhaseRequest(recoverable.clientMessageId);
  const showContinue = recoverable && !eventPhaseRecovery && !(unfinished.length === 1 && unfinished[0]?.status === "failed");
  const waiting = receipts.some((receipt) => ["waiting", "waiting-person", "resumption-queued"].includes(receipt.state));
  const presentation = useMemo(() => describeGroupPresentation({ events, executions, interactions, active: live, turn: liveTurn, nameFor, unavailable: Boolean(activityError) || !loaded }), [events, executions, interactions, live, liveTurn, nameFor, activityError, loaded]);
  const statusLine = activityError ? "Reconnecting to activity" : localSends.some((item) => item.state === "uncertain") ? "Checking message confirmation" : sending ? "Sending…" : interactions.length || executions.length || live ? presentation.line : waiting ? "Waiting for requested work" : !loaded || !receiptsLoaded || observed.groupId !== group.id ? "Checking activity" : localSends.some((item) => item.state === "accepted") ? "Message accepted" : "Ready";
  const activeSlugs = presentation.activeSlugs;
  const rows = useMemo(() => groupConversationRows(events, executions, localSends), [events, executions, localSends]);
  const viewEvent = eventId && onOpenEvent ? <button type="button" className="font-medium text-snow/80 underline-offset-2 hover:underline" onClick={() => onOpenEvent(eventId)} data-testid="group-event-phase-link">View event</button> : null;

  return (
    <div className="glass-main flex h-full min-w-0 flex-1" data-testid="group-chat" data-group-id={group.id} data-live={live ? "true" : "false"}>
      <div className="flex min-w-0 flex-1 flex-col" data-testid="group-conversation">
      <header className="glass-header window-drag flex min-h-[78px] shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-3" data-testid="conversation-header">
        <GroupAvatars members={members} size={30} activeSlugs={activeSlugs} gatherKey={active ? group.id : undefined} />
        <div className="min-w-0 flex-[1_1_10rem]">
          {renaming ? (
            <input
              autoFocus
              aria-label="Group name"
              data-testid="group-name-input"
              className="window-no-drag h-7 w-full max-w-xs rounded-lg border border-line bg-black/18 px-2 text-sm font-semibold text-snow outline-none focus:border-spark/50"
              value={nameDraft}
              onChange={(event) => setNameDraft(event.target.value)}
              onBlur={() => void rename()}
              onKeyDown={(event) => {
                if (event.key === "Enter") void rename();
                if (event.key === "Escape") setRenaming(false);
              }}
            />
          ) : (
            <h1 className="whitespace-normal text-sm font-semibold text-snow [overflow-wrap:anywhere]" data-testid="group-name">{event?.title ?? group.name}</h1>
          )}
          <p className="whitespace-normal text-xs text-mist [overflow-wrap:anywhere]" data-testid="conversation-header-title">{members.map((member) => member.name).join(", ")}</p>
        </div>
        <div className="window-no-drag flex shrink-0 items-center gap-1" data-testid="conversation-header-actions">
          {eventId && onOpenEvent ? <Button variant="ghost" onClick={() => onOpenEvent(eventId)} data-testid="event-conversation-backlink">View event</Button> : null}
          {documentsApi ? <Button variant="ghost" onClick={() => setSharedDocument({ groupId: group.id, id: "" })} data-testid="group-shared-documents">Shared documents</Button> : null}
          {live ? <Button variant="ghost" disabled={busyActions.includes("stop")} onClick={stopGroup}>{busyActions.includes("stop") ? "Stopping…" : actionAttempts.current.get("stop")?.state === "retryable" ? "Retry stop" : "Stop all"}</Button> : null}
          {!event && !group.eventId ? <ActionMenu
            label="Group chat options"
            items={[
              { label: "Rename", onSelect: () => { setNameDraft(group.name); setRenaming(true); } },
              ...(onOpenDetails ? [{ label: "Group details", onSelect: onOpenDetails }] : []),
              { label: "Archive", tone: "danger", disabled: live || sending || busyActions.includes("archive"), onSelect: () => void runAction("archive", () => coworkerBridge.groups.archive(group.id), (archived) => { if (mounted.current) onGroupArchived(archived); }) },
            ]}
          /> : null}
        </div>
        {/* One plain line, no dot: who is replying, or Ready. */}
        <span data-testid="coworker-top-status" data-tone={statusLine === "Ready" ? "ready" : "mist"} className={`min-w-0 max-w-full whitespace-normal text-xs [overflow-wrap:anywhere] ${statusLine === "Ready" ? "text-ready" : "text-mist"}`}>
          {statusLine}
        </span>
      </header>
      {event || group.eventId ? <p className="border-b border-line/60 px-5 py-2 text-[11px] text-mist">Event conversation. Change participants and future sessions in the event editor. {group.archivedAt ? "This conversation is archived; its history is kept." : ""}</p> : null}
      <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} style={{ overflowAnchor: "none" }} className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <div ref={contentRef} className="mx-auto max-w-3xl space-y-3">
          {introduction}
          {observed.groupId !== group.id && !activityError ? <p role="status" className="text-xs text-mist">Loading conversation…</p> : null}
          {loaded && observed.groupId === group.id && rows.length === 0 && !introduction ? (
            <div className="mx-auto flex h-full max-w-md flex-col items-center justify-center py-10 text-center" data-testid="group-chat-empty">
              <GroupAvatars members={members} size={40} animated={false} />
              <p className="mt-3 text-sm font-semibold text-snow">{group.name}</p>
              <p className="mt-0.5 text-xs text-mist">{members.map((member) => member.name).join(", ")}</p>
              <p className="mt-4 text-sm text-mist">What should we work through together? Name a coworker with @ to choose who answers.</p>
            </div>
          ) : null}
          {rows.map((row, index) => {
            if ("execution" in row) {
              const execution = row.execution;
              const member = coworkers.find((coworker) => coworker.slug === execution.slug);
              return member ? <GroupExecutionRow key={`execution:${execution.executionId}:${execution.threadId}:${execution.messageId}:${execution.slug}`} activity={execution} coworker={member} runtime={runtime} unavailable={Boolean(activityError) || !loaded} waiting={interactions.some((entry) => entry.executionId === execution.executionId)} /> : null;
            }
            const { event, delivery } = row;
            const previousRow = rows[index - 1];
            const nextRow = rows[index + 1];
            const previous = previousRow && "event" in previousRow ? previousRow.event : undefined;
            const next = nextRow && "event" in nextRow ? nextRow.event : undefined;
            const key = groupMessageKey(event);
            const sameSpeaker = (other: GroupTimelineEvent | undefined) => Boolean(other && other.kind === event.kind && other.slug === event.slug);
            const continued = sameSpeaker(previous) && event.at - (previous?.at ?? 0) < 5 * 60_000;
            const tail = !sameSpeaker(next);
            const label = timeLabelBetween(previous?.at, event.at);
            if (event.kind === "status") {
              // A quiet line. When it is about a speaker of the latest unfinished turn, it also offers the fix.
              const speaker = recoverable && event.turnId === recoverable.id ? unfinished.find((entry) => entry.slug === event.slug) : undefined;
              const failure = speaker ? describeSpeakerFailure(speaker.error, nameFor(speaker.slug)) : null;
              return (
                <p key={key} className="flex flex-wrap items-center justify-center gap-x-3 px-12 text-center text-[11px] text-mist" data-testid="group-status" data-status={event.status} data-speaker={event.slug} data-error={speaker?.error}>
                  {documentsApi && "documentId" in event && typeof event.documentId === "string" ? <button type="button" className="text-spark hover:underline" onClick={() => setSharedDocument({ groupId: group.id, id: String(event.documentId) })}>{event.text}</button> : <span title={speaker?.error && speaker.error !== event.text ? speaker.error : undefined}>{event.text}</span>}
                  {speaker && recoverable ? eventPhaseRecovery ? viewEvent : (
                    <span className="flex items-center gap-x-3">
                      <button type="button" disabled={recoveryBusy} className="font-medium text-snow/80 underline-offset-2 hover:underline disabled:opacity-50" data-testid="group-speaker-retry" data-speaker={speaker.slug} onClick={() => resume(recoverable, speaker.slug)}>Continue</button>
                      {failure?.modelRelated ? (
                        <button type="button" className="font-medium text-snow/80 underline-offset-2 hover:underline" onClick={() => onChooseModel(speaker.slug)}>Choose AI model</button>
                      ) : null}
                    </span>
                  ) : null}
                </p>
              );
            }
            if (event.kind === "action") {
              const open = onOpenAssignment && event.slug && event.threadId ? () => onOpenAssignment(event.slug ?? "", event.threadId ?? "") : null;
              return (
                <div key={key} className="flex justify-center py-0.5" data-testid="group-action-line" data-action={event.action} data-speaker={event.slug} data-thread-id={event.threadId}>
                  {open ? (
                    <button type="button" className="rounded-full border border-line/70 px-3 py-1 text-[11px] text-mist transition-colors hover:border-spark/40 hover:text-snow" onClick={open}>{event.text}</button>
                  ) : (
                    <span className="rounded-full border border-line/70 px-3 py-1 text-[11px] text-mist">{event.text}</span>
                  )}
                </div>
              );
            }
            if (event.kind === "user") {
              const queued = queue.some((item) => item.clientMessageId === event.clientMessageId);
              const eventPhase = isEventPhaseRequest(delivery?.clientMessageId ?? event.clientMessageId, delivery?.turnId ?? event.turnId);
              return (
                <div key={key} data-scroll-anchor={key} data-client-message-id={event.clientMessageId} data-delivery-state={delivery?.state ?? "recorded"}>
                  {label ? <p className="pb-1 pt-2 text-center text-[11px] font-medium text-mist/80" data-testid="group-time-label">{label}</p> : null}
                  <div className={`flex justify-end ${continued ? "-mt-1.5" : ""}`} data-message-role="user" data-continued={continued ? "true" : "false"}>
                    <div className={`bubble bubble-user max-w-[72%] whitespace-pre-wrap ${tail ? "bubble-tail-right" : ""}`} title={timeLabel(event.at)}>
                      {event.text}
                    </div>
                  </div>
                  {delivery ? <div className="mt-1 flex flex-wrap items-center justify-end gap-x-3 gap-y-1 px-2 text-[11px] text-mist" role="status" data-testid={queued ? "group-queued" : delivery.state === "failed" || delivery.state === "uncertain" ? "group-turn-failed" : "group-send-receipt"}>
                    <span>{eventPhase ? "Managed event phase; its run record owns the status" : queued ? "Next" : delivery.state === "pending" ? "Waiting to send" : delivery.state === "sending" ? "Sending…" : delivery.state === "accepted" ? "Accepted" : delivery.state === "cancelled" ? "Removed from queue" : delivery.state === "uncertain" ? "Confirmation delayed. Checking records." : "Could not send"}</span>
                    {delivery.error ? <span className="max-w-prose [overflow-wrap:anywhere]">{delivery.error}</span> : null}
                    {eventPhase ? viewEvent : delivery.state === "failed" || delivery.state === "uncertain" ? <button type="button" className="font-medium text-snow/80 underline-offset-2 hover:underline" onClick={() => sendVoicedMessage(delivery.text, delivery.clientMessageId)}>Retry</button> : null}
                    {!eventPhase && (queued || delivery.state === "pending") ? <button type="button" disabled={busyActions.includes(`remove:${delivery.clientMessageId}`)} className="text-mist underline disabled:opacity-50" aria-label="Do not send this" onClick={() => removeQueued(delivery.clientMessageId)}>{busyActions.includes(`remove:${delivery.clientMessageId}`) ? "Removing…" : actionAttempts.current.get(`remove:${delivery.clientMessageId}`)?.state === "retryable" ? "Retry remove" : "Remove"}</button> : null}
                  </div> : null}
                </div>
              );
            }
            // In a group, each reply is signed: a small avatar at the tail and the name once per run.
            const speaker = coworkers.find((coworker) => coworker.slug === event.slug);
            return (
              <div key={key} data-scroll-anchor={key} data-execution-id={event.executionId}>
                {label ? <p className="pb-1 pt-2 text-center text-[11px] font-medium text-mist/80" data-testid="group-time-label">{label}</p> : null}
                <div className={`flex items-end gap-2 ${continued ? "-mt-1.5" : ""}`} data-message-role="assistant" data-speaker={event.slug} data-continued={continued ? "true" : "false"}>
                  <span className="w-6 shrink-0">
                    {tail && speaker ? <CoworkerAvatar identity={speaker.slug} animated={false} motion="quiet" gaze={false} color={speaker.avatarColor} glasses={speaker.avatarGlasses} name={speaker.name} size={24} /> : null}
                  </span>
                  <div className="min-w-0 max-w-[76%]">
                    {!continued ? <p className="mb-0.5 px-2 text-[11px] font-medium text-mist" data-testid="group-speaker-name">{nameFor(event.slug ?? "")}</p> : null}
                    <div className={`bubble bubble-coworker [overflow-wrap:anywhere] ${tail ? "bubble-tail-left" : ""}`} title={timeLabel(event.at)}>
                      <Markdown text={event.text} className="overflow-x-auto" />
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
          <CollaborationReceipts receipts={receipts} canRetry={(receipt) => !receipt.eventRunId && !events.some((entry) => entry.executionId === receipt.id && isEventPhaseRequest(entry.clientMessageId, entry.turnId))} retryUnavailable={viewEvent} />
          {interactions.map((entry) => {
            const member = members.find((member) => member.slug === entry.slug);
            if (!member) return null;
            const binding = { groupId: group.id, executionId: entry.executionId, workspaceId: entry.workspaceId, threadId: entry.threadId, slug: entry.slug };
            return <div key={entry.executionId} data-testid="group-waiting-person" data-execution-id={entry.executionId} data-thread-id={entry.threadId} data-speaker={entry.slug}>
              <p className="mb-2 text-xs text-mist">{member.name} is waiting for your permission or answer.</p>
              <InteractionCards coworker={member} pending={entry.pending} keyboardShortcuts={false}
                onPermission={async (request, reply) => { await waitForGroup(coworkerBridge.groups.replyInteraction({ ...binding, kind: "permission", requestId: request.id, reply })); }}
                onAnswer={async (request, answers) => { await waitForGroup(coworkerBridge.groups.replyInteraction({ ...binding, kind: "question", requestId: request.id, answers })); }}
                onSkip={async (request) => { await waitForGroup(coworkerBridge.groups.replyInteraction({ ...binding, kind: "question", requestId: request.id, reply: "reject" })); }} />
              <button type="button" disabled={busyActions.includes(entry.executionId)} className="mt-2 text-xs text-mist underline disabled:opacity-50" onClick={() => void runAction(entry.executionId, () => coworkerBridge.collaboration.cancel(entry.executionId))}>{actionAttempts.current.get(entry.executionId)?.state === "retryable" ? "Retry stopping" : "Stop"} {member.name}'s step</button>
            </div>;
          })}
          {live && executions.length === 0 && interactions.length === 0 ? <p className="px-1 text-[11px] text-mist [overflow-wrap:anywhere]" data-testid="group-progress-phrase">{statusLine}</p> : null}
          {eventPhaseRecovery ? <div className="flex flex-wrap items-center justify-center gap-3 text-[11px] text-mist" data-testid="group-event-phase-recovery"><span>This event phase cannot be replayed. Its accepted run and results are kept.</span>{viewEvent}</div> : null}
          {showContinue && recoverable ? (
            <div className="flex items-center justify-center gap-3 text-[11px] text-mist" data-testid="group-turn-recovery" data-turn-id={recoverable.id}>
              <span>{listNames(unfinished.map((speaker) => nameFor(speaker.slug)))} still to reply</span>
              <button type="button" disabled={recoveryBusy} className="font-medium text-snow/80 underline-offset-2 hover:underline disabled:opacity-50" data-testid="group-turn-continue" onClick={() => resume(recoverable)}>Continue</button>
            </div>
          ) : null}
          {localSends.filter((item) => item.turnId).map((item) => isEventPhaseRequest(item.clientMessageId, item.turnId) ? <div key={item.clientMessageId} className="flex flex-wrap items-center justify-center gap-3 text-[11px] text-mist" role="status" data-testid="group-event-phase-receipt"><span>Event phase replay is unavailable; inspect its recorded run.</span>{viewEvent}</div> : <div key={item.clientMessageId} className="flex items-center justify-center gap-3 text-[11px] text-mist" role="status" data-testid="group-recovery-receipt">
            <span>{item.state === "failed" || item.state === "uncertain" ? "Continue could not be confirmed" : item.state === "accepted" ? "Continue accepted" : "Requesting Continue…"}{item.error ? `: ${item.error}` : ""}</span>
            {item.state === "failed" || item.state === "uncertain" ? <button type="button" className="font-medium text-snow/80 underline-offset-2 hover:underline" onClick={() => { const turn = group.turns.find((turn) => turn.id === item.turnId); if (turn) resume(turn, item.only); }}>Retry Continue</button> : null}
          </div>)}
          {pendingAssignment ? (
            <div ref={assignmentChoiceRef} tabIndex={-1} role="group" aria-label="Choose an assignment owner" className="outline-none" data-testid="group-assignment-choice">
            <InteractionCard label="Who should own this assignment" title="Who should own this?" detail={pendingAssignment.outcome} onClose={assignmentBusy ? undefined : dismissAssignment} testId="group-assignment-owner">
              {assignmentBusy ? <p role="status" className="mt-2 text-xs text-mist">Creating assignment for {nameFor(assignmentBusy)}…</p> : null}
              <div className="mt-3 divide-y divide-line/70 rounded-xl border border-line/70" role="listbox" aria-label="Owner">
                {ownerChoices.map((choice) => (
                  <OptionRow
                    key={choice.member.slug}
                    letter={choice.letter}
                    label={assignmentBusy === choice.member.slug ? `${choice.member.name}…` : choice.member.name}
                    description={[choice.member.role, choice.suggested ? "Suggested" : ""].filter(Boolean).join(" · ")}
                    active={choice.suggested}
                    disabled={Boolean(assignmentBusy)}
                    onChoose={() => void createAssignment(choice.member.slug, pendingAssignment.outcome)}
                  />
                ))}
              </div>
            </InteractionCard>
            </div>
          ) : null}
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          {activityError ? <ErrorNote>{activityError}</ErrorNote> : null}
        </div>
      </div>
      {active && away && !pendingAssignment ? <JumpToLatest onClick={jumpToLatest} /> : null}
      </div>
      <div className="px-5 pb-4 pt-2" data-testid="coworker-composer">
        <div className="mx-auto max-w-3xl">
          {assignmentMode ? (
            <p className="mb-2 px-2 text-[11px] text-mist" data-testid="group-assignment-mode">Something one of them should own, separate from this chat</p>
          ) : null}
          <div className={`relative rounded-[24px] border bg-panel/60 p-3 transition-colors focus-within:border-spark/50 ${assignmentMode ? "border-spark/35" : "border-line"}`} data-testid="coworker-input-surface">
            {!assignmentMode ? <VoicePanel voice={voice} /> : null}
            {mention && mentionOptions.length > 0 && !assignmentMode ? (
              <ul
                role="listbox"
                aria-label="Coworkers to name"
                data-testid="group-mention-menu"
                className="absolute bottom-full left-3 z-30 mb-1.5 min-w-48 overflow-hidden rounded-xl border border-line bg-[#0d121b] py-1 text-left"
              >
                {mentionOptions.map((option, index) => (
                  <li key={option.handle}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={index === mention.index}
                      data-testid="group-mention-option"
                      data-handle={option.handle}
                      className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-xs transition-colors hover:bg-white/6 ${index === mention.index ? "bg-white/8" : ""}`}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => insertMention(option)}
                    >
                      {option.member ? <CoworkerAvatar identity={option.member.slug} motion="quiet" gaze={false} color={option.member.avatarColor} glasses={option.member.avatarGlasses} name={option.member.name} size={18} /> : <span className="flex size-[18px] items-center justify-center rounded-full border border-line text-[10px] text-mist">@</span>}
                      <span className="text-snow">{option.label}</span>
                      {option.detail ? <span className="truncate text-mist">{option.detail}</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <div>
              <textarea
                ref={(element) => { composerRef.current = element; voice.fieldRef.current = element; }}
                aria-label={assignmentMode ? "Assignment outcome" : `Message ${group.name}`}
                data-testid="group-composer"
                rows={1}
                className="block min-h-[56px] w-full resize-none bg-transparent px-1 pb-3 pt-1 text-sm leading-relaxed text-snow outline-none placeholder:text-mist/65"
                placeholder={assignmentMode ? "What should one of them own?" : `Message ${members.map((member) => member.name).join(", ")}`}
                value={assignmentMode ? assignment : message}
                disabled={!runtime.engineManaged || Boolean(group.archivedAt)}
                onChange={(event) => {
                  if (assignmentMode) {
                    setAssignment(event.target.value);
                    return;
                  }
                  setMessage(event.target.value);
                  updateMention(event.target.value, event.target.selectionStart ?? event.target.value.length);
                }}
                onClick={(event) => !assignmentMode && updateMention(event.currentTarget.value, event.currentTarget.selectionStart ?? 0)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                  if (event.key === "Enter" && event.shiftKey) return;
                  if (assignmentMode) {
                    if (event.key === "Enter" && !event.repeat) {
                      event.preventDefault();
                      proposeAssignment();
                    }
                    return;
                  }
                  if (mention && mentionOptions.length > 0) {
                    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                      event.preventDefault();
                      const step = event.key === "ArrowDown" ? 1 : -1;
                      setMention({ ...mention, index: (mention.index + step + mentionOptions.length) % mentionOptions.length });
                      return;
                    }
                    if (!event.shiftKey && (event.key === "Enter" || event.key === "Tab")) {
                      event.preventDefault();
                      const option = mentionOptions[mention.index] ?? mentionOptions[0];
                      if (option) insertMention(option);
                      return;
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setMention(null);
                      return;
                    }
                  }
                  if (event.key === "Enter" && !event.repeat) {
                    event.preventDefault();
                    send();
                  }
                }}
              />
              <div className="flex items-center gap-2" data-testid="coworker-composer-actions">
                {!eventId ? <button
                  type="button"
                  aria-pressed={assignmentMode}
                  disabled={Boolean(assignmentBusy) || Boolean(group.archivedAt)}
                  data-testid="group-assignment-toggle"
                  className={`flex size-8 shrink-0 items-center justify-center rounded-full border text-lg leading-none transition-colors ${
                    assignmentMode ? "border-spark/50 bg-spark/15 text-spark" : "border-line text-mist hover:border-spark/40 hover:text-snow"
                  }`}
                  title={assignmentMode ? "Back to chat" : "Create assignment"}
                  onClick={() => {
                    setAssignmentMode((current) => !current);
                    setPendingAssignment(null);
                    requestAnimationFrame(() => composerRef.current?.focus());
                  }}
                >
                  <PlusIcon className={`size-4 transition-transform ${assignmentMode ? "rotate-45" : ""}`} />
                  <span className="sr-only">{assignmentMode ? "Back to chat" : "Create assignment"}</span>
                </button> : null}
                {!assignmentMode ? <VoiceToggle voice={voice} disabled={!runtime.engineManaged || Boolean(group.archivedAt)} /> : null}
                <span className="min-w-0 flex-1 text-[11px] text-mist/75">{assignmentMode ? "Create an assignment" : "@name to choose who answers"}</span>
                {live && !assignmentMode ? <Button variant="ghost" disabled={busyActions.includes("stop")} className="mb-0.5 rounded-full px-3 py-1 text-xs" onClick={stopGroup}>{busyActions.includes("stop") ? "Stopping…" : actionAttempts.current.get("stop")?.state === "retryable" ? "Retry stop" : "Stop"}</Button> : null}
                {assignmentMode ? (
                  <SendButton label="Create assignment" busy={false} disabled={!assignment.trim() || !runtime.engineManaged || Boolean(pendingAssignment) || Boolean(group.archivedAt)} onClick={proposeAssignment} testId="group-send" />
                ) : (
                  <SendButton label={live || sending ? "Next" : "Send"} busy={false} disabled={!message.trim() || !runtime.engineManaged || Boolean(group.archivedAt)} onClick={send} testId="group-send" />
                )}
              </div>
            </div>
          </div>
          {eventId ? <p className="mt-2 px-2 text-[11px] text-mist" data-testid="event-assignment-unavailable">Create assignments in a coworker's own chat for now. Event-chat assignment receipts are not yet supported; ordinary follow-up messages still work here.</p> : null}
          <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-2 text-[10px] text-mist/65">
            <p className="min-w-0 truncate">
              {assignmentMode ? "Enter to choose who owns it · Shift Enter for a new line" : "Enter to send · Shift Enter for a new line · @name chooses who answers, @everyone asks all"}
            </p>
            {/* What the members hold between them; the line stays away while nobody holds anything. */}
            <SummaryLine summary={holdings} />
          </div>
        </div>
      </div>
      </div>
      {documentsApi && sharedDocument?.groupId === group.id ? <GroupDocuments api={documentsApi} groupId={group.id} openId={sharedDocument.id} onClose={() => setSharedDocument(null)} /> : null}
    </div>
  );
}
