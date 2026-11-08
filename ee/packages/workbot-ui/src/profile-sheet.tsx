"use client";

import { Dialog } from "@base-ui/react/dialog";
import { Clock3, Fingerprint, ListChecks, Lock, Monitor, ShieldCheck, X } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { describeSchedule } from "@openwork/calendar";
import { useWorkbotAutomations } from "./calendar-data";
import { RemoteJobs, useWorkbotRemoteJobs } from "./remote-jobs";
import { computerViews, useRetainedSurface, workbotHost } from "./host";
import { useWorkbotConnections, useWorkbotMemory } from "./data";
import { AppMark } from "./files";
import { dayLabel } from "./format";
import { OpenWorkMark } from "./mark";
import type { WorkbotActivity } from "./activity";
import { ActivityDetails, StatusIcon, WatchButton } from "./working-status";

/**
 * Workbot's profile, behind its name (`profileSheet`): who it is and whether it is at work, then one tab at a time
 * (P3): what it is working on, what it can use, and what it remembers about the person. Read-only in this version:
 * the person changes memory by telling Workbot, and connections in Den.
 */
type ProfileTab = "tasks" | "permissions" | "computer" | "schedules" | "memory";
const TABS: Array<{ id: ProfileTab; label: string; icon: typeof ListChecks }> = [
  { id: "tasks", label: "Tasks", icon: ListChecks },
  { id: "permissions", label: "Permissions", icon: ShieldCheck },
  { id: "computer", label: "Computer", icon: Monitor },
  { id: "schedules", label: "Schedules", icon: Clock3 },
  { id: "memory", label: "Identity", icon: Fingerprint },
];

const row = "flex min-h-11 items-center gap-3 border-b border-[var(--wb-row-line)] py-2 text-[13.5px] text-[var(--wb-text)] last:border-b-0";

export function ProfileSheet({ open, onClose, name, activity }: { open: boolean; onClose(): void; name: string; activity: WorkbotActivity; mark?: ReactNode }) {
  const surface = useRetainedSurface(open);
  const [tab, setTab] = useState<ProfileTab>("tasks");
  const tabId = useId();
  const centered = workbotHost().centeredProfile === true;
  const tabs = centered ? TABS : TABS.filter((entry) => entry.id !== "computer" && entry.id !== "schedules").map((entry) => ({ ...entry, label: entry.id === "permissions" ? "What I can use" : entry.id === "memory" ? "What I remember" : entry.label }));
  return <Dialog.Root open={surface.open} onOpenChange={(next) => { if (!next) onClose(); }}>
    <Dialog.Portal {...surface.portal}>
      <Dialog.Backdrop className="fixed inset-0 z-40 bg-[var(--wb-ink)]/25 transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 motion-reduce:transition-none sm:bg-[var(--wb-ink)]/10" />
      <Dialog.Popup className="workbot fixed inset-x-0 bottom-0 top-3 z-50 flex flex-col overflow-hidden rounded-t-[24px] bg-[var(--wb-bg)] pb-[env(safe-area-inset-bottom)] shadow-[var(--wb-panel-shadow)] outline-none transition-transform duration-200 ease-out data-[ending-style]:translate-y-full data-[starting-style]:translate-y-full motion-reduce:transition-none sm:inset-y-0 sm:left-auto sm:right-0 sm:top-0 sm:w-[420px] sm:rounded-none sm:shadow-[var(--wb-sheet-shadow)] sm:data-[ending-style]:translate-x-full sm:data-[ending-style]:translate-y-0 sm:data-[starting-style]:translate-x-full sm:data-[starting-style]:translate-y-0" data-workbot-profile>
        <div className="relative flex shrink-0 flex-col items-center gap-1.5 px-5 pb-4 pt-6">
          <Dialog.Close aria-label="Close" className="absolute left-4 top-4 grid size-9 place-items-center rounded-full text-[var(--wb-muted)] shadow-[0_0_0_1px_var(--wb-ring)] hover:text-[var(--wb-text)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"><X size={16} strokeWidth={1.75} aria-hidden /></Dialog.Close>
          <span aria-hidden className={`grid ${centered ? "size-[96px]" : "size-[76px]"} place-items-center rounded-full bg-[var(--wb-surface)] shadow-[var(--wb-card-shadow)]`}><OpenWorkMark width={centered ? 38 : 34} height={centered ? 48 : 42} /></span>
          <Dialog.Title className={`pt-2 font-semibold text-[var(--wb-text)] ${centered ? "text-[24px] leading-7 tracking-[-0.02em]" : "text-[20px] leading-6 tracking-[-0.015em]"}`}>{name}</Dialog.Title>
          <Dialog.Description className="flex max-w-full items-center gap-1.5 text-[14px] text-[var(--wb-muted)]" data-workbot-profile-status>
            {!centered && activity.working ? <><StatusIcon activity={activity} size={13} /><span className="truncate">{activity.label}</span></> : <><span aria-hidden className={`size-2 rounded-full ${activity.connected === false ? "bg-[var(--wb-disabled)]" : "bg-[#30a46c]"}`} />{activity.connected === false ? "Connecting" : centered ? "Connected" : "Ready"}</>}
          </Dialog.Description>
          {centered && activity.working ? <p className="flex max-w-full items-center gap-1.5 text-[12px] text-[var(--wb-muted)]"><StatusIcon activity={activity} size={12} /><span className="truncate">{activity.label}</span></p> : null}
          <div role="tablist" aria-label={`${name}'s profile`} className="mt-3 flex w-full max-w-[320px] items-center justify-between rounded-full bg-[var(--wb-surface)] p-1 shadow-[0_0_0_1px_var(--wb-ring)]">
            {tabs.map(({ id, label, icon: Icon }, index) => <button key={id} type="button" role="tab" id={`${tabId}-${id}`} aria-controls={`${tabId}-panel`} tabIndex={tab === id ? 0 : -1} aria-selected={tab === id} aria-label={label} title={label} onClick={() => setTab(id)}
              onKeyDown={(event) => {
                const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
                const entry = next === null ? null : tabs[next];
                if (!entry) return;
                event.preventDefault(); setTab(entry.id); document.getElementById(`${tabId}-${entry.id}`)?.focus();
              }}
              className={`flex h-9 flex-1 items-center justify-center rounded-full transition-colors duration-150 focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)] ${tab === id ? "bg-[var(--wb-chip)] text-[var(--wb-text)]" : "text-[var(--wb-muted)] hover:text-[var(--wb-text)]"}`}>
              <Icon size={18} strokeWidth={1.6} aria-hidden />
            </button>)}
          </div>
        </div>
        <div role="tabpanel" id={`${tabId}-panel`} aria-labelledby={`${tabId}-${tab}`} tabIndex={0} className="min-h-0 flex-1 overflow-y-auto pb-6 outline-none">
          {tab === "tasks" ? <TasksTab name={name} activity={activity} onClose={onClose} /> : tab === "permissions" ? <PermissionsTab name={name} /> : tab === "computer" ? <ComputerTab name={name} onClose={onClose} /> : tab === "schedules" ? <SchedulesTab /> : <MemoryTab name={name} />}
        </div>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}

function TasksTab({ name, activity, onClose }: { name: string; activity: WorkbotActivity; onClose(): void }) {
  const remote = useWorkbotRemoteJobs(true);
  const localWork = activity.main !== null || activity.tasks.length > 0;
  return <>
    {localWork ? <>
      <h2 className="px-5 pb-2 text-[13px] font-medium text-[var(--wb-text)]">{activity.working ? "In progress" : "Recent"}</h2>
      <ActivityDetails name={name} activity={activity} />
    </> : !remote.data?.jobs.length && !remote.isFetching ? <p className="px-5 pt-2 text-[13px] text-[var(--wb-muted)]">{name} isn&apos;t working on anything right now. Bigger jobs you hand it show up here while they run.</p> : null}
    {workbotHost().remoteTasks && remote.isPending ? <p className="px-5 pt-3 text-[13px] text-[var(--wb-muted)]" role="status">Checking your remote tasks…</p> : null}
    {workbotHost().remoteTasks && remote.isError ? <p className="px-5 pt-3 text-[13px] text-[var(--wb-muted)]" role="status">Couldn&apos;t verify your remote tasks. <button type="button" className="underline" onClick={() => void remote.refetch()}>Try again</button></p> : null}
    <RemoteJobs jobs={remote.data?.jobs ?? []} />
    {remote.data?.hasEarlier ? <p className="px-5 pt-2 text-[12px] text-[var(--wb-muted)]">Showing recent remote tasks. Older jobs may be outside this chat&apos;s current history.</p> : null}
    {activity.watch ? <div className="px-5 pt-3"><WatchButton watch={activity.watch} onDone={onClose} /></div> : null}
  </>;
}

function ComputerTab({ name, onClose }: { name: string; onClose(): void }) {
  const views = computerViews(workbotHost());
  return <div className="flex flex-col gap-3 px-5 pt-1">
    <p className="text-[13px] leading-[19px] text-[var(--wb-muted)]">{name}&apos;s own browser and computer. The full view opens only when you choose to look.</p>
    {views.length ? views.map((view) => <WatchButton key={view} watch={view} onDone={onClose} />) : <p className="flex items-center gap-2 text-[13px] text-[var(--wb-muted)]"><Lock size={14} aria-hidden />Your organization hasn&apos;t enabled a computer for {name}.</p>}
  </div>;
}

function SchedulesTab() {
  return workbotHost().calendar ? <SchedulesList /> : <p className="px-5 pt-1 text-[13px] leading-[19px] text-[var(--wb-muted)]">Schedules aren&apos;t enabled for this organization. An admin can turn on Workbot&apos;s calendar.</p>;
}

/** Read the same owner-scoped Automations as Calendar; never invent a schedule or a new per-feature screen. */
function SchedulesList() {
  const schedules = useWorkbotAutomations();
  return <div className="flex flex-col gap-3 px-5 pt-1">
    <h2 className="text-[13px] font-medium text-[var(--wb-text)]">Your schedules</h2>
    {schedules.isPending ? <p className="text-[13px] text-[var(--wb-muted)]" role="status">Reading your schedules…</p>
      : schedules.isError ? <p className="text-[13px] text-[var(--wb-muted)]" role="status">Couldn&apos;t read your schedules. <button type="button" className="underline" onClick={() => void schedules.refetch()}>Try again</button></p>
      : !schedules.data.items.length ? <p className="text-[13px] text-[var(--wb-muted)]">No schedules yet. Ask Workbot to set one up.</p>
      : <ul>{schedules.data.items.map(({ automation, revision }) => <li key={automation.id} className={`${row} flex-col !items-start gap-0.5`}>
        <span className="font-medium">{automation.name}</span>
        <span className="text-[12px] text-[var(--wb-muted)]">{describeSchedule(revision.schedule, revision.schedule.timezone, "en-US")} · {automation.state === "inactive" ? "Paused" : automation.state === "needs_attention" ? "Needs attention" : "Active"}</span>
      </li>)}</ul>}
  </div>;
}

/** The apps and parts of its computer Workbot can use for the person, each saying whether it can; off ones stay listed with why (P4). */
function PermissionsTab({ name }: { name: string }) {
  const host = workbotHost();
  const connections = useWorkbotConnections({ enabled: true, waiting: false });
  const views = computerViews(host);
  const abilities: Array<{ label: string; on: boolean }> = [
    { label: "Browse the web in its own browser", on: views.includes("browser") },
    { label: "Use apps on its own computer", on: views.includes("computer") },
    { label: "Read and edit your documents", on: host.documents === true },
    { label: "Your calendar", on: host.calendar === true },
  ];
  return <div className="flex flex-col gap-6 px-5 pt-1">
    <section>
      <h2 className="pb-1 text-[13px] font-medium text-[var(--wb-text)]">Your apps</h2>
      {connections.isPending ? <p className="py-2 text-[13px] text-[var(--wb-muted)]" aria-busy="true">Checking your apps…</p>
        : connections.isError ? <p className="py-2 text-[13px] text-[var(--wb-muted)]" role="status">Couldn&apos;t check your apps. <button type="button" className="underline" onClick={() => void connections.refetch()}>Try again</button></p>
        : connections.data.length === 0 ? <p className="py-2 text-[13px] text-[var(--wb-muted)]">No apps are set up for {name} yet.</p>
        : <ul>{connections.data.map((connection) => <li key={connection.id} className={row}>
            <AppMark name={connection.name} size={16} />
            <span className="min-w-0 flex-1 truncate">{connection.name}</span>
            {connection.ready ? <span className="text-[12.5px] text-[var(--wb-muted)]">Connected</span>
              : connection.connectUrl ? <a href={connection.connectUrl} target="_blank" rel="noreferrer noopener" className="rounded-full px-2.5 py-1 text-[12.5px] font-medium text-[var(--wb-text)] shadow-[0_0_0_1px_var(--wb-ring)] hover:bg-[var(--wb-chip)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]">Connect</a>
              : <span className="flex items-center gap-1 text-[12.5px] text-[var(--wb-muted)]"><Lock size={12} aria-hidden />An admin sets this up</span>}
          </li>)}</ul>}
    </section>
    <section>
      <h2 className="pb-1 text-[13px] font-medium text-[var(--wb-text)]">What {name} can do</h2>
      <ul>{abilities.map((ability) => <li key={ability.label} className={row}>
        <span className="min-w-0 flex-1">{ability.label}</span>
        {ability.on ? <span className="text-[12.5px] text-[var(--wb-muted)]">On</span> : <span className="flex items-center gap-1 text-[12.5px] text-[var(--wb-muted)]" title="An admin can turn this on"><Lock size={12} aria-hidden />Off</span>}
      </li>)}</ul>
    </section>
    {host.connectionsHref ? <a href={host.connectionsHref} target="_blank" rel="noreferrer noopener" className="w-fit text-[13px] font-medium text-[var(--wb-text)] underline decoration-[var(--wb-disabled)] underline-offset-2 hover:decoration-current">Manage your connections</a> : null}
  </div>;
}

/** "about-me.md" → "About me". */
function memoryTitle(file: string) {
  const plain = file.replace(/\.(md|txt)$/i, "").replace(/[-_]+/g, " ").trim();
  return plain ? `${plain[0]?.toUpperCase()}${plain.slice(1)}` : file;
}

/** What Workbot remembers, file by file, newest first. Read-only: it changes when the person tells Workbot. */
function MemoryTab({ name }: { name: string }) {
  const memory = useWorkbotMemory(true);
  return <div className="flex flex-col gap-3 px-5 pt-1">
    <p className="text-[13px] leading-[18px] text-[var(--wb-muted)]">What {name} keeps in mind about you across chats. To change something, tell {name} in the chat.</p>
    {memory.isPending ? <p className="text-[13px] text-[var(--wb-muted)]" role="status">Reading what I remember…</p>
      : memory.isError ? <p className="text-[13px] text-[var(--wb-muted)]" role="status">{memory.error.message} <button type="button" className="underline" onClick={() => void memory.refetch()}>Try again</button></p>
      : memory.data.length === 0 ? <p className="text-[13px] text-[var(--wb-muted)]">Nothing yet. Tell {name} about yourself, your team and your projects, and it will remember.</p>
      : <ul className="flex flex-col gap-2">{memory.data.map((file) => <li key={file.name}>
          <details className="group rounded-[14px] bg-[var(--wb-surface)] shadow-[var(--wb-card-shadow)]">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)] [&::-webkit-details-marker]:hidden">
              <span className="truncate text-[14px] font-medium text-[var(--wb-text)]">{memoryTitle(file.name)}</span>
              <span className="shrink-0 text-[12px] text-[var(--wb-muted)]">{file.updatedAt ? dayLabel(file.updatedAt) : ""}</span>
            </summary>
            <p className="whitespace-pre-wrap break-words border-t border-[var(--wb-hairline)] px-4 py-3 text-[13px] leading-[19px] text-[var(--wb-text)]">{file.content.trim()}</p>
          </details>
        </li>)}</ul>}
  </div>;
}
