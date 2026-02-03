import { For, Show, createMemo, createSignal } from "solid-js";

import type { ScheduledJob } from "../types";
import { formatRelativeTime, isTauriRuntime } from "../utils";

import Button from "../components/button";
import {
  Calendar,
  Clock,
  FolderOpen,
  RefreshCw,
  Terminal,
  Trash2,
} from "lucide-solid";

export type ScheduledTasksViewProps = {
  jobs: ScheduledJob[];
  source: "local" | "remote";
  sourceReady: boolean;
  status: string | null;
  busy: boolean;
  lastUpdatedAt: number | null;
  refreshJobs: (options?: { force?: boolean }) => void;
  deleteJob: (name: string) => Promise<void> | void;
  isWindows: boolean;
};

const toRelative = (value?: string | null) => {
  if (!value) return "Never";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "Never";
  return formatRelativeTime(parsed);
};

const taskSummary = (job: ScheduledJob) => {
  const run = job.run;
  if (run?.command) {
    const args = run.arguments ? ` ${run.arguments}` : "";
    return { label: "Command", value: `${run.command}${args}`, mono: true };
  }
  const prompt = run?.prompt ?? job.prompt;
  if (prompt) {
    return { label: "Prompt", value: prompt, mono: false };
  }
  return { label: "Task", value: "No prompt or command found.", mono: false };
};

const statusLabel = (status?: string | null) => {
  if (!status) return "Not run yet";
  if (status === "running") return "Running";
  if (status === "success") return "Success";
  if (status === "failed") return "Failed";
  return status;
};

const statusTone = (status?: string | null) => {
  if (status === "success") return "border-emerald-7/50 bg-emerald-4/20 text-emerald-11";
  if (status === "failed") return "border-red-7/50 bg-red-4/20 text-red-11";
  if (status === "running") return "border-amber-7/50 bg-amber-4/20 text-amber-11";
  return "border-gray-6/60 bg-gray-2/40 text-gray-11";
};

export default function ScheduledTasksView(props: ScheduledTasksViewProps) {
  const supported = createMemo(() => {
    if (props.source === "remote") return props.sourceReady;
    return isTauriRuntime() && !props.isWindows;
  });
  const supportNote = createMemo(() => {
    if (props.source === "remote") {
      return props.sourceReady ? null : "OpenWork server unavailable. Connect to sync scheduled tasks.";
    }
    if (!isTauriRuntime()) return "Scheduled tasks require the desktop app.";
    if (props.isWindows) return "Scheduler is not supported on Windows yet.";
    return null;
  });
  const sourceDescription = createMemo(() =>
    props.source === "remote"
      ? "Automations that run on a schedule from the connected OpenWork server."
      : "Automations that run on a schedule from this device."
  );
  const sourceLabel = createMemo(() =>
    props.source === "remote" ? "From OpenWork server" : "From local scheduler"
  );
  const schedulerLabel = createMemo(() => (props.source === "remote" ? "OpenWork server" : "Local"));
  const schedulerHint = createMemo(() =>
    props.source === "remote" ? "Remote instance" : "Launchd or systemd"
  );
  const schedulerUnavailableHint = createMemo(() =>
    props.source === "remote" ? "OpenWork server unavailable" : "Desktop-only"
  );
  const deleteDescription = createMemo(() =>
    props.source === "remote"
      ? "This removes the schedule and deletes the job definition from the connected OpenWork server."
      : "This removes the schedule and deletes the job definition from your machine."
  );

  const lastUpdatedLabel = createMemo(() => {
    if (!props.lastUpdatedAt) return "Not synced yet";
    return formatRelativeTime(props.lastUpdatedAt);
  });

  const [deleteTarget, setDeleteTarget] = createSignal<ScheduledJob | null>(null);
  const [deleteBusy, setDeleteBusy] = createSignal(false);
  const [deleteError, setDeleteError] = createSignal<string | null>(null);

  const confirmDelete = async () => {
    const target = deleteTarget();
    if (!target) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await props.deleteJob(target.slug);
      setDeleteTarget(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDeleteError(message || "Failed to delete job.");
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <section class="space-y-8">
      <div class="bg-gradient-to-r from-gray-2 to-gray-4 rounded-3xl p-1">
        <div class="bg-gray-1 rounded-[22px] p-6 md:p-8 space-y-6">
          <div class="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h3 class="text-lg font-semibold text-gray-12">Scheduled Tasks</h3>
              <p class="text-sm text-gray-10 mt-1">
                {sourceDescription()}
              </p>
            </div>
            <Button
              variant="secondary"
              onClick={() => props.refreshJobs({ force: true })}
              disabled={!supported() || props.busy}
            >
              <RefreshCw size={16} />
              {props.busy ? "Refreshing" : "Refresh"}
            </Button>
          </div>

          <div class="grid gap-3 sm:grid-cols-3">
            <div class="rounded-2xl border border-gray-6/60 bg-gray-2/40 p-4">
              <div class="text-[11px] uppercase tracking-wider text-gray-10">
                Scheduled Jobs
              </div>
              <div class="mt-2 text-2xl font-semibold text-gray-12">
                {props.jobs.length}
              </div>
              <div class="text-xs text-gray-9 mt-1">Active schedules</div>
            </div>
            <div class="rounded-2xl border border-gray-6/60 bg-gray-2/40 p-4">
              <div class="text-[11px] uppercase tracking-wider text-gray-10">
                Last Sync
              </div>
              <div class="mt-2 text-lg font-semibold text-gray-12">
                {supported() ? lastUpdatedLabel() : "Unavailable"}
              </div>
              <div class="text-xs text-gray-9 mt-1">{sourceLabel()}</div>
            </div>
            <div class="rounded-2xl border border-gray-6/60 bg-gray-2/40 p-4">
              <div class="text-[11px] uppercase tracking-wider text-gray-10">Scheduler</div>
              <div class="mt-2 text-lg font-semibold text-gray-12">
                {supported() ? schedulerLabel() : "Unavailable"}
              </div>
              <div class="text-xs text-gray-9 mt-1">
                {supported() ? schedulerHint() : schedulerUnavailableHint()}
              </div>
            </div>
          </div>
        </div>
      </div>

      <Show when={supportNote()}>
        <div class="rounded-2xl border border-gray-6/60 bg-gray-2/40 px-5 py-4 text-sm text-gray-10">
          {supportNote()}
        </div>
      </Show>

      <Show when={props.status}>
        <div class="rounded-2xl border border-red-7/40 bg-red-4/10 px-5 py-4 text-sm text-red-11">
          {props.status}
        </div>
      </Show>

      <Show when={deleteError()}>
        <div class="rounded-2xl border border-red-7/40 bg-red-4/10 px-5 py-4 text-sm text-red-11">
          {deleteError()}
        </div>
      </Show>

      <div class="rounded-2xl border border-gray-6/60 bg-gray-1/40 overflow-hidden">
        <Show
          when={props.jobs.length}
          fallback={
            <div class="px-6 py-10 text-sm text-gray-10">
              No scheduled tasks yet. Add the opencode-scheduler plugin and create a job to
              see it here.
            </div>
          }
        >
          <div class="divide-y divide-gray-6/60">
            <For each={props.jobs}>
              {(job) => {
                const summary = () => taskSummary(job);
                return (
                  <div class="p-6 space-y-4">
                    <div class="flex flex-wrap items-start justify-between gap-4">
                      <div class="space-y-2">
                        <div class="flex items-center gap-2">
                          <Calendar size={16} class="text-gray-11" />
                          <div class="text-sm font-semibold text-gray-12">{job.name}</div>
                        </div>
                        <div class="text-xs text-gray-10">
                          Cron <span class="font-mono text-gray-12">{job.schedule}</span>
                        </div>
                        <div class="text-[11px] text-gray-7 font-mono">{job.slug}</div>
                      </div>
                      <div class="flex items-center gap-2">
                        <span
                          class={`px-2 py-1 rounded-full border text-[11px] font-medium ${statusTone(
                            job.lastRunStatus
                          )}`}
                        >
                          {statusLabel(job.lastRunStatus)}
                        </span>
                        <Button
                          variant="danger"
                          class="!px-3 !py-2 text-xs"
                          onClick={() => setDeleteTarget(job)}
                          disabled={!supported() || props.busy || deleteBusy()}
                        >
                          <Trash2 size={14} />
                          Delete
                        </Button>
                      </div>
                    </div>

                    <div class="grid gap-3 md:grid-cols-2">
                      <div class="rounded-xl border border-gray-6/60 bg-gray-2/30 p-4 space-y-2">
                        <div class="text-[10px] uppercase tracking-wide text-gray-10">
                          {summary().label}
                        </div>
                        <div
                          class={`text-sm text-gray-12 break-words ${
                            summary().mono ? "font-mono" : ""
                          }`}
                        >
                          {summary().value}
                        </div>
                      </div>
                      <div class="rounded-xl border border-gray-6/60 bg-gray-2/30 p-4 space-y-2">
                        <div class="text-[10px] uppercase tracking-wide text-gray-10">Run context</div>
                        <div class="space-y-2 text-xs text-gray-10">
                          <div class="flex items-center gap-2">
                            <FolderOpen size={14} class="text-gray-9" />
                            <span class="font-mono text-gray-12 break-all">
                              {job.workdir ?? "Default"}
                            </span>
                          </div>
                          <Show when={job.run?.attachUrl ?? job.attachUrl}>
                            <div class="flex items-center gap-2">
                              <Terminal size={14} class="text-gray-9" />
                              <span class="font-mono text-gray-12 break-all">
                                {job.run?.attachUrl ?? job.attachUrl}
                              </span>
                            </div>
                          </Show>
                          <Show when={job.source}>
                            <div class="text-[11px] text-gray-9">Source: {job.source}</div>
                          </Show>
                        </div>
                      </div>
                    </div>

                    <div class="flex flex-wrap gap-4 text-xs text-gray-10">
                      <div class="flex items-center gap-1">
                        <Clock size={12} />
                        Last run {toRelative(job.lastRunAt)}
                      </div>
                      <div>Created {toRelative(job.createdAt)}</div>
                      <Show when={job.run?.agent}>
                        <div>Agent {job.run?.agent}</div>
                      </Show>
                      <Show when={job.run?.model}>
                        <div>Model {job.run?.model}</div>
                      </Show>
                    </div>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>
      </div>

      <Show when={deleteTarget()}>
        <div class="fixed inset-0 z-50 bg-gray-1/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div class="bg-gray-2 border border-gray-6/70 w-full max-w-md rounded-2xl shadow-2xl overflow-hidden">
            <div class="p-6 space-y-4">
              <div class="flex items-start justify-between gap-4">
                <div>
                  <h3 class="text-lg font-semibold text-gray-12">Delete scheduled task?</h3>
                  <p class="text-sm text-gray-11 mt-1">
                    {deleteDescription()}
                  </p>
                </div>
              </div>
              <div class="rounded-xl bg-gray-1/20 border border-gray-6 p-3 text-xs text-gray-11 font-mono break-all">
                {deleteTarget()?.name}
              </div>
              <div class="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleteBusy()}>
                  Cancel
                </Button>
                <Button variant="danger" onClick={confirmDelete} disabled={deleteBusy()}>
                  {deleteBusy() ? "Deleting" : "Delete"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </Show>
    </section>
  );
}
