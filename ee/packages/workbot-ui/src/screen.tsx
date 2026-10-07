"use client";

import { ArrowUp, Check, Copy, FileText, Lock, Pencil } from "lucide-react";
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from "react";
import { setWorkbotHost, workbotHost, type WorkbotHost } from "./host";
import { OpenWorkMark } from "./mark";
import {
  useEditWorkbotMessage,
  useSendWorkbotMessage,
  useStartWorkbot,
  useStopWorkbot,
  useStopWorkbotTask,
  useWorkbotLive,
  useWorkbotThread,
  workbotFilesKey,
  type LiveText,
  type WorkbotAttachment,
  type WorkbotStep,
  type WorkbotTask,
  type WorkbotTurn,
} from "./data";
import { AppMark, AttachButton, FileBadge, FilesButton, FilesPanel, ImageThumb, isImage, kindLabel, SentAttachments, UploadTray, useFileDrop, useUploads, type Upload } from "./files";
import { initials } from "./format";
import { WorkbotMarkdown } from "./markdown";
import { OpenFileContext } from "./open-file";
import { PreviewPanel } from "./preview";
import { Welcome } from "./welcome";
import { useQueryClient } from "@tanstack/react-query";

/**
 * Workbot: one thread, instant. Layout and values follow the Paper file "WorkBot — one chat, set up once",
 * page v4 (screens 1–4) for the thread and v5 (screens 5–8) for files.
 */

type Pending = {
  id: string;
  text: string;
  sentAt: number;
  /** Files still uploading, shown from the tray until the turn exists. */
  uploads: Upload[];
  failed: string | null;
};

const PAGE_TURNS = 30;
const COLUMN = "w-full max-w-[640px]";

function newMessageId() {
  return crypto.randomUUID().replaceAll("-", "");
}

/** The Workbot page. `host` is the app it lives in: signed-in requests, the person, their apps (see WorkbotHost). */
export function WorkbotScreen({ host }: { host: WorkbotHost }) {
  setWorkbotHost(host);
  const { user } = host;
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<Pending[]>([]);
  const [turnWindow, setTurnWindow] = useState(PAGE_TURNS);
  const [filesOpen, setFilesOpen] = useState(false);
  const [preview, setPreview] = useState<WorkbotAttachment | null>(null);
  // The welcome shows once, while there's no conversation yet; leaving it, Workbot starts the conversation itself.
  // "pending" until the conversation is first read: then it shows (no conversation yet) or never does.
  const [welcome, setWelcome] = useState<"pending" | "showing" | "done">("pending");
  const [greetingAwaited, setGreetingAwaited] = useState(false);
  const start = useStartWorkbot();
  const stream = useWorkbotLive(true);
  const thread = useWorkbotThread({ turns: turnWindow, awaiting: greetingAwaited || pending.some((entry) => !entry.failed), live: stream.connected });
  const send = useSendWorkbotMessage();
  const stop = useStopWorkbot();
  const editMessage = useEditWorkbotMessage();
  // Messages replaced by an edit leave the page at once; the conversation catches up on its next read.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const uploads = useUploads();
  const data = thread.data?.available ? thread.data : null;
  // The open file at its newest version: when Workbot revises it, the preview follows (same id, newer updatedAt).
  const previewFile = useMemo(() => {
    if (!preview || !data) return preview;
    let newest = preview;
    for (const turn of data.turns) {
      for (const file of [...turn.outputs, ...turn.attachments]) {
        if (file.id === preview.id && (file.updatedAt ?? 0) > (newest.updatedAt ?? 0)) newest = file;
      }
    }
    return newest;
  }, [preview, data]);
  const filesEnabled = data?.filesEnabled ?? false;
  const addFiles = uploads.add;
  const dragging = useFileDrop(filesEnabled, addFiles);

  useEffect(() => {
    if (greetingAwaited && (start.isError || start.data?.started === false || (data?.turns.length ?? 0) > 0)) setGreetingAwaited(false);
  }, [data, greetingAwaited, start.isError, start.data]);
  useEffect(() => {
    if (welcome === "pending" && data) setWelcome(needsWelcome(data.turns) && pending.length === 0 ? "showing" : "done");
  }, [data, welcome, pending.length]);
  // Once they're past the welcome, remember it for this conversation's hello, so a reload doesn't show it again.
  useEffect(() => {
    const hello = data?.turns[0];
    if (welcome === "done" && hello?.greeting && hello.sentAt) rememberWelcomed(hello.sentAt);
  }, [data, welcome]);

  // Once the conversation no longer has a hidden message, it needn't be hidden any more.
  useEffect(() => {
    if (!data || hidden.size === 0) return;
    const present = new Set(data.turns.map((turn) => turn.id));
    if ([...hidden].some((id) => !present.has(id))) setHidden((current) => new Set([...current].filter((id) => present.has(id))));
  }, [data, hidden]);

  // A sent message stays on screen as written until the conversation shows it.
  useEffect(() => {
    if (!data) return;
    const known = new Set(data.turns.map((turn) => turn.id));
    setPending((current) => (current.some((entry) => known.has(entry.id)) ? current.filter((entry) => !known.has(entry.id)) : current));
  }, [data]);

  const submit = (text: string, retry?: Pending) => {
    const trimmed = text.trim();
    const id = retry?.id ?? newMessageId();
    const fromTray = retry ? { taken: retry.uploads, settled: Promise.resolve(retry.uploads.flatMap((upload) => (upload.saved ? [upload.saved] : []))) } : uploads.take();
    if (!trimmed && fromTray.taken.length === 0) return;
    setPending((current) => [...current.filter((entry) => entry.id !== id), { id, text: trimmed, sentAt: Date.now(), uploads: fromTray.taken, failed: null }]);
    const fail = (message: string) => setPending((current) => current.map((entry) => (entry.id === id ? { ...entry, failed: message } : entry)));
    // The message waits for its files, then goes out with their ids.
    void fromTray.settled.then((saved) => {
      if (fromTray.taken.length > 0 && saved.length < fromTray.taken.length) {
        fail("A file didn't upload.");
        return;
      }
      send.mutate({ id, text: trimmed, attachments: saved.map((file) => file.id) }, {
        onError: (error) => fail(error.message),
        onSuccess: () => void queryClient.invalidateQueries({ queryKey: workbotFilesKey }),
      });
    });
  };

  /** Sends an edited message in place of the old one: it and everything after it make way for the new answer. */
  const editTurn = (turn: WorkbotTurn, text: string, onError: (message: string) => void) => {
    const trimmed = text.trim();
    if (!trimmed && turn.attachments.length === 0) return;
    const turns = data?.turns ?? [];
    const from = turns.findIndex((entry) => entry.id === turn.id);
    const replaced = from === -1 ? [turn.id] : turns.slice(from).map((entry) => entry.id);
    const id = newMessageId();
    setHidden((current) => new Set([...current, ...replaced]));
    setPending((current) => [...current, { id, text: trimmed, sentAt: Date.now(), uploads: [], failed: null }]);
    editMessage.mutate(
      { id: turn.id, newId: id, text: trimmed, attachments: turn.attachments.map((file) => file.id) },
      {
        onError: (error) => {
          setHidden((current) => new Set([...current].filter((entry) => !replaced.includes(entry))));
          setPending((current) => current.filter((entry) => entry.id !== id));
          onError(error.message);
        },
      },
    );
  };

  if (thread.isPending) return <WorkbotSkeleton />;
  if (thread.isError && !thread.data) {
    return (
      <Centered>
        <p className="text-[14px] text-[var(--wb-text)]">Couldn&apos;t load your conversation.</p>
        <button type="button" onClick={() => void thread.refetch()} className="mt-3 rounded-full px-3 py-1.5 text-[13px] font-medium text-[var(--wb-text)] hover:bg-[var(--wb-chip)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]">
          Try again
        </button>
      </Centered>
    );
  }
  if (!data) {
    const notEnabled = thread.data?.available === false && thread.data.reason === "workbot_not_enabled";
    return (
      <Centered>
        <Lock size={16} strokeWidth={1.5} className="text-[var(--wb-muted)]" aria-hidden />
        <p className="mt-3 text-[14px] text-[var(--wb-text)]">{notEnabled ? "Workbot isn't on for your organization yet." : "Workbot is unavailable right now."}</p>
        <p className="mt-1 text-[13px] text-[var(--wb-muted)]">{notEnabled ? "An admin can turn it on." : "Try again in a few minutes."}</p>
      </Centered>
    );
  }

  const busy = data.status === "busy" || pending.some((entry) => !entry.failed);
  const empty = data.turns.length === 0 && pending.length === 0;
  const firstName = user?.name?.trim().split(/\s+/)[0] ?? null;
  if (welcome === "showing" || (welcome === "pending" && pending.length === 0 && needsWelcome(data.turns))) {
    return (
      <Welcome
        name={data.name}
        firstName={firstName}
        // Start only after the person finishes or skips connecting their apps.
        onBegin={() => {
          if (start.isIdle) {
            setGreetingAwaited(true);
            start.mutate();
          }
        }}
        onDone={() => setWelcome("done")}
      />
    );
  }
  // Right after the welcome: the conversation, with Workbot typing its hello. If that can't start, the drawn greeting.
  const starting = empty && (start.isPending || (greetingAwaited && start.data?.started === true));
  const composer = (
    <Composer
      name={data.name}
      busy={busy}
      stopping={stop.isPending}
      filesEnabled={filesEnabled}
      uploads={uploads.uploads}
      onFiles={addFiles}
      onRemoveUpload={uploads.remove}
      onRetryUpload={uploads.retry}
      onSend={(text) => submit(text)}
      onStop={() => stop.mutate()}
    />
  );

  return (
    <OpenFileContext.Provider value={setPreview}>
    <div className="workbot flex h-dvh flex-col bg-[var(--wb-bg)] antialiased">
      <WorkbotHeader
        name={data.name}
        organizationName={data.organizationName}
        userName={user?.name ?? null}
        files={filesEnabled ? <FilesButton open={filesOpen} onOpen={() => setFilesOpen(true)} /> : null}
      />
      <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
      {empty && !starting ? (
        <FirstOpen name={data.name} organizationName={data.organizationName} firstName={firstName} onSuggestion={(text) => submit(text)}>
          {start.isError ? (
            <div className="flex items-center gap-2 py-2 text-[13px] text-[var(--wb-muted)]" role="status">
              <span>Couldn&apos;t check your day.</span>
              <button type="button" onClick={() => { setGreetingAwaited(true); start.mutate(); }} className="rounded-full px-2 py-1 font-medium text-[var(--wb-text)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]">Try again</button>
            </div>
          ) : null}
          {composer}
        </FirstOpen>
      ) : (
        <>
          <Conversation
            turns={hidden.size ? data.turns.filter((turn) => !hidden.has(turn.id)) : data.turns}
            canChange={!busy}
            onEdit={editTurn}
            pending={pending}
            live={stream.live}
            hasEarlier={data.hasEarlier}
            loadingEarlier={thread.isFetching && turnWindow > data.turns.length}
            onLoadEarlier={() => setTurnWindow((current) => Math.min(200, current + PAGE_TURNS))}
            onRetry={(entry) => submit(entry.text, entry)}
            onRetryTurn={(turn) => {
              if (turn.greeting) { setGreetingAwaited(true); start.mutate(); }
              else submit(turn.text);
            }}
            onSuggestion={(text) => submit(text)}
            starting={starting}
            intro={
              data.hasEarlier
                ? null
                : (() => {
                    const at = data.turns[0]?.sentAt ?? pending[0]?.sentAt ?? Date.now();
                    const spoken = starting || data.turns[0]?.greeting === true;
                    // Workbot's own hello carries the time; the drawn greeting brings its own.
                    return { at: spoken ? 0 : at, node: <Intro name={data.name} organizationName={data.organizationName} firstName={firstName} at={at} spoken={spoken} /> };
                  })()
            }
          />
          <div className="flex shrink-0 justify-center px-3 pb-3 pt-3 sm:px-10 sm:pb-7">
            <div className={COLUMN}>
              {composer}
            </div>
          </div>
        </>
      )}
      </div>
      {previewFile ? <PreviewPanel file={previewFile} onClose={() => setPreview(null)} /> : null}
      </div>
      {filesEnabled ? (
        <FilesPanel
          open={filesOpen}
          onClose={() => setFilesOpen(false)}
          assistantName={data.name}
          onOpenFile={(file) => {
            setFilesOpen(false);
            setPreview(file);
          }}
        />
      ) : null}
      {dragging ? (
        <div className="pointer-events-none fixed inset-3 z-40 grid place-items-center rounded-[28px] border-2 border-dashed border-[var(--wb-disabled)] bg-[var(--wb-bg)]/85">
          <p className="flex items-center gap-2 text-[14px] font-medium text-[var(--wb-text)]"><FileText size={16} strokeWidth={1.75} aria-hidden />Drop to add to your message</p>
        </div>
      ) : null}
    </div>
    </OpenFileContext.Provider>
  );
}

const WELCOMED_KEY = "workbot.welcomed";

function rememberWelcomed(helloAt: number) {
  try {
    window.localStorage.setItem(WELCOMED_KEY, String(helloAt));
  } catch {
    // Storage off: the welcome may show again after a reload, which is harmless.
  }
}

/**
 * The welcome shows until the person is past it: nothing from them in the conversation yet, and either no hello yet
 * or a hello they haven't been welcomed for (it started in the background while they were on the welcome, and a
 * reload must not skip it). Clearing the conversation brings it back, since the next hello is a new one.
 */
function needsWelcome(turns: WorkbotTurn[]) {
  if (turns.some((turn) => !turn.greeting)) return false;
  const hello = turns[0];
  if (!hello?.sentAt) return true;
  try {
    return window.localStorage.getItem(WELCOMED_KEY) !== String(hello.sentAt);
  } catch {
    return true;
  }
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="workbot flex h-dvh flex-col items-center justify-center bg-[var(--wb-bg)] px-6 text-center">{children}</div>;
}

/** Matches the conversation layout: header, a few lines of thread, the composer. */
function WorkbotSkeleton() {
  return (
    <div className="workbot flex h-dvh flex-col bg-[var(--wb-bg)]" aria-busy="true">
      <div className="flex h-12 items-center gap-2.5 border-b border-[var(--wb-hairline)] px-4 sm:h-15 sm:px-6">
        <span className="h-7 w-7 rounded-[9px] bg-[var(--wb-bubble)] sm:h-7.5 sm:w-7.5" />
        <span className="h-4 w-20 rounded bg-[var(--wb-bubble)]" />
      </div>
      <div className="flex flex-1 flex-col items-center justify-end px-4 pb-2 sm:px-10">
        <div className={`${COLUMN} flex flex-col gap-[3px]`}>
          <span className="ml-auto h-[38px] w-48 rounded-[20px] rounded-br-md bg-[var(--wb-bubble)]" />
          <span className="mt-3.5 h-6 w-40 rounded bg-[var(--wb-chip)]" />
          <span className="mt-1.5 h-24 w-[70%] rounded-[20px] rounded-bl-md bg-[var(--wb-surface)] shadow-[var(--wb-card-shadow)]" />
        </div>
      </div>
      <div className="flex justify-center px-3 pb-3 pt-3 sm:px-10 sm:pb-7">
        <div className={`${COLUMN} h-[50px] rounded-full bg-[var(--wb-surface)] shadow-[var(--wb-composer-shadow)] sm:h-13`} />
      </div>
    </div>
  );
}

/** The OpenWork mark: Workbot is OpenWork's assistant, so it wears OpenWork's mark rather than a monogram tile. */
function Mark({ size }: { name: string; size: "header" | "hero" }) {
  return (
    <OpenWorkMark width={size === "hero" ? 36 : 16} height={size === "hero" ? 45 : 20} className="shrink-0" />
  );
}

function useConnectedApps() {
  return workbotHost().useConnectedApps();
}

function WorkbotHeader({ name, organizationName, userName, files }: { name: string; organizationName: string; userName: string | null; files: ReactNode }) {
  const apps = useConnectedApps();
  const names = apps.map((app) => app.name);
  return (
    <header className="flex h-13 shrink-0 items-center justify-between px-4 sm:px-5">
      <div className="flex min-w-0 items-center gap-2" title={organizationName}>
        <Mark name={name} size="header" />
        <h1 className="truncate text-[15px] font-semibold leading-5 tracking-[-0.015em] text-[var(--wb-text)]">{name}</h1>
      </div>
      <div className="flex shrink-0 items-center gap-2.5 sm:gap-3.5">
        {files}
        {apps.length > 0 ? (
          <span className="flex h-7 items-center gap-[7px] rounded-full bg-[var(--wb-chip)] pl-2 pr-2.5" title={names.join(", ")} aria-label={`Connected: ${names.join(", ")}`}>
            {apps.slice(0, 4).map((app) => <AppMark key={app.id} name={app.name} />)}
            <span className="hidden max-w-[220px] truncate pl-0.5 text-[12px] leading-4 text-[var(--wb-muted)] sm:inline">{names.join(", ")}</span>
          </span>
        ) : null}
        <a
          href={workbotHost().homeHref}
          aria-label="Your dashboard"
          className="grid size-8 shrink-0 place-items-center rounded-full bg-[var(--wb-ink)] text-[11px] font-semibold tracking-[0.02em] text-[var(--wb-on-ink)] transition-opacity duration-150 hover:opacity-85 focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"
        >
          {initials(userName)}
        </a>
      </div>
    </header>
  );
}

function timestampLabel(at: number) {
  const date = new Date(at);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (date.toDateString() === today.toDateString()) return `Today ${time}`;
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  if (today.getTime() - date.getTime() < 6 * 86_400_000) return `${date.toLocaleDateString("en-US", { weekday: "long" })} ${time}`;
  return `${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${time}`;
}

function Timestamp({ at }: { at: number }) {
  return (
    <div className="flex justify-center pb-3">
      <span className="text-[12px] font-medium leading-4 text-[var(--wb-muted)]">{timestampLabel(at)}</span>
    </div>
  );
}

/**
 * Who Workbot is and its greeting: on the first open, and afterwards at the top of the conversation, so the hello
 * the person read doesn't vanish when they reply (DESIGN P11).
 */
function Intro(props: { name: string; organizationName: string; firstName: string | null; at: number; spoken?: boolean }) {
  const apps = useConnectedApps().map((app) => app.name);
  const seeing = apps.length === 0 ? null : apps.length === 1 ? apps[0] : `${apps.slice(0, -1).join(", ")} and ${apps.at(-1)}`;
  const hour = new Date(props.at).getHours();
  const hello = hour < 12 ? "Morning" : hour < 18 ? "Hi" : "Evening";
  return (
    <>
      <div className="flex flex-col items-center gap-1.5 pb-7">
        <Mark name={props.name} size="hero" />
        <span className="pt-1 text-[15px] font-semibold leading-[18px] text-[var(--wb-text)]">{props.name}</span>
        <span className="text-[12px] leading-4 text-[var(--wb-muted)]">Set up by {props.organizationName}</span>
      </div>
      {/* When Workbot wrote its own hello, that message follows; only the drawn greeting needs the lines here. */}
      {props.spoken ? null : (
        <div className="flex flex-col gap-[3px]">
          <Timestamp at={props.at} />
          <div className="flex">
            <p className="max-w-[520px] rounded-[20px] rounded-bl-md bg-[var(--wb-surface)] px-4 py-2.5 text-[15px] leading-[22px] text-[var(--wb-text)] shadow-[var(--wb-card-shadow)]">
              {hello}{props.firstName ? ` ${props.firstName}` : ""}.{seeing ? ` I can already see your ${seeing}.` : ""}
            </p>
          </div>
          <div className="flex">
            <p className="max-w-[520px] rounded-[20px] rounded-tl-md bg-[var(--wb-surface)] px-4 py-2.5 text-[15px] leading-[22px] text-[var(--wb-text)] shadow-[var(--wb-card-shadow)]">
              What can I take off your plate today?
            </p>
          </div>
        </div>
      )}
    </>
  );
}

/** Screen 1: the assistant, who set it up, its greeting as its own bubbles, starters, the composer — one centered group. */
function FirstOpen(props: { name: string; organizationName: string; firstName: string | null; onSuggestion: (text: string) => void; children: ReactNode }) {
  const apps = useConnectedApps().map((app) => app.name);
  const has = (pattern: RegExp) => apps.find((app) => pattern.test(app)) ?? null;
  const slack = has(/slack/i);
  const mail = has(/gmail|mail|outlook/i);
  const calendar = has(/calendar/i);
  const suggestions = [
    { text: slack ? "Catch me up on Slack" : "Catch me up on what I missed", app: slack },
    { text: "Emails that need a reply", app: mail },
    { text: "Plan my day", app: calendar },
  ];
  const [now] = useState(() => Date.now());
  return (
    <div className="flex flex-1 items-center justify-center overflow-y-auto px-4 pb-18 sm:px-10">
      <div className={`${COLUMN} flex flex-col gap-1`}>
        <Intro name={props.name} organizationName={props.organizationName} firstName={props.firstName} at={now} />
        <ul className="flex flex-wrap gap-2 py-[18px]">
          {suggestions.map((suggestion) => (
            <li key={suggestion.text}>
              <button
                type="button"
                onClick={() => props.onSuggestion(suggestion.text)}
                className="flex h-[34px] items-center gap-2 rounded-full bg-[var(--wb-surface)] pl-3 pr-3.5 text-[13px] leading-4 text-[var(--wb-text)] shadow-[0_0_0_1px_var(--wb-ring)] transition-shadow duration-150 hover:shadow-[0_0_0_1px_var(--wb-disabled)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"
              >
                {suggestion.app ? <AppMark name={suggestion.app} size={13} /> : null}
                {suggestion.text}
              </button>
            </li>
          ))}
        </ul>
        {props.children}
      </div>
    </div>
  );
}

type Row = { key: string; at: number; turn: WorkbotTurn | null; pending: Pending | null };

/** A new timestamp shows when the day changes or after a quiet hour, like a messaging app. */
function showsTimestamp(previous: Row | undefined, row: Row) {
  if (!row.at) return false;
  if (!previous?.at) return true;
  return new Date(previous.at).toDateString() !== new Date(row.at).toDateString() || row.at - previous.at > 60 * 60_000;
}

function Conversation(props: {
  turns: WorkbotTurn[];
  pending: Pending[];
  live: Record<string, LiveText>;
  hasEarlier: boolean;
  loadingEarlier: boolean;
  onLoadEarlier: () => void;
  onRetry: (entry: Pending) => void;
  onRetryTurn: (turn: WorkbotTurn) => void;
  /** The greeting, kept above the first message once the start of the conversation is loaded. */
  intro: { at: number; node: ReactNode } | null;
  onSuggestion: (text: string) => void;
  /** Workbot is about to say hello (right after the welcome). */
  starting: boolean;
  /** Whether the person's messages can be edited now (not while Workbot is answering). */
  canChange: boolean;
  onEdit: (turn: WorkbotTurn, text: string, onError: (message: string) => void) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const known = new Set(props.turns.map((turn) => turn.id));
  // A pending message and its turn share a key, so the bubble never re-mounts when the turn arrives.
  const rows: Row[] = [
    ...props.turns.map((turn) => ({ key: turn.id, at: turn.sentAt ?? 0, turn, pending: null })),
    ...props.pending.filter((entry) => !known.has(entry.id)).map((entry) => ({ key: entry.id, at: entry.sentAt, turn: null, pending: entry })),
  ];
  const lastTurnId = props.turns.at(-1)?.id;
  // One indicator, at the end of the thread, says a reply is on its way and none of it shows yet. Background tasks
  // show their progress on their own cards, and streamed text or a running step already shows Workbot at work, so
  // neither keeps the dots. Uploading files say so instead.
  const typing = useSettled(
    props.starting
      || props.pending.some((entry) => !known.has(entry.id) && !entry.failed && !entry.uploads.some((upload) => upload.status === "uploading"))
      || props.turns.some((turn) => awaitingReply(turn, props.live[turn.id] ?? null)),
    350,
  );
  // Local previews keep a just-sent image on screen while its kept copy loads.
  const localUrls = useMemo(() => {
    const urls: Record<string, string | null> = {};
    for (const entry of props.pending) for (const upload of entry.uploads) if (upload.saved) urls[upload.saved.id] = upload.previewUrl;
    return urls;
  }, [props.pending]);
  const previews = useRef<Record<string, string | null>>({});
  Object.assign(previews.current, localUrls);

  // Follow new content (including streamed text) only while the person is at the bottom.
  useLayoutEffect(() => {
    const node = scroller.current;
    const inner = content.current;
    if (!node || !inner) return;
    const follow = () => {
      if (pinned.current) node.scrollTop = node.scrollHeight;
    };
    follow();
    const observer = new ResizeObserver(follow);
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);

  // Sending always brings the conversation back to the newest message.
  const pendingCount = props.pending.length;
  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node || pendingCount === 0) return;
    pinned.current = true;
    node.scrollTop = node.scrollHeight;
  }, [pendingCount]);

  return (
    <div
      ref={scroller}
      className="workbot-scroll flex-1 overflow-y-auto [overflow-anchor:none]"
      onScroll={(event) => {
        const node = event.currentTarget;
        pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
      }}
    >
      <div ref={content} className="flex min-h-full flex-col items-center justify-end px-4 pb-2 pt-6 sm:px-10">
        <div className={`${COLUMN} flex flex-col`}>
          {props.hasEarlier ? (
            <button
              type="button"
              onClick={() => {
                pinned.current = false;
                props.onLoadEarlier();
              }}
              disabled={props.loadingEarlier}
              className="mx-auto mb-6 rounded-full px-3 py-1 text-[12px] font-medium text-[var(--wb-muted)] hover:bg-[var(--wb-chip)] hover:text-[var(--wb-text)] disabled:opacity-50 focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"
            >
              {props.loadingEarlier ? "Loading earlier messages" : "Show earlier messages"}
            </button>
          ) : null}
          {props.intro ? <div className="flex flex-col gap-1 pb-8">{props.intro.node}</div> : null}
          <ol className="flex flex-col" aria-label="Conversation">
            {rows.map((row, index) => {
              // The greeting has its own time; the first message only gets one after a quiet hour or a new day.
              const previous = rows[index - 1] ?? (props.intro?.at ? { key: "intro", at: props.intro.at, turn: null, pending: null } : undefined);
              const stamp = showsTimestamp(previous, row);
              return (
                <li key={row.key} className={`flex flex-col gap-1 ${index > 0 ? (stamp ? "pt-9" : "pt-8") : stamp && props.intro ? "pt-1" : ""}`}>
                  {stamp ? <Timestamp at={row.at} /> : null}
                  {row.turn ? (
                    <TurnView
                      canChange={props.canChange}
                      onEdit={props.onEdit}
                      turn={row.turn}
                      live={props.live[row.turn.id] ?? null}
                      latest={row.turn.id === lastTurnId && props.pending.every((entry) => known.has(entry.id))}
                      previews={previews.current}
                      onRetry={() => row.turn && props.onRetryTurn(row.turn)}
                      onSuggestion={props.onSuggestion}
                    />
                  ) : row.pending ? (
                    <PendingView entry={row.pending} onRetry={() => row.pending && props.onRetry(row.pending)} />
                  ) : null}
                </li>
              );
            })}
          </ol>
          {typing ? <div className="pt-3"><TypingBubble /></div> : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Workbot's reaction to a message: one emoji in the system's own emoji font, pinned to the message's corner like a
 * messaging app's tapback. It pops in once when it arrives (no bounce; none for reduced motion, DESIGN V6).
 */
function Reaction({ emoji }: { emoji: string }) {
  return (
    <span
      role="img"
      aria-label={`Reacted ${emoji}`}
      className="workbot-reaction workbot-emoji grid h-7 min-w-7 place-items-center rounded-full bg-[var(--wb-surface)] px-1 text-[15px] leading-none shadow-[var(--wb-card-shadow)]"
    >
      {emoji}
    </span>
  );
}

function UserBubble({ text, muted = false, reaction = null, action }: { text: string; muted?: boolean; reaction?: string | null; action?: ReactNode }) {
  if (!text) {
    return reaction ? (
      <div className="flex justify-end">
        <Reaction emoji={reaction} />
      </div>
    ) : null;
  }
  return (
    <div className="flex justify-end">
      <div className="group/own relative max-w-[85%] sm:max-w-[480px]">
        <p className={`whitespace-pre-wrap break-words rounded-[20px] bg-[var(--wb-user-bubble)] px-4 py-2.5 text-[15px] leading-[22px] text-[var(--wb-text)] transition-opacity duration-150 ${muted ? "opacity-60" : ""}`}>
          {text}
        </p>
        {action ? <span className={ownAction}>{action}</span> : null}
        {reaction ? (
          <span className="absolute -left-3 -top-3.5">
            <Reaction emoji={reaction} />
          </span>
        ) : null}
      </div>
    </div>
  );
}

const iconButton =
  "grid size-7 place-items-center rounded-full text-[var(--wb-muted)] transition-colors duration-150 hover:bg-[var(--wb-chip)] hover:text-[var(--wb-text)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)] disabled:opacity-40";

/**
 * With a mouse, a message's action waits in the gutter beside the bubble until hover or keyboard focus. Touch can't
 * hover, so there it rests under the bubble's trailing edge, clear of the reaction on the top-left corner.
 */
const ownAction =
  "absolute -left-8 top-1/2 -translate-y-1/2 opacity-0 transition-opacity duration-150 group-hover/own:opacity-100 has-[:focus-visible]:opacity-100 [@media(hover:none)]:static [@media(hover:none)]:mt-1 [@media(hover:none)]:flex [@media(hover:none)]:h-7 [@media(hover:none)]:translate-y-0 [@media(hover:none)]:items-center [@media(hover:none)]:justify-end [@media(hover:none)]:opacity-100";

/**
 * Edit for the person's own message. It stays in place, dimmed, while it can't be used (a reply is running or the
 * message is still sending), so the conversation never shifts when it becomes available. On touch the 28px icon
 * gets a 44px tap target without taking more room.
 */
function EditButton({ disabled, onClick }: { disabled: boolean; onClick?: () => void }) {
  return (
    <button type="button" aria-label="Edit message" title="Edit" disabled={disabled} onClick={onClick} className={`${iconButton} disabled:hover:bg-transparent disabled:hover:text-[var(--wb-muted)] [@media(hover:none)]:-my-2 [@media(hover:none)]:-mr-2 [@media(hover:none)]:size-11`}>
      <Pencil size={14} strokeWidth={1.75} aria-hidden />
    </button>
  );
}

/** Edit appears beside its own message on hover or keyboard focus (at rest under it on touch), without a delete action. */
function OwnMessage(props: {
  turn: WorkbotTurn;
  canChange: boolean;
  onEdit: (turn: WorkbotTurn, text: string, onError: (message: string) => void) => void;
}) {
  const { turn } = props;
  const [mode, setMode] = useState<"idle" | "editing">("idle");
  const [draft, setDraft] = useState(turn.text);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const element = field.current;
    if (mode !== "editing" || !element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 240)}px`;
  }, [draft, mode]);
  useEffect(() => {
    if (mode !== "editing") return;
    const element = field.current;
    element?.focus();
    element?.setSelectionRange(element.value.length, element.value.length);
  }, [mode]);

  const save = () => {
    const text = draft.trim();
    if (!text) return;
    setMode("idle");
    setError(null);
    if (text === turn.text.trim()) return;
    props.onEdit(turn, text, setError);
  };

  if (mode === "editing") {
    return (
      <div className="flex justify-end">
        <div className="flex w-full max-w-[85%] flex-col gap-2 sm:max-w-[480px]">
          <textarea
            ref={field}
            value={draft}
            rows={1}
            aria-label="Edit your message"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setDraft(turn.text);
                setMode("idle");
              } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                save();
              }
            }}
            className="w-full resize-none rounded-[20px] bg-[var(--wb-surface)] px-4 py-2.5 text-[15px] leading-[22px] text-[var(--wb-text)] shadow-[var(--wb-composer-shadow)] outline-none"
          />
          <div className="flex items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={() => {
                setDraft(turn.text);
                setMode("idle");
              }}
              className="h-8 rounded-full px-3 text-[13px] font-medium text-[var(--wb-muted)] transition-colors duration-150 hover:bg-[var(--wb-chip)] hover:text-[var(--wb-text)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={!draft.trim()}
              className="h-8 rounded-full bg-[var(--wb-ink)] px-3.5 text-[13px] font-medium text-[var(--wb-on-ink)] transition-opacity duration-150 hover:opacity-90 disabled:opacity-40 focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"
            >
              Send
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <UserBubble text={turn.text} reaction={turn.reaction} action={<EditButton disabled={!props.canChange} onClick={() => setMode("editing")} />} />
      {error ? <p className="pr-1 text-[13px] leading-4 text-[var(--wb-danger)]">{error}</p> : null}
    </div>
  );
}

/** Copies one of Workbot's answers, with a moment of "Copied" to say it worked. */
function CopyAnswer({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <div className="flex h-7 items-center pl-0.5 opacity-0 transition-opacity duration-150 group-hover/answer:opacity-100 group-focus-within/answer:opacity-100 [@media(hover:none)]:opacity-100">
      <button
        type="button"
        aria-label={copied ? "Copied" : "Copy answer"}
        title={copied ? "Copied" : "Copy"}
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => setCopied(true)).catch(() => undefined);
        }}
        className={iconButton}
      >
        {copied ? <Check size={14} strokeWidth={2} aria-hidden /> : <Copy size={14} strokeWidth={1.75} aria-hidden />}
      </button>
    </div>
  );
}

/**
 * Workbot's words in a chat bubble on the left: white on the page with a hairline, so its answers and the person's
 * grey bubbles on the right read as two sides of one conversation. It hugs short replies and stops at a readable
 * width; wide tables and code scroll inside it.
 */
function AssistantBubble({ children }: { children: ReactNode }) {
  return (
    <div className="flex py-[3px]">
      <div className="flex w-fit min-w-0 max-w-full flex-col overflow-x-auto rounded-[20px] rounded-bl-md bg-[var(--wb-surface)] px-4 py-2.5 shadow-[var(--wb-card-shadow)] sm:max-w-[600px]">
        {children}
      </div>
    </div>
  );
}

/**
 * Workbot writing a reply that doesn't show yet: one small reply bubble with three dots that darken in turn at the
 * end of the thread, like a messaging app's typing indicator. Nothing else moves (DESIGN V6, P11).
 */
function TypingBubble() {
  return (
    <div className="workbot-row-enter flex pt-1.5 pl-1" role="status" aria-label="Workbot is processing">
      <div className="flex h-9 items-center gap-[5px] rounded-[20px] rounded-bl-md bg-[var(--wb-surface)] px-4 shadow-[var(--wb-card-shadow)]">
        <span aria-hidden className="workbot-typing-dot" />
        <span aria-hidden className="workbot-typing-dot" />
        <span aria-hidden className="workbot-typing-dot" />
      </div>
    </div>
  );
}

const Gap = () => <span aria-hidden className="h-3.5 w-px shrink-0" />;

function pendingAttachments(entry: Pending): { attachments: WorkbotAttachment[]; urls: Record<string, string | null> } {
  const urls: Record<string, string | null> = {};
  const attachments = entry.uploads.map((upload) => {
    const id = upload.saved?.id ?? `local-${upload.key}`;
    urls[id] = upload.previewUrl;
    return { id, name: upload.file.name, mediaType: upload.file.type || "application/octet-stream", size: upload.file.size };
  });
  return { attachments, urls };
}

function PendingView({ entry, onRetry }: { entry: Pending; onRetry: () => void }) {
  const { attachments, urls } = pendingAttachments(entry);
  const uploading = entry.uploads.some((upload) => upload.status === "uploading");
  return (
    <>
      <SentAttachments attachments={attachments} localUrls={urls} />
      {/* Holds Edit's place while sending, so the bubble doesn't move when its turn arrives. */}
      <UserBubble text={entry.text} muted={Boolean(entry.failed)} action={entry.failed ? undefined : <EditButton disabled />} />
      {entry.failed ? (
        <p className="flex items-center justify-end gap-2 pt-1 text-[12px] leading-4 text-[var(--wb-muted)]">
          {entry.failed}
          <button type="button" onClick={onRetry} className="font-medium text-[var(--wb-text)] underline underline-offset-2">Send again</button>
        </p>
      ) : (
        <>
          <Gap />
          {uploading ? <QuietLine label="Uploading your files" /> : null}
        </>
      )}
    </>
  );
}

/** Ticks once a second while mounted. */
function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * Workbot's computer: a slim laptop with a soft blue screen whose two lines write themselves while it works.
 * Sized for the 16px slot (DESIGN V5); the motion stops for reduced motion (V6).
 */
/** Workbot's computer; its screen "writes" only while it is working (V6). */
function ComputerGlyph({ working = true }: { working?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width={16} height={16} fill="none" className={`workbot-computer ${working ? "is-working" : ""}`}>
      <rect x="2.25" y="3" width="11.5" height="8" rx="1.75" className="workbot-computer-screen" strokeWidth={1.25} />
      <path d="M1.5 13h13" className="workbot-computer-stand" strokeWidth={1.25} strokeLinecap="round" />
      <path className="workbot-computer-line" d="M4.75 6h3.5" strokeWidth={1.25} strokeLinecap="round" />
      <path className="workbot-computer-line" d="M4.75 8.25h5.5" strokeWidth={1.25} strokeLinecap="round" />
    </svg>
  );
}

/**
 * A little person at Workbot's computer: while it works they type (hands tapping, head nodding along, lines
 * appearing on the screen); when it's done they sit back. Only motion that means "working" (DESIGN V6).
 */
function WorkerGlyph({ working }: { working: boolean }) {
  return (
    <svg viewBox="0 0 28 28" width={28} height={28} fill="none" className={`workbot-worker ${working ? "is-working" : ""}`}>
      {/* desk */}
      <path d="M2.5 21h23" stroke="var(--wb-computer-frame)" strokeWidth={1.25} strokeLinecap="round" />
      {/* laptop: screen and base, facing the person */}
      <rect x="14.5" y="12.25" width="10.5" height="7.5" rx="1.5" fill="var(--wb-computer-screen)" stroke="var(--wb-ink)" strokeWidth={1.25} />
      <path d="M13 21h12.5" stroke="var(--wb-ink)" strokeWidth={1.5} strokeLinecap="round" />
      <path className="workbot-worker-line" d="M17 15h4" stroke="var(--wb-computer-line-live)" strokeWidth={1.25} strokeLinecap="round" />
      <path className="workbot-worker-line" d="M17 17.3h5.5" stroke="var(--wb-computer-line-live)" strokeWidth={1.25} strokeLinecap="round" />
      {/* person: body, head, arm reaching to the keyboard */}
      <path d="M4.5 21v-4.2a3.3 3.3 0 0 1 3.3-3.3h0.4a3.3 3.3 0 0 1 3.3 3.3v4.2" fill="var(--wb-ink)" />
      <g className="workbot-worker-head">
        <circle cx="8" cy="9.6" r="2.6" fill="var(--wb-ink)" />
      </g>
      <g className="workbot-worker-arm">
        <path d="M10.2 16.8l3.6 2.5" stroke="var(--wb-ink)" strokeWidth={1.6} strokeLinecap="round" />
      </g>
    </svg>
  );
}

/** A quiet line for the page's own waiting states ("Uploading your files", "Up next"): words only. */
function QuietLine({ label }: { label: string }) {
  return (
    <p className="flex h-6 shrink-0 items-center pl-1 text-[13px] leading-4 text-[var(--wb-faint)]" role="status" aria-live="polite">
      {label}
    </p>
  );
}

/**
 * Streamed text arrives in bursts; this reveals it at a steady pace that speeds up when it falls behind,
 * so the reply reads as written rather than jumping a sentence at a time.
 */
function useSmoothText(target: string) {
  const [shown, setShown] = useState(0);
  const shownRef = useRef(0);
  const previous = useRef("");
  useEffect(() => {
    const goal = target.length;
    // A new piece of text (the next step's) starts from its beginning; more of the same text continues.
    if (!target.startsWith(previous.current.slice(0, shownRef.current))) shownRef.current = 0;
    previous.current = target;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      shownRef.current = goal;
      setShown(goal);
      return;
    }
    let frame = 0;
    const tick = () => {
      const current = shownRef.current;
      if (current >= goal) return;
      // A steady pace, as if written: about 45 frames (¾ s) to catch up with whatever has arrived, never slower
      // than 2 characters a frame. A reply that arrives in one burst still reads as written, not pasted.
      shownRef.current = Math.min(goal, current + Math.max(2, Math.ceil((goal - current) / 45)));
      setShown(shownRef.current);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return target.slice(0, Math.min(shown, target.length));
}

function StreamingText({ text }: { text: string }) {
  const shown = useSmoothText(text);
  return (
    <div className="workbot-streaming">
      <WorkbotMarkdown text={shown} />
    </div>
  );
}

/** An app the turn used, for the "Using …" line: Workbot's computer or a connected app. */
type UsedApp = { key: string; name: string; computer: boolean };

function usedApps(steps: WorkbotStep[], starting: LiveText["working"] | null): UsedApp[] {
  const used: UsedApp[] = [];
  const add = (entry: UsedApp) => {
    if (!used.some((existing) => existing.key === entry.key)) used.push(entry);
  };
  for (const step of steps) {
    if (step.icon === "computer") add({ key: "computer", name: "my computer", computer: true });
    else if (step.app) add({ key: step.app, name: step.app, computer: false });
  }
  if (starting?.on === "computer") add({ key: "computer", name: "my computer", computer: true });
  return used;
}

function joinNames(names: string[]) {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * The value, but each one stays at least `minMs` before the next replaces it, so quick changes read as one calm
 * change instead of a flicker.
 */
function useHeld<T>(value: T, key: string, minMs: number): T {
  const [shown, setShown] = useState({ key, value });
  const shownAt = useRef(Date.now());
  useEffect(() => {
    if (key === shown.key) return;
    const timer = window.setTimeout(() => {
      shownAt.current = Date.now();
      setShown({ key, value });
    }, Math.max(0, minMs - (Date.now() - shownAt.current)));
    return () => window.clearTimeout(timer);
    // `value` travels with `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, minMs, shown.key]);
  return shown.value;
}


/** A computer update stays at least this long, so quick commands read as one calm change. */
const UPDATE_HOLD_MS = 1_600;

/**
 * Work done between two things Workbot said, where it happened: its computer as a card (the little person at work,
 * what it is doing, how long), or one quiet line for apps alone ("Using Gmail", then "Used Gmail"). `live` while
 * nothing has been said after it yet, so a card doesn't blink between two commands (DESIGN C3, T1, V6).
 */
function StepsSegment({ steps, live }: { steps: WorkbotStep[]; live: boolean }) {
  const used = usedApps(steps, null);
  const computer = steps.filter((step) => step.icon === "computer");
  const updates = computer.flatMap((step) => step.updates);
  const latest = updates.at(-1) ?? null;
  const update = useHeld(latest, latest ?? "", UPDATE_HOLD_MS);
  if (used.length === 0) return null;
  const others = used.filter((app) => !app.computer);
  if (computer.length > 0) {
    return (
      <div className="py-1 pl-1">
        <WorkCard
          title={live ? "Using my computer" : "Used my computer"}
          detail={(live ? update : latest) ?? (live ? "Getting started" : "Done")}
          running={live}
          outcome={live ? null : "done"}
          startedAt={computer.find((step) => step.startedAt)?.startedAt ?? null}
          finishedAt={live ? null : ([...computer].reverse().find((step) => step.finishedAt)?.finishedAt ?? null)}
          updates={live ? [] : updates}
          action={<AppLogos apps={others} />}
        />
      </div>
    );
  }
  const label = `${live ? "Using" : "Used"} ${joinNames(others.map((app) => app.name))}`;
  return (
    <p
      className={`flex h-7 items-center gap-2 pl-1 text-[12.5px] leading-4 ${live ? "workbot-row-enter" : "text-[var(--wb-faint)]"}`}
      role={live ? "status" : undefined}
      aria-live={live ? "polite" : undefined}
    >
      <span aria-hidden className="flex shrink-0 items-center gap-1">
        {others.map((app) => (
          <span key={app.key} className="workbot-app-enter grid size-4 place-items-center">
            <AppMark name={app.name} size={14} />
          </span>
        ))}
      </span>
      <span key={label} className={`truncate ${live ? "workbot-shimmer text-[13px]" : ""}`}>{label}</span>
    </p>
  );
}

/** The other apps a computer card's work used, as logos in its trailing slot. */
function AppLogos({ apps }: { apps: UsedApp[] }) {
  if (apps.length === 0) return null;
  return (
    <span aria-label={`Also using ${joinNames(apps.map((app) => app.name))}`} className="flex shrink-0 items-center gap-1.5 pr-1">
      {apps.map((app) => (
        <span key={app.key} className="workbot-app-enter grid size-4 place-items-center">
          <AppMark name={app.name} size={14} />
        </span>
      ))}
    </span>
  );
}


/**
 * The hello as it is written: nothing while it is still looking things up (a call that starts a lookup, or a short
 * line that could be a note to itself), and never its closing "Next:" line, which becomes buttons when it's done.
 */
function helloSoFar(text: string, working: LiveText["working"] | null) {
  if (working || (text.length < 40 && !text.includes("\n"))) return "";
  return withoutNextLine(text);
}

/** An answer as it is written, without a closing "Next:" line, which becomes buttons once the answer is done. */
function withoutNextLine(text: string) {
  const lines = text.split("\n");
  const next = lines.findIndex((line) => /^\**next\**\s*:/i.test(line.trim()));
  if (next !== -1) return lines.slice(0, next).join("\n").trimEnd();
  // A last line that may still become "Next:" waits until it can't.
  const last = lines.at(-1)?.trim().replace(/\*/g, "").toLowerCase() ?? "";
  if (last && "next:".startsWith(last)) return lines.slice(0, -1).join("\n").trimEnd();
  return text;
}

/** What of a turn's reply shows right now: its streamed text, its computer starting, or a step still running. */
function replyProgress(turn: WorkbotTurn, live: LiveText | null) {
  const working = turn.status === "working" || turn.status === "queued";
  // The model call in progress (not stored yet): its text so far, and whether it has started a step.
  const current = working && live && live.step >= turn.modelSteps ? live : null;
  // Workbot's hello streams only its message, never its notes between lookups.
  const liveText = turn.greeting ? helloSoFar(current?.text ?? "", current?.working ?? null) : withoutNextLine(current?.text ?? "");
  const last = turn.parts.at(-1);
  // Its computer starting before the step is stored: the card shows right away, after what it just said.
  const startingCard = working && !turn.greeting && current?.working?.on === "computer" && !(last?.kind === "steps" && last.steps.some((step) => step.icon === "computer"));
  const lastIsLive = working && last?.kind === "steps" && !liveText && !startingCard;
  return { working, liveText, startingCard, lastIsLive };
}

/** Workbot owes this reply and none of it shows yet (a hello's lookups stay hidden, so they don't count as showing). */
function awaitingReply(turn: WorkbotTurn, live: LiveText | null) {
  if (turn.status !== "working") return false;
  const { liveText, startingCard, lastIsLive } = replyProgress(turn, live);
  return !liveText && !startingCard && (Boolean(turn.greeting) || !lastIsLive);
}

/** True only once `flag` has held for `ms`: the typing bubble doesn't flash for a beat between two steps. */
function useSettled(flag: boolean, ms: number) {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!flag) {
      setSettled(false);
      return;
    }
    const timer = window.setTimeout(() => setSettled(true), ms);
    return () => window.clearTimeout(timer);
  }, [flag, ms]);
  return flag && settled;
}

function TurnView(props: {
  canChange: boolean;
  onEdit: (turn: WorkbotTurn, text: string, onError: (message: string) => void) => void;
  turn: WorkbotTurn;
  live: LiveText | null;
  latest: boolean;
  previews: Record<string, string | null>;
  onRetry: () => void;
  onSuggestion: (text: string) => void;
}) {
  const { turn } = props;
  const { working, liveText, startingCard, lastIsLive } = replyProgress(turn, props.live);
  // An answer watched while it was written keeps revealing at the same pace once it's stored, instead of the whole
  // text snapping in when the turn ends. Answers already done when the page opened show at once.
  const watched = useRef(working);
  if (working) watched.current = true;
  const parts = turn.parts;
  const last = parts.at(-1);
  // The stored last text is revealed in the live slot after the list, so its reveal carries on when it's stored.
  const lastText = parts.reduce((found, part, index) => (part.kind === "text" ? index : found), -1);
  const tailIsStored = !working && watched.current && lastText !== -1 && lastText === parts.length - 1;
  const storedTail = tailIsStored && last?.kind === "text" ? last.text : null;
  const tail: string | null = working ? liveText || null : storedTail;
  return (
    <>
      <SentAttachments attachments={turn.attachments} localUrls={props.previews} />
      {turn.text && !turn.greeting ? (
        <OwnMessage turn={turn} canChange={props.canChange && turn.status !== "queued"} onEdit={props.onEdit} />
      ) : (
        <UserBubble text={turn.text} reaction={turn.reaction} />
      )}
      {parts.length > 0 || liveText || startingCard || turn.status === "queued" ? <Gap /> : null}
      {/* What it said and what it did, in the order it happened: "On it." · the computer card · the answer. */}
      <div className="group/answer flex flex-col">
        {parts.map((part, index) => {
          if (part.kind === "text") {
            if (tailIsStored && index === lastText) return null;
            return (
              <AssistantBubble key={index}>
                <WorkbotMarkdown text={part.text} />
              </AssistantBubble>
            );
          }
          // Its hello looks things up out of sight; once it's done, one quiet line says what it read.
          if (turn.greeting && working) return null;
          return <StepsSegment key={index} steps={part.steps} live={working && index === parts.length - 1 && lastIsLive} />;
        })}
        {/* One slot for the text being written, kept when the answer is stored, so the reveal carries on. */}
        {tail ? (
          <AssistantBubble>
            <StreamingText text={tail} />
          </AssistantBubble>
        ) : null}
        {startingCard ? <StepsSegment steps={[{ label: "Using my computer", icon: "computer", status: "running", app: null, startedAt: null, finishedAt: null, updates: [] }]} live /> : null}
        {turn.status === "queued" ? <QuietLine label="Up next" /> : null}
        {turn.status === "done" && lastText !== -1 ? (
          <CopyAnswer text={parts.flatMap((part) => (part.kind === "text" ? [part.text] : [])).join("\n\n")} />
        ) : null}
      </div>
      {turn.outputs.length ? <OutputFiles files={turn.outputs} /> : null}
      {turn.tasks.length ? <TaskCards tasks={turn.tasks} canRetry={props.canChange} onRetry={(task) => props.onSuggestion(`Try the "${task.title}" background task again.`)} /> : null}
      {/* Workbot's hello offers what to ask next, only while it is still the latest message. */}
      {turn.suggestions.length && props.latest ? (
        <ul className="flex flex-wrap gap-2 pl-1 pt-3">
          {turn.suggestions.map((text) => (
            <li key={text}>
              <button
                type="button"
                onClick={() => props.onSuggestion(text)}
                className="flex h-[34px] items-center rounded-full bg-[var(--wb-surface)] px-3.5 text-[13px] leading-4 text-[var(--wb-text)] shadow-[0_0_0_1px_var(--wb-ring)] transition-shadow duration-150 hover:shadow-[0_0_0_1px_var(--wb-disabled)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"
              >
                {text}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {turn.status === "failed" ? (
        <p className="flex items-center gap-2 pl-1 pt-1.5 text-[13px] leading-4 text-[var(--wb-danger)]">
          {turn.error}
          {props.latest ? <button type="button" onClick={props.onRetry} className="font-medium text-[var(--wb-text)] underline underline-offset-2">Try again</button> : null}
        </p>
      ) : null}
      {turn.status === "stopped" ? <p className="pl-1 pt-1.5 text-[13px] leading-4 text-[var(--wb-muted)]">Stopped</p> : null}
    </>
  );
}


function duration(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const isOpen = (task: WorkbotTask) => task.status === "queued" || task.status === "working" || task.status === "paused";

/**
 * Work Workbot did on its computer, as one card: the laptop, what the work is, and what it is doing now (or what it
 * last did, once it is over) with how long it has taken. Running: the laptop animates and the line shimmers (V6).
 * Finished: the card stays, quiet, with a check. Clicking a finished card shows everything it did, in its own words.
 */
function WorkCard(props: {
  title: string;
  /** What it is doing now, or what it last did. */
  detail: string;
  running: boolean;
  outcome: "done" | "failed" | "stopped" | null;
  startedAt: number | null;
  finishedAt: number | null;
  updates: string[];
  action?: ReactNode;
}) {
  const now = useNow();
  const [open, setOpen] = useState(false);
  const elapsed = props.startedAt ? (props.finishedAt ?? (props.running ? now : null)) : null;
  const expandable = !props.running && props.updates.length > 1;
  const body = (
    <>
      <span aria-hidden className="relative grid size-9 shrink-0 place-items-center rounded-[10px] bg-[var(--wb-chip)]">
        <WorkerGlyph working={props.running} />
        {props.outcome === "done" ? (
          <span className="absolute -bottom-1 -right-1 grid size-4 place-items-center rounded-full bg-[var(--wb-ink)] text-[var(--wb-surface)] ring-2 ring-[var(--wb-surface)]">
            <Check size={9} strokeWidth={3} />
          </span>
        ) : null}
      </span>
      <span className="flex min-w-0 flex-1 flex-col text-left">
        <span className="truncate text-[13.5px] font-medium leading-5 text-[var(--wb-text)]">{props.title}</span>
        <span className={`flex min-w-0 items-center gap-1.5 text-[12px] leading-4 ${props.outcome === "failed" ? "text-[var(--wb-danger)]" : "text-[var(--wb-muted)]"}`}>
          <span key={props.detail} className={`workbot-subtitle-enter truncate ${props.running ? "workbot-shimmer" : ""}`}>{props.detail}</span>
          {props.startedAt && elapsed && elapsed - props.startedAt >= 1_000 ? (
            <span className="shrink-0 tabular-nums">· {duration(elapsed - props.startedAt)}</span>
          ) : null}
        </span>
      </span>
      {props.action}
    </>
  );
  return (
    <div className="workbot-row-enter max-w-[480px] rounded-[14px] bg-[var(--wb-surface)] shadow-[var(--wb-card-shadow)]">
      {expandable ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex w-full items-center gap-3 rounded-[14px] py-2.5 pl-2.5 pr-3 outline-none focus-visible:shadow-[var(--wb-focus)]"
        >
          {body}
        </button>
      ) : (
        <div className="flex items-center gap-3 py-2.5 pl-2.5 pr-2" role="status" aria-live="polite">
          {body}
        </div>
      )}
      {open ? (
        <ol className="workbot-fade-in flex flex-col gap-1.5 pb-3 pl-[58px] pr-4">
          {props.updates.map((update, index) => (
            <li key={`${index}:${update}`} className="text-[12.5px] leading-[18px] text-[var(--wb-muted)]">
              {update}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

/** One background task as a card: the little person at work, what it's doing, how long, and Stop. */
function TaskCard({ task, onRetry, canRetry = true }: { task: WorkbotTask; onRetry?: () => void; canRetry?: boolean }) {
  const stop = useStopWorkbotTask();
  const running = isOpen(task);
  const outcome = running ? null : task.status === "done" ? "done" : task.status === "failed" ? "failed" : "stopped";
  const detail = running
    ? task.status === "queued" ? "Waiting to start" : task.status === "paused" ? "Picking it back up" : (task.update ?? "Working on it")
    : outcome === "done" ? "Done" : outcome === "failed" ? "Couldn't finish" : "Stopped";
  const stopping = stop.isPending && stop.variables === task.id;
  return (
    <WorkCard
      title={task.title}
      detail={detail}
      running={running}
      outcome={outcome}
      startedAt={task.status === "queued" ? null : task.startedAt}
      finishedAt={task.finishedAt}
      updates={task.updates}
      action={
        running ? (
          <button
            type="button"
            disabled={stopping}
            onClick={() => stop.mutate(task.id)}
            className="h-7 shrink-0 rounded-full px-3 text-[12px] font-medium text-[var(--wb-muted)] transition-colors duration-150 hover:bg-[var(--wb-chip)] hover:text-[var(--wb-text)] disabled:opacity-50 focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"
          >
            {stopping ? "Stopping" : "Stop"}
          </button>
        ) : task.status === "failed" && onRetry ? (
          <button type="button" disabled={!canRetry} onClick={onRetry} className="h-7 shrink-0 rounded-full px-3 text-[12px] font-medium text-[var(--wb-text)] hover:bg-[var(--wb-chip)] disabled:opacity-50 focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]">Try again</button>
        ) : null
      }
    />
  );
}

/** A task keeps the same keyed card in the turn that started it, through every status. */
function TaskCards({ tasks, onRetry, canRetry }: { tasks: WorkbotTask[]; onRetry: (task: WorkbotTask) => void; canRetry: boolean }) {
  return (
    <div className="flex flex-col gap-2 pl-1 pt-3">
      {tasks.map((task) => <div key={task.id} data-workbot-task={task.id}><TaskCard task={task} canRetry={canRetry} onRetry={() => onRetry(task)} /></div>)}
    </div>
  );
}

/** Files Workbot made while answering, as cards under the answer that open in the preview panel. */
function OutputFiles({ files }: { files: WorkbotAttachment[] }) {
  const open = useContext(OpenFileContext);
  return (
    <div className="workbot-row-enter flex flex-wrap gap-2 pl-1 pt-3">
      {files.map((file) => (
        <button
          key={file.id}
          type="button"
          onClick={() => open(file)}
          className="flex min-w-0 max-w-full items-center gap-3 rounded-[14px] bg-[var(--wb-surface)] py-2 pl-2 pr-4 text-left shadow-[var(--wb-card-shadow)] transition-shadow duration-150 ease-out hover:shadow-[var(--wb-card-shadow-hover)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)] sm:max-w-[320px]"
        >
          {isImage(file.mediaType) ? <ImageThumb id={file.id} className="size-9 shrink-0 rounded-[8px] outline outline-1 -outline-offset-1 outline-black/10" /> : <FileBadge name={file.name} mediaType={file.mediaType} />}
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[13.5px] font-medium leading-5 text-[var(--wb-text)]">{file.name}</span>
            <span className="text-[12px] leading-4 text-[var(--wb-muted)]">{kindLabel(file.name, file.mediaType)}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

function Composer(props: {
  name: string;
  busy: boolean;
  stopping: boolean;
  filesEnabled: boolean;
  uploads: Upload[];
  onFiles: (files: FileList | File[]) => void;
  onRemoveUpload: (key: string) => void;
  onRetryUpload: (key: string) => void;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const hasFiles = props.uploads.length > 0;
  const canSend = text.trim().length > 0 || (hasFiles && props.uploads.every((upload) => upload.status !== "failed"));

  useLayoutEffect(() => {
    const node = input.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 200)}px`;
  }, [text]);

  const sendNow = () => {
    if (!canSend) return;
    props.onSend(text);
    setText("");
    input.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      sendNow();
    } else if (event.key === "Escape" && props.busy) {
      props.onStop();
    }
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!props.filesEnabled || event.clipboardData.files.length === 0) return;
    event.preventDefault();
    props.onFiles(event.clipboardData.files);
  };
  // While an answer is in progress, a typed message is still sent (it is answered next); an empty box offers Stop.
  const showStop = props.busy && !canSend;
  const multiline = hasFiles || text.includes("\n") || text.length > 70;

  return (
    <div
      className={`flex bg-[var(--wb-surface)] shadow-[var(--wb-composer-shadow)] transition-[border-radius] duration-150 ${
        hasFiles ? "flex-col gap-2 rounded-[24px] pb-2 pl-2.5 pr-2 pt-2.5" : `items-end gap-1 pl-[7px] pr-[7px] sm:pr-2 ${multiline ? "rounded-[24px] py-2" : "rounded-full py-[7px] sm:py-2"}`
      }`}
    >
      {hasFiles ? <UploadTray uploads={props.uploads} onRemove={props.onRemoveUpload} onRetry={props.onRetryUpload} /> : null}
      <div className={`flex flex-1 items-end gap-1 ${hasFiles ? "" : "contents"}`}>
        <AttachButton enabled={props.filesEnabled} onFiles={props.onFiles} />
        <textarea
          ref={input}
          value={text}
          rows={1}
          autoFocus
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={`Message ${props.name}`}
          aria-label={`Message ${props.name}`}
          className="max-h-[200px] min-h-9 flex-1 resize-none bg-transparent px-1.5 py-[7px] text-[16px] leading-[22px] text-[var(--wb-text)] outline-none placeholder:text-[var(--wb-faint)] sm:py-[9px] sm:text-[14px] sm:leading-[18px]"
        />
        <button
          type="button"
          onClick={showStop ? props.onStop : sendNow}
          disabled={showStop ? props.stopping : !canSend}
          aria-label={showStop ? "Stop" : "Send"}
          aria-keyshortcuts={showStop ? "Escape" : "Enter"}
          title={showStop ? "Stop (esc)" : "Send (⏎)"}
          className="grid size-9 shrink-0 place-items-center rounded-full bg-[var(--wb-ink)] text-[var(--wb-bg)] transition-colors duration-150 disabled:bg-[var(--wb-disabled)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"
        >
          {showStop ? <span aria-hidden className="h-2.75 w-2.75 rounded-[2.5px] bg-[var(--wb-bg)]" /> : <ArrowUp size={16} strokeWidth={2.25} aria-hidden />}
        </button>
      </div>
    </div>
  );
}
