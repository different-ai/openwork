import { createEffect, createMemo, createSignal } from "solid-js";

import type { ScheduledJob } from "../types";
import { schedulerDeleteJob, schedulerListJobs } from "../lib/tauri";
import type { OpenworkServerClient, OpenworkServerStatus } from "../lib/openwork-server";
import { isTauriRuntime } from "../utils";
import { createWorkspaceContextKey } from "./workspace-context";

export type AutomationsStore = ReturnType<typeof createAutomationsStore>;

export function createAutomationsStore(options: {
  selectedWorkspaceId: () => string;
  selectedWorkspaceRoot: () => string;
  runtimeWorkspaceId: () => string | null;
  openworkServerClient: () => OpenworkServerClient | null;
  openworkServerStatus: () => OpenworkServerStatus;
  schedulerPluginInstalled: () => boolean;
}) {
  const [scheduledJobs, setScheduledJobs] = createSignal<ScheduledJob[]>([]);
  const [scheduledJobsStatus, setScheduledJobsStatus] = createSignal<string | null>(null);
  const [scheduledJobsBusy, setScheduledJobsBusy] = createSignal(false);
  const [scheduledJobsUpdatedAt, setScheduledJobsUpdatedAt] = createSignal<number | null>(null);
  const [pendingRefreshContextKey, setPendingRefreshContextKey] = createSignal<string | null>(null);

  const serverBacked = createMemo(() => {
    const client = options.openworkServerClient();
    const runtimeWorkspaceId = (options.runtimeWorkspaceId() ?? "").trim();
    return options.openworkServerStatus() === "connected" && Boolean(client && runtimeWorkspaceId);
  });

  const scheduledJobsSource = createMemo<"local" | "remote">(() =>
    serverBacked() ? "remote" : "local",
  );

  const scheduledJobsContextKey = createWorkspaceContextKey({
    selectedWorkspaceId: options.selectedWorkspaceId,
    selectedWorkspaceRoot: options.selectedWorkspaceRoot,
    runtimeWorkspaceId: options.runtimeWorkspaceId,
  });

  const scheduledJobsPollingAvailable = createMemo(() => {
    if (scheduledJobsSource() === "remote") return true;
    return isTauriRuntime() && options.schedulerPluginInstalled();
  });

  const refreshScheduledJobs = async (
    _options?: { force?: boolean },
  ): Promise<"success" | "error" | "unavailable" | "skipped"> => {
    const requestContextKey = scheduledJobsContextKey();
    if (!requestContextKey) return "skipped";

    if (scheduledJobsBusy()) {
      setPendingRefreshContextKey(requestContextKey);
      return "skipped";
    }

    if (scheduledJobsSource() === "remote") {
      const client = options.openworkServerClient();
      const workspaceId = (options.runtimeWorkspaceId() ?? "").trim();
      if (!client || options.openworkServerStatus() !== "connected" || !workspaceId) {
        if (scheduledJobsContextKey() !== requestContextKey) return "skipped";
        const status =
          options.openworkServerStatus() === "disconnected"
            ? "OpenWork server unavailable. Connect to sync scheduled tasks."
            : options.openworkServerStatus() === "limited"
              ? "OpenWork server needs a token to load scheduled tasks."
              : "OpenWork server not ready.";
        setScheduledJobsStatus(status);
        return "unavailable";
      }

      setScheduledJobsBusy(true);
      setScheduledJobsStatus(null);
      try {
        const response = await client.listScheduledJobs(workspaceId);
        if (scheduledJobsContextKey() !== requestContextKey) return "skipped";
        setScheduledJobs(Array.isArray(response.items) ? response.items : []);
        setScheduledJobsUpdatedAt(Date.now());
        return "success";
      } catch (error) {
        if (scheduledJobsContextKey() !== requestContextKey) return "skipped";
        const message = error instanceof Error ? error.message : String(error);
        setScheduledJobsStatus(message || "Failed to load scheduled tasks.");
        return "error";
      } finally {
        setScheduledJobsBusy(false);
      }
    }

    if (!isTauriRuntime() || !options.schedulerPluginInstalled()) {
      if (scheduledJobsContextKey() !== requestContextKey) return "skipped";
      setScheduledJobsStatus(null);
      return "unavailable";
    }

    setScheduledJobsBusy(true);
    setScheduledJobsStatus(null);
    try {
      const root = options.selectedWorkspaceRoot().trim();
      const jobs = await schedulerListJobs(root || undefined);
      if (scheduledJobsContextKey() !== requestContextKey) return "skipped";
      setScheduledJobs(jobs);
      setScheduledJobsUpdatedAt(Date.now());
      return "success";
    } catch (error) {
      if (scheduledJobsContextKey() !== requestContextKey) return "skipped";
      const message = error instanceof Error ? error.message : String(error);
      setScheduledJobsStatus(message || "Failed to load scheduled tasks.");
      return "error";
    } finally {
      setScheduledJobsBusy(false);
    }
  };

  const deleteScheduledJob = async (name: string) => {
    if (scheduledJobsSource() === "remote") {
      const client = options.openworkServerClient();
      const workspaceId = (options.runtimeWorkspaceId() ?? "").trim();
      if (!client || !workspaceId) {
        throw new Error("OpenWork server unavailable. Connect to sync scheduled tasks.");
      }
      const response = await client.deleteScheduledJob(workspaceId, name);
      setScheduledJobs((current) => current.filter((entry) => entry.slug !== response.job.slug));
      return;
    }

    if (!isTauriRuntime()) {
      throw new Error("Scheduled tasks require the desktop app.");
    }
    const root = options.selectedWorkspaceRoot().trim();
    const job = await schedulerDeleteJob(name, root || undefined);
    setScheduledJobs((current) => current.filter((entry) => entry.slug !== job.slug));
  };

  createEffect(() => {
    scheduledJobsContextKey();
    setScheduledJobs([]);
    setScheduledJobsStatus(null);
    setScheduledJobsUpdatedAt(null);
    setPendingRefreshContextKey(null);
  });

  createEffect(() => {
    const key = scheduledJobsContextKey();
    if (!key) return;
    if (scheduledJobsBusy()) return;
    if (scheduledJobsUpdatedAt()) return;
    void refreshScheduledJobs();
  });

  createEffect(() => {
    const pending = pendingRefreshContextKey();
    if (!pending) return;
    if (scheduledJobsBusy()) return;
    if (pending !== scheduledJobsContextKey()) {
      setPendingRefreshContextKey(scheduledJobsContextKey());
      return;
    }
    setPendingRefreshContextKey(null);
    void refreshScheduledJobs();
  });

  return {
    scheduledJobs,
    scheduledJobsStatus,
    scheduledJobsBusy,
    scheduledJobsUpdatedAt,
    scheduledJobsSource,
    scheduledJobsPollingAvailable,
    scheduledJobsContextKey,
    refreshScheduledJobs,
    deleteScheduledJob,
  };
}
