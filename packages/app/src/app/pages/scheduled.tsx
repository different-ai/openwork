import { For, Show, createMemo, createSignal } from "solid-js";

import type { ScheduledJob } from "../types";
import { usePlatform } from "../context/platform";
import { formatRelativeTime, isTauriRuntime } from "../utils";

import Button from "../components/button";
import {
  BookOpen,
  Brain,
  Calendar,
  Clock,
  FolderOpen,
  MessageSquare,
  Plus,
  Play,
  PlugZap,
  RefreshCw,
  Terminal,
  Trash2,
  TrendingUp,
  Trophy,
  X,
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
  activeWorkspaceRoot: string;
  createSessionAndOpen: () => void;
  setPrompt: (value: string) => void;
  newTaskDisabled: boolean;
  schedulerInstalled: boolean;
  canEditPlugins: boolean;
  addPlugin: (pluginNameOverride?: string) => void;
  reloadWorkspaceEngine: () => Promise<void>;
  reloadBusy: boolean;
  canReloadWorkspace: boolean;
};

const toRelative = (value?: string | null) => {
  if (!value) return "Never";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "Never";
  return formatRelativeTime(parsed);
};

const pad2 = (value: number) => String(value).padStart(2, "0");

const parseCronNumbers = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return [] as number[];
  const parts = trimmed.split(",");
  const values = new Set<number>();
  for (const part of parts) {
    const segment = part.trim();
    if (!segment) continue;
    if (segment.includes("-")) {
      const [startRaw, endRaw] = segment.split("-");
      const start = Number.parseInt(startRaw ?? "", 10);
      const end = Number.parseInt(endRaw ?? "", 10);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      const lo = Math.min(start, end);
      const hi = Math.max(start, end);
      for (let i = lo; i <= hi; i += 1) values.add(i);
      continue;
    }
    const num = Number.parseInt(segment, 10);
    if (!Number.isFinite(num)) continue;
    values.add(num);
  }
  return Array.from(values).sort((a, b) => a - b);
};

const humanizeCron = (cron: string) => {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return "Custom schedule";
  const [minuteRaw, hourRaw, dom, mon, dowRaw] = parts;
  if (!minuteRaw || !hourRaw || !dom || !mon || !dowRaw) return "Custom schedule";

  // Every N hours
  if (minuteRaw === "0" && hourRaw.startsWith("*/") && dom === "*" && mon === "*" && dowRaw === "*") {
    const interval = Number.parseInt(hourRaw.slice(2), 10);
    if (Number.isFinite(interval) && interval > 0) {
      return interval === 1 ? "Every hour" : `Every ${interval} hours`;
    }
  }

  // Daily / weekly at a fixed time
  const hour = Number.parseInt(hourRaw, 10);
  const minute = Number.parseInt(minuteRaw, 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return "Custom schedule";
  if (dom !== "*" || mon !== "*") return "Custom schedule";

  const timeLabel = `${pad2(hour)}:${pad2(minute)}`;

  if (dowRaw === "*") {
    return `Every day at ${timeLabel}`;
  }

  const days = parseCronNumbers(dowRaw);
  const normalized = new Set(days.map((d) => (d === 7 ? 0 : d)));
  const allDays = [0, 1, 2, 3, 4, 5, 6];
  const weekdayDays = [1, 2, 3, 4, 5];
  const weekendDays = [0, 6];

  const includesAll = allDays.every((d) => normalized.has(d));
  if (includesAll) return `Every day at ${timeLabel}`;

  const includesWeekdays = weekdayDays.every((d) => normalized.has(d)) && !weekendDays.some((d) => normalized.has(d));
  if (includesWeekdays) return `Weekdays at ${timeLabel}`;

  const includesWeekends = weekendDays.every((d) => normalized.has(d)) && !weekdayDays.some((d) => normalized.has(d));
  if (includesWeekends) return `Weekends at ${timeLabel}`;

  const labels: Record<number, string> = {
    0: "Sun",
    1: "Mon",
    2: "Tue",
    3: "Wed",
    4: "Thu",
    5: "Fri",
    6: "Sat",
  };
  const list = Array.from(normalized)
    .filter((d) => d >= 0 && d <= 6)
    .sort((a, b) => a - b)
    .map((d) => labels[d] ?? String(d))
    .join(", ");
  if (!list) return `At ${timeLabel}`;
  return `${list} at ${timeLabel}`;
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
  if (status === "success") return "border-emerald-7/60 bg-emerald-3/60 text-emerald-11";
  if (status === "failed") return "border-red-7/60 bg-red-3/60 text-red-11";
  if (status === "running") return "border-amber-7/60 bg-amber-3/60 text-amber-11";
  return "border-gray-6 bg-gray-2 text-gray-9";
};

const statusIconTone = (status?: string | null) => {
  if (status === "success") return "border-emerald-6 text-emerald-10";
  if (status === "failed") return "border-red-6 text-red-10";
  if (status === "running") return "border-amber-6 text-amber-10";
  return "border-gray-6 text-gray-9";
};

const automationTemplates = [
  {
    icon: Calendar,
    name: "Daily planning brief",
    description: "Build a focused plan from your tasks and calendar.",
    prompt: "Review my pending tasks and calendar, then draft a practical plan for today with top priorities and one follow-up reminder.",
    tone: "text-blue-9",
    scheduleMode: "daily" as const,
    scheduleTime: "08:30",
    scheduleDays: ["mo", "tu", "we", "th", "fr"],
  },
  {
    icon: BookOpen,
    name: "Inbox zero helper",
    description: "Summarize unread messages and draft short replies.",
    prompt: "Summarize unread inbox messages, suggest priority order, and draft concise reply options for the top conversations.",
    tone: "text-teal-9",
    scheduleMode: "daily" as const,
    scheduleTime: "17:30",
    scheduleDays: ["mo", "tu", "we", "th", "fr"],
  },
  {
    icon: MessageSquare,
    name: "Meeting prep notes",
    description: "Generate prep bullets for tomorrow's meetings.",
    prompt: "Prepare meeting briefs for tomorrow with context, talking points, and questions to unblock decisions.",
    tone: "text-indigo-9",
    scheduleMode: "daily" as const,
    scheduleTime: "18:00",
    scheduleDays: ["mo", "tu", "we", "th", "fr"],
  },
  {
    icon: TrendingUp,
    name: "Weekly wins recap",
    description: "Create a Friday recap of wins, blockers, and next steps.",
    prompt: "Summarize the week into wins, blockers, and clear next steps I can share with the team.",
    tone: "text-emerald-9",
    scheduleMode: "daily" as const,
    scheduleTime: "16:00",
    scheduleDays: ["fr"],
  },
  {
    icon: Trophy,
    name: "Learning digest",
    description: "Turn saved links and notes into a weekly digest.",
    prompt: "Collect my saved links and notes, then draft a weekly learning digest with key ideas and follow-up actions.",
    tone: "text-amber-9",
    scheduleMode: "daily" as const,
    scheduleTime: "10:00",
    scheduleDays: ["su"],
  },
  {
    icon: Brain,
    name: "Habit check-in",
    description: "Run a quick accountability check through the day.",
    prompt: "Ask me for a quick progress check-in, capture blockers, and suggest one concrete next action.",
    tone: "text-pink-9",
    scheduleMode: "interval" as const,
    intervalHours: 6,
  },
];

const dayOptions = [
  { id: "mo", label: "Mo", cron: "1" },
  { id: "tu", label: "Tu", cron: "2" },
  { id: "we", label: "We", cron: "3" },
  { id: "th", label: "Th", cron: "4" },
  { id: "fr", label: "Fr", cron: "5" },
  { id: "sa", label: "Sa", cron: "6" },
  { id: "su", label: "Su", cron: "0" },
];

const normalizeSentence = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/[.!?]$/.test(trimmed)) return trimmed;
  return `${trimmed}.`;
};

const buildCronFromDaily = (timeValue: string, days: string[]) => {
  const [hour, minute] = timeValue.split(":");
  if (!hour || !minute) return "";
  const hourValue = Number.parseInt(hour, 10);
  const minuteValue = Number.parseInt(minute, 10);
  if (!Number.isFinite(hourValue) || !Number.isFinite(minuteValue)) return "";
  if (!days.length) return "";
  if (days.length === dayOptions.length) {
    return `${minuteValue} ${hourValue} * * *`;
  }
  const daySpec = dayOptions
    .filter((day) => days.includes(day.id))
    .map((day) => day.cron)
    .join(",");
  if (!daySpec) return "";
  return `${minuteValue} ${hourValue} * * ${daySpec}`;
};

const buildCronFromInterval = (hours: number) => {
  if (!Number.isFinite(hours) || hours <= 0) return "";
  const interval = Math.max(1, Math.round(hours));
  return `0 */${interval} * * *`;
};

const buildAutomationPrompt = (options: {
  name: string;
  prompt: string;
  schedule: string;
  workdir: string;
}) => {
  const name = options.name.trim();
  const schedule = options.schedule.trim();
  const prompt = normalizeSentence(options.prompt);
  if (!schedule || !prompt) return "";
  const workdir = options.workdir.trim();
  const nameSegment = name ? ` named "${name}"` : "";
  const workdirSegment = workdir ? ` Run from ${workdir}.` : "";
  return `Schedule a job${nameSegment} with cron "${schedule}" to ${prompt}${workdirSegment}`.trim();
};

const AutomationCard = (props: {
  icon: any;
  description: string;
  tone?: string;
  onClick?: () => void;
  disabled?: boolean;
}) => {
  const Icon = props.icon;
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      class={`group w-full rounded-2xl border bg-gray-1 p-5 text-left transition-shadow hover:shadow-md ${
        props.disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"
      } border-gray-4 hover:border-gray-5`}
    >
      <div class={`mb-4 flex h-8 w-8 items-center justify-center rounded-lg border border-gray-3 bg-gray-1 ${
        props.tone ?? ""
      }`}>
        <Icon size={18} />
      </div>
      <p class="text-[13px] text-gray-10 leading-relaxed group-hover:text-gray-12">{props.description}</p>
    </button>
  );
};

const AutomationJobCard = (props: {
  job: ScheduledJob;
  supported: boolean;
  busy: boolean;
  onDelete: () => void;
  onRun: () => void;
}) => {
  const summary = () => taskSummary(props.job);
  const status = () => props.job.lastRunStatus;
  const scheduleLabel = () => humanizeCron(props.job.schedule);
  return (
    <div class="flex flex-col gap-4 rounded-2xl border border-gray-4 bg-gray-1 p-5 shadow-sm">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div class="flex min-w-0 items-start gap-3">
          <div
            class={`flex h-8 w-8 items-center justify-center rounded-lg border bg-gray-1 ${statusIconTone(
              status()
            )}`}
          >
            <Calendar size={18} />
          </div>
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <h3 class="text-sm font-semibold text-gray-12 truncate">{props.job.name}</h3>
              <span
                class={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${statusTone(
                  status()
                )}`}
              >
                {statusLabel(status())}
              </span>
            </div>
            <div class="mt-1 text-xs text-gray-9">{scheduleLabel()}</div>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <button
            type="button"
            onClick={props.onRun}
            disabled={!props.supported || props.busy}
            class={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
              !props.supported || props.busy
                ? "border-gray-5 text-gray-8"
                : "border-gray-5 text-gray-10 hover:bg-gray-2/70 hover:text-gray-12"
            }`}
          >
            <Play size={12} />
            Run
          </button>
          <button
            type="button"
            onClick={props.onDelete}
            disabled={!props.supported || props.busy}
            class={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
              !props.supported || props.busy
                ? "border-gray-5 text-gray-8"
                : "border-red-6 text-red-10 hover:bg-red-3"
            }`}
          >
            <Trash2 size={12} />
            Delete
          </button>
        </div>
      </div>

      <div class="grid gap-3 md:grid-cols-2">
        <div class="rounded-xl border border-gray-4 bg-gray-2/60 px-3 py-3">
          <div class="text-[10px] uppercase tracking-wide text-gray-8">{summary().label}</div>
          <div
            class={`mt-1 text-sm text-gray-12 break-words ${summary().mono ? "font-mono" : ""}`}
          >
            {summary().value}
          </div>
        </div>
        <div class="rounded-xl border border-gray-4 bg-gray-2/60 px-3 py-3 space-y-2">
          <div class="text-[10px] uppercase tracking-wide text-gray-8">Run context</div>
          <div class="space-y-2 text-xs text-gray-9">
            <div class="flex items-center gap-2">
              <FolderOpen size={14} class="text-gray-8" />
              <span class="font-mono text-gray-12 break-all">
                {props.job.workdir ?? "Default"}
              </span>
            </div>
            <Show when={props.job.run?.attachUrl ?? props.job.attachUrl}>
              <div class="flex items-center gap-2">
                <Terminal size={14} class="text-gray-8" />
                <span class="font-mono text-gray-12 break-all">
                  {props.job.run?.attachUrl ?? props.job.attachUrl}
                </span>
              </div>
            </Show>
            <Show when={props.job.source}>
              <div class="text-[11px] text-gray-8">Source: {props.job.source}</div>
            </Show>
          </div>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-4 text-xs text-gray-9">
        <div class="flex items-center gap-1">
          <Clock size={12} />
          Last run {toRelative(props.job.lastRunAt)}
        </div>
        <div>Created {toRelative(props.job.createdAt)}</div>
        <Show when={props.job.run?.agent}>
          <div>Agent {props.job.run?.agent}</div>
        </Show>
        <Show when={props.job.run?.model}>
          <div>Model {props.job.run?.model}</div>
        </Show>
      </div>
    </div>
  );
};

export default function ScheduledTasksView(props: ScheduledTasksViewProps) {
  const platform = usePlatform();
  const [installingScheduler, setInstallingScheduler] = createSignal(false);
  const [schedulerInstallRequested, setSchedulerInstallRequested] = createSignal(false);
  const supported = createMemo(() => {
    if (props.source === "remote") return props.sourceReady;
    return (
      isTauriRuntime() &&
      !props.isWindows &&
      props.schedulerInstalled &&
      !schedulerInstallRequested()
    );
  });
  const schedulerGateActive = createMemo(() => {
    if (props.source !== "local") return false;
    if (!isTauriRuntime() || props.isWindows) return false;
    return !props.schedulerInstalled || schedulerInstallRequested();
  });
  const schedulerGateMode = createMemo(() => (props.schedulerInstalled ? "reload" : "install"));
  const automationDisabled = createMemo(() => props.newTaskDisabled || schedulerGateActive());
  const supportNote = createMemo(() => {
    if (props.source === "remote") {
      return props.sourceReady ? null : "OpenWork server unavailable. Connect to sync scheduled tasks.";
    }
    if (!isTauriRuntime()) return "Scheduled tasks require the desktop app.";
    if (props.isWindows) return "Scheduler is not supported on Windows yet.";
    if (!props.schedulerInstalled || schedulerInstallRequested()) return null;
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
  const [createModalOpen, setCreateModalOpen] = createSignal(false);
  const [automationName, setAutomationName] = createSignal("Daily bug scan");
  const [automationProject, setAutomationProject] = createSignal(props.activeWorkspaceRoot);
  const [automationPrompt, setAutomationPrompt] = createSignal(
    "Scan recent commits and flag riskier diffs."
  );
  const [scheduleMode, setScheduleMode] = createSignal<"daily" | "interval">("daily");
  const [scheduleTime, setScheduleTime] = createSignal("09:00");
  const [scheduleDays, setScheduleDays] = createSignal(["mo", "tu", "we", "th", "fr"]);
  const [intervalHours, setIntervalHours] = createSignal(6);

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

  const cronExpression = createMemo(() => {
    if (scheduleMode() === "interval") {
      return buildCronFromInterval(intervalHours());
    }
    return buildCronFromDaily(scheduleTime(), scheduleDays());
  });

  const createPromptValue = createMemo(() =>
    buildAutomationPrompt({
      name: automationName(),
      prompt: automationPrompt(),
      schedule: cronExpression(),
      workdir: automationProject(),
    })
  );

  const canCreateAutomation = createMemo(() => !!createPromptValue());

  const openSchedulerDocs = () => {
    platform.openLink("https://github.com/anomalyco/opencode-scheduler");
  };

  const handleInstallScheduler = async () => {
    if (installingScheduler() || !props.canEditPlugins) return;
    setInstallingScheduler(true);
    setSchedulerInstallRequested(true);
    try {
      await Promise.resolve(props.addPlugin("opencode-scheduler"));
    } finally {
      setInstallingScheduler(false);
    }
  };

  const openCreateModal = () => {
    if (automationDisabled()) return;
    const root = props.activeWorkspaceRoot.trim();
    if (!automationProject().trim() && root) {
      setAutomationProject(root);
    }
    setCreateModalOpen(true);
  };

  const openCreateModalFromTemplate = (template: (typeof automationTemplates)[number]) => {
    if (automationDisabled()) return;
    const root = props.activeWorkspaceRoot.trim();
    if (root) {
      setAutomationProject(root);
    }
    setAutomationName(template.name);
    setAutomationPrompt(template.prompt);
    setScheduleMode(template.scheduleMode);
    if (template.scheduleMode === "interval") {
      setIntervalHours(template.intervalHours ?? 6);
    } else {
      setScheduleTime(template.scheduleTime ?? "09:00");
      setScheduleDays(template.scheduleDays ?? ["mo", "tu", "we", "th", "fr"]);
    }
    setCreateModalOpen(true);
  };

  const handleCreateAutomation = () => {
    if (automationDisabled()) return;
    const promptValue = createPromptValue();
    if (!promptValue) return;
    props.setPrompt(promptValue);
    props.createSessionAndOpen();
    setCreateModalOpen(false);
  };

  const runAutomationNow = (job: ScheduledJob) => {
    const run = job.run;
    const workdir = (job.workdir ?? props.activeWorkspaceRoot ?? "").trim();
    const schedule = humanizeCron(job.schedule);

    if (run?.prompt || job.prompt) {
      const promptBody = (run?.prompt ?? job.prompt ?? "").trim();
      const workdirHint = workdir ? `\n\nRun from ${workdir}.` : "";
      props.setPrompt(`Run this automation now: ${job.name}.\nSchedule: ${schedule}.\n\n${promptBody}${workdirHint}`.trim());
      props.createSessionAndOpen();
      return;
    }

    if (run?.command) {
      const args = run.arguments ? ` ${run.arguments}` : "";
      const cmd = `${run.command}${args}`.trim();
      const workdirHint = workdir ? `\n\nRun from ${workdir}.` : "";
      props.setPrompt(
        `Run this automation now: ${job.name}.\nSchedule: ${schedule}.\n\nRun the following command:\n${cmd}${workdirHint}`.trim()
      );
      props.createSessionAndOpen();
      return;
    }

    props.setPrompt(`Run this automation now: ${job.name}.\nSchedule: ${schedule}.`);
    props.createSessionAndOpen();
  };

  const toggleDay = (id: string) => {
    setScheduleDays((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return Array.from(next);
    });
  };

  const updateIntervalHours = (value: string) => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return;
    const bounded = Math.min(24, Math.max(1, parsed));
    setIntervalHours(bounded);
  };

  return (
    <section class="space-y-10">
      <div class="flex flex-wrap items-center justify-end gap-4">
        <button
          type="button"
          onClick={openSchedulerDocs}
          class="text-xs font-medium text-gray-9 transition-colors hover:text-gray-12"
        >
          Learn more
        </button>
        <button
          type="button"
          onClick={() => props.refreshJobs({ force: true })}
          disabled={!supported() || props.busy}
          class={`flex items-center gap-1.5 text-xs font-medium transition-colors ${
            !supported() || props.busy
              ? "text-gray-8"
              : "text-gray-9 hover:text-gray-12"
          }`}
        >
          <RefreshCw size={14} />
          {props.busy ? "Refreshing" : "Refresh"}
        </button>
        <button
          type="button"
          onClick={openCreateModal}
          disabled={automationDisabled()}
          class={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
            automationDisabled()
              ? "bg-gray-3 text-gray-8"
              : "bg-gray-12 text-gray-1 hover:bg-gray-11"
          }`}
        >
          <Plus size={14} />
          New automation
        </button>
      </div>

      <div class="pt-8 text-center">
        <div class="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-gray-4 bg-gray-1 shadow-sm">
          <Terminal size={28} class="text-gray-9" />
        </div>
        <div class="flex items-center justify-center gap-2">
          <h2 class="text-2xl font-semibold text-gray-12">Automations</h2>
          <span class="rounded border border-gray-4 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-tight text-gray-8">
            Beta
          </span>
        </div>
        <p class="mt-2 text-sm text-gray-9">{sourceDescription()}</p>
      </div>

      <Show when={schedulerGateActive()}>
        <div class="rounded-2xl border border-gray-5 bg-gradient-to-b from-gray-1 to-gray-2/70 px-5 py-5 shadow-sm">
          <div class="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div class="flex items-start gap-3">
              <div class="flex h-10 w-10 items-center justify-center rounded-xl border border-gray-4 bg-gray-1">
                <PlugZap size={18} class="text-gray-10" />
              </div>
              <div>
                <div class="text-sm font-semibold text-gray-12">
                  {schedulerGateMode() === "reload"
                    ? "Reload OpenWork to activate automations"
                    : "Install the scheduler to unlock automations"}
                </div>
                <div class="mt-1 text-xs text-gray-9">
                  {schedulerGateMode() === "reload"
                    ? "OpenCode loads plugins at startup. Reload OpenWork to activate opencode-scheduler."
                    : "Automations run through the opencode-scheduler plugin. Add it to this workspace to enable scheduling."}
                </div>
              </div>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                onClick={handleInstallScheduler}
                disabled={!props.canEditPlugins || installingScheduler()}
              >
                {installingScheduler() ? "Installing..." : "Install scheduler"}
              </Button>
              <Button
                variant="outline"
                onClick={() => void props.reloadWorkspaceEngine()}
                disabled={!props.canReloadWorkspace || props.reloadBusy || !props.schedulerInstalled}
              >
                {props.reloadBusy ? "Reloading..." : "Reload OpenWork"}
              </Button>
              <button
                type="button"
                onClick={openSchedulerDocs}
                class="text-xs font-medium text-gray-9 transition-colors hover:text-gray-12"
              >
                View docs
              </button>
            </div>
          </div>
        </div>
      </Show>

      <Show when={supportNote()}>
        <div class="rounded-xl border border-gray-4 bg-gray-2/60 px-5 py-4 text-sm text-gray-10">
          {supportNote()}
        </div>
      </Show>

      <Show when={props.status}>
        <div class="rounded-xl border border-red-7/40 bg-red-3/60 px-5 py-4 text-sm text-red-11">
          {props.status}
        </div>
      </Show>

      <Show when={deleteError()}>
        <div class="rounded-xl border border-red-7/40 bg-red-3/60 px-5 py-4 text-sm text-red-11">
          {deleteError()}
        </div>
      </Show>

      <Show
        when={props.jobs.length > 0}
        fallback={
          <div class={`space-y-4 ${schedulerGateActive() ? "opacity-60 pointer-events-none" : ""}`}>
            <div class="text-center text-sm text-gray-9">
              No automations yet. Pick a template or create your own automation prompt.
            </div>
            <div class="grid w-full max-w-5xl mx-auto grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              <For each={automationTemplates}>
                {(card) => (
                  <AutomationCard
                    icon={card.icon}
                    description={card.description}
                    tone={card.tone}
                    onClick={() => openCreateModalFromTemplate(card)}
                    disabled={automationDisabled()}
                  />
                )}
              </For>
            </div>
            <button
              type="button"
              onClick={openSchedulerDocs}
              class="mx-auto block text-xs text-gray-9 transition-colors hover:text-gray-12"
            >
              Explore more
            </button>
          </div>
        }
      >
        <div class={`grid w-full grid-cols-1 gap-4 ${schedulerGateActive() ? "opacity-60 pointer-events-none" : ""}`}>
          <For each={props.jobs}>
            {(job) => (
              <AutomationJobCard
                job={job}
                supported={supported()}
                busy={props.busy || deleteBusy()}
                onDelete={() => setDeleteTarget(job)}
                onRun={() => runAutomationNow(job)}
              />
            )}
          </For>
        </div>
      </Show>

      <Show when={deleteTarget()}>
        <div class="fixed inset-0 z-50 bg-black/20 backdrop-blur-sm flex items-center justify-center p-4">
          <div class="bg-white border border-gray-6 w-full max-w-md rounded-2xl shadow-2xl overflow-hidden">
            <div class="p-6 space-y-4">
              <div class="flex items-start justify-between gap-4">
                <div>
                  <h3 class="text-lg font-semibold text-gray-12">Delete automation?</h3>
                  <p class="text-sm text-gray-9 mt-1">{deleteDescription()}</p>
                </div>
              </div>
              <div class="rounded-xl bg-gray-2 border border-gray-6 p-3 text-xs text-gray-9 font-mono break-all">
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

      <Show when={createModalOpen()}>
        <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-[2px] p-4">
          <div class="w-full max-w-2xl rounded-3xl bg-white shadow-2xl overflow-hidden border border-gray-6">
            <div class="p-8 space-y-6">
              <div class="flex items-start justify-between gap-4">
                <div>
                  <h2 class="text-xl font-semibold text-gray-12">Create automation</h2>
                  <p class="text-xs text-gray-9 mt-2">
                    Automations are scheduled by running a prompt in a new thread. We’ll prefill
                    a prompt for you to send.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setCreateModalOpen(false)}
                  class="rounded-full p-1 text-gray-8 transition-colors hover:bg-gray-2 hover:text-gray-12"
                >
                  <X size={18} />
                </button>
              </div>

              <div class="space-y-6">
                <div>
                  <label class="mb-2 block text-[11px] font-bold uppercase tracking-wider text-gray-8">
                    Name
                  </label>
                  <input
                    type="text"
                    value={automationName()}
                    onInput={(event) => setAutomationName(event.currentTarget.value)}
                    class="w-full rounded-xl border border-gray-6 bg-gray-2 px-3 py-2 text-sm text-gray-12 focus:outline-none focus:ring-1 focus:ring-blue-9/20 focus:border-blue-7"
                  />
                </div>
                <div>
                  <label class="mb-2 block text-[11px] font-bold uppercase tracking-wider text-gray-8">
                    Projects
                  </label>
                  <input
                    type="text"
                    value={automationProject()}
                    onInput={(event) => setAutomationProject(event.currentTarget.value)}
                    placeholder="Choose a folder"
                    class="w-full rounded-xl border border-gray-6 bg-gray-2 px-3 py-2 text-sm text-gray-12 focus:outline-none focus:ring-1 focus:ring-blue-9/20 focus:border-blue-7"
                  />
                </div>
                <div>
                  <label class="mb-2 block text-[11px] font-bold uppercase tracking-wider text-gray-8">
                    Prompt
                  </label>
                  <div class="rounded-xl border border-gray-6 bg-gray-2 p-3">
                    <textarea
                      rows={4}
                      value={automationPrompt()}
                      onInput={(event) => setAutomationPrompt(event.currentTarget.value)}
                      class="w-full resize-none bg-transparent text-sm text-gray-12 focus:outline-none"
                    />
                  </div>
                </div>
                <div>
                  <div class="mb-2 flex items-center justify-between">
                    <label class="block text-[11px] font-bold uppercase tracking-wider text-gray-8">
                      Schedule
                    </label>
                    <div class="flex rounded-lg bg-gray-3 p-0.5">
                      <button
                        type="button"
                        onClick={() => setScheduleMode("daily")}
                        class={`px-3 py-1 text-[10px] font-bold rounded-md transition-colors ${
                          scheduleMode() === "daily"
                            ? "bg-gray-1 text-gray-12 shadow-sm"
                            : "text-gray-9"
                        }`}
                      >
                        Daily
                      </button>
                      <button
                        type="button"
                        onClick={() => setScheduleMode("interval")}
                        class={`px-3 py-1 text-[10px] font-bold rounded-md transition-colors ${
                          scheduleMode() === "interval"
                            ? "bg-gray-1 text-gray-12 shadow-sm"
                            : "text-gray-9"
                        }`}
                      >
                        Interval
                      </button>
                    </div>
                  </div>
                  <Show
                    when={scheduleMode() === "daily"}
                    fallback={
                      <div class="flex flex-wrap items-center gap-3">
                        <div class="flex items-center gap-2 rounded-xl border border-gray-6 bg-gray-2 px-3 py-2 text-sm text-gray-12">
                          <span>Every</span>
                          <input
                            type="number"
                            min={1}
                            max={24}
                            value={intervalHours()}
                            onInput={(event) => updateIntervalHours(event.currentTarget.value)}
                            class="w-16 bg-transparent text-right focus:outline-none"
                          />
                          <span>hours</span>
                        </div>
                      </div>
                    }
                  >
                    <div class="flex flex-wrap items-center gap-3">
                      <div class="flex items-center justify-between rounded-xl border border-gray-6 bg-gray-2 px-3 py-2 text-sm text-gray-12">
                        <input
                          type="time"
                          value={scheduleTime()}
                          onInput={(event) => setScheduleTime(event.currentTarget.value)}
                          class="bg-transparent focus:outline-none"
                        />
                        <Clock size={16} class="text-gray-8" />
                      </div>
                      <div class="flex flex-wrap gap-1">
                        <For each={dayOptions}>
                          {(day) => (
                            <button
                              type="button"
                              onClick={() => toggleDay(day.id)}
                              class={`h-8 w-8 rounded-full text-[10px] font-bold transition-colors ${
                                scheduleDays().includes(day.id)
                                  ? "bg-gray-12 text-gray-1"
                                  : "bg-gray-3 text-gray-9"
                              }`}
                            >
                              {day.label}
                            </button>
                          )}
                        </For>
                      </div>
                    </div>
                  </Show>
                  <Show when={cronExpression()}>
                    <div class="mt-2 text-[11px] text-gray-8">
                      Cron: <span class="font-mono text-gray-12">{cronExpression()}</span>
                    </div>
                  </Show>
                </div>
              </div>
            </div>
            <div class="flex items-center justify-between gap-4 border-t border-gray-6 bg-gray-2/60 px-8 py-4">
              <button
                type="button"
                onClick={openSchedulerDocs}
                class="text-xs font-medium text-gray-9 transition-colors hover:text-gray-12"
              >
                View scheduler docs
              </button>
              <div class="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setCreateModalOpen(false)}
                  class="px-4 py-2 text-xs font-medium text-gray-8 transition-colors hover:text-gray-12"
                >
                  Cancel
                </button>
                <button
                type="button"
                onClick={handleCreateAutomation}
                disabled={!canCreateAutomation() || automationDisabled()}
                class={`px-4 py-2 text-xs font-medium rounded-lg transition-colors ${
                  !canCreateAutomation() || automationDisabled()
                    ? "bg-gray-3 text-gray-8 cursor-not-allowed"
                    : "bg-gray-12 text-gray-1 hover:bg-gray-11"
                }`}
              >
                Create
                </button>
              </div>
            </div>
          </div>
        </div>
      </Show>
    </section>
  );
}
