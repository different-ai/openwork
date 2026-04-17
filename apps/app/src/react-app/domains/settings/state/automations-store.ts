import { useSyncExternalStore } from "react";

import { t } from "../../../../i18n";
import { schedulerDeleteJob, schedulerListJobs } from "../../../../app/lib/tauri";
import type { ScheduledJob } from "../../../../app/types";
import { isTauriRuntime, normalizeDirectoryPath } from "../../../../app/utils";
import type { OpenworkServerStore } from "../../connections/openwork-server-store";

export type AutomationActionPlan =
  | { ok: true; mode: "session_prompt"; prompt: string }
  | { ok: false; error: string };

export type PrepareCreateAutomationInput = {
  name: string;
  prompt: string;
  schedule: string;
  workdir?: string | null;
};

export type AutomationsStoreSnapshot = {
  scheduledJobs: ScheduledJob[];
  scheduledJobsStatus: string | null;
  scheduledJobsBusy: boolean;
  scheduledJobsUpdatedAt: number | null;
  pendingRefreshContextKey: string | null;
};

type CreateAutomationsStoreOptions = {
  selectedWorkspaceId: () => string;
  selectedWorkspaceRoot: () => string;
  runtimeWorkspaceId: () => string | null;
  openworkServer: OpenworkServerStore;
  schedulerPluginInstalled: () => boolean;
};

type MutableState = AutomationsStoreSnapshot;

export type AutomationsStore = ReturnType<typeof createAutomationsStore>;

const normalizeSentence = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/[.!?]$/.test(trimmed)) return trimmed;
  return `${trimmed}.`;
};

const buildCreateAutomationPrompt = (
  input: PrepareCreateAutomationInput,
): AutomationActionPlan => {
  const name = input.name.trim();
  const schedule = input.schedule.trim();
  const prompt = normalizeSentence(input.prompt);
  if (!schedule) {
    return { ok: false, error: t("automations.schedule_required") };
  }
  if (!prompt) {
    return { ok: false, error: t("automations.prompt_required") };
  }
  const workdir = (input.workdir ?? "").trim();
  const nameSegment = name ? ` named \"${name}\"` : "";
  const workdirSegment = workdir ? ` Run from ${workdir}.` : "";
  return {
    ok: true,
    mode: "session_prompt",
    prompt: `Schedule a job${nameSegment} with cron \"${schedule}\" to ${prompt}${workdirSegment}`.trim(),
  };
};

const buildRunAutomationPrompt = (
  job: ScheduledJob,
  fallbackWorkdir?: string | null,
): AutomationActionPlan => {
  const workdir = (job.workdir ?? fallbackWorkdir ?? "").trim();
  const workdirSegment = workdir ? `\n\nRun from ${workdir}.` : "";

  if (job.run?.prompt || job.prompt) {
    const promptBody = (job.run?.prompt ?? job.prompt ?? "").trim();
    if (!promptBody) {
      return { ok: false, error: t("automations.prompt_empty") };
    }
    return {
      ok: true,
      mode: "session_prompt",
      prompt: `Run this automation now: ${job.name}.\nSchedule: ${job.schedule}.\n\n${promptBody}${workdirSegment}`.trim(),
    };
  }

  if (job.run?.command) {
    const args = job.run.arguments ? ` ${job.run.arguments}` : "";
    const command = `${job.run.command}${args}`.trim();
    return {
      ok: true,
      mode: "session_prompt",
      prompt: `Run this automation now: ${job.name}.\nSchedule: ${job.schedule}.\n\nRun the following command:\n${command}${workdirSegment}`.trim(),
    };
  }

  return {
    ok: true,
    mode: "session_prompt",
    prompt: `Run this automation now: ${job.name}.\nSchedule: ${job.schedule}.`.trim(),
  };
};

export function createAutomationsStore(options: CreateAutomationsStoreOptions) {
  const listeners = new Set<() => void>();

  let disposed = false;
  let started = false;
  let openworkServerUnsubscribe: (() => void) | null = null;
  let lastContextKey = "";

  let snapshot: AutomationsStoreSnapshot;
  let state: MutableState = {
    scheduledJobs: [],
    scheduledJobsStatus: null,
    scheduledJobsBusy: false,
    scheduledJobsUpdatedAt: null,
    pendingRefreshContextKey: null,
  };

  const emitChange = () => {
    for (const listener of listeners) listener();
  };

  const refreshSnapshot = () => {
    snapshot = {
      scheduledJobs: state.scheduledJobs,
      scheduledJobsStatus: state.scheduledJobsStatus,
      scheduledJobsBusy: state.scheduledJobsBusy,
      scheduledJobsUpdatedAt: state.scheduledJobsUpdatedAt,
      pendingRefreshContextKey: state.pendingRefreshContextKey,
    };
  };

  const mutateState = (updater: (current: MutableState) => MutableState) => {
    state = updater(state);
    refreshSnapshot();
    emitChange();
  };

  const setStateField = <K extends keyof MutableState>(key: K, value: MutableState[K]) => {
    if (Object.is(state[key], value)) return;
    mutateState((current) => ({ ...current, [key]: value }));
  };

  const getScheduledJobsContextKey = () => {
    const workspaceId = options.selectedWorkspaceId().trim();
    const root = normalizeDirectoryPath(options.selectedWorkspaceRoot().trim());
    const runtimeWorkspaceId = (options.runtimeWorkspaceId() ?? "").trim();
    return `local:${workspaceId}:${root}:${runtimeWorkspaceId}`;
  };

  const getServerSnapshot = () => options.openworkServer.getSnapshot();

  const getServerBacked = () => {
    const openworkSnapshot = getServerSnapshot();
    const runtimeWorkspaceId = (options.runtimeWorkspaceId() ?? "").trim();
    return (
      openworkSnapshot.openworkServerStatus === "connected" &&
      Boolean(openworkSnapshot.openworkServerClient && runtimeWorkspaceId)
    );
  };

  const getScheduledJobsSource = (): "local" | "remote" =>
    getServerBacked() ? "remote" : "local";

  const getScheduledJobsPollingAvailable = () => {
    if (getScheduledJobsSource() === "remote") return true;
    return isTauriRuntime() && options.schedulerPluginInstalled();
  };

  const maybeRefreshScheduledJobs = () => {
    if (disposed) return;
    if (!getScheduledJobsContextKey()) return;
    if (state.scheduledJobsBusy) return;
    if (state.scheduledJobsUpdatedAt) return;
    void refreshScheduledJobs();
  };

  const flushPendingRefresh = () => {
    if (disposed) return;
    const pending = state.pendingRefreshContextKey;
    if (!pending || state.scheduledJobsBusy) return;

    const contextKey = getScheduledJobsContextKey();
    if (pending !== contextKey) {
      setStateField("pendingRefreshContextKey", contextKey);
      return;
    }

    setStateField("pendingRefreshContextKey", null);
    void refreshScheduledJobs();
  };

  const syncFromOptions = () => {
    const nextContextKey = getScheduledJobsContextKey();
    if (nextContextKey !== lastContextKey) {
      lastContextKey = nextContextKey;
      mutateState((current) => ({
        ...current,
        scheduledJobs: [],
        scheduledJobsStatus: null,
        scheduledJobsUpdatedAt: null,
        pendingRefreshContextKey: null,
      }));
    }

    maybeRefreshScheduledJobs();
  };

  const refreshScheduledJobs = async (
    _options?: { force?: boolean },
  ): Promise<"success" | "error" | "unavailable" | "skipped"> => {
    const requestContextKey = getScheduledJobsContextKey();
    if (!requestContextKey) return "skipped";

    if (state.scheduledJobsBusy) {
      setStateField("pendingRefreshContextKey", requestContextKey);
      return "skipped";
    }

    if (getScheduledJobsSource() === "remote") {
      const openworkSnapshot = getServerSnapshot();
      const client = openworkSnapshot.openworkServerClient;
      const workspaceId = (options.runtimeWorkspaceId() ?? "").trim();
      if (!client || openworkSnapshot.openworkServerStatus !== "connected" || !workspaceId) {
        if (getScheduledJobsContextKey() !== requestContextKey) return "skipped";
        const status =
          openworkSnapshot.openworkServerStatus === "disconnected"
            ? t("automations.server_unavailable")
            : openworkSnapshot.openworkServerStatus === "limited"
              ? t("automations.server_needs_token")
              : t("automations.server_not_ready");
        setStateField("scheduledJobsStatus", status);
        return "unavailable";
      }

      mutateState((current) => ({
        ...current,
        scheduledJobsBusy: true,
        scheduledJobsStatus: null,
      }));

      try {
        const response = await client.listScheduledJobs(workspaceId);
        if (getScheduledJobsContextKey() !== requestContextKey) return "skipped";
        mutateState((current) => ({
          ...current,
          scheduledJobs: Array.isArray(response.items) ? response.items : [],
          scheduledJobsUpdatedAt: Date.now(),
        }));
        return "success";
      } catch (error) {
        if (getScheduledJobsContextKey() !== requestContextKey) return "skipped";
        const message = error instanceof Error ? error.message : String(error);
        setStateField("scheduledJobsStatus", message || t("automations.failed_to_load"));
        return "error";
      } finally {
        setStateField("scheduledJobsBusy", false);
        flushPendingRefresh();
      }
    }

    if (!isTauriRuntime() || !options.schedulerPluginInstalled()) {
      if (getScheduledJobsContextKey() !== requestContextKey) return "skipped";
      setStateField("scheduledJobsStatus", null);
      return "unavailable";
    }

    mutateState((current) => ({
      ...current,
      scheduledJobsBusy: true,
      scheduledJobsStatus: null,
    }));

    try {
      const root = options.selectedWorkspaceRoot().trim();
      const jobs = await schedulerListJobs(root || undefined);
      if (getScheduledJobsContextKey() !== requestContextKey) return "skipped";
      mutateState((current) => ({
        ...current,
        scheduledJobs: jobs,
        scheduledJobsUpdatedAt: Date.now(),
      }));
      return "success";
    } catch (error) {
      if (getScheduledJobsContextKey() !== requestContextKey) return "skipped";
      const message = error instanceof Error ? error.message : String(error);
      setStateField("scheduledJobsStatus", message || t("automations.failed_to_load"));
      return "error";
    } finally {
      setStateField("scheduledJobsBusy", false);
      flushPendingRefresh();
    }
  };

  const deleteScheduledJob = async (name: string) => {
    if (getScheduledJobsSource() === "remote") {
      const openworkSnapshot = getServerSnapshot();
      const client = openworkSnapshot.openworkServerClient;
      const workspaceId = (options.runtimeWorkspaceId() ?? "").trim();
      if (!client || !workspaceId) {
        throw new Error(t("automations.server_unavailable"));
      }
      const response = await client.deleteScheduledJob(workspaceId, name);
      mutateState((current) => ({
        ...current,
        scheduledJobs: current.scheduledJobs.filter((entry) => entry.slug !== response.job.slug),
      }));
      return;
    }

    if (!isTauriRuntime()) {
      throw new Error(t("automations.desktop_required"));
    }
    const root = options.selectedWorkspaceRoot().trim();
    const job = await schedulerDeleteJob(name, root || undefined);
    mutateState((current) => ({
      ...current,
      scheduledJobs: current.scheduledJobs.filter((entry) => entry.slug !== job.slug),
    }));
  };

  const prepareCreateAutomation = (input: PrepareCreateAutomationInput) =>
    buildCreateAutomationPrompt(input);

  const prepareRunAutomation = (job: ScheduledJob, fallbackWorkdir?: string | null) =>
    buildRunAutomationPrompt(job, fallbackWorkdir);

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const start = () => {
    if (started || disposed) return;
    started = true;
    lastContextKey = getScheduledJobsContextKey();
    openworkServerUnsubscribe = options.openworkServer.subscribe(() => {
      if (disposed) return;
      emitChange();
    });
    syncFromOptions();
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    openworkServerUnsubscribe?.();
    openworkServerUnsubscribe = null;
    listeners.clear();
  };

  refreshSnapshot();

  return {
    subscribe,
    getSnapshot: () => snapshot,
    start,
    dispose,
    syncFromOptions,
    scheduledJobs: () => snapshot.scheduledJobs,
    scheduledJobsStatus: () => snapshot.scheduledJobsStatus,
    scheduledJobsBusy: () => snapshot.scheduledJobsBusy,
    scheduledJobsUpdatedAt: () => snapshot.scheduledJobsUpdatedAt,
    scheduledJobsSource: getScheduledJobsSource,
    scheduledJobsPollingAvailable: getScheduledJobsPollingAvailable,
    scheduledJobsContextKey: getScheduledJobsContextKey,
    refreshScheduledJobs,
    deleteScheduledJob,
    jobs: () => snapshot.scheduledJobs,
    jobsStatus: () => snapshot.scheduledJobsStatus,
    jobsBusy: () => snapshot.scheduledJobsBusy,
    jobsUpdatedAt: () => snapshot.scheduledJobsUpdatedAt,
    jobsSource: getScheduledJobsSource,
    pollingAvailable: getScheduledJobsPollingAvailable,
    refresh: refreshScheduledJobs,
    remove: deleteScheduledJob,
    prepareCreateAutomation,
    prepareRunAutomation,
  };
}

export function useAutomationsStoreSnapshot(store: AutomationsStore) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
