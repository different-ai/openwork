import { useEffect, useRef, useState } from "react";
import { coworkerBridge, type CoworkerSummary } from "@/lib/bridge";
import {
  eventInputSchema,
  eventRunIsLive,
  type EventArtifact,
  type EventDetail,
  type WorkplaceEvent,
} from "@/lib/events";
import { describeScheduleForPeople } from "@/lib/responsibility-copy";
import { Button, ErrorNote, inputClass } from "@/ui/kit";
import { EventSheet } from "@/ui/event-sheet";
import { DocumentMarkdown } from "@/ui/markdown";

// Uncertain requests retain their id even if the person closes and reopens the detail.
const runRequests = new Map<string, string>();
export type EventSelection = {
  eventId: string;
  runId?: string;
  at?: number;
  requestId: number;
};

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
  const selectedRun = detail?.runs.find((run) => run.id === runId);
  const snapshot = selectedRun?.event ?? detail?.event;
  const name = (slug: string) =>
    coworkers.find((member) => member.slug === slug)?.name ??
    `${slug} (not on this team)`;
  const artifacts = selectedRun
    ? selectedRun.artifacts
    : (snapshot?.artifacts ?? []);
  const missingRun = Boolean(runId && detail && !selectedRun);
  const live = detail?.runs.some(eventRunIsLive) ?? false;
  const current = detail?.event;
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
  const planStatus =
    current?.state === "archived"
      ? "Archived"
      : current?.state === "paused"
        ? "Paused"
        : seriesEnded
          ? "Repeat period ended"
          : hasUpcoming
            ? "Scheduled"
            : "No upcoming session";
  const continuity = selectedRun ? selectedRun.continuity : detail?.continuity;
  const continuitySource = continuity?.sourceRunId
    ? detail?.runs.find((run) => run.id === continuity.sourceRunId)
    : undefined;
  const currentOutcome = !selectedRun && continuitySource?.outcomeStatus === "delivered"
    ? continuitySource.outcome : null;
  const outcomeStatus = !selectedRun?.outcome
    ? "Summary pending"
    : selectedRun.outcomeStatus === "delivered"
      ? "Delivered outcome"
      : selectedRun.outcomeStatus === "provisional"
        ? "Provisional outcome / not yet delivered"
        : "Outcome delivery not confirmed";
  const moment = (at: number) =>
    new Date(at).toLocaleString(undefined, {
      timeZone: snapshot?.schedule.timezone,
      dateStyle: "medium",
      timeStyle: "short",
    });

  return (
    <EventSheet
      title={artifactPreview ? "Recorded event artifact" : "Event details"}
      busy={Boolean(busy)}
      active={active}
      onClose={onClose}
    >
      <div
        ref={content}
        className="space-y-4 break-words"
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
              disabled={Boolean(busy)}
              onClick={() => setArtifactPreview(null)}
            >
              Back to event
            </Button>
            <header>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-mist">
                Read-only / recorded revision{" "}
                {artifactPreview.document.revision}
              </p>
              <h3
                ref={artifactHeading}
                tabIndex={-1}
                className="mt-1 break-words text-lg font-semibold leading-snug text-snow outline-none"
              >
                {artifactPreview.document.title}
              </h3>
              <p className="mt-2 text-xs text-mist">
                Owner:{" "}
                {artifactPreview.artifact.owner.kind === "coworker"
                  ? name(artifactPreview.artifact.owner.slug)
                  : `Shared documents for ${artifactPreview.eventTitle}`}
              </p>
              <p className="mt-1 text-xs text-mist">
                {artifactPreview.artifact.relation} in{" "}
                {artifactPreview.eventTitle}
                {artifactPreview.artifact.contributorSlug
                  ? ` / contributor: ${name(artifactPreview.artifact.contributorSlug)}`
                  : ""}
              </p>
            </header>
            <p className="text-xs text-mist">
              This is the exact document revision referenced by this run, not
              the current document. It stays with its original owner.
            </p>
            <DocumentMarkdown
              text={artifactPreview.document.body}
              className="!mx-0 !max-w-none"
              onOpenDocument={() =>
                setError(
                  "This link does not name a recorded revision. Return to the event and select a recorded artifact, or open the current document separately.",
                )
              }
            />
            <div className="border-t border-line pt-3">
              <Button
                variant="ghost"
                disabled={Boolean(busy)}
                onClick={() =>
                  void act("current document", () =>
                    onOpenArtifact(artifactPreview.artifact),
                  )
                }
              >
                Open current document
              </Button>
              <p className="mt-1 text-[11px] text-mist">
                Opens the owner's separate document view. Its content may have
                changed since this run.
              </p>
            </div>
          </article>
        ) : null}
        <div className={artifactPreview ? "hidden" : "space-y-4"}>
          {readError ? (
            <div role="alert">
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
              Reading event and history...
            </p>
          ) : null}
          {detail ? (
            <label className="block text-xs text-mist">
              Session history
              <select
                className={`${inputClass} mt-1`}
                value={runId}
                disabled={Boolean(busy)}
                onChange={(change) => {
                  setRunId(change.target.value);
                  setArtifactPreview(null);
                }}
                data-testid="event-history-select"
              >
                <option value="">
                  Current plan
                  {hasUpcoming && selection.at
                    ? ` / scheduled ${moment(selection.at)}`
                    : !hasUpcoming
                      ? ` / ${planStatus.toLowerCase()}`
                      : ""}
                </option>
                {detail.runs.map((run) => (
                  <option value={run.id} key={run.id}>
                    {moment(run.scheduledFor)} / {run.trigger} / {run.status}
                  </option>
                ))}
                {missingRun ? (
                  <option value={runId}>Selected run unavailable</option>
                ) : null}
              </select>
            </label>
          ) : null}
          {missingRun ? (
            <ErrorNote>
              The selected run is not in the returned history. Its snapshot is
              unavailable; no newer run has been substituted.
            </ErrorNote>
          ) : snapshot ? (
            <>
              <header>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-mist">
                  {selectedRun
                    ? "Instructions used for this session"
                    : hasUpcoming
                      ? "Plan for upcoming sessions"
                      : planStatus}{" "}
                  / revision {snapshot.revision}
                </p>
                <h3 className="mt-1 break-words text-lg font-semibold leading-snug text-snow">
                  {snapshot.title}
                </h3>
              </header>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 rounded-xl border border-line bg-panel/40 p-3 text-xs [&_dd]:min-w-0 [&_dd]:break-words">
                <dt className="text-mist">Owner</dt>
                <dd>{name(snapshot.leadSlug)}</dd>
                <dt className="text-mist">Participants</dt>
                <dd className="break-words">
                  {snapshot.participantSlugs.map(name).join(", ")}
                </dd>
                <dt className="text-mist">Status</dt>
                <dd>
                  {selectedRun
                    ? `${selectedRun.status} / ${selectedRun.phase}`
                    : planStatus}
                </dd>
                <dt className="text-mist">When</dt>
                <dd>
                  {selectedRun
                    ? moment(selectedRun.scheduledFor)
                    : hasUpcoming
                      ? describeScheduleForPeople(snapshot.schedule)
                      : "No upcoming session"}{" "}
                  ({snapshot.schedule.timezone})
                </dd>
                <dt className="text-mist">Where</dt>
                <dd>This computer, while Open Coworker is open</dd>
                {snapshot.schedule.kind !== "once" ? (
                  <>
                    <dt className="text-mist">Repeat until</dt>
                    <dd>
                      {snapshot.repeatUntil == null
                        ? "Until paused"
                        : `${moment(snapshot.repeatUntil)} (last start)`}
                    </dd>
                  </>
                ) : null}
                <dt className="text-mist">Session limits</dt>
                <dd>
                  {snapshot.durationMinutes === null
                    ? "Up to 240 minutes (safety limit)"
                    : `${snapshot.durationMinutes} minutes`}{" "}
                  / at most {snapshot.maxReplies} replies
                </dd>
                {selectedRun?.startedAt ? (
                  <>
                    <dt className="text-mist">Started</dt>
                    <dd>{moment(selectedRun.startedAt)}</dd>
                  </>
                ) : null}
                {selectedRun?.finishedAt ? (
                  <>
                    <dt className="text-mist">Finished</dt>
                    <dd>{moment(selectedRun.finishedAt)}</dd>
                  </>
                ) : null}
              </dl>
              <section>
                <h4 className="text-xs font-semibold text-mist">Goal</h4>
                <p className="mt-1 whitespace-pre-wrap text-sm text-snow">
                  {snapshot.objective}
                </p>
              </section>
              <section>
                <h4 className="text-xs font-semibold text-mist">
                  Working prompt
                </h4>
                <p className="mt-1 whitespace-pre-wrap text-sm text-snow">
                  {snapshot.description ||
                    "No additional instructions for this session."}
                </p>
              </section>
              <section
                className="space-y-3 border-t border-line pt-3"
                data-testid={
                  selectedRun ? "event-carried-forward" : "event-latest-outcome"
                }
                data-source-run-id={continuity?.sourceRunId ?? undefined}
              >
                <h4 className="text-xs font-semibold text-mist">
                  {selectedRun
                    ? "Carried forward into this session"
                    : "Latest delivered outcome"}
                </h4>
                <p className="text-[11px] leading-relaxed text-mist">
                  {selectedRun
                    ? "These notes were saved when this session began. They are separate from its new outcome below."
                    : "The last delivered result and unfinished work are shown here; you do not need to open history first."}
                </p>
                <section>
                  <h5 className="text-xs font-semibold text-mist">
                    {selectedRun ? "Previous summary" : "Outcome summary"}
                  </h5>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-snow">
                    {continuity?.sourceRunId
                      ? (currentOutcome?.summary ?? continuity.summary) ||
                        "No summary text was recorded in the delivered outcome."
                      : selectedRun
                        ? "No earlier delivered summary was recorded for this session."
                        : "Summary pending. No delivered outcome is available yet."}
                  </p>
                </section>
                {!selectedRun &&
                continuitySource?.outcome &&
                continuitySource.outcomeStatus === "delivered"
                  ? [
                      {
                        title: "Decisions",
                        items: continuitySource.outcome.decisions,
                      },
                      {
                        title: "Accomplishments",
                        items: continuitySource.outcome.accomplishments,
                      },
                    ].map((section) => (
                      <section key={section.title}>
                        <h5 className="text-xs font-semibold text-mist">
                          {section.title}
                        </h5>
                        {section.items.length ? (
                          <ul className="mt-1 list-disc space-y-1 pl-4 text-sm text-snow">
                            {section.items.map((text, index) => (
                              <li key={index}>{text}</li>
                            ))}
                          </ul>
                        ) : (
                          <p className="mt-1 text-xs text-mist">
                            None recorded in that outcome.
                          </p>
                        )}
                      </section>
                    ))
                  : null}
                {[
                  {
                    title: "Pending questions",
                    items: currentOutcome?.openQuestions ?? continuity?.openQuestions ?? [],
                  },
                  { title: "Follow-ups", items: currentOutcome?.followUps ?? continuity?.followUps ?? [] },
                ].map((section) => (
                  <section key={section.title}>
                    <h5 className="text-xs font-semibold text-mist">
                      {section.title}
                    </h5>
                    {section.title === "Pending questions" ? (
                      <p className="mt-1 text-[11px] text-mist">
                        Work questions from the previous delivered outcome, not
                        app permission requests or approvals.
                      </p>
                    ) : null}
                    {continuity?.sourceRunId && section.items.length ? (
                      <ul className="mt-1 list-disc space-y-1 pl-4 text-sm text-snow">
                        {section.items.map((text, index) => (
                          <li key={index}>{text}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-1 text-xs text-mist">
                        {continuity?.sourceRunId
                          ? "None recorded in that outcome."
                          : selectedRun
                            ? "No earlier delivered outcome recorded."
                            : "Awaiting a delivered outcome."}
                      </p>
                    )}
                  </section>
                ))}
                {continuity?.previousRunId && continuity.previousStatus ? (
                  <p className="text-xs text-mist">
                    {selectedRun ? "Previous session" : "Most recent session"}:{" "}
                    {continuity.previousStatus}.
                  </p>
                ) : null}
                {continuity?.note ? (
                  <p className="text-xs leading-relaxed text-mist">
                    {continuity.note}
                  </p>
                ) : null}
                {continuitySource ? (
                  <Button
                    variant="ghost"
                    className="text-xs"
                    disabled={Boolean(busy)}
                    onClick={() => {
                      setRunId(continuitySource.id);
                      setArtifactPreview(null);
                    }}
                  >
                    View source session
                  </Button>
                ) : continuity?.sourceRunId ? (
                  <p className="text-[11px] text-mist">
                    The source session is outside the loaded history; these
                    saved notes are kept.
                  </p>
                ) : null}
              </section>
              {selectedRun ? (
                <section
                  className="space-y-3 border-t border-line pt-3"
                  data-testid="event-outcome"
                  data-outcome-status={
                    selectedRun.outcome
                      ? (selectedRun.outcomeStatus ?? "unknown")
                      : "pending"
                  }
                >
                  <h4 className="text-xs font-semibold text-mist">
                    Outcome summary
                  </h4>
                  <p
                    role="status"
                    className={`text-[11px] ${selectedRun.outcomeStatus === "delivered" && selectedRun.outcome ? "text-ready" : "text-mist"}`}
                  >
                    {outcomeStatus}
                  </p>
                  <p className="whitespace-pre-wrap text-sm text-snow">
                    {selectedRun.outcome?.summary ||
                      (eventRunIsLive(selectedRun)
                        ? "Summary pending. This session is still in progress or waiting for work."
                        : "Summary pending. No summary was recorded for this session.")}
                  </p>
                  {selectedRun.outcomeStatus === "provisional" &&
                  selectedRun.outcome ? (
                    <p className="text-[11px] text-mist">
                      These are provisional notes, not a delivered result.
                    </p>
                  ) : null}
                  {selectedRun.outcome
                    ? [
                        {
                          title: "Decisions",
                          items: selectedRun.outcome.decisions,
                        },
                        {
                          title: "Accomplishments",
                          items: selectedRun.outcome.accomplishments,
                        },
                        {
                          title: "Pending questions",
                          items: selectedRun.outcome.openQuestions,
                        },
                        {
                          title: "Follow-ups",
                          items: selectedRun.outcome.followUps,
                        },
                      ].map((section) => (
                        <section key={section.title}>
                          <h5 className="text-xs font-semibold text-mist">
                            {section.title}
                          </h5>
                          {section.title === "Pending questions" ? (
                            <p className="mt-1 text-[11px] text-mist">
                              Work questions recorded in this session's outcome,
                              not app permission requests or approvals.
                            </p>
                          ) : null}
                          {section.items.length ? (
                            <ul className="mt-1 list-disc space-y-1 pl-4 text-sm text-snow">
                              {section.items.map((text, index) => (
                                <li key={index}>{text}</li>
                              ))}
                            </ul>
                          ) : (
                            <p className="mt-1 text-xs text-mist">
                              None recorded.
                            </p>
                          )}
                        </section>
                      ))
                    : null}
                  <p className="text-xs text-mist">
                    Contributors:{" "}
                    {selectedRun.contributorSlugs.length
                      ? selectedRun.contributorSlugs.map(name).join(", ")
                      : "None recorded yet"}
                  </p>
                  {selectedRun.error ? (
                    <ErrorNote>{selectedRun.error}</ErrorNote>
                  ) : null}
                </section>
              ) : (
                <p className="text-xs text-mist">
                  {hasUpcoming
                    ? "Upcoming sessions use the current goal and working prompt."
                    : "No upcoming session is scheduled."}{" "}
                  Earlier sessions keep their own plans and results in history.
                </p>
              )}
              <section className="space-y-2 border-t border-line pt-3">
                <h4 className="text-xs font-semibold text-mist">
                  Artifacts and references
                </h4>
                {artifacts.length === 0 ? (
                  <p className="text-xs text-mist">
                    No document references recorded.
                  </p>
                ) : (
                  artifacts.map((artifact, index) => (
                    <div
                      className="flex items-start gap-2"
                      key={`${artifact.documentId}:${index}`}
                    >
                      <div className="min-w-0 flex-1">
                        <p className="break-words text-sm text-snow">
                          {artifact.title || artifact.documentId}
                        </p>
                        <p className="text-[11px] text-mist">
                          {artifact.relation} / revision {artifact.revision} /{" "}
                          {artifact.owner.kind === "coworker"
                            ? name(artifact.owner.slug)
                            : "shared group document"}
                          {artifact.contributorSlug
                            ? ` / ${name(artifact.contributorSlug)}`
                            : ""}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        className="text-xs"
                        disabled={Boolean(busy)}
                        onClick={(click) => {
                          if (!selectedRun) {
                            void act("current document", () =>
                              onOpenArtifact(artifact),
                            );
                            return;
                          }
                          artifactOpener.current = click.currentTarget;
                          const run = selectedRun;
                          const scope = artifactScope.current;
                          void act("document revision", async () => {
                            const document =
                              await coworkerBridge.events.document.read(
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
                        }}
                        data-testid={
                          selectedRun
                            ? "event-artifact-open-revision"
                            : "event-reference-open-current"
                        }
                      >
                        {selectedRun
                          ? `View revision ${artifact.revision}`
                          : "Open current document"}
                      </Button>
                    </div>
                  ))
                )}
                <p className="text-[11px] text-mist">
                  {selectedRun
                    ? "View revision reads the exact recorded document through this run. If it is unavailable, a current version is never substituted."
                    : "These are references on the event definition, not recorded run artifacts. Select a run to read its exact revisions; opening a current document is a separate action."}
                </p>
              </section>
              <Button
                variant="ghost"
                disabled={Boolean(busy) || !snapshot.groupId}
                onClick={() =>
                  void act("conversation", () =>
                    onOpenConversation(snapshot.groupId),
                  )
                }
                data-testid="event-open-conversation"
              >
                Open conversation
              </Button>
            </>
          ) : null}
          {detail ? (
            <section className="space-y-3 border-t border-line pt-4">
              <p className="text-xs text-mist">
                Changes apply to future sessions. Earlier plans and results stay
                in history. Pausing does not cancel a session already running.
              </p>
              {seriesEnded ? (
                <p
                  className="text-xs text-mist"
                  data-testid="event-series-ended"
                >
                  The repeat period has ended.{" "}
                  {detail.event.state === "archived"
                    ? "This event is archived and its history is kept."
                    : "Choose a new time to schedule more sessions, or use Run now for a separate session."}
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={Boolean(busy) || Boolean(readError)}
                  onClick={() => onEdit(detail.event)}
                >
                  {seriesEnded ? "Choose a new time" : "Edit future sessions"}
                </Button>
                {detail.event.state !== "archived" ? (
                  <Button
                    variant="ghost"
                    disabled={Boolean(busy) || Boolean(readError)}
                    onClick={() =>
                      void act("pause", async () => {
                        const input = eventInputSchema.parse({
                          ...detail.event,
                          state:
                            detail.event.state === "active"
                              ? "paused"
                              : "active",
                        });
                        const event = await coworkerBridge.events.update(
                          detail.event.id,
                          input,
                          detail.event.revision,
                        );
                        setDetail((value) =>
                          value ? { ...value, event } : value,
                        );
                        void onChanged();
                      })
                    }
                  >
                    {detail.event.state === "active"
                      ? "Pause future sessions"
                      : "Resume future sessions"}
                  </Button>
                ) : null}
                <Button
                  variant="primary"
                  disabled={
                    Boolean(busy) ||
                    Boolean(readError) ||
                    live ||
                    detail.event.state === "archived"
                  }
                  data-testid="event-run-now"
                  onClick={() =>
                    void act("run", async () => {
                      const requestId =
                        runRequests.get(detail.event.id) ?? crypto.randomUUID();
                      runRequests.set(detail.event.id, requestId);
                      try {
                        const run = await coworkerBridge.events.runNow(
                          detail.event.id,
                          requestId,
                        );
                        runRequests.delete(detail.event.id);
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
                {selectedRun && eventRunIsLive(selectedRun) ? (
                  <Button
                    variant="danger"
                    disabled={Boolean(busy) || Boolean(readError)}
                    onClick={() =>
                      void act("cancel", async () => {
                        const run = await coworkerBridge.events.cancel(
                          detail.event.id,
                          selectedRun.id,
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
                    Cancel this run
                  </Button>
                ) : null}
              </div>
              {uncertain ? (
                <p role="status" className="text-xs text-amber">
                  The previous run request was not confirmed. History refreshes
                  without resending. An explicit retry uses the same request ID.
                </p>
              ) : (
                <p className="text-[11px] text-mist">
                  Run now starts work with the participants' models and normal
                  inference usage.
                </p>
              )}
            </section>
          ) : null}
        </div>
        {error ? (
          <div role="alert">
            <ErrorNote>{error}</ErrorNote>
          </div>
        ) : null}
        {busy ? (
          <p role="status" className="text-xs text-mist">
            Waiting for {busy} confirmation...
          </p>
        ) : null}
      </div>
    </EventSheet>
  );
}
