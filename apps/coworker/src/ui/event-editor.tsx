import { useRef, useState } from "react";
import { coworkerBridge, type CoworkerSummary } from "@/lib/bridge";
import {
  eventInputSchema,
  type EventArtifact,
  type EventInput,
  type WorkplaceEvent,
} from "@/lib/events";
import { Button, ErrorNote, Field, inputClass } from "@/ui/kit";
import { EventSheet } from "@/ui/event-sheet";
import { EventParticipants } from "@/ui/event-participants";

const DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
type Cadence = "once" | "daily" | "weekdays" | "weekly";

function wallTime(at: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (name: string) =>
    parts.find((part) => part.type === name)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

/** Resolve wall time in the chosen zone, not the machine's implicit zone. */
function startInZone(
  value: string,
  timezone: string,
  overlap: "reject" | "last" = "reject",
): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))
    throw new Error("Choose a complete start date and time.");
  const target = Date.parse(`${value}:00Z`);
  if (!Number.isFinite(target) || wallTime(target, "UTC") !== value)
    throw new Error("Choose a valid start date and time.");
  const offsets = new Set<number>();
  try {
    // Read both sides of nearby clock changes, including half-hour and two-hour DST.
    for (const days of [-2, -1, 0, 1, 2]) {
      const sample = target + days * 86400000;
      offsets.add(Date.parse(`${wallTime(sample, timezone)}:00Z`) - sample);
    }
  } catch {
    throw new Error("Choose a valid IANA time zone, such as Europe/Paris.");
  }
  const matches = [...offsets]
    .map((offset) => target - offset)
    .filter((at) => Number.isFinite(at) && wallTime(at, timezone) === value);
  const at = matches[0];
  if (at === undefined)
    throw new Error(
      "That local time does not exist because the clock changes. Choose another time.",
    );
  if (matches.length > 1 && overlap === "last") return Math.max(...matches);
  if (matches.length > 1)
    throw new Error(
      "That local time occurs twice when the clock changes. Choose an unambiguous time.",
    );
  return at;
}

function referenceKey(item: EventArtifact): string {
  return `${item.owner.kind === "coworker" ? `${item.owner.slug}:${item.owner.createdAt}` : item.owner.groupId}:${item.documentId}`;
}

export function EventEditor({
  event,
  coworkers,
  initialSlug,
  initialStartsAt,
  onSaved,
  onClose,
  active,
}: {
  active: boolean;
  event: WorkplaceEvent | null;
  coworkers: CoworkerSummary[];
  initialSlug?: string;
  initialStartsAt?: number;
  onSaved: (event: WorkplaceEvent) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<EventInput>(() => {
    if (event) return eventInputSchema.parse(event);
    const startsAt =
      initialStartsAt ?? Math.ceil((Date.now() + 3600000) / 3600000) * 3600000;
    return {
      title: "",
      description: "",
      objective: "",
      template: "working-session",
      leadSlug: "",
      participantSlugs: initialSlug ? [initialSlug] : [],
      startsAt,
      schedule: {
        kind: "once",
        at: startsAt,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      },
      durationMinutes: 30,
      maxReplies: 12,
      state: "active",
      artifacts: [],
    };
  });
  const [timezone, setTimezone] = useState(draft.schedule.timezone);
  const [start, setStart] = useState(() =>
    wallTime(draft.startsAt, draft.schedule.timezone),
  );
  const [time, setTime] = useState(() =>
    draft.schedule.kind === "once"
      ? wallTime(draft.startsAt, draft.schedule.timezone).slice(11)
      : `${String(draft.schedule.hour).padStart(2, "0")}:${String(draft.schedule.minute).padStart(2, "0")}`,
  );
  const [cadence, setCadence] = useState<Cadence>(() =>
    draft.schedule.kind === "weekly"
      ? draft.schedule.daysOfWeek.join(",") === "1,2,3,4,5"
        ? "weekdays"
        : "weekly"
      : draft.schedule.kind,
  );
  const [days, setDays] = useState<number[]>(
    draft.schedule.kind === "weekly" ? draft.schedule.daysOfWeek : [1],
  );
  const [untilDate, setUntilDate] = useState(() =>
    draft.repeatUntil == null
      ? ""
      : wallTime(draft.repeatUntil, draft.schedule.timezone).slice(0, 10),
  );
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [error, setError] = useState("");
  const [references, setReferences] = useState<EventArtifact[] | null>(null);
  const [referenceError, setReferenceError] = useState("");
  const [readingReferences, setReadingReferences] = useState(false);
  const members = coworkers.filter((coworker) =>
    draft.participantSlugs.includes(coworker.slug),
  );
  const missing = draft.participantSlugs.filter(
    (slug) => !coworkers.some((coworker) => coworker.slug === slug),
  );

  function toggleMember(slug: string) {
    setDraft((current) => {
      const participants = current.participantSlugs.includes(slug)
        ? current.participantSlugs.filter((member) => member !== slug)
        : [...current.participantSlugs, slug];
      return {
        ...current,
        participantSlugs: participants,
        leadSlug: participants.includes(current.leadSlug)
          ? current.leadSlug
          : "",
        maxReplies: Math.max(current.maxReplies, participants.length + 1),
      };
    });
  }

  async function save() {
    if (saving.current) return;
    setError("");
    let input: EventInput;
    try {
      if (missing.length)
        throw new Error(
          "Remove coworkers who are no longer on the team before saving future sessions.",
        );
      const zone = timezone.trim();
      const startsAt =
        zone === draft.schedule.timezone &&
        start === wallTime(draft.startsAt, draft.schedule.timezone)
          ? draft.startsAt
          : startInZone(start, zone);
      // The activation boundary and recurrence clock are independent persisted values.
      let schedule = draft.schedule;
      if (cadence === "once") {
        if (
          schedule.kind !== "once" ||
          schedule.at !== startsAt ||
          schedule.timezone !== zone
        ) {
          schedule = { kind: "once", at: startsAt, timezone: zone };
        }
      } else {
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
          throw new Error("Choose a valid session time.");
        const hour = Number(time.slice(0, 2));
        const minute = Number(time.slice(3));
        const sameTime =
          schedule.kind !== "once" &&
          schedule.hour === hour &&
          schedule.minute === minute &&
          schedule.timezone === zone;
        if (cadence === "daily") {
          if (schedule.kind !== "daily" || !sameTime) {
            schedule = { kind: "daily", hour, minute, timezone: zone };
          }
        } else {
          const daysOfWeek = cadence === "weekdays" ? [1, 2, 3, 4, 5] : days;
          if (
            schedule.kind !== "weekly" ||
            !sameTime ||
            schedule.daysOfWeek.length !== daysOfWeek.length ||
            schedule.daysOfWeek.some((day) => !daysOfWeek.includes(day))
          ) {
            schedule = {
              kind: "weekly",
              hour,
              minute,
              timezone: zone,
              daysOfWeek,
            };
          }
        }
      }
      let repeatUntil = draft.repeatUntil;
      if (cadence === "once" && draft.schedule.kind !== "once")
        repeatUntil = null;
      else if (cadence === "once") repeatUntil = draft.repeatUntil;
      else if (!untilDate) {
        if (repeatUntil != null) repeatUntil = null;
      } else if (
        repeatUntil == null ||
        zone !== draft.schedule.timezone ||
        untilDate !==
          wallTime(repeatUntil, draft.schedule.timezone).slice(0, 10)
      ) {
        // A whole-day cutoff includes both occurrences of a repeated final minute.
        repeatUntil = startInZone(`${untilDate}T23:59`, zone, "last") + 59999;
      }
      if (repeatUntil != null && repeatUntil < startsAt)
        throw new Error(
          "Repeat until must be on or after the schedule's start.",
        );
      input = eventInputSchema.parse({
        ...draft,
        startsAt,
        schedule,
        ...(repeatUntil === undefined ? {} : { repeatUntil }),
      });
    } catch (cause) {
      if (
        cause &&
        typeof cause === "object" &&
        "issues" in cause &&
        Array.isArray(cause.issues)
      ) {
        setError(
          cause.issues
            .map((issue: unknown) =>
              issue && typeof issue === "object" && "message" in issue
                ? String(issue.message)
                : "Check the event fields.",
            )
            .join(" "),
        );
      } else
        setError(
          cause instanceof Error
            ? cause.message
            : "Check the event fields and time zone.",
        );
      return;
    }
    saving.current = true;
    setBusy(true);
    try {
      onSaved(
        event
          ? await coworkerBridge.events.update(event.id, input, event.revision)
          : await coworkerBridge.events.create(input),
      );
    } catch (cause) {
      setError(
        `${cause instanceof Error ? cause.message : String(cause)} Your draft is kept. No automatic retry was made; check the calendar before trying again.`,
      );
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  async function loadReferences() {
    if (readingReferences) return;
    setReadingReferences(true);
    setReferenceError("");
    const found: EventArtifact[] = [];
    const failures: string[] = [];
    await Promise.all(
      members.map(async (member) => {
        try {
          const documents = await coworkerBridge.documents.list(member.slug);
          found.push(
            ...documents.map(
              (document): EventArtifact => ({
                owner: {
                  kind: "coworker",
                  slug: member.slug,
                  createdAt: member.createdAt,
                },
                documentId: document.id,
                title: document.title,
                revision: document.revision,
                relation: "used",
                contributorSlug: member.slug,
              }),
            ),
          );
        } catch {
          failures.push(member.name);
        }
      }),
    );
    if (event?.groupId) {
      try {
        const documents = await coworkerBridge.groups.documents.list(
          event.groupId,
        );
        found.push(
          ...documents.map(
            (document): EventArtifact => ({
              owner: { kind: "group", groupId: event.groupId },
              documentId: document.id,
              title: document.title,
              revision: document.revision,
              relation: "used",
              contributorSlug: document.authorSlug,
            }),
          ),
        );
      } catch {
        failures.push("Shared documents");
      }
    }
    setReferences(found);
    setReadingReferences(false);
    if (failures.length)
      setReferenceError(
        `Could not read: ${failures.join(", ")}. Existing references are kept.`,
      );
  }

  return (
    <EventSheet
      title={event ? "Edit event" : "New event"}
      busy={busy}
      active={active}
      onClose={onClose}
    >
      <form
        className="space-y-4 [&_input]:min-w-0 [&_select]:min-w-0 [&_label]:min-w-0"
        data-testid="event-editor"
        onSubmit={(submission) => {
          submission.preventDefault();
          void save();
        }}
      >
        <p className="text-xs leading-relaxed text-mist">
          Give the team a goal, choose who joins, and set a time. Sessions run
          on this computer while Open Coworker is open.{" "}
          {event
            ? "Edits apply to future sessions. Earlier sessions keep their instructions and results."
            : "Choose an owner before scheduling. Saving an active event enables its schedule."}
        </p>
        <fieldset disabled={busy} className="space-y-4">
          <Field label="Template">
            <select
              className={inputClass}
              value={draft.template}
              onChange={(change) => {
                if (change.target.value === "all-hands")
                  setDraft((value) => ({
                    ...value,
                    template: "all-hands",
                    title: "All Hands",
                    description: "A team check-in on progress and decisions.",
                    objective:
                      "Share what changed, surface decisions and blockers, and agree on useful next steps. Ground contributions in current work.",
                    participantSlugs: coworkers.map((member) => member.slug),
                    leadSlug: "",
                    maxReplies: Math.max(
                      value.maxReplies,
                      coworkers.length + 1,
                    ),
                  }));
                else
                  setDraft((value) => ({
                    ...value,
                    template: "working-session",
                  }));
              }}
            >
              <option value="working-session">Working session</option>
              <option value="all-hands">All Hands</option>
            </select>
          </Field>
          <Field label="Title">
            <input
              required
              maxLength={160}
              className={inputClass}
              value={draft.title}
              onChange={(change) =>
                setDraft((value) => ({ ...value, title: change.target.value }))
              }
            />
          </Field>
          <Field label="Goal">
            <textarea
              required
              maxLength={4000}
              className={`${inputClass} min-h-20`}
              placeholder="What should this session accomplish? What will done look like?"
              value={draft.objective}
              onChange={(change) =>
                setDraft((value) => ({
                  ...value,
                  objective: change.target.value,
                }))
              }
            />
            <p className="mt-1 text-[11px] text-mist">
              Name the result the team should work toward and how you will know
              it is done.
            </p>
          </Field>
          <Field label="Working prompt">
            <textarea
              maxLength={4000}
              className={`${inputClass} min-h-16`}
              placeholder="Optional instructions, agenda, or context for each session"
              value={draft.description}
              onChange={(change) =>
                setDraft((value) => ({
                  ...value,
                  description: change.target.value,
                }))
              }
            />
            <p className="mt-1 text-[11px] text-mist">
              Optional guidance the team uses each time this event runs.
            </p>
          </Field>
          <EventParticipants
            coworkers={coworkers}
            selected={draft.participantSlugs}
            leadSlug={draft.leadSlug}
            disabled={busy || !active}
            onToggle={toggleMember}
          />
          <Field label="Owner">
            <select
              required
              className={inputClass}
              value={draft.leadSlug}
              onChange={(change) =>
                setDraft((value) => ({
                  ...value,
                  leadSlug: change.target.value,
                }))
              }
            >
              <option value="">Choose and confirm an owner</option>
              {members.map((member) => (
                <option key={member.slug} value={member.slug}>
                  {member.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="grid gap-3 @min-[400px]/panel:grid-cols-2">
            <Field label={cadence === "once" ? "Start" : "Schedule begins"}>
              <input
                required
                type="datetime-local"
                className={inputClass}
                value={start}
                onChange={(change) => setStart(change.target.value)}
              />
            </Field>
            <Field label="Time zone">
              <input
                required
                className={inputClass}
                value={timezone}
                placeholder="Europe/Paris"
                onChange={(change) => setTimezone(change.target.value)}
              />
            </Field>
          </div>
          <p className="text-[11px] text-mist">
            {cadence === "once"
              ? "The start uses the named time zone."
              : "Schedule begins is when the series can start; Session time sets the time of each meeting."}{" "}
            Changing the zone keeps the date and time you entered. Other edits
            keep the saved timestamps and time zone.
          </p>
          <div className="grid gap-3 @min-[400px]/panel:grid-cols-2">
            <Field label="Repeat">
              <select
                className={inputClass}
                value={cadence}
                onChange={(change) => {
                  const value = change.target.value;
                  if (
                    value === "once" ||
                    value === "daily" ||
                    value === "weekdays" ||
                    value === "weekly"
                  ) {
                    if (
                      draft.schedule.kind === "once" &&
                      cadence === "once" &&
                      value !== "once"
                    )
                      setTime(start.slice(11));
                    setCadence(value);
                  }
                }}
              >
                <option value="once">Once</option>
                <option value="daily">Daily</option>
                <option value="weekdays">Weekdays</option>
                <option value="weekly">Weekly</option>
              </select>
            </Field>
            <Field label="Duration (minutes)">
              <input
                type="number"
                min={5}
                max={240}
                step={1}
                className={inputClass}
                placeholder="240-minute safety limit"
                value={draft.durationMinutes ?? ""}
                onChange={(change) =>
                  setDraft((value) => ({
                    ...value,
                    durationMinutes:
                      change.target.value === ""
                        ? null
                        : Number(change.target.value),
                  }))
                }
              />
            </Field>
          </div>
          {draft.durationMinutes === null ? (
            <p className="text-[11px] text-mist">
              Without a fixed duration, each session still stops after at most
              240 minutes.
            </p>
          ) : null}
          {cadence !== "once" ? (
            <Field label={`Session time / ${timezone}`}>
              <input
                required
                type="time"
                className={inputClass}
                value={time}
                onChange={(change) => setTime(change.target.value)}
              />
            </Field>
          ) : null}
          {cadence === "weekly" ? (
            <fieldset className="flex flex-wrap gap-3">
              <legend className="mb-2 text-xs text-mist">
                Days of the week
              </legend>
              {DAYS.map((day, index) => (
                <label
                  className="flex items-center gap-1 text-xs text-mist"
                  key={day}
                >
                  <input
                    type="checkbox"
                    className="accent-spark"
                    checked={days.includes(index)}
                    onChange={() =>
                      setDays((value) =>
                        value.includes(index)
                          ? value.filter((item) => item !== index)
                          : [...value, index].sort(),
                      )
                    }
                  />
                  {day}
                </label>
              ))}
            </fieldset>
          ) : null}
          {cadence !== "once" ? (
            <Field label="Repeat until">
              <input
                type="date"
                className={inputClass}
                value={untilDate}
                min={start.slice(0, 10)}
                onChange={(change) => setUntilDate(change.target.value)}
              />
              <p className="mt-1 text-[11px] leading-relaxed text-mist">
                Optional last day in {timezone}. Sessions may start through the
                end of that day. An unchanged date keeps its saved end time.
              </p>
              <p className="mt-2 text-[11px] leading-relaxed text-mist">
                Leave blank to repeat until paused. Each session keeps its own
                history. Resuming schedules the next future session; missed
                sessions are not replayed.
              </p>
            </Field>
          ) : null}
          <div className="grid gap-3 @min-[400px]/panel:grid-cols-2">
            <Field label="Reply limit">
              <input
                required
                type="number"
                min={Math.max(2, draft.participantSlugs.length + 1)}
                max={40}
                step={1}
                className={inputClass}
                value={draft.maxReplies}
                onChange={(change) =>
                  setDraft((value) => ({
                    ...value,
                    maxReplies: Number(change.target.value),
                  }))
                }
              />
            </Field>
            <Field label="Future sessions">
              <select
                className={inputClass}
                value={draft.state}
                onChange={(change) => {
                  const state = change.target.value;
                  if (state === "active" || state === "paused")
                    setDraft((value) => ({ ...value, state }));
                }}
              >
                <option value="active">Active</option>
                <option value="paused">Paused</option>
                {draft.state === "archived" ? (
                  <option value="archived">Archived (kept)</option>
                ) : null}
              </select>
            </Field>
          </div>
          <p className="text-[11px] text-mist">
            Allow at least {Math.max(2, draft.participantSlugs.length + 1)}{" "}
            replies: one per participant and the owner's conclusion. Pausing
            does not cancel a run already accepted.
          </p>
          <section className="space-y-2 border-t border-line pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-xs font-semibold text-mist">
                Attached document references ({draft.artifacts.length}/30)
              </h3>
              <Button
                type="button"
                variant="ghost"
                disabled={readingReferences}
                onClick={() => void loadReferences()}
              >
                {readingReferences ? "Reading..." : "Choose references"}
              </Button>
            </div>
            <p className="text-[11px] text-mist">
              Documents stay with their owners. A reference does not copy data
              or grant access.
            </p>
            {draft.artifacts.map((artifact) => (
              <div
                key={referenceKey(artifact)}
                className="flex items-center gap-2 text-xs text-snow"
              >
                <span className="min-w-0 flex-1 break-words">
                  {artifact.title || artifact.documentId} (revision{" "}
                  {artifact.revision})
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  className="text-xs"
                  onClick={() =>
                    setDraft((value) => ({
                      ...value,
                      artifacts: value.artifacts.filter(
                        (item) => referenceKey(item) !== referenceKey(artifact),
                      ),
                    }))
                  }
                >
                  Remove reference
                </Button>
              </div>
            ))}
            {references ? (
              <div className="max-h-44 space-y-2 overflow-y-auto">
                {references.length === 0 ? (
                  <p className="text-xs text-mist">
                    No documents available from these participants.
                  </p>
                ) : (
                  references
                    .filter(
                      (reference) =>
                        !draft.artifacts.some(
                          (item) =>
                            referenceKey(item) === referenceKey(reference),
                        ),
                    )
                    .map((reference) => (
                      <Button
                        type="button"
                        key={referenceKey(reference)}
                        variant="ghost"
                        className="block w-full text-left text-xs"
                        disabled={draft.artifacts.length >= 30}
                        onClick={() =>
                          setDraft((value) => ({
                            ...value,
                            artifacts: [...value.artifacts, reference],
                          }))
                        }
                      >
                        Attach {reference.title} (
                        {reference.owner.kind === "coworker"
                          ? reference.owner.slug
                          : "shared"}
                        )
                      </Button>
                    ))
                )}
              </div>
            ) : null}
            {referenceError ? <ErrorNote>{referenceError}</ErrorNote> : null}
          </section>
        </fieldset>
        {error ? (
          <div role="alert">
            <ErrorNote>{error}</ErrorNote>
          </div>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={busy}
            aria-busy={busy}
          >
            {event ? "Save future sessions" : "Create event"}
          </Button>
        </div>
      </form>
    </EventSheet>
  );
}
