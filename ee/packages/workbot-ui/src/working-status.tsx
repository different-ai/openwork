"use client";

import { Check, ChevronRight, CircleSlash, CircleX, Clock3, Globe, Monitor } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import { calmChat } from "./host";
import { useBrowserPreview } from "./browser-preview-context";
import { useStopWorkbotTask } from "./data";
import { ConnectorIcon } from "./connector-line";
import type { ActivityStep, ActivityTask, WorkbotActivity } from "./activity";
import { ProfileSheet } from "./profile-sheet";
import { OpenWorkMark } from "./mark";

/**
 * Workbot's working state, out of the chat: its name in the header carries a quiet line saying what
 * it is doing now, and tapping the name opens the task sheet with the steps behind it. Three levels, each on request:
 * the status line, the sheet, then the live screen ("Watch"). The chat keeps only what Workbot says. Background tasks
 * are one row each; their steps open inside the row.
 */

function useTicking(on: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}

/** "12s", "4m", "1h 5m": how long, as a glance. */
function elapsed(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function clock(at: number) {
  return new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function StatusIcon({ activity, size = 12 }: { activity: WorkbotActivity; size?: number }) {
  if (activity.icon === "app") return <ConnectorIcon app={{ name: activity.app, ...(activity.site ? { site: activity.site } : {}), ...(activity.remote ? { remote: true as const } : {}), ...(activity.openwork ? { openwork: true as const } : {}) }} size={size} />;
  if (activity.icon === "browser") return <Globe size={size} strokeWidth={1.75} aria-hidden className="shrink-0" />;
  if (activity.icon === "computer") return <Monitor size={size} strokeWidth={1.75} aria-hidden className="shrink-0" />;
  return <span aria-hidden className="workbot-presence-dot size-1.5 shrink-0 rounded-full" />;
}

/**
 * The assistant's name, and under it what it is doing now with how long it has taken. Tapping it opens the same sheet
 * as the avatar on a wide screen (ProfileBadge): the profile.
 * Nothing to say: just the name, still opening the sheet when there are tasks to look back on.
 */
export function WorkingName({ name, activity, mark, phone = false }: { name: string; activity: WorkbotActivity; mark: ReactNode; /** The phone header's pill: centred, and always opens its sheet. */ phone?: boolean }) {
  const [open, setOpen] = useState(false);
  const now = useTicking(activity.working && activity.since !== null);
  // The name and desktop avatar always open the same profile.

  const title = <span className="truncate text-[15px] font-semibold leading-5 tracking-[-0.015em] text-[var(--wb-text)]">{name}</span>;
  return <>
    <button type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-label={activity.working ? `${name}: ${activity.label}. Show what ${name} is doing` : `${name}: open profile`}
      className="flex min-w-0 items-center gap-2 rounded-lg py-0.5 pl-1.5 pr-1.5 text-left transition-colors duration-150 enabled:hover:bg-[var(--wb-chip)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)] disabled:cursor-default" data-workbot-working-name>
      {mark}
      <span className={`flex min-w-0 flex-col ${phone ? "items-center" : ""}`}>
        {title}
        {activity.working ? <span className="workbot-subtitle-enter flex min-w-0 items-center gap-1 text-[12px] leading-4 text-[var(--wb-muted)]" role="status" aria-live="polite" data-workbot-status-line>
          <StatusIcon activity={activity} />
          <span key={activity.label} className="workbot-shimmer truncate">{activity.label}</span>
          {activity.since !== null && now - activity.since >= 5_000 ? <span className="shrink-0 tabular-nums">· {elapsed(now - activity.since)}</span> : null}
        </span> : null}
      </span>
    </button>
    {<ProfileSheet open={open} onClose={() => setOpen(false)} name={name} activity={activity} mark={mark} />}
  </>;
}

export { elapsed, StatusIcon };

/**
 * The profile at the top centre, as a person shows in a messaging app: Workbot's avatar (the
 * OpenWork mark), its name on a pill just under it (never overlapping: over a glass header the two would blend), and in the pill what it is doing now. The first level of what it is
 * doing (status), then the profile on tap (tasks, what it can use, its computer, memory), then the live view.
 */
export function ProfileBadge({ name, activity }: { name: string; activity: WorkbotActivity }) {
  const [open, setOpen] = useState(false);

  const label = activity.working ? `${name}: ${activity.label}. Show what ${name} is doing` : `${name}: open profile`;
  const sheet = <ProfileSheet open={open} onClose={() => setOpen(false)} name={name} activity={activity} />;
  // Calm look: one inline pill on every screen: a small avatar, the name, a green dot that breathes while Workbot
  // works, and what it is doing now.
  if (calmChat()) return <>
    <button type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-label={label}
      className="flex h-9 min-w-0 max-w-full items-center gap-2 rounded-full bg-[var(--wb-surface)] pl-1.5 pr-3.5 shadow-[0_0_0_1px_var(--wb-ring)] transition-shadow duration-150 hover:shadow-[0_0_0_1px_var(--wb-disabled)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]" data-workbot-profile-pill>
      <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-full bg-[var(--wb-chip)]"><OpenWorkMark width={10} height={13} /></span>
      <span className="shrink-0 text-[13px] font-semibold leading-4 tracking-[-0.01em] text-[var(--wb-text)]">{name}</span>
      <span className="flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-[var(--wb-muted)]" role="status" aria-live="polite" data-workbot-status-line>
        <span aria-hidden className={`workbot-live-dot size-1.5 shrink-0 rounded-full ${activity.working ? "is-working" : ""}`} />
        {activity.working ? <span key={activity.label} className="workbot-subtitle-enter min-w-0 max-w-[260px] truncate">{activity.label}</span> : null}
      </span>
    </button>
    {sheet}
  </>;
  return <>
    <button type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-label={label}
      className="group flex flex-col items-center rounded-[18px] focus-visible:outline-none" data-workbot-profile-badge>
      <span aria-hidden className="relative grid size-9 place-items-center rounded-full bg-[var(--wb-surface)] shadow-[0_0_0_1px_var(--wb-ring),var(--wb-card-shadow)] transition-transform duration-150 ease-out group-active:scale-[0.96] motion-reduce:transition-none">
        <OpenWorkMark width={15} height={19} />
      </span>
      <span className="relative mt-1 flex max-w-[136px] flex-col items-center rounded-[13px] bg-[var(--wb-surface)] px-2.5 py-[3px] shadow-[0_0_0_1px_var(--wb-ring),var(--wb-card-shadow)] transition-shadow duration-150 group-hover:shadow-[0_0_0_1px_var(--wb-disabled),var(--wb-card-shadow)] group-focus-visible:shadow-[var(--wb-focus)]">
        <span className="max-w-full truncate text-[13px] font-semibold leading-4 tracking-[-0.01em] text-[var(--wb-text)]">{name}</span>
        {activity.working ? <span className="workbot-subtitle-enter flex max-w-full items-center gap-1 text-[11px] leading-[14px] text-[var(--wb-muted)]" role="status" aria-live="polite" data-workbot-status-line>
          <StatusIcon activity={activity} size={11} />
          <span key={activity.label} className="workbot-shimmer min-w-0 truncate">{activity.label}</span>
        </span> : null}
      </span>
    </button>
    {<ProfileSheet open={open} onClose={() => setOpen(false)} name={name} activity={activity} />}
  </>;
}

/** A step, with how many times in a row it was taken ("Checking the remote task" seven times reads as one line). */
export type ShownStep = ActivityStep & { count: number };

/** Consecutive repeats of the same step become one, counted: a task that polls shows one line, not one per poll. */
export function collapseRepeats(steps: ActivityStep[]): ShownStep[] {
  const shown: ShownStep[] = [];
  for (const step of steps) {
    const previous = shown.at(-1);
    if (previous && previous.label === step.label && previous.app === step.app) shown[shown.length - 1] = { ...step, count: previous.count + 1 };
    else shown.push({ ...step, count: 1 });
  }
  return shown;
}

function StepList({ steps, working }: { steps: Array<ActivityStep & { count?: number }>; working: boolean }) {
  return <ol className="flex flex-col" data-workbot-sheet-steps>
    {steps.map((step, index) => <li key={step.key} className="relative flex gap-3 pb-3">
      {index < steps.length - 1 || working ? <span aria-hidden className="absolute left-[9px] top-5 h-[calc(100%-16px)] border-l border-dashed border-[var(--wb-disabled)]" /> : null}
      <span aria-hidden className={`relative mt-px grid size-[19px] shrink-0 place-items-center rounded-full ${step.done ? "border border-[var(--wb-ink)] text-[var(--wb-ink)]" : "border border-[var(--wb-disabled)]"}`}>
        {step.done ? <Check size={11} strokeWidth={2.5} /> : <span className="workbot-presence-dot size-1.5 rounded-full" />}
      </span>
      <span className={`flex min-w-0 items-center gap-1.5 text-[13.5px] leading-5 ${step.done ? "text-[var(--wb-text)]" : "workbot-shimmer"}`}>
        {step.app || step.remote || step.site ? <ConnectorIcon app={{ name: step.app, ...(step.site ? { site: step.site } : {}), ...(step.remote ? { remote: true as const } : {}), ...(step.openwork ? { openwork: true as const } : {}) }} size={13} /> : null}
        <span className="min-w-0">{step.label}{step.count && step.count > 1 ? <span className="text-[var(--wb-muted)]"> · {step.count} times</span> : null}</span>
      </span>
    </li>)}
    {working ? <li className="flex items-center gap-3 text-[13px] text-[var(--wb-muted)]" aria-label="Still working">
      <span aria-hidden className="grid size-[19px] shrink-0 place-items-center"><span className="workbot-presence-dot size-1.5 rounded-full" /></span>
      <span className="workbot-shimmer">Working</span>
    </li> : null}
  </ol>;
}

const taskIsOpen = (task: ActivityTask) => task.status === "queued" || task.status === "working" || task.status === "paused";

/**
 * A background task's one plain status line: what it is doing now, or how it ended. Gone quiet (unfinished, but no
 * step for a long while) is said plainly with when it last moved. Never its list of steps.
 */
export function taskStatusLine(task: ActivityTask) {
  if (taskIsOpen(task) && task.quiet) return `No progress since ${task.lastAt ? clock(task.lastAt) : "it started"}`;
  switch (task.status) {
    case "queued": return "Waiting to start";
    case "paused": return "Picking it back up";
    case "working": return task.current ?? "Working on it";
    case "done": return "Done";
    case "failed": return "Couldn't finish";
    case "stopped": return "Stopped";
  }
}

/** When, as a clock time: started for unfinished work, ended for the rest. */
export function taskTime(task: ActivityTask) {
  const at = taskIsOpen(task) ? task.startedAt : (task.finishedAt ?? task.lastAt);
  return at ? clock(at) : null;
}

/**
 * One background task, one row: its title, one status line and a time, with Stop while it is unfinished. Its steps
 * (repeats counted) and note open on tap, inside the row; they are never listed at the top level.
 */
function TaskRow({ task }: { task: ActivityTask }) {
  const stop = useStopWorkbotTask();
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();
  const open = taskIsOpen(task);
  const live = task.status === "working" && !task.quiet;
  const stopping = stop.isPending && stop.variables === task.id;
  const steps = collapseRepeats(task.steps);
  const note = open && !task.quiet ? task.note : null;
  const hasDetail = steps.length > 0 || note !== null;
  const time = taskTime(task);
  const Icon = task.status === "done" ? Check : task.status === "failed" ? CircleX : task.status === "stopped" ? CircleSlash : task.quiet || task.status === "queued" ? Clock3 : null;
  return <li className="border-b border-[var(--wb-row-line)] last:border-b-0" data-workbot-sheet-task={task.id}>
    <div className="flex min-h-12 items-start gap-2 py-2">
      <button type="button" disabled={!hasDetail} aria-expanded={hasDetail ? expanded : undefined} aria-controls={hasDetail && expanded ? detailId : undefined} onClick={() => setExpanded((value) => !value)}
        className="group flex min-w-0 flex-1 items-start gap-3 rounded-lg text-left focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)] disabled:cursor-default" data-workbot-task-toggle>
        <span aria-hidden className="mt-0.5 grid size-[15px] shrink-0 place-items-center text-[var(--wb-muted)]">{Icon ? <Icon size={15} strokeWidth={1.6} /> : <span className="workbot-presence-dot size-1.5 rounded-full" />}</span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center justify-between gap-2">
            <span className="truncate text-[13.5px] text-[var(--wb-text)]">{task.title}</span>
            {time ? <span className="shrink-0 text-[12px] tabular-nums text-[var(--wb-muted)]" data-workbot-task-time>{time}</span> : null}
          </span>
          <span className={`mt-0.5 block truncate text-[12px] text-[var(--wb-muted)] ${live ? "workbot-shimmer" : ""}`} data-workbot-task-line>{taskStatusLine(task)}</span>
        </span>
        {hasDetail ? <ChevronRight size={13} aria-hidden className={`mt-1 shrink-0 text-[var(--wb-muted)] transition-transform duration-150 motion-reduce:transition-none ${expanded ? "rotate-90" : ""}`} /> : null}
      </button>
      {open ? <button type="button" disabled={stopping} onClick={() => stop.mutate(task.id)} aria-label={`Stop ${task.title}`} className="h-7 shrink-0 rounded-full px-3 text-[12px] font-medium text-[var(--wb-muted)] transition-colors duration-150 hover:bg-[var(--wb-chip)] hover:text-[var(--wb-text)] disabled:opacity-50 focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]">{stopping ? "Stopping" : "Stop"}</button> : null}
    </div>
    {expanded && hasDetail ? <div id={detailId} className="flex flex-col gap-2 pb-2 pl-[27px]" data-workbot-task-detail>
      {note ? <p className="text-[12.5px] leading-[18px] text-[var(--wb-muted)]">{note}</p> : null}
      {steps.length ? <StepList steps={steps} working={live} /> : null}
    </div> : null}
  </li>;
}

/** The reply's steps, then one row per background task: the body of the task sheet, and the profile's Tasks tab. */
export function ActivityDetails({ name, activity }: { name: string; activity: WorkbotActivity }) {
  return <>
    {activity.main ? <section className="flex flex-col gap-2 border-t border-[var(--wb-hairline)] px-5 pt-4" data-workbot-sheet-main>
      <h3 className="text-[12px] font-medium text-[var(--wb-muted)]">{name}</h3>
      <StepList steps={activity.main.steps} working />
    </section> : null}
    {activity.tasks.length ? <section className="px-5 pt-3" aria-label="Background tasks" data-workbot-sheet-tasks>
      <h3 className="pb-1 text-[12px] font-medium text-[var(--wb-muted)]">In the background</h3>
      <ul>{activity.tasks.map((task) => <TaskRow key={task.id} task={task} />)}</ul>
    </section> : null}
  </>;
}

/**
 * Native-screen watching only. Browser tasks open from their persistent inline Open preview card. The screen opens
 * where the browser's does: beside the chat (a sheet on a phone); without that panel, on its own page.
 */
export function WatchButton({ watch, onDone }: { watch: "browser" | "computer"; onDone(): void }) {
  const preview = useBrowserPreview();
  if (watch === "browser") return null;
  return <button type="button" onClick={() => {
    onDone();
    if (preview) { preview.open({ id: "computer:watch", title: "Workbot's computer", status: "working" }, "computer"); return; }
    window.history.pushState(null, "", `/${watch}${window.location.search}`); window.dispatchEvent(new PopStateEvent("popstate"));
  }}
    className="flex h-9 w-full items-center justify-center gap-2 rounded-full bg-[var(--wb-chip)] text-[13px] font-medium text-[var(--wb-text)] hover:bg-[var(--wb-bubble)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]" data-workbot-watch>
    <Monitor size={14} aria-hidden />Watch the screen
  </button>;
}
