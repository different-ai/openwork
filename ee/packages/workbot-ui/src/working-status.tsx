"use client";

import { Dialog } from "@base-ui/react/dialog";
import { Check, Globe, Monitor, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useRetainedSurface, workbotHost } from "./host";
import { useStopWorkbotTask } from "./data";
import { ConnectorIcon } from "./connector-line";
import type { ActivityStep, ActivityTask, WorkbotActivity } from "./activity";
import { ProfileSheet } from "./profile-sheet";
import { OpenWorkMark } from "./mark";
import { RemoteJobs, useWorkbotRemoteJobs } from "./remote-jobs";

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
  if (activity.icon === "app") return <ConnectorIcon app={{ name: activity.app, ...(activity.site ? { site: activity.site } : {}), ...(activity.remote ? { remote: true as const } : {}), ...(activity.openwork ? { openwork: true as const } : {}) }} size={size} />;
  if (activity.icon === "browser") return <Globe size={size} strokeWidth={1.75} aria-hidden className="shrink-0" />;
  if (activity.icon === "computer") return <Monitor size={size} strokeWidth={1.75} aria-hidden className="shrink-0" />;
  return <span aria-hidden className="workbot-presence-dot size-1.5 shrink-0 rounded-full" />;
}

/**
 * The assistant's name, and under it what it is doing now with how long it has taken. Tapping it opens the task sheet.
 * Nothing to say: just the name, still opening the sheet when there are tasks to look back on.
 */
export function WorkingName({ name, activity, mark, tasksOnly = false }: { name: string; activity: WorkbotActivity; mark: ReactNode; /** Phones: the name opens the task sheet, never a profile. */ tasksOnly?: boolean }) {
  const [open, setOpen] = useState(false);
  const now = useTicking(activity.working && activity.since !== null);
  // With the profile, the name always opens it; otherwise only when there is work to look at. On a phone it always
  // opens the task sheet, which says plainly when nothing is running.
  const profile = !tasksOnly && workbotHost().profileSheet === true;
  const openable = tasksOnly || profile || activity.working || activity.tasks.length > 0;
  const title = <span className="truncate text-[15px] font-semibold leading-5 tracking-[-0.015em] text-[var(--wb-text)]">{name}</span>;
  return <>
    <button type="button" disabled={!openable} onClick={() => setOpen(true)} aria-haspopup="dialog" aria-label={activity.working ? `${name}: ${activity.label}. Show what ${name} is doing` : profile ? `${name}: open profile` : `${name}: show recent tasks`}
      className="flex min-w-0 items-center gap-2 rounded-lg py-0.5 pl-1.5 pr-1.5 text-left transition-colors duration-150 enabled:hover:bg-[var(--wb-chip)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)] disabled:cursor-default" data-workbot-working-name>
      {mark}
      <span className={`flex min-w-0 flex-col ${tasksOnly ? "items-center" : ""}`}>
        {title}
        {activity.working ? <span className="workbot-subtitle-enter flex min-w-0 items-center gap-1 text-[12px] leading-4 text-[var(--wb-muted)]" role="status" aria-live="polite" data-workbot-status-line>
          <StatusIcon activity={activity} />
          <span key={activity.label} className="workbot-shimmer truncate">{activity.label}</span>
          {activity.since !== null && now - activity.since >= 5_000 ? <span className="shrink-0 tabular-nums">· {elapsed(now - activity.since)}</span> : null}
        </span> : null}
      </span>
    </button>
    {profile ? <ProfileSheet open={open} onClose={() => setOpen(false)} name={name} activity={activity} mark={mark} /> : <TaskSheet open={open} onClose={() => setOpen(false)} name={name} activity={activity} />}
  </>;
}

export { elapsed, StatusIcon };

/**
 * The profile at the top centre (`profileSheet`), as a person shows in a messaging app: Workbot's avatar (the
 * OpenWork mark), its name on a pill under it, and in the pill what it is doing now. The first level of what it is
 * doing (status), then the profile on tap (tasks, what it can use, its computer, memory), then the live view.
 */
export function ProfileBadge({ name, activity }: { name: string; activity: WorkbotActivity }) {
  const [open, setOpen] = useState(false);
  const profile = workbotHost().profileSheet === true;
  return <>
    <button type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-label={activity.working ? `${name}: ${activity.label}. Show what ${name} is doing` : profile ? `${name}: open profile` : `${name}: show recent tasks`}
      className="group flex flex-col items-center rounded-[18px] focus-visible:outline-none" data-workbot-profile-badge>
      <span aria-hidden className="relative grid size-9 place-items-center rounded-full bg-[var(--wb-surface)] shadow-[0_0_0_1px_var(--wb-ring),var(--wb-card-shadow)] transition-transform duration-150 ease-out group-active:scale-[0.96] motion-reduce:transition-none">
        <OpenWorkMark width={15} height={19} />
      </span>
      <span className="relative -mt-1.5 flex max-w-[136px] flex-col items-center rounded-[13px] bg-[var(--wb-surface)] px-2.5 py-[3px] shadow-[0_0_0_1px_var(--wb-ring),var(--wb-card-shadow)] transition-shadow duration-150 group-hover:shadow-[0_0_0_1px_var(--wb-disabled),var(--wb-card-shadow)] group-focus-visible:shadow-[var(--wb-focus)]">
        <span className="max-w-full truncate text-[13px] font-semibold leading-4 tracking-[-0.01em] text-[var(--wb-text)]">{name}</span>
        {activity.working ? <span className="workbot-subtitle-enter flex max-w-full items-center gap-1 text-[11px] leading-[14px] text-[var(--wb-muted)]" role="status" aria-live="polite" data-workbot-status-line>
          <StatusIcon activity={activity} size={11} />
          <span key={activity.label} className="workbot-shimmer min-w-0 truncate">{activity.label}</span>
        </span> : null}
      </span>
    </button>
    {profile ? <ProfileSheet open={open} onClose={() => setOpen(false)} name={name} activity={activity} /> : <TaskSheet open={open} onClose={() => setOpen(false)} name={name} activity={activity} />}
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
        {step.app || step.remote || step.site ? <ConnectorIcon app={{ name: step.app, ...(step.site ? { site: step.site } : {}), ...(step.remote ? { remote: true as const } : {}), ...(step.openwork ? { openwork: true as const } : {}) }} size={13} /> : null}
        <span className="min-w-0">{step.label}</span>
      </span>
    </li>)}
    {working ? <li className="flex items-center gap-3 text-[13px] text-[var(--wb-muted)]" aria-label="Still working">
      <span aria-hidden className="grid size-[19px] shrink-0 place-items-center"><span className="workbot-presence-dot size-1.5 rounded-full" /></span>
      <span className="workbot-shimmer">Working</span>
    </li> : null}
  </ol>;
}

function TaskSection({ task }: { task: ActivityTask }) {
  const stop = useStopWorkbotTask();
  const open = task.status === "queued" || task.status === "working" || task.status === "paused";
  const stopping = stop.isPending && stop.variables === task.id;
  // Gone quiet: unfinished as far as the conversation knows, but no step for a long while. Said plainly, with Stop.
  const state = open && task.quiet ? `No progress since ${task.lastAt ? clock(task.lastAt) : "it started"}` : task.status === "queued" ? "Waiting to start" : task.status === "paused" ? "Picking it back up" : task.status === "done" ? "Done" : task.status === "failed" ? "Couldn't finish" : task.status === "stopped" ? "Stopped" : null;
  return <section className="flex flex-col gap-2 border-t border-[var(--wb-hairline)] px-5 pb-2 pt-4" data-workbot-sheet-task={task.id}>
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 className="text-[12px] font-medium text-[var(--wb-muted)]">In the background{state ? ` · ${state}` : ""}</h3>
        <p className="truncate text-[14px] font-medium leading-5 text-[var(--wb-text)]">{task.title}</p>
      </div>
      {open ? <button type="button" disabled={stopping} onClick={() => stop.mutate(task.id)} className="h-7 shrink-0 rounded-full px-3 text-[12px] font-medium text-[var(--wb-muted)] transition-colors duration-150 hover:bg-[var(--wb-chip)] hover:text-[var(--wb-text)] disabled:opacity-50 focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]">{stopping ? "Stopping" : "Stop"}</button> : null}
    </div>
    {open && !task.quiet && task.note ? <p className="text-[12.5px] leading-[18px] text-[var(--wb-muted)]">{task.note}</p> : null}
    {task.steps.length || open ? <StepList steps={task.steps} working={task.status === "working" && !task.quiet} /> : null}
  </section>;
}

/**
 * The task sheet: whether Workbot is at work, on what, since when, and each step of the reply in progress and of its
 * background tasks with a check once done. A bottom sheet on phones (it reaches the bottom edge, so nothing behind
 * shows through), a panel under the name on wider screens.
 */
/** What the sheet leads with: the reply in progress, else the first unfinished task. */
function sheetLead(activity: WorkbotActivity) {
  const openTasks = activity.tasks.filter((task) => (task.status === "queued" || task.status === "working" || task.status === "paused") && !task.quiet);
  const lead = activity.main ? null : openTasks[0] ?? null;
  return {
    // Idle with nothing to look back on: say so plainly rather than titling an empty list "Recent tasks".
    title: activity.main ? (activity.main.request.trim() || "Your message") : lead?.title ?? (activity.tasks.length > 0 ? "Recent tasks" : "Nothing running right now"),
    since: activity.main?.since ?? lead?.startedAt ?? null,
  };
}

/** The reply's steps and each background task's: the body of the task sheet, and the profile's Tasks tab. */
export function ActivityDetails({ name, activity }: { name: string; activity: WorkbotActivity }) {
  return <>
    {activity.main ? <section className="flex flex-col gap-2 border-t border-[var(--wb-hairline)] px-5 pt-4" data-workbot-sheet-main>
      <h3 className="text-[12px] font-medium text-[var(--wb-muted)]">{name}</h3>
      <StepList steps={activity.main.steps} working />
    </section> : null}
    {activity.tasks.map((task) => <TaskSection key={task.id} task={task} />)}
  </>;
}

/** Native-screen watching only. Browser tasks open from their persistent inline Open preview card. */
export function WatchButton({ watch, onDone }: { watch: "browser" | "computer"; onDone(): void }) {
  if (watch === "browser") return null;
  return <button type="button" onClick={() => { onDone(); window.history.pushState(null, "", `/${watch}${window.location.search}`); window.dispatchEvent(new PopStateEvent("popstate")); }}
    className="flex h-9 w-full items-center justify-center gap-2 rounded-full bg-[var(--wb-chip)] text-[13px] font-medium text-[var(--wb-text)] hover:bg-[var(--wb-bubble)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]" data-workbot-watch>
    <Monitor size={14} aria-hidden />Watch the screen
  </button>;
}

export function TaskSheet({ open, onClose, name, activity }: { open: boolean; onClose(): void; name: string; activity: WorkbotActivity }) {
  const surface = useRetainedSurface(open);
  const { title, since } = sheetLead(activity);
  const watch = activity.watch;
  const remote = useWorkbotRemoteJobs(open);
  return <Dialog.Root open={surface.open} onOpenChange={(next) => { if (!next) onClose(); }}>
    <Dialog.Portal {...surface.portal}>
      <Dialog.Backdrop className="fixed inset-0 z-40 bg-[var(--wb-ink)]/25 transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 motion-reduce:transition-none sm:bg-[var(--wb-ink)]/10" />
      <Dialog.Popup className="workbot fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col overflow-hidden rounded-t-[24px] bg-[var(--wb-surface)] pb-[env(safe-area-inset-bottom)] shadow-[var(--wb-panel-shadow)] outline-none transition-transform duration-200 ease-out data-[ending-style]:translate-y-full data-[starting-style]:translate-y-full motion-reduce:transition-none sm:inset-x-auto sm:bottom-auto sm:left-4 sm:top-14 sm:max-h-[min(36rem,calc(100dvh-5rem))] sm:w-[420px] sm:rounded-[16px] sm:data-[ending-style]:translate-y-0 sm:data-[ending-style]:opacity-0 sm:data-[starting-style]:translate-y-0 sm:data-[starting-style]:opacity-0" data-workbot-task-sheet>
        <div className="flex shrink-0 items-start justify-between gap-3 px-5 pb-4 pt-5">
          <div className="flex min-w-0 flex-col gap-2">
            {activity.working ? <span className="w-fit rounded-md bg-[var(--wb-ink)] px-2 py-0.5 text-[12px] font-medium text-[var(--wb-on-ink)]">In progress</span> : null}
            <Dialog.Title className="line-clamp-2 text-[16px] font-semibold leading-[22px] text-[var(--wb-text)]">{title}</Dialog.Title>
            {activity.working ? <Dialog.Description className="text-[13px] leading-[18px] text-[var(--wb-muted)]">{activity.label}{since ? ` · since ${clock(since)}` : ""}</Dialog.Description> : <Dialog.Description className="text-[13px] leading-[18px] text-[var(--wb-muted)]">{activity.tasks.length > 0 ? `${name} isn't working on anything right now.` : `When you hand ${name} a bigger job, its progress shows here.`}</Dialog.Description>}
          </div>
          <Dialog.Close aria-label="Close" className="grid size-8 shrink-0 place-items-center rounded-full text-[var(--wb-muted)] shadow-[0_0_0_1px_var(--wb-ring)] hover:text-[var(--wb-text)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"><X size={15} strokeWidth={1.75} aria-hidden /></Dialog.Close>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pb-4">
          <ActivityDetails name={name} activity={activity} />
          <RemoteJobs jobs={remote.data?.jobs ?? []} statusError={remote.data?.statusError} />
          {workbotHost().remoteTasks && remote.isError && !remote.data ? <p className="px-5 pt-3 text-[13px] text-[var(--wb-muted)]">Couldn&apos;t check remote tasks just now. <button type="button" className="underline" onClick={() => void remote.refetch()}>Try again</button></p> : null}
        </div>
        {watch === "computer" ? <div className="shrink-0 border-t border-[var(--wb-hairline)] px-5 py-3"><WatchButton watch={watch} onDone={onClose} /></div> : null}
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}
