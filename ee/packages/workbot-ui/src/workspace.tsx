"use client";

import { Dialog } from "@base-ui/react/dialog";
import { Popover } from "@base-ui/react/popover";
import { useQuery } from "@tanstack/react-query";
import { googleDriveProvider } from "@openwork/documents";
import { googleDriveFileId, workbotContextLabel, type WorkbotViewContext } from "@openwork/types/workbot-context";
import { CalendarDays, FileText, House, Lock, MessageCircle, Monitor, PanelLeft, X } from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { workbotHost, useRetainedSurface } from "./host";

export type WorkspacePage = "home" | "calendar" | "documents" | "computer";
export const WorkspaceNavigationContext = createContext<((fileId: string) => void) | null>(null);
/** The document on screen right now, so a reply never offers to open what is already open. */
export const OpenDocumentContext = createContext<string | null>(null);
/** Opens Workbot's computer from a conversation; null while it is already on screen or unavailable. */
export const ComputerNavigationContext = createContext<(() => void) | null>(null);
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

/** Guided navigation: one quiet action for the first document a reply links to; any others stay inline links. */
export function DocumentOffers({ links }: { links: Array<{ fileId: string; label: string }> }) {
  const open = useContext(WorkspaceNavigationContext);
  const current = useContext(OpenDocumentContext);
  const first = links[0];
  if (!open || !workbotHost().guidedNavigation || !first || first.fileId === current) return null;
  return <div className="workbot-row-enter flex min-h-7 items-center pt-1" data-workbot-document-offer>
    <button type="button" onClick={() => open(first.fileId)} title="Open in Documents"
      className="flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-full px-2.5 text-[13px] font-medium leading-4 text-[var(--wb-text)] transition-colors duration-150 hover:bg-[var(--wb-chip)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]">
      <FileText size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-[var(--wb-muted)]" /><span className="truncate">Open {first.label}</span>
    </button>
  </div>;
}

export type DocumentNavigationState = "opening" | "opened" | "failed" | "superseded";
/** What became of the documents Workbot opened for this page's own messages; null without guided navigation. */
export const DocumentNavigationContext = createContext<{ status: Readonly<Record<string, DocumentNavigationState>>; open(receipt: { id: string; fileId: string }): void } | null>(null);

/** Says whether a document Workbot asked to open actually opened, so a request never reads as done. */
export function DocumentNavigationStatus({ receipts }: { receipts: Array<{ id: string; fileId: string }> }) {
  const navigation = useContext(DocumentNavigationContext);
  const receipt = receipts.at(-1);
  const status = receipt ? navigation?.status[receipt.id] : undefined;
  if (!navigation || !receipt || !status) return null;
  const again = status === "failed" ? "Try again" : status === "superseded" ? "Open" : null;
  return <p className="workbot-row-enter flex min-h-7 items-center gap-1.5 pl-2.5 pt-1 text-[12px] text-[var(--wb-muted)]" role="status" aria-busy={status === "opening"} data-workbot-document-navigation={status}>
    <FileText size={14} strokeWidth={1.75} aria-hidden className="shrink-0" />
    <span className="min-w-0 truncate">{status === "opening" ? "Opening in Documents…" : status === "opened" ? "Opened in Documents" : status === "failed" ? "Couldn't open this document. Check your Drive access." : "Not opened, because you moved on."}</span>
    {again && <button type="button" onClick={() => navigation.open(receipt)} className="shrink-0 rounded-full px-2 py-0.5 font-medium text-[var(--wb-text)] hover:bg-[var(--wb-chip)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]">{again}</button>}
  </p>;
}

/** Guided navigation: the latest reply that used Workbot's computer offers to open it, like a mentioned document. */
export function ComputerOffer() {
  const open = useContext(ComputerNavigationContext);
  if (!open || !workbotHost().guidedNavigation) return null;
  return <div className="workbot-row-enter flex min-h-7 items-center pt-1" data-workbot-computer-offer>
    <button type="button" onClick={open} title="Open Workbot's computer"
      className="flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-full px-2.5 text-[13px] font-medium leading-4 text-[var(--wb-text)] transition-colors duration-150 hover:bg-[var(--wb-chip)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]">
      <Monitor size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-[var(--wb-muted)]" /><span className="truncate">Open Computer</span>
    </button>
  </div>;
}

/** One navigation drawer, backed by the signed-in member's Drive metadata. */
export function WorkspaceMenu({ page, onPage, onDocument, onChats, drafts }: { page: WorkspacePage; onPage(page: WorkspacePage): void; onDocument(fileId: string): void; onChats?: () => void; drafts: boolean }) {
  const host = workbotHost();
  const [open, setOpen] = useState(false);
  const surface = useRetainedSurface(open);
  const provider = useMemo(() => googleDriveProvider((path, signal) => host.requestJson(`/v1/workbot/documents${path}`, { signal })), [host]);
  const recent = useQuery({
    queryKey: ["documents", host.homeHref, host.identity?.organizationId, host.identity?.principalId, "workspace-recent"],
    queryFn: ({ signal }) => provider.list({ view: "recent", folderId: "root", query: "", signal }),
    enabled: surface.open && host.documents === true && !!host.identity, retry: false, staleTime: 0, gcTime: 0,
  });
  const navigate = (next: WorkspacePage) => { onPage(next); setOpen(false); };
  const row = "flex h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-[13px] text-[var(--wb-text)] hover:bg-[var(--wb-chip)] aria-[current=page]:bg-[var(--wb-chip)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]";
  return <Dialog.Root open={surface.open} onOpenChange={next => { if (!surface.blocked) setOpen(next); }}>
    <Dialog.Trigger className={control} aria-label="Open workspace navigation" title="Navigate"><PanelLeft size={16} strokeWidth={1.5} aria-hidden /></Dialog.Trigger>
    <Dialog.Portal {...surface.portal}>
      <Dialog.Backdrop className="fixed inset-0 z-40 bg-[var(--wb-ink)]/10 transition-opacity duration-150 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 motion-reduce:transition-none" />
      <Dialog.Popup className="workbot fixed inset-y-0 left-0 z-50 flex w-[min(20rem,100vw)] flex-col bg-[var(--wb-surface)] shadow-[var(--wb-sheet-shadow)] outline-none transition-transform duration-200 ease-out data-[ending-style]:-translate-x-full data-[starting-style]:-translate-x-full motion-reduce:transition-none">
        <div className="flex h-14 shrink-0 items-center justify-between px-4"><Dialog.Title className="text-[14px] font-semibold text-[var(--wb-text)]">Workbot</Dialog.Title><Dialog.Close className={control} aria-label="Close workspace navigation"><X size={16} strokeWidth={1.5} aria-hidden /></Dialog.Close></div>
        <nav aria-label="Workspace" className="px-2">
          <button type="button" className={row} aria-current={page === "home" ? "page" : undefined} onClick={() => navigate("home")}><House size={16} strokeWidth={1.5} aria-hidden />Home</button>
          <button type="button" className={row} disabled={!host.calendar} aria-current={page === "calendar" ? "page" : undefined} onClick={() => navigate("calendar")} title={!host.calendar ? "Calendar is off. An admin can turn it on." : undefined}><CalendarDays size={16} strokeWidth={1.5} aria-hidden />Calendar{!host.calendar && <Lock size={13} aria-label="Off for this workspace" />}</button>
          {host.documents === true && <button type="button" className={row} aria-current={page === "documents" ? "page" : undefined} onClick={() => navigate("documents")}><FileText size={16} strokeWidth={1.5} aria-hidden />Documents</button>}
          {host.computer && <button type="button" className={row} aria-current={page === "computer" ? "page" : undefined} onClick={() => navigate("computer")}><Monitor size={16} strokeWidth={1.5} aria-hidden />Computer</button>}
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

/** The composer stays in the workspace; the conversation shows in an anchored Base UI popover until the person minimizes it. */
export function WorkspaceAssistant({ name, context, includeContext, onIncludeContext, composer, conversation, onDocument, onComputer = null, unavailable, active, reveal = 0, stayOpen = false }: { active: boolean; /** Opens the computer from the conversation; null while it is on screen. */ onComputer?: (() => void) | null; name: string; context: WorkbotViewContext | null; includeContext: boolean; onIncludeContext(value: boolean): void; composer: ReactNode; conversation: ReactNode; onDocument(fileId: string): void; unavailable: boolean; /** Increments when chat navigation should leave the conversation open beside the document. */ reveal?: number; /** Guided navigation keeps the conversation open while a document opens behind it. */ stayOpen?: boolean }) {
  // Shown by default; only the person's own minimize hides it, and coming back to a view keeps that choice.
  const [minimized, setMinimized] = useState(false);
  const open = active && !minimized;
  const surface = useRetainedSurface(open);
  const anchor = useRef<HTMLDivElement>(null);
  // A new request from the conversation shows it again.
  const revealed = useRef(reveal);
  useEffect(() => { if (active && reveal !== revealed.current) { revealed.current = reveal; setMinimized(false); } }, [reveal, active]);
  return <div ref={anchor} className="fixed bottom-3 right-3 z-30 w-[min(26rem,calc(100vw-1.5rem))] sm:bottom-5 sm:right-5" data-workbot-workspace-assistant>
    <Popover.Root open={surface.open} onOpenChange={(next, details) => {
      if (surface.blocked) return;
      // Working in the document behind it never minimizes the conversation; only Hide, the trigger or Escape do.
      if (!next && (details.reason === "outside-press" || details.reason === "focus-out")) {
        details.cancel();
        return;
      }
      setMinimized(!next);
    }}>
      <div className="mb-1 flex min-w-0 items-center justify-end gap-1.5">
        {context && <button type="button" aria-pressed={includeContext} onClick={() => onIncludeContext(!includeContext)} title={includeContext ? "Exclude this view from your next message" : "Include a read-only reference to this view"} className={`min-w-0 truncate rounded-full bg-[var(--wb-surface)] px-2.5 py-1 text-[11px] shadow-[var(--wb-card-shadow)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)] ${includeContext ? "text-[var(--wb-text)]" : "text-[var(--wb-muted)] line-through"}`} data-workbot-view-context data-testid="workbot-view-context">{workbotContextLabel(context)}{includeContext ? " · Read-only context" : ""}{context.kind === "document" && context.unsaved ? " · Unsaved edits excluded" : ""}</button>}
        <Popover.Trigger className="flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-[var(--wb-surface)] px-2.5 text-[11px] text-[var(--wb-text)] shadow-[var(--wb-card-shadow)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]" aria-label={open ? "Hide workspace chat" : "Show workspace chat"}><MessageCircle size={13} strokeWidth={1.5} aria-hidden />{name}</Popover.Trigger>
      </div>
      {composer}
      <Popover.Portal {...surface.portal}>
        <Popover.Positioner anchor={anchor} side="top" align="end" sideOffset={8} collisionPadding={12} className="z-40 max-w-[var(--available-width)]">
          <Popover.Popup initialFocus={false} className="workbot flex h-[min(34rem,var(--available-height))] w-[min(30rem,var(--available-width))] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-[var(--dls-radius,16px)] bg-[var(--wb-surface)] shadow-[var(--wb-panel-shadow)] outline-none" data-workbot-workspace-chat>
            <div className="flex h-10 shrink-0 items-center justify-between px-3"><Popover.Title className="text-[13px] font-medium text-[var(--wb-text)]">{name}</Popover.Title><Popover.Close className={control} aria-label="Hide workspace chat"><X size={15} strokeWidth={1.5} aria-hidden /></Popover.Close></div>
            <WorkspaceNavigationContext.Provider value={fileId => { if (!stayOpen) setMinimized(true); onDocument(fileId); }}>
              <ComputerNavigationContext.Provider value={onComputer ? () => { if (!stayOpen) setMinimized(true); onComputer(); } : null}>
                {unavailable ? <p className="p-4 text-[13px] text-[var(--wb-muted)]" role="status">Chat is unavailable. Open Home to try again.</p> : conversation}
              </ComputerNavigationContext.Provider>
            </WorkspaceNavigationContext.Provider>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  </div>;
}
