/** @jsxImportSource react */
import { useEffect, useLayoutEffect, useRef, useState, type PropsWithChildren } from "react";
import { create } from "zustand";
import { ChevronRight, LoaderCircle } from "lucide-react";
import {
  createOpenworkServerClient,
  type EngineStatus,
  type EngineV2MigrationStatus,
  type OpenworkServerClient,
} from "@/app/lib/openwork-server";
import { isDesktopRuntime } from "@/app/lib/runtime-env";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { resolveOpenworkConnection } from "./openwork-connection";

/**
 * The one-time import of chats from the retired OpenCode v1 engine. A notice
 * requires it while v1 history remains without a completed receipt. Consent,
 * progress and retry stay visible until the upgrade finishes.
 */

export const CHAT_HISTORY_IMPORTED_EVENT = "openwork-history-imported";

export type ChatImportClient = Pick<OpenworkServerClient, "getEngineStatus" | "importV1History">;

type ConsentState = {
  client: ChatImportClient;
  submitting: boolean;
  error: string | null;
};

type ProgressState = {
  client: ChatImportClient;
  migration: EngineV2MigrationStatus;
  view: "dialog" | "banner";
  retrying: boolean;
};

type ChatImportState = {
  consent: ConsentState | null;
  progress: ProgressState | null;
};

const initialState: ChatImportState = { consent: null, progress: null };

export const useChatImportStore = create<ChatImportState>(() => initialState);

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

const formatCount = (value: number) => new Intl.NumberFormat().format(value);

/** Chats dealt with so far: copied, already here, or left behind. */
const handledCount = (migration: EngineV2MigrationStatus) =>
  migration.imported + migration.skipped + (migration.notCopied?.length ?? 0);

function importedSummary(migration: EngineV2MigrationStatus) {
  const summary = t("chat_import.summary", {
    count: migration.imported,
    imported: formatCount(migration.imported),
    skipped: formatCount(migration.skipped),
  });
  const left = migration.notCopied?.length ?? 0;
  return left ? `${summary} ${t("chat_import.not_copied", { count: left, left: formatCount(left) })}` : summary;
}

function updateConsent(client: ChatImportClient, patch: Partial<Omit<ConsentState, "client">>) {
  useChatImportStore.setState((state) =>
    state.consent?.client === client ? { consent: { ...state.consent, ...patch } } : state);
}

function updateProgress(patch: Partial<ProgressState>) {
  useChatImportStore.setState((state) =>
    state.progress ? { progress: { ...state.progress, ...patch } } : state);
}

function showImportProgress() {
  updateProgress({ view: "dialog" });
}

/** Open the import consent. An import that is already running is shown instead. */
function requestChatImport(client: ChatImportClient) {
  const { progress } = useChatImportStore.getState();
  if (progress?.migration.state === "running") {
    showImportProgress();
    return;
  }
  useChatImportStore.setState({ consent: { client, submitting: false, error: null } });
}

async function confirmChatImport() {
  const consent = useChatImportStore.getState().consent;
  if (!consent || consent.submitting) return;
  updateConsent(consent.client, { submitting: true, error: null });
  try {
    const status = await consent.client.importV1History();
    useChatImportStore.setState({ consent: null });
    if (status.migration) {
      useChatImportStore.setState({
        progress: { client: consent.client, migration: status.migration, view: "dialog", retrying: false },
      });
    }
  } catch (cause) {
    updateConsent(consent.client, { submitting: false, error: messageOf(cause, t("chat_import.start_failed")) });
  }
}

/** Status reads from any surface: present a running import nobody is showing yet. */
function observeChatImport(client: ChatImportClient, status: EngineStatus) {
  const migration = status.migration;
  if (!migration) return;
  if (migration.state === "completed" && useChatImportStore.getState().progress?.migration.state !== "completed") {
    window.dispatchEvent(new Event(CHAT_HISTORY_IMPORTED_EVENT));
  }
  if (useChatImportStore.getState().progress) {
    updateProgress({ migration });
    return;
  }
  if (migration.state === "running" || migration.state === "error") {
    useChatImportStore.setState({ progress: { client, migration, view: "dialog", retrying: false } });
  }
}

/** A running import can only move to the background; a finished one is dismissed. */
function closeImportProgress() {
  useChatImportStore.setState((state) => {
    if (!state.progress) return state;
    if (state.progress.migration.state === "running") return { progress: { ...state.progress, view: "banner" } };
    return { progress: null };
  });
}

async function retryChatImport() {
  const progress = useChatImportStore.getState().progress;
  if (!progress || progress.retrying) return;
  updateProgress({ retrying: true });
  try {
    const status = await progress.client.importV1History();
    updateProgress({ migration: status.migration ?? progress.migration, retrying: false, view: "dialog" });
  } catch (cause) {
    updateProgress({
      retrying: false,
      migration: { ...progress.migration, error: messageOf(cause, t("chat_import.start_failed")) },
    });
  }
}

function useElapsed(startedAt: string | undefined, running: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);
  const started = startedAt ? Date.parse(startedAt) : Number.NaN;
  if (!Number.isFinite(started)) return null;
  const seconds = Math.max(0, Math.floor((now - started) / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function ImportProgressBar(props: { migration: EngineV2MigrationStatus }) {
  const { migration } = props;
  const done = handledCount(migration);
  const copying = migration.phase === "copying" || (migration.phase === undefined && done > 0);
  const elapsed = useElapsed(migration.startedAt, migration.state === "running");
  const value = copying && migration.total > 0 ? Math.min(100, Math.round((done / migration.total) * 100)) : null;
  const label = copying && migration.total > 0
    ? t("chat_import.progress_copied", { done: formatCount(done), total: formatCount(migration.total) })
    : migration.total > 0
      ? t("chat_import.progress_total", { count: migration.total, total: formatCount(migration.total) })
      : "";
  return (
    <div className="grid gap-2">
      <Progress
        value={value}
        aria-label={t("chat_import.progress_title")}
        className={cn(
          "w-full",
          value === null && "[&_[data-slot=progress-indicator]]:w-1/3 [&_[data-slot=progress-indicator]]:animate-progress-shimmer motion-reduce:[&_[data-slot=progress-indicator]]:animate-none",
        )}
      />
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground tabular-nums">
        <span data-testid="chat-import-count">{label}</span>
        {elapsed ? <span>{elapsed}</span> : null}
      </div>
    </div>
  );
}

function ImportConsentDialog(props: { consent: ConsentState }) {
  const { consent } = props;
  return (
    <AlertDialog open>
      <AlertDialogContent data-testid="chat-import-consent">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("chat_import.consent_title")}</AlertDialogTitle>
          <AlertDialogDescription>{t("chat_import.consent_body")}</AlertDialogDescription>
        </AlertDialogHeader>
        {consent.error ? <Alert variant="destructive"><AlertDescription>{consent.error}</AlertDescription></Alert> : null}
        <details className="group text-xs text-muted-foreground">
          <summary className="flex cursor-pointer list-none items-center gap-1 select-none hover:text-foreground">
            <ChevronRight className="size-3.5 transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none" />
            {t("chat_import.what_changes")}
          </summary>
          <ul className="mt-2 grid list-disc gap-1 ps-8">
            <li>{t("chat_import.change_permissions")}</li>
            <li>{t("chat_import.change_attachments")}</li>
          </ul>
        </details>
        <AlertDialogFooter>

          <Button data-testid="chat-import-confirm" disabled={consent.submitting} onClick={() => void confirmChatImport()}>
            {t("chat_import.import")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ImportProgressDialog(props: { progress: ProgressState }) {
  const { progress } = props;
  const { migration } = progress;
  const running = migration.state === "running";
  return (
    <Dialog open onOpenChange={(open) => { if (!open && migration.state === "completed") closeImportProgress(); }}>
      <DialogContent showCloseButton={false} data-testid="chat-import-progress" data-state-kind={migration.state}>
        <DialogHeader>
          <DialogTitle>
            {running ? t("chat_import.progress_title")
              : migration.state === "completed" ? t("chat_import.done_title")
                : t("chat_import.error_title")}
          </DialogTitle>
          <DialogDescription>
            {running ? t("chat_import.progress_note")
              : migration.state === "completed" ? importedSummary(migration)
                : migration.error}
          </DialogDescription>
        </DialogHeader>
        {running ? <ImportProgressBar migration={migration} /> : null}
        {migration.state === "completed" && migration.notCopied?.length ? (
          <ul data-testid="chat-import-not-copied" className="grid max-h-32 list-disc gap-1 overflow-y-auto ps-5 text-xs text-muted-foreground">
            {migration.notCopied.map((chat) => <li key={chat.id} className="truncate">{chat.title || chat.id}</li>)}
          </ul>
        ) : null}
        {migration.state === "error" ? <p className="text-xs text-muted-foreground">{t("chat_import.error_note")}</p> : null}
        <DialogFooter>
          {running ? (
            <span className="text-sm text-muted-foreground">{t("chat_import.progress_note")}</span>
          ) : migration.state === "completed" ? (
            <Button onClick={closeImportProgress}>{t("chat_import.done")}</Button>
          ) : (
            <Button disabled={progress.retrying} onClick={() => void retryChatImport()}>{t("chat_import.try_again")}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Both floating notices clear the actual chrome, including native offsets and taller route headers. */
function ImportFloatingRegion(props: PropsWithChildren) {
  const regionRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const region = regionRef.current;
    if (!region) return;
    const chromeSelector = "[data-session-header], [data-settings-titlebar], [data-sidebar-titlebar], .window-titlebar";
    const observed = new Set<Element>();
    let frame: number | null = null;
    let rebindChrome = false;
    const measure = () => {
      const bottom = Math.max(0, ...Array.from(observed, (element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 ? rect.bottom : 0;
      }));
      const value = `${bottom}px`;
      if (region.style.getPropertyValue("--chat-import-chrome-bottom") !== value) {
        region.style.setProperty("--chat-import-chrome-bottom", value);
      }
    };
    const scheduleMeasure = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        if (rebindChrome) {
          rebindChrome = false;
          refreshChrome();
        }
        measure();
      });
    };
    const resizeObserver = new ResizeObserver(scheduleMeasure);
    const refreshChrome = () => {
      const chrome = new Set(document.querySelectorAll(chromeSelector));
      for (const element of observed) {
        if (chrome.has(element)) continue;
        resizeObserver.unobserve(element);
        observed.delete(element);
      }
      for (const element of chrome) {
        if (observed.has(element)) continue;
        observed.add(element);
        resizeObserver.observe(element);
      }
    };
    const scheduleRefresh = () => {
      rebindChrome = true;
      scheduleMeasure();
    };
    // Only chrome replacement needs rebinding. Streaming text and app-wide
    // attribute changes must not trigger layout reads; header sizes use RO.
    const containsChrome = (node: Node) => node instanceof Element
      && (node.matches(chromeSelector) || node.querySelector(chromeSelector) !== null);
    const mutationObserver = new MutationObserver((records) => {
      if (records.some(record => [...record.addedNodes, ...record.removedNodes].some(containsChrome))) {
        scheduleRefresh();
      }
    });
    mutationObserver.observe(document.getElementById("root") ?? document.body, { childList: true, subtree: true });
    window.addEventListener("resize", scheduleMeasure);
    scheduleRefresh();
    return () => {
      mutationObserver.disconnect();
      resizeObserver.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, []);
  // Above page chrome (z-40) but below dialogs, menus and the command palette (z-50), which must cover this optional notice.
  return (
    <div
      ref={regionRef}
      className="pointer-events-none fixed inset-x-0 top-[calc(max(var(--window-titlebar-height),var(--chat-import-chrome-bottom,0px))+var(--spacing)*3)] z-[45] flex justify-center px-4"
    >
      {props.children}
    </div>
  );
}

function ImportBanner(props: { progress: ProgressState }) {
  const { migration } = props.progress;
  const done = handledCount(migration);
  const count = migration.phase === "copying" && migration.total > 0
    ? t("chat_import.progress_copied", { done: formatCount(done), total: formatCount(migration.total) })
    : null;
  return (
    <ImportFloatingRegion>
      <div
        role="status"
        aria-live="polite"
        data-testid="chat-import-banner"
        className="pointer-events-auto flex max-w-xl items-center gap-3 rounded-2xl bg-popover px-4 py-3 text-popover-foreground shadow-[var(--dls-card-shadow)] ring-1 ring-foreground/5"
      >
        <LoaderCircle className="size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{t("chat_import.progress_title")}</p>
          <p className="text-xs text-muted-foreground">{count ? `${count}. ` : ""}{t("chat_import.progress_note")}</p>
        </div>
        <Button type="button" size="xs" variant="outline" onClick={showImportProgress}>
          {t("chat_import.show_progress")}
        </Button>
      </div>
    </ImportFloatingRegion>
  );
}

/** Polls the running import and finishes it quietly when it was sent to the background. */
function useImportLifecycle(progress: ProgressState | null) {
  const client = progress?.client;
  const state = progress?.migration.state;
  const view = progress?.view;
  useEffect(() => {
    if (!client || state !== "running") return;
    let disposed = false;
    const timer = window.setInterval(() => {
      void client.getEngineStatus().then(
        (status) => { if (!disposed) observeChatImport(client, status); },
        () => {},
      );
    }, 1_000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [client, state]);
  useEffect(() => {
    const current = useChatImportStore.getState().progress;
    if (!current || view !== "banner") return;
    if (state === "error" || (state === "completed" && current.migration.notCopied?.length)) {
      // A failure needs a decision (retry or leave it), and chats that could
      // not be copied should be seen, so bring the dialog back.
      showImportProgress();
    } else if (state === "completed") {
      useChatImportStore.setState({ progress: null });
      toast.success(t("chat_import.done_title"), { description: importedSummary(current.migration) });
    }
  }, [state, view]);
}

type ImportCandidate = { client: ChatImportClient; status: EngineStatus };

/**
 * Reads the local server's engine status once, on desktop: a renderer reload
 * mid-import picks the import up again, and v1 chats still on disk are offered.
 */
function useImportCandidate(): ImportCandidate | null {
  const [candidate, setCandidate] = useState<ImportCandidate | null>(null);
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const readStatus = async () => {
      try {
        const connection = await resolveOpenworkConnection();
        if (cancelled) return;
        if (!connection.normalizedBaseUrl || !connection.resolvedToken) throw new Error("Local server not ready");
        const client = createOpenworkServerClient({
          baseUrl: connection.normalizedBaseUrl,
          token: connection.resolvedToken,
          hostToken: connection.resolvedHostToken,
        });
        const status = await client.getEngineStatus();
        if (cancelled) return;
        observeChatImport(client, status);
        setCandidate({ client, status });
        // The startup check may invalidate a preview-era receipt when v1
        // gained more chats. Read again once that check/engine startup finishes.
        if (!status.running && !status.v1HistoryAvailable && status.migration?.state !== "running" && status.migration?.state !== "error") {
          retryTimer = setTimeout(() => void readStatus(), 2_000);
        }
      } catch {
        // Startup can race the local server. Keep trying so an upgrade cannot
        // disappear for this launch because the first status read failed.
        if (!cancelled) retryTimer = setTimeout(() => void readStatus(), 2_000);
      }
    };
    void readStatus();
    return () => { cancelled = true; clearTimeout(retryTimer); };
  }, []);
  return candidate;
}

/** Offer the import while v1 chats remain on disk and no import has finished or is running. */
export function shouldOfferChatImport(
  status: Pick<EngineStatus, "v1HistoryAvailable" | "migration">,
): boolean {
  return status.v1HistoryAvailable
    && status.migration?.state !== "running"
    && status.migration?.state !== "completed";
}

function ChatImportNotice(props: { candidate: ImportCandidate }) {
  return (
    <AlertDialog open>
      <AlertDialogContent data-testid="chat-import-notice">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("chat_import.required_title")}</AlertDialogTitle>
          <AlertDialogDescription>{t("chat_import.required_body")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button onClick={() => requestChatImport(props.candidate.client)}>{t("chat_import.import")}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function ChatHistoryImportOverlay() {
  const consent = useChatImportStore((state) => state.consent);
  const progress = useChatImportStore((state) => state.progress);
  useImportLifecycle(progress);
  const candidate = useImportCandidate();
  // Once an import starts, the status read at launch no longer applies.
  const [importStarted, setImportStarted] = useState(false);
  useEffect(() => {
    if (progress) setImportStarted(true);
  }, [progress]);
  const offerImport = candidate !== null && !importStarted && !consent && !progress
    && shouldOfferChatImport(candidate.status);
  return (
    <>
      {offerImport ? (
        <ChatImportNotice
          candidate={candidate}
        />
      ) : null}
      {consent ? <ImportConsentDialog consent={consent} /> : null}
      {progress?.view === "dialog" ? <ImportProgressDialog progress={progress} /> : null}
      {progress?.view === "banner" && progress.migration.state === "running" ? <ImportBanner progress={progress} /> : null}
    </>
  );
}
