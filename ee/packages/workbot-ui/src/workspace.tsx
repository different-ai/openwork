"use client";

import { Dialog } from "@base-ui/react/dialog";
import { useQuery } from "@tanstack/react-query";
import { googleDriveFileId, workbotContextLabel, type WorkbotViewContext } from "@openwork/types/workbot-context";
import { CalendarDays, FileText, Globe, House, Lock, MessageCircle, Monitor, PanelLeft, X } from "lucide-react";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { computerTabLabel, workbotHost, useRetainedSurface } from "./host";
import { DOCUMENTS_LIST_GC_MS, ItemIcon } from "@openwork/documents/react";
import { usePrefetchWorkbotDocuments, useWorkbotDocumentsSource } from "./documents";

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
  const host = workbotHost();
  if (!open || !host.guidedNavigation) return null;
  const label = computerTabLabel(host);
  return <div className="workbot-row-enter flex min-h-7 items-center pt-1" data-workbot-computer-offer>
    <button type="button" onClick={open} title={label === "Browser" ? "Open Workbot's browser" : "Open Workbot's computer"}
      className="flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-full px-2.5 text-[13px] font-medium leading-4 text-[var(--wb-text)] transition-colors duration-150 hover:bg-[var(--wb-chip)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]">
      <ComputerTabIcon label={label} size={14} strokeWidth={1.75} /><span className="truncate">Open {label}</span>
    </button>
  </div>;
}

/** The computer page's icon: a globe where it is only the browser, a monitor where it is the whole computer. */
export function ComputerTabIcon({ label, size = 16, strokeWidth = 1.5 }: { label: "Browser" | "Computer"; size?: number; strokeWidth?: number }) {
  const Icon = label === "Browser" ? Globe : Monitor;
  return <Icon size={size} strokeWidth={strokeWidth} aria-hidden className="shrink-0 text-[var(--wb-muted)]" />;
}

/** One navigation drawer, backed by the signed-in member's Drive metadata. */
export function WorkspaceMenu({ page, onPage, onDocument, onChats, drafts }: { page: WorkspacePage; onPage(page: WorkspacePage): void; onDocument(fileId: string): void; onChats?: () => void; drafts: boolean }) {
  const host = workbotHost();
  const [open, setOpen] = useState(false);
  const surface = useRetainedSurface(open);
  // The same sources as Documents (Google Drive, and OneDrive where it is connected), so both list the same files.
  const documents = useWorkbotDocumentsSource();
  const recent = useQuery({
    queryKey: ["documents", ...documents.scope, documents.provider.id, "workspace-recent"],
    queryFn: ({ signal }) => documents.provider.list({ view: "recent", folderId: "root", query: "", signal }),
    // Opening the drawer again within half a minute shows the same list at once; it refreshes after that.
    enabled: surface.open && documents.ready, retry: false, staleTime: 30_000, gcTime: DOCUMENTS_LIST_GC_MS,
  });
  const prefetchDocuments = usePrefetchWorkbotDocuments();
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
          {host.documents === true && <button type="button" className={row} aria-current={page === "documents" ? "page" : undefined} onPointerEnter={page === "documents" ? undefined : prefetchDocuments} onFocus={page === "documents" ? undefined : prefetchDocuments} onClick={() => navigate("documents")}><FileText size={16} strokeWidth={1.5} aria-hidden />Documents</button>}
          {onChats && <button type="button" className={row} disabled={drafts} title={drafts ? "Save or close document drafts before switching chats." : undefined} onClick={() => { setOpen(false); onChats(); }}><MessageCircle size={16} strokeWidth={1.5} aria-hidden />Chats{drafts && <Lock size={13} aria-label="Save or close document drafts first" />}</button>}
          {drafts && onChats && <p className="px-3 py-1 text-[12px] text-[var(--wb-muted)]">Save or close drafts to switch chats.</p>}
        </nav>
        {host.documents === true && <div className="mt-5 min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          <h2 className="px-3 pb-2 text-[12px] font-medium text-[var(--wb-muted)]">Recent documents</h2>
          {recent.isError ? <div className="px-3 text-[12px] text-[var(--wb-muted)]" role="status">Couldn't read recent documents. <button type="button" className="underline" onClick={() => void recent.refetch()}>Try again</button></div>
            : recent.isPending ? <div className="flex flex-col gap-3 px-3" aria-label="Loading recent documents" aria-busy="true">{[0, 1, 2].map(id => <span key={id} className="h-5 rounded bg-[var(--wb-chip)]" />)}</div>
            : recent.data.items.filter(item => item.kind === "file").slice(0, 12).map(item => <button type="button" key={item.id} aria-label={`Open ${item.name}`} className={row} onClick={() => { onDocument(item.id); setOpen(false); }}><ItemIcon item={item} size={16} /><span className="truncate">{item.name}</span></button>)}
          {recent.isSuccess && recent.data.items.every(item => item.kind !== "file") && <p className="px-3 text-[12px] text-[var(--wb-muted)]">No recent documents.</p>}
        </div>}
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}

/** The chip names the exact snapshot attached to this message, including draft state. */
export function SentContext({ context }: { context?: WorkbotViewContext }) {
  if (!context) return null;
  return <p className="mb-1 truncate text-right text-[11px] text-[var(--wb-muted)]" title={workbotContextLabel(context)} data-workbot-sent-context>{context.kind === "browser" ? "Browser" : context.kind === "calendar" ? "Calendar" : "Documents"} · {workbotContextLabel(context)}{context.kind === "document" && context.unsaved ? " · Unsaved edits excluded" : ""}</p>;
}

/** True while the window is at least `minWidth` pixels wide; follows resizes. */
export function useWideScreen(minWidth = 1024) {
  const query = `(min-width: ${minWidth}px)`;
  const [wide, setWide] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const sync = () => setWide(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, [query]);
  return wide;
}

/**
 * Browser-heavy work: the conversation docked beside Workbot's live browser (or computer) instead of floating over
 * it, so the person can watch the page and direct Workbot at the same time. The open tab is shared with each message
 * unless they turn it off for this tab; the chip names it. On narrow windows the chat stays on Home.
 * Document offers follow the page's own rules (workspace assistant and Documents on), so nothing is offered here
 * that the page itself can't open.
 */
export function DockedChat({ name, context, includeContext, onIncludeContext, composer, conversation, unavailable }: { name: string; context: WorkbotViewContext | null; includeContext: boolean; onIncludeContext(value: boolean): void; composer: ReactNode; conversation: ReactNode; unavailable: boolean }) {
  return <aside aria-label={`Chat with ${name}`} className="workbot flex min-h-0 w-[min(400px,36vw)] shrink-0 flex-col border-l border-[var(--wb-hairline)] bg-[var(--wb-bg)]" data-workbot-docked-chat data-testid="workbot-docked-chat">
    <div className="flex h-12 shrink-0 items-center justify-between gap-2 px-4">
      <h2 className="truncate text-[13px] font-semibold text-[var(--wb-text)]">{name}</h2>
      {context && <button type="button" aria-pressed={includeContext} onClick={() => onIncludeContext(!includeContext)}
        title={includeContext ? `Your next message tells ${name} which tab you're on. Click to leave it out.` : `Tell ${name} which tab you're on`}
        className={`min-w-0 max-w-[60%] truncate rounded-full px-2.5 py-1 text-[11px] transition-colors duration-150 hover:bg-[var(--wb-chip)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)] ${includeContext ? "bg-[var(--wb-chip)] text-[var(--wb-text)]" : "text-[var(--wb-muted)] line-through"}`}
        data-testid="workbot-docked-context">{workbotContextLabel(context)}{includeContext ? " · This tab" : ""}</button>}
    </div>
    {unavailable ? <p className="flex-1 p-4 text-[13px] text-[var(--wb-muted)]" role="status">Chat is unavailable. Open Home to try again.</p>
      : <div className="flex min-h-0 flex-1 flex-col">{conversation}</div>}
    <div className="shrink-0 px-3 pb-3 pt-2">{composer}</div>
  </aside>;
}
