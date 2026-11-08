"use client";

import { Dialog } from "@base-ui/react/dialog";
import { Check, Globe, Monitor, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useRetainedSurface } from "./host";
import { useStopWorkbotTask } from "./data";
import { AppMark } from "./files";
import type { ActivityStep, ActivityTask, WorkbotActivity } from "./activity";

/**
 * Workbot's working state, out of the chat (`workingStatus`): its name in the header carries a quiet line saying what
 * it is doing now, and tapping the name opens the task sheet with the steps behind it. Three levels, each on request:
 * the status line, the sheet, then the live screen ("Watch"). The chat keeps only what Workbot says.
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
  if (activity.app) return <AppMark name={activity.app} size={size} />;
  if (activity.icon === "browser") return <Globe size={size} strokeWidth={1.75} aria-hidden className="shrink-0" />;
  if (activity.icon === "computer") return <Monitor size={size} strokeWidth={1.75} aria-hidden className="shrink-0" />;
  return <span aria-hidden className="workbot-presence-dot size-1.5 shrink-0 rounded-full" />;
}

/**
 * The assistant's name, and under it what it is doing now with how long it has taken. Tapping it opens the task sheet.
 * Nothing to say: just the name, still opening the sheet when there are tasks to look back on.
 */
export function WorkingName({ name, activity, mark }: { name: string; activity: WorkbotActivity; mark: ReactNode }) {
  const [open, setOpen] = useState(false);
  const now = useTicking(activity.working && activity.since !== null);
  const openable = activity.working || activity.tasks.length > 0;
  const title = <span className="truncate text-[15px] font-semibold leading-5 tracking-[-0.015em] text-[var(--wb-text)]">{name}</span>;
  return <>
    <button type="button" disabled={!openable} onClick={() => setOpen(true)} aria-haspopup="dialog" aria-label={activity.working ? `${name}: ${activity.label}. Show what ${name} is doing` : `${name}: show recent tasks`}
      className="flex min-w-0 items-center gap-2 rounded-lg py-0.5 pr-1.5 text-left transition-colors duration-150 enabled:hover:bg-[var(--wb-chip)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)] disabled:cursor-default" data-workbot-working-name>
      {mark}
      <span className="flex min-w-0 flex-col">
        {title}
        {activity.working ? <span className="workbot-subtitle-enter flex min-w-0 items-center gap-1 text-[12px] leading-4 text-[var(--wb-muted)]" role="status" aria-live="polite" data-workbot-status-line>
          <StatusIcon activity={activity} />
          <span key={activity.label} className="workbot-shimmer truncate">{activity.label}</span>
          {activity.since !== null && now - activity.since >= 5_000 ? <span className="shrink-0 tabular-nums">· {elapsed(now - activity.since)}</span> : null}
        </span> : null}
      </span>
    </button>
    <TaskSheet open={open} onClose={() => setOpen(false)} name={name} activity={activity} />
  </>;
}

function StepList({ steps, working }: { steps: ActivityStep[]; working: boolean }) {
  return <ol className="flex flex-col" data-workbot-sheet-steps>
    {steps.map((step, index) => <li key={step.key} className="relative flex gap-3 pb-3">
      {index < steps.length - 1 || working ? <span aria-hidden className="absolute left-[9px] top-5 h-[calc(100%-16px)] border-l border-dashed border-[var(--wb-disabled)]" /> : null}
      <span aria-hidden className={`relative mt-px grid size-[19px] shrink-0 place-items-center rounded-full ${step.done ? "border border-[var(--wb-ink)] text-[var(--wb-ink)]" : "border border-[var(--wb-disabled)]"}`}>
        {step.done ? <Check size={11} strokeWidth={2.5} /> : <span className="workbot-presence-dot size-1.5 rounded-full" />}
      </span>
      <span className={`flex min-w-0 items-center gap-1.5 text-[13.5px] leading-5 ${step.done ? "text-[var(--wb-text)]" : "workbot-shimmer"}`}>
        {step.app ? <AppMark name={step.app} size={13} /> : null}
        <span className="min-w-0">{step.label}</span>
      </span>
    </li>)}
    {working ? <li className="flex items-center gap-3 text-[13px] text-[var(--wb-muted)]" aria-label="Still working">
      <span aria-hidden className="grid size-[19px] shrink-0 place-items-center"><span className="workbot-presence-dot size-1.5 rounded-full" /></span>
      <span className="workbot-shimmer">Working</span>
    </li> : null}
  </ol>;
}

function TaskSection({ task, index, total }: { task: ActivityTask; index: number; total: number }) {
  const stop = useStopWorkbotTask();
  const open = task.status === "queued" || task.status === "working" || task.status === "paused";
  const stopping = stop.isPending && stop.variables === task.id;
  const state = task.status === "queued" ? "Waiting to start" : task.status === "paused" ? "Picking it back up" : task.status === "done" ? "Done" : task.status === "failed" ? "Couldn't finish" : task.status === "stopped" ? "Stopped" : null;
  return <section className="flex flex-col gap-2 border-t border-[var(--wb-hairline)] px-5 pb-2 pt-4" data-workbot-sheet-task={task.id}>
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 className="text-[12px] font-medium text-[var(--wb-muted)]">{total > 1 ? `Background task ${index + 1}` : "Background task"}{state ? ` · ${state}` : ""}</h3>
        <p className="truncate text-[14px] font-medium leading-5 text-[var(--wb-text)]">{task.title}</p>
      </div>
      {open ? <button type="button" disabled={stopping} onClick={() => stop.mutate(task.id)} className="h-7 shrink-0 rounded-full px-3 text-[12px] font-medium text-[var(--wb-muted)] transition-colors duration-150 hover:bg-[var(--wb-chip)] hover:text-[var(--wb-text)] disabled:opacity-50 focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]">{stopping ? "Stopping" : "Stop"}</button> : null}
    </div>
    {open && task.note ? <p className="text-[12.5px] leading-[18px] text-[var(--wb-muted)]">{task.note}</p> : null}
    {task.steps.length || open ? <StepList steps={task.steps} working={task.status === "working"} /> : null}
  </section>;
}

/**
 * The task sheet: whether Workbot is at work, on what, since when, and each step of the reply in progress and of its
 * background tasks with a check once done. A bottom sheet on phones (it reaches the bottom edge, so nothing behind
 * shows through), a panel under the name on wider screens.
 */
export function TaskSheet({ open, onClose, name, activity }: { open: boolean; onClose(): void; name: string; activity: WorkbotActivity }) {
  const surface = useRetainedSurface(open);
  const openTasks = activity.tasks.filter((task) => task.status === "queued" || task.status === "working" || task.status === "paused");
  const lead = activity.main ? null : openTasks[0] ?? null;
  const title = activity.main ? (activity.main.request.trim() || "Your message") : lead?.title ?? "Recent tasks";
  const since = activity.main?.since ?? lead?.startedAt ?? null;
  const watch = activity.watch;
  return <Dialog.Root open={surface.open} onOpenChange={(next) => { if (!next) onClose(); }}>
    <Dialog.Portal {...surface.portal}>
      <Dialog.Backdrop className="fixed inset-0 z-40 bg-[var(--wb-ink)]/25 transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 motion-reduce:transition-none sm:bg-[var(--wb-ink)]/10" />
      <Dialog.Popup className="workbot fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col overflow-hidden rounded-t-[24px] bg-[var(--wb-surface)] pb-[env(safe-area-inset-bottom)] shadow-[var(--wb-panel-shadow)] outline-none transition-transform duration-200 ease-out data-[ending-style]:translate-y-full data-[starting-style]:translate-y-full motion-reduce:transition-none sm:inset-x-auto sm:bottom-auto sm:left-4 sm:top-14 sm:max-h-[min(36rem,calc(100dvh-5rem))] sm:w-[420px] sm:rounded-[16px] sm:data-[ending-style]:translate-y-0 sm:data-[ending-style]:opacity-0 sm:data-[starting-style]:translate-y-0 sm:data-[starting-style]:opacity-0" data-workbot-task-sheet>
        <div className="flex shrink-0 items-start justify-between gap-3 px-5 pb-4 pt-5">
          <div className="flex min-w-0 flex-col gap-2">
            <span className={`w-fit rounded-md px-2 py-0.5 text-[12px] font-medium ${activity.working ? "bg-[var(--wb-ink)] text-[var(--wb-on-ink)]" : "bg-[var(--wb-chip)] text-[var(--wb-muted)]"}`}>{activity.working ? "In progress" : "Nothing running"}</span>
            <Dialog.Title className="line-clamp-2 text-[16px] font-semibold leading-[22px] text-[var(--wb-text)]">{title}</Dialog.Title>
            {activity.working ? <Dialog.Description className="text-[13px] leading-[18px] text-[var(--wb-muted)]">{activity.label}{since ? ` · since ${clock(since)}` : ""}</Dialog.Description> : <Dialog.Description className="text-[13px] text-[var(--wb-muted)]">{name} isn&apos;t working on anything right now.</Dialog.Description>}
          </div>
          <Dialog.Close aria-label="Close" className="grid size-8 shrink-0 place-items-center rounded-full text-[var(--wb-muted)] shadow-[0_0_0_1px_var(--wb-ring)] hover:text-[var(--wb-text)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"><X size={15} strokeWidth={1.75} aria-hidden /></Dialog.Close>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pb-4">
          {activity.main ? <section className="flex flex-col gap-2 border-t border-[var(--wb-hairline)] px-5 pt-4" data-workbot-sheet-main>
            <h3 className="text-[12px] font-medium text-[var(--wb-muted)]">{name}</h3>
            <StepList steps={activity.main.steps} working />
          </section> : null}
          {activity.tasks.map((task, index) => <TaskSection key={task.id} task={task} index={index} total={activity.tasks.length} />)}
        </div>
        {watch ? <div className="shrink-0 border-t border-[var(--wb-hairline)] px-5 py-3">
          <button type="button" onClick={() => { onClose(); window.history.pushState(null, "", `/${watch}${window.location.search}`); window.dispatchEvent(new PopStateEvent("popstate")); }}
            className="flex h-9 w-full items-center justify-center gap-2 rounded-full bg-[var(--wb-chip)] text-[13px] font-medium text-[var(--wb-text)] hover:bg-[var(--wb-bubble)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]" data-workbot-watch>
            {watch === "browser" ? <Globe size={14} aria-hidden /> : <Monitor size={14} aria-hidden />}Watch {watch === "browser" ? "the browser" : "the screen"}
          </button>
        </div> : null}
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}
