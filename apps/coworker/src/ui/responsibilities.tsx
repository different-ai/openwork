import { useCallback, useEffect, useMemo, useState } from "react";
import type { AutomationList, AutomationModel, AutomationSchedule } from "@openwork/types/automations";
import { coworkerBridge, type CoworkerSummary, type LocalResponsibility } from "@/lib/bridge";
import {
  cloudModelOptions,
  describePlacement,
  describeRunOutcome,
  resolveCloudModel,
  type CloudModelOption,
  type DenLlmProvider,
} from "@/lib/cloud-responsibilities";
import { createDenAutomationsClient, describeSchedule, type DenSession } from "@/lib/den";
import { ActionMenu, Button, ErrorNote, Field, StatusDot, inputClass, type ActionMenuItem } from "@/ui/kit";

type AutomationEntry = AutomationList["items"][number];
type Placement = "cloud" | "local";

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

/** One row of the unified list, whichever place it runs. */
type ResponsibilityRow = {
  key: string;
  name: string;
  placement: string;
  schedule: string;
  next: string;
  /** "Succeeded · Sep 2, 9:00 AM" or empty when it has never run. */
  last: string;
  lastFailed: boolean;
  /** Short state pill; empty for an ordinary active responsibility. */
  state: string;
  tone: "spark" | "mint" | "amber" | "rose" | "mist";
  /** Explanation shown only when this row cannot run here. */
  warning: string;
  attention: string;
  actions: ActionMenuItem[];
};

const PLACEMENT_NOTE =
  "OpenWork Cloud runs even when this Mac is off but cannot read this coworker's local files. This Mac can use those files but runs only while Open Coworker is open.";

export function ResponsibilitiesPanel({
  session,
  coworkers,
  coworker,
  localItems,
  onLocalItemsChanged,
  onCoworkerChanged,
  onConnect,
}: {
  session: DenSession | null;
  coworkers: CoworkerSummary[];
  coworker: CoworkerSummary;
  /** Local responsibilities, polled by the sidebar so Recent and this list share one read. */
  localItems: LocalResponsibility[];
  onLocalItemsChanged: (items: LocalResponsibility[]) => void;
  onCoworkerChanged: (coworker: CoworkerSummary) => void;
  onConnect: () => void;
}) {
  const [adding, setAdding] = useState<Placement | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const den = useMemo(() => (session ? createDenAutomationsClient(session) : null), [session]);
  const [entries, setEntries] = useState<AutomationEntry[]>([]);

  const refreshLocal = useCallback(async () => {
    try {
      onLocalItemsChanged(await coworkerBridge.localResponsibilities.list(coworker.slug));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [coworker.slug, onLocalItemsChanged]);

  const refreshCloud = useCallback(async () => {
    if (!den) {
      setEntries([]);
      return;
    }
    try {
      const list = await den.list();
      setEntries(list.items);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [den]);

  useEffect(() => {
    void refreshCloud();
    if (!den) return;
    const timer = window.setInterval(() => void refreshCloud(), 15_000);
    return () => window.clearInterval(timer);
  }, [den, refreshCloud]);

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

  async function act(key: string, work: () => Promise<string>) {
    setBusyKey(key);
    setError("");
    setNotice("");
    try {
      const message = await work();
      if (message) setNotice(message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyKey("");
    }
  }

  async function associate(automationId: string) {
    await act(automationId, async () => {
      onCoworkerChanged(
        await coworkerBridge.coworkers.update(coworker.slug, { automations: [...coworker.automations, automationId] }),
      );
      return "";
    });
  }

  const localRows: ResponsibilityRow[] = localItems.map((item) => {
    const running = item.latestRun?.status === "running";
    const failed = item.latestRun?.status === "failed";
    const paused = item.state !== "active";
    return {
      key: `local:${item.id}`,
      name: item.name,
      placement: "This Mac",
      schedule: describeSchedule(item.schedule),
      next: paused ? "Paused" : running ? "Running now" : formatWhen(item.nextDueAt),
      last: item.latestRun && !running
        ? `${stateLabel(item.latestRun.status)} · ${formatWhen(item.latestRun.finishedAt || item.latestRun.startedAt)}`
        : "",
      lastFailed: Boolean(failed),
      state: running ? "Running" : paused ? "Paused" : failed ? "Failed" : "",
      tone: running ? "spark" : failed ? "rose" : paused ? "mist" : "mint",
      warning: "",
      attention: failed ? item.latestRun?.error ?? "" : "",
      actions: [
        {
          label: running ? "Running…" : "Run now",
          disabled: running,
          onSelect: () => void act(`local:${item.id}`, async () => {
            const result = await coworkerBridge.localResponsibilities.runNow(coworker.slug, item.id);
            window.setTimeout(() => void refreshLocal(), 500);
            return result.accepted ? "Run started." : "This responsibility is already running.";
          }),
        },
        {
          label: paused ? "Resume" : "Pause",
          onSelect: () => void act(`local:${item.id}`, async () => {
            await coworkerBridge.localResponsibilities.setActive(coworker.slug, item.id, paused);
            await refreshLocal();
            return "";
          }),
        },
        {
          label: "Remove",
          tone: "danger",
          disabled: running,
          onSelect: () => void act(`local:${item.id}`, async () => {
            await coworkerBridge.localResponsibilities.remove(coworker.slug, item.id);
            await refreshLocal();
            return "";
          }),
        },
      ],
    };
  });

  const cloudRows: ResponsibilityRow[] = owned.map((entry) => {
    const state = entry.automation.state;
    const needsAttention = state === "needs_attention";
    const paused = state !== "active" && !needsAttention;
    const placement = describePlacement(entry.revision.executionTarget);
    const lastRunFailed = Boolean(entry.latestRun && entry.latestRun.status !== "succeeded");
    const id = entry.automation.id;
    return {
      key: `cloud:${id}`,
      name: entry.automation.name,
      placement: placement.label,
      schedule: describeSchedule(entry.revision.schedule),
      next: needsAttention ? "Waiting for you" : paused ? stateLabel(state) : formatWhen(entry.automation.nextDueAt),
      last: entry.latestRun ? `${describeRunOutcome(entry.latestRun)} · ${formatWhen(entry.latestRun.finishedAt)}` : "",
      lastFailed: lastRunFailed,
      state: needsAttention ? "Needs you" : paused ? stateLabel(state) : "",
      tone: needsAttention ? "rose" : paused ? "mist" : "mint",
      warning: placement.target === "cloud" ? "" : placement.detail,
      attention: entry.automation.needsAttentionReason?.message ?? "",
      actions: [
        {
          label: "Run now",
          disabled: needsAttention,
          onSelect: () => void act(`cloud:${id}`, async () => {
            if (!den) return "";
            await den.runNow(id);
            void refreshCloud();
            return placement.target === "cloud"
              ? "Run requested in OpenWork Cloud."
              : "Run requested. It starts only when the OpenWork desktop app is open for your account.";
          }),
        },
        ...(state === "active" || (state !== "archived" && !needsAttention)
          ? [{
              label: state === "active" ? "Pause" : "Resume",
              onSelect: () => void act(`cloud:${id}`, async () => {
                if (!den) return "";
                await den.setActive(id, state !== "active");
                await refreshCloud();
                return "";
              }),
            }]
          : []),
        {
          label: "Release",
          tone: "danger" as const,
          onSelect: () => void act(`cloud:${id}`, async () => {
            onCoworkerChanged(
              await coworkerBridge.coworkers.update(coworker.slug, {
                automations: coworker.automations.filter((candidate) => candidate !== id),
              }),
            );
            return "";
          }),
        },
      ],
    };
  });

  const rows = [...cloudRows, ...localRows];
  const canAdd = adding === null;

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-3 px-1">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-mist">Responsibilities</h3>
        {rows.length > 0 && canAdd ? (
          <button
            type="button"
            className="rounded-lg px-2 py-1 text-[11px] font-medium text-spark transition-colors hover:bg-spark/10"
            onClick={() => setAdding(session ? "cloud" : "local")}
          >
            + Add
          </button>
        ) : null}
      </div>

      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {notice ? <p className="rounded-lg bg-mint/10 px-3 py-2 text-xs text-mint" data-testid="responsibility-notice">{notice}</p> : null}

      {adding ? (
        <AddResponsibility
          session={session}
          coworker={coworker}
          placement={adding}
          onPlacementChange={setAdding}
          onConnect={onConnect}
          onCancel={() => setAdding(null)}
          onCreatedLocal={async () => {
            setAdding(null);
            await refreshLocal();
          }}
          onCreatedCloud={async (automationId) => {
            setAdding(null);
            await associate(automationId);
            void refreshCloud();
          }}
        />
      ) : null}

      {rows.length === 0 && canAdd ? (
        <div className="rounded-2xl border border-dashed border-line bg-ink px-4 py-5 text-center" data-testid="responsibilities-empty">
          <p className="text-xs text-mist">No responsibilities yet.</p>
          <Button variant="default" className="mt-3 text-xs" onClick={() => setAdding(session ? "cloud" : "local")}>
            Add responsibility
          </Button>
        </div>
      ) : null}

      {rows.length > 0 ? (
        <ul className="divide-y divide-line rounded-2xl border border-line bg-ink" data-testid="responsibility-list">
          {rows.map((row) => (
            <li key={row.key} className="px-3.5 py-3" data-testid="responsibility-row">
              <div className="flex items-start gap-2.5">
                <span className="mt-1.5"><StatusDot tone={row.tone} /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <p className="min-w-0 break-words text-sm font-semibold leading-snug text-snow">{row.name}</p>
                    <ActionMenu label={`Actions for ${row.name}`} items={row.actions.map((action) => ({ ...action, disabled: action.disabled || busyKey === row.key }))} />
                  </div>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-mist">
                    <span className={`rounded-full px-1.5 py-px font-medium ${row.placement === "OpenWork Cloud" ? "bg-spark/10 text-spark" : row.placement === "This Mac" ? "bg-white/7 text-mist" : "bg-amber/10 text-amber"}`}>
                      {row.placement}
                    </span>
                    <span>{row.schedule}</span>
                    {row.state ? <span className={`font-medium ${row.tone === "rose" ? "text-rose" : row.tone === "spark" ? "text-spark" : "text-mist"}`}>· {row.state}</span> : null}
                  </p>
                  <p className="mt-1 text-[11px] text-mist">
                    <span>Next: {row.next}</span>
                    {row.last ? <span className={row.lastFailed ? "text-amber" : ""}> · Last: {row.last}</span> : null}
                  </p>
                  {row.attention ? <p className="mt-1.5 break-words rounded-lg bg-rose/8 px-2.5 py-1.5 text-[11px] leading-relaxed text-rose">{row.attention}</p> : null}
                  {row.warning ? <p className="mt-1.5 rounded-lg bg-amber/8 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber">{row.warning}</p> : null}
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {rows.length > 0 && !adding ? (
        <p className="px-1 text-[11px] leading-relaxed text-mist/80" data-testid="responsibility-placement-note">{PLACEMENT_NOTE}</p>
      ) : null}

      {others.length > 0 ? (
        <details className="rounded-2xl border border-line bg-ink px-3 py-2.5">
          <summary className="cursor-pointer text-xs font-medium text-mist">
            {others.length} other organization automation{others.length === 1 ? "" : "s"}
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

/** One form for both places; the placement switch explains each choice once. */
function AddResponsibility({
  session,
  coworker,
  placement,
  onPlacementChange,
  onConnect,
  onCancel,
  onCreatedLocal,
  onCreatedCloud,
}: {
  session: DenSession | null;
  coworker: CoworkerSummary;
  placement: Placement;
  onPlacementChange: (placement: Placement) => void;
  onConnect: () => void;
  onCancel: () => void;
  onCreatedLocal: () => Promise<void>;
  onCreatedCloud: (automationId: string) => Promise<void>;
}) {
  return (
    <div className="space-y-3 rounded-2xl border border-line bg-ink p-3" data-testid="add-responsibility">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-semibold text-snow">New responsibility</p>
        <Button variant="ghost" className="px-2 text-xs" onClick={onCancel}>Cancel</Button>
      </div>
      <div className="grid grid-cols-2 rounded-lg border border-line bg-panel/60 p-0.5" role="radiogroup" aria-label="Where it runs">
        <button
          type="button"
          role="radio"
          aria-checked={placement === "cloud"}
          className={`rounded-md px-2 py-1.5 text-[11px] font-medium ${placement === "cloud" ? "bg-white/8 text-snow" : "text-mist hover:text-snow"}`}
          onClick={() => onPlacementChange("cloud")}
        >
          OpenWork Cloud{session ? " · Recommended" : ""}
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={placement === "local"}
          className={`rounded-md px-2 py-1.5 text-[11px] font-medium ${placement === "local" ? "bg-white/8 text-snow" : "text-mist hover:text-snow"}`}
          onClick={() => onPlacementChange("local")}
        >
          This Mac
        </button>
      </div>
      <p className="text-[11px] leading-relaxed text-mist">
        {placement === "cloud"
          ? "Runs in OpenWork Cloud even when this Mac is off, with models your organization authorizes. Cloud runs cannot read this coworker's local files or memory."
          : "Runs on this Mac with full access to this coworker's files, only while Open Coworker is open. If a run is missed, the latest one is recovered on the next launch."}
      </p>
      {placement === "cloud" && !session ? (
        <div className="rounded-xl border border-spark/25 bg-spark/5 p-3">
          <p className="text-xs text-snow">Sign in to OpenWork to run responsibilities in the cloud.</p>
          <Button variant="primary" className="mt-2 w-full text-xs" onClick={onConnect}>Continue with OpenWork</Button>
        </div>
      ) : null}
      {placement === "local" ? <CreateLocalResponsibility coworker={coworker} onCreated={onCreatedLocal} /> : null}
      {placement === "cloud" && session ? <CreateResponsibility session={session} coworker={coworker} onCreated={onCreatedCloud} /> : null}
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
      actionLabel="Create responsibility"
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
  coworker,
  onCreated,
}: {
  session: DenSession;
  coworker: CoworkerSummary;
  onCreated: (automationId: string) => Promise<void>;
}) {
  const den = useMemo(() => createDenAutomationsClient(session), [session]);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [time, setTime] = useState("09:00");
  const [cadence, setCadence] = useState<"daily" | "weekly">("daily");
  const [weekday, setWeekday] = useState(1);
  const [providers, setProviders] = useState<DenLlmProvider[]>([]);
  const [providersError, setProvidersError] = useState("");
  const [modelId, setModelId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const options: CloudModelOption[] = useMemo(() => cloudModelOptions(providers), [providers]);
  const preferred = useMemo(
    () => resolveCloudModel({ model: coworker.model, modelVariant: coworker.modelVariant }, providers, options),
    [coworker.model, coworker.modelVariant, options, providers],
  );
  const preferredId = `${preferred.model.providerId}/${preferred.model.modelId}`;
  const effectiveModelId = options.some((option) => option.id === modelId) ? modelId : preferredId;

  useEffect(() => {
    let cancelled = false;
    den
      .listCloudProviders()
      .then((list) => {
        if (!cancelled) setProviders(list);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setProvidersError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [den]);

  async function create() {
    const [hourRaw, minuteRaw] = time.split(":");
    const hour = Number.parseInt(hourRaw ?? "", 10);
    const minute = Number.parseInt(minuteRaw ?? "", 10);
    if (!name.trim() || !instructions.trim() || Number.isNaN(hour) || Number.isNaN(minute)) {
      setError("Add a name, instructions, and valid time.");
      return;
    }
    const selected = options.find((option) => option.id === effectiveModelId);
    if (!selected) {
      setError("Choose a model your organization authorizes for OpenWork Cloud.");
      return;
    }
    const schedule: AutomationSchedule =
      cadence === "daily"
        ? { kind: "daily", timezone, hour, minute }
        : { kind: "weekly", timezone, daysOfWeek: [weekday], hour, minute };
    // Keep the coworker's reasoning variant only when the Cloud model is the
    // one its local preference resolved to; other models get the provider default.
    const model: AutomationModel = {
      providerId: selected.providerId,
      modelId: selected.modelId,
      variant: selected.id === preferredId ? preferred.model.variant ?? null : null,
    };
    setBusy(true);
    setError("");
    try {
      const detail = await den.create({ name: name.trim(), instructions: instructions.trim(), schedule, model });
      await onCreated(detail.automation.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 border-t border-line pt-3">
      <Field label="Name">
        <input className={`${inputClass} bg-panel`} value={name} placeholder="Morning competitor report" onChange={(event) => setName(event.target.value)} />
      </Field>
      <Field label="Instructions">
        <textarea className={`${inputClass} min-h-20 resize-y bg-panel`} value={instructions} placeholder="What should happen on every run?" onChange={(event) => setInstructions(event.target.value)} />
      </Field>
      <Field label="AI model in OpenWork Cloud">
        <select className={`${inputClass} bg-panel`} value={effectiveModelId} onChange={(event) => setModelId(event.target.value)}>
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.providerName} · {option.modelName}
              {option.accessKind === "free" ? " (free starter)" : ""}
            </option>
          ))}
        </select>
      </Field>
      <p className="text-[11px] leading-relaxed text-mist">
        {preferred.resolution === "default" && coworker.model
          ? `${coworker.name}'s usual AI model (${coworker.model}) is not authorized in OpenWork Cloud, so the free starter is preselected.`
          : "Cloud runs can only use AI models your organization authorizes in OpenWork."}
      </p>
      {providersError ? <ErrorNote>Could not read organization models: {providersError}</ErrorNote> : null}
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
    <div className="space-y-3 border-t border-line pt-3">
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
