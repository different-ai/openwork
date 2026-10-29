"use client";

import { Autocomplete } from "@base-ui/react/autocomplete";
import { Dialog } from "@base-ui/react/dialog";
import {
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleDashed,
  FileText,
  House,
  LayoutDashboard,
  ListChecks,
  Lock,
  MessageCircle,
  MessagesSquare,
  Monitor,
  PenLine,
  Plug,
  Plus,
  RotateCw,
  Search,
  Square,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { chatTitle, sinceLabel } from "./chats";
import {
  highlightRuns,
  loadPaletteRecents,
  matchIndexes,
  rankPaletteItems,
  recordPaletteRecent,
  type RankedGroup,
  type Rankable,
} from "./command-palette-search";
import { newChatId, useStopWorkbotTask, type WorkbotChats, type WorkbotTask } from "./data";
import { useRetainedSurface } from "./host";

/**
 * Workbot's command palette: Cmd+K / Ctrl+K from anywhere, or the search button in
 * the header. Every entry is something Workbot already does from a visible control (DESIGN S6): switch chats, start a
 * side chat, stop a reply or a background task, open a page or the files, and the Den pages the header links to.
 * Base UI's Dialog and Autocomplete own focus, the combobox/listbox roles and arrow-key navigation (DESIGN P5).
 */

export type WorkbotPaletteTab = "home" | "calendar" | "documents" | "computer";
type Page = "root" | "chats" | "tasks";

type Entry = Rankable & {
  icon: ReactNode;
  /** Quiet trailing text: when a chat was last used, how long a task has run. */
  meta?: string;
  /** Why this can't run right now, shown on the row (DESIGN P4). The row stays visible but disabled. */
  locked?: string;
  /** Opens a nested page (Tab or Enter) instead of running. */
  page?: Exclude<Page, "root">;
  /** What Enter does, as the highlighted row says it. */
  verb: string;
  run?: () => void;
  /** Keeps the palette open after running (Try again). */
  stayOpen?: boolean;
  /** Runs once the palette has closed, for actions that move focus (Write a message, Show a task). */
  thenFocus?: () => void;
  /** Cmd/Ctrl+Enter. */
  alt?: { verb: string; run: () => void };
};

export type WorkbotCommandPaletteProps = {
  name: string;
  tab: WorkbotPaletteTab;
  tabs: readonly WorkbotPaletteTab[];
  onTab: (tab: WorkbotPaletteTab) => void;
  /** Side chats, where they are on. */
  chats: {
    current: string | null;
    list: WorkbotChats | undefined;
    loading: boolean;
    failed: boolean;
    retry: () => void;
    open: (chat: string | null) => void;
    /** Unsaved document drafts keep the person in this chat. */
    locked: boolean;
  } | null;
  busy: boolean;
  onStop: (() => void) | null;
  onOpenFiles: (() => void) | null;
  tasks: readonly WorkbotTask[];
  onFocusComposer: (() => void) | null;
  onShowTask: (taskId: string) => void;
  homeHref: string;
  connectionsHref: string | null;
};

const TAB_LABEL: Record<WorkbotPaletteTab, string> = { home: "Home", calendar: "Calendar", documents: "Documents", computer: "Computer" };
const TAB_ICON: Record<WorkbotPaletteTab, ReactNode> = {
  home: <House size={16} strokeWidth={1.5} aria-hidden />,
  calendar: <CalendarDays size={16} strokeWidth={1.5} aria-hidden />,
  documents: <FileText size={16} strokeWidth={1.5} aria-hidden />,
  computer: <Monitor size={16} strokeWidth={1.5} aria-hidden />,
};
const TAB_KEYWORDS: Record<WorkbotPaletteTab, string> = {
  home: "chat conversation main start",
  calendar: "week meetings schedule automations",
  documents: "drive files docs sheets",
  computer: "browser desktop screen",
};

function isMac() {
  return typeof navigator !== "undefined" && /mac|iphone|ipad|ipod/i.test(navigator.platform);
}

const running = (task: WorkbotTask) => task.status === "queued" || task.status === "working" || task.status === "paused";

function taskState(task: WorkbotTask) {
  if (task.status === "queued") return "Waiting to start";
  if (task.status === "paused") return "Picking it back up";
  if (task.status === "working") return task.update ?? "Working on it";
  return task.status === "done" ? "Done" : task.status === "failed" ? "Couldn't finish" : "Stopped";
}

function taskIcon(task: WorkbotTask) {
  if (running(task)) return <CircleDashed size={16} strokeWidth={1.5} aria-hidden className="motion-safe:animate-[spin_3s_linear_infinite]" />;
  if (task.status === "done") return <Check size={16} strokeWidth={1.5} aria-hidden />;
  if (task.status === "failed") return <CircleAlert size={16} strokeWidth={1.5} aria-hidden className="text-[var(--wb-danger)]" />;
  return <Square size={14} strokeWidth={1.5} aria-hidden />;
}

function chatHref(chat: string | null) {
  const url = new URL(window.location.href);
  if (chat) url.searchParams.set("chat", chat);
  else url.searchParams.delete("chat");
  return url.toString();
}

const openInNewTab = (href: string) => { window.open(href, "_blank", "noopener,noreferrer"); };

function Kbd({ children, label }: { children: ReactNode; label?: string }) {
  return <kbd aria-label={label} className="inline-grid h-5 min-w-5 place-items-center rounded-[5px] bg-[var(--wb-chip)] px-1 font-sans text-[11px] font-medium leading-none text-[var(--wb-muted)]">{children}</kbd>;
}

function Highlighted({ text, query }: { text: string; query: string }) {
  const marked = matchIndexes(query, text);
  if (marked.size === 0) return <>{text}</>;
  return <>{highlightRuns(text, marked).map((run, index) => run.match
    ? <mark key={index} className="bg-transparent font-semibold text-[var(--wb-text)]">{run.text}</mark>
    : <span key={index}>{run.text}</span>)}</>;
}

/** Where the Chats group will be, while it loads: the label and three rows of the same height. */
function ChatsSkeleton() {
  return (
    <div className="pt-1" aria-hidden data-workbot-palette-loading>
      <p className="px-2.5 pb-1 pt-2 text-[12px] font-medium text-[var(--wb-muted)]">Chats</p>
      {[44, 32, 38].map((width) => (
        <div key={width} className="flex h-10 items-center gap-2.5 px-2.5">
          <span className="size-4 rounded-full bg-[var(--wb-chip)]" />
          <span className="h-3 rounded bg-[var(--wb-chip)]" style={{ width: `${width}%` }} />
        </div>
      ))}
    </div>
  );
}

const NO_CHATS: WorkbotChats["side"] = [];

const ICON_BUTTON =
  "grid h-8 w-8 shrink-0 place-items-center rounded-full text-[var(--wb-muted)] transition-colors duration-150 hover:bg-[var(--wb-chip)] hover:text-[var(--wb-text)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]";

export function WorkbotCommandPalette(props: WorkbotCommandPaletteProps) {
  const mac = useMemo(isMac, []);
  const mod = mac ? "⌘" : "Ctrl";
  const [open, setOpen] = useState(false);
  const surface = useRetainedSurface(open);
  const [page, setPage] = useState<Page>("root");
  const [query, setQuery] = useState("");
  const [recents, setRecents] = useState<string[]>(loadPaletteRecents);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  /** Where focus goes back to when the palette was opened from the keyboard (the composer, a document). */
  const returnTo = useRef<HTMLElement | null>(null);
  /** An action's own focus move, run once the palette has closed. */
  const pendingFocus = useRef<(() => void) | null>(null);
  const stopTask = useStopWorkbotTask();
  const blocked = surface.blocked;

  const close = useCallback((thenFocus?: () => void) => {
    pendingFocus.current = thenFocus ?? null;
    setOpen(false);
  }, []);
  const flushFocus = () => {
    const next = pendingFocus.current;
    pendingFocus.current = null;
    next?.();
  };
  // A page change can unmount the header mid-close; the focus move still happens.
  useEffect(() => () => {
    const next = pendingFocus.current;
    pendingFocus.current = null;
    if (next) window.setTimeout(next, 0);
  }, []);

  useEffect(() => {
    if (!open) { setPage("root"); setQuery(""); setHighlightedId(null); }
    else setRecents(loadPaletteRecents());
  }, [open]);

  // A new search or page starts at the top, where the best match is, after the list's own scroll-into-view settles.
  useEffect(() => {
    if (!open) return;
    let frame = window.requestAnimationFrame(() => { frame = window.requestAnimationFrame(() => { if (scroller.current) scroller.current.scrollTop = 0; }); });
    return () => window.cancelAnimationFrame(frame);
  }, [open, page, query]);

  // Cmd+K on macOS, Ctrl+K elsewhere, from anywhere on the page, including the composer. Pressed again, it closes.
  useEffect(() => {
    if (blocked) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.isComposing || event.altKey || event.shiftKey || event.key.toLowerCase() !== "k") return;
      if (!(mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)) return;
      event.preventDefault();
      setOpen((current) => {
        if (!current) returnTo.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
        return !current;
      });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [blocked, mac]);

  const { chats, tasks } = props;
  const sideChats = chats?.list?.side ?? NO_CHATS;
  const runningTasks = tasks.filter(running);

  const chatEntries = useMemo<Entry[]>(() => {
    // Until the list arrives the Chats group is a skeleton, so rows never jump in under the pointer.
    if (!chats || !chats.list) return [];
    const lock = chats.locked ? "Save or close document drafts first" : undefined;
    const entry = (id: string | null, title: string, updatedAt: number | undefined, preview: boolean): Entry => ({
      id: `chat:${id ?? "main"}`,
      group: "chats",
      title,
      detail: chats.current === id ? "Open now" : lock,
      meta: updatedAt ? sinceLabel(updatedAt) : undefined,
      keywords: id ? "side chat conversation" : "main chat conversation home",
      preview,
      icon: lock && chats.current !== id ? <Lock size={14} strokeWidth={1.5} aria-hidden /> : <MessageCircle size={16} strokeWidth={1.5} aria-hidden />,
      locked: chats.current === id ? "Open now" : lock,
      verb: "Open",
      run: () => chats.open(id),
      thenFocus: props.onFocusComposer ?? undefined,
      alt: { verb: "New tab", run: () => openInNewTab(chatHref(id)) },
    });
    return [
      entry(null, "Main chat", chats.list?.main?.updatedAt, chats.current !== null),
      ...sideChats.map((chat, index) => entry(chat.id, chatTitle(chat.title), chat.updatedAt, index < 4 && chat.id !== chats.current)),
    ];
  }, [chats, sideChats, props.onFocusComposer]);

  const taskEntries = useMemo<Entry[]>(() => [...tasks].sort((a, b) => Number(running(b)) - Number(running(a)) || (b.startedAt ?? 0) - (a.startedAt ?? 0)).map((task) => ({
    id: `task:${task.id}`,
    group: "tasks",
    title: task.title,
    detail: taskState(task),
    meta: task.startedAt ? sinceLabel(task.startedAt) : undefined,
    keywords: `background task job ${task.status}`,
    preview: running(task),
    icon: taskIcon(task),
    verb: "Show",
    run: () => { if (props.tab !== "home") props.onTab("home"); },
    thenFocus: () => props.onShowTask(task.id),
    alt: running(task) ? { verb: "Stop", run: () => stopTask.mutate(task.id) } : undefined,
  })), [tasks, props, stopTask]);

  const rootEntries = useMemo<Entry[]>(() => {
    const entries: Entry[] = [];
    if (props.onFocusComposer) entries.push({ id: "action:write", group: "actions", title: `Message ${props.name}`, keywords: "write type ask compose focus", icon: <PenLine size={16} strokeWidth={1.5} aria-hidden />, verb: "Write", run: () => { if (props.tab !== "home") props.onTab("home"); }, thenFocus: props.onFocusComposer });
    if (props.busy && props.onStop) entries.push({ id: "action:stop", group: "actions", title: "Stop the reply", detail: `${props.name} is answering`, keywords: "cancel halt interrupt", icon: <Square size={14} strokeWidth={1.5} aria-hidden />, verb: "Stop", run: props.onStop });
    if (chats) {
      const lock = chats.locked ? "Save or close document drafts first" : undefined;
      entries.push({ id: "action:new-side-chat", group: "actions", title: "New side chat", detail: lock, keywords: "start create conversation topic", locked: lock, icon: lock ? <Lock size={14} strokeWidth={1.5} aria-hidden /> : <Plus size={16} strokeWidth={1.5} aria-hidden />, verb: "Start", run: () => chats.open(newChatId()), thenFocus: props.onFocusComposer ?? undefined });
      entries.push({ id: "action:switch-chat", group: "actions", title: "Switch chat", detail: chats.list ? `${(sideChats.length + 1).toLocaleString()} chats` : undefined, keywords: "chats side conversations list go", icon: <MessagesSquare size={16} strokeWidth={1.5} aria-hidden />, page: "chats", verb: "Open" });
      if (chats.failed && !chats.list) entries.push({ id: "action:retry-chats", group: "chats", title: "Couldn't load your chats", detail: "Try again", keywords: "retry reload", icon: <RotateCw size={16} strokeWidth={1.5} aria-hidden />, verb: "Try again", run: chats.retry, stayOpen: true });
    }
    if (tasks.length > 0) entries.push({ id: "action:tasks", group: "actions", title: "Show background tasks", detail: runningTasks.length > 0 ? `${runningTasks.length.toLocaleString()} running` : `${tasks.length.toLocaleString()} finished`, keywords: "jobs work progress", icon: <ListChecks size={16} strokeWidth={1.5} aria-hidden />, page: "tasks", verb: "Open" });
    if (props.onOpenFiles) entries.push({ id: "action:files", group: "actions", title: "Show files", keywords: "uploads attachments documents outputs", icon: <FileText size={16} strokeWidth={1.5} aria-hidden />, verb: "Show", run: props.onOpenFiles });
    for (const tab of props.tabs) {
      entries.push({ id: `nav:${tab}`, group: "navigation", title: TAB_LABEL[tab], detail: props.tab === tab ? "Open now" : undefined, keywords: TAB_KEYWORDS[tab], icon: TAB_ICON[tab], locked: props.tab === tab ? "Open now" : undefined, verb: "Go", run: () => props.onTab(tab) });
    }
    entries.push({ id: "settings:dashboard", group: "settings", title: "Your dashboard", detail: "OpenWork", keywords: "account profile organization workspace admin", icon: <LayoutDashboard size={16} strokeWidth={1.5} aria-hidden />, verb: "Open", run: () => window.location.assign(props.homeHref), alt: { verb: "New tab", run: () => openInNewTab(props.homeHref) } });
    const connections = props.connectionsHref;
    if (connections) entries.push({ id: "settings:connections", group: "settings", title: "Your connections", detail: "OpenWork", keywords: "apps google microsoft calendar connect accounts integrations", icon: <Plug size={16} strokeWidth={1.5} aria-hidden />, verb: "Open", run: () => window.location.assign(connections), alt: { verb: "New tab", run: () => openInNewTab(connections) } });
    return [...entries, ...chatEntries, ...taskEntries];
  }, [props, chats, sideChats.length, tasks.length, runningTasks.length, chatEntries, taskEntries]);

  const pageEntries = useMemo(() => page === "chats" ? [
    ...rootEntries.filter((entry) => entry.id === "action:new-side-chat"),
    ...chatEntries.map((entry) => ({ ...entry, preview: true })),
  ] : page === "tasks" ? taskEntries.map((entry) => ({ ...entry, preview: true })) : rootEntries, [page, rootEntries, chatEntries, taskEntries]);
  const groups: RankedGroup<Entry>[] = useMemo(
    // The page or chat already open is not offered as a recent: it would lead nowhere.
    () => rankPaletteItems(query, pageEntries, page === "root" ? recents.filter((id) => pageEntries.find((entry) => entry.id === id)?.locked === undefined) : []),
    [query, pageEntries, page, recents],
  );
  const highlighted = highlightedId ? pageEntries.find((entry) => entry.id === highlightedId) ?? null : null;
  const count = groups.reduce((total, group) => total + group.items.length, 0);
  const loadingChats = chats !== null && chats.loading && !chats.list && (page === "chats" || (page === "root" && !query.trim()));

  const goTo = (next: Page) => { setPage(next); setQuery(""); setHighlightedId(null); window.requestAnimationFrame(() => input.current?.focus()); };
  const back = () => goTo("root");

  const choose = (entry: Entry, alt = false) => {
    if (entry.locked) return;
    if (!alt && entry.page) { goTo(entry.page); return; }
    const action = alt ? entry.alt?.run : entry.run;
    if (!action) return;
    if (page === "root" && !entry.stayOpen) setRecents(recordPaletteRecent(entry.id));
    if (!entry.stayOpen) close(alt ? undefined : entry.thenFocus);
    action();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = input.current;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (page !== "root") back();
      else close();
      return;
    }
    // Emacs-style Ctrl+N / Ctrl+P move like the arrow keys (macOS habit, also on other systems).
    if (event.ctrlKey && !event.metaKey && !event.altKey && (event.key === "n" || event.key === "p") && target) {
      event.preventDefault();
      event.stopPropagation();
      target.dispatchEvent(new globalThis.KeyboardEvent("keydown", { key: event.key === "n" ? "ArrowDown" : "ArrowUp", bubbles: true, cancelable: true }));
      return;
    }
    if (event.key === "Enter" && (mac ? event.metaKey : event.ctrlKey)) {
      event.preventDefault();
      event.stopPropagation();
      if (highlighted?.alt) choose(highlighted, true);
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      if (event.shiftKey) { if (page !== "root") back(); }
      else if (highlighted?.page) goTo(highlighted.page);
      return;
    }
    if (event.key === "Backspace" && page !== "root" && target && target.value === "" && target.selectionStart === 0) {
      event.preventDefault();
      back();
    }
  };

  const placeholder = page === "chats" ? "Search chats" : page === "tasks" ? "Search background tasks" : `Search ${props.name}, chats and actions`;
  const pageTitle = page === "chats" ? "Chats" : page === "tasks" ? "Background tasks" : null;
  const altChord = mac ? "⌘↵" : "Ctrl+↵";

  const row = (entry: Entry) => (
    <Autocomplete.Item
      key={entry.id}
      value={entry}
      disabled={entry.locked !== undefined}
      onClick={() => choose(entry)}
      data-workbot-palette-item={entry.id}
      className="group flex h-10 w-full min-w-0 cursor-default select-none items-center gap-2.5 rounded-[10px] px-2.5 text-left text-[13px] text-[var(--wb-text)] outline-none [contain-intrinsic-size:auto_40px] [content-visibility:auto] data-[highlighted]:bg-[var(--wb-chip)] data-[disabled]:text-[var(--wb-muted)]"
    >
      <span className="grid size-5 shrink-0 place-items-center text-[var(--wb-muted)]">{entry.icon}</span>
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="min-w-0 shrink truncate"><Highlighted text={entry.title} query={query} /></span>
        {entry.detail ? <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--wb-muted)]">{entry.detail}</span> : null}
      </span>
      {entry.meta ? <span className="shrink-0 text-[12px] text-[var(--wb-muted)] group-data-[highlighted]:hidden">{entry.meta}</span> : null}
      {entry.locked === undefined ? (
        <span className="hidden shrink-0 items-center gap-1.5 text-[12px] text-[var(--wb-muted)] group-data-[highlighted]:flex" aria-hidden>
          {entry.alt ? <><span>{entry.alt.verb}</span><Kbd>{altChord}</Kbd></> : null}
          <span>{entry.verb}</span><Kbd>{entry.page ? "⇥" : "↵"}</Kbd>
        </span>
      ) : null}
      {entry.page ? <ChevronRight size={14} strokeWidth={1.5} aria-hidden className="shrink-0 text-[var(--wb-muted)] group-data-[highlighted]:hidden" /> : null}
    </Autocomplete.Item>
  );

  return (
    <Dialog.Root
      open={surface.open}
      onOpenChange={(next, details) => {
        if (blocked) return;
        if (next && details.reason === "trigger-press") returnTo.current = null;
        setOpen(next);
      }}
      onOpenChangeComplete={(next) => { if (!next) flushFocus(); }}
    >
      <Dialog.Trigger
        className={ICON_BUTTON}
        aria-label="Search and actions"
        aria-keyshortcuts={mac ? "Meta+K" : "Control+K"}
        title={`Search and actions (${mod}${mac ? "" : "+"}K)`}
        data-workbot-palette-trigger
      >
        <Search size={16} strokeWidth={1.5} aria-hidden />
      </Dialog.Trigger>
      <Dialog.Portal {...surface.portal}>
        <Dialog.Backdrop className="workbot fixed inset-0 z-50 bg-[var(--wb-ink)]/15 transition-opacity duration-[120ms] ease-out data-[ending-style]:opacity-0 data-[ending-style]:duration-[80ms] data-[starting-style]:opacity-0 motion-reduce:transition-none" />
        <Dialog.Popup
          initialFocus={input}
          finalFocus={() => (pendingFocus.current ? false : returnTo.current?.isConnected ? returnTo.current : true)}
          onKeyDownCapture={onKeyDown}
          data-workbot-palette
          className="workbot fixed left-1/2 top-2 z-50 flex max-h-[min(30rem,calc(100dvh-1rem))] w-[min(40rem,calc(100vw-1rem))] -translate-x-1/2 flex-col overflow-hidden rounded-[var(--dls-radius,16px)] bg-[var(--wb-surface)] text-[var(--wb-text)] shadow-[var(--wb-panel-shadow)] outline-none transition-opacity duration-[80ms] ease-out data-[ending-style]:opacity-0 motion-reduce:transition-none sm:top-[12vh]"
        >
          <Dialog.Title className="sr-only">{pageTitle ?? "Search and actions"}</Dialog.Title>
          <Autocomplete.Root
            key={page}
            items={groups}
            filter={null}
            open
            inline
            autoHighlight="always"
            keepHighlight
            value={query}
            onValueChange={(next, details) => { if (details.reason === "input-change" || details.reason === "input-clear" || details.reason === "clear-press") setQuery(next); }}
            onItemHighlighted={(value) => setHighlightedId(value?.id ?? null)}
            itemToStringValue={(entry) => entry.title}
          >
            <div className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--wb-hairline)] px-3">
              {pageTitle ? (
                <>
                  <button type="button" onClick={back} aria-label="Back" title="Back (esc)" className={`-ml-1 ${ICON_BUTTON}`}><ChevronLeft size={16} strokeWidth={1.5} aria-hidden /></button>
                  <span className="shrink-0 rounded-md bg-[var(--wb-chip)] px-1.5 py-0.5 text-[12px] font-medium text-[var(--wb-text)]">{pageTitle}</span>
                </>
              ) : <Search size={16} strokeWidth={1.5} aria-hidden className="shrink-0 text-[var(--wb-muted)]" />}
              <Autocomplete.Input
                ref={input}
                placeholder={placeholder}
                aria-label={placeholder}
                data-workbot-palette-input
                className="h-full min-w-0 flex-1 bg-transparent text-[16px] text-[var(--wb-text)] outline-none placeholder:text-[var(--wb-faint)] sm:text-[14px]"
              />
            </div>
            <div ref={scroller} className="min-h-0 flex-1 scroll-pb-2 scroll-pt-10 overflow-y-auto overscroll-contain [overflow-anchor:none]">
              <Autocomplete.Empty className="px-6 py-10 text-center empty:hidden">
                {query.trim() ? (
                  <>
                    <p className="text-[13px] text-[var(--wb-text)]">Nothing matches &ldquo;{query.trim()}&rdquo;</p>
                    <p className="mt-1 text-[12px] text-[var(--wb-muted)]">Try fewer or different words.</p>
                  </>
                ) : page === "tasks" ? <p className="text-[13px] text-[var(--wb-muted)]">No background tasks in this chat yet.</p> : null}
              </Autocomplete.Empty>
              <Autocomplete.List className="p-1.5 outline-none empty:hidden" aria-label={pageTitle ?? "Results"}>
                {(group: RankedGroup<Entry>) => (
                  <Autocomplete.Group key={group.value} items={group.items} className="pb-1" data-workbot-palette-group={group.value}>
                    <Autocomplete.GroupLabel className="px-2.5 pb-1 pt-2 text-[12px] font-medium text-[var(--wb-muted)]">{group.label}</Autocomplete.GroupLabel>
                    <Autocomplete.Collection>{row}</Autocomplete.Collection>
                    {group.value === "actions" && loadingChats ? <ChatsSkeleton /> : null}
                  </Autocomplete.Group>
                )}
              </Autocomplete.List>
            </div>
            <Autocomplete.Status className="sr-only">
              {loadingChats ? "Loading chats" : count === 0 ? (query.trim() ? "No results" : "") : `${count.toLocaleString()} ${count === 1 ? "result" : "results"}`}
            </Autocomplete.Status>
            <div className="hidden h-9 shrink-0 items-center gap-4 border-t border-[var(--wb-hairline)] px-3 text-[12px] text-[var(--wb-muted)] sm:flex" aria-hidden>
              <span className="flex items-center gap-1.5"><Kbd>↑</Kbd><Kbd>↓</Kbd>Move</span>
              <span className="flex items-center gap-1.5"><Kbd>↵</Kbd>Run</span>
              {page === "root" ? <span className="flex items-center gap-1.5"><Kbd>⇥</Kbd>Open list</span> : <span className="flex items-center gap-1.5"><Kbd>⌫</Kbd>Back</span>}
              <span className="ml-auto flex items-center gap-1.5"><Kbd>esc</Kbd>{page === "root" ? "Close" : "Back"}</span>
            </div>
          </Autocomplete.Root>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
