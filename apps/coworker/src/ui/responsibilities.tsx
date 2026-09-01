import { useCallback, useEffect, useMemo, useState } from "react";
import type { AutomationList, AutomationSchedule } from "@openwork/types/automations";
import { coworkerBridge, type CoworkerSummary } from "@/lib/bridge";
import { createDenAutomationsClient, describeSchedule, type DenSession } from "@/lib/den";
import { Button, Empty, ErrorNote, Field, Section, StatusDot, inputClass } from "@/ui/kit";

type AutomationEntry = AutomationList["items"][number];

/**
 * Responsibilities are plain OpenWork Automations, re-presented coworker-first.
 * The coworker ⇄ automation association lives in the coworker's own coworker.md (and in the
 * automation's existing pinned workspaceId), never in a new Den column.
 */
export function ResponsibilitiesPanel({
  session,
  coworkers,
  coworker,
  onCoworkerChanged,
}: {
  session: DenSession;
  coworkers: CoworkerSummary[];
  coworker: CoworkerSummary;
  onCoworkerChanged: (coworker: CoworkerSummary) => void;
}) {
  const den = useMemo(() => createDenAutomationsClient(session), [session]);
  const [entries, setEntries] = useState<AutomationEntry[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showCreate, setShowCreate] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const list = await den.list();
      setEntries(list.items);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [den]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const belongsTo = useCallback(
    (entry: AutomationEntry, candidate: CoworkerSummary) =>
      candidate.automations.includes(entry.automation.id) ||
      Boolean(candidate.workspaceId && entry.revision.workspaceId === candidate.workspaceId),
    [],
  );
  const owned = entries.filter((entry) => belongsTo(entry, coworker));
  const others = entries.filter((entry) => !owned.includes(entry));
  const ownerOf = (entry: AutomationEntry) =>
    coworkers.find((candidate) => candidate.slug !== coworker.slug && belongsTo(entry, candidate)) ?? null;

  async function associate(automationId: string) {
    try {
      const updated = await coworkerBridge.coworkers.update(coworker.slug, { automations: [...coworker.automations, automationId] });
      onCoworkerChanged(updated);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function release(automationId: string) {
    try {
      const updated = await coworkerBridge.coworkers.update(coworker.slug, {
        automations: coworker.automations.filter((id) => id !== automationId),
      });
      onCoworkerChanged(updated);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function runNow(automationId: string) {
    setNotice("");
    try {
      await den.runNow(automationId);
      setNotice("Run requested. It executes on your OpenWork Cloud schedule runner.");
      void refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <div className="space-y-4">
      <Section
        title="Responsibilities"
        actions={
          <>
            <Button variant="ghost" onClick={() => void refresh()}>
              Refresh
            </Button>
            <Button variant="primary" onClick={() => setShowCreate((value) => !value)}>
              {showCreate ? "Close" : "New responsibility"}
            </Button>
          </>
        }
      >
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        {notice ? <p className="mb-3 text-sm text-mint">{notice}</p> : null}
        {showCreate ? (
          <CreateResponsibility
            onCreated={async (automationId) => {
              setShowCreate(false);
              await associate(automationId);
              void refresh();
            }}
            session={session}
          />
        ) : null}
        {owned.length === 0 ? (
          <Empty>
            {coworker.name} owns no recurring work yet. Create a responsibility, or assign an existing
            automation below.
          </Empty>
        ) : (
          <ul className="divide-y divide-line">
            {owned.map((entry) => (
              <li key={entry.automation.id} className="flex items-center gap-3 py-3">
                <StatusDot
                  tone={
                    entry.automation.state === "active"
                      ? "mint"
                      : entry.automation.state === "needs_attention"
                        ? "rose"
                        : "mist"
                  }
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-snow">{entry.automation.name}</p>
                  <p className="truncate text-xs text-mist">
                    {describeSchedule(entry.revision.schedule)}
                    {entry.latestRun ? ` · last run ${entry.latestRun.status}` : " · never run"}
                    {entry.automation.nextDueAt ? ` · next ${new Date(entry.automation.nextDueAt).toLocaleString()}` : ""}
                  </p>
                </div>
                <Button variant="ghost" onClick={() => void runNow(entry.automation.id)}>
                  Run now
                </Button>
                <Button variant="ghost" onClick={() => void release(entry.automation.id)}>
                  Release
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Section>
      {others.length > 0 ? (
        <Section title="Other automations in your organization">
          <ul className="divide-y divide-line">
            {others.map((entry) => {
              const owner = ownerOf(entry);
              return (
                <li key={entry.automation.id} className="flex items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-snow">{entry.automation.name}</p>
                    <p className="truncate text-xs text-mist">{describeSchedule(entry.revision.schedule)}</p>
                  </div>
                  {owner ? (
                    <span className="shrink-0 text-xs text-mist">Owned by {owner.name}</span>
                  ) : (
                    <Button variant="ghost" onClick={() => void associate(entry.automation.id)}>
                      Assign to {coworker.name}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}

function CreateResponsibility({
  session,
  onCreated,
}: {
  session: DenSession;
  onCreated: (automationId: string) => Promise<void>;
}) {
  const den = useMemo(() => createDenAutomationsClient(session), [session]);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [time, setTime] = useState("09:00");
  const [cadence, setCadence] = useState<"daily" | "weekly">("daily");
  const [weekday, setWeekday] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function create() {
    const [hourRaw, minuteRaw] = time.split(":");
    const hour = Number.parseInt(hourRaw ?? "", 10);
    const minute = Number.parseInt(minuteRaw ?? "", 10);
    if (!name.trim() || !instructions.trim() || Number.isNaN(hour) || Number.isNaN(minute)) {
      setError("Name, instructions, and a valid time are required.");
      return;
    }
    const schedule: AutomationSchedule =
      cadence === "daily"
        ? { kind: "daily", timezone, hour, minute }
        : { kind: "weekly", timezone, daysOfWeek: [weekday], hour, minute };
    setBusy(true);
    setError("");
    try {
      const detail = await den.create({ name: name.trim(), instructions: instructions.trim(), schedule });
      await onCreated(detail.automation.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-4 space-y-3 rounded-lg border border-line bg-panel-2 p-4">
      <Field label="Name">
        <input className={inputClass} value={name} placeholder="Morning competitor report" onChange={(event) => setName(event.target.value)} />
      </Field>
      <Field label="Instructions">
        <textarea
          className={`${inputClass} min-h-20 resize-y`}
          value={instructions}
          placeholder="What should happen on every run?"
          onChange={(event) => setInstructions(event.target.value)}
        />
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Cadence">
          <select className={inputClass} value={cadence} onChange={(event) => setCadence(event.target.value === "weekly" ? "weekly" : "daily")}>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </select>
        </Field>
        {cadence === "weekly" ? (
          <Field label="Day">
            <select className={inputClass} value={weekday} onChange={(event) => setWeekday(Number.parseInt(event.target.value, 10))}>
              {["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((label, index) => (
                <option key={label} value={index}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        <Field label={`Time (${timezone})`}>
          <input className={inputClass} type="time" value={time} onChange={(event) => setTime(event.target.value)} />
        </Field>
      </div>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <div className="flex justify-end">
        <Button variant="primary" disabled={busy} onClick={() => void create()}>
          {busy ? "Creating…" : "Create responsibility"}
        </Button>
      </div>
    </div>
  );
}
