"use client";

import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Dialog } from "@base-ui/react/dialog";
import { ArrowLeft, PanelLeft, Plus, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { newChatId, useRemoveWorkbotChat, type WorkbotChats } from "./data";

/**
 * Side chats: next to the person's main chat (one ongoing conversation), side chats keep one topic apart. They share
 * the main chat's memory. Shown only where side chats are on (the workbotSideChats feature).
 */

const CHAT_PARAM = "chat";
const CHAT_ID = /^[a-z0-9]{16,40}$/;

function chatInLocation(): string | null {
  if (typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get(CHAT_PARAM);
  return value && CHAT_ID.test(value) ? value : null;
}

/**
 * The chat on screen, kept in the address (`?chat=<id>` for a side chat), so a reload stays in it and Back returns to
 * the chat before. Always the main chat (null) where side chats are off.
 */
export function useChatLocation(enabled: boolean): [string | null, (chat: string | null) => void] {
  const [chat, setChat] = useState<string | null>(() => (enabled ? chatInLocation() : null));
  useEffect(() => {
    if (!enabled) return;
    const onPop = () => setChat(chatInLocation());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [enabled]);
  const open = useCallback((next: string | null) => {
    const url = new URL(window.location.href);
    if (next) url.searchParams.set(CHAT_PARAM, next);
    else url.searchParams.delete(CHAT_PARAM);
    window.history.pushState(null, "", url);
    setChat(next);
  }, []);
  return [enabled ? chat : null, open];
}

/** "now", "5m", "3h", "2d", or the date: how long ago a chat was last used, as a chat list shows it. */
export function sinceLabel(at: number, now: number = Date.now()) {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** A side chat's name in the list and its header: the name Workbot gave it, or "New side chat" until then. */
export function chatTitle(title: string | undefined) {
  return title?.trim() || "New side chat";
}

const ICON_BUTTON =
  "grid h-8 w-8 shrink-0 place-items-center rounded-full text-[var(--wb-muted)] transition-colors duration-150 hover:bg-[var(--wb-chip)] hover:text-[var(--wb-text)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]";

/** Opens the list of chats, at the start of the header. */
export function ChatsButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} aria-label="Chats" title="Chats" className={`-ml-1.5 ${ICON_BUTTON}`}>
      <PanelLeft size={16} strokeWidth={1.5} aria-hidden />
    </button>
  );
}

/** A side chat's header: back to the main chat, and the chat's name. */
export function SideChatTitle({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <button type="button" onClick={onBack} aria-label="Back to main chat" title="Back to main chat" className={`-ml-1.5 ${ICON_BUTTON}`}>
        <ArrowLeft size={16} strokeWidth={1.5} aria-hidden />
      </button>
      <h1 className="truncate text-[15px] font-semibold leading-5 tracking-[-0.015em] text-[var(--wb-text)]">{title}</h1>
    </div>
  );
}

/** Removes the side chat on screen, after asking (OW-CONFIRM). */
export function RemoveChatButton({ chatId, title, onRemoved }: { chatId: string; title: string; onRemoved: () => void }) {
  const [open, setOpen] = useState(false);
  const remove = useRemoveWorkbotChat();
  return (
    <AlertDialog.Root open={open} onOpenChange={(next) => { setOpen(next); if (!next) remove.reset(); }}>
      <AlertDialog.Trigger aria-label="Remove side chat" title="Remove side chat" className={ICON_BUTTON}>
        <Trash2 size={15} strokeWidth={1.5} aria-hidden />
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-black/20 transition-opacity duration-150 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 motion-reduce:transition-none" />
        <AlertDialog.Popup className="workbot fixed left-1/2 top-1/2 z-50 w-[calc(100%-32px)] max-w-[380px] -translate-x-1/2 -translate-y-1/2 rounded-[18px] bg-[var(--wb-surface)] p-5 shadow-[var(--wb-sheet-shadow)] outline-none">
          <AlertDialog.Title className="text-[15px] font-semibold leading-5 text-[var(--wb-text)]">Remove &ldquo;{title}&rdquo;?</AlertDialog.Title>
          <AlertDialog.Description className="mt-1.5 text-[13px] leading-5 text-[var(--wb-muted)]">
            Its messages and files go with it. This cannot be undone.
          </AlertDialog.Description>
          {remove.error ? <p role="status" className="mt-3 text-[13px] leading-5 text-[var(--wb-danger)]">{remove.error.message}</p> : null}
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Close className="h-8 rounded-full px-3.5 text-[13px] font-medium text-[var(--wb-text)] hover:bg-[var(--wb-chip)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]">
              Cancel
            </AlertDialog.Close>
            <button
              type="button"
              disabled={remove.isPending}
              onClick={() => remove.mutate(chatId, { onSuccess: () => { setOpen(false); onRemoved(); } })}
              className="h-8 rounded-full bg-[var(--wb-danger)] px-3.5 text-[13px] font-medium text-white transition-opacity duration-150 hover:opacity-90 disabled:opacity-60 focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"
            >
              Remove
            </button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

/** Lists with more side chats than this get a filter. */
const FILTER_FROM = 6;

/**
 * The person's chats: the main chat, then their side chats, most recently used first, with "New side chat" next to
 * them (OW-ADD). Picking one opens it.
 */
export function ChatsDrawer(props: {
  open: boolean;
  onClose: () => void;
  /** The chat on screen: null for the main chat. */
  current: string | null;
  chats: WorkbotChats | undefined;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  onOpenChat: (chat: string | null) => void;
}) {
  const [filter, setFilter] = useState("");
  const side = props.chats?.side ?? [];
  const query = filter.trim().toLowerCase();
  const shown = query ? side.filter((chat) => chatTitle(chat.title).toLowerCase().includes(query)) : side;
  const open = (chat: string | null) => {
    props.onOpenChat(chat);
    props.onClose();
  };
  const row = (selected: boolean) =>
    `flex h-11 w-full items-center gap-3 rounded-[10px] px-3 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)] ${selected ? "bg-[var(--wb-chip)]" : "hover:bg-[var(--wb-chip)]"}`;
  return (
    <Dialog.Root open={props.open} onOpenChange={(next) => { if (!next) props.onClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/10 transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 motion-reduce:transition-none" />
        <Dialog.Popup className="workbot fixed inset-y-0 left-0 z-50 flex w-full max-w-[340px] flex-col bg-[var(--wb-surface)] shadow-[var(--wb-sheet-shadow)] outline-none transition-transform duration-200 ease-out data-[ending-style]:-translate-x-full data-[starting-style]:-translate-x-full motion-reduce:transition-none">
          <div className="flex h-13 shrink-0 items-center justify-between pl-5 pr-3">
            <Dialog.Title className="text-[15px] font-semibold leading-[18px] tracking-[-0.01em] text-[var(--wb-text)]">Chats</Dialog.Title>
            <Dialog.Close aria-label="Close" className={ICON_BUTTON}>
              <X size={14} strokeWidth={2} aria-hidden />
            </Dialog.Close>
          </div>
          <nav aria-label="Chats" className="flex min-h-0 flex-1 flex-col px-2 pb-3">
            <button type="button" onClick={() => open(null)} aria-current={props.current === null ? "page" : undefined} className={row(props.current === null)}>
              <span className="min-w-0 flex-1 truncate text-[14px] font-medium leading-5 text-[var(--wb-text)]">Main chat</span>
              {props.chats?.main ? <span className="shrink-0 text-[12px] leading-4 text-[var(--wb-muted)]">{sinceLabel(props.chats.main.updatedAt)}</span> : null}
            </button>
            <div className="mt-3 flex h-9 shrink-0 items-center justify-between pl-3 pr-1">
              <h2 className="text-[12px] font-medium leading-4 text-[var(--wb-muted)]">Side chats</h2>
              <button type="button" onClick={() => open(newChatId())} aria-label="New side chat" title="New side chat" className={ICON_BUTTON}>
                <Plus size={16} strokeWidth={1.5} aria-hidden />
              </button>
            </div>
            {side.length >= FILTER_FROM ? (
              <input
                type="search"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter by name"
                aria-label="Filter side chats by name"
                className="mx-1 mb-1.5 h-8 shrink-0 rounded-full bg-[var(--wb-chip)] px-3.5 text-[13px] text-[var(--wb-text)] placeholder:text-[var(--wb-muted)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"
              />
            ) : null}
            <div className="min-h-0 flex-1 overflow-y-auto">
              {props.loading && !props.chats ? (
                <ul aria-busy="true" className="flex flex-col">
                  {[0, 1, 2].map((index) => (
                    <li key={index} className="flex h-11 items-center px-3"><span className="h-3 w-40 rounded bg-[var(--wb-chip)]" /></li>
                  ))}
                </ul>
              ) : props.failed && !props.chats ? (
                <p className="px-3 py-2 text-[13px] leading-5 text-[var(--wb-muted)]">
                  Couldn&apos;t load your side chats.{" "}
                  <button type="button" onClick={props.onRetry} className="font-medium text-[var(--wb-text)] underline underline-offset-2">Try again</button>
                </p>
              ) : side.length === 0 ? (
                <p className="px-3 py-2 text-[13px] leading-5 text-[var(--wb-muted)]">No side chats yet.</p>
              ) : shown.length === 0 ? (
                <p className="px-3 py-2 text-[13px] leading-5 text-[var(--wb-muted)]">No side chat has that name.</p>
              ) : (
                <ul className="flex flex-col">
                  {shown.map((chat) => (
                    <li key={chat.id}>
                      <button type="button" onClick={() => open(chat.id)} aria-current={props.current === chat.id ? "page" : undefined} className={row(props.current === chat.id)}>
                        <span className={`min-w-0 flex-1 truncate text-[14px] leading-5 ${chat.title.trim() ? "text-[var(--wb-text)]" : "text-[var(--wb-muted)]"}`}>{chatTitle(chat.title)}</span>
                        <span className="shrink-0 text-[12px] leading-4 text-[var(--wb-muted)]">{sinceLabel(chat.updatedAt)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </nav>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
