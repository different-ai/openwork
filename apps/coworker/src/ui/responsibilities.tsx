import { useCallback, useEffect, useMemo, useState } from "react";
import type { AutomationList, AutomationSchedule } from "@openwork/types/automations";
import { coworkerBridge, type CoworkerSummary, type LocalResponsibility } from "@/lib/bridge";
import { createDenAutomationsClient, describeSchedule, type DenSession } from "@/lib/den";
import { Button, Empty, ErrorNote, Field, StatusDot, inputClass } from "@/ui/kit";

type AutomationEntry = AutomationList["items"][number];

function formatWhen(timestamp: number | null): string {
  if (!timestamp) return "Not scheduled";
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function stateLabel(state: string): string {
  if (state === "needs_attention") return "Needs you";
  const readable = state.replaceAll("_", " ");
  return readable.slice(0, 1).toUpperCase() + readable.slice(1);
}

export function ResponsibilitiesPanel({
  session,
  coworkers,
  coworker,
  onCoworkerChanged,
  onConnect,
}: {
  session: DenSession | null;
  coworkers: CoworkerSummary[];
  coworker: CoworkerSummary;
  onCoworkerChanged: (coworker: CoworkerSummary) => void;
  onConnect: () => void;
}) {
  const [mode, setMode] = useState<"local" | "cloud">(session ? "cloud" : "local");

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-snow">Responsibilities</h3>
        <p className="mt-0.5 text-xs text-mist">Work this coworker owns on a schedule</p>
      </div>
      <div className="grid grid-cols-2 rounded-xl border border-line bg-ink p-1">
        <button
          type="button"
          className={`rounded-lg px-2 py-1.5 text-[11px] font-medium ${mode === "cloud" ? "bg-white/8 text-snow" : "text-mist hover:text-snow"}`}
          onClick={() => setMode("cloud")}
        >
          OpenWork Cloud <span className="text-spark">· Recommended</span>
        </button>
        <button
          type="button"
          className={`rounded-lg px-2 py-1.5 text-[11px] font-medium ${mode === "local" ? "bg-white/8 text-snow" : "text-mist hover:text-snow"}`}
          onClick={() => setMode("local")}
        >
          This Mac
        </button>
      </div>
      {mode === "local" ? <LocalResponsibilitiesPanel coworker={coworker} /> : null}
      {mode === "cloud" && session ? (
        <CloudResponsibilitiesPanel
          session={session}
          coworkers={coworkers}
          coworker={coworker}
          onCoworkerChanged={onCoworkerChanged}
        />
      ) : null}
      {mode === "cloud" && !session ? (
        <div className="rounded-2xl border border-spark/25 bg-spark/5 p-4">
          <p className="text-xs font-semibold text-snow">Keep work running when this Mac is offline</p>
          <p className="mt-1 text-xs leading-relaxed text-mist">
            Connect OpenWork Cloud for always-on schedules, organization-managed providers, and centralized run history.
          </p>
          <Button variant="primary" className="mt-3 w-full text-xs" onClick={onConnect}>Connect OpenWork</Button>
        </div>
      ) : null}
    </div>
  );
}

function LocalResponsibilitiesPanel({ coworker }: { coworker: CoworkerSummary }) {
  const [items, setItems] = useState<LocalResponsibility[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [busyId, setBusyId] = useState("");

  const refresh = useCallback(async () => {
    try {
      setItems(await coworkerBridge.localResponsibilities.list(coworker.slug));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [coworker.slug]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function runNow(id: string) {
    setBusyId(id);
    setNotice("");
    try {
      const result = await coworkerBridge.localResponsibilities.runNow(coworker.slug, id);
      setNotice(result.accepted ? "Run started as a native OpenWork thread." : "This responsibility is already running.");
      window.setTimeout(() => void refresh(), 500);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId("");
    }
  }

  async function setActive(id: string, active: boolean) {
    setBusyId(id);
    try {
      await coworkerBridge.localResponsibilities.setActive(coworker.slug, id, active);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId("");
    }
  }

  async function remove(id: string) {
    setBusyId(id);
    try {
      await coworkerBridge.localResponsibilities.remove(coworker.slug, id);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId("");
    }
  }

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-line bg-panel/45 px-3 py-2.5 text-[11px] leading-relaxed text-mist">
        Runs through the local OpenWork engine while Open Coworker is open. One missed occurrence is recovered on the next launch.
      </div>
      <div className="flex justify-end">
        <Button variant="ghost" className="px-2 text-xs" onClick={() => setShowCreate((value) => !value)}>
          {showCreate ? "Close" : "+ New local responsibility"}
        </Button>
      </div>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {notice ? <p className="rounded-lg bg-mint/10 px-3 py-2 text-xs text-mint">{notice}</p> : null}
      {showCreate ? (
        <CreateLocalResponsibility
          coworker={coworker}
          onCreated={async () => {
            setShowCreate(false);
            await refresh();
          }}
        />
      ) : null}
      {items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line bg-ink p-3">
          <Empty>No local responsibilities yet.</Empty>
        </div>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => {
            const running = item.latestRun?.status === "running";
            const failed = item.latestRun?.status === "failed";
            return (
              <li key={item.id} className={`rounded-2xl border bg-ink p-3 ${failed ? "border-rose/30" : "border-line"}`}>
                <div className="flex items-start gap-2.5">
                  <span className="mt-1"><StatusDot tone={running ? "spark" : failed ? "rose" : item.state === "active" ? "mint" : "mist"} /></span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-semibold text-snow">{item.name}</p>
                      <span className="shrink-0 rounded-full bg-panel px-2 py-0.5 text-[10px] font-medium text-mist">
                        {running ? "Running" : item.state === "active" ? "Active" : "Paused"}
                      </span>
                    </div>
                    <p className="mt-1 text-xs leading-relaxed text-mist">{describeSchedule(item.schedule)}</p>
                  </div>
                </div>
                {item.latestRun?.error ? <p className="mt-2 rounded-lg bg-rose/8 px-2.5 py-2 text-xs text-rose">{item.latestRun.error}</p> : null}
                <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-lg bg-panel px-2.5 py-2">
                    <dt className="text-mist">Last run</dt>
                    <dd className="mt-0.5 truncate font-medium text-snow">
                      {item.latestRun ? `${stateLabel(item.latestRun.status)} · ${formatWhen(item.latestRun.finishedAt || item.latestRun.startedAt)}` : "Never"}
                    </dd>
                  </div>
                  <div className="rounded-lg bg-panel px-2.5 py-2">
                    <dt className="text-mist">Next run</dt>
                    <dd className="mt-0.5 truncate font-medium text-snow">{item.state === "active" ? formatWhen(item.nextDueAt) : "Paused"}</dd>
                  </div>
                </dl>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  <Button variant="primary" className="text-xs" disabled={busyId === item.id || running} onClick={() => void runNow(item.id)}>
                    {running ? "Running…" : "Run now"}
                  </Button>
                  <Button variant="ghost" className="text-xs" disabled={busyId === item.id} onClick={() => void setActive(item.id, item.state !== "active")}>
                    {item.state === "active" ? "Pause" : "Resume"}
                  </Button>
                  <Button variant="ghost" className="text-xs text-rose" disabled={busyId === item.id || running} onClick={() => void remove(item.id)}>
                    Remove
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Cloud Responsibilities remain native OpenWork Automations, with Den as scheduler. */
function CloudResponsibilitiesPanel({
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
  const [busyId, setBusyId] = useState("");

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
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
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
      const updated = await coworkerBridge.coworkers.update(coworker.slug, {
        automations: [...coworker.automations, automationId],
      });
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
    setBusyId(automationId);
    setNotice("");
    try {
      await den.runNow(automationId);
      setNotice("Run requested on OpenWork Cloud.");
      void refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId("");
    }
  }

  async function setActive(automationId: string, active: boolean) {
    setBusyId(automationId);
    setNotice("");
    try {
      await den.setActive(automationId, active);
      setNotice(active ? "Responsibility resumed." : "Responsibility paused.");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId("");
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-medium text-mist">Always-on through OpenWork Cloud</p>
        <Button variant="ghost" className="px-2" onClick={() => setShowCreate((value) => !value)}>
          {showCreate ? "Close" : "+ New"}
        </Button>
      </div>

      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {notice ? <p className="rounded-lg bg-mint/10 px-3 py-2 text-xs text-mint">{notice}</p> : null}
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
        <div className="rounded-2xl border border-dashed border-line bg-ink p-3">
          <Empty>No recurring work yet. Add a responsibility when this coworker should keep watch.</Empty>
        </div>
      ) : (
        <ul className="space-y-2">
          {owned.map((entry) => {
            const state = entry.automation.state;
            const needsAttention = state === "needs_attention";
            const tone = state === "active" ? "mint" : needsAttention ? "rose" : "mist";
            return (
              <li key={entry.automation.id} className={`rounded-2xl border bg-ink p-3 ${needsAttention ? "border-rose/30" : "border-line"}`}>
                <div className="flex items-start gap-2.5">
                  <span className="mt-1"><StatusDot tone={tone} /></span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-semibold text-snow">{entry.automation.name}</p>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${needsAttention ? "bg-rose/10 text-rose" : "bg-panel text-mist"}`}>
                        {stateLabel(state)}
                      </span>
                    </div>
                    <p className="mt-1 text-xs leading-relaxed text-mist">{describeSchedule(entry.revision.schedule)}</p>
                  </div>
                </div>

                {entry.automation.needsAttentionReason ? (
                  <p className="mt-2 rounded-lg bg-rose/8 px-2.5 py-2 text-xs leading-relaxed text-rose">
                    {entry.automation.needsAttentionReason.message}
                  </p>
                ) : null}

                <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-lg bg-panel px-2.5 py-2">
                    <dt className="text-mist">Last run</dt>
                    <dd className="mt-0.5 truncate font-medium text-snow">
                      {entry.latestRun ? `${stateLabel(entry.latestRun.status)} · ${formatWhen(entry.latestRun.finishedAt)}` : "Never"}
                    </dd>
                  </div>
                  <div className="rounded-lg bg-panel px-2.5 py-2">
                    <dt className="text-mist">Next run</dt>
                    <dd className="mt-0.5 truncate font-medium text-snow">
                      {needsAttention ? "Waiting for you" : formatWhen(entry.automation.nextDueAt)}
                    </dd>
                  </div>
                </dl>

                <div className="mt-3 flex flex-wrap gap-1.5">
                  <Button
                    variant="primary"
                    className="text-xs"
                    disabled={busyId === entry.automation.id || needsAttention}
                    onClick={() => void runNow(entry.automation.id)}
                  >
                    {busyId === entry.automation.id ? "Working…" : "Run now"}
                  </Button>
                  {state === "active" ? (
                    <Button variant="ghost" className="text-xs" disabled={busyId === entry.automation.id} onClick={() => void setActive(entry.automation.id, false)}>
                      Pause
                    </Button>
                  ) : state !== "archived" && !needsAttention ? (
                    <Button variant="ghost" className="text-xs" disabled={busyId === entry.automation.id} onClick={() => void setActive(entry.automation.id, true)}>
                      Resume
                    </Button>
                  ) : null}
                  <Button variant="ghost" className="text-xs" onClick={() => void release(entry.automation.id)}>
                    Release
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {others.length > 0 ? (
        <details className="rounded-2xl border border-line bg-ink p-3">
          <summary className="cursor-pointer text-xs font-medium text-mist">
            Browse {others.length} other organization automation{others.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-2 space-y-2">
            {others.map((entry) => {
              const owner = ownerOf(entry);
              return (
                <li key={entry.automation.id} className="rounded-xl bg-panel p-2.5">
                  <p className="text-xs font-medium text-snow">{entry.automation.name}</p>
                  <p className="mt-0.5 text-[11px] text-mist">{owner ? `Owned by ${owner.name}` : describeSchedule(entry.revision.schedule)}</p>
                  {!owner ? (
                    <button className="mt-1 text-[11px] font-medium text-spark hover:underline" onClick={() => void associate(entry.automation.id)}>
                      Assign to {coworker.name}
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function CreateLocalResponsibility({
  coworker,
  onCreated,
}: {
  coworker: CoworkerSummary;
  onCreated: () => Promise<void>;
}) {
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
      setError("Add a name, instructions, and valid time.");
      return;
    }
    const schedule: AutomationSchedule = cadence === "daily"
      ? { kind: "daily", timezone, hour, minute }
      : { kind: "weekly", timezone, daysOfWeek: [weekday], hour, minute };
    setBusy(true);
    setError("");
    try {
      await coworkerBridge.localResponsibilities.create(coworker.slug, {
        name: name.trim(),
        instructions: instructions.trim(),
        schedule,
      });
      await onCreated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ResponsibilityFields
      name={name}
      instructions={instructions}
      time={time}
      cadence={cadence}
      weekday={weekday}
      timezone={timezone}
      busy={busy}
      error={error}
      actionLabel="Create locally"
      onNameChange={setName}
      onInstructionsChange={setInstructions}
      onTimeChange={setTime}
      onCadenceChange={setCadence}
      onWeekdayChange={setWeekday}
      onSubmit={() => void create()}
    />
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
      setError("Add a name, instructions, and valid time.");
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
    <div className="space-y-3 rounded-2xl border border-line bg-ink p-3">
      <Field label="Name">
        <input className={`${inputClass} bg-panel`} value={name} placeholder="Morning competitor report" onChange={(event) => setName(event.target.value)} />
      </Field>
      <Field label="Instructions">
        <textarea className={`${inputClass} min-h-20 resize-y bg-panel`} value={instructions} placeholder="What should happen on every run?" onChange={(event) => setInstructions(event.target.value)} />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Cadence">
          <select className={`${inputClass} bg-panel`} value={cadence} onChange={(event) => setCadence(event.target.value === "weekly" ? "weekly" : "daily")}>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </select>
        </Field>
        {cadence === "weekly" ? (
          <Field label="Day">
            <select className={`${inputClass} bg-panel`} value={weekday} onChange={(event) => setWeekday(Number.parseInt(event.target.value, 10))}>
              {["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((label, index) => (
                <option key={label} value={index}>{label}</option>
              ))}
            </select>
          </Field>
        ) : null}
      </div>
      <Field label={`Time · ${timezone}`}>
        <input className={`${inputClass} bg-panel`} type="time" value={time} onChange={(event) => setTime(event.target.value)} />
      </Field>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <Button variant="primary" className="w-full" disabled={busy} onClick={() => void create()}>
        {busy ? "Creating…" : "Create responsibility"}
      </Button>
    </div>
  );
}

function ResponsibilityFields({
  name,
  instructions,
  time,
  cadence,
  weekday,
  timezone,
  busy,
  error,
  actionLabel,
  onNameChange,
  onInstructionsChange,
  onTimeChange,
  onCadenceChange,
  onWeekdayChange,
  onSubmit,
}: {
  name: string;
  instructions: string;
  time: string;
  cadence: "daily" | "weekly";
  weekday: number;
  timezone: string;
  busy: boolean;
  error: string;
  actionLabel: string;
  onNameChange: (value: string) => void;
  onInstructionsChange: (value: string) => void;
  onTimeChange: (value: string) => void;
  onCadenceChange: (value: "daily" | "weekly") => void;
  onWeekdayChange: (value: number) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="space-y-3 rounded-2xl border border-line bg-ink p-3">
      <Field label="Name">
        <input className={`${inputClass} bg-panel`} value={name} placeholder="Morning competitor report" onChange={(event) => onNameChange(event.target.value)} />
      </Field>
      <Field label="Instructions">
        <textarea className={`${inputClass} min-h-20 resize-y bg-panel`} value={instructions} placeholder="What should happen on every run?" onChange={(event) => onInstructionsChange(event.target.value)} />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Cadence">
          <select className={`${inputClass} bg-panel`} value={cadence} onChange={(event) => onCadenceChange(event.target.value === "weekly" ? "weekly" : "daily")}>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </select>
        </Field>
        {cadence === "weekly" ? (
          <Field label="Day">
            <select className={`${inputClass} bg-panel`} value={weekday} onChange={(event) => onWeekdayChange(Number.parseInt(event.target.value, 10))}>
              {["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((label, index) => (
                <option key={label} value={index}>{label}</option>
              ))}
            </select>
          </Field>
        ) : null}
      </div>
      <Field label={`Time · ${timezone}`}>
        <input className={`${inputClass} bg-panel`} type="time" value={time} onChange={(event) => onTimeChange(event.target.value)} />
      </Field>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <Button variant="primary" className="w-full" disabled={busy} onClick={onSubmit}>
        {busy ? "Creating…" : actionLabel}
      </Button>
    </div>
  );
}
