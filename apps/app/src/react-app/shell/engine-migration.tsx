/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { create } from "zustand";
import { ChevronRight, LoaderCircle, TriangleAlert } from "lucide-react";
import {
  createOpenworkServerClient,
  OpenworkServerError,
  type EngineActivity,
  type EngineV2MigrationStatus,
  type EngineV2PreviewStatus,
  type OpenworkServerClient,
} from "@/app/lib/openwork-server";
import { isDesktopRuntime } from "@/app/lib/runtime-env";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
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
import { resolveExtensionIconSrc } from "@/react-app/design-system/extension-icon-src";
import { useAutomationsDenContext } from "@/react-app/domains/automations/use-automations";
import { resolveOpenworkConnection } from "./openwork-connection";

/**
 * One home for switching chat engines and migrating v1 history (S6). The
 * command palette and Advanced settings only ask; this module checks what is
 * still running, asks for consent, and keeps a migration visible app-wide —
 * as a dialog the person can step out of, then a banner, until it finishes.
 */

export type EngineMigrationClient = Pick<
  OpenworkServerClient,
  "getEngineV2PreviewStatus" | "getEngineActivity" | "switchOpencodeEngine" | "migrateOpencodeHistory"
>;

export type ChatEngine = "v1" | "v2";

/** `upgrade` copies chats and then switches to v2 on its own; `migrate` only copies. */
export type EngineMigrationMode = "migrate" | "upgrade";

type ConsentState = {
  client: EngineMigrationClient;
  mode: EngineMigrationMode;
  /** Tasks the v1 engine is still running; copying them mid-turn needs an explicit choice. */
  runningTasks: number;
  submitting: boolean;
  error: string | null;
};

type ProgressState = {
  client: EngineMigrationClient;
  migration: EngineV2MigrationStatus;
  selected: ChatEngine;
  view: "dialog" | "banner";
  retrying: boolean;
  /** Set when a retry was refused because v1 tasks are running. */
  runningTasks: number;
  /** Switch chats to v2 as soon as the copy completes (the upgrade flow). */
  switchWhenDone: boolean;
};

type SwitchPrompt = {
  engine: ChatEngine;
  from: ChatEngine;
  runningTasks: number;
  resolve: (confirmed: boolean) => void;
};

type EngineMigrationState = {
  consent: ConsentState | null;
  progress: ProgressState | null;
  switchPrompt: SwitchPrompt | null;
  switching: boolean;
};

const initialState: EngineMigrationState = { consent: null, progress: null, switchPrompt: null, switching: false };

export const useEngineMigrationStore = create<EngineMigrationState>(() => initialState);

export function resetEngineMigrationForTest() {
  useEngineMigrationStore.setState(initialState);
}

export function selectedChatEngine(status: Pick<EngineV2PreviewStatus, "enabled" | "chatRouting">): ChatEngine {
  return status.enabled && status.chatRouting ? "v2" : "v1";
}

function runningOn(activity: EngineActivity | null, engine: ChatEngine): number {
  const count = activity ? (engine === "v1" ? activity.v1 : activity.v2) : null;
  return count ? count.busySessions + count.waitingRequests : 0;
}

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/** Running v1 tasks reported by a refused migration, or null for any other failure. */
function refusedForRunningTasks(cause: unknown): number | null {
  if (!(cause instanceof OpenworkServerError) || cause.code !== "engine_migration_active_sessions") return null;
  const details = cause.details;
  const count = (key: "busySessions" | "waitingRequests") => {
    if (!details || typeof details !== "object" || !(key in details)) return 0;
    const value: unknown = Reflect.get(details, key);
    return typeof value === "number" && value > 0 ? value : 0;
  };
  return Math.max(1, count("busySessions") + count("waitingRequests"));
}

const formatCount = (value: number) => new Intl.NumberFormat().format(value);

/** The settings-row state line, e.g. "Migrated 2 chats; 1 already in v2." */
export function engineMigrationMessage(migration: EngineV2MigrationStatus | undefined): string | undefined {
  if (!migration) return undefined;
  if (migration.state === "running") {
    if (migration.phase === "starting" || migration.phase === "converting" || migration.total === 0) {
      return t("engine_migration.settings_starting");
    }
    return t("engine_migration.settings_running", {
      done: formatCount(migration.imported + migration.skipped),
      total: formatCount(migration.total),
    });
  }
  if (migration.state === "completed") return migratedSummary(migration);
  if (migration.state === "error") return migration.error;
  return undefined;
}

function migratedSummary(migration: EngineV2MigrationStatus) {
  return t("engine_migration.migrated_summary", {
    count: migration.imported,
    imported: formatCount(migration.imported),
    skipped: formatCount(migration.skipped),
  });
}

function updateConsent(client: EngineMigrationClient, patch: Partial<Omit<ConsentState, "client">>) {
  useEngineMigrationStore.setState((state) =>
    state.consent?.client === client ? { consent: { ...state.consent, ...patch } } : state);
}

function updateProgress(patch: Partial<ProgressState>) {
  useEngineMigrationStore.setState((state) =>
    state.progress ? { progress: { ...state.progress, ...patch } } : state);
}

/** Open the migration consent. A migration that is already running is shown instead. */
export function requestEngineMigration(client: EngineMigrationClient, mode: EngineMigrationMode = "migrate") {
  const { progress } = useEngineMigrationStore.getState();
  if (progress?.migration.state === "running") {
    showEngineMigrationProgress();
    return;
  }
  useEngineMigrationStore.setState({ consent: { client, mode, runningTasks: 0, submitting: false, error: null } });
  // The consent is usable immediately; the server refuses (409) a migration
  // started before this check lands, which surfaces the same warning.
  void client.getEngineActivity().then(
    (activity) => updateConsent(client, { runningTasks: runningOn(activity, "v1") }),
    () => {},
  );
}

export function cancelEngineMigration() {
  useEngineMigrationStore.setState((state) => (state.consent?.submitting ? state : { consent: null }));
}

function presentMigration(
  client: EngineMigrationClient,
  status: EngineV2PreviewStatus,
  view: ProgressState["view"],
  switchWhenDone = false,
) {
  const migration = status.migration;
  if (!migration) return;
  useEngineMigrationStore.setState((state) => ({
    progress: {
      client,
      migration,
      selected: selectedChatEngine(status),
      view: state.progress?.view ?? view,
      retrying: false,
      runningTasks: 0,
      switchWhenDone: switchWhenDone || state.progress?.switchWhenDone === true,
    },
  }));
}

export async function confirmEngineMigration() {
  const consent = useEngineMigrationStore.getState().consent;
  if (!consent || consent.submitting) return;
  updateConsent(consent.client, { submitting: true, error: null });
  try {
    const status = await consent.client.migrateOpencodeHistory({ allowActiveSessions: consent.runningTasks > 0 });
    useEngineMigrationStore.setState({ consent: null });
    presentMigration(consent.client, status, "dialog", consent.mode === "upgrade");
  } catch (cause) {
    const running = refusedForRunningTasks(cause);
    updateConsent(consent.client, running === null
      ? { submitting: false, error: messageOf(cause, t("engine_migration.start_failed")) }
      : { submitting: false, runningTasks: running });
  }
}

/** Status reads from any surface: present a running migration nobody is showing yet. */
export function observeEngineMigration(client: EngineMigrationClient, status: EngineV2PreviewStatus) {
  const migration = status.migration;
  if (!migration) return;
  const { progress } = useEngineMigrationStore.getState();
  if (progress) {
    updateProgress({ migration, selected: selectedChatEngine(status) });
    return;
  }
  if (migration.state === "running") presentMigration(client, status, "dialog");
}

export function continueEngineMigrationInBackground() {
  updateProgress({ view: "banner" });
}

export function showEngineMigrationProgress() {
  updateProgress({ view: "dialog" });
}

/** A running migration can only move to the background; a finished one is dismissed. */
export function closeEngineMigrationProgress() {
  useEngineMigrationStore.setState((state) => {
    if (!state.progress) return state;
    if (state.progress.migration.state === "running") return { progress: { ...state.progress, view: "banner" } };
    return { progress: null };
  });
}

export async function retryEngineMigration(allowActiveSessions = false) {
  const progress = useEngineMigrationStore.getState().progress;
  if (!progress || progress.retrying) return;
  updateProgress({ retrying: true });
  try {
    const status = await progress.client.migrateOpencodeHistory({ allowActiveSessions });
    updateProgress({
      migration: status.migration ?? progress.migration,
      selected: selectedChatEngine(status),
      retrying: false,
      runningTasks: 0,
      view: "dialog",
    });
  } catch (cause) {
    const running = refusedForRunningTasks(cause);
    updateProgress(running === null
      ? { retrying: false, migration: { ...progress.migration, error: messageOf(cause, t("engine_migration.start_failed")) } }
      : { retrying: false, runningTasks: running });
  }
}

/**
 * Switch chat routing after checking the engine being left. v1 tasks keep
 * running unseen after a switch to v2; switching to v1 stops the v2 sidecar.
 * Resolves with the new status, or null when cancelled or failed.
 */
export async function requestEngineSwitch(
  client: EngineMigrationClient,
  engine: ChatEngine,
  from: ChatEngine,
): Promise<EngineV2PreviewStatus | null> {
  const store = useEngineMigrationStore;
  if (store.getState().switching || engine === from) return null;
  store.setState({ switching: true });
  try {
    const activity = await client.getEngineActivity().catch(() => null);
    const runningTasks = runningOn(activity, from);
    if (runningTasks > 0) {
      const confirmed = await new Promise<boolean>((resolve) => {
        store.setState({ switchPrompt: { engine, from, runningTasks, resolve } });
      });
      store.setState({ switchPrompt: null });
      if (!confirmed) return null;
    }
    const next = await client.switchOpencodeEngine(engine);
    window.dispatchEvent(new CustomEvent("openwork-engine-changed"));
    updateProgress({ selected: selectedChatEngine(next) });
    return next;
  } catch (cause) {
    toast.error(messageOf(cause, t("engine_migration.switch_failed")));
    return null;
  } finally {
    store.setState({ switching: false });
  }
}

export function resolveEngineSwitchPrompt(confirmed: boolean) {
  useEngineMigrationStore.getState().switchPrompt?.resolve(confirmed);
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

function MigrationProgressBar(props: { migration: EngineV2MigrationStatus }) {
  const { migration } = props;
  const done = migration.imported + migration.skipped;
  const copying = migration.phase === "copying" || (migration.phase === undefined && done > 0);
  const elapsed = useElapsed(migration.startedAt, migration.state === "running");
  const value = copying && migration.total > 0 ? Math.min(100, Math.round((done / migration.total) * 100)) : null;
  const label = copying && migration.total > 0
    ? t("engine_migration.progress_copied", { done: formatCount(done), total: formatCount(migration.total) })
    : migration.total > 0
      ? t("engine_migration.progress_total", { count: migration.total, total: formatCount(migration.total) })
      : "";
  return (
    <div className="grid gap-2">
      <Progress
        value={value}
        aria-label={t("engine_migration.progress_title")}
        className={cn(
          "w-full",
          value === null && "[&_[data-slot=progress-indicator]]:w-1/3 [&_[data-slot=progress-indicator]]:animate-progress-shimmer motion-reduce:[&_[data-slot=progress-indicator]]:animate-none",
        )}
      />
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground tabular-nums">
        <span data-testid="engine-migration-count">{label}</span>
        {elapsed ? <span>{elapsed}</span> : null}
      </div>
    </div>
  );
}

function RunningTasksAlert(props: { count: number; body: string }) {
  return (
    <Alert variant="warning">
      <TriangleAlert />
      <AlertTitle>{t("engine_migration.running_tasks", { count: props.count })}</AlertTitle>
      <AlertDescription>{props.body}</AlertDescription>
    </Alert>
  );
}

function MigrationConsentDialog(props: { consent: ConsentState }) {
  const { consent } = props;
  // Start on Cancel, not the disclosure: Enter should never start a migration by accident.
  const cancelRef = useRef<HTMLButtonElement>(null);
  const upgrade = consent.mode === "upgrade";
  return (
    <AlertDialog open onOpenChange={(open) => { if (!open) cancelEngineMigration(); }}>
      <AlertDialogContent data-testid="engine-migration-consent" data-mode={consent.mode} initialFocus={cancelRef}>
        <AlertDialogHeader>
          <AlertDialogTitle>{upgrade ? t("engine_migration.upgrade_consent_title") : t("engine_migration.consent_title")}</AlertDialogTitle>
          <AlertDialogDescription>{upgrade ? t("engine_migration.upgrade_consent_body") : t("engine_migration.consent_body")}</AlertDialogDescription>
        </AlertDialogHeader>
        {consent.runningTasks > 0
          ? <RunningTasksAlert count={consent.runningTasks} body={t("engine_migration.running_tasks_migrate")} />
          : null}
        {consent.error ? <Alert variant="destructive"><AlertDescription>{consent.error}</AlertDescription></Alert> : null}
        <details className="group text-xs text-muted-foreground">
          <summary className="flex cursor-pointer list-none items-center gap-1 select-none hover:text-foreground">
            <ChevronRight className="size-3.5 transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none" />
            {t("engine_migration.what_changes")}
          </summary>
          <ul className="mt-2 grid list-disc gap-1 ps-8">
            <li>{t("engine_migration.change_permissions")}</li>
            <li>{t("engine_migration.change_attachments")}</li>
            <li>{t("engine_migration.change_sync")}</li>
            <li>{t("engine_migration.change_plugins")}</li>
            {upgrade ? null : <li>{t("engine_migration.change_engine")}</li>}
          </ul>
        </details>
        <AlertDialogFooter>
          <AlertDialogCancel ref={cancelRef} disabled={consent.submitting}>{t("common.cancel")}</AlertDialogCancel>
          <Button
            variant={consent.runningTasks > 0 ? "outline" : "default"}
            disabled={consent.submitting}
            onClick={() => void confirmEngineMigration()}
          >
            {consent.runningTasks > 0
              ? t("engine_migration.migrate_anyway")
              : upgrade ? t("engine_migration.upgrade") : t("engine_migration.migrate")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function MigrationProgressDialog(props: { progress: ProgressState }) {
  const { progress } = props;
  const { migration } = progress;
  const running = migration.state === "running";
  const switchToV2 = () => {
    // Close first so a running-tasks prompt is the only dialog on screen.
    useEngineMigrationStore.setState({ progress: null });
    void requestEngineSwitch(progress.client, "v2", progress.selected);
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) closeEngineMigrationProgress(); }}>
      <DialogContent showCloseButton={false} data-testid="engine-migration-progress" data-state-kind={migration.state}>
        <DialogHeader>
          <DialogTitle>
            {running ? t("engine_migration.progress_title")
              : migration.state === "completed" ? t("engine_migration.done_title")
                : t("engine_migration.error_title")}
          </DialogTitle>
          <DialogDescription>
            {running ? t("engine_migration.progress_note")
              : migration.state === "completed" ? migratedSummary(migration)
                : migration.error}
          </DialogDescription>
        </DialogHeader>
        {running ? <MigrationProgressBar migration={migration} /> : null}
        {migration.state === "error" && progress.runningTasks > 0
          ? <RunningTasksAlert count={progress.runningTasks} body={t("engine_migration.running_tasks_retry")} />
          : migration.state === "error" ? <p className="text-xs text-muted-foreground">{t("engine_migration.error_note")}</p> : null}
        <DialogFooter>
          {running ? (
            <Button variant="outline" onClick={continueEngineMigrationInBackground}>
              {t("engine_migration.continue_in_background")}
            </Button>
          ) : migration.state === "completed" ? (
            progress.selected === "v1" ? (
              <>
                <Button variant="outline" onClick={closeEngineMigrationProgress}>{t("engine_migration.not_now")}</Button>
                <Button onClick={switchToV2}>{t("engine_migration.switch_to_v2")}</Button>
              </>
            ) : (
              <Button onClick={closeEngineMigrationProgress}>{t("engine_migration.done")}</Button>
            )
          ) : (
            <>
              <Button variant="outline" disabled={progress.retrying} onClick={closeEngineMigrationProgress}>{t("common.close")}</Button>
              {progress.runningTasks > 0 ? (
                <Button variant="outline" disabled={progress.retrying} onClick={() => void retryEngineMigration(true)}>
                  {t("engine_migration.migrate_anyway")}
                </Button>
              ) : (
                <Button disabled={progress.retrying} onClick={() => void retryEngineMigration()}>{t("engine_migration.try_again")}</Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MigrationBanner(props: { progress: ProgressState }) {
  const { migration } = props.progress;
  const done = migration.imported + migration.skipped;
  const count = migration.phase === "copying" && migration.total > 0
    ? t("engine_migration.progress_copied", { done: formatCount(done), total: formatCount(migration.total) })
    : null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-[100] flex justify-center px-4">
      <div
        role="status"
        aria-live="polite"
        data-testid="engine-migration-banner"
        className="pointer-events-auto flex max-w-xl items-center gap-3 rounded-2xl bg-popover px-4 py-3 text-popover-foreground shadow-[var(--dls-card-shadow)] ring-1 ring-foreground/5"
      >
        <LoaderCircle className="size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{t("engine_migration.banner_title")}</p>
          <p className="text-xs text-muted-foreground">{count ? `${count}. ` : ""}{t("engine_migration.banner_note")}</p>
        </div>
        <Button type="button" size="xs" variant="outline" onClick={showEngineMigrationProgress}>
          {t("engine_migration.show_progress")}
        </Button>
      </div>
    </div>
  );
}

function EngineSwitchPrompt(props: { prompt: SwitchPrompt }) {
  const { prompt } = props;
  const leavingV2 = prompt.from === "v2";
  return (
    <AlertDialog open onOpenChange={(open) => { if (!open) resolveEngineSwitchPrompt(false); }}>
      <AlertDialogContent data-testid="engine-switch-prompt">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("engine_migration.switch_running_title", { count: prompt.runningTasks, engine: prompt.from })}</AlertDialogTitle>
          <AlertDialogDescription>
            {leavingV2 ? t("engine_migration.switch_from_v2") : t("engine_migration.switch_from_v1")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("engine_migration.keep_engine", { engine: prompt.from })}</AlertDialogCancel>
          <Button variant={leavingV2 ? "destructive" : "default"} onClick={() => resolveEngineSwitchPrompt(true)}>
            {leavingV2 ? t("engine_migration.stop_and_switch") : t("engine_migration.switch_anyway")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Polls the running migration and finishes it quietly when it was sent to the background. */
function useMigrationLifecycle(progress: ProgressState | null) {
  const client = progress?.client;
  const state = progress?.migration.state;
  const view = progress?.view;
  useEffect(() => {
    if (!client || state !== "running") return;
    let disposed = false;
    const timer = window.setInterval(() => {
      void client.getEngineV2PreviewStatus().then(
        (status) => { if (!disposed) observeEngineMigration(client, status); },
        () => {},
      );
    }, 1_000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [client, state]);
  useEffect(() => {
    // The upgrade flow switches on its own once every chat is copied.
    const current = useEngineMigrationStore.getState().progress;
    if (!current || state !== "completed" || !current.switchWhenDone) return;
    useEngineMigrationStore.setState({ progress: null });
    const switched = current.selected === "v2"
      ? Promise.resolve(true)
      : requestEngineSwitch(current.client, "v2", current.selected).then((next) => next !== null);
    void switched.then((ok) => {
      if (ok) toast.success(t("engine_migration.upgraded_title"), { description: migratedSummary(current.migration) });
    });
  }, [state]);
  useEffect(() => {
    const current = useEngineMigrationStore.getState().progress;
    if (!current || view !== "banner") return;
    if (state === "error") {
      // A failure needs a decision (retry or leave it), so bring the dialog back.
      showEngineMigrationProgress();
    } else if (state === "completed") {
      useEngineMigrationStore.setState({ progress: null });
      toast.success(t("engine_migration.done_title"), {
        description: migratedSummary(current.migration),
        ...(current.selected === "v1"
          ? { action: { label: t("engine_migration.switch_to_v2"), onClick: () => void requestEngineSwitch(current.client, "v2", "v1") } }
          : {}),
      });
    }
  }, [state, view]);
}

/** A renderer reload mid-migration (or another window starting one) is picked up once. */
function useRunningMigrationDiscovery(enabled: boolean) {
  useEffect(() => {
    if (!enabled || !isDesktopRuntime()) return;
    let cancelled = false;
    void (async () => {
      try {
        const connection = await resolveOpenworkConnection();
        if (cancelled || !connection.normalizedBaseUrl || !connection.resolvedToken) return;
        const client = createOpenworkServerClient({
          baseUrl: connection.normalizedBaseUrl,
          token: connection.resolvedToken,
          hostToken: connection.resolvedHostToken,
        });
        const status = await client.getEngineV2PreviewStatus();
        if (!cancelled) observeEngineMigration(client, status);
      } catch {
        // Engine controls report connection problems where they are used.
      }
    })();
    return () => { cancelled = true; };
  }, [enabled]);
}

const UPGRADE_SNOOZE_KEY = "openwork.engineUpgrade.snoozedUntil";
const UPGRADE_SNOOZE_MS = 3 * 24 * 60 * 60_000;

function readUpgradeSnooze(): number {
  try {
    const value = Number(window.localStorage.getItem(UPGRADE_SNOOZE_KEY));
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function snoozeUpgrade(now = Date.now()) {
  try { window.localStorage.setItem(UPGRADE_SNOOZE_KEY, String(now + UPGRADE_SNOOZE_MS)); } catch { /* best effort */ }
}

/** Offer the upgrade only to people still chatting on v1 who have v1 chats to bring along. */
export function shouldOfferEngineUpgrade(
  status: Pick<EngineV2PreviewStatus, "enabled" | "chatRouting" | "v1HistoryAvailable" | "migration">,
  options: { now: number; snoozedUntil: number },
): boolean {
  return selectedChatEngine(status) === "v1"
    && status.v1HistoryAvailable === true
    && status.migration?.state !== "running"
    && options.snoozedUntil <= options.now;
}

/** `engineV2Upgrade` for the active organization; signed out or unreachable means off. */
function useEngineUpgradeFeature(): boolean {
  const context = useAutomationsDenContext();
  const query = useQuery({
    // Shares the cache with other org-feature reads (e.g. the Calendar).
    queryKey: ["den", "org-features", context.organizationId],
    queryFn: () => context.client!.getOrgFeatures(context.organizationId!),
    enabled: context.ready && isDesktopRuntime(),
    staleTime: 5 * 60_000,
    select: (features) => features.engineV2Upgrade === true,
  });
  return query.data === true;
}

type UpgradeCandidate = { client: EngineMigrationClient; status: EngineV2PreviewStatus };

/** Reads engine status once the feature is on, and again whenever the engine changes. */
function useEngineUpgradeCandidate(enabled: boolean): UpgradeCandidate | null {
  const [candidate, setCandidate] = useState<UpgradeCandidate | null>(null);
  useEffect(() => {
    if (!enabled) {
      setCandidate(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const connection = await resolveOpenworkConnection();
        if (cancelled || !connection.normalizedBaseUrl || !connection.resolvedToken) return;
        const client = createOpenworkServerClient({
          baseUrl: connection.normalizedBaseUrl,
          token: connection.resolvedToken,
          hostToken: connection.resolvedHostToken,
        });
        const status = await client.getEngineV2PreviewStatus();
        if (!cancelled) setCandidate({ client, status });
      } catch {
        // No notice when the local server can't be read; Advanced settings still works.
      }
    };
    void load();
    const reload = () => { void load(); };
    window.addEventListener("openwork-engine-changed", reload);
    return () => { cancelled = true; window.removeEventListener("openwork-engine-changed", reload); };
  }, [enabled]);
  return candidate;
}

function EngineUpgradeNotice(props: { candidate: UpgradeCandidate; onLater: () => void }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-[100] flex justify-center px-4">
      <div
        role="status"
        data-testid="engine-upgrade-notice"
        className="pointer-events-auto flex max-w-xl items-center gap-3 rounded-2xl bg-popover px-4 py-3 text-popover-foreground shadow-[var(--dls-card-shadow)] ring-1 ring-foreground/5"
      >
        <img src={resolveExtensionIconSrc("/openwork-mark.svg")} alt="" className="size-4 shrink-0 opacity-80 dark:invert" />
        <p className="min-w-0 flex-1 text-sm">{t("engine_migration.upgrade_notice")}</p>
        <div className="flex shrink-0 items-center gap-2">
          <Button type="button" size="xs" variant="ghost" onClick={props.onLater}>
            {t("engine_migration.upgrade_later")}
          </Button>
          <Button type="button" size="xs" onClick={() => requestEngineMigration(props.candidate.client, "upgrade")}>
            {t("engine_migration.upgrade")}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function EngineMigrationOverlay(props: { discoverRunningMigration?: boolean }) {
  const consent = useEngineMigrationStore((state) => state.consent);
  const progress = useEngineMigrationStore((state) => state.progress);
  const switchPrompt = useEngineMigrationStore((state) => state.switchPrompt);
  useMigrationLifecycle(progress);
  useRunningMigrationDiscovery(props.discoverRunningMigration !== false);
  const upgradeFeature = useEngineUpgradeFeature();
  const candidate = useEngineUpgradeCandidate(upgradeFeature);
  const [snoozedUntil, setSnoozedUntil] = useState(readUpgradeSnooze);
  const offerUpgrade = candidate !== null && !consent && !progress && !switchPrompt
    && shouldOfferEngineUpgrade(candidate.status, { now: Date.now(), snoozedUntil });
  return (
    <>
      {offerUpgrade ? (
        <EngineUpgradeNotice
          candidate={candidate}
          onLater={() => { snoozeUpgrade(); setSnoozedUntil(readUpgradeSnooze()); }}
        />
      ) : null}
      {consent ? <MigrationConsentDialog consent={consent} /> : null}
      {progress?.view === "dialog" ? <MigrationProgressDialog progress={progress} /> : null}
      {progress?.view === "banner" && progress.migration.state === "running" ? <MigrationBanner progress={progress} /> : null}
      {switchPrompt ? <EngineSwitchPrompt prompt={switchPrompt} /> : null}
    </>
  );
}
