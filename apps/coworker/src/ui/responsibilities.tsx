import { useCallback, useEffect, useMemo, useState } from "react";
import type { AutomationList, AutomationModel, AutomationRun, AutomationSchedule } from "@openwork/types/automations";
import { coworkerBridge, type CoworkerSummary, type LocalResponsibility } from "@/lib/bridge";
import {
  cloudModelOptions,
  describePlacement,
  resolveCloudModel,
  type CloudModelOption,
  type DenLlmProvider,
} from "@/lib/cloud-responsibilities";
import { explainRunPrompt } from "@/lib/conversation";
import { createDenAutomationsClient, type DenSession } from "@/lib/den";
import {
  describeDurationForPeople,
  describeMoment,
  describeRowStatus,
  describeRunTrend,
  describeScheduleForPeople,
  describeWhere,
  outcomeForPrompt,
  sentenceCase,
} from "@/lib/responsibility-copy";
import { cloudRunEntry, describeRunOutcome, localRunEntry, type RunEntry } from "@/lib/run-history";
import { ActionMenu, Button, ErrorNote, Field, StatusDot, inputClass, type ActionMenuItem } from "@/ui/kit";

type AutomationEntry = AutomationList["items"][number];
type Placement = "cloud" | "local";
type Tone = "spark" | "mint" | "amber" | "rose" | "mist";

function stateLabel(state: string): string {
  if (state === "needs_attention") return "Needs you";
  const readable = state.replaceAll("_", " ");
  return readable.slice(0, 1).toUpperCase() + readable.slice(1);
}

/**
 * One row of the list, whichever place it runs. The row itself is one plain
 * line; everything else waits behind it in the detail.
 */
type ResponsibilityRow = {
  key: string;
  name: string;
  /** Where it runs, as a sentence: only the detail says this; a Cloud row also carries a small tag. */
  where: string;
  cloud: boolean;
  /** "Every day at 9:00 AM (Paris time)". */
  schedule: string;
  /** "Done today at 12:05 PM", "Working on it now", "Next: tomorrow at 9:00 AM". */
  status: string;
  statusTone: Tone;
  /** The next occurrence in plain words, or empty when there is none. */
  next: string;
  paused: boolean;
  /** Newest run of any state and newest run that finished. */
  latest: RunEntry | undefined;
  finished: RunEntry | undefined;
  /** Machine-readable state for the row element; "active" when nothing special is happening. */
  state: string;
  tone: Tone;
  /** Shown only when this row cannot run here. */
  warning: string;
  /** What went wrong the last time, in the system's words; kept behind a disclosure. */
  attention: string;
  actions: ActionMenuItem[];
  /** Known runs, newest first; cloud rows load theirs when opened. */
  history: RunEntry[] | null;
  loadHistory?: () => Promise<void>;
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
  onOpenThread,
  onExplain,
}: {
  session: DenSession | null;
  coworkers: CoworkerSummary[];
  coworker: CoworkerSummary;
  /** Local responsibilities, polled by the sidebar so Recent and this list share one read. */
  localItems: LocalResponsibility[];
  onLocalItemsChanged: (items: LocalResponsibility[]) => void;
  onCoworkerChanged: (coworker: CoworkerSummary) => void;
  onConnect: () => void;
  /** Open a run's native thread in the main column. */
  onOpenThread: (threadId: string) => void;
  /** Put a ready-to-send message in the coworker's discussion composer. */
  onExplain: (message: string) => void;
}) {
  const [adding, setAdding] = useState<Placement | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [cloudRuns, setCloudRuns] = useState<Record<string, AutomationRun[]>>({});
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

  function explain(name: string, entry: RunEntry) {
    onExplain(explainRunPrompt({
      responsibilityName: name,
      outcome: outcomeForPrompt(entry.outcome),
      when: describeMoment(entry.at),
      summary: entry.summary,
      error: entry.error,
    }));
  }

  const localRows: ResponsibilityRow[] = localItems.map((item) => {
    const history = item.runs.map(localRunEntry);
    const latest = history[0];
    const running = latest?.outcome === "running";
    const queued = latest?.outcome === "queued";
    const failed = latest?.outcome === "failed";
    const paused = item.state !== "active";
    const key = `local:${item.id}`;
    const finished = history.find((entry) => entry.outcome !== "running" && entry.outcome !== "queued");
    return {
      key,
      name: item.name,
      where: describeWhere("local"),
      cloud: false,
      schedule: describeScheduleForPeople(item.schedule),
      status: describeRowStatus({ latest, finished, paused, needsAttention: false, nextDueAt: item.nextDueAt }),
      statusTone: running || queued ? "spark" : failed ? "rose" : paused ? "mist" : finished ? "mint" : "mist",
      next: paused || running || queued ? "" : describeMoment(item.nextDueAt),
      paused,
      latest,
      finished,
      state: running ? "Running" : queued ? "Queued" : paused ? "Paused" : failed ? "Failed" : "active",
      tone: running || queued ? "spark" : failed ? "rose" : paused ? "mist" : "mint",
      warning: "",
      attention: failed ? latest?.error ?? "" : "",
      history,
      actions: [
        queued
          ? {
              label: "Don't run this time",
              onSelect: () => void act(key, async () => {
                await coworkerBridge.localResponsibilities.cancelQueued(coworker.slug, item.id);
                await refreshLocal();
                return "Taken out of line.";
              }),
            }
          : {
              label: running ? "Working on it…" : "Run now",
              disabled: running,
              onSelect: () => void act(key, async () => {
                const result = await coworkerBridge.localResponsibilities.runNow(coworker.slug, item.id);
                window.setTimeout(() => void refreshLocal(), 500);
                if (result.queued) return "It'll start when the current run finishes.";
                return result.accepted ? "Run started." : "This one is already running.";
              }),
            },
        ...(failed && latest?.threadId
          ? [{
              label: "Pick up where it stopped",
              onSelect: () => void act(key, async () => {
                const result = await coworkerBridge.localResponsibilities.resume(coworker.slug, item.id);
                window.setTimeout(() => void refreshLocal(), 500);
                if (result.accepted) return "Picking up where it stopped.";
                return result.reason === "at limit"
                  ? "This Mac is busy with other runs. Try again when one finishes."
                  : "This one is already running.";
              }),
            }]
          : []),
        {
          label: paused ? "Resume" : "Pause",
          onSelect: () => void act(key, async () => {
            await coworkerBridge.localResponsibilities.setActive(coworker.slug, item.id, paused);
            await refreshLocal();
            return "";
          }),
        },
        {
          label: "Remove",
          tone: "danger",
          disabled: running,
          onSelect: () => void act(key, async () => {
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
    const id = entry.automation.id;
    const latest = entry.latestRun ? cloudRunEntry(entry.latestRun) : undefined;
    const loaded = cloudRuns[id];
    const history = loaded ? loaded.map(cloudRunEntry) : latest ? [latest] : [];
    const finished = latest && latest.outcome !== "running" && latest.outcome !== "queued" ? latest : undefined;
    const status = needsAttention
      ? "Needs you"
      : paused
        ? stateLabel(state)
        : describeRowStatus({ latest, finished, paused: false, needsAttention: false, nextDueAt: entry.automation.nextDueAt });
    return {
      key: `cloud:${id}`,
      name: entry.automation.name,
      where: describeWhere(placement.target === "cloud" ? "cloud" : "desktop"),
      cloud: true,
      schedule: describeScheduleForPeople(entry.revision.schedule),
      status,
      statusTone: needsAttention ? "rose" : paused ? "mist" : finished?.outcome === "succeeded" ? "mint" : finished ? "amber" : "mist",
      next: paused || needsAttention ? "" : describeMoment(entry.automation.nextDueAt),
      paused,
      latest,
      finished,
      state: needsAttention ? "Needs you" : paused ? stateLabel(state) : "active",
      tone: needsAttention ? "rose" : paused ? "mist" : "mint",
      warning: placement.target === "cloud" ? "" : placement.detail,
      attention: entry.automation.needsAttentionReason?.message ?? "",
      history: loaded ? history : null,
      loadHistory: async () => {
        if (!den || cloudRuns[id]) return;
        try {
          const runs = await den.listRuns(id);
          setCloudRuns((current) => ({ ...current, [id]: runs }));
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      },
      actions: [
        {
          label: "Run now",
          disabled: needsAttention,
          onSelect: () => void act(`cloud:${id}`, async () => {
            if (!den) return "";
            await den.runNow(id);
            void refreshCloud();
            return placement.target === "cloud"
              ? "Asked OpenWork Cloud to run it now."
              : "Asked for a run. It starts when the OpenWork desktop app is open for your account.";
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
          label: `Take off ${coworker.name}'s list`,
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

  function toggleRow(row: ResponsibilityRow) {
    const next = openRow === row.key ? null : row.key;
    setOpenRow(next);
    if (next && row.loadHistory) void row.loadHistory();
  }

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-3 px-1">
        <h3 className="text-[11px] font-semibold text-mist">On a schedule</h3>
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
          <p className="text-xs text-mist">Nothing on a schedule yet.</p>
          <Button variant="default" className="mt-3 text-xs" onClick={() => setAdding(session ? "cloud" : "local")}>
            Add assignment
          </Button>
        </div>
      ) : null}

      {rows.length > 0 ? (
        <ul className="divide-y divide-line rounded-2xl border border-line bg-ink" data-testid="responsibility-list">
          {rows.map((row) => {
            const expanded = openRow === row.key;
            const statusClass = row.statusTone === "rose"
              ? "text-rose"
              : row.statusTone === "amber"
                ? "text-amber"
                : row.statusTone === "spark"
                  ? "text-spark"
                  : row.statusTone === "mint"
                    ? "text-mint"
                    : "text-mist";
            return (
              <li key={row.key} data-testid="responsibility-row" data-state={row.state} data-expanded={expanded ? "true" : "false"}>
                <div className="flex items-start gap-2.5 px-3.5 py-3">
                  <span className="mt-1.5"><StatusDot tone={row.tone} /></span>
                  <button
                    type="button"
                    className="min-w-0 flex-1 rounded-lg text-left outline-none focus-visible:ring-1 focus-visible:ring-spark/60"
                    aria-expanded={expanded}
                    onClick={() => toggleRow(row)}
                    data-testid="responsibility-history-toggle"
                    title={expanded ? "Hide details" : "Show details"}
                  >
                    <span className="block break-words text-sm font-semibold leading-snug text-snow">{row.name}</span>
                    <span className="mt-0.5 block text-[11px] leading-relaxed text-mist" data-testid="responsibility-line">
                      {row.schedule}
                      <span aria-hidden="true"> · </span>
                      <span className={`font-medium ${statusClass}`}>{row.status}</span>
                      {row.cloud ? <span className="ml-1.5 rounded-full bg-spark/10 px-1.5 py-px text-[10px] font-medium text-spark">Cloud</span> : null}
                    </span>
                  </button>
                  <ActionMenu label={`Actions for ${row.name}`} items={row.actions.map((action) => ({ ...action, disabled: action.disabled || busyKey === row.key }))} />
                </div>
                {expanded ? (
                  <ResponsibilityDetail
                    row={row}
                    coworkerName={coworker.name}
                    onOpenThread={onOpenThread}
                    onExplain={(entry) => explain(row.name, entry)}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {rows.length > 0 && !adding ? (
        <p className="px-1 text-[11px] leading-relaxed text-mist/80" data-testid="responsibility-placement-note">{PLACEMENT_NOTE}</p>
      ) : null}

      {others.length > 0 ? (
        <details className="rounded-2xl border border-line bg-ink px-3 py-2.5">
          <summary className="cursor-pointer text-xs font-medium text-mist">
            {others.length} more in your organization
          </summary>
          <ul className="mt-2 space-y-2">
            {others.map((entry) => {
              const owner = ownerOf(entry);
              return (
                <li key={entry.automation.id} className="rounded-xl bg-panel p-2.5">
                  <p className="text-xs font-medium text-snow">{entry.automation.name}</p>
                  <p className="mt-0.5 text-[11px] text-mist">{owner ? `Looked after by ${owner.name}` : describeScheduleForPeople(entry.revision.schedule)}</p>
                  {!owner ? (
                    <button className="mt-1 text-[11px] font-medium text-spark hover:underline" onClick={() => void associate(entry.automation.id)}>
                      Give to {coworker.name}
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

/**
 * Everything a person might want to know about one responsibility, in labelled
 * everyday facts, followed by what happened each time it ran.
 */
function ResponsibilityDetail({
  row,
  coworkerName,
  onOpenThread,
  onExplain,
}: {
  row: ResponsibilityRow;
  coworkerName: string;
  onOpenThread: (threadId: string) => void;
  onExplain: (entry: RunEntry) => void;
}) {
  const known = row.history ?? [];
  const trend = describeRunTrend(known);
  const lastTime = row.finished
    ? [
        describeRunOutcome(row.finished.outcome),
        sentenceCase(describeMoment(row.finished.at)),
        row.finished.durationMs !== null ? `took ${describeDurationForPeople(row.finished.durationMs)}` : "",
        row.finished.how ? row.finished.how.toLowerCase() : "",
      ].filter(Boolean).join(" · ")
    : "";
  const nextText = row.latest?.outcome === "running"
    ? "Working on it now"
    : row.latest?.outcome === "queued"
      ? "Waiting its turn"
      : row.paused
        ? "Paused — nothing until you resume it"
        : row.next
          ? sentenceCase(row.next)
          : "Not scheduled";
  const summary = row.finished?.outcome === "succeeded" ? row.finished.summary : "";
  return (
    <div className="border-t border-line/70 bg-panel/40 px-3.5 py-3 text-[11px] leading-relaxed" data-testid="responsibility-detail">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        <dt className="text-mist">When</dt>
        <dd className="text-snow">{row.schedule}</dd>
        <dt className="text-mist">Where</dt>
        <dd className="text-snow">{row.where}</dd>
        <dt className="text-mist">Next</dt>
        <dd className="text-snow">{nextText}</dd>
        {lastTime ? (
          <>
            <dt className="text-mist">Last time</dt>
            <dd className={row.finished?.outcome === "succeeded" ? "text-snow" : "text-amber"}>{lastTime}</dd>
          </>
        ) : null}
      </dl>
      {summary ? (
        <div className="mt-2">
          <p className="text-mist">What {coworkerName} said</p>
          <p className="mt-0.5 line-clamp-3 text-snow/85" title={summary} data-testid="responsibility-summary">{summary}</p>
        </div>
      ) : null}
      {row.attention ? (
        <details className="mt-2 rounded-lg bg-rose/8 px-2.5 py-1.5 text-rose">
          <summary className="cursor-pointer select-none font-medium">What went wrong</summary>
          <p className="mt-1 break-words">{row.attention}</p>
        </details>
      ) : null}
      {row.warning ? <p className="mt-2 rounded-lg bg-amber/8 px-2.5 py-1.5 text-amber">{row.warning}</p> : null}
      <RunHistory
        entries={known}
        trend={trend}
        loading={row.history === null}
        coworkerName={coworkerName}
        onOpenThread={onOpenThread}
        onExplain={onExplain}
      />
    </div>
  );
}

/** Each time it ran: what happened, when, how long it took, and the coworker's own words. */
function RunHistory({
  entries,
  trend,
  loading,
  coworkerName,
  onOpenThread,
  onExplain,
}: {
  entries: RunEntry[];
  trend: string;
  loading: boolean;
  coworkerName: string;
  onOpenThread: (threadId: string) => void;
  onExplain: (entry: RunEntry) => void;
}) {
  if (loading && entries.length === 0) {
    return <p className="mt-2 text-mist">Looking up earlier runs…</p>;
  }
  if (entries.length === 0) {
    return <p className="mt-2 text-mist">It hasn't run yet.</p>;
  }
  return (
    <div className="mt-2.5">
      <p className="text-mist" data-testid="responsibility-trend">{trend || "So far"}</p>
      <ol className="mt-1.5 space-y-1.5 border-l border-line pl-3" data-testid="responsibility-history">
        {entries.map((entry) => {
          const tone: Tone = entry.outcome === "succeeded" ? "mint" : entry.outcome === "failed" ? "rose" : entry.outcome === "missed" ? "amber" : entry.outcome === "running" || entry.outcome === "queued" ? "spark" : "mist";
          const explainable = entry.outcome !== "queued" && entry.outcome !== "running";
          return (
            <li key={entry.id} data-testid="responsibility-run" data-outcome={entry.outcome}>
              <div className="flex flex-wrap items-center gap-x-1.5 text-mist">
                <StatusDot tone={tone} />
                <span className={`font-medium ${tone === "rose" ? "text-rose" : tone === "amber" ? "text-amber" : "text-snow"}`}>{describeRunOutcome(entry.outcome)}</span>
                <span>· {describeMoment(entry.at)}</span>
                {entry.durationMs !== null ? <span>· {describeDurationForPeople(entry.durationMs)}</span> : null}
                {entry.how ? <span>· {entry.how}</span> : null}
              </div>
              {entry.summary ? <p className="mt-0.5 line-clamp-3 text-snow/80" title={entry.summary}>{entry.summary}</p> : null}
              {entry.error ? (
                <details className="mt-0.5 text-rose">
                  <summary className="cursor-pointer select-none">What went wrong</summary>
                  <p className="mt-0.5 break-words">{entry.error}</p>
                </details>
              ) : null}
              {explainable || entry.threadId ? (
                <div className="mt-1 flex flex-wrap gap-x-3">
                  {entry.threadId ? (
                    <button type="button" className="font-medium text-spark hover:underline" onClick={() => onOpenThread(entry.threadId)}>
                      Open the conversation
                    </button>
                  ) : null}
                  {explainable ? (
                    <button type="button" className="font-medium text-spark hover:underline" onClick={() => onExplain(entry)} data-testid="responsibility-explain">
                      Ask {coworkerName} to explain
                    </button>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
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
        <p className="text-xs font-semibold text-snow">New assignment on a schedule</p>
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
          <p className="text-xs text-snow">Sign in to OpenWork to run scheduled assignments in the cloud.</p>
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
      actionLabel="Create assignment"
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
        {busy ? "Creating…" : "Create assignment"}
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
