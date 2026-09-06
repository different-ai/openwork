import { useComposerDraft } from "@/ui/use-composer-draft";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { coworkerBridge, type CollaborationReceipt, type CoworkerGroupSummary, type CoworkerGroupTurn, type CoworkerSummary, type GroupTimelineEvent, type RuntimeInfo } from "@/lib/bridge";
import { assignmentPrompt, assignmentTitle, timeLabelBetween, type DiscussionMessage } from "@/lib/conversation";
import { combineSummaryLines, describeCoworkerSummary, type CoworkerSummaryLine } from "@/lib/coworker-summary";
import { classifyThreads, discussionIds, loadDiscussionRegistry } from "@/lib/discussions";
import { lastDocumentsOpened } from "@/ui/documents";
import {
  publishGroupRun,
  stopGroupRun,
  type QueuedGroupMessage,
} from "@/lib/group-runs";
import {
  chooseSpeakers,
  describeGroupActivity,
  describeSpeakerFailure,
  describeTurnProgress,
  listNames,
  mentionCandidates,
  unfinishedSpeakers,
  type GroupParticipant,
} from "@/lib/groups";
import { createCoworkerThreads } from "@/lib/threads";
import { executionProgress, type ExecutionActivity } from "@/lib/progress-activity";
import { PROGRESS_LIMITS } from "@/lib/progress-config";
import { LiveRow } from "@/ui/live-row";
import { CoworkerAvatar } from "@/ui/coworker-avatar";
import { GroupAvatars } from "@/ui/coworker-rail";
import { InteractionCard, LETTERS, OptionRow, typingInField } from "@/ui/interactions";
import { ActionMenu, Button, ErrorNote, PlusIcon } from "@/ui/kit";
import { CollaborationReceipts, SendButton, SummaryLine } from "@/ui/threads";
import { useAutoGrow } from "@/ui/use-auto-grow";

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
    const read = async () => {
      const lines = await Promise.all(members.map(async (member) => {
        const [workers, scheduled, documents, registry] = await Promise.all([
          coworkerBridge.workers.list(member.slug).catch(() => []),
          coworkerBridge.localResponsibilities.list(member.slug).catch(() => []),
          coworkerBridge.documents.list(member.slug).catch(() => []),
          loadDiscussionRegistry(member.slug).catch((): string[] => []),
        ]);
        const all = member.workspaceId && runtime.engineManaged
          ? await createCoworkerThreads({ serverUrl: runtime.serverUrl, workspaceId: member.workspaceId, token: runtime.ownerToken }).listAllThreads().catch(() => [])
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
function GroupExecutionRow({ activity, coworker, runtime }: { activity: ExecutionActivity; coworker: CoworkerSummary; runtime: RuntimeInfo }) {
  const currentRef = useRef(activity);
  currentRef.current = activity;
  const [streamed, setStreamed] = useState<Array<{ messageId: string; id: string; text: string }>>([]);
  useEffect(() => {
    if (!coworker.workspaceId || !runtime.engineManaged) return;
    const controller = new AbortController();
    const approved = new Set<string>();
    const parts = new Map<string, { messageId: string; id: string; text: string }>();
    const client = createOpencodeClient({ baseUrl: `${runtime.serverUrl}/workspace/${encodeURIComponent(coworker.workspaceId)}/opencode`, headers: { Authorization: `Bearer ${runtime.ownerToken}` }, redirect: "error" });
    const accepts = (messageId: string) => approved.has(messageId) || currentRef.current.replies.some((reply) => reply.id === messageId && reply.parentId === activity.messageId);
    const keep = (messageId: string, id: string, text: string) => {
      const key = `${messageId}:${id}`;
      if (!parts.has(key) && parts.size >= PROGRESS_LIMITS.maxReplyParts) return;
      const used = [...parts].reduce((size, [other, part]) => size + (other === key ? 0 : part.text.length), 0);
      parts.set(key, { messageId, id, text: text.slice(0, Math.max(0, PROGRESS_LIMITS.maxReplyChars - used)) });
      setStreamed([...parts.values()]);
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
              parts.delete(`${part.messageID}:${part.id}`);
              setStreamed([...parts.values()]);
              continue;
            }
            const current = parts.get(`${part.messageID}:${part.id}`);
            keep(part.messageID, part.id, part.time?.end === undefined && current && current.text.length > part.text.length ? current.text : part.text);
          } else if (event.type === "message.part.delta") {
            const part = event.properties;
            if (part.sessionID !== activity.threadId || !accepts(part.messageID) || part.field !== "text") continue;
            // Deltas cannot establish that a part is visible text. Require an announced or projected text part.
            const known = parts.get(`${part.messageID}:${part.partID}`) ?? currentRef.current.replies.find((reply) => reply.id === part.messageID)?.parts.find((item) => item.id === part.partID);
            if (known) keep(part.messageID, part.partID, known.text + part.delta);
          }
        }
      } catch { /* The bounded snapshot poll remains authoritative when live events disconnect. */ }
    })();
    return () => { controller.abort(); };
  }, [activity.executionId, activity.messageId, activity.threadId, coworker.workspaceId, runtime.engineManaged, runtime.ownerToken, runtime.serverUrl]);

  const replies = new Map<string, Map<string, string>>();
  for (const reply of activity.replies) replies.set(reply.id, new Map(reply.parts.map((part) => [part.id, part.text])));
  for (const part of streamed) {
    const parts = replies.get(part.messageId) ?? new Map<string, string>();
    if (part.text.length > (parts.get(part.id)?.length ?? 0)) parts.set(part.id, part.text);
    replies.set(part.messageId, parts);
  }
  const text = [...replies.values()].map((parts) => [...parts.values()].join("")).filter(Boolean).join("\n").slice(0, PROGRESS_LIMITS.maxReplyChars);
  const progress = executionProgress(activity, Boolean(text.trim()));
  return <div className="min-w-0" data-testid="group-working" data-execution-id={activity.executionId} data-message-id={activity.messageId} data-thread-id={activity.threadId} data-speaker={activity.slug}>
    <p className="mb-1 px-2 text-[11px] font-medium text-mist [overflow-wrap:anywhere]" data-testid="group-speaker-name">{coworker.name}</p>
    {text ? <div className="flex min-w-0 items-end gap-2" data-message-role="assistant" data-live="true">
      <span className="shrink-0"><CoworkerAvatar animated={false} color={coworker.avatarColor} glasses={coworker.avatarGlasses} name={coworker.name} size={24} /></span>
      <div className="bubble bubble-coworker bubble-tail-left min-w-0 max-w-[76%] whitespace-pre-wrap [overflow-wrap:anywhere]" data-testid="group-live-reply">{text}</div>
    </div> : null}
    <LiveRow coworker={coworker} progress={progress} phase={text ? "writing" : "thinking"} wordsArrived={Boolean(text)} />
  </div>;
}

/**
 * A group chat: the person and several coworkers in one conversation. Each
 * reply is a real turn in that coworker's own workspace on a group-specific
 * discussion thread; the group only ever sees the visible text. Every turn is
 * a record in the group's store, so the view renders what is persisted.
 */
export function GroupChat({
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
  briefing,
  onRememberFocus,
}: {
  active?: boolean;
  introduction?: ReactNode;
  briefing?: { enabled: boolean; context: string; request: { id: string; text: string } | null };
  onRememberFocus?: (focus: string) => Promise<void>;
  group: CoworkerGroupSummary;
  coworkers: CoworkerSummary[];
  runtime: RuntimeInfo;
  onGroupChanged: (group: CoworkerGroupSummary) => void;
  onGroupArchived: (group: CoworkerGroupSummary) => void;
  /** One plain line describing the latest activity, for the rail. */
  onActivityLine: (id: string, line: string) => void;
  /** Open one coworker's AI model setting, the fix for a model-related failure. */
  onChooseModel: (slug: string) => void;
  /** Open the group's details (members, facilitator, archive). */
  onOpenDetails?: () => void;
  /** Open an assignment a group created, in its owner's view. */
  onOpenAssignment?: (slug: string, threadId: string) => void;
}) {
  const [observed, setObserved] = useState<{ groupId: string; timeline: GroupTimelineEvent[]; executions: ExecutionActivity[] }>({ groupId: "", timeline: [], executions: [] });
  const events = observed.groupId === group.id ? observed.timeline : [];
  const executions = observed.groupId === group.id ? observed.executions : [];
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useComposerDraft(`group:${group.id}`);
  const [live, setLive] = useState(false);
  const [liveTurn, setLiveTurn] = useState<CoworkerGroupTurn | null>(null);
  const [queue, setQueue] = useState<QueuedGroupMessage[]>([]);
  const [receipts, setReceipts] = useState<CollaborationReceipt[]>([]);
  const [failedSend, setFailedSend] = useState<{ text: string; clientMessageId: string; error: string } | null>(null);
  const [error, setError] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(group.name);
  const [mention, setMention] = useState<{ start: number; query: string; index: number } | null>(null);
  /** The composer turned towards an assignment: what someone should own, then who. */
  const [assignmentMode, setAssignmentMode] = useState(false);
  const [assignment, setAssignment] = useState("");
  const [pendingAssignment, setPendingAssignment] = useState<{ outcome: string; suggested: string } | null>(null);
  const [assignmentBusy, setAssignmentBusy] = useState("");
  const groupRef = useRef(group);
  groupRef.current = group;
  const coworkersRef = useRef(coworkers);
  coworkersRef.current = coworkers;
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const changedRef = useRef(onGroupChanged);
  changedRef.current = onGroupChanged;
  useAutoGrow(composerRef, message);

  const members = useMemo(
    () => group.participantSlugs.map((slug) => coworkers.find((coworker) => coworker.slug === slug)).filter((member): member is CoworkerSummary => Boolean(member)),
    [coworkers, group.participantSlugs],
  );
  const membersRef = useRef(members);
  membersRef.current = members;
  const holdings = useGroupHoldings(members, runtime);
  const nameFor = useCallback((slug: string) => coworkers.find((coworker) => coworker.slug === slug)?.name ?? slug, [coworkers]);

  useEffect(() => {
    setLoaded(false);
    setLive(false);
    setLiveTurn(null);
    setQueue([]);
    setReceipts([]);
  }, [group.id]);

  useEffect(() => {
    let cancelled = false;
    let reading = false;
    const refresh = async () => {
      if (reading) return;
      reading = true;
      try {
        const [status, activity, updated, work] = await Promise.all([coworkerBridge.groups.status(group.id), coworkerBridge.groups.activity(group.id), coworkerBridge.groups.get(group.id), coworkerBridge.collaboration.receipts({ groupId: group.id })]);
        if (cancelled) return;
        setLive(status.active); setLiveTurn(status.turn); setQueue(status.queue);
        publishGroupRun({ groupId: group.id, active: status.active, ...(status.turn ? { turn: status.turn } : {}), done: !status.active });
        setObserved({ groupId: group.id, ...activity }); setReceipts(work); setLoaded(true); setError("");
        if (updated.updatedAt !== groupRef.current.updatedAt) changedRef.current(updated);
      } catch {
        if (!cancelled) {
          setObserved((current) => ({ ...current, executions: [] }));
          setError("Live activity could not be refreshed. Recorded replies and waiting receipts are kept.");
        }
      }
      finally { reading = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), PROGRESS_LIMITS.activityPollMs);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [group.id]);

  useEffect(() => {
    onActivityLine(group.id, live && !liveTurn ? "Choosing who should respond…" : describeGroupActivity(events, nameFor, liveTurn));
  }, [events, group.id, live, liveTurn, nameFor, onActivityLine]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [events.length, liveTurn?.status, liveTurn?.speakers, queue.length]);

  useEffect(() => {
    if (loaded && active) composerRef.current?.focus();
  }, [loaded, group.id, active]);

  async function startTurn(text: string, clientMessageId: string): Promise<void> {
    try {
      await coworkerBridge.groups.submit(group.id, { text, clientMessageId, context: briefing?.context });
      setLive(true);
    } catch (cause) {
      setFailedSend({ text, clientMessageId, error: cause instanceof Error ? cause.message : String(cause) });
    }
  }

  async function resume(turn: CoworkerGroupTurn, only?: string): Promise<void> {
    setError("");
    try {
      await coworkerBridge.groups.submit(group.id, { text: turn.prompt, clientMessageId: newId("resume"), turnId: turn.id, only, attempt: Date.now(), context: briefing?.context });
      setLive(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const briefingRef = useRef(briefing);
  briefingRef.current = briefing;
  const startTurnRef = useRef(startTurn);
  startTurnRef.current = startTurn;
  const handledRequest = useRef("");
  useEffect(() => {
    const request = briefing?.request;
    if (!loaded || live || members.length < 2 || !request || handledRequest.current === request.id) return;
    handledRequest.current = request.id;
    void startTurnRef.current(request.text, request.id);
  }, [briefing?.request, loaded, live, members.length]);
  useEffect(() => {
    if (!loaded || !briefing?.enabled || members.length < 2) return;
    let checking = false;
    let cancelled = false;
    async function tick() {
      if (checking) return;
      checking = true;
      try {
        const due = await coworkerBridge.allHands.claim();
        if (due && !cancelled && briefingRef.current?.enabled) {
          await startTurnRef.current("Give us our All Hands briefing: what changed, what needs my decision, and the most useful next step. Use current evidence, name the source and time, and say when information is missing. Only relevant coworkers should contribute. This briefing is read-only: propose actions without executing them.", due.id);
        }
      } catch (cause) { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { checking = false; }
    }
    void tick();
    const timer = window.setInterval(() => void tick(), 30_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [loaded, briefing?.enabled, group.id, members.length]);

  async function send(): Promise<void> {
    const text = message.trim();
    if (!text) return;
    if (members.length < 2) {
      setError("A group chat needs at least two coworkers who are still here.");
      return;
    }
    const focus = /^(?:\/focus\s+|focus on\s+)([\s\S]+)$/i.exec(text);
    if (focus?.[1] && onRememberFocus) {
      try { await onRememberFocus(focus[1]); }
      catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return; }
    }
    setError("");
    setFailedSend(null);
    setMessage("");
    setMention(null);
    const clientMessageId = newId("m");
    void startTurn(text, clientMessageId);
  }

  async function rename(): Promise<void> {
    const next = nameDraft.trim();
    setRenaming(false);
    if (!next || next === group.name) return;
    onGroupChanged(await coworkerBridge.groups.update(group.id, { name: next }));
  }

  // --- an assignment from the group ------------------------------------------------
  /** Ask who should own it: the best match by role is proposed first; the person confirms. */
  function proposeAssignment(): void {
    const outcome = assignment.trim();
    if (!outcome || members.length === 0) return;
    setError("");
    setPendingAssignment({ outcome, suggested: chooseSpeakers(outcome, members, events)[0] ?? members[0]?.slug ?? "" });
  }

  /** Create the assignment in the owner's own workspace and link it from the timeline as one action line. */
  async function createAssignment(slug: string, outcome: string): Promise<void> {
    const owner = coworkersRef.current.find((coworker) => coworker.slug === slug);
    if (!owner) return;
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
      setPendingAssignment(null);
      setAssignment("");
      setAssignmentMode(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAssignmentBusy("");
    }
  }

  const ownerChoices = useMemo(() => {
    if (!pendingAssignment) return [];
    const ordered = [...members].sort((left, right) => Number(right.slug === pendingAssignment.suggested) - Number(left.slug === pendingAssignment.suggested));
    return ordered.map((member, index) => ({ letter: LETTERS[index] ?? String(index + 1), member, suggested: member.slug === pendingAssignment.suggested }));
  }, [members, pendingAssignment]);

  useEffect(() => {
    if (!pendingAssignment) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (typingInField(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Escape") {
        setPendingAssignment(null);
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
      field?.focus();
      field?.setSelectionRange(position, position);
    });
  }

  const latestTurn = group.turns.at(-1) ?? null;
  const recoverable = !live && latestTurn && unfinishedSpeakers(latestTurn).length > 0 ? latestTurn : null;
  const unfinished = recoverable ? unfinishedSpeakers(recoverable) : [];
  const showContinue = recoverable && !(unfinished.length === 1 && unfinished[0]?.status === "failed");
  const progressLine = liveTurn ? describeTurnProgress(liveTurn, nameFor) : "";
  const waiting = receipts.some((receipt) => ["waiting", "waiting-person", "resumption-queued"].includes(receipt.state));
  const statusLine = !loaded || observed.groupId !== group.id ? "Checking activity" : error ? "Activity unavailable" : executions.length ? `${executions.length} active execution${executions.length === 1 ? "" : "s"}` : live ? (progressLine || "Choosing who should respond…") : waiting ? "Waiting for requested work" : "Ready";

  return (
    <div className="glass-main flex h-full min-w-0 flex-1 flex-col" data-testid="group-chat" data-group-id={group.id} data-live={live ? "true" : "false"}>
      <header className="glass-header window-drag flex min-h-[78px] shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-3" data-testid="conversation-header">
        <GroupAvatars members={members} size={30} />
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
            <h1 className="whitespace-normal text-sm font-semibold text-snow [overflow-wrap:anywhere]" data-testid="group-name">{group.name}</h1>
          )}
          <p className="whitespace-normal text-xs text-mist [overflow-wrap:anywhere]" data-testid="conversation-header-title">{members.map((member) => member.name).join(", ")}</p>
        </div>
        <div className="window-no-drag flex shrink-0 items-center gap-1" data-testid="conversation-header-actions">
          {live ? <Button variant="ghost" onClick={() => void stopGroupRun(group.id)}>Stop all</Button> : null}
          <ActionMenu
            label="Group chat options"
            items={[
              ...(!briefing ? [{ label: "Rename", onSelect: () => { setNameDraft(group.name); setRenaming(true); } }] : []),
              ...(onOpenDetails ? [{ label: "Group details", onSelect: onOpenDetails }] : []),
              ...(!briefing ? [{ label: "Archive", tone: "danger" as const, disabled: live, onSelect: () => void coworkerBridge.groups.archive(group.id).then(onGroupArchived) }] : []),
            ]}
          />
        </div>
        {/* One plain line, no dot: who is replying, or Ready. */}
        <span data-testid="coworker-top-status" data-tone={statusLine === "Ready" ? "ready" : "mist"} className={`min-w-0 max-w-full whitespace-normal text-xs [overflow-wrap:anywhere] ${statusLine === "Ready" ? "text-ready" : "text-mist"}`}>
          {statusLine}
        </span>
      </header>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <div className="mx-auto max-w-3xl space-y-3">
          {introduction}
          {loaded && events.length === 0 && !introduction ? (
            <div className="mx-auto flex h-full max-w-md flex-col items-center justify-center py-10 text-center" data-testid="group-chat-empty">
              <GroupAvatars members={members} size={40} />
              <p className="mt-3 text-sm font-semibold text-snow">{group.name}</p>
              <p className="mt-0.5 text-xs text-mist">{members.map((member) => member.name).join(", ")}</p>
              <p className="mt-4 text-sm text-mist">What should we work through together? Name a coworker with @ to choose who answers.</p>
            </div>
          ) : null}
          {events.map((event, index) => {
            const previous = events[index - 1];
            const next = events[index + 1];
            const sameSpeaker = (other: GroupTimelineEvent | undefined) => Boolean(other && other.kind === event.kind && other.slug === event.slug);
            const continued = sameSpeaker(previous) && event.at - (previous?.at ?? 0) < 5 * 60_000;
            const tail = !sameSpeaker(next);
            const label = timeLabelBetween(previous?.at, event.at);
            if (event.kind === "status") {
              // A quiet line. When it is about a speaker of the latest unfinished turn, it also offers the fix.
              const speaker = recoverable && event.turnId === recoverable.id ? unfinished.find((entry) => entry.slug === event.slug) : undefined;
              const failure = speaker ? describeSpeakerFailure(speaker.error, nameFor(speaker.slug)) : null;
              return (
                <p key={event.id} className="flex flex-wrap items-center justify-center gap-x-3 px-12 text-center text-[11px] text-mist" data-testid="group-status" data-status={event.status} data-speaker={event.slug} data-error={speaker?.error}>
                  <span title={speaker?.error && speaker.error !== event.text ? speaker.error : undefined}>{event.text}</span>
                  {speaker && recoverable ? (
                    <span className="flex items-center gap-x-3">
                      <button type="button" className="font-medium text-snow/80 underline-offset-2 hover:underline" data-testid="group-speaker-retry" data-speaker={speaker.slug} onClick={() => void resume(recoverable, speaker.slug)}>Retry</button>
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
                <div key={event.id} className="flex justify-center py-0.5" data-testid="group-action-line" data-action={event.action} data-speaker={event.slug} data-thread-id={event.threadId}>
                  {open ? (
                    <button type="button" className="rounded-full border border-line/70 px-3 py-1 text-[11px] text-mist transition-colors hover:border-spark/40 hover:text-snow" onClick={open}>{event.text}</button>
                  ) : (
                    <span className="rounded-full border border-line/70 px-3 py-1 text-[11px] text-mist">{event.text}</span>
                  )}
                </div>
              );
            }
            if (event.kind === "user") {
              return (
                <div key={event.id}>
                  {label ? <p className="pb-1 pt-2 text-center text-[11px] font-medium text-mist/80" data-testid="group-time-label">{label}</p> : null}
                  <div className={`flex justify-end ${continued ? "-mt-1.5" : ""}`} data-message-role="user" data-continued={continued ? "true" : "false"}>
                    <div className={`bubble bubble-user max-w-[72%] whitespace-pre-wrap ${tail ? "bubble-tail-right" : ""}`} title={timeLabel(event.at)}>
                      {event.text}
                    </div>
                  </div>
                </div>
              );
            }
            // In a group, each reply is signed: a small avatar at the tail and the name once per run.
            const speaker = coworkers.find((coworker) => coworker.slug === event.slug);
            return (
              <div key={event.id}>
                {label ? <p className="pb-1 pt-2 text-center text-[11px] font-medium text-mist/80" data-testid="group-time-label">{label}</p> : null}
                <div className={`flex items-end gap-2 ${continued ? "-mt-1.5" : ""}`} data-message-role="assistant" data-speaker={event.slug} data-continued={continued ? "true" : "false"}>
                  <span className="w-6 shrink-0">
                    {tail && speaker ? <CoworkerAvatar color={speaker.avatarColor} glasses={speaker.avatarGlasses} name={speaker.name} size={24} /> : null}
                  </span>
                  <div className="max-w-[76%]">
                    {!continued ? <p className="mb-0.5 px-2 text-[11px] font-medium text-mist" data-testid="group-speaker-name">{nameFor(event.slug ?? "")}</p> : null}
                    <div className={`bubble bubble-coworker whitespace-pre-wrap ${tail ? "bubble-tail-left" : ""}`} title={timeLabel(event.at)}>
                      {event.text}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
          <CollaborationReceipts receipts={observed.groupId === group.id ? receipts : []} />
          {executions.map((execution) => {
            const member = coworkers.find((coworker) => coworker.slug === execution.slug);
            return member ? <GroupExecutionRow key={execution.executionId} activity={execution} coworker={member} runtime={runtime} /> : null;
          })}
          {live && executions.length === 0 ? <p className="px-1 text-[11px] text-mist [overflow-wrap:anywhere]" data-testid="group-progress-phrase">{statusLine}</p> : null}
          {showContinue && recoverable ? (
            <div className="flex items-center justify-center gap-3 text-[11px] text-mist" data-testid="group-turn-recovery" data-turn-id={recoverable.id}>
              <span>{listNames(unfinished.map((speaker) => nameFor(speaker.slug)))} still to reply</span>
              <button type="button" className="font-medium text-snow/80 underline-offset-2 hover:underline" data-testid="group-turn-continue" onClick={() => void resume(recoverable)}>Continue</button>
            </div>
          ) : null}
          {failedSend ? (
            <div className="flex items-center justify-center gap-3 text-[11px] text-mist" data-testid="group-turn-failed">
              <span>That message could not be sent: {failedSend.error}</span>
              <button type="button" className="font-medium text-snow/80 underline-offset-2 hover:underline" onClick={() => { const retry = failedSend; setFailedSend(null); void startTurn(retry.text, retry.clientMessageId); }}>Retry</button>
            </div>
          ) : null}
          {pendingAssignment ? (
            <InteractionCard label="Who should own this assignment" title="Who should own this?" detail={pendingAssignment.outcome} onClose={() => setPendingAssignment(null)} testId="group-assignment-owner">
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
          ) : null}
          {error ? <ErrorNote>{error}</ErrorNote> : null}
        </div>
      </div>
      <div className="px-5 pb-4 pt-2" data-testid="coworker-composer">
        <div className="mx-auto max-w-3xl">
          {assignmentMode ? (
            <p className="mb-2 px-2 text-[11px] text-mist" data-testid="group-assignment-mode">Something one of them should own, separate from this chat</p>
          ) : null}
          {queue.map((item) => (
            <div key={item.clientMessageId} className="mb-1.5 flex items-center gap-2 px-4 text-[11px] text-mist" data-testid="group-queued">
              <span className="font-medium text-snow/70">Next</span>
              <span className="min-w-0 flex-1 truncate">{item.text}</span>
              <button type="button" className="rounded-full px-1.5 text-mist hover:text-snow" aria-label="Do not send this" onClick={() => void coworkerBridge.groups.removeQueued(group.id, item.clientMessageId)}>×</button>
            </div>
          ))}
          <div className={`relative rounded-[24px] border bg-panel/60 p-3 transition-colors focus-within:border-spark/50 ${assignmentMode ? "border-spark/35" : "border-line"}`} data-testid="coworker-input-surface">
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
                      {option.member ? <CoworkerAvatar color={option.member.avatarColor} glasses={option.member.avatarGlasses} name={option.member.name} size={18} /> : <span className="flex size-[18px] items-center justify-center rounded-full border border-line text-[10px] text-mist">@</span>}
                      <span className="text-snow">{option.label}</span>
                      {option.detail ? <span className="truncate text-mist">{option.detail}</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <div>
              <textarea
                ref={composerRef}
                aria-label={assignmentMode ? "Assignment outcome" : `Message ${group.name}`}
                data-testid="group-composer"
                rows={1}
                className="block min-h-[56px] w-full resize-none bg-transparent px-1 pb-3 pt-1 text-sm leading-relaxed text-snow outline-none placeholder:text-mist/65"
                placeholder={assignmentMode ? "What should one of them own?" : `Message ${members.map((member) => member.name).join(", ")}`}
                value={assignmentMode ? assignment : message}
                disabled={!runtime.engineManaged}
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
                  if (assignmentMode) {
                    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
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
                    if (event.key === "Enter" || event.key === "Tab") {
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
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    send();
                  }
                }}
              />
              <div className="flex items-center gap-2" data-testid="coworker-composer-actions">
                <button
                  type="button"
                  aria-pressed={assignmentMode}
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
                </button>
                <span className="min-w-0 flex-1 text-[11px] text-mist/75">{assignmentMode ? "Create an assignment" : "@name to choose who answers"}</span>
                {live && !assignmentMode ? <Button variant="ghost" className="mb-0.5 rounded-full px-3 py-1 text-xs" onClick={() => void stopGroupRun(group.id)}>Stop</Button> : null}
                {assignmentMode ? (
                  <SendButton label="Create assignment" busy={false} disabled={!assignment.trim() || !runtime.engineManaged || Boolean(pendingAssignment)} onClick={proposeAssignment} testId="group-send" />
                ) : (
                  <SendButton label={live ? "Next" : "Send"} busy={false} disabled={!message.trim() || !runtime.engineManaged} onClick={send} testId="group-send" />
                )}
              </div>
            </div>
          </div>
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
  );
}
