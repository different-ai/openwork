import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { coworkerBridge, type CoworkerSummary } from "@/lib/bridge";
import {
  eventInputSchema,
  eventRunIsLive,
  type EventArtifact,
  type EventContinuity,
  type EventDetail,
  type EventOutcome,
  type EventRun,
  type WorkplaceEvent,
} from "@/lib/events";
import {
  describeMoment,
  describeScheduleForPeople,
  describeZone,
  sentenceCase,
} from "@/lib/responsibility-copy";
import { Button, ErrorNote } from "@/ui/kit";
import { EventSheet } from "@/ui/event-sheet";
import { DocumentMarkdown } from "@/ui/markdown";
import { CoworkerAvatar, GroupAvatars } from "@/ui/coworker-avatar";

// Uncertain requests retain their id even if the person closes and reopens the detail.
const runRequests = new Map<string, string>();
/** Sessions shown before the list offers the rest. */
const VISIBLE_SESSIONS = 4;
/** Summaries longer than this start folded to a few lines. */
const LONG_SUMMARY = 360;

export type EventSelection = {
  eventId: string;
  runId?: string;
  at?: number;
  requestId: number;
};

type Tone = "spark" | "mint" | "ready" | "amber" | "rose" | "mist";
type RunStatus = { label: string; tone: Tone; live: boolean };

const toneText: Record<Tone, string> = {
  spark: "text-spark",
  mint: "text-mint",
  ready: "text-ready",
  amber: "text-amber",
  rose: "text-rose",
  mist: "text-mist",
};
const toneDot: Record<Tone, string> = {
  spark: "bg-spark",
  mint: "bg-mint",
  ready: "bg-ready",
  amber: "bg-amber",
  rose: "bg-rose",
  mist: "bg-mist",
};

/** One short, truthful word for a session. */
function describeRun(run: EventRun): RunStatus {
  if (run.stopping) return { label: "Stopping · awaiting confirmation", tone: "mint", live: true };
  switch (run.status) {
    case "queued":
      return { label: "Starting", tone: "spark", live: true };
    case "running":
      return run.phase === "conclusion"
        ? { label: "Wrapping up", tone: "mint", live: true }
        : { label: "In session", tone: "mint", live: true };
    case "waiting":
      return { label: "Waiting for work", tone: "mint", live: true };
    case "succeeded":
      return run.outcome
        ? run.outcomeStatus === "delivered"
          ? { label: "Delivered", tone: "ready", live: false }
          : run.outcomeStatus === "provisional"
            ? { label: "Provisional", tone: "amber", live: false }
            : { label: "Delivery unconfirmed", tone: "amber", live: false }
        : { label: "No summary", tone: "mist", live: false };
    case "partial":
      return { label: "Partly finished", tone: "amber", live: false };
    case "failed":
      return { label: "Did not finish", tone: "rose", live: false };
    case "cancelled":
      return { label: "Stopped", tone: "mist", live: false };
  }
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/** "Sep 10", with the year only when it is not this year. */
function shortDay(at: number): string {
  const date = new Date(at);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(
    undefined,
    sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" },
  );
}

/** "Sep 10 · 9:00 AM". */
function shortMoment(at: number): string {
  return `${shortDay(at)} · ${new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

function Disclosure({ open }: { open?: boolean }) {
  return (
    <svg
      className={`size-3 shrink-0 text-mist transition-transform ${open ? "rotate-90" : ""} group-open:rotate-90`}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  );
}

function StatusGlyph({ tone, live }: { tone: Tone; live: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`relative inline-flex size-2 shrink-0 rounded-full ${toneDot[tone]}`}
    >
      {live ? (
        <span
          className={`absolute inset-0 animate-ping rounded-full opacity-60 motion-reduce:animate-none ${toneDot[tone]}`}
        />
      ) : null}
    </span>
  );
}

function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="text-[10px] font-semibold uppercase tracking-wider text-mist">
      {children}
    </p>
  );
}

function ConversationIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3.5 2.75h9A1.75 1.75 0 0 1 14.25 4.5v5a1.75 1.75 0 0 1-1.75 1.75H6l-3.75 2v-2.6A1.75 1.75 0 0 1 1.75 9.5v-5A1.75 1.75 0 0 1 3.5 2.75Z" />
    </svg>
  );
}

function DocumentIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M4 2.25h5.25L12.5 5.5v7.75a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5v-10.5a.5.5 0 0 1 .5-.5Z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
      <path
        d="M9.25 2.25V5.5h3.25M5.75 8.25h4.5M5.75 10.75h4.5"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

type OutcomeGroup = {
  key: keyof Omit<EventOutcome, "summary">;
  title: string;
  tone: Tone;
  icon: ReactNode;
};

const outcomeGroups: OutcomeGroup[] = [
  {
    key: "openQuestions",
    title: "Open questions",
    tone: "amber",
    icon: (
      <svg className="size-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
        <circle cx="8" cy="8" r="6.25" />
        <path d="M6.2 6.3a1.9 1.9 0 0 1 3.7.5c0 1.2-1.9 1.4-1.9 2.6" />
        <circle cx="8" cy="11.6" r="0.55" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
  {
    key: "decisions",
    title: "Decisions",
    tone: "spark",
    icon: (
      <svg className="size-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="8" cy="8" r="6.25" />
        <path d="M5.2 8.2l1.9 1.9 3.8-4" />
      </svg>
    ),
  },
  {
    key: "accomplishments",
    title: "Done",
    tone: "ready",
    icon: (
      <svg className="size-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M2.5 8.6l2.6 2.6 3.2-3.5" />
        <path d="M7.4 8.6l2.6 2.6 3.5-3.9" />
        <path d="M10.6 4.9l2.9-3" />
      </svg>
    ),
  },
  {
    key: "followUps",
    title: "Follow-ups",
    tone: "mist",
    icon: (
      <svg className="size-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M2.75 8h9.5M9 4.5 12.5 8 9 11.5" />
      </svg>
    ),
  },
];

/** "2 open questions · 1 follow-up" or "Nothing left open". */
function describeOpenWork(outcome: Pick<EventOutcome, "openQuestions" | "followUps">): string {
  const parts: string[] = [];
  if (outcome.openQuestions.length)
    parts.push(`${outcome.openQuestions.length} open question${outcome.openQuestions.length === 1 ? "" : "s"}`);
  if (outcome.followUps.length)
    parts.push(`${outcome.followUps.length} follow-up${outcome.followUps.length === 1 ? "" : "s"}`);
  return parts.length ? parts.join(" · ") : "Nothing left open";
}

function Summary({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > LONG_SUMMARY;
  return (
    <div>
      <p
        className={`whitespace-pre-wrap text-sm leading-relaxed text-snow ${long && !open ? "line-clamp-5" : ""}`}
      >
        {text}
      </p>
      {long ? (
        <button
          type="button"
          className="mt-1 text-xs font-medium text-mist hover:text-snow"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "Show less" : "Read the full summary"}
        </button>
      ) : null}
    </div>
  );
}

/** The structured result, grouped so a person can scan questions, decisions and work. */
function OutcomeGroups({ outcome }: { outcome: Pick<EventOutcome, "openQuestions" | "decisions" | "accomplishments" | "followUps"> }) {
  const present = outcomeGroups.filter((group) => outcome[group.key].length > 0);
  if (present.length === 0) return null;
  return (
    <div className="space-y-3">
      {present.map((group) => (
        <section key={group.key} aria-label={group.title}>
          <h5 className={`flex items-center gap-1.5 text-[11px] font-semibold ${toneText[group.tone]}`}>
            {group.icon}
            {group.title}
            <span className="font-normal text-mist">{outcome[group.key].length}</span>
          </h5>
          <ul className="mt-1.5 space-y-1.5">
            {outcome[group.key].map((text, index) => (
              <li key={index} className="flex gap-2 text-sm leading-snug text-snow">
                <span aria-hidden="true" className="mt-[7px] size-1 shrink-0 rounded-full bg-mist/60" />
                <span className="min-w-0 break-words">{text}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function Contributors({ slugs, coworkers }: { slugs: string[]; coworkers: CoworkerSummary[] }) {
  if (slugs.length === 0) return null;
  const members = slugs
    .map((slug) => coworkers.find((member) => member.slug === slug))
    .filter((member): member is CoworkerSummary => Boolean(member));
  const names = slugs.map((slug) => coworkers.find((member) => member.slug === slug)?.name ?? slug);
  return (
    <p className="flex items-center gap-2 text-xs text-mist">
      {members.length ? (
        <GroupAvatars members={members} size={20} animated={false} />
      ) : null}
      <span className="min-w-0 break-words">{joinNames(names)} contributed</span>
    </p>
  );
}

export function EventDetails({
  selection,
  coworkers,
  onClose,
  onEdit,
  onOpenConversation,
  onOpenArtifact,
  onChanged,
  active,
}: {
  active: boolean;
  selection: EventSelection;
  coworkers: CoworkerSummary[];
  onClose: () => void;
  onEdit: (event: WorkplaceEvent) => void;
  onOpenConversation: (groupId: string) => Promise<void>;
  onOpenArtifact: (artifact: EventArtifact) => Promise<void>;
  onChanged: () => Promise<void>;
}) {
  const [detail, setDetail] = useState<EventDetail | null>(null);
  const [runId, setRunId] = useState(selection.runId ?? "");
  const [readError, setReadError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [allSessions, setAllSessions] = useState(false);
  const [goalOpen, setGoalOpen] = useState(false);
  const [artifactPreview, setArtifactPreview] = useState<{
    artifact: EventArtifact;
    document: Awaited<ReturnType<typeof coworkerBridge.events.document.read>>;
    runId: string;
    eventTitle: string;
  } | null>(null);
  const artifactHeading = useRef<HTMLHeadingElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const artifactOpener = useRef<HTMLButtonElement | null>(null);
  const artifactScope = useRef("");
  artifactScope.current = `${selection.eventId}:${runId}:${selection.requestId}`;
  const acting = useRef(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [uncertain, setUncertain] = useState(() =>
    runRequests.has(selection.eventId),
  );
  useEffect(() => {
    setRunId(selection.runId ?? "");
    setArtifactPreview(null);
  }, [selection.requestId, selection.runId]);
  useEffect(
    () => () => {
      artifactScope.current = "";
    },
    [],
  );
  useEffect(() => {
    if (
      !active ||
      (document.activeElement !== document.body &&
        !content.current
          ?.closest("[data-testid='calendar-event-panel']")
          ?.contains(document.activeElement))
    )
      return;
    if (artifactPreview)
      artifactHeading.current?.focus({ preventScroll: true });
    else if (artifactOpener.current?.isConnected)
      artifactOpener.current.focus({ preventScroll: true });
  }, [active, artifactPreview]);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let reading = false;
    const refresh = async () => {
      if (reading) return;
      reading = true;
      try {
        const value = await coworkerBridge.events.get(selection.eventId);
        if (!cancelled) {
          setDetail(value);
          setReadError("");
        }
      } catch (cause) {
        if (!cancelled)
          setReadError(
            `Event details are unavailable: ${cause instanceof Error ? cause.message : String(cause)}. Shown information may be stale.`,
          );
      } finally {
        reading = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [active, selection.eventId, refreshKey]);

  async function act(name: string, action: () => Promise<void>) {
    if (acting.current) return;
    acting.current = true;
    setBusy(name);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      acting.current = false;
      setBusy("");
      setRefreshKey((value) => value + 1);
    }
  }

  const sessions = useMemo(
    () => [...(detail?.runs ?? [])].sort((a, b) => b.scheduledFor - a.scheduledFor),
    [detail?.runs],
  );
  const selectedRun = detail?.runs.find((run) => run.id === runId);
  const snapshot = selectedRun?.event ?? detail?.event;
  const current = detail?.event;
  const name = (slug: string) =>
    coworkers.find((member) => member.slug === slug)?.name ??
    `${slug} (not on this team)`;
  const artifacts = selectedRun
    ? selectedRun.artifacts
    : (snapshot?.artifacts ?? []);
  const missingRun = Boolean(runId && detail && !selectedRun);
  const liveRun = detail?.runs.find(eventRunIsLive);
  const seriesEnded = Boolean(
    current &&
    current.schedule.kind !== "once" &&
    current.repeatUntil != null &&
    current.repeatUntil < Date.now(),
  );
  const hasUpcoming =
    current?.state === "active" &&
    !seriesEnded &&
    current.nextDueAt !== null &&
    (current.repeatUntil == null || current.nextDueAt <= current.repeatUntil);
  const continuity: EventContinuity | null | undefined = selectedRun
    ? selectedRun.continuity
    : detail?.continuity;
  const continuitySource = continuity?.sourceRunId
    ? detail?.runs.find((run) => run.id === continuity.sourceRunId)
    : undefined;
  const latestOutcome =
    !selectedRun && continuitySource?.outcomeStatus === "delivered"
      ? continuitySource.outcome
      : null;
  const participants = useMemo(() => {
    const slugs = current?.participantSlugs ?? [];
    return slugs
      .map((slug) => coworkers.find((member) => member.slug === slug))
      .filter((member): member is CoworkerSummary => Boolean(member));
  }, [current?.participantSlugs, coworkers]);
  // Who is "talking" in the hero follows the live session: participants still contributing, then the owner concluding.
  const talkingSlugs =
    liveRun?.status !== "running"
      ? []
      : liveRun.phase === "conclusion"
        ? [liveRun.event.leadSlug]
        : liveRun.phase === "contributions"
          ? liveRun.event.participantSlugs.filter((slug) => !liveRun.contributorSlugs.includes(slug))
          : [];
  const zoneNote = snapshot ? describeZone(snapshot.schedule.timezone) : "";

  // What is happening with this event right now, in one line.
  const situation: { tone: Tone; text: string; live: boolean } | null = !current
    ? null
    : liveRun
      ? {
          tone: "mint",
          live: true,
          text:
            liveRun.stopping
              ? "Stopping this session · awaiting confirmation"
              : liveRun.status === "queued"
                ? "A session is starting"
                : liveRun.status === "waiting" || liveRun.phase === "waiting"
                  ? "In session · waiting for delegated work"
                  : liveRun.phase === "conclusion"
                    ? `In session · ${name(current.leadSlug)} is wrapping up`
                    : `In session now · ${liveRun.contributorSlugs.length} of ${liveRun.event.participantSlugs.length} contributed`,
        }
      : current.state === "archived"
        ? { tone: "mist", live: false, text: "Archived · history is kept" }
        : current.state === "paused"
          ? { tone: "mist", live: false, text: "Paused · no future sessions until resumed" }
          : seriesEnded
            ? { tone: "mist", live: false, text: "Repeat period ended" }
            : hasUpcoming
              ? {
                  tone: "spark",
                  live: false,
                  text:
                    selection.at && selection.at > Date.now() && selection.at !== current.nextDueAt
                      ? `Session planned ${describeMoment(selection.at)}`
                      : `Next session ${describeMoment(current.nextDueAt)}`,
                }
              : { tone: "mist", live: false, text: "No upcoming session" };

  const others = current
    ? current.participantSlugs.filter((slug) => slug !== current.leadSlug).map(name)
    : [];
  const visibleSessions = allSessions ? sessions : sessions.slice(0, VISIBLE_SESSIONS);
  const runStatus = selectedRun ? describeRun(selectedRun) : null;
  const longGoal = (current?.objective.length ?? 0) > 240;

  function openArtifact(artifact: EventArtifact, target: HTMLButtonElement) {
    if (!selectedRun) {
      void act("current document", () => onOpenArtifact(artifact));
      return;
    }
    artifactOpener.current = target;
    const run = selectedRun;
    const scope = artifactScope.current;
    void act("document revision", async () => {
      const document = await coworkerBridge.events.document.read(
        selection.eventId,
        run.id,
        artifact,
      );
      if (
        document.id !== artifact.documentId ||
        document.revision !== artifact.revision
      )
        throw new Error(
          "The recorded document revision was not returned. No current version has been substituted.",
        );
      if (artifactScope.current === scope)
        setArtifactPreview({
          artifact,
          document,
          runId: run.id,
          eventTitle: run.event.title,
        });
    });
  }

  return (
    <EventSheet
      title={artifactPreview ? "Document" : "Event"}
      busy={Boolean(busy)}
      active={active}
      onClose={onClose}
    >
      <div
        ref={content}
        className="space-y-5 break-words"
        data-testid="event-detail"
        data-event-id={selection.eventId}
        data-run-id={runId}
      >
        {artifactPreview ? (
          <article
            className="space-y-4"
            data-testid="event-artifact-reader"
            data-document-id={artifactPreview.document.id}
            data-revision={artifactPreview.document.revision}
            data-run-id={artifactPreview.runId}
          >
            <Button
              variant="ghost"
              className="-ml-2 text-xs"
              disabled={Boolean(busy)}
              onClick={() => setArtifactPreview(null)}
            >
              ← Back to event
            </Button>
            <header className="space-y-1.5">
              <Eyebrow>
                Recorded revision {artifactPreview.document.revision} · read-only
              </Eyebrow>
              <h3
                ref={artifactHeading}
                tabIndex={-1}
                className="break-words text-lg font-semibold leading-snug text-snow outline-none"
              >
                {artifactPreview.document.title}
              </h3>
              <p className="text-xs text-mist">
                Owner:{" "}
                {artifactPreview.artifact.owner.kind === "coworker"
                  ? name(artifactPreview.artifact.owner.slug)
                  : `Shared documents for ${artifactPreview.eventTitle}`}
                {" · "}
                {artifactPreview.artifact.relation} in {artifactPreview.eventTitle}
                {artifactPreview.artifact.contributorSlug &&
                artifactPreview.artifact.contributorSlug !==
                  (artifactPreview.artifact.owner.kind === "coworker" ? artifactPreview.artifact.owner.slug : "")
                  ? ` by ${name(artifactPreview.artifact.contributorSlug)}`
                  : ""}
              </p>
            </header>
            <DocumentMarkdown
              text={artifactPreview.document.body}
              className="!mx-0 !max-w-none"
              onOpenDocument={() =>
                setError(
                  "This link does not name a recorded revision. Return to the event and select a recorded document, or open the current document separately.",
                )
              }
            />
            <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-3">
              <Button
                variant="ghost"
                className="text-xs"
                disabled={Boolean(busy)}
                onClick={() =>
                  void act("current document", () =>
                    onOpenArtifact(artifactPreview.artifact),
                  )
                }
              >
                Open current document
              </Button>
              <p className="text-[11px] text-mist">
                This is the exact revision this session used; the current document may have changed.
              </p>
            </footer>
          </article>
        ) : null}
        <div className={artifactPreview ? "hidden" : "space-y-5"}>
          {readError ? (
            <div role="alert" className="space-y-2">
              <ErrorNote>{readError}</ErrorNote>
              <Button
                variant="ghost"
                onClick={() => setRefreshKey((value) => value + 1)}
              >
                Refresh details
              </Button>
            </div>
          ) : null}
          {!detail && !readError ? (
            <p role="status" className="text-sm text-mist">
              Reading event and history…
            </p>
          ) : null}

          {snapshot && current ? (
            <>
              {/* Hero: who, what, when. */}
              <header className="space-y-3">
                <div className="flex items-start gap-3">
                  {participants.length ? (
                    <GroupAvatars members={participants} size={36} motion="navigation" activeSlugs={talkingSlugs} />
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <h3 className="break-words text-lg font-semibold leading-snug text-snow">
                      {current.title}
                    </h3>
                    <p className="mt-0.5 text-xs text-mist">
                      {describeScheduleForPeople(current.schedule)}
                      {current.durationMinutes ? ` · ${current.durationMinutes} min` : ""}
                    </p>
                    <p className="mt-0.5 text-xs text-mist">
                      Led by {name(current.leadSlug)}
                      {others.length ? ` · with ${joinNames(others)}` : ""}
                    </p>
                  </div>
                </div>
                {situation ? (
                  <p
                    role="status"
                    data-testid="event-situation"
                    className={`flex items-center gap-2 text-sm font-medium ${toneText[situation.tone]}`}
                  >
                    <StatusGlyph tone={situation.tone} live={situation.live} />
                    <span className="min-w-0 break-words">{sentenceCase(situation.text)}</span>
                  </p>
                ) : null}
                <div>
                  <p
                    className={`whitespace-pre-wrap text-sm leading-relaxed text-snow/90 ${longGoal && !goalOpen ? "line-clamp-3" : ""}`}
                  >
                    <span className="font-medium text-mist">Goal · </span>
                    {current.objective}
                  </p>
                  {longGoal ? (
                    <button
                      type="button"
                      className="mt-1 text-xs font-medium text-mist hover:text-snow"
                      aria-expanded={goalOpen}
                      onClick={() => setGoalOpen((value) => !value)}
                    >
                      {goalOpen ? "Show less" : "Read the full goal"}
                    </button>
                  ) : null}
                </div>
              </header>

              {/* The conversation is the way in; everything else is a receipt. */}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="primary"
                  className="inline-flex items-center gap-2"
                  disabled={Boolean(busy) || !snapshot.groupId}
                  onClick={() =>
                    void act("conversation", () =>
                      onOpenConversation(snapshot.groupId),
                    )
                  }
                  data-testid="event-open-conversation"
                >
                  <ConversationIcon />
                  Open conversation
                </Button>
                {current.state !== "archived" ? (
                  <Button
                    disabled={Boolean(busy) || Boolean(readError) || Boolean(liveRun)}
                    title={
                      liveRun
                        ? "A session is already in progress."
                        : "Starts a session now with the participants' models and normal inference usage."
                    }
                    data-testid="event-run-now"
                    onClick={() =>
                      void act("run", async () => {
                        const requestId =
                          runRequests.get(current.id) ?? crypto.randomUUID();
                        runRequests.set(current.id, requestId);
                        try {
                          const run = await coworkerBridge.events.runNow(
                            current.id,
                            requestId,
                          );
                          runRequests.delete(current.id);
                          setUncertain(false);
                          setRunId(run.id);
                          setDetail((value) =>
                            value
                              ? {
                                  ...value,
                                  runs: [
                                    run,
                                    ...value.runs.filter(
                                      (item) => item.id !== run.id,
                                    ),
                                  ],
                                }
                              : value,
                          );
                        } catch (cause) {
                          setUncertain(true);
                          throw cause;
                        }
                        void onChanged();
                      })
                    }
                  >
                    {uncertain ? "Retry same run request" : "Run now"}
                  </Button>
                ) : null}
                {liveRun ? (
                  <Button
                    variant="danger"
                    disabled={Boolean(busy) || Boolean(readError)}
                    title="Stops the session in progress. Its notes so far are kept."
                    onClick={() =>
                      void act("stop", async () => {
                        const run = await coworkerBridge.events.cancel(
                          current.id,
                          liveRun.id,
                        );
                        setDetail((value) =>
                          value
                            ? {
                                ...value,
                                runs: value.runs.map((item) =>
                                  item.id === run.id ? run : item,
                                ),
                              }
                            : value,
                        );
                        void onChanged();
                      })
                    }
                  >
                    Stop session
                  </Button>
                ) : null}
              </div>
              {uncertain ? (
                <p role="status" className="text-xs text-amber">
                  The last run request was not confirmed. History refreshes without
                  resending; Retry uses the same request.
                </p>
              ) : null}

              {missingRun ? (
                <ErrorNote>
                  This session is not in the loaded history. Nothing newer has been
                  substituted.
                </ErrorNote>
              ) : null}

              {/* The result card: one session's outcome, latest by default. */}
              {selectedRun && runStatus ? (
                <section
                  className="space-y-3 rounded-2xl border border-line bg-panel/45 p-4"
                  data-testid="event-outcome"
                  data-outcome-status={
                    selectedRun.outcome
                      ? (selectedRun.outcomeStatus ?? "unknown")
                      : "pending"
                  }
                >
                  <header className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Eyebrow>Session · {shortMoment(selectedRun.scheduledFor)}</Eyebrow>
                      {selectedRun.trigger !== "scheduled" ? (
                        <p className="mt-0.5 text-[11px] text-mist">
                          {selectedRun.trigger === "manual" ? "Started with Run now" : "Recovered after an interruption"}
                        </p>
                      ) : null}
                    </div>
                    <p
                      role="status"
                      className={`flex shrink-0 items-center gap-1.5 text-[11px] font-medium ${toneText[runStatus.tone]}`}
                    >
                      <StatusGlyph tone={runStatus.tone} live={runStatus.live} />
                      {runStatus.label}
                    </p>
                  </header>
                  {selectedRun.outcome ? (
                    <>
                      <Summary text={selectedRun.outcome.summary || "No summary text was recorded."} />
                      {selectedRun.outcomeStatus === "provisional" ? (
                        <p className="text-[11px] text-amber">
                          Provisional notes, not a delivered result.
                        </p>
                      ) : null}
                      <OutcomeGroups outcome={selectedRun.outcome} />
                    </>
                  ) : (
                    <p className="text-sm text-mist">
                      {runStatus.live
                        ? "The summary arrives when the lead wraps up."
                        : "No summary was recorded for this session."}
                    </p>
                  )}
                  {selectedRun.error ? <ErrorNote>{selectedRun.error}</ErrorNote> : null}
                  <Contributors slugs={selectedRun.contributorSlugs} coworkers={coworkers} />
                  {continuity?.sourceRunId ? (
                    <details
                      className="group border-t border-line/70 pt-2"
                      data-testid="event-carried-forward"
                      data-source-run-id={continuity.sourceRunId}
                    >
                      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11px] font-medium text-mist hover:text-snow">
                        <Disclosure />
                        Carried in from the previous session
                      </summary>
                      <div className="mt-2 space-y-3 text-sm">
                        {continuity.summary ? (
                          <p className="whitespace-pre-wrap text-xs leading-relaxed text-mist">{continuity.summary}</p>
                        ) : null}
                        <OutcomeGroups
                          outcome={{
                            openQuestions: continuity.openQuestions,
                            followUps: continuity.followUps,
                            decisions: [],
                            accomplishments: [],
                          }}
                        />
                        {continuity.note ? (
                          <p className="text-[11px] leading-relaxed text-mist">{continuity.note}</p>
                        ) : null}
                        {continuitySource ? (
                          <button
                            type="button"
                            className="text-xs font-medium text-mist hover:text-snow"
                            disabled={Boolean(busy)}
                            onClick={() => {
                              setRunId(continuitySource.id);
                              setArtifactPreview(null);
                            }}
                          >
                            View that session
                          </button>
                        ) : (
                          <p className="text-[11px] text-mist">
                            That session is outside the loaded history; these saved notes are kept.
                          </p>
                        )}
                      </div>
                    </details>
                  ) : null}
                </section>
              ) : !missingRun ? (
                <section
                  className="space-y-3 rounded-2xl border border-line bg-panel/45 p-4"
                  data-testid="event-latest-outcome"
                  data-source-run-id={continuity?.sourceRunId ?? undefined}
                >
                  {continuity?.sourceRunId ? (
                    <>
                      <header className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <Eyebrow>
                            Latest result
                            {continuitySource ? ` · ${shortDay(continuitySource.scheduledFor)}` : ""}
                          </Eyebrow>
                          <p className="mt-0.5 text-[11px] text-mist">
                            {describeOpenWork(latestOutcome ?? continuity)}
                          </p>
                        </div>
                        <p
                          role="status"
                          className={`flex shrink-0 items-center gap-1.5 text-[11px] font-medium ${latestOutcome ? "text-ready" : "text-mist"}`}
                        >
                          <StatusGlyph tone={latestOutcome ? "ready" : "mist"} live={false} />
                          {latestOutcome ? "Delivered" : "Saved notes"}
                        </p>
                      </header>
                      <Summary
                        text={
                          (latestOutcome?.summary ?? continuity.summary) ||
                          "No summary text was recorded in the delivered outcome."
                        }
                      />
                      <OutcomeGroups
                        outcome={
                          latestOutcome ?? {
                            openQuestions: continuity.openQuestions,
                            followUps: continuity.followUps,
                            decisions: [],
                            accomplishments: [],
                          }
                        }
                      />
                      {continuitySource ? (
                        <Contributors slugs={continuitySource.contributorSlugs} coworkers={coworkers} />
                      ) : (
                        <p className="text-[11px] text-mist">
                          From a session outside the loaded history; these saved notes are kept.
                        </p>
                      )}
                      {continuity.note ? (
                        <p className="text-[11px] leading-relaxed text-mist">{continuity.note}</p>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <Eyebrow>Results</Eyebrow>
                      <p className="text-sm text-mist">
                        {liveRun
                          ? "The first result arrives when this session wraps up."
                          : hasUpcoming
                            ? "Nothing yet. The first result appears here after the next session."
                            : "No delivered result yet."}
                      </p>
                    </>
                  )}
                </section>
              ) : null}

              {/* Documents this event works with. */}
              {artifacts.length ? (
                <section className="space-y-2" aria-label="Documents">
                  <Eyebrow>
                    Documents <span className="font-normal normal-case tracking-normal">{artifacts.length}</span>
                  </Eyebrow>
                  <ul className="divide-y divide-line/70 rounded-xl border border-line/70">
                    {artifacts.map((artifact, index) => (
                      <li
                        key={`${artifact.documentId}:${index}`}
                        className="flex items-center gap-3 px-3 py-2"
                      >
                        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-white/5 text-mist">
                          <DocumentIcon />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm text-snow" title={artifact.title || artifact.documentId}>
                            {artifact.title || artifact.documentId}
                          </p>
                          <p className="truncate text-[11px] text-mist">
                            {artifact.owner.kind === "coworker"
                              ? name(artifact.owner.slug)
                              : "Shared"}
                            {" · "}
                            {artifact.relation}
                            {selectedRun ? ` · revision ${artifact.revision}` : ""}
                            {artifact.contributorSlug && artifact.contributorSlug !== (artifact.owner.kind === "coworker" ? artifact.owner.slug : "")
                              ? ` · by ${name(artifact.contributorSlug)}`
                              : ""}
                          </p>
                        </div>
                        <Button
                          variant="ghost"
                          className="shrink-0 text-xs"
                          disabled={Boolean(busy)}
                          title={
                            selectedRun
                              ? "Opens the exact revision recorded for this session."
                              : "Opens the owner's current document."
                          }
                          onClick={(click) => openArtifact(artifact, click.currentTarget)}
                          data-testid={
                            selectedRun
                              ? "event-artifact-open-revision"
                              : "event-reference-open-current"
                          }
                        >
                          Open
                        </Button>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {/* Sessions: a glanceable history, one row each. */}
              {sessions.length ? (
                <section className="space-y-2" aria-label="Sessions">
                  <Eyebrow>
                    Sessions <span className="font-normal normal-case tracking-normal">{sessions.length}</span>
                  </Eyebrow>
                  <ul className="divide-y divide-line/70 rounded-xl border border-line/70" data-testid="event-sessions">
                    {visibleSessions.map((run) => {
                      const status = describeRun(run);
                      const selected = run.id === runId;
                      return (
                        <li key={run.id}>
                          <button
                            type="button"
                            aria-pressed={selected}
                            disabled={Boolean(busy)}
                            data-testid="event-session-row"
                            data-run-id={run.id}
                            className={`flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-white/5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-spark/60 ${selected ? "bg-white/6" : ""}`}
                            onClick={() => {
                              setRunId(selected ? "" : run.id);
                              setArtifactPreview(null);
                            }}
                          >
                            <StatusGlyph tone={status.tone} live={status.live} />
                            <span className="min-w-0 flex-1 truncate text-sm text-snow">
                              {shortMoment(run.scheduledFor)}
                            </span>
                            {run.trigger === "manual" ? (
                              <span className="shrink-0 text-[10px] text-mist">Run now</span>
                            ) : null}
                            <span className={`shrink-0 text-[11px] font-medium ${toneText[status.tone]}`}>
                              {status.label}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                  {sessions.length > VISIBLE_SESSIONS || selectedRun ? (
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                      {sessions.length > VISIBLE_SESSIONS ? (
                        <button
                          type="button"
                          className="text-xs font-medium text-mist hover:text-snow"
                          aria-expanded={allSessions}
                          onClick={() => setAllSessions((value) => !value)}
                        >
                          {allSessions
                            ? "Show fewer"
                            : `Show all ${sessions.length} sessions`}
                        </button>
                      ) : null}
                      {selectedRun ? (
                        <button
                          type="button"
                          className="text-xs font-medium text-mist hover:text-snow"
                          disabled={Boolean(busy)}
                          data-testid="event-show-current"
                          onClick={() => {
                            setRunId("");
                            setArtifactPreview(null);
                          }}
                        >
                          Back to the current plan
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </section>
              ) : null}

              {/* Everything else stays one click away. */}
              <details className="group rounded-xl border border-line/70">
                <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-xs font-medium text-mist hover:text-snow">
                  <Disclosure />
                  {selectedRun ? "Instructions used for this session" : "Instructions & settings"}
                  <span className="ml-auto text-[10px] font-normal">revision {snapshot.revision}</span>
                </summary>
                <div className="space-y-4 border-t border-line/70 px-3 py-3">
                  {selectedRun && snapshot.objective !== current.objective ? (
                    <section>
                      <h5 className="text-[11px] font-semibold text-mist">Goal at the time</h5>
                      <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-snow/90">
                        {snapshot.objective}
                      </p>
                    </section>
                  ) : null}
                  <section>
                    <h5 className="text-[11px] font-semibold text-mist">Working prompt</h5>
                    <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-snow/90">
                      {snapshot.description || "No extra instructions. The goal alone guides the session."}
                    </p>
                  </section>
                  <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs [&_dd]:min-w-0 [&_dd]:break-words [&_dd]:text-snow/90 [&_dt]:text-mist">
                    <dt>Participants</dt>
                    <dd>
                      <span className="flex flex-wrap items-center gap-1.5">
                        {snapshot.participantSlugs.map((slug) => {
                          const member = coworkers.find((item) => item.slug === slug);
                          return (
                            <span key={slug} className="inline-flex items-center gap-1 rounded-full border border-line/70 py-0.5 pl-0.5 pr-2">
                              {member ? (
                                <CoworkerAvatar
                                  identity={member.slug}
                                  name={member.name}
                                  color={member.avatarColor}
                                  glasses={member.avatarGlasses}
                                  size={16}
                                  motion="quiet"
                                  animated={false}
                                  gaze={false}
                                />
                              ) : null}
                              {name(slug)}
                              {slug === snapshot.leadSlug ? <span className="text-mist">· lead</span> : null}
                            </span>
                          );
                        })}
                      </span>
                    </dd>
                    <dt>Limits</dt>
                    <dd>
                      {snapshot.durationMinutes === null
                        ? "Up to 240 minutes"
                        : `${snapshot.durationMinutes} minutes`}{" "}
                      · at most {snapshot.maxReplies} replies
                    </dd>
                    {snapshot.schedule.kind !== "once" ? (
                      <>
                        <dt>Repeats until</dt>
                        <dd>
                          {snapshot.repeatUntil == null
                            ? "Until paused or archived"
                            : `${shortMoment(snapshot.repeatUntil)} (last start)`}
                        </dd>
                      </>
                    ) : null}
                    {selectedRun?.startedAt ? (
                      <>
                        <dt>Started</dt>
                        <dd>{shortMoment(selectedRun.startedAt)}</dd>
                      </>
                    ) : null}
                    {selectedRun?.finishedAt ? (
                      <>
                        <dt>Finished</dt>
                        <dd>{shortMoment(selectedRun.finishedAt)}</dd>
                      </>
                    ) : null}
                    <dt>Runs on</dt>
                    <dd>This computer, while Open Coworker is open</dd>
                    {zoneNote ? (
                      <>
                        <dt>Clock</dt>
                        <dd>Schedule keeps {snapshot.schedule.timezone} time {zoneNote}; times here are shown in your zone.</dd>
                      </>
                    ) : null}
                  </dl>
                </div>
              </details>

              {/* Quiet management; changes only reach future sessions. */}
              <footer className="space-y-2 border-t border-line pt-3">
                {seriesEnded ? (
                  <p className="text-xs text-mist" data-testid="event-series-ended">
                    {current.state === "archived"
                      ? "Archived; its history is kept."
                      : "The repeat period has ended. Choose a new time to continue, or Run now for a one-off session."}
                  </p>
                ) : null}
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="ghost"
                    className="text-xs"
                    disabled={Boolean(busy) || Boolean(readError)}
                    title="Changes apply to future sessions. Earlier plans and results stay in history."
                    onClick={() => onEdit(current)}
                  >
                    {seriesEnded ? "Choose a new time" : "Edit event"}
                  </Button>
                  {current.state !== "archived" ? (
                    <Button
                      variant="ghost"
                      className="text-xs"
                      disabled={Boolean(busy) || Boolean(readError)}
                      title={
                        current.state === "active"
                          ? "Future sessions will not start. A session already running continues."
                          : "Future sessions start again on schedule."
                      }
                      onClick={() =>
                        void act("pause", async () => {
                          const input = eventInputSchema.parse({
                            ...current,
                            state: current.state === "active" ? "paused" : "active",
                          });
                          const event = await coworkerBridge.events.update(
                            current.id,
                            input,
                            current.revision,
                          );
                          setDetail((value) =>
                            value ? { ...value, event } : value,
                          );
                          void onChanged();
                        })
                      }
                    >
                      {current.state === "active" ? "Pause" : "Resume"}
                    </Button>
                  ) : null}
                  <span className="ml-auto text-[11px] text-mist">
                    Applies to future sessions
                  </span>
                </div>
              </footer>
            </>
          ) : null}
        </div>
        {error ? (
          <div role="alert">
            <ErrorNote>{error}</ErrorNote>
          </div>
        ) : null}
        {busy ? (
          <p role="status" className="text-xs text-mist">
            Waiting for {busy} confirmation…
          </p>
        ) : null}
      </div>
    </EventSheet>
  );
}
