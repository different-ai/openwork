"use client";

import { ArrowUp, ChevronRight, FileText, Lock } from "lucide-react";
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from "react";
import { setWorkbotHost, workbotHost, type WorkbotHost } from "./host";
import { OpenWorkMark } from "./mark";
import {
  useSendWorkbotMessage,
  useStopWorkbot,
  useWorkbotLive,
  useWorkbotThread,
  workbotFilesKey,
  type LiveText,
  type WorkbotAttachment,
  type WorkbotPart,
  type WorkbotStep,
  type WorkbotTurn,
} from "./data";
import { AppMark, AttachButton, FileBadge, FilesButton, FilesPanel, fileTypeColor, ImageThumb, isImage, kindLabel, SentAttachments, UploadTray, useFileDrop, useUploads, type Upload } from "./files";
import { durationLabel, initials } from "./format";
import { WorkbotMarkdown } from "./markdown";
import { OpenFileContext } from "./open-file";
import { PreviewPanel } from "./preview";
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
  const stream = useWorkbotLive(true);
  const thread = useWorkbotThread({ turns: turnWindow, awaiting: pending.some((entry) => !entry.failed), live: stream.connected });
  const send = useSendWorkbotMessage();
  const stop = useStopWorkbot();
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

  if (thread.isPending) return <WorkbotSkeleton />;
  if (thread.isError && !thread.data) {
    return (
      <Centered>
        <p className="text-[14px] text-[var(--wb-text)]">Couldn&apos;t load your conversation.</p>
        <button type="button" onClick={() => void thread.refetch()} className="mt-3 rounded-full px-3 py-1.5 text-[13px] font-medium text-[var(--wb-text)] hover:bg-[var(--wb-chip)] focus-visible:outline-2 focus-visible:outline-[var(--wb-ink)]">
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
      {empty ? (
        <FirstOpen name={data.name} organizationName={data.organizationName} firstName={firstName} onSuggestion={(text) => submit(text)}>
          {composer}
        </FirstOpen>
      ) : (
        <>
          <Conversation
            turns={data.turns}
            pending={pending}
            live={stream.live}
            hasEarlier={data.hasEarlier}
            loadingEarlier={thread.isFetching && turnWindow > data.turns.length}
            onLoadEarlier={() => setTurnWindow((current) => Math.min(200, current + PAGE_TURNS))}
            onRetry={(entry) => submit(entry.text, entry)}
            onRetryTurn={(turn) => submit(turn.text)}
          />
          <div className="flex shrink-0 justify-center px-3 pb-3 pt-3 sm:px-10 sm:pb-7">
            <div className={COLUMN}>{composer}</div>
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
          <span className="mt-1.5 h-24 w-[70%] rounded-[20px] rounded-bl-md bg-[var(--wb-bubble)]" />
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
          className="grid size-8 shrink-0 place-items-center rounded-full bg-[var(--wb-ink)] text-[11px] font-semibold tracking-[0.02em] text-[var(--wb-on-ink)] transition-opacity duration-150 hover:opacity-85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--wb-ink)]"
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
  const seeing = apps.length === 0 ? null : apps.length === 1 ? apps[0] : `${apps.slice(0, -1).join(", ")} and ${apps.at(-1)}`;
  const [now] = useState(() => Date.now());
  const hour = new Date(now).getHours();
  const hello = hour < 12 ? "Morning" : hour < 18 ? "Hi" : "Evening";
  return (
    <div className="flex flex-1 items-center justify-center overflow-y-auto px-4 pb-18 sm:px-10">
      <div className={`${COLUMN} flex flex-col gap-1`}>
        <div className="flex flex-col items-center gap-1.5 pb-7">
          <Mark name={props.name} size="hero" />
          <span className="pt-1 text-[15px] font-semibold leading-[18px] text-[var(--wb-text)]">{props.name}</span>
          <span className="text-[12px] leading-4 text-[var(--wb-muted)]">Set up by {props.organizationName}</span>
        </div>
        <div className="flex flex-col gap-[3px]">
          <Timestamp at={now} />
          <div className="flex">
            <p className="max-w-[520px] rounded-[20px] rounded-bl-md bg-[var(--wb-bubble)] px-3.5 py-[9px] text-[15px] leading-[21px] text-[var(--wb-text)] sm:text-[14px] sm:leading-5">
              {hello}{props.firstName ? ` ${props.firstName}` : ""}.{seeing ? ` I can already see your ${seeing}.` : ""}
            </p>
          </div>
          <div className="flex">
            <p className="max-w-[520px] rounded-[20px] rounded-tl-md bg-[var(--wb-bubble)] px-3.5 py-[9px] text-[15px] leading-[21px] text-[var(--wb-text)] sm:text-[14px] sm:leading-5">
              What can I take off your plate today?
            </p>
          </div>
        </div>
        <ul className="flex flex-wrap gap-2 py-[18px]">
          {suggestions.map((suggestion) => (
            <li key={suggestion.text}>
              <button
                type="button"
                onClick={() => props.onSuggestion(suggestion.text)}
                className="flex h-[34px] items-center gap-2 rounded-full bg-[var(--wb-surface)] pl-3 pr-3.5 text-[13px] leading-4 text-[var(--wb-text)] shadow-[0_0_0_1px_var(--wb-ring)] transition-shadow duration-150 hover:shadow-[0_0_0_1px_var(--wb-disabled)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--wb-ink)]"
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
              className="mx-auto mb-6 rounded-full px-3 py-1 text-[12px] font-medium text-[var(--wb-muted)] hover:bg-[var(--wb-chip)] hover:text-[var(--wb-text)] disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-[var(--wb-ink)]"
            >
              {props.loadingEarlier ? "Loading earlier messages" : "Show earlier messages"}
            </button>
          ) : null}
          <ol className="flex flex-col" aria-label="Conversation">
            {rows.map((row, index) => {
              const stamp = showsTimestamp(rows[index - 1], row);
              return (
                <li key={row.key} className={`flex flex-col gap-1 ${index > 0 ? (stamp ? "pt-9" : "pt-8") : ""}`}>
                  {stamp ? <Timestamp at={row.at} /> : null}
                  {row.turn ? (
                    <TurnView turn={row.turn} live={props.live[row.turn.id] ?? null} latest={row.turn.id === lastTurnId} previews={previews.current} onRetry={() => row.turn && props.onRetryTurn(row.turn)} />
                  ) : row.pending ? (
                    <PendingView entry={row.pending} onRetry={() => row.pending && props.onRetry(row.pending)} />
                  ) : null}
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </div>
  );
}

function UserBubble({ text, muted = false }: { text: string; muted?: boolean }) {
  if (!text) return null;
  return (
    <div className="flex justify-end">
      <p className={`max-w-[85%] whitespace-pre-wrap break-words rounded-[20px] bg-[var(--wb-user-bubble)] px-4 py-2.5 text-[15px] leading-[22px] text-[var(--wb-text)] transition-opacity duration-150 sm:max-w-[480px] ${muted ? "opacity-60" : ""}`}>
        {text}
      </p>
    </div>
  );
}

/** Workbot's words read as a page, not a chat bubble: plain text in the column. */
function AssistantBubble({ children }: { children: ReactNode }) {
  return <div className="flex flex-col py-1.5 pl-1">{children}</div>;
}

/**
 * Workbot thinking: a small reply bubble with three dots that darken in turn, where its answer will appear,
 * like a messaging app's typing indicator. Nothing else moves (DESIGN V6, P11).
 */
function TypingBubble() {
  return (
    <div className="workbot-row-enter flex pt-1.5 pl-1" role="status" aria-label="Thinking">
      <div className="flex h-8 items-center gap-[5px] rounded-full bg-[var(--wb-chip)] px-3">
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
      <UserBubble text={entry.text} muted={Boolean(entry.failed)} />
      {entry.failed ? (
        <p className="flex items-center justify-end gap-2 pt-1 text-[12px] leading-4 text-[var(--wb-muted)]">
          {entry.failed}
          <button type="button" onClick={onRetry} className="font-medium text-[var(--wb-text)] underline underline-offset-2">Send again</button>
        </p>
      ) : (
        <>
          <Gap />
          {uploading ? <LiveLine label="Uploading your files" since={entry.sentAt} /> : <TypingBubble />}
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
 * Sized for the 16px step slot (DESIGN V5); the motion belongs to the running step only and stops for reduced
 * motion (V6).
 */
function ComputerGlyph({ working }: { working: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width={16} height={16} fill="none" className={working ? "workbot-computer is-working" : "workbot-computer"}>
      <rect x="2.25" y="3" width="11.5" height="8" rx="1.75" className="workbot-computer-screen" strokeWidth={1.25} />
      <path d="M1.5 13h13" className="workbot-computer-stand" strokeWidth={1.25} strokeLinecap="round" />
      <path className="workbot-computer-line" d="M4.75 6h3.5" strokeWidth={1.25} strokeLinecap="round" />
      <path className="workbot-computer-line" d="M4.75 8.25h5.5" strokeWidth={1.25} strokeLinecap="round" />
    </svg>
  );
}

/** A file step's icon in its file type's color, read from the file name in the label. */
function FileGlyph({ label }: { label: string }) {
  const name = /([^\s/]+\.[A-Za-z0-9]{2,5})\b/.exec(label)?.[1] ?? "";
  return <FileText size={14} strokeWidth={1.75} style={{ color: fileTypeColor(name) }} />;
}

function StepIcon({ step, working = false }: { step: Pick<WorkbotStep, "icon" | "app" | "label">; working?: boolean }) {
  return (
    <span aria-hidden className="grid size-4 shrink-0 place-items-center text-[var(--wb-muted)]">
      {step.icon === "app" && step.app ? (
        <AppMark name={step.app} size={14} />
      ) : step.icon === "file" ? (
        <FileGlyph label={step.label} />
      ) : step.icon === "computer" ? (
        <ComputerGlyph working={working} />
      ) : (
        <span className={`h-1.5 w-1.5 rounded-full ${working ? "workbot-pulse bg-[var(--wb-muted)]" : "bg-[var(--wb-disabled)]"}`} />
      )}
    </span>
  );
}

/** Up to three distinct icons of a folded group, side by side, so the apps it worked in show at a glance. */
function StepIcons({ steps }: { steps: WorkbotStep[] }) {
  const seen = new Set<string>();
  const distinct = steps.filter((step) => {
    const key = step.icon === "app" ? `app:${step.app}` : step.icon;
    if (step.icon === "dot" || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const shown = (distinct.length ? distinct : steps.slice(0, 1)).slice(0, 3);
  return (
    <span aria-hidden className="flex shrink-0 items-center gap-1">
      {shown.map((step, index) => (
        <StepIcon key={index} step={step} />
      ))}
    </span>
  );
}

/** The one line that says what is happening right now. Shimmer only here (DESIGN V6). */
function LiveLine({ label, since, step }: { label: string; since: number | null; step?: Pick<WorkbotStep, "icon" | "app" | "label"> }) {
  const now = useNow();
  const elapsed = since ? Math.max(0, now - since) : 0;
  return (
    <p className="flex h-6 shrink-0 items-center gap-2 pl-1" role="status" aria-live="polite">
      <StepIcon step={step ?? { icon: "dot", app: null, label }} working />
      <span className={step ? "workbot-shimmer text-[13px] leading-4" : "text-[13px] leading-4 text-[var(--wb-faint)]"}>{label}</span>
      {elapsed >= 1_000 ? <span className="text-[12px] leading-4 tabular-nums text-[var(--wb-faint)]">{durationLabel(elapsed)}</span> : null}
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
  useEffect(() => {
    const goal = target.length;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || shownRef.current > goal) {
      shownRef.current = goal;
      setShown(goal);
      return;
    }
    let frame = 0;
    const tick = () => {
      const current = shownRef.current;
      if (current >= goal) return;
      // About 12 frames to catch up with whatever is buffered, never slower than 2 characters a frame.
      shownRef.current = Math.min(goal, current + Math.max(2, Math.ceil((goal - current) / 12)));
      setShown(shownRef.current);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target.length]);
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

function stepDuration(steps: WorkbotStep[]) {
  const started = steps.find((step) => step.startedAt)?.startedAt ?? null;
  const ended = steps.reduce<number | null>((latest, step) => (step.finishedAt && (!latest || step.finishedAt > latest) ? step.finishedAt : latest), null);
  return started && ended ? durationLabel(ended - started) : null;
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** One sentence for a folded group: "Searched Slack and checked Gmail", "Worked in Slack and Notion", "Used my computer". */
function groupLabel(steps: WorkbotStep[]) {
  const [first, second] = steps;
  if (!first) return "";
  if (!second) return first.label;
  // The same step twice ("Updated memory") reads once.
  if (steps.every((step) => step.label === first.label)) return first.label;
  const apps = [...new Set(steps.flatMap((step) => (step.app ? [step.app] : [])))];
  const computer = steps.some((step) => step.icon === "computer");
  // Its computer leads the summary; files it opened along the way are in the details.
  if (computer && !apps.length) return "Used my computer";
  if (steps.length === 2 && !computer) return `${first.label} and ${lowerFirst(second.label)}`;
  const places = computer ? [...apps, "my computer"] : apps;
  if (places.length) return `Worked in ${places.length === 1 ? places[0] : `${places.slice(0, -1).join(", ")} and ${places.at(-1)}`}`;
  return `${first.label} and ${steps.length - 1} more`;
}

/** What it did on its computer, in its own words, under the step. */
function Updates({ updates }: { updates: string[] }) {
  return (
    <ul className="flex flex-col gap-1">
      {updates.map((update, index) => (
        <li key={index} className="flex items-center gap-2 text-[12px] leading-4 text-[var(--wb-muted)]">
          <span aria-hidden className="h-1 w-1 shrink-0 rounded-full bg-[var(--wb-computer-line)]" />
          <span className="truncate">{update}</span>
        </li>
      ))}
    </ul>
  );
}

/** A finished step folds to one quiet line; several fold to one summary line. Both open inline (DESIGN T1, S3). */
function StepsLine({ steps }: { steps: WorkbotStep[] }) {
  const failed = steps.filter((step) => step.status === "error").length;
  const label = groupLabel(steps);
  const duration = stepDuration(steps);
  const single = steps.length === 1 ? steps[0] : undefined;
  const meta = (
    <>
      {failed ? <span className="shrink-0 text-[12px] leading-4 text-[var(--wb-faint)]">{failed === steps.length ? "didn't work" : `${failed} didn't work`}</span> : null}
      {duration ? <span className="shrink-0 text-[12px] leading-4 tabular-nums text-[var(--wb-faint)]">{duration}</span> : null}
    </>
  );
  // A single step with nothing more to say stays a plain line.
  if (single && !single.updates.length) {
    return (
      <p className="flex h-6 w-fit max-w-full items-center gap-2 pl-1">
        <StepIcon step={single} />
        <span className="truncate text-[13px] leading-4 text-[var(--wb-muted)]">{single.label}</span>
        {meta}
      </p>
    );
  }
  return (
    <details className="workbot-details group">
      <summary className="flex h-6 w-fit max-w-full cursor-pointer list-none items-center gap-2 rounded pl-1 hover:[&>span.label]:text-[var(--wb-text)] focus-visible:outline-2 focus-visible:outline-[var(--wb-ink)] [&::-webkit-details-marker]:hidden">
        {single ? <StepIcon step={single} /> : <StepIcons steps={steps} />}
        <span className="label truncate text-[13px] leading-4 text-[var(--wb-muted)] transition-colors duration-150">{label}</span>
        {meta}
        <ChevronRight size={12} strokeWidth={1.75} aria-hidden className="shrink-0 text-[var(--wb-faint)] transition-transform duration-150 group-open:rotate-90" />
      </summary>
      <div className="ml-[11px] mt-1 border-l border-[var(--wb-hairline)] pb-1 pl-4">
        {single ? (
          <Updates updates={single.updates} />
        ) : (
          <ol className="flex flex-col gap-1.5">
            {steps.map((step, index) => (
              <li key={index} className="flex flex-col gap-1">
                <span className="flex items-center gap-2 text-[12px] leading-4 text-[var(--wb-muted)]">
                  <StepIcon step={step} />
                  <span className="truncate">{step.label}</span>
                  {step.status === "error" ? <span className="shrink-0 text-[var(--wb-faint)]">didn&apos;t work</span> : null}
                  {step.startedAt && step.finishedAt ? <span className="shrink-0 tabular-nums text-[var(--wb-faint)]">{durationLabel(step.finishedAt - step.startedAt)}</span> : null}
                </span>
                {step.updates.length ? (
                  <div className="pl-6">
                    <Updates updates={step.updates} />
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </div>
    </details>
  );
}

type LedgerRow = { key: string; label: string; step: WorkbotStep; state: "running" | "done" | "error"; since: number | null; subtitle?: string };

/** The rows of a group at work: one per step; its computer's newest update rides under its row. */
function ledgerRows(steps: WorkbotStep[], starting: LiveText["working"] | null): LedgerRow[] {
  const rows = steps.map((step, index): LedgerRow => {
    const state = step.status === "running" ? "running" : step.status === "error" ? "error" : "done";
    // Its computer is one row; while it works, its newest update in its own words sits underneath.
    const subtitle = step.icon === "computer" && state === "running" ? step.updates.at(-1) : undefined;
    return { key: `${index}`, label: step.label, step, state, since: step.startedAt, subtitle };
  });
  // The model has started writing its next command: the computer row is at work again right away.
  if (starting?.on === "computer" && !rows.some((row) => row.state === "running")) {
    const previous = rows.at(-1);
    if (previous?.step.icon === "computer") {
      rows[rows.length - 1] = { ...previous, label: "Using my computer", state: "running" };
    } else {
      rows.push({ key: "starting", label: "Using my computer", step: { label: "Using my computer", icon: "computer", status: "running", app: null, startedAt: starting.since, finishedAt: null, updates: [] }, state: "running", since: starting.since });
    }
  }
  return rows;
}

/** A pause between steps shorter than this shows nothing, so quick hops between steps don't flicker the typing bubble. */
const THINKING_AFTER_MS = 2_000;

/** How many rows of a group at work stay in view; older ones fade out at the top. */
const LEDGER_ROWS = 4;

function LedgerLine({ row }: { row: LedgerRow }) {
  const now = useNow();
  const elapsed = row.state === "running" && row.since ? Math.max(0, now - row.since) : 0;
  return (
    <li className="workbot-row-enter flex flex-col pl-1">
      <span className="flex h-6 items-center gap-2">
        <StepIcon step={row.step} working={row.state === "running"} />
        <span className={row.state === "running" ? "workbot-shimmer truncate text-[13px] leading-4" : "truncate text-[13px] leading-4 text-[var(--wb-faint)]"}>{row.label}</span>
        {row.state === "error" ? <span className="shrink-0 text-[12px] leading-4 text-[var(--wb-faint)]">didn&apos;t work</span> : null}
        {elapsed >= 1_000 ? <span className="shrink-0 text-[12px] leading-4 tabular-nums text-[var(--wb-faint)]">{durationLabel(elapsed)}</span> : null}
      </span>
      {row.subtitle ? (
        // Keyed by the text, so each new update fades in over the last one.
        <span key={row.subtitle} className="workbot-subtitle-enter -mt-0.5 truncate pb-1 pl-6 text-[12px] leading-4 text-[var(--wb-faint)]">
          {row.subtitle}
        </span>
      ) : null}
    </li>
  );
}

/**
 * A group while Workbot works on it: its last few steps, the current one shimmering with its time, the ones
 * before it quiet. It stays put between steps (a longer pause shows the typing bubble) so the list
 * never collapses and reopens (DESIGN P11, T1).
 */
function LiveLedger({ steps, thinking, starting = null }: { steps: WorkbotStep[]; thinking: boolean; starting?: LiveText["working"] | null }) {
  const now = useNow();
  const lastFinished = steps.reduce<number | null>((latest, step) => (step.finishedAt && (!latest || step.finishedAt > latest) ? step.finishedAt : latest), null);
  const rows = ledgerRows(steps, starting);
  // Between steps nothing shows at first; a longer pause, or a step that isn't on its computer, brings the
  // typing bubble where the reply will go.
  const typing =
    thinking && !rows.some((row) => row.state === "running") && (starting?.on === "other" || lastFinished === null || now - lastFinished >= THINKING_AFTER_MS);
  const shown = rows.slice(-LEDGER_ROWS);
  const current = [...rows].reverse().find((row) => row.state === "running");
  return (
    <div role="status" aria-live="polite" aria-label={current?.label}>
      <ol className={rows.length > shown.length ? "workbot-ledger-earlier flex flex-col" : "flex flex-col"}>
        {shown.map((row) => (
          <LedgerLine key={row.key} row={row} />
        ))}
      </ol>
      {typing ? <TypingBubble /> : null}
    </div>
  );
}

function PartView({ part, live, starting }: { part: WorkbotPart; live: boolean; starting: LiveText["working"] | null }) {
  // When a group finishes, its list settles into the one-line summary with a soft fade, never on page load.
  const [wasLive, setWasLive] = useState(live);
  const [settled, setSettled] = useState(false);
  if (wasLive !== live) {
    setWasLive(live);
    if (!live) setSettled(true);
  }
  if (part.kind === "text") {
    return (
      <AssistantBubble>
        <WorkbotMarkdown text={part.text} />
      </AssistantBubble>
    );
  }
  if (live) return <LiveLedger steps={part.steps} thinking starting={starting} />;
  return (
    <div className={settled ? "workbot-settle" : undefined}>
      <StepsLine steps={part.steps} />
    </div>
  );
}

function TurnView(props: { turn: WorkbotTurn; live: LiveText | null; latest: boolean; previews: Record<string, string | null>; onRetry: () => void }) {
  const { turn } = props;
  const working = turn.status === "working" || turn.status === "queued";
  // The model call in progress (not stored yet): its text so far, and whether it has started a step.
  const current = working && props.live && props.live.step >= turn.modelSteps ? props.live : null;
  const liveText = current?.text ?? "";
  const starting = current?.working ?? null;
  const last = turn.parts.at(-1);
  // While it works, the newest group of steps stays live: it shows the step starting, or the typing bubble.
  const liveGroup = working && !liveText && last?.kind === "steps";
  const showThinking = working && !liveText && !liveGroup && !starting;
  return (
    <>
      <SentAttachments attachments={turn.attachments} localUrls={props.previews} />
      <UserBubble text={turn.text} />
      {turn.parts.length > 0 || liveText || showThinking || starting ? <Gap /> : null}
      {turn.parts.map((part, index) => (
        <PartView key={index} part={part} live={liveGroup && index === turn.parts.length - 1} starting={starting} />
      ))}
      {liveText ? (
        <AssistantBubble>
          <StreamingText text={liveText} />
        </AssistantBubble>
      ) : null}
      {/* Writing the instructions for a step can take a while (a long script): show the step starting now. */}
      {starting && !liveGroup ? <LiveLedger steps={[]} thinking starting={starting} /> : null}
      {showThinking ? turn.status === "queued" ? <LiveLine label="Up next" since={null} /> : <TypingBubble /> : null}
      {turn.outputs.length ? <OutputFiles files={turn.outputs} /> : null}
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
          className="flex min-w-0 max-w-full items-center gap-3 rounded-[14px] bg-[var(--wb-surface)] py-2 pl-2 pr-4 text-left shadow-[var(--wb-card-shadow)] transition-shadow duration-150 ease-out hover:shadow-[var(--wb-card-shadow-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--wb-ink)] sm:max-w-[320px]"
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
          className="grid size-9 shrink-0 place-items-center rounded-full bg-[var(--wb-ink)] text-[var(--wb-bg)] transition-colors duration-150 disabled:bg-[var(--wb-disabled)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--wb-ink)]"
        >
          {showStop ? <span aria-hidden className="h-2.75 w-2.75 rounded-[2.5px] bg-[var(--wb-bg)]" /> : <ArrowUp size={16} strokeWidth={2.25} aria-hidden />}
        </button>
      </div>
    </div>
  );
}
