"use client";

import { ArrowLeft, Cloud, Monitor, Play, Plus } from "lucide-react";
import { useState } from "react";

import { focusRing } from "./lp-demo-ui";

type State = "Active" | "Needs attention" | "Inactive";
type Where = "Desktop computer" | "Cloud computer";
type Run = { id: number; status: "Completed" | "Running" | "Run missed"; when: string };

type Automation = {
  id: string;
  name: string;
  instructions: string;
  state: State;
  where: Where;
  schedule: string;
  runs: Run[];
  next: string;
};

const INITIAL: Automation[] = [
  { id: "weekly", name: "Weekly update to #launch", instructions: "Pull closed Linear issues and Q3 numbers, draft the update, ask before posting.", state: "Active", where: "Desktop computer", schedule: "Weekly · Mon · 09:00", next: "Mon 09:00", runs: [{ id: 1, status: "Completed", when: "Mon 09:00" }, { id: 2, status: "Completed", when: "Sep 15 09:00" }] },
  { id: "inbox", name: "Morning inbox triage", instructions: "Sort new email into Reply, Read later and Done. Draft replies for the first group.", state: "Active", where: "Cloud computer", schedule: "Daily · 08:30", next: "Tomorrow 08:30", runs: [{ id: 1, status: "Completed", when: "Today 08:30" }] },
  { id: "invoice", name: "Invoice cleanup", instructions: "Rename new invoices in ~/Invoices and add them to invoices.xlsx.", state: "Needs attention", where: "Desktop computer", schedule: "Daily · 18:00", next: "Today 18:00", runs: [{ id: 1, status: "Run missed", when: "Yesterday 18:00" }] },
  { id: "pricing", name: "Competitor pricing check", instructions: "Visit three pricing pages and note any change in a table.", state: "Inactive", where: "Cloud computer", schedule: "Weekly · Fri · 10:00", next: "Paused", runs: [{ id: 1, status: "Completed", when: "Sep 19 10:00" }] }
];

const STATE_CLASS: Record<State, string> = {
  Active: "bg-[#ECFDF5] text-[#047857]",
  "Needs attention": "bg-[#FFFBEB] text-[#B45309]",
  Inactive: "bg-[#F3F4F6] text-[#4B5563]"
};

const SCHEDULES = ["Daily · 09:00", "Weekdays · 08:30", "Weekly · Mon · 09:00"];

type Screen = { kind: "list" } | { kind: "detail"; id: string } | { kind: "create" };

export function AutomationsView() {
  const [items, setItems] = useState<Automation[]>(INITIAL);
  const [screen, setScreen] = useState<Screen>({ kind: "list" });
  const [query, setQuery] = useState("");

  const update = (id: string, change: (item: Automation) => Automation) =>
    setItems((current) => current.map((item) => (item.id === id ? change(item) : item)));

  const runNow = (id: string) => {
    const runId = Date.now();
    update(id, (item) => ({ ...item, state: item.state === "Needs attention" ? "Active" : item.state, runs: [{ id: runId, status: "Running", when: "Now" }, ...item.runs] }));
    window.setTimeout(() => {
      update(id, (item) => ({ ...item, runs: item.runs.map((run) => (run.id === runId ? { ...run, status: "Completed", when: "Just now" } : run)) }));
    }, 1400);
  };

  if (screen.kind === "create") {
    return (
      <CreateForm
        onCancel={() => setScreen({ kind: "list" })}
        onCreate={(automation) => {
          setItems((current) => [automation, ...current]);
          setScreen({ kind: "list" });
        }}
      />
    );
  }

  if (screen.kind === "detail") {
    const item = items.find((entry) => entry.id === screen.id);
    if (!item) return null;
    const active = item.state !== "Inactive";
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-5 md:px-7">
        <button type="button" onClick={() => setScreen({ kind: "list" })} className={`flex items-center gap-1.5 self-start rounded text-xs text-[#6B7280] hover:text-[#111827] ${focusRing}`}>
          <ArrowLeft size={13} aria-hidden="true" /> All Automations
        </button>
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="text-xl font-semibold tracking-[-0.02em] text-[#111827]">{item.name}</h3>
          <span className={`flex h-[22px] items-center rounded-full px-2 text-[11px] font-medium ${STATE_CLASS[item.state]}`}>{item.state}</span>
        </div>
        <span className="text-xs text-[#6B7280]">{item.schedule} · {item.where}</span>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => runNow(item.id)} className={`flex h-8 items-center gap-1.5 rounded-lg bg-[var(--lp-ink)] px-3 text-xs text-white hover:opacity-90 ${focusRing}`}>
            <Play size={12} fill="currentColor" aria-hidden="true" /> Run now
          </button>
          <button
            type="button"
            onClick={() => update(item.id, (entry) => ({ ...entry, state: active ? "Inactive" : "Active", next: active ? "Paused" : entry.schedule.split(" · ").slice(-1)[0] }))}
            className={`flex h-8 items-center rounded-lg px-3 text-xs text-[#374151] shadow-[0_0_0_1px_#E5E7EB] hover:bg-[#F7F8FA] ${focusRing}`}
          >
            {active ? "Deactivate" : "Activate"}
          </button>
        </div>
        {item.state === "Needs attention" ? (
          <p className="rounded-lg bg-[#FFFBEB] px-3 py-2 text-xs text-[#92400E]">Last run missed: this computer was asleep at 18:00. Run it now or move it to a cloud computer.</p>
        ) : null}
        <div className="rounded-xl p-4 shadow-[0_0_0_1px_rgba(1,22,39,0.08)]">
          <div className="text-xs font-medium text-[#374151]">Instructions</div>
          <p className="mt-1.5 text-[13px] leading-5 text-[#111827]">{item.instructions}</p>
        </div>
        <div className="flex flex-col">
          <div className="flex justify-between border-b border-[var(--lp-border)] pb-1.5 text-xs">
            <span className="font-medium text-[#374151]">Run history</span>
            <span className="text-[#6B7280]">Next: {item.next}</span>
          </div>
          {item.runs.map((run) => (
            <div key={run.id} className="flex h-10 items-center justify-between border-b border-[#F0F1F3] text-xs">
              <span className={run.status === "Running" ? "lp-demo-shimmer text-[#374151]" : run.status === "Run missed" ? "text-[#B45309]" : "text-[#047857]"}>{run.status === "Running" ? "Running…" : run.status}</span>
              <span className="text-[#6B7280]">{run.when}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const visible = items.filter((item) => item.name.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto px-5 py-5 md:px-7">
      <div className="flex items-center justify-between">
        <h3 className="text-xl font-semibold tracking-[-0.02em] text-[#111827]">Automations</h3>
        <button type="button" onClick={() => setScreen({ kind: "create" })} className={`flex h-8 items-center gap-1.5 rounded-lg bg-[var(--lp-ink)] px-3.5 text-xs text-white hover:opacity-90 ${focusRing}`}>
          <Plus size={13} aria-hidden="true" /> New Automation
        </button>
      </div>
      <label className="sr-only" htmlFor="demo-automation-search">Search Automations</label>
      <input
        id="demo-automation-search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search Automations"
        className="h-[30px] w-full max-w-[260px] rounded-lg px-2.5 text-xs text-[#111827] shadow-[0_0_0_1px_#E5E7EB] placeholder:text-[#9AA2AE] focus:shadow-[0_0_0_1.5px_var(--lp-ink)] focus:outline-none"
      />
      {visible.length ? (
        <div className="grid gap-3.5 sm:grid-cols-2">
          {visible.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setScreen({ kind: "detail", id: item.id })}
              className={`flex flex-col gap-2.5 rounded-[14px] p-4 text-left shadow-[0_0_0_1px_rgba(1,22,39,0.08)] transition-colors duration-150 hover:bg-[#FAFBFC] ${focusRing}`}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-[#111827]">{item.name}</span>
                <span className={`flex h-[22px] shrink-0 items-center rounded-full px-2 text-[11px] font-medium ${STATE_CLASS[item.state]}`}>{item.state}</span>
              </span>
              <span className="text-xs leading-[18px] text-[#4B5563]">{item.instructions}</span>
              <span className="flex items-center gap-1.5 text-xs text-[#6B7280]">
                {item.where === "Desktop computer" ? <Monitor size={14} strokeWidth={1.5} aria-hidden="true" /> : <Cloud size={14} strokeWidth={1.5} aria-hidden="true" />}
                {item.where}
              </span>
              <span className="flex justify-between border-t border-[#F0F1F3] pt-2.5 text-[11px] text-[#6B7280]">
                <span>{item.schedule}</span>
                <span>{item.runs[0] ? `Last run: ${item.runs[0].status}` : `Next: ${item.next}`}</span>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <p className="py-10 text-center text-[13px] text-[#6B7280]">No Automations match “{query}”.</p>
      )}
    </div>
  );
}

function CreateForm({ onCancel, onCreate }: { onCancel: () => void; onCreate: (automation: Automation) => void }) {
  const [name, setName] = useState("Friday wins recap");
  const [instructions, setInstructions] = useState("Collect this week's closed deals from HubSpot and post a short recap to #sales.");
  const [schedule, setSchedule] = useState(SCHEDULES[0]);
  const [where, setWhere] = useState<Where>("Cloud computer");

  return (
    <form
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-5 md:px-7"
      onSubmit={(event) => {
        event.preventDefault();
        if (!name.trim()) return;
        onCreate({ id: `new-${Date.now()}`, name: name.trim(), instructions: instructions.trim(), state: "Active", where, schedule, next: schedule.split(" · ").slice(-1)[0], runs: [] });
      }}
    >
      <button type="button" onClick={onCancel} className={`flex items-center gap-1.5 self-start rounded text-xs text-[#6B7280] hover:text-[#111827] ${focusRing}`}>
        <ArrowLeft size={13} aria-hidden="true" /> All Automations
      </button>
      <h3 className="text-xl font-semibold tracking-[-0.02em] text-[#111827]">Create Automation</h3>
      <label className="flex flex-col gap-1.5 text-xs font-medium text-[#374151]">
        Name
        <input value={name} onChange={(event) => setName(event.target.value)} className="h-9 rounded-lg px-3 text-[13px] font-normal text-[#111827] shadow-[0_0_0_1px_#E5E7EB] focus:shadow-[0_0_0_1.5px_var(--lp-ink)] focus:outline-none" />
      </label>
      <label className="flex flex-col gap-1.5 text-xs font-medium text-[#374151]">
        Instructions
        <textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} rows={3} className="resize-none rounded-lg px-3 py-2 text-[13px] font-normal leading-5 text-[#111827] shadow-[0_0_0_1px_#E5E7EB] focus:shadow-[0_0_0_1.5px_var(--lp-ink)] focus:outline-none" />
      </label>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 text-xs font-medium text-[#374151]">Schedule</legend>
        <div className="flex flex-wrap gap-1.5">
          {SCHEDULES.map((entry) => (
            <button key={entry} type="button" aria-pressed={schedule === entry} onClick={() => setSchedule(entry)} className={`h-8 rounded-lg px-3 text-xs ${focusRing} ${schedule === entry ? "bg-[var(--lp-ink)] text-white" : "text-[#374151] shadow-[0_0_0_1px_#E5E7EB] hover:bg-[#F7F8FA]"}`}>
              {entry}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 text-xs font-medium text-[#374151]">Runs on</legend>
        <div className="flex gap-1.5">
          {(["Desktop computer", "Cloud computer"] satisfies Where[]).map((entry) => (
            <button key={entry} type="button" aria-pressed={where === entry} onClick={() => setWhere(entry)} className={`flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs ${focusRing} ${where === entry ? "bg-[var(--lp-ink)] text-white" : "text-[#374151] shadow-[0_0_0_1px_#E5E7EB] hover:bg-[#F7F8FA]"}`}>
              {entry === "Desktop computer" ? <Monitor size={13} aria-hidden="true" /> : <Cloud size={13} aria-hidden="true" />}
              {entry}
            </button>
          ))}
        </div>
      </fieldset>
      <div className="flex gap-2 pt-1">
        <button type="submit" className={`flex h-9 items-center rounded-lg bg-[var(--lp-ink)] px-4 text-[13px] text-white hover:opacity-90 ${focusRing}`}>Create and activate</button>
        <button type="button" onClick={onCancel} className={`flex h-9 items-center rounded-lg px-4 text-[13px] text-[#374151] shadow-[0_0_0_1px_#E5E7EB] hover:bg-[#F7F8FA] ${focusRing}`}>Cancel</button>
      </div>
    </form>
  );
}
