import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { coworkerBridge, type CoworkerGroupSummary, type CoworkerGroupTurn, type CoworkerSummary, type GroupTimelineEvent, type RuntimeInfo } from "@/lib/bridge";
import { timeLabelBetween } from "@/lib/conversation";
import { registerDiscussion } from "@/lib/discussions";
import {
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
} from "@/lib/groups";
import { createCoworkerThreads } from "@/lib/threads";
import { CoworkerAvatar } from "@/ui/coworker-avatar";
import { GroupAvatars } from "@/ui/coworker-rail";
import { ActionMenu, Button, ErrorNote, StatusDot } from "@/ui/kit";
import { SendButton } from "@/ui/threads";
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
}: {
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
}) {
  const [events, setEvents] = useState<GroupTimelineEvent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState("");
  const [live, setLive] = useState(() => Boolean(liveGroupRun(group.id)));
  const [liveTurn, setLiveTurn] = useState<CoworkerGroupTurn | null>(() => liveGroupRun(group.id)?.turn ?? null);
  const [queue, setQueue] = useState<QueuedGroupMessage[]>(() => queuedGroupMessages(group.id));
  const [failedSend, setFailedSend] = useState<{ text: string; clientMessageId: string; error: string } | null>(null);
  const [error, setError] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(group.name);
  const [mention, setMention] = useState<{ start: number; query: string; index: number } | null>(null);
  const groupRef = useRef(group);
  groupRef.current = group;
  const coworkersRef = useRef(coworkers);
  coworkersRef.current = coworkers;
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(composerRef, message);

  const members = useMemo(
    () => group.participantSlugs.map((slug) => coworkers.find((coworker) => coworker.slug === slug)).filter((member): member is CoworkerSummary => Boolean(member)),
    [coworkers, group.participantSlugs],
  );
  const membersRef = useRef(members);
  membersRef.current = members;
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
    if (loaded) composerRef.current?.focus();
  }, [loaded, group.id]);

  /** Send one prompt to a member's group thread (created and registered on first use) and return its reply. */
  async function ask(run: LiveGroupRun, slug: string, prompt: string, signal: AbortSignal): Promise<{ text: string; threadId: string }> {
    const coworker = coworkersRef.current.find((item) => item.slug === slug);
    if (!coworker) throw new Error("That coworker is no longer here.");
    const workspaceId = coworker.workspaceId || (await coworkerBridge.coworkers.ensureWorkspace(slug)).workspaceId;
    if (!workspaceId) throw new Error(`${coworker.name}'s workspace is not ready.`);
    const threads = createCoworkerThreads({ serverUrl: runtime.serverUrl, workspaceId, token: runtime.ownerToken, model: coworker.model, modelVariant: coworker.modelVariant });
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
      const acceptance = await threads.client.sendTurn(threadId, { prompt, messageId: newId("msg"), signal });
      const result = await threads.client.waitForThread(threadId, { timeoutMs: REPLY_TIMEOUT_MS, pollIntervalMs: 600, since: acceptance, signal });
      if (result.outcome === "aborted") throw new Error("Stopped.");
      if (result.outcome === "timeout") {
        await threads.client.abortThread(threadId).catch(() => undefined);
        throw new Error(`${coworker.name} took too long to reply.`);
      }
      if (result.outcome === "failed") throw new Error(result.terminalError?.message || `${coworker.name} could not reply.`);
      return { text: replyTextSince(result.snapshot.messages, acceptance.messageCountBefore), threadId };
    } finally {
      if (run.abortCurrent) run.abortCurrent = null;
    }
  }

  function depsFor(run: LiveGroupRun): GroupTurnDeps {
    const groupId = group.id;
    return {
      ask: (slug, prompt, signal) => ask(run, slug, prompt, signal),
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

  function send(): void {
    const text = message.trim();
    if (!text) return;
    if (members.length < 2) {
      setError("A group chat needs at least two coworkers who are still here.");
      return;
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
              { label: "Rename", onSelect: () => { setNameDraft(group.name); setRenaming(true); } },
              ...(onOpenDetails ? [{ label: "Group details", onSelect: onOpenDetails }] : []),
              { label: "Archive", tone: "danger", disabled: live, onSelect: () => void coworkerBridge.groups.archive(group.id).then(onGroupArchived) },
            ]}
          />
        </div>
        <span data-testid="coworker-top-status" className={`flex shrink-0 items-center gap-2 text-xs ${live ? "text-spark" : "text-mist"}`}>
          <StatusDot tone={live ? "spark" : "mist"} />
          {statusLine}
        </span>
      </header>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <div className="mx-auto max-w-3xl space-y-3">
          {loaded && events.length === 0 ? (
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
                <p key={event.id} className="flex flex-wrap items-center justify-center gap-x-3 px-12 text-center text-[11px] text-mist" data-testid="group-status" data-status={event.status} data-speaker={event.slug}>
                  <span>{event.text}</span>
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
              return (
                <div key={event.id} className="flex justify-center py-0.5" data-testid="group-action-line" data-action={event.action}>
                  <span className="rounded-full border border-line/70 px-3 py-1 text-[11px] text-mist">{event.text}</span>
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
          {error ? <ErrorNote>{error}</ErrorNote> : null}
        </div>
      </div>
      <div className="px-5 pb-4 pt-2" data-testid="coworker-composer">
        <div className="mx-auto max-w-3xl">
          {queue.map((item) => (
            <div key={item.clientMessageId} className="mb-1.5 flex items-center gap-2 px-4 text-[11px] text-mist" data-testid="group-queued">
              <span className="font-medium text-snow/70">Next</span>
              <span className="min-w-0 flex-1 truncate">{item.text}</span>
              <button type="button" className="rounded-full px-1.5 text-mist hover:text-snow" aria-label="Do not send this" onClick={() => dequeueGroupMessage(group.id, item.clientMessageId)}>×</button>
            </div>
          ))}
          <div className="relative">
            {mention && mentionOptions.length > 0 ? (
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
            <div className="flex min-w-0 items-end gap-1 rounded-[20px] border border-line bg-panel/60 py-1 pl-4 pr-1 transition-colors focus-within:border-spark/50">
              <textarea
                ref={composerRef}
                aria-label={`Message ${group.name}`}
                data-testid="group-composer"
                rows={1}
                className="min-h-[30px] min-w-0 flex-1 resize-none bg-transparent py-1 text-sm leading-relaxed text-snow outline-none placeholder:text-mist/65"
                placeholder={`Message ${members.map((member) => member.name).join(", ")}`}
                value={message}
                disabled={!runtime.engineManaged}
                onChange={(event) => {
                  setMessage(event.target.value);
                  updateMention(event.target.value, event.target.selectionStart ?? event.target.value.length);
                }}
                onClick={(event) => updateMention(event.currentTarget.value, event.currentTarget.selectionStart ?? 0)}
                onKeyDown={(event) => {
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
              {live ? <Button variant="ghost" className="mb-0.5 rounded-full px-3 py-1 text-xs" onClick={() => void stopGroupRun(group.id)}>Stop</Button> : null}
              <SendButton label={live ? "Next" : "Send"} busy={false} disabled={!message.trim() || !runtime.engineManaged} onClick={send} testId="group-send" />
            </div>
          </div>
          <p className="mt-1.5 px-4 text-[9px] text-mist/65">Enter to send · Shift Enter for a new line · @name chooses who answers, @everyone asks all</p>
        </div>
      </div>
    </div>
  );
}
