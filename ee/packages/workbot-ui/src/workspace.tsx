"use client";

import { Dialog } from "@base-ui/react/dialog";
import { Popover } from "@base-ui/react/popover";
import { useQuery } from "@tanstack/react-query";
import { googleDriveProvider } from "@openwork/documents";
import { googleDriveFileId, workbotContextLabel, type WorkbotViewContext } from "@openwork/types/workbot-context";
import { CalendarDays, FileText, House, Lock, MessageCircle, PanelLeft, X } from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { workbotHost } from "./host";

export type WorkspacePage = "home" | "calendar" | "documents";
export const WorkspaceNavigationContext = createContext<((fileId: string) => void) | null>(null);
const control = "grid size-8 shrink-0 place-items-center rounded-lg text-[var(--wb-muted)] hover:bg-[var(--wb-chip)] hover:text-[var(--wb-text)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]";

/** A result offers navigation; only the person's ordinary click opens a file in Workbot. */
export function WorkspaceLink({ href, children }: { href: string; children: ReactNode }) {
  const open = useContext(WorkspaceNavigationContext);
  const fileId = open ? googleDriveFileId(href) : null;
  return <a href={href} target="_blank" rel="noreferrer noopener" className="underline decoration-[var(--wb-disabled)] underline-offset-2 hover:decoration-current" title={fileId ? "Open in Documents" : undefined} onClick={event => {
    if (!fileId || !open || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    open(fileId);
  }}>{children}</a>;
}

/** One navigation drawer, backed by the signed-in member's Drive metadata. */
export function WorkspaceMenu({ page, onPage, onDocument, onChats, drafts }: { page: WorkspacePage; onPage(page: WorkspacePage): void; onDocument(fileId: string): void; onChats?: () => void; drafts: boolean }) {
  const host = workbotHost();
  const [open, setOpen] = useState(false);
  const provider = useMemo(() => googleDriveProvider((path, signal) => host.requestJson(`/v1/workbot/documents${path}`, { signal })), [host]);
  const recent = useQuery({
    queryKey: ["documents", host.homeHref, host.identity?.organizationId, host.identity?.principalId, "workspace-recent"],
    queryFn: ({ signal }) => provider.list({ view: "recent", folderId: "root", query: "", signal }),
    enabled: open && host.documents === true && !!host.identity, retry: false, staleTime: 0, gcTime: 0,
  });
  const navigate = (next: WorkspacePage) => { onPage(next); setOpen(false); };
  const row = "flex h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-[13px] text-[var(--wb-text)] hover:bg-[var(--wb-chip)] aria-[current=page]:bg-[var(--wb-chip)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]";
  return <Dialog.Root open={open} onOpenChange={setOpen}>
    <Dialog.Trigger className={control} aria-label="Open workspace navigation" title="Navigate"><PanelLeft size={16} strokeWidth={1.5} aria-hidden /></Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-40 bg-[var(--wb-ink)]/10 transition-opacity duration-150 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 motion-reduce:transition-none" />
      <Dialog.Popup className="workbot fixed inset-y-0 left-0 z-50 flex w-[min(20rem,100vw)] flex-col bg-[var(--wb-surface)] shadow-[var(--wb-sheet-shadow)] outline-none transition-transform duration-200 ease-out data-[ending-style]:-translate-x-full data-[starting-style]:-translate-x-full motion-reduce:transition-none">
        <div className="flex h-14 shrink-0 items-center justify-between px-4"><Dialog.Title className="text-[14px] font-semibold text-[var(--wb-text)]">Workbot</Dialog.Title><Dialog.Close className={control} aria-label="Close workspace navigation"><X size={16} strokeWidth={1.5} aria-hidden /></Dialog.Close></div>
        <nav aria-label="Workspace" className="px-2">
          <button type="button" className={row} aria-current={page === "home" ? "page" : undefined} onClick={() => navigate("home")}><House size={16} strokeWidth={1.5} aria-hidden />Home</button>
          <button type="button" className={row} disabled={!host.calendar} aria-current={page === "calendar" ? "page" : undefined} onClick={() => navigate("calendar")} title={!host.calendar ? "Calendar is off. An admin can turn it on." : undefined}><CalendarDays size={16} strokeWidth={1.5} aria-hidden />Calendar{!host.calendar && <Lock size={13} aria-label="Off for this workspace" />}</button>
          {host.documents === true && <button type="button" className={row} aria-current={page === "documents" ? "page" : undefined} onClick={() => navigate("documents")}><FileText size={16} strokeWidth={1.5} aria-hidden />Documents</button>}
          {onChats && <button type="button" className={row} disabled={drafts} title={drafts ? "Save or close document drafts before switching chats." : undefined} onClick={() => { setOpen(false); onChats(); }}><MessageCircle size={16} strokeWidth={1.5} aria-hidden />Chats{drafts && <Lock size={13} aria-label="Save or close document drafts first" />}</button>}
          {drafts && onChats && <p className="px-3 py-1 text-[12px] text-[var(--wb-muted)]">Save or close drafts to switch chats.</p>}
        </nav>
        {host.documents === true && <div className="mt-5 min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          <h2 className="px-3 pb-2 text-[12px] font-medium text-[var(--wb-muted)]">Recent documents</h2>
          {recent.isError ? <div className="px-3 text-[12px] text-[var(--wb-muted)]" role="status">Couldn't read recent documents. <button type="button" className="underline" onClick={() => void recent.refetch()}>Try again</button></div>
            : recent.isPending ? <div className="flex flex-col gap-3 px-3" aria-label="Loading recent documents" aria-busy="true">{[0, 1, 2].map(id => <span key={id} className="h-5 rounded bg-[var(--wb-chip)]" />)}</div>
            : recent.data.items.filter(item => item.kind === "file").slice(0, 12).map(item => <button type="button" key={item.id} aria-label={`Open ${item.name}`} className={row} onClick={() => { onDocument(item.id); setOpen(false); }}><FileText size={16} strokeWidth={1.5} aria-hidden /><span className="truncate">{item.name}</span></button>)}
          {recent.isSuccess && recent.data.items.every(item => item.kind !== "file") && <p className="px-3 text-[12px] text-[var(--wb-muted)]">No recent documents.</p>}
        </div>}
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}

/** The chip names the exact snapshot attached to this message, including draft state. */
export function SentContext({ context }: { context?: WorkbotViewContext }) {
  if (!context) return null;
  return <p className="mb-1 truncate text-right text-[11px] text-[var(--wb-muted)]" title={workbotContextLabel(context)} data-workbot-sent-context>{context.kind === "calendar" ? "Calendar" : "Documents"} · {workbotContextLabel(context)}{context.kind === "document" && context.unsaved ? " · Unsaved edits excluded" : ""}</p>;
}

/** The composer stays in the workspace; the conversation is disclosed through an anchored Base UI popover. */
export function WorkspaceAssistant({ name, context, includeContext, onIncludeContext, composer, conversation, onDocument, unavailable, active }: { active: boolean; name: string; context: WorkbotViewContext | null; includeContext: boolean; onIncludeContext(value: boolean): void; composer: ReactNode; conversation: ReactNode; onDocument(fileId: string): void; unavailable: boolean }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!active) setOpen(false); }, [active]);
  return <div ref={anchor} className="fixed bottom-3 right-3 z-30 w-[min(26rem,calc(100vw-1.5rem))] sm:bottom-5 sm:right-5" data-workbot-workspace-assistant>
    <Popover.Root open={open} onOpenChange={(next, details) => {
      // The composer belongs to this explicit disclosure, not to the document behind it.
      const target = details.reason === "focus-out" && details.event instanceof FocusEvent ? details.event.relatedTarget : details.event.target;
      if (!next && (details.reason === "outside-press" || details.reason === "focus-out") && target instanceof Node && anchor.current?.contains(target)) {
        details.cancel();
        return;
      }
      setOpen(next);
    }}>
      <div className="mb-1 flex min-w-0 items-center justify-end gap-1.5">
        {context && <button type="button" aria-pressed={includeContext} onClick={() => onIncludeContext(!includeContext)} title={includeContext ? "Exclude this view from your next message" : "Include a read-only reference to this view"} className={`min-w-0 truncate rounded-full bg-[var(--wb-surface)] px-2.5 py-1 text-[11px] shadow-[var(--wb-card-shadow)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)] ${includeContext ? "text-[var(--wb-text)]" : "text-[var(--wb-muted)] line-through"}`} data-workbot-view-context data-testid="workbot-view-context">{workbotContextLabel(context)}{includeContext ? " · Read-only context" : ""}{context.kind === "document" && context.unsaved ? " · Unsaved edits excluded" : ""}</button>}
        <Popover.Trigger className="flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-[var(--wb-surface)] px-2.5 text-[11px] text-[var(--wb-text)] shadow-[var(--wb-card-shadow)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]" aria-label={open ? "Hide workspace chat" : "Show workspace chat"}><MessageCircle size={13} strokeWidth={1.5} aria-hidden />{name}</Popover.Trigger>
      </div>
      {composer}
      <Popover.Portal>
        <Popover.Positioner anchor={anchor} side="top" align="end" sideOffset={8} collisionPadding={12} className="z-40 max-w-[var(--available-width)]">
          <Popover.Popup initialFocus={false} className="workbot flex h-[min(34rem,var(--available-height))] w-[min(30rem,var(--available-width))] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-[var(--dls-radius,16px)] bg-[var(--wb-surface)] shadow-[var(--wb-panel-shadow)] outline-none" data-workbot-workspace-chat>
            <div className="flex h-10 shrink-0 items-center justify-between px-3"><Popover.Title className="text-[13px] font-medium text-[var(--wb-text)]">{name}</Popover.Title><Popover.Close className={control} aria-label="Hide workspace chat"><X size={15} strokeWidth={1.5} aria-hidden /></Popover.Close></div>
            <WorkspaceNavigationContext.Provider value={fileId => { setOpen(false); onDocument(fileId); }}>
              {unavailable ? <p className="p-4 text-[13px] text-[var(--wb-muted)]" role="status">Chat is unavailable. Open Home to try again.</p> : conversation}
            </WorkspaceNavigationContext.Provider>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  </div>;
}
