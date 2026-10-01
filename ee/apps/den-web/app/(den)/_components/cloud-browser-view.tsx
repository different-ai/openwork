"use client";

import { Check, Globe, Lock, Maximize2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ClipboardEvent } from "react";
import {
  addressLabel,
  clampWheel,
  framePoint,
  keyIntent,
  siteHost,
  takeBatch,
  textEvents,
  type TakeoverEvent,
} from "../_lib/cloud-browser-input";
import { requestBlob, requestJson } from "../_lib/den-flow";
import { DenButton } from "./ui/button";

/**
 * The person's live view of their cloud browser, for agent hand-offs: the
 * agent opened a site that needs a sign-in, the person takes over, signs in
 * themselves (straight to the site), and chooses Done so the sign-in is kept.
 *
 * Polls the screen about twice a second, only while the view is on screen and
 * the browser is running. "card" sits in a chat thread; "page" is the full
 * view that hand-off links from Slack and Automations open.
 */
export type CloudBrowserViewProps = {
  assistantName: string;
  siteLabel?: string;
  onDone?: () => void;
  onSkip?: () => void;
  variant?: "card" | "page";
  /** Card only: the full view, opened by the header's expand action. */
  expandHref?: string;
};

type CloudBrowserStatus = { available: boolean; running: boolean; url: string | null; title: string | null };

const FRAME_INTERVAL_MS = 500;
const STATUS_INTERVAL_MS = 2_000;
const IDLE_STATUS_INTERVAL_MS = 5_000;
const OFF_STATUS_INTERVAL_MS = 30_000;
const WHEEL_FLUSH_MS = 120;
const WHEEL_LINE_PX = 40;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseStatus(payload: unknown): CloudBrowserStatus | null {
  if (!isRecord(payload) || typeof payload.available !== "boolean" || typeof payload.running !== "boolean") return null;
  return {
    available: payload.available,
    running: payload.running,
    url: typeof payload.url === "string" ? payload.url : null,
    title: typeof payload.title === "string" ? payload.title : null,
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** On screen and in a visible tab. */
function useVisible(element: HTMLElement | null): boolean {
  const [onScreen, setOnScreen] = useState(true);
  const [pageVisible, setPageVisible] = useState(true);
  useEffect(() => {
    const update = () => setPageVisible(document.visibilityState === "visible");
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  useEffect(() => {
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => setOnScreen(entries.some((entry) => entry.isIntersecting)));
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return onScreen && pageVisible;
}

function StatusLabel({ tone, children }: { tone: "attention" | "neutral" | "done"; children: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-[12px] font-medium text-[var(--dls-text-secondary)]">
      {tone === "done" ? (
        <Check size={16} strokeWidth={1.5} aria-hidden />
      ) : (
        <span aria-hidden className={`size-1.5 rounded-full ${tone === "attention" ? "bg-amber-500" : "bg-gray-400"}`} />
      )}
      <span className={tone === "attention" ? "text-amber-700" : undefined}>{children}</span>
    </span>
  );
}

export function CloudBrowserView({ assistantName, siteLabel, onDone, onSkip, variant = "card", expandHref }: CloudBrowserViewProps) {
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const visible = useVisible(root);
  const [status, setStatus] = useState<CloudBrowserStatus | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [frameStale, setFrameStale] = useState(false);
  const [controlling, setControlling] = useState(false);
  const [finished, setFinished] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const queue = useRef<TakeoverEvent[]>([]);
  const sending = useRef(false);
  const refreshFrame = useRef<() => void>(() => {});

  const running = status?.available === true && status.running;
  const site = siteLabel?.trim() || siteHost(status?.url ?? null) || "the site";
  const address = addressLabel(status?.url ?? null);

  const refreshStatus = useCallback(async (): Promise<CloudBrowserStatus | null> => {
    try {
      const { response, payload } = await requestJson("/v1/cloud-browser", { method: "GET" }, 10_000);
      const parsed = response.ok ? parseStatus(payload) : null;
      setStatusFailed(parsed === null);
      if (parsed) setStatus(parsed);
      return parsed;
    } catch {
      setStatusFailed(true);
      return null;
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const current = await refreshStatus();
      if (cancelled) return;
      const interval = !current ? IDLE_STATUS_INTERVAL_MS : !current.available ? OFF_STATUS_INTERVAL_MS : current.running ? STATUS_INTERVAL_MS : IDLE_STATUS_INTERVAL_MS;
      timer = setTimeout(() => void tick(), interval);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [visible, refreshStatus]);

  useEffect(() => {
    if (!visible || !running) return;
    let cancelled = false;
    const pause: { timer: ReturnType<typeof setTimeout> | undefined; wake: (() => void) | null } = { timer: undefined, wake: null };
    const loop = async () => {
      while (!cancelled) {
        const started = Date.now();
        try {
          const { response, blob } = await requestBlob("/v1/cloud-browser/screen", { method: "GET" });
          if (cancelled) return;
          if (blob) {
            setFrameUrl(URL.createObjectURL(blob));
            setFrameStale(false);
          } else if (response.status === 409) {
            void refreshStatus();
            return;
          } else {
            setFrameStale(true);
          }
        } catch {
          if (cancelled) return;
          setFrameStale(true);
        }
        await new Promise<void>((resolve) => {
          pause.wake = resolve;
          pause.timer = setTimeout(resolve, Math.max(0, FRAME_INTERVAL_MS - (Date.now() - started)));
        });
        pause.wake = null;
      }
    };
    refreshFrame.current = () => {
      if (pause.timer !== undefined) clearTimeout(pause.timer);
      pause.wake?.();
    };
    void loop();
    return () => {
      cancelled = true;
      refreshFrame.current();
      refreshFrame.current = () => {};
    };
  }, [visible, running, refreshStatus]);

  useEffect(() => () => {
    if (frameUrl) URL.revokeObjectURL(frameUrl);
  }, [frameUrl]);

  useEffect(() => {
    if (!running) setControlling(false);
  }, [running]);

  const flush = useCallback(async () => {
    if (sending.current) return;
    sending.current = true;
    try {
      while (queue.current.length > 0) {
        const events = takeBatch(queue.current);
        const { response } = await requestJson("/v1/cloud-browser/input", { method: "POST", body: JSON.stringify({ events }) }, 10_000);
        if (!response.ok) {
          queue.current = [];
          if (response.status === 409) void refreshStatus();
          else setProblem("Your browser didn't get that. Try again.");
          return;
        }
        refreshFrame.current();
      }
    } catch {
      queue.current = [];
      setProblem("Your browser didn't get that. Try again.");
    } finally {
      sending.current = false;
    }
  }, [refreshStatus]);

  const send = useCallback((...events: TakeoverEvent[]) => {
    if (events.length === 0) return;
    setProblem(null);
    queue.current.push(...events);
    void flush();
  }, [flush]);

  const pointFor = useCallback((clientX: number, clientY: number) => {
    const image = imageRef.current;
    if (!image) return null;
    const rect = image.getBoundingClientRect();
    return framePoint({ clientX, clientY, rect, natural: { width: image.naturalWidth, height: image.naturalHeight } });
  }, []);

  useEffect(() => {
    const element = frameRef.current;
    if (!element || !controlling) return;
    element.focus();
    const pending: { deltaY: number; x: number; y: number; timer: number | undefined } = { deltaY: 0, x: 0, y: 0, timer: undefined };
    const onWheel = (event: WheelEvent) => {
      const point = pointFor(event.clientX, event.clientY);
      if (!point) return;
      event.preventDefault();
      pending.deltaY += event.deltaMode === 1 ? event.deltaY * WHEEL_LINE_PX : event.deltaY;
      pending.x = point.x;
      pending.y = point.y;
      if (pending.timer !== undefined) return;
      pending.timer = window.setTimeout(() => {
        pending.timer = undefined;
        const deltaY = clampWheel(pending.deltaY);
        pending.deltaY = 0;
        if (deltaY !== 0) send({ type: "wheel", x: pending.x, y: pending.y, deltaY });
      }, WHEEL_FLUSH_MS);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      element.removeEventListener("wheel", onWheel);
      if (pending.timer !== undefined) window.clearTimeout(pending.timer);
    };
  }, [controlling, pointFor, send]);

  function onFrameClick(event: MouseEvent<HTMLDivElement>) {
    if (!controlling) return;
    const point = pointFor(event.clientX, event.clientY);
    if (point) send({ type: "click", ...point, clickCount: Math.min(3, Math.max(1, event.detail)) });
  }

  function onFrameKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!controlling) return;
    const intent = keyIntent(event);
    if (!intent) return;
    event.preventDefault();
    send(intent);
  }

  function onFramePaste(event: ClipboardEvent<HTMLDivElement>) {
    if (!controlling) return;
    event.preventDefault();
    send(...textEvents(event.clipboardData.getData("text/plain")));
  }

  async function finish() {
    setFinishing(true);
    setProblem(null);
    try {
      // Deliver everything the person typed before keeping the sign-in.
      for (let waited = 0; (sending.current || queue.current.length > 0) && waited < 5_000; waited += 50) await sleep(50);
      const { response } = await requestJson("/v1/cloud-browser/done", { method: "POST", body: "{}" }, 15_000);
      if (!response.ok) {
        setProblem(response.status === 409 ? `Your browser closed before saving. Ask ${assistantName} to open the site again.` : "Couldn't save your sign-in. Choose Done again.");
        return;
      }
      setControlling(false);
      setFinished(true);
      onDone?.();
    } catch {
      setProblem("Couldn't save your sign-in. Choose Done again.");
    } finally {
      setFinishing(false);
    }
  }

  const label = finished
    ? <StatusLabel tone="done">Saved for next time</StatusLabel>
    : !status
      ? null
      : !status.available
        ? <StatusLabel tone="neutral">Off</StatusLabel>
        : !status.running
          ? <StatusLabel tone="neutral">Not open</StatusLabel>
          : frameStale
            ? <StatusLabel tone="neutral">Not updating</StatusLabel>
            : controlling
              ? <StatusLabel tone="neutral">You're in control</StatusLabel>
              : <StatusLabel tone="attention">Waiting for you</StatusLabel>;

  const body = !status
    ? statusFailed
      ? (
        <div className="flex aspect-[16/9] w-full flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="text-[13px] text-[var(--dls-text-secondary)]">Couldn't reach your cloud browser.</p>
          <DenButton variant="secondary" size="sm" onClick={() => void refreshStatus()}>Retry</DenButton>
        </div>
      )
      : <div className="aspect-[16/9] w-full bg-[var(--dls-hover)]" aria-hidden />
    : !status.available
      ? (
        <div className="flex aspect-[16/9] w-full items-center justify-center gap-2 px-6 text-center text-[13px] text-[var(--dls-text-secondary)]">
          <Lock size={16} strokeWidth={1.5} aria-hidden />
          <p>Cloud browser isn't on for this workspace. OpenWork support can turn it on.</p>
        </div>
      )
      : !status.running && !frameUrl
        ? (
          <div className="flex aspect-[16/9] w-full items-center justify-center px-6 text-center">
            <p className="text-[13px] text-[var(--dls-text-secondary)]">Nothing is open. Ask {assistantName} to open the site again.</p>
          </div>
        )
        : (
          <div
            ref={frameRef}
            role="group"
            tabIndex={controlling ? 0 : -1}
            aria-label={controlling ? `${site}, controlled by you` : `${site}, live view`}
            onClick={onFrameClick}
            onKeyDown={onFrameKeyDown}
            onPaste={onFramePaste}
            className="relative block w-full bg-[var(--dls-hover)] outline-none"
          >
            {frameUrl ? (
              <img
                ref={imageRef}
                src={frameUrl}
                alt=""
                draggable={false}
                className={["block h-auto w-full select-none", frameStale || !status.running ? "opacity-60" : ""].join(" ")}
              />
            ) : (
              <div className="aspect-[16/9] w-full" aria-hidden />
            )}
            {controlling ? <span aria-hidden className="pointer-events-none absolute inset-0 ring-2 ring-inset ring-[var(--dls-accent)]" /> : null}
          </div>
        );

  const showFooter = status?.available === true && (status.running || finished);

  return (
    <section
      ref={setRoot}
      aria-label={`Cloud browser for ${site}`}
      className={[
        "w-full overflow-hidden border border-[var(--dls-border)] bg-[var(--dls-surface)]",
        variant === "card" ? "max-w-[720px] rounded-[var(--dls-radius,16px)]" : "rounded-[var(--dls-radius,16px)]",
      ].join(" ")}
    >
      <header className="flex h-10 items-center gap-2 border-b border-[var(--dls-border)] px-3">
        {status?.url?.startsWith("https:") ? (
          <Lock size={16} strokeWidth={1.5} className="shrink-0 text-[var(--dls-text-secondary)]" aria-hidden />
        ) : (
          <Globe size={16} strokeWidth={1.5} className="shrink-0 text-[var(--dls-text-secondary)]" aria-hidden />
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--dls-text-primary)]">{address || site}</span>
        {label}
        {variant === "card" && expandHref && running ? (
          <a
            href={expandHref}
            target="_blank"
            rel="noreferrer"
            aria-label="Open full view"
            className="flex size-7 shrink-0 items-center justify-center rounded-[var(--radius,0.45rem)] text-[var(--dls-text-secondary)] transition-colors hover:bg-[var(--dls-hover)] hover:text-[var(--dls-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--dls-accent)]"
          >
            <Maximize2 size={16} strokeWidth={1.5} aria-hidden />
          </a>
        ) : null}
      </header>
      {body}
      {problem ? (
        <p role="alert" className="border-t border-[var(--dls-border)] px-3 py-2 text-[12px] text-red-600">{problem}</p>
      ) : null}
      {showFooter ? (
        <footer className="flex flex-wrap items-center gap-3 border-t border-[var(--dls-border)] px-3 py-2.5">
          <p className="min-w-0 flex-1 text-[13px] text-[var(--dls-text-secondary)]">
            {finished ? `Tell ${assistantName} you're done.` : `Your password goes to ${site}, not ${assistantName}`}
          </p>
          {onSkip && !finished ? (
            <DenButton variant="secondary" size="sm" onClick={onSkip}>Skip for now</DenButton>
          ) : null}
          {finished ? null : controlling ? (
            <DenButton size="sm" loading={finishing} onClick={() => void finish()}>Done</DenButton>
          ) : (
            <DenButton size="sm" disabled={!frameUrl || !status.running} onClick={() => setControlling(true)}>Take over</DenButton>
          )}
        </footer>
      ) : null}
    </section>
  );
}
