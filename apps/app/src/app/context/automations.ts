import { createEffect, createMemo, createSignal } from "solid-js";

import type { ScheduledJob } from "../types";
import { schedulerDeleteJob, schedulerListJobs } from "../lib/tauri";
import { isTauriRuntime } from "../utils";
import { createWorkspaceContextKey } from "./workspace-context";
import type { OpenworkServerStore } from "../connections/openwork-server-store";
import { t } from "../../i18n";

export type AutomationsStore = ReturnType<typeof createAutomationsStore>;

export type AutomationActionPlan =
  | { ok: true; mode: "session_prompt"; prompt: string }
  | { ok: false; error: string };

export type PrepareCreateAutomationInput = {
  name: string;
  prompt: string;
  schedule: string;
  workdir?: string | null;
};

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

export function createAutomationsStore(options: {
  selectedWorkspaceId: () => string;
  selectedWorkspaceRoot: () => string;
  runtimeWorkspaceId: () => string | null;
  openworkServer: OpenworkServerStore;
  schedulerPluginInstalled: () => boolean;
}) {
  const [scheduledJobs, setScheduledJobs] = createSignal<ScheduledJob[]>([]);
  const [scheduledJobsStatus, setScheduledJobsStatus] = createSignal<string | null>(null);
  const [scheduledJobsBusy, setScheduledJobsBusy] = createSignal(false);
  const [scheduledJobsUpdatedAt, setScheduledJobsUpdatedAt] = createSignal<number | null>(null);
  const [pendingRefreshContextKey, setPendingRefreshContextKey] = createSignal<string | null>(null);

  const serverBacked = createMemo(() => {
    const client = options.openworkServer.openworkServerClient();
    const runtimeWorkspaceId = (options.runtimeWorkspaceId() ?? "").trim();
    return options.openworkServer.openworkServerStatus() === "connected" && Boolean(client && runtimeWorkspaceId);
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
      const client = options.openworkServer.openworkServerClient();
      const workspaceId = (options.runtimeWorkspaceId() ?? "").trim();
      if (!client || options.openworkServer.openworkServerStatus() !== "connected" || !workspaceId) {
        if (scheduledJobsContextKey() !== requestContextKey) return "skipped";
        const status =
          options.openworkServer.openworkServerStatus() === "disconnected"
            ? t("automations.server_unavailable")
            : options.openworkServer.openworkServerStatus() === "limited"
              ? t("automations.server_needs_token")
              : t("automations.server_not_ready");
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
        setScheduledJobsStatus(message || t("automations.failed_to_load"));
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
      setScheduledJobsStatus(message || t("automations.failed_to_load"));
      return "error";
    } finally {
      setScheduledJobsBusy(false);
    }
  };

  const deleteScheduledJob = async (name: string) => {
    if (scheduledJobsSource() === "remote") {
      const client = options.openworkServer.openworkServerClient();
      const workspaceId = (options.runtimeWorkspaceId() ?? "").trim();
      if (!client || !workspaceId) {
        throw new Error(t("automations.server_unavailable"));
      }
      const response = await client.deleteScheduledJob(workspaceId, name);
      setScheduledJobs((current) => current.filter((entry) => entry.slug !== response.job.slug));
      return;
    }

    if (!isTauriRuntime()) {
      throw new Error(t("automations.desktop_required"));
    }
    const root = options.selectedWorkspaceRoot().trim();
    const job = await schedulerDeleteJob(name, root || undefined);
    setScheduledJobs((current) => current.filter((entry) => entry.slug !== job.slug));
  };

  const prepareCreateAutomation = (input: PrepareCreateAutomationInput) =>
    buildCreateAutomationPrompt(input);

  const prepareRunAutomation = (
    job: ScheduledJob,
    fallbackWorkdir?: string | null,
  ) => buildRunAutomationPrompt(job, fallbackWorkdir);

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
    jobs: scheduledJobs,
    jobsStatus: scheduledJobsStatus,
    jobsBusy: scheduledJobsBusy,
    jobsUpdatedAt: scheduledJobsUpdatedAt,
    jobsSource: scheduledJobsSource,
    pollingAvailable: scheduledJobsPollingAvailable,
    refresh: refreshScheduledJobs,
    remove: deleteScheduledJob,
    prepareCreateAutomation,
    prepareRunAutomation,
  };
}
