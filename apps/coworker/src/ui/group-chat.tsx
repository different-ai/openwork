import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { coworkerBridge, type CoworkerGroupSummary, type CoworkerSummary, type GroupTimelineEvent, type RuntimeInfo } from "@/lib/bridge";
import { registerDiscussion } from "@/lib/discussions";
import { describeGroupActivity, replyTextSince, runGroupTurn, type GroupTurnProgress } from "@/lib/groups";
import { createCoworkerThreads } from "@/lib/threads";
import { CoworkerAvatar } from "@/ui/coworker-avatar";
import { GroupAvatars } from "@/ui/coworker-rail";
import { Button, ErrorNote, StatusDot } from "@/ui/kit";
import { timeLabelBetween } from "@/lib/conversation";
import { SendButton } from "@/ui/threads";
import { useAutoGrow } from "@/ui/use-auto-grow";

const REPLY_TIMEOUT_MS = 180_000;

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function timeLabel(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/**
 * A group chat: the person and several coworkers in one conversation. Each
 * reply is a real turn in that coworker's own workspace on a group-specific
 * discussion thread; the group only ever sees the visible text.
 */
export function GroupChat({
  group,
  coworkers,
  runtime,
  onGroupChanged,
  onGroupArchived,
  onActivityLine,
}: {
  group: CoworkerGroupSummary;
  coworkers: CoworkerSummary[];
  runtime: RuntimeInfo;
  onGroupChanged: (group: CoworkerGroupSummary) => void;
  onGroupArchived: (group: CoworkerGroupSummary) => void;
  /** One plain line describing the latest activity, for the rail. */
  onActivityLine: (id: string, line: string) => void;
}) {
  const [events, setEvents] = useState<GroupTimelineEvent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState<GroupTurnProgress | null>(null);
  const [error, setError] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(group.name);
  const controllerRef = useRef<AbortController | null>(null);
  const currentThreadRef = useRef<{ slug: string; threadId: string; abort: () => Promise<unknown> } | null>(null);
  const groupRef = useRef(group);
  groupRef.current = group;
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(composerRef, message);

  const members = useMemo(
    () => group.participantSlugs.map((slug) => coworkers.find((coworker) => coworker.slug === slug)).filter((member): member is CoworkerSummary => Boolean(member)),
    [coworkers, group.participantSlugs],
  );
  const nameFor = useCallback((slug: string) => coworkers.find((coworker) => coworker.slug === slug)?.name ?? slug, [coworkers]);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    void coworkerBridge.groups.readTimeline(group.id).then((items) => {
      if (cancelled) return;
      setEvents(items);
      setLoaded(true);
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      cancelled = true;
    };
  }, [group.id]);

  useEffect(() => {
    onActivityLine(group.id, progress && progress.phase !== "done" ? "Replying" : describeGroupActivity(events, nameFor));
  }, [events, group.id, nameFor, onActivityLine, progress]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [events.length, progress?.phase]);

  useEffect(() => {
    if (loaded) composerRef.current?.focus();
  }, [loaded, group.id]);

  /** Send one prompt to a member's group thread (created and registered on first use) and return its reply. */
  async function ask(slug: string, prompt: string, signal: AbortSignal): Promise<string> {
    const coworker = coworkers.find((item) => item.slug === slug);
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
    currentThreadRef.current = { slug, threadId, abort: () => threads.client.abortThread(threadId) };
    const acceptance = await threads.client.sendTurn(threadId, { prompt, messageId: newId("msg"), signal });
    const result = await threads.client.waitForThread(threadId, { timeoutMs: REPLY_TIMEOUT_MS, pollIntervalMs: 600, since: acceptance, signal });
    currentThreadRef.current = null;
    if (result.outcome === "aborted") throw new Error("Stopped.");
    if (result.outcome === "timeout") throw new Error(`${coworker.name} took too long to reply.`);
    if (result.outcome === "failed") throw new Error(result.terminalError?.message || `${coworker.name} could not reply.`);
    return replyTextSince(result.snapshot.messages, acceptance.messageCountBefore);
  }

  async function send(): Promise<void> {
    const text = message.trim();
    if (!text || progress) return;
    if (members.length < 2) {
      setError("A group chat needs at least two coworkers who are still here.");
      return;
    }
    setError("");
    setMessage("");
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      await runGroupTurn({
        group: { id: group.id, name: group.name },
        participants: members,
        recent: events,
        message: text,
        clientMessageId: newId("m"),
        signal: controller.signal,
        deps: {
          ask,
          append: async (event) => {
            const stored = await coworkerBridge.groups.appendEvent(group.id, event);
            setEvents((current) => [...current, stored]);
            return stored;
          },
          onProgress: setProgress,
        },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      controllerRef.current = null;
      setProgress(null);
    }
  }

  async function stopAll(): Promise<void> {
    controllerRef.current?.abort();
    await currentThreadRef.current?.abort().catch(() => undefined);
  }

  async function rename(): Promise<void> {
    const next = nameDraft.trim();
    setRenaming(false);
    if (!next || next === group.name) return;
    onGroupChanged(await coworkerBridge.groups.update(group.id, { name: next }));
  }

  const running = progress?.speakers.find((speaker) => speaker.status === "running");
  const statusLine = progress
    ? progress.phase === "routing"
      ? "Choosing who should respond…"
      : running
        ? `${nameFor(running.slug)} is replying…`
        : "Finishing"
    : "Ready";

  return (
    <div className="glass-main flex h-full min-w-0 flex-1 flex-col" data-testid="group-chat" data-group-id={group.id}>
      <header className="glass-header window-drag flex h-[78px] items-center gap-3 border-b border-line px-6 pt-2" data-testid="conversation-header">
        <GroupAvatars members={members} size={30} />
        <div className="min-w-0 flex-1">
          {renaming ? (
            <input
              autoFocus
              aria-label="Group name"
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
            <h1 className="truncate text-sm font-semibold text-snow">{group.name}</h1>
          )}
          <p className="truncate text-xs text-mist" data-testid="conversation-header-title">{members.map((member) => member.name).join(", ")}</p>
        </div>
        <div className="window-no-drag flex shrink-0 items-center gap-1" data-testid="conversation-header-actions">
          {progress ? <Button variant="ghost" onClick={() => void stopAll()}>Stop all</Button> : null}
          {!progress ? (
            <Button variant="ghost" onClick={() => { setNameDraft(group.name); setRenaming(true); }} title="Rename this group chat">Rename</Button>
          ) : null}
          {!progress ? (
            <Button variant="ghost" onClick={() => void coworkerBridge.groups.archive(group.id).then(onGroupArchived)} title="Archive this group chat; its messages are kept">Archive</Button>
          ) : null}
        </div>
        <span data-testid="coworker-top-status" className={`flex shrink-0 items-center gap-2 text-xs ${progress ? "text-spark" : "text-mist"}`}>
          <StatusDot tone={progress ? "spark" : "mist"} />
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
              return (
                <p key={event.id} className="px-12 text-center text-[11px] text-mist" data-testid="group-status" data-status={event.status}>
                  {event.text}
                </p>
              );
            }
            if (event.kind === "user") {
              return (
                <div key={event.id}>
                  {label ? <p className="pb-1 pt-2 text-center text-[11px] font-medium text-mist/80">{label}</p> : null}
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
                {label ? <p className="pb-1 pt-2 text-center text-[11px] font-medium text-mist/80">{label}</p> : null}
                <div className={`flex items-end gap-2 ${continued ? "-mt-1.5" : ""}`} data-message-role="assistant" data-speaker={event.slug} data-continued={continued ? "true" : "false"}>
                  <span className="w-6 shrink-0">
                    {tail && speaker ? <CoworkerAvatar color={speaker.avatarColor} glasses={speaker.avatarGlasses} name={speaker.name} size={24} /> : null}
                  </span>
                  <div className="max-w-[76%]">
                    {!continued ? <p className="mb-0.5 px-2 text-[11px] font-medium text-mist">{nameFor(event.slug ?? "")}</p> : null}
                    <div className={`bubble bubble-coworker whitespace-pre-wrap ${tail ? "bubble-tail-left" : ""}`} title={timeLabel(event.at)}>
                      {event.text}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
          {progress && progress.phase !== "done" ? (
            <div className="flex items-center gap-2.5 px-1 text-xs text-spark" data-testid="group-working" data-phase={progress.phase}>
              <StatusDot tone="spark" />
              <span>{statusLine}</span>
              {progress.speakers.length > 1 ? (
                <span className="text-mist">
                  {progress.speakers.map((speaker) => `${nameFor(speaker.slug)}: ${speaker.status === "queued" ? "waiting" : speaker.status}`).join(" · ")}
                </span>
              ) : null}
            </div>
          ) : null}
          {error ? <ErrorNote>{error}</ErrorNote> : null}
        </div>
      </div>
      <div className="border-t border-line px-5 py-4">
        <div className="mx-auto max-w-3xl">
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
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            {progress ? (
              <Button variant="ghost" className="mb-0.5 rounded-full px-3 py-1 text-xs" onClick={() => void stopAll()}>Stop</Button>
            ) : (
              <SendButton label="Send" busy={false} disabled={!message.trim() || !runtime.engineManaged} onClick={() => void send()} testId="group-send" />
            )}
          </div>
          <p className="mt-1.5 px-4 text-[9px] text-mist/65">Enter to send · Shift Enter for a new line · @name chooses who answers, @everyone asks all</p>
        </div>
      </div>
    </div>
  );
}
