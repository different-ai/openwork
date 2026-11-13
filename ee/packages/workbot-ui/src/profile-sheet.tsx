"use client";

import { Dialog } from "@base-ui/react/dialog";
import { connectorDisplayName } from "@openwork/types/connector-brand";
import { Clock3, Fingerprint, FolderOpen, LayoutGrid, ListChecks, Lock, MonitorSmartphone, X } from "lucide-react";
import { useContext, useId, useState, type ReactNode } from "react";
import { describeSchedule } from "@openwork/calendar";
import { useWorkbotAutomations } from "./calendar-data";
import { RemoteJobs, useWorkbotRemoteJobs } from "./remote-jobs";
import { computerViews, useRetainedSurface, workbotHost } from "./host";
import { useWorkbotApps, useWorkbotMemory } from "./data";
import { APP_STATUS, appNote } from "./apps";
import { useWorkbotConnect, WorkbotConnectionButton } from "./connect";
import { AppMark, FilesList } from "./files";
import { OpenFileContext } from "./open-file";
import { dayLabel } from "./format";
import { OpenWorkMark } from "./mark";
import type { WorkbotActivity } from "./activity";
import { ActivityDetails, StatusIcon } from "./working-status";
import { PhoneSheetEdge, SheetGrabber, useSheetDrag } from "./sheet-drag";
import { DeviceComputerNavigationContext, WorkbotDevices } from "./devices";

/**
 * Workbot's profile, behind its name: who it is and whether it is at work, then one tab at a time
 * (P3): what it is working on, files, apps, schedules, computers and identity. Computers reuses Devices, including
 * the screen's existing guarded Open actions; no provisioning or permission changes. The person changes memory by
 * telling Workbot, and connections in Den. `initialTab` picks the tab each time the sheet opens.
 */
export type ProfileTab = "tasks" | "files" | "permissions" | "schedules" | "computers" | "memory";
const TABS: Array<{ id: ProfileTab; label: string; icon: typeof ListChecks }> = [
  { id: "tasks", label: "Tasks", icon: ListChecks },
  { id: "files", label: "Files", icon: FolderOpen },
  { id: "permissions", label: "Apps", icon: LayoutGrid },
  { id: "schedules", label: "Schedules", icon: Clock3 },
  { id: "computers", label: "Computers", icon: MonitorSmartphone },
  { id: "memory", label: "Identity", icon: Fingerprint },
];

const row = "flex min-h-11 items-center gap-3 border-b border-[var(--wb-row-line)] py-2 text-[13.5px] text-[var(--wb-text)] last:border-b-0";

export function ProfileSheet({ open, onClose, name, activity, initialTab = "tasks" }: { open: boolean; onClose(): void; name: string; activity: WorkbotActivity; mark?: ReactNode; /** The tab it opens on, each time it opens (default Tasks). */ initialTab?: ProfileTab }) {
  const surface = useRetainedSurface(open);
  const [tab, setTab] = useState<ProfileTab>(initialTab);
  // The sheet stays mounted while closed, so each opening starts on the tab the caller asked for.
  const [openedOn, setOpenedOn] = useState(open ? initialTab : null);
  const want = open ? initialTab : null;
  if (want !== openedOn) {
    setOpenedOn(want);
    if (want) setTab(want);
  }
  const tabId = useId();

  const computers = workbotHost().profileComputers === true && workbotHost().devices === true;
  const tabs = TABS.filter((entry) => computers || entry.id !== "computers");
  if (!tabs.some((entry) => entry.id === tab)) setTab("tasks");
  const drag = useSheetDrag(onClose);
  // One sheet for every screen size: a side panel from `sm` up, and on phones a full-height sheet under the status bar
  // that reaches the bottom edge (its rows scroll under a glass fade), pulled down or closed to dismiss.
  return <Dialog.Root open={surface.open} onOpenChange={(next) => { if (!next) onClose(); }}>
    <Dialog.Portal {...surface.portal}>
      <Dialog.Backdrop className="fixed inset-0 z-40 bg-[var(--wb-ink)]/25 transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 motion-reduce:transition-none sm:bg-[var(--wb-ink)]/10" />
      <Dialog.Popup ref={drag.popupRef} className="workbot fixed inset-x-0 bottom-0 top-[calc(env(safe-area-inset-top)+0.5rem)] z-50 flex flex-col overflow-hidden rounded-t-[24px] bg-[var(--wb-bg)] shadow-[var(--wb-panel-shadow)] outline-none workbot-sheet-motion transition-transform data-[ending-style]:translate-y-full data-[starting-style]:translate-y-full motion-reduce:transition-none sm:inset-y-0 sm:left-auto sm:right-0 sm:top-0 sm:w-[420px] sm:rounded-none sm:shadow-[var(--wb-sheet-shadow)] sm:data-[ending-style]:translate-x-full sm:data-[ending-style]:translate-y-0 sm:data-[starting-style]:translate-x-full sm:data-[starting-style]:translate-y-0" data-workbot-profile data-workbot-phone-sheet>
        <div {...drag.handle} className="relative flex shrink-0 touch-none select-none flex-col items-center gap-1.5 px-5 pb-4 pt-6 sm:touch-auto sm:select-auto">
          <SheetGrabber />
          <Dialog.Close aria-label="Close" className="absolute left-4 top-4 grid size-9 place-items-center rounded-full text-[var(--wb-muted)] shadow-[0_0_0_1px_var(--wb-ring)] hover:text-[var(--wb-text)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]" data-workbot-sheet-close><X size={16} strokeWidth={1.75} aria-hidden /></Dialog.Close>
          <span aria-hidden className="grid size-[96px] place-items-center rounded-full bg-[var(--wb-surface)] shadow-[var(--wb-card-shadow)]"><OpenWorkMark width={38} height={48} /></span>
          <Dialog.Title className="pt-2 font-semibold text-[var(--wb-text)] text-[24px] leading-7 tracking-[-0.02em]">{name}</Dialog.Title>
          <Dialog.Description className="flex max-w-full items-center gap-1.5 text-[14px] text-[var(--wb-muted)]" data-workbot-profile-status>
            <><span aria-hidden className={`size-2 rounded-full ${activity.connected === false ? "bg-[var(--wb-disabled)]" : "bg-[#30a46c]"}`} />{activity.connected === false ? "Connecting" : "Connected"}</>
          </Dialog.Description>
          {activity.working ? <p className="flex max-w-full items-center gap-1.5 text-[12px] text-[var(--wb-muted)]"><StatusIcon activity={activity} size={12} /><span className="truncate">{activity.label}</span></p> : null}
          <div role="tablist" aria-label={`${name}'s profile`} className="mt-3 flex w-full max-w-[320px] items-center justify-between rounded-full bg-[var(--wb-surface)] p-1 shadow-[0_0_0_1px_var(--wb-ring)]">
            {tabs.map(({ id, label, icon: Icon }, index) => <button key={id} type="button" role="tab" id={`${tabId}-${id}`} aria-controls={`${tabId}-panel`} tabIndex={tab === id ? 0 : -1} aria-selected={tab === id} aria-label={label} title={label} onClick={() => setTab(id)}
              onKeyDown={(event) => {
                const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
                const entry = next === null ? null : tabs[next];
                if (!entry) return;
                event.preventDefault(); setTab(entry.id); document.getElementById(`${tabId}-${entry.id}`)?.focus();
              }}
              className={`flex ${computers ? "h-11" : "h-9"} min-w-0 flex-1 items-center justify-center rounded-full transition-colors duration-150 focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)] ${tab === id ? "bg-[var(--wb-chip)] text-[var(--wb-text)]" : "text-[var(--wb-muted)] hover:text-[var(--wb-text)]"}`}>
              <Icon size={18} strokeWidth={1.6} aria-hidden />
            </button>)}
          </div>
        </div>
        <div role="tabpanel" id={`${tabId}-panel`} aria-labelledby={`${tabId}-${tab}`} tabIndex={0} className="min-h-0 flex-1 overflow-y-auto pb-[calc(env(safe-area-inset-bottom)+2rem)] outline-none sm:pb-6">
          {tab === "tasks" ? <TasksTab name={name} activity={activity} /> : tab === "files" ? <FilesTab name={name} open={surface.open} onClose={onClose} /> : tab === "permissions" ? <AppsTab name={name} /> : tab === "schedules" ? <SchedulesTab /> : tab === "computers" && computers ? <ComputersTab onClose={onClose} /> : <MemoryTab name={name} />}
        </div>
        <PhoneSheetEdge />
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}

function TasksTab({ name, activity }: { name: string; activity: WorkbotActivity }) {
  const remote = useWorkbotRemoteJobs(true);
  const localWork = activity.main !== null || activity.tasks.length > 0;
  const localActive = activity.main !== null || activity.tasks.some((task) => !task.quiet && (task.status === "queued" || task.status === "working" || task.status === "paused"));
  return <>
    {localWork ? <>
      <h2 className="px-5 pb-2 text-[13px] font-medium text-[var(--wb-text)]">{localActive ? "In progress" : "Recent"}</h2>
      <ActivityDetails name={name} activity={activity} />
    </> : !remote.data?.jobs.length && !remote.isFetching ? <p className="px-5 pt-2 text-[13px] text-[var(--wb-muted)]">{name} isn&apos;t working on anything right now. Bigger jobs you hand it show up here while they run.</p> : null}
    {remote.isPending ? <p className="px-5 pt-3 text-[13px] text-[var(--wb-muted)]" role="status">Checking your remote tasks…</p> : null}
    {/* Only when nothing is known yet; known rows keep their last state through a failed refresh. */}
    {remote.isError && !remote.data ? <p className="px-5 pt-3 text-[13px] text-[var(--wb-muted)]" role="status">Couldn&apos;t check your remote tasks just now. <button type="button" className="underline" onClick={() => void remote.refetch()}>Try again</button></p> : null}
    <RemoteJobs jobs={remote.data?.jobs ?? []} statusError={remote.data?.statusError} />
    {remote.data?.hasEarlier ? <p className="px-5 pt-2 text-[12px] text-[var(--wb-muted)]">Showing recent remote tasks. Older jobs may be outside this chat&apos;s current history.</p> : null}
  </>;
}

/** Files the person sent and Workbot made; opening one closes the profile and shows it beside the chat. */
function FilesTab({ name, open, onClose }: { name: string; open: boolean; onClose(): void }) {
  const openFile = useContext(OpenFileContext);
  return <FilesList enabled={open} assistantName={name} framed={false} onOpenFile={(file) => { onClose(); openFile(file); }} />;
}

/** Reuse the inventory and the screen's guarded navigation; dismiss the sheet only when Open is available. */
function ComputersTab({ onClose }: { onClose(): void }) {
  const computerFor = useContext(DeviceComputerNavigationContext);
  return <WorkbotDevices computerFor={(chat) => {
    const openComputer = computerFor?.(chat);
    return openComputer ? () => { onClose(); openComputer(); } : null;
  }} />;
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

/**
 * The apps and parts of its computer Workbot can use for the person, each saying whether it can; off ones stay listed
 * with why (P4). Apps: every connector the person can use, connected or not (Connected first), with one Connect where
 * they sign in themselves and a short note where only an admin can.
 */
/** `titled`: the sheet is already titled Apps, so the list does not repeat it. */
function AppsTab({ name, titled = false }: { name: string; titled?: boolean }) {
  const host = workbotHost();
  const views = computerViews(host);
  const abilities: Array<{ label: string; on: boolean }> = [
    { label: "Browse the web in its own browser", on: views.includes("browser") },
    { label: "Use apps on its own computer", on: views.includes("computer") },
    { label: "Read and edit your documents", on: host.documents === true },
    { label: "Your calendar", on: host.calendar === true },
  ];
  return <div className="flex flex-col gap-6 px-5 pt-1">
    <AppsList name={name} heading={!titled} />
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

/**
 * Every app the person can use, connected or not: Connected first, then Needs sign-in, Not connected and Needs
 * attention, each with its plain status; one Connect where they sign in themselves, "Ask your admin" where they can't.
 */
export function AppsList({ name, heading = true }: { name: string; heading?: boolean }) {
  const flow = useWorkbotConnect();
  const apps = useWorkbotApps({ enabled: true, waiting: flow.pendingId !== null });
  return <section aria-label="Your apps">
    {heading ? <h2 className="pb-1 text-[13px] font-medium text-[var(--wb-text)]">Your apps</h2> : null}
    {apps.isPending ? <p className="py-2 text-[13px] text-[var(--wb-muted)]" aria-busy="true">Checking your apps…</p>
      : apps.isError ? <p className="py-2 text-[13px] text-[var(--wb-muted)]" role="status">Couldn&apos;t check your apps. <button type="button" className="underline" onClick={() => void apps.refetch()}>Try again</button></p>
      : apps.data.length === 0 ? <p className="py-2 text-[13px] text-[var(--wb-muted)]">No apps are set up for {name} yet.</p>
      : <ul data-workbot-apps>{apps.data.map((app) => {
          const status = APP_STATUS[app.status];
          const displayName = connectorDisplayName(app.name);
          const note = appNote(app);
          return <li key={app.id} className={row} data-workbot-app={app.status}>
            <AppMark name={displayName} size={18} fallback="letter" iconCandidates={app.iconCandidates} tile />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{displayName}</span>
              <span className="flex items-center gap-1.5 text-[12px] text-[var(--wb-muted)]"><span aria-hidden className={`size-1.5 shrink-0 rounded-full ${status.dot}`} />{status.label}</span>
            </span>
            {app.action === "connect" ? <span className="flex max-w-[62%] justify-end"><WorkbotConnectionButton connection={app} flow={flow} /></span>
              : note ? <span className="flex shrink-0 items-center gap-1 text-[12.5px] text-[var(--wb-muted)]"><Lock size={12} aria-hidden />{note}</span>
              : null}
          </li>;
        })}</ul>}
  </section>;
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
