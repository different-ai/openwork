import { useComposerDraft } from "@/ui/use-composer-draft";
import { createHeadlessThreadClient, isRunning, type HeadlessThreadClient, type HeadlessTurnAcceptance } from "@openwork/headless-threads";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { coworkerBridge, type CoworkerGroupSummary, type CoworkerGroupTurn, type CoworkerSummary, type GroupTimelineEvent, type RuntimeInfo } from "@/lib/bridge";
import { assignmentPrompt, assignmentTitle, timeLabelBetween, type DiscussionMessage } from "@/lib/conversation";
import { combineSummaryLines, describeCoworkerSummary, type CoworkerSummaryLine } from "@/lib/coworker-summary";
import { classifyThreads, discussionIds, loadDiscussionRegistry, registerDiscussion } from "@/lib/discussions";
import { lastDocumentsOpened } from "@/ui/documents";
import { effortForTurn, effortLevelFor, variantForLevel } from "@/lib/effort";
import { ROUTING_TIMEOUT_MS, earlierSpeakerOrders, facilitatorModels, facilitatorPrompt, routeWithFacilitator, type FacilitatorAsk } from "@/lib/facilitator";
import {
  busyGroupSpeakers,
  dequeueGroupMessage,
  enqueueGroupMessage,
  liveGroupRun,
  publishGroupRun,
  queuedGroupMessages,
  startGroupRun,
  stopGroupRun,
  subscribeGroupRuns,
  type LiveGroupRun,
  type QueuedGroupMessage,
} from "@/lib/group-runs";
import {
  chooseSpeakers,
  describeGroupActivity,
  describeSpeakerFailure,
  describeTurnProgress,
  listNames,
  mentionCandidates,
  replyTextSince,
  resumeGroupTurn,
  runGroupTurn,
  unfinishedSpeakers,
  type GroupParticipant,
  type GroupTurnDeps,
  type RoutingPlan,
  unavailableModelReason,
} from "@/lib/groups";
import { createCoworkerThreads, type EngineModelCatalog } from "@/lib/threads";
import { failureText } from "@/lib/turn-failure";
import { CoworkerAvatar } from "@/ui/coworker-avatar";
import { GroupAvatars } from "@/ui/coworker-rail";
import { InteractionCard, LETTERS, OptionRow, typingInField } from "@/ui/interactions";
import { ActionMenu, Button, ErrorNote, PlusIcon, StatusDot } from "@/ui/kit";
import { SendButton, SummaryLine } from "@/ui/threads";
import { useAutoGrow } from "@/ui/use-auto-grow";

/** How long one coworker may take over one reply before the turn moves on. */
export const REPLY_TIMEOUT_MS = 180_000;

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function timeLabel(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** The hidden coordinator workspace, registered once per app run; a failure is forgotten so the next turn tries again. */
let coordinatorPromise: Promise<{ workspaceId: string }> | null = null;
function coordinatorReady(): Promise<{ workspaceId: string }> {
  coordinatorPromise ??= coworkerBridge.coordinator.ensure().then((coordinator) => {
    if (!coordinator.workspaceId) throw new Error("The coordinator workspace is not ready.");
    return coordinator;
  });
  coordinatorPromise.catch(() => {
    coordinatorPromise = null;
  });
  return coordinatorPromise;
}
const CATALOG_TTL_MS = 60_000;
/** How long a settled thread may still be catching up on its reply text before it counts as no reply. */
const REPLY_TEXT_GRACE_MS = 10_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * The visible text of one accepted turn once the thread is done with it. A
 * thread can read idle for a moment before its reply text has landed, so an
 * empty reply gets a short grace period (and another wait if the thread turns
 * out to be running again) before it counts as no reply.
 */
async function settledReplyText(client: HeadlessThreadClient, threadId: string, acceptance: HeadlessTurnAcceptance, timeoutMs: number, signal: AbortSignal, name: string): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let result = await client.waitForThread(threadId, { timeoutMs, pollIntervalMs: 600, since: acceptance, signal });
  for (;;) {
    if (result.outcome === "aborted") throw new Error("Stopped.");
    if (result.outcome === "timeout") {
      await client.abortThread(threadId).catch(() => undefined);
      throw new Error(`${name} took too long to reply.`);
    }
    if (result.outcome === "failed") throw new Error(result.terminalError ? failureText(result.terminalError) : `${name} could not reply.`);
    const text = replyTextSince(result.snapshot.messages, acceptance.messageCountBefore);
    if (text) return text;
    const graceEnd = Date.now() + REPLY_TEXT_GRACE_MS;
    let snapshot = result.snapshot;
    while (Date.now() < graceEnd && !signal.aborted) {
      await sleep(500, signal);
      snapshot = await client.getThreadSnapshot(threadId, { signal });
      const later = replyTextSince(snapshot.messages, acceptance.messageCountBefore);
      if (later) return later;
      if (isRunning(snapshot.status)) break;
    }
    if (signal.aborted) throw new Error("Stopped.");
    if (!isRunning(snapshot.status)) return "";
    result = await client.waitForThread(threadId, { timeoutMs: Math.max(1_000, deadline - Date.now()), pollIntervalMs: 600, since: acceptance, signal });
  }
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
  const [events, setEvents] = useState<GroupTimelineEvent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useComposerDraft(`group:${group.id}`);
  const [live, setLive] = useState(() => Boolean(liveGroupRun(group.id)));
  const [liveTurn, setLiveTurn] = useState<CoworkerGroupTurn | null>(() => liveGroupRun(group.id)?.turn ?? null);
  const [queue, setQueue] = useState<QueuedGroupMessage[]>(() => queuedGroupMessages(group.id));
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
  const catalogRef = useRef<{ at: number; catalog: EngineModelCatalog } | null>(null);
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
    let cancelled = false;
    setLoaded(false);
    void coworkerBridge.groups.readTimeline(group.id).then((items) => {
      if (cancelled) return;
      // A line the live run appended while the timeline was loading is already in state.
      setEvents((current) => {
        const known = new Set(items.map((item) => item.id));
        return [...items, ...current.filter((item) => !known.has(item.id))];
      });
      setLoaded(true);
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      cancelled = true;
    };
  }, [group.id]);

  // The run lives outside the view: pick it up on mount and follow it while here.
  useEffect(() => subscribeGroupRuns((update) => {
    if (update.groupId !== group.id) return;
    if (update.turn) {
      setLive(true);
      setLiveTurn(update.turn);
    }
    if (update.event) {
      const stored = update.event;
      setEvents((current) => (current.some((item) => item.id === stored.id) ? current : [...current, stored]));
    }
    if (update.queue) setQueue(update.queue);
    if (update.done) {
      setLive(false);
      setLiveTurn(null);
    }
  }), [group.id]);

  useEffect(() => {
    onActivityLine(group.id, live && !liveTurn ? "Choosing who should respond…" : describeGroupActivity(events, nameFor, liveTurn));
  }, [events, group.id, live, liveTurn, nameFor, onActivityLine]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [events.length, liveTurn?.status, liveTurn?.speakers, queue.length]);

  useEffect(() => {
    if (loaded && active) composerRef.current?.focus();
  }, [loaded, group.id, active]);

  /** The connected models, read through any workspace and kept for a minute. */
  async function connectedCatalog(threads: ReturnType<typeof createCoworkerThreads>): Promise<EngineModelCatalog> {
    if (!catalogRef.current || Date.now() - catalogRef.current.at > CATALOG_TTL_MS) {
      catalogRef.current = { at: Date.now(), catalog: await threads.listModelCatalog() };
    }
    return catalogRef.current.catalog;
  }

  /** Send one prompt to a member's group thread (created and registered on first use) and return its reply. */
  async function ask(run: LiveGroupRun, slug: string, prompt: string, signal: AbortSignal): Promise<{ text: string; threadId: string }> {
    const coworker = coworkersRef.current.find((item) => item.slug === slug);
    if (!coworker) throw new Error("That coworker is no longer here.");
    const workspaceId = coworker.workspaceId || (await coworkerBridge.coworkers.ensureWorkspace(slug)).workspaceId;
    if (!workspaceId) throw new Error(`${coworker.name}'s workspace is not ready.`);
    // A group reply is an ordinary reply: the effort dial decides its effort from what the model offers; an exact effort the person fixed wins.
    const catalogThreads = createCoworkerThreads({ serverUrl: runtime.serverUrl, workspaceId, token: runtime.ownerToken });
    const connected = (await connectedCatalog(catalogThreads)).models;
    // A saved model that is not connected fails here, by name, rather than as a provider error mid-turn.
    const unavailable = unavailableModelReason(coworker.model, connected);
    if (unavailable) throw new Error(unavailable);
    const offered = connected.find((model) => model.id === coworker.model)?.variants ?? [];
    const modelVariant = effortForTurn({ kind: "reply", stop: coworker.effortPreference, fixedVariant: coworker.modelVariant, variants: offered });
    const threads = createCoworkerThreads({ serverUrl: runtime.serverUrl, workspaceId, token: runtime.ownerToken, model: coworker.model, modelVariant });
    let threadId = groupRef.current.participantThreadIds[slug] ?? "";
    if (!threadId) {
      const created = await threads.client.createThread({ title: `Group chat: ${groupRef.current.name}`, signal });
      threadId = created.id;
      await registerDiscussion(slug, threadId);
      const updated = await coworkerBridge.groups.update(groupRef.current.id, { participantThreadIds: { [slug]: threadId } });
      groupRef.current = updated;
      onGroupChanged(updated);
    }
    run.abortCurrent = () => threads.client.abortThread(threadId);
    try {
      const acceptance = await threads.client.sendTurn(threadId, { prompt: briefing ? `${briefing.context}\n\n${prompt}` : prompt, messageId: newId("msg"), signal });
      return { text: await settledReplyText(threads.client, threadId, acceptance, REPLY_TIMEOUT_MS, signal, coworker.name), threadId };
    } finally {
      if (run.abortCurrent) run.abortCurrent = null;
    }
  }

  /**
   * The silent facilitator's one routing pass for a message. It runs in the
   * hidden coordinator workspace on the model the coworkers use; whatever goes
   * wrong (no model, an unusable answer, a timeout) resolves null and the
   * deterministic scorer decides instead — the person only ever sees
   * "Choosing who should respond…".
   */
  async function route(input: Parameters<NonNullable<GroupTurnDeps["route"]>>[0]): Promise<RoutingPlan | null> {
    // One name already decides who speaks; there is nothing to route.
    if (!input.mentions.everyone && input.mentions.slugs.length === 1) return null;
    const current = groupRef.current;
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(ROUTING_TIMEOUT_MS)]);
    const coordinator = await coordinatorReady();
    const threads = createCoworkerThreads({ serverUrl: runtime.serverUrl, workspaceId: coordinator.workspaceId, token: runtime.ownerToken });
    const models = facilitatorModels(await connectedCatalog(threads), membersRef.current, current.facilitatorModel);
    if (!models.primary) return null;
    const busy = busyGroupSpeakers(current.id);
    const prompt = facilitatorPrompt({
      group: current,
      members: input.participants.map((participant) => ({ ...participant, busy: busy.has(participant.slug) })),
      recent: input.recent,
      earlierOrders: earlierSpeakerOrders(current.turns),
      message: briefing ? `${briefing.context}\n\nUser message: ${input.message}` : input.message,
      mentions: input.mentions,
      nameFor,
    });
    const client = createHeadlessThreadClient({ baseUrl: runtime.serverUrl, workspaceId: coordinator.workspaceId, token: runtime.ownerToken });
    let threadId = current.facilitatorThreadId;
    if (!threadId) {
      const created = await client.createThread({ title: `Facilitator · ${current.name}`, signal });
      threadId = created.id;
      const updated = await coworkerBridge.groups.update(current.id, { facilitatorThreadId: threadId });
      groupRef.current = updated;
      onGroupChanged(updated);
    }
    const ask: FacilitatorAsk = async (text, model, askSignal) => {
      // The facilitator thinks least: the lowest effort its model offers, whatever any dial says.
      const variant = variantForLevel(effortLevelFor("facilitator", "balanced"), model.variants);
      const acceptance = await client.sendTurn(threadId, { prompt: text, model: { providerId: model.providerId, modelId: model.modelId, ...(variant ? { variant } : {}) }, messageId: newId("msg"), signal: askSignal });
      return settledReplyText(client, threadId, acceptance, ROUTING_TIMEOUT_MS, askSignal, "The facilitator");
    };
    return routeWithFacilitator({
      prompt,
      participants: input.participants,
      mentions: input.mentions,
      models,
      ask,
      signal,
      // Never shown to the person; kept in the console so a silent fallback can be understood later.
      onAttempt: (detail) => console.info(`[open-coworker] facilitator ${detail.outcome} on ${detail.model}${detail.reason ? `: ${detail.reason}` : ""}`),
    });
  }

  function depsFor(run: LiveGroupRun): GroupTurnDeps {
    const groupId = group.id;
    return {
      ask: (slug, prompt, signal) => ask(run, slug, prompt, signal),
      route: (input) => route(input),
      append: async (event) => {
        const stored = await coworkerBridge.groups.appendEvent(groupId, event);
        publishGroupRun({ groupId, event: stored });
        return stored;
      },
      begin: async (input) => {
        const begun = await coworkerBridge.groups.beginTurn(groupId, input);
        if (begun.userEvent) publishGroupRun({ groupId, event: begun.userEvent });
        return begun;
      },
      record: async (turnId, patch) => {
        const turn = await coworkerBridge.groups.updateTurn(groupId, turnId, patch);
        run.turn = turn;
        return turn;
      },
      onTurn: (turn) => {
        run.turn = turn;
        publishGroupRun({ groupId, turn });
      },
    };
  }

  /** After a run, the stored record is the truth the view renders: refresh it, then start whatever waited. */
  async function settleRun(): Promise<void> {
    const groupId = group.id;
    const updated = await coworkerBridge.groups.get(groupId).catch(() => null);
    if (updated) onGroupChanged(updated);
    const next = dequeueGroupMessage(groupId);
    if (next) void startTurn(next.text, next.clientMessageId);
  }

  async function startTurn(text: string, clientMessageId: string): Promise<void> {
    const participants: GroupParticipant[] = membersRef.current;
    const recent = eventsRef.current;
    const current = groupRef.current;
    try {
      await startGroupRun(current.id, async (run) => {
        publishGroupRun({ groupId: current.id, turn: { id: "", clientMessageId, prompt: text, createdAt: Date.now(), updatedAt: Date.now(), status: "routing", mode: "sequential", routedBy: "fallback", speakers: [] } });
        await runGroupTurn({ group: { id: current.id, name: current.name }, participants, recent, message: text, clientMessageId, signal: run.controller.signal, deps: depsFor(run) });
      });
    } catch (cause) {
      setFailedSend({ text, clientMessageId, error: cause instanceof Error ? cause.message : String(cause) });
    }
    await settleRun();
  }

  async function resume(turn: CoworkerGroupTurn, only?: string): Promise<void> {
    const participants: GroupParticipant[] = membersRef.current;
    const current = groupRef.current;
    setError("");
    try {
      await startGroupRun(current.id, async (run) => {
        run.turn = turn;
        publishGroupRun({ groupId: current.id, turn });
        await resumeGroupTurn({ group: { id: current.id, name: current.name }, participants, turn, events: eventsRef.current, only, signal: run.controller.signal, deps: depsFor(run) });
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
    await settleRun();
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
      if (checking || liveGroupRun(group.id)) return;
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
    if (live || liveGroupRun(group.id)) {
      // The composer stays usable while a turn runs: this message goes next.
      enqueueGroupMessage(group.id, { clientMessageId, text });
      return;
    }
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
  const statusLine = live ? (progressLine || "Choosing who should respond…") : "Ready";
  const replying = liveTurn?.speakers.find((speaker) => speaker.status === "running");
  const replyingMember = replying ? coworkers.find((coworker) => coworker.slug === replying.slug) : null;

  return (
    <div className="glass-main flex h-full min-w-0 flex-1 flex-col" data-testid="group-chat" data-group-id={group.id} data-live={live ? "true" : "false"}>
      <header className="glass-header window-drag flex h-[78px] items-center gap-3 border-b border-line px-6 pt-2" data-testid="conversation-header">
        <GroupAvatars members={members} size={30} />
        <div className="min-w-0 flex-1">
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
            <h1 className="truncate text-sm font-semibold text-snow" data-testid="group-name">{group.name}</h1>
          )}
          <p className="truncate text-xs text-mist" data-testid="conversation-header-title">{members.map((member) => member.name).join(", ")}</p>
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
        <span data-testid="coworker-top-status" data-tone={live ? "mist" : "ready"} className={`shrink-0 text-xs ${live ? "text-mist" : "text-ready"}`}>
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
          {live ? (
            <div className="flex items-center gap-2.5 px-1 text-xs text-spark" data-testid="group-working" data-phase={liveTurn?.status ?? "routing"}>
              {replyingMember ? <CoworkerAvatar color={replyingMember.avatarColor} glasses={replyingMember.avatarGlasses} name={replyingMember.name} size={20} /> : <StatusDot tone="spark" />}
              <span data-testid="group-progress-phrase">{statusLine}</span>
            </div>
          ) : null}
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
              <button type="button" className="rounded-full px-1.5 text-mist hover:text-snow" aria-label="Do not send this" onClick={() => dequeueGroupMessage(group.id, item.clientMessageId)}>×</button>
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
