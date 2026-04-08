import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";

import type { ScheduledJob } from "../types";
import { useAutomations } from "../automations/provider";
import { usePlatform } from "../context/platform";
import { formatRelativeTime, isTauriRuntime } from "../utils";
import { t, td } from "../../i18n";

import {
  BookOpen,
  Brain,
  Calendar,
  Clock,
  MessageSquare,
  Play,
  PlugZap,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  TrendingUp,
  Trophy,
  X,
} from "lucide-solid";
import { useStatusToasts, type AppStatusToastTone } from "../shell/status-toasts";

type AutomationsFilter = "all" | "scheduled" | "templates";
type ScheduleMode = "daily" | "interval";

type AutomationTemplate = {
  icon: any;
  name: string;
  description: string;
  prompt: string;
  scheduleMode: ScheduleMode;
  scheduleTime?: string;
  scheduleDays?: string[];
  intervalHours?: number;
  badge: string;
};

const pageTitleClass = "text-[28px] font-semibold tracking-[-0.5px] text-dls-text";
const sectionTitleClass = "text-[15px] font-medium tracking-[-0.2px] text-dls-text";
const panelCardClass =
  "rounded-[20px] border border-dls-border bg-dls-surface p-5 transition-all hover:border-dls-border hover:shadow-[0_2px_12px_-4px_rgba(0,0,0,0.06)]";
const pillButtonClass =
  "inline-flex items-center justify-center gap-1.5 rounded-full px-4 py-2 text-[13px] font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.18)] disabled:cursor-not-allowed disabled:opacity-60";
const pillPrimaryClass = `${pillButtonClass} bg-dls-accent text-white hover:bg-[var(--dls-accent-hover)]`;
const pillSecondaryClass = `${pillButtonClass} border border-dls-border bg-dls-surface text-dls-text hover:bg-dls-hover`;
const pillGhostClass = `${pillButtonClass} border border-dls-border bg-dls-surface text-dls-secondary hover:bg-dls-hover hover:text-dls-text`;
const tagClass =
  "inline-flex items-center rounded-md border border-dls-border bg-dls-hover px-2 py-1 text-[11px] text-dls-secondary";

const DEFAULT_AUTOMATION_NAME = () => td("scheduled.default_automation_name", "Daily bug scan");
const DEFAULT_AUTOMATION_PROMPT =
  "Scan recent commits and flag riskier diffs with the most important follow-ups.";
const DEFAULT_SCHEDULE_TIME = "09:00";
const DEFAULT_SCHEDULE_DAYS = ["mo", "tu", "we", "th", "fr"];
const DEFAULT_INTERVAL_HOURS = 6;

const automationTemplates: AutomationTemplate[] = [
  {
    icon: Calendar,
    name: td("scheduled.tpl_daily_planning_name", "Daily planning brief"),
    description: td("scheduled.tpl_daily_planning_desc", "Build a focused plan from your tasks and calendar."),
    prompt:
      "Review my pending tasks and calendar, then draft a practical plan for today with top priorities and one follow-up reminder.",
    scheduleMode: "daily",
    scheduleTime: "08:30",
    scheduleDays: ["mo", "tu", "we", "th", "fr"],
    badge: td("scheduled.badge_weekday_morning", "Weekday morning"),
  },
  {
    icon: BookOpen,
    name: td("scheduled.tpl_inbox_zero_name", "Inbox zero helper"),
    description: td("scheduled.tpl_inbox_zero_desc", "Summarize unread messages and draft short replies."),
    prompt:
      "Summarize unread inbox messages, suggest priority order, and draft concise reply options for the top conversations.",
    scheduleMode: "daily",
    scheduleTime: "17:30",
    scheduleDays: ["mo", "tu", "we", "th", "fr"],
    badge: td("scheduled.badge_end_of_day", "End-of-day"),
  },
  {
    icon: MessageSquare,
    name: td("scheduled.tpl_meeting_prep_name", "Meeting prep notes"),
    description: td("scheduled.tpl_meeting_prep_desc", "Generate prep bullets for tomorrow's meetings."),
    prompt:
      "Prepare meeting briefs for tomorrow with context, talking points, and questions to unblock decisions.",
    scheduleMode: "daily",
    scheduleTime: "18:00",
    scheduleDays: ["mo", "tu", "we", "th", "fr"],
    badge: td("scheduled.badge_weekday_evening", "Weekday evening"),
  },
  {
    icon: TrendingUp,
    name: td("scheduled.tpl_weekly_wins_name", "Weekly wins recap"),
    description: td("scheduled.tpl_weekly_wins_desc", "Create a Friday recap of wins, blockers, and next steps."),
    prompt:
      "Summarize the week into wins, blockers, and clear next steps I can share with the team.",
    scheduleMode: "daily",
    scheduleTime: "16:00",
    scheduleDays: ["fr"],
    badge: td("scheduled.badge_friday_wrapup", "Friday wrap-up"),
  },
  {
    icon: Trophy,
    name: td("scheduled.tpl_learning_digest_name", "Learning digest"),
    description: td("scheduled.tpl_learning_digest_desc", "Turn saved links and notes into a weekly digest."),
    prompt:
      "Collect my saved links and notes, then draft a weekly learning digest with key ideas and follow-up actions.",
    scheduleMode: "daily",
    scheduleTime: "10:00",
    scheduleDays: ["su"],
    badge: td("scheduled.badge_weekend_review", "Weekend review"),
  },
  {
    icon: Brain,
    name: td("scheduled.tpl_habit_checkin_name", "Habit check-in"),
    description: td("scheduled.tpl_habit_checkin_desc", "Run a quick accountability check through the day."),
    prompt:
      "Ask me for a quick progress check-in, capture blockers, and suggest one concrete next action.",
    scheduleMode: "interval",
    intervalHours: 6,
    badge: td("scheduled.badge_every_few_hours", "Every few hours"),
  },
];

const dayOptions = [
  { id: "mo", label: () => td("scheduled.day_mon", "Mon"), cron: "1" },
  { id: "tu", label: () => td("scheduled.day_tue", "Tue"), cron: "2" },
  { id: "we", label: () => td("scheduled.day_wed", "Wed"), cron: "3" },
  { id: "th", label: () => td("scheduled.day_thu", "Thu"), cron: "4" },
  { id: "fr", label: () => td("scheduled.day_fri", "Fri"), cron: "5" },
  { id: "sa", label: () => td("scheduled.day_sat", "Sat"), cron: "6" },
  { id: "su", label: () => td("scheduled.day_sun", "Sun"), cron: "0" },
];

export type AutomationsViewProps = {
  busy: boolean;
  selectedWorkspaceRoot: string;
  createSessionAndOpen: (initialPrompt?: string) => Promise<string | undefined> | string | void;
  newTaskDisabled: boolean;
  schedulerInstalled: boolean;
  canEditPlugins: boolean;
  addPlugin: (pluginNameOverride?: string) => void;
  reloadWorkspaceEngine: () => Promise<void>;
  reloadBusy: boolean;
  canReloadWorkspace: boolean;
  showHeader?: boolean;
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
  if (parts.length < 5) return td("scheduled.custom_schedule", "Custom schedule");
  const [minuteRaw, hourRaw, dom, mon, dowRaw] = parts;
  if (!minuteRaw || !hourRaw || !dom || !mon || !dowRaw) return td("scheduled.custom_schedule", "Custom schedule");

  if (
    minuteRaw === "0" &&
    hourRaw.startsWith("*/") &&
    dom === "*" &&
    mon === "*" &&
    dowRaw === "*"
  ) {
    const interval = Number.parseInt(hourRaw.slice(2), 10);
    if (Number.isFinite(interval) && interval > 0) {
      return interval === 1 ? td("scheduled.every_hour", "Every hour") : td("scheduled.every_n_hours", "Every {interval} hours", { interval });
    }
  }

  const hour = Number.parseInt(hourRaw, 10);
  const minute = Number.parseInt(minuteRaw, 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return td("scheduled.custom_schedule", "Custom schedule");
  if (dom !== "*" || mon !== "*") return td("scheduled.custom_schedule", "Custom schedule");

  const timeLabel = `${pad2(hour)}:${pad2(minute)}`;

  if (dowRaw === "*") {
    return td("scheduled.every_day_at", "Every day at {time}", { time: timeLabel });
  }

  const days = parseCronNumbers(dowRaw);
  const normalized = new Set(days.map((d) => (d === 7 ? 0 : d)));
  const allDays = [0, 1, 2, 3, 4, 5, 6];
  const weekdayDays = [1, 2, 3, 4, 5];
  const weekendDays = [0, 6];

  if (allDays.every((d) => normalized.has(d))) return td("scheduled.every_day_at", "Every day at {time}", { time: timeLabel });
  if (
    weekdayDays.every((d) => normalized.has(d)) &&
    !weekendDays.some((d) => normalized.has(d))
  ) {
    return td("scheduled.weekdays_at", "Weekdays at {time}", { time: timeLabel });
  }
  if (
    weekendDays.every((d) => normalized.has(d)) &&
    !weekdayDays.some((d) => normalized.has(d))
  ) {
    return td("scheduled.weekends_at", "Weekends at {time}", { time: timeLabel });
  }

  const labels: Record<number, string> = {
    0: td("scheduled.day_sun", "Sun"),
    1: td("scheduled.day_mon", "Mon"),
    2: td("scheduled.day_tue", "Tue"),
    3: td("scheduled.day_wed", "Wed"),
    4: td("scheduled.day_thu", "Thu"),
    5: td("scheduled.day_fri", "Fri"),
    6: td("scheduled.day_sat", "Sat"),
  };

  const list = Array.from(normalized)
    .filter((d) => d >= 0 && d <= 6)
    .sort((a, b) => a - b)
    .map((d) => labels[d] ?? String(d))
    .join(", ");

  return list ? td("scheduled.days_at", "{days} at {time}", { days: list, time: timeLabel }) : td("scheduled.at_time", "At {time}", { time: timeLabel });
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
  return daySpec ? `${minuteValue} ${hourValue} * * ${daySpec}` : "";
};

const buildCronFromInterval = (hours: number) => {
  if (!Number.isFinite(hours) || hours <= 0) return "";
  const interval = Math.max(1, Math.round(hours));
  return `0 */${interval} * * *`;
};

const taskSummary = (job: ScheduledJob) => {
  const run = job.run;
  if (run?.command) {
    const args = run.arguments ? ` ${run.arguments}` : "";
    return `${run.command}${args}`;
  }
  const prompt = run?.prompt ?? job.prompt;
  return prompt?.trim() || td("scheduled.task_summary_no_prompt", "No prompt or command found.");
};

const toRelative = (value?: string | null) => {
  if (!value) return td("scheduled.never", "Never");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return td("scheduled.never", "Never");
  return formatRelativeTime(parsed);
};

const templateScheduleLabel = (template: AutomationTemplate) => {
  if (template.scheduleMode === "interval") {
    const interval = template.intervalHours ?? DEFAULT_INTERVAL_HOURS;
    return interval === 1 ? td("scheduled.every_hour", "Every hour") : td("scheduled.every_n_hours", "Every {interval} hours", { interval });
  }
  return humanizeCron(
    buildCronFromDaily(
      template.scheduleTime ?? DEFAULT_SCHEDULE_TIME,
      template.scheduleDays ?? DEFAULT_SCHEDULE_DAYS,
    ),
  );
};

const statusLabel = (status?: string | null) => {
  if (!status) return td("scheduled.not_run_yet", "Not run yet");
  if (status === "running") return td("scheduled.running_status", "Running");
  if (status === "success") return td("scheduled.success_status", "Success");
  if (status === "failed") return td("scheduled.failed_status", "Failed");
  return status;
};

const statusTagClass = (status?: string | null) => {
  if (status === "success") {
    return "inline-flex items-center rounded-md border border-emerald-7/30 bg-emerald-3/40 px-2 py-1 text-[11px] text-emerald-11";
  }
  if (status === "failed") {
    return "inline-flex items-center rounded-md border border-red-7/30 bg-red-3/40 px-2 py-1 text-[11px] text-red-11";
  }
  if (status === "running") {
    return "inline-flex items-center rounded-md border border-amber-7/30 bg-amber-3/40 px-2 py-1 text-[11px] text-amber-11";
  }
  return tagClass;
};

const TemplateCard = (props: {
  template: AutomationTemplate;
  disabled: boolean;
  onUse: () => void;
}) => {
  const Icon = props.template.icon;
  return (
    <div class={`${panelCardClass} flex flex-col gap-4 text-left`}>
      <div class="flex gap-4 min-w-0">
        <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-hover">
          <Icon size={20} class="text-dls-secondary" />
        </div>
        <div class="min-w-0 flex-1">
          <h4 class="text-[14px] font-semibold text-dls-text truncate">{props.template.name}</h4>
          <p class="mt-2 line-clamp-2 text-[13px] leading-relaxed text-dls-secondary">
            {props.template.description}
          </p>
          <div class="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-dls-secondary">
            <span class={tagClass}>{props.template.badge}</span>
            <span class={tagClass}>{templateScheduleLabel(props.template)}</span>
          </div>
        </div>
      </div>

      <div class="flex items-center justify-between gap-3 border-t border-dls-border pt-4">
        <span class={tagClass}>{td("scheduled.template_badge", "Template")}</span>
        <button type="button" class={pillPrimaryClass} onClick={props.onUse} disabled={props.disabled}>
          <Sparkles size={14} />
          {td("scheduled.explore_more", "Explore more")}
        </button>
      </div>
    </div>
  );
};

const JobCard = (props: {
  job: ScheduledJob;
  busy: boolean;
  sourceLabel: string;
  onRun: () => void;
  onDelete: () => void;
}) => {
  const summary = createMemo(() => taskSummary(props.job));
  const scheduleLabel = createMemo(() => humanizeCron(props.job.schedule));
  const status = createMemo(() => props.job.lastRunStatus ?? null);

  return (
    <div class={`${panelCardClass} flex flex-col gap-4 text-left`}>
      <div class="flex gap-4 min-w-0">
        <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-hover">
          <Calendar size={20} class="text-dls-secondary" />
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <h4 class="text-[14px] font-semibold text-dls-text truncate">{props.job.name}</h4>
            <span class={statusTagClass(status())}>{statusLabel(status())}</span>
          </div>
          <p class="mt-2 line-clamp-2 text-[13px] leading-relaxed text-dls-secondary">
            {summary()}
          </p>
          <div class="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-dls-secondary">
            <span class={tagClass}>{scheduleLabel()}</span>
            <span class={tagClass}>{props.sourceLabel}</span>
            <Show when={props.job.source}>
              <span class={tagClass}>{props.job.source}</span>
            </Show>
          </div>
          <div class="mt-3 flex flex-wrap items-center gap-4 text-[12px] text-dls-secondary">
            <div>{td("scheduled.last_run_prefix", "Last run")} {toRelative(props.job.lastRunAt)}</div>
            <div>{td("scheduled.created_prefix", "Created")} {toRelative(props.job.createdAt)}</div>
          </div>
        </div>
      </div>

      <div class="flex flex-wrap items-center justify-between gap-3 border-t border-dls-border pt-4">
        <span class={tagClass}>{td("scheduled.filter_scheduled", "Scheduled")}</span>
        <div class="flex flex-wrap gap-2">
          <button type="button" class={pillSecondaryClass} onClick={props.onRun} disabled={props.busy}>
            <Play size={14} />
            {td("scheduled.run_label", "Run")}
          </button>
          <button type="button" class={pillGhostClass} onClick={props.onDelete} disabled={props.busy}>
            <Trash2 size={14} />
            {td("scheduled.delete_label", "Delete")}
          </button>
        </div>
      </div>
    </div>
  );
};

export default function AutomationsView(props: AutomationsViewProps) {
  const automations = useAutomations();
  const platform = usePlatform();
  const statusToasts = useStatusToasts();

  const [searchQuery, setSearchQuery] = createSignal("");
  const [activeFilter, setActiveFilter] = createSignal<AutomationsFilter>("all");
  const [installingScheduler, setInstallingScheduler] = createSignal(false);
  const [schedulerInstallRequested, setSchedulerInstallRequested] = createSignal(false);
  const [deleteTarget, setDeleteTarget] = createSignal<ScheduledJob | null>(null);
  const [deleteBusy, setDeleteBusy] = createSignal(false);
  const [deleteError, setDeleteError] = createSignal<string | null>(null);
  const [createModalOpen, setCreateModalOpen] = createSignal(false);
  const [createBusy, setCreateBusy] = createSignal(false);
  const [createError, setCreateError] = createSignal<string | null>(null);
  const [automationName, setAutomationName] = createSignal(DEFAULT_AUTOMATION_NAME());
  const [automationPrompt, setAutomationPrompt] = createSignal(DEFAULT_AUTOMATION_PROMPT);
  const [scheduleMode, setScheduleMode] = createSignal<ScheduleMode>("daily");
  const [scheduleTime, setScheduleTime] = createSignal(DEFAULT_SCHEDULE_TIME);
  const [scheduleDays, setScheduleDays] = createSignal([...DEFAULT_SCHEDULE_DAYS]);
  const [intervalHours, setIntervalHours] = createSignal(DEFAULT_INTERVAL_HOURS);
  const [lastUpdatedNow, setLastUpdatedNow] = createSignal(Date.now());

  createEffect(() => {
    if (typeof window === "undefined") return;
    const interval = window.setInterval(() => setLastUpdatedNow(Date.now()), 1_000);
    onCleanup(() => window.clearInterval(interval));
  });

  const showToast = (title: string, tone: AppStatusToastTone = "info") => {
    statusToasts.showToast({ title, tone });
  };

  const resetDraft = (template?: AutomationTemplate) => {
    setAutomationName(template?.name ?? DEFAULT_AUTOMATION_NAME());
    setAutomationPrompt(template?.prompt ?? DEFAULT_AUTOMATION_PROMPT);
    setScheduleMode(template?.scheduleMode ?? "daily");
    setScheduleTime(template?.scheduleTime ?? DEFAULT_SCHEDULE_TIME);
    setScheduleDays([...(template?.scheduleDays ?? DEFAULT_SCHEDULE_DAYS)]);
    setIntervalHours(template?.intervalHours ?? DEFAULT_INTERVAL_HOURS);
    setCreateError(null);
  };

  const supported = createMemo(() => {
    if (automations.jobsSource() === "remote") return true;
    return isTauriRuntime() && props.schedulerInstalled && !schedulerInstallRequested();
  });

  const schedulerGateActive = createMemo(() => {
    if (automations.jobsSource() !== "local") return false;
    if (!isTauriRuntime()) return false;
    return !props.schedulerInstalled || schedulerInstallRequested();
  });

  const automationDisabled = createMemo(
    () => props.newTaskDisabled || schedulerGateActive() || createBusy(),
  );

  const sourceLabel = createMemo(() =>
    automations.jobsSource() === "remote" ? td("scheduled.source_remote", "From OpenWork server") : td("scheduled.source_local", "From local scheduler"),
  );

  const sourceDescription = createMemo(() =>
    automations.jobsSource() === "remote"
      ? td("scheduled.subtitle_remote", "Automations that run on a schedule from the connected OpenWork server.")
      : td("scheduled.subtitle_local", "Automations that run on a schedule from this device."),
  );

  const supportNote = createMemo(() => {
    if (automations.jobsSource() === "remote") return null;
    if (!isTauriRuntime()) return td("scheduled.desktop_required", "Scheduled tasks require the desktop app.");
    if (!props.schedulerInstalled || schedulerInstallRequested()) return null;
    return null;
  });

  const lastUpdatedLabel = createMemo(() => {
    lastUpdatedNow();
    if (!automations.jobsUpdatedAt()) return td("scheduled.not_synced_yet", "Not synced yet");
    return formatRelativeTime(automations.jobsUpdatedAt() as number);
  });

  const filteredJobs = createMemo(() => {
    const query = searchQuery().trim().toLowerCase();
    const items = automations.jobs();
    if (!query) return items;
    return items.filter((job) => {
      const summary = taskSummary(job).toLowerCase();
      const schedule = humanizeCron(job.schedule).toLowerCase();
      return (
        job.name.toLowerCase().includes(query) ||
        summary.includes(query) ||
        schedule.includes(query)
      );
    });
  });

  const filteredTemplates = createMemo(() => {
    const query = searchQuery().trim().toLowerCase();
    if (!query) return automationTemplates;
    return automationTemplates.filter((template) => {
      return (
        template.name.toLowerCase().includes(query) ||
        template.description.toLowerCase().includes(query) ||
        template.badge.toLowerCase().includes(query)
      );
    });
  });

  const showJobsSection = createMemo(() => activeFilter() !== "templates");
  const showTemplatesSection = createMemo(() => activeFilter() !== "scheduled");

  const cronExpression = createMemo(() => {
    if (scheduleMode() === "interval") {
      return buildCronFromInterval(intervalHours());
    }
    return buildCronFromDaily(scheduleTime(), scheduleDays());
  });

  const cronPreviewLabel = createMemo(() => {
    const cron = cronExpression();
    return cron ? humanizeCron(cron) : null;
  });

  const openSchedulerDocs = () => {
    platform.openLink("https://github.com/different-ai/opencode-scheduler");
  };

  const refreshJobs = () => {
    if (props.busy) return;
    void automations.refresh({ force: true });
  };

  const handleInstallScheduler = async () => {
    if (installingScheduler() || !props.canEditPlugins) return;
    setInstallingScheduler(true);
    setSchedulerInstallRequested(true);
    try {
      await Promise.resolve(props.addPlugin("opencode-scheduler"));
      showToast(td("scheduled.scheduler_install_requested", "Scheduler install requested."), "success");
    } finally {
      setInstallingScheduler(false);
    }
  };

  const openCreateModal = () => {
    if (automationDisabled()) return;
    resetDraft();
    setCreateModalOpen(true);
  };

  const openCreateModalFromTemplate = (template: AutomationTemplate) => {
    if (automationDisabled()) return;
    resetDraft(template);
    setCreateModalOpen(true);
  };

  const closeCreateModal = () => {
    setCreateModalOpen(false);
    setCreateError(null);
    setCreateBusy(false);
  };

  const handleCreateAutomation = async () => {
    if (automationDisabled()) return;
    const plan = automations.prepareCreateAutomation({
      name: automationName(),
      prompt: automationPrompt(),
      schedule: cronExpression(),
      workdir: props.selectedWorkspaceRoot,
    });
    if (!plan.ok) {
      setCreateError(plan.error);
      return;
    }

    setCreateBusy(true);
    setCreateError(null);
    try {
      await Promise.resolve(props.createSessionAndOpen(plan.prompt));
      setCreateModalOpen(false);
      showToast(td("scheduled.prepared_automation_in_chat", "Prepared automation in chat."), "success");
    } catch (error) {
      setCreateError(
        error instanceof Error ? error.message : td("scheduled.prepare_error_fallback", "Failed to prepare automation in chat."),
      );
    } finally {
      setCreateBusy(false);
    }
  };

  const handleRunAutomation = async (job: ScheduledJob) => {
    if (!supported() || props.busy) return;
    const plan = automations.prepareRunAutomation(job, props.selectedWorkspaceRoot);
    if (!plan.ok) {
      showToast(plan.error, "warning");
      return;
    }
    await Promise.resolve(props.createSessionAndOpen(plan.prompt));
    showToast(td("scheduled.prepared_job_in_chat", "Prepared {name} in chat.", { name: job.name }), "success");
  };

  const confirmDelete = async () => {
    const target = deleteTarget();
    if (!target) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await automations.remove(target.slug);
      setDeleteTarget(null);
      showToast(td("scheduled.removed_job", "Removed {name}.", { name: target.name }), "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDeleteError(message || td("scheduled.delete_error_fallback", "Failed to delete job."));
    } finally {
      setDeleteBusy(false);
    }
  };

  const toggleDay = (id: string) => {
    setScheduleDays((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return Array.from(next);
    });
  };

  const updateIntervalHours = (value: string) => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return;
    const bounded = Math.min(24, Math.max(1, parsed));
    setIntervalHours(bounded);
  };

  const jobsEmptyMessage = createMemo(() => {
    const query = searchQuery().trim();
    if (query) return td("scheduled.no_automations_match", "No automations match this search.", { query });
    if (schedulerGateActive()) return td("scheduled.install_scheduler_hint", "Automations run through the opencode-scheduler plugin. Add it to this workspace to enable scheduling.");
    return td("scheduled.empty_hint", "No automations yet. Pick a template or create your own automation prompt.");
  });

  return (
    <section class="space-y-8">
      <div class="space-y-6">
        <div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div class="min-w-0">
            <Show when={props.showHeader !== false}>
              <h2 class={pageTitleClass}>{td("scheduled.title", "Automations")}</h2>
            </Show>
            <p class="mt-2 max-w-2xl text-[14px] leading-relaxed text-dls-secondary">
              {td("scheduled.page_description", "Schedule recurring tasks for this worker, monitor what is already registered, and start from a reusable template.")}
            </p>
          </div>

          <div class="flex flex-wrap gap-3 lg:justify-end">
            <button type="button" onClick={openSchedulerDocs} class={pillSecondaryClass}>
              <PlugZap size={14} />
              {td("scheduled.view_scheduler_docs", "View scheduler docs")}
            </button>
            <button type="button" onClick={refreshJobs} disabled={props.busy} class={pillSecondaryClass}>
              <RefreshCw size={14} />
              {props.busy ? td("scheduled.refreshing", "Refreshing") : td("common.refresh", "Refresh")}
            </button>
            <button
              type="button"
              onClick={openCreateModal}
              disabled={automationDisabled()}
              class={pillPrimaryClass}
            >
              <Plus size={14} />
              {td("scheduled.new_automation", "New automation")}
            </button>
          </div>
        </div>

        <div class="flex flex-col gap-3 rounded-[20px] border border-dls-border bg-dls-surface p-4 md:flex-row md:items-center md:justify-between">
          <div class="relative min-w-0 flex-1">
            <Search size={16} class="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-dls-secondary" />
            <input
              type="text"
              value={searchQuery()}
              onInput={(event) => setSearchQuery(event.currentTarget.value)}
              placeholder={td("scheduled.search_placeholder", "Search automations or templates")}
              class="w-full rounded-xl border border-dls-border bg-dls-surface py-3 pl-11 pr-4 text-[14px] text-dls-text focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.12)]"
            />
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <For each={["all", "scheduled", "templates"] as AutomationsFilter[]}>
              {(filter) => (
                <button
                  type="button"
                  onClick={() => setActiveFilter(filter)}
                  class={activeFilter() === filter ? pillPrimaryClass : pillGhostClass}
                >
                  {filter === "all"
                    ? td("scheduled.filter_all", "All")
                    : filter === "scheduled"
                      ? td("scheduled.filter_scheduled", "Scheduled")
                      : td("scheduled.filter_templates", "Templates")}
                </button>
              )}
            </For>
          </div>
        </div>
      </div>

      <Show when={schedulerGateActive()}>
        <div class="rounded-[20px] border border-dls-border bg-dls-hover px-5 py-5">
          <div class="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div class="flex gap-3">
              <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-surface">
                <PlugZap size={18} class="text-dls-secondary" />
              </div>
              <div>
                <div class="text-[15px] font-medium tracking-[-0.2px] text-dls-text">
                  {props.schedulerInstalled
                    ? td("scheduled.reload_activate_title", "Reload OpenWork to activate automations")
                    : td("scheduled.install_scheduler_title", "Install the scheduler to unlock automations")}
                </div>
                <p class="mt-1 text-[13px] leading-relaxed text-dls-secondary">
                  {props.schedulerInstalled
                    ? td("scheduled.reload_activate_hint", "OpenCode loads plugins at startup. Reload OpenWork to activate opencode-scheduler.")
                    : td("scheduled.install_scheduler_hint", "Automations run through the opencode-scheduler plugin. Add it to this workspace to enable scheduling.")}
                </p>
              </div>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleInstallScheduler}
                disabled={!props.canEditPlugins || installingScheduler()}
                class={pillSecondaryClass}
              >
                <Plus size={14} />
                {installingScheduler() ? td("scheduled.installing", "Installing...") : td("scheduled.install_scheduler", "Install scheduler")}
              </button>
              <button
                type="button"
                onClick={() => void props.reloadWorkspaceEngine()}
                disabled={!props.canReloadWorkspace || props.reloadBusy || !props.schedulerInstalled}
                class={pillSecondaryClass}
              >
                <RefreshCw size={14} />
                {props.reloadBusy ? td("scheduled.reloading", "Reloading...") : td("scheduled.reload_openwork", "Reload OpenWork")}
              </button>
            </div>
          </div>
        </div>
      </Show>

      <Show when={supportNote()}>
        <div class="rounded-[20px] border border-dls-border bg-dls-hover px-5 py-4 text-[13px] text-dls-secondary">
          {supportNote()}
        </div>
      </Show>

      <Show when={automations.jobsStatus()}>
        <div class="rounded-[20px] border border-red-7/20 bg-red-1/40 px-5 py-4 text-[13px] text-red-11">
          {automations.jobsStatus()}
        </div>
      </Show>

      <Show when={deleteError()}>
        <div class="rounded-[20px] border border-red-7/20 bg-red-1/40 px-5 py-4 text-[13px] text-red-11">
          {deleteError()}
        </div>
      </Show>

      <Show when={showJobsSection()}>
        <div class="space-y-4">
          <div class="flex items-end justify-between gap-3">
            <div>
              <h3 class={sectionTitleClass}>{td("scheduled.your_automations", "Your automations")}</h3>
              <p class="mt-1 text-[13px] text-dls-secondary">{sourceDescription()}</p>
            </div>
            <div class="text-[12px] text-dls-secondary">
              {sourceLabel()} · {td("scheduled.last_updated_prefix", "Last updated")} {lastUpdatedLabel()}
            </div>
          </div>

          <Show
            when={filteredJobs().length}
            fallback={
              <div class="rounded-[20px] border border-dashed border-dls-border bg-dls-surface px-5 py-8 text-[14px] text-dls-secondary">
                {jobsEmptyMessage()}
              </div>
            }
          >
            <div class="rounded-[24px] bg-dls-hover p-4">
              <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
                <For each={filteredJobs()}>
                  {(job) => (
                    <JobCard
                      job={job}
                      sourceLabel={sourceLabel()}
                      busy={props.busy || deleteBusy() || !supported()}
                      onRun={() => void handleRunAutomation(job)}
                      onDelete={() => setDeleteTarget(job)}
                    />
                  )}
                </For>
              </div>
            </div>
          </Show>
        </div>
      </Show>

      <Show when={showTemplatesSection()}>
        <div class="space-y-4">
          <div class="flex items-end justify-between gap-3">
            <div>
              <h3 class={sectionTitleClass}>{td("scheduled.quick_start_templates", "Quick start templates")}</h3>
              <p class="mt-1 text-[13px] text-dls-secondary">
                {td("scheduled.quick_start_templates_desc", "Start from a proven recurring workflow, then tailor the prompt before you prepare it in chat.")}
              </p>
            </div>
            <div class="text-[12px] text-dls-secondary">{td("scheduled.template_count", "{count} templates", { count: filteredTemplates().length })}</div>
          </div>

          <Show
            when={filteredTemplates().length}
            fallback={
              <div class="rounded-[20px] border border-dashed border-dls-border bg-dls-surface px-5 py-8 text-[14px] text-dls-secondary">
                {td("scheduled.no_templates_match", "No templates match this search.")}
              </div>
            }
          >
            <div class="rounded-[24px] bg-dls-hover p-4">
              <div class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                <For each={filteredTemplates()}>
                  {(template) => (
                    <TemplateCard
                      template={template}
                      disabled={automationDisabled()}
                      onUse={() => openCreateModalFromTemplate(template)}
                    />
                  )}
                </For>
              </div>
            </div>
          </Show>
        </div>
      </Show>

      <Show when={deleteTarget()}>
        <div class="fixed inset-0 z-50 bg-black/20 backdrop-blur-sm flex items-center justify-center p-4">
          <div class="bg-dls-surface border border-dls-border w-full max-w-md rounded-2xl shadow-2xl overflow-hidden">
            <div class="p-6 space-y-4">
              <div>
                <h3 class="text-lg font-semibold text-dls-text">{td("scheduled.delete_confirm_title", "Delete automation?")}</h3>
                <p class="mt-1 text-sm text-dls-secondary">
                  {td("scheduled.delete_confirm_desc", "This removes the schedule and deletes the job definition from {source}.", { source: sourceLabel().toLowerCase() })}
                </p>
              </div>

              <div class="rounded-xl bg-dls-hover border border-dls-border p-3 text-xs text-dls-secondary">
                {deleteTarget()?.name}
              </div>

              <div class="flex justify-end gap-2">
                <button type="button" class={pillGhostClass} onClick={() => setDeleteTarget(null)} disabled={deleteBusy()}>
                  {td("common.cancel", "Cancel")}
                </button>
                <button type="button" class={pillPrimaryClass} onClick={() => void confirmDelete()} disabled={deleteBusy()}>
                  {deleteBusy() ? td("scheduled.deleting", "Deleting") : td("scheduled.delete_label", "Delete")}
                </button>
              </div>
            </div>
          </div>
        </div>
      </Show>

      <Show when={createModalOpen()}>
        <div class="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
          <div class="w-full max-w-2xl rounded-2xl border border-dls-border bg-dls-surface shadow-2xl overflow-hidden">
            <div class="px-5 py-4 border-b border-dls-border flex items-center justify-between gap-3">
              <div>
                <div class="text-sm font-semibold text-dls-text">{td("scheduled.create_title", "Create automation")}</div>
                <p class="mt-1 text-xs text-dls-secondary">
                  {td("scheduled.create_desc", "Automations are scheduled by running a prompt in a new thread. We'll prefill a prompt for you to send.")}
                </p>
              </div>
              <button
                type="button"
                onClick={closeCreateModal}
                class="rounded-full p-1 text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
              >
                <X size={18} />
              </button>
            </div>

            <div class="p-5 space-y-5">
              <div class="space-y-1.5">
                <label class="text-[13px] font-medium text-dls-text">{td("scheduled.name_label", "Name")}</label>
                <input
                  type="text"
                  value={automationName()}
                  onInput={(event) => setAutomationName(event.currentTarget.value)}
                  class="w-full rounded-xl border border-dls-border bg-dls-surface px-4 py-3 text-[14px] text-dls-text focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.12)]"
                />
              </div>

              <div class="space-y-1.5">
                <label class="text-[13px] font-medium text-dls-text">{td("scheduled.task_summary_prompt", "Prompt")}</label>
                <textarea
                  rows={4}
                  value={automationPrompt()}
                  onInput={(event) => setAutomationPrompt(event.currentTarget.value)}
                  class="w-full resize-none rounded-xl border border-dls-border bg-dls-surface px-4 py-3 text-[14px] text-dls-text focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.12)]"
                />
              </div>

              <div class="space-y-3">
                <div class="flex items-center justify-between gap-3">
                  <label class="text-[13px] font-medium text-dls-text">{td("scheduled.schedule_label", "Schedule")}</label>
                  <div class="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setScheduleMode("daily")}
                      class={scheduleMode() === "daily" ? pillPrimaryClass : pillGhostClass}
                    >
                      {td("scheduled.daily_mode", "Daily")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setScheduleMode("interval")}
                      class={scheduleMode() === "interval" ? pillPrimaryClass : pillGhostClass}
                    >
                      {td("scheduled.interval_mode", "Interval")}
                    </button>
                  </div>
                </div>

                <Show
                  when={scheduleMode() === "daily"}
                  fallback={
                    <div class="flex flex-wrap items-center gap-3 rounded-[20px] border border-dls-border bg-dls-hover p-4">
                      <div class="text-[13px] text-dls-secondary">{td("scheduled.every_prefix", "Every")}</div>
                      <input
                        type="number"
                        min={1}
                        max={24}
                        value={intervalHours()}
                        onInput={(event) => updateIntervalHours(event.currentTarget.value)}
                        class="w-20 rounded-xl border border-dls-border bg-dls-surface px-3 py-2 text-[14px] text-dls-text focus:outline-none"
                      />
                      <div class="text-[13px] text-dls-secondary">{td("scheduled.hours_suffix", "hours")}</div>
                    </div>
                  }
                >
                  <div class="space-y-3 rounded-[20px] border border-dls-border bg-dls-hover p-4">
                    <div class="flex flex-wrap items-center gap-3">
                      <div class="flex items-center gap-2 rounded-xl border border-dls-border bg-dls-surface px-3 py-2 text-[14px] text-dls-text">
                        <Clock size={16} class="text-dls-secondary" />
                        <input
                          type="time"
                          value={scheduleTime()}
                          onInput={(event) => setScheduleTime(event.currentTarget.value)}
                          class="bg-transparent focus:outline-none"
                        />
                      </div>
                    </div>

                    <div class="flex flex-wrap gap-2">
                      <For each={dayOptions}>
                        {(day) => (
                          <button
                            type="button"
                            onClick={() => toggleDay(day.id)}
                            class={scheduleDays().includes(day.id) ? pillPrimaryClass : pillGhostClass}
                          >
                            {day.label()}
                          </button>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>

                <Show when={cronExpression()}>
                  <div class="rounded-[20px] border border-dls-border bg-dls-hover px-4 py-3 text-[13px] text-dls-secondary">
                    <div>{cronPreviewLabel()}</div>
                    <div class="mt-1 font-mono text-[12px] text-dls-text">{cronExpression()}</div>
                  </div>
                </Show>
              </div>

              <Show when={createError()}>
                <div class="rounded-xl border border-red-7/20 bg-red-1/40 px-4 py-3 text-xs text-red-12">
                  {createError()}
                </div>
              </Show>
            </div>

            <div class="px-5 py-4 border-t border-dls-border flex items-center justify-between gap-3">
              <div class="text-[12px] text-dls-secondary">{td("scheduled.worker_root_hint", "Worker root is inferred from the selected workspace.")}</div>
              <div class="flex items-center gap-2">
                <button type="button" class={pillGhostClass} onClick={closeCreateModal} disabled={createBusy()}>
                  {td("common.cancel", "Cancel")}
                </button>
                <button
                  type="button"
                  class={pillPrimaryClass}
                  onClick={() => void handleCreateAutomation()}
                  disabled={createBusy() || automationDisabled()}
                >
                  {createBusy() ? td("scheduled.create_button", "Create") : td("scheduled.create_button", "Create")}
                </button>
              </div>
            </div>
          </div>
        </div>
      </Show>
    </section>
  );
}
