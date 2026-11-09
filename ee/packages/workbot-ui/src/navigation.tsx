"use client";

import { Dialog } from "@base-ui/react/dialog";
import { CalendarDays, FileText, FolderOpen, Lock, MessageCircle, PanelLeft, Plus, Search, Shapes, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { AccountAvatar } from "./account-menu";
import { chatTitle, sinceLabel } from "./chats";
import { newChatId, type WorkbotChats } from "./data";
import { useRetainedSurface, workbotHost } from "./host";
import { OpenWorkMark } from "./mark";
import { useWorkbotViewport } from "./viewport";
import type { WorkspacePage } from "./workspace";

/** Shared navigation reads no data: the screen owns the chat query and every destination. */
export type NavigationProps = {
  page: WorkspacePage;
  onPage(page: WorkspacePage): void;
  currentChat: string | null;
  chats: WorkbotChats | undefined;
  loading: boolean;
  failed: boolean;
  onRetry(): void;
  /** Read the list again when a phone drawer opens; cached chats stay visible while refreshing. */
  onOpen?(): void;
  /** Omit where side chats are unavailable. New chats use the same callback. */
  onOpenChat?: (chat: string | null) => void;
  drafts: boolean;
  onFiles?: () => void;
  /** Task progress is not a destination: it lives in the status under Workbot's name and the sheet behind it. */
  onApps?: () => void;
  /** The real search trigger/palette. Mount only one navigation variant at a time. */
  search?: ReactNode;
  /** Optional callback alternative when the palette is mounted separately by the screen. */
  onSearch?: () => void;
  /** An account trigger, not a second menu wrapped around an avatar. */
  account?: ReactNode;
};

const control = "grid size-10 shrink-0 place-items-center rounded-lg text-[var(--wb-muted)] transition-colors duration-150 hover:bg-[var(--wb-chip)] hover:text-[var(--wb-text)] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]";
const row = "flex min-h-[var(--wb-nav-row-height,40px)] w-full items-center gap-2.5 rounded-lg px-3 text-left text-[length:var(--wb-nav-font-size,13px)] text-[var(--wb-text)] transition-colors duration-150 hover:bg-[var(--wb-chip)] aria-[current=page]:bg-[var(--wb-chip)] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]";
const draftReason = "Save or close document drafts before switching chats.";

type Destination = { label: string; icon: typeof MessageCircle; selected?: boolean; disabled?: boolean; onClick(): void };

function destinations(props: NavigationProps, rail = false): Destination[] {
  const host = workbotHost();
  return [
    // The desktop rail goes back to the chat you were in; the list beside it picks Main chat or a side chat.
    rail ? { label: "Chats", icon: MessageCircle, selected: props.page === "home", onClick: () => props.onPage("home") } : {
      label: "Main chat", icon: MessageCircle, selected: props.page === "home" && props.currentChat === null,
      disabled: props.currentChat !== null && (props.drafts || !props.onOpenChat),
      onClick: () => {
        if (props.currentChat !== null) {
          if (props.drafts || !props.onOpenChat) return;
          props.onOpenChat(null);
        }
        props.onPage("home");
      },
    },
    ...(host.documents === true ? [{ label: "Documents", icon: FileText, selected: props.page === "documents", onClick: () => props.onPage("documents") }] : []),
    ...(host.calendar === true ? [{ label: "Calendar", icon: CalendarDays, selected: props.page === "calendar", onClick: () => props.onPage("calendar") }] : []),
    ...(props.onFiles ? [{ label: "Files", icon: FolderOpen, onClick: props.onFiles }] : []),
    ...(props.onApps ? [{ label: "Apps", icon: Shapes, onClick: props.onApps }] : []),
  ];
}

function NewChatButton({ props, onDone, compact = false }: { props: NavigationProps; onDone?: () => void; compact?: boolean }) {
  if (!props.onOpenChat) return null;
  return <button type="button" disabled={props.drafts} aria-label="New side chat" title={props.drafts ? draftReason : "New side chat"} className={compact ? control : row} onClick={() => {
    if (props.drafts || !props.onOpenChat) return;
    props.onOpenChat(newChatId());
    props.onPage("home");
    onDone?.();
  }}><Plus size={16} strokeWidth={1.5} aria-hidden />{!compact && "New side chat"}</button>;
}

/** The local filter lives at the top of desktop navigation or in the phone's bottom toolbar. */
function ChatFilter({ value, onChange }: { value: string; onChange(value: string): void }) {
  return <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-full bg-[var(--wb-chip)] px-3 text-[var(--wb-muted)] focus-within:shadow-[var(--wb-focus)]">
    <Search size={15} strokeWidth={1.5} aria-hidden className="shrink-0" />
    <input type="search" aria-label="Search side chats" placeholder="Find a chat" value={value} onChange={event => onChange(event.target.value)} className="min-w-0 flex-1 bg-transparent text-[length:var(--wb-nav-font-size,13px)] text-[var(--wb-text)] placeholder:text-[var(--wb-muted)] focus:outline-none" />
  </label>;
}

function SideChats({ props, filter, onDone }: { props: NavigationProps; filter: string; onDone?: () => void }) {
  if (!props.onOpenChat) return null;
  const query = filter.trim().toLocaleLowerCase();
  const side = [...(props.chats?.side ?? [])].sort((left, right) => right.updatedAt - left.updatedAt);
  const shown = query ? side.filter(chat => chatTitle(chat.title).toLocaleLowerCase().includes(query)) : side;
  return <section aria-label="Side chats" className="flex min-h-0 flex-1 flex-col">
    <div className="flex min-h-10 shrink-0 items-center justify-between pl-3 pr-1">
      <h2 className="text-[12px] font-medium text-[var(--wb-muted)]">Side chats</h2>
      <NewChatButton props={props} onDone={onDone} compact />
    </div>
    {props.drafts && <p className="flex items-start gap-1.5 px-3 pb-2 text-[12px] leading-4 text-[var(--wb-muted)]"><Lock size={13} strokeWidth={1.5} aria-hidden className="mt-0.5 shrink-0" />Save or close drafts to switch chats.</p>}
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      {props.loading && !props.chats ? <ul aria-label="Loading side chats" aria-busy="true">{[0, 1, 2].map(index => <li key={index} className="flex h-10 items-center px-3"><span className="h-3 w-36 rounded bg-[var(--wb-chip)]" /></li>)}</ul>
        : props.failed && !props.chats ? <p role="status" className="px-3 py-2 text-[13px] leading-5 text-[var(--wb-muted)]">Couldn&apos;t load your side chats. <Retry onRetry={props.onRetry} /></p>
        : side.length === 0 ? <button type="button" className={`${row} text-[var(--wb-muted)]`} disabled={props.drafts} title={props.drafts ? draftReason : undefined} onClick={() => {
          if (props.drafts || !props.onOpenChat) return;
          props.onOpenChat(newChatId()); props.onPage("home"); onDone?.();
        }}>Start a side chat</button>
        : shown.length === 0 ? <p role="status" className="px-3 py-2 text-[13px] text-[var(--wb-muted)]">No matching side chats.</p>
        : <ul>{shown.map(chat => <li key={chat.id}><button type="button" className={row} disabled={props.drafts && props.currentChat !== chat.id} title={props.drafts && props.currentChat !== chat.id ? draftReason : chatTitle(chat.title)} aria-current={props.page === "home" && props.currentChat === chat.id ? "page" : undefined} onClick={() => {
          if (props.drafts && props.currentChat !== chat.id) return;
          props.onOpenChat?.(chat.id); props.onPage("home"); onDone?.();
        }}><span className="min-w-0 flex-1 truncate">{chatTitle(chat.title)}</span><span className="shrink-0 text-[12px] tabular-nums text-[var(--wb-muted)]">{sinceLabel(chat.updatedAt)}</span></button></li>)}</ul>}
      {props.failed && props.chats && <p role="status" className="px-3 py-2 text-[12px] leading-4 text-[var(--wb-muted)]">Couldn&apos;t refresh side chats. <Retry onRetry={props.onRetry} /></p>}
    </div>
  </section>;
}

function Retry({ onRetry }: { onRetry(): void }) {
  return <button type="button" onClick={onRetry} className="rounded font-medium text-[var(--wb-text)] underline underline-offset-2 focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]">Try again</button>;
}

function Account({ account }: { account?: ReactNode }) {
  return account ?? <AccountAvatar userName={workbotHost().user?.name ?? null} />;
}

/**
 * Wide-screen icon rail, and beside it the chat list only while a chat is on screen: Documents and Calendar bring their
 * own navigation, so each view has one sidebar. No invented channels or Computer entry.
 */
export function DesktopNavigation(props: NavigationProps) {
  const [filter, setFilter] = useState("");
  const chatView = props.page === "home";
  return <aside className="workbot flex min-h-0 shrink-0 border-r border-[var(--wb-hairline)] text-[var(--wb-text)]" aria-label="Workbot navigation" data-workbot-desktop-navigation>
    <div className={`flex w-16 shrink-0 flex-col items-center gap-2 bg-[var(--wb-surface)] py-3 ${chatView ? "border-r border-[var(--wb-hairline)]" : ""}`}>
      <span aria-hidden className="mb-3 grid size-9 place-items-center"><OpenWorkMark width={20} height={25} /></span>
      <nav aria-label="Workspace" className="flex flex-col items-center gap-2">{destinations(props, true).map(({ label, icon: Icon, selected, disabled, onClick }) => <button key={label} type="button" onClick={onClick} disabled={disabled} title={disabled ? draftReason : label} aria-label={label} aria-current={selected ? "page" : undefined} className={`${control} aria-[current=page]:bg-[var(--wb-chip)] aria-[current=page]:text-[var(--wb-text)]`}><Icon size={18} strokeWidth={1.5} aria-hidden /></button>)}</nav>
      <div className="mt-auto flex flex-col items-center gap-3 pt-4">
        {props.search ?? (props.onSearch && <button type="button" onClick={props.onSearch} className={control} title="Search messages" aria-label="Search messages"><Search size={18} strokeWidth={1.5} aria-hidden /></button>)}
        <Account account={props.account} />
      </div>
    </div>
    {chatView && <div className="flex min-h-0 w-[260px] flex-col bg-[var(--wb-bg)] px-2 pb-3">
      <div className="flex h-16 shrink-0 items-center px-1"><ChatFilter value={filter} onChange={setFilter} /></div>
      <nav aria-label="Chats" className="mb-4">{destinations(props).slice(0, 1).map(({ label, icon: Icon, selected, disabled, onClick }) => <button key={label} type="button" disabled={disabled} onClick={onClick} title={disabled ? draftReason : undefined} className={row} aria-current={selected ? "page" : undefined}><Icon size={16} strokeWidth={1.5} aria-hidden /><span className="flex-1">{label}</span>{props.chats?.main && <span className="text-[12px] tabular-nums text-[var(--wb-muted)]">{sinceLabel(props.chats.main.updatedAt)}</span>}</button>)}</nav>
      <SideChats props={props} filter={filter} />
    </div>}
  </aside>;
}

/** Base UI owns focus trapping, Escape, outside press and focus return. */
export function MobileNavigation(props: NavigationProps) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const surface = useRetainedSurface(open);
  const viewport = useWorkbotViewport(surface.open);
  const close = () => setOpen(false);
  return <Dialog.Root open={surface.open} onOpenChange={next => { if (!surface.blocked) { if (next && !open) props.onOpen?.(); setOpen(next); } }}>
    <Dialog.Trigger className={control} aria-label="Open workspace navigation" title="Navigate"><PanelLeft size={16} strokeWidth={1.5} aria-hidden /></Dialog.Trigger>
    <Dialog.Portal {...surface.portal}>
      <Dialog.Backdrop className="workbot fixed inset-0 z-40 bg-[var(--wb-ink)]/10 transition-opacity duration-150 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 motion-reduce:transition-none" />
      <Dialog.Popup ref={viewport} className="workbot fixed left-0 top-[var(--wb-viewport-top,0px)] z-50 flex h-[var(--wb-viewport-height,100dvh)] w-[calc(100vw-48px)] max-w-[340px] flex-col bg-[var(--wb-bg)] pb-[env(safe-area-inset-bottom)] text-[var(--wb-text)] shadow-[var(--wb-sheet-shadow)] outline-none workbot-sheet-motion transition-transform [--wb-nav-font-size:14px] [--wb-nav-row-height:44px] data-[ending-style]:-translate-x-full data-[starting-style]:-translate-x-full motion-reduce:transition-none" data-workbot-mobile-navigation>
        <div className="flex h-14 shrink-0 items-center justify-between gap-2 pl-4 pr-3">
          <Dialog.Title className="sr-only">Menu</Dialog.Title>
          <Account account={props.account} />
          <span className="flex-1" />
          {props.search ?? (props.onSearch && <button type="button" className={control} onClick={() => { close(); props.onSearch?.(); }} title="Search messages" aria-label="Search messages"><Search size={16} strokeWidth={1.5} aria-hidden /></button>)}
          <Dialog.Close className={control} aria-label="Close workspace navigation"><X size={16} strokeWidth={1.5} aria-hidden /></Dialog.Close>
        </div>
        <nav aria-label="Go to" className="max-h-[45dvh] shrink-0 overflow-y-auto px-2 pb-3">{destinations(props).map(({ label, icon: Icon, selected, disabled, onClick }) => <button key={label} type="button" onClick={() => { onClick(); close(); }} disabled={disabled} title={disabled ? draftReason : undefined} aria-current={selected ? "page" : undefined} className={row}><Icon size={16} strokeWidth={1.5} aria-hidden />{label}</button>)}</nav>
        <div className="flex min-h-0 flex-1 flex-col px-2"><SideChats props={props} filter={filter} onDone={close} /></div>
        <div className="mt-2 flex shrink-0 items-center gap-2 border-t border-[var(--wb-hairline)] px-3 py-3">
          <ChatFilter value={filter} onChange={setFilter} />
          <NewChatButton props={props} onDone={close} compact />
        </div>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}
