/** @jsxImportSource react */
import { useEffect, useMemo, useState } from "react";
import type { ComponentType, SVGProps } from "react";
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
} from "lucide-react";

import { t } from "../../../../i18n";
import type { ScheduledJob } from "../../../../app/types";
import { formatRelativeTime, isTauriRuntime } from "../../../../app/utils";

type AutomationsFilter = "all" | "scheduled" | "templates";
type ScheduleMode = "daily" | "interval";
type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

type AutomationTemplate = {
  icon: IconComponent;
  name: string;
  description: string;
  prompt: string;
  scheduleMode: ScheduleMode;
  scheduleTime?: string;
  scheduleDays?: string[];
  intervalHours?: number;
  badge: string;
};

export type AutomationActionPlan =
  | { ok: true; mode: "session_prompt"; prompt: string }
  | { ok: false; error: string };

export type AutomationsStoreLike = {
  jobs: () => ScheduledJob[];
  jobsStatus: () => string | null;
  jobsUpdatedAt: () => number | null;
  jobsSource: () => "local" | "remote";
  refresh: (options?: { force?: boolean }) => Promise<"success" | "error" | "unavailable" | "skipped"> | "success" | "error" | "unavailable" | "skipped";
  remove: (name: string) => Promise<void> | void;
  prepareCreateAutomation: (input: {
    name: string;
    prompt: string;
    schedule: string;
    workdir?: string | null;
  }) => AutomationActionPlan;
  prepareRunAutomation: (job: ScheduledJob, fallbackWorkdir?: string | null) => AutomationActionPlan;
};

export type AutomationsViewProps = {
  automations: AutomationsStoreLike;
  busy: boolean;
  selectedWorkspaceRoot: string;
  createSessionAndOpen: (initialPrompt?: string) => Promise<string | undefined> | string | void;
  newTaskDisabled: boolean;
  schedulerInstalled: boolean;
  canEditPlugins: boolean;
  addPlugin: (pluginNameOverride?: string) => Promise<void> | void;
  reloadWorkspaceEngine: () => Promise<void>;
  reloadBusy: boolean;
  canReloadWorkspace: boolean;
  openLink: (url: string) => void;
  showToast?: (input: {
    title: string;
    tone?: "success" | "info" | "warning" | "error";
    description?: string | null;
  }) => void;
  showHeader?: boolean;
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

const DEFAULT_AUTOMATION_NAME = () => t("scheduled.default_automation_name");
const DEFAULT_AUTOMATION_PROMPT =
  "Scan recent commits and flag riskier diffs with the most important follow-ups.";
const DEFAULT_SCHEDULE_TIME = "09:00";
const DEFAULT_SCHEDULE_DAYS = ["mo", "tu", "we", "th", "fr"];
const DEFAULT_INTERVAL_HOURS = 6;

const automationTemplates: AutomationTemplate[] = [
  {
    icon: Calendar,
    name: t("scheduled.tpl_daily_planning_name"),
    description: t("scheduled.tpl_daily_planning_desc"),
    prompt:
      "Review my pending tasks and calendar, then draft a practical plan for today with top priorities and one follow-up reminder.",
    scheduleMode: "daily",
    scheduleTime: "08:30",
    scheduleDays: ["mo", "tu", "we", "th", "fr"],
    badge: t("scheduled.badge_weekday_morning"),
  },
  {
    icon: BookOpen,
    name: t("scheduled.tpl_inbox_zero_name"),
    description: t("scheduled.tpl_inbox_zero_desc"),
    prompt:
      "Summarize unread inbox messages, suggest priority order, and draft concise reply options for the top conversations.",
    scheduleMode: "daily",
    scheduleTime: "17:30",
    scheduleDays: ["mo", "tu", "we", "th", "fr"],
    badge: t("scheduled.badge_end_of_day"),
  },
  {
    icon: MessageSquare,
    name: t("scheduled.tpl_meeting_prep_name"),
    description: t("scheduled.tpl_meeting_prep_desc"),
    prompt:
      "Prepare meeting briefs for tomorrow with context, talking points, and questions to unblock decisions.",
    scheduleMode: "daily",
    scheduleTime: "18:00",
    scheduleDays: ["mo", "tu", "we", "th", "fr"],
    badge: t("scheduled.badge_weekday_evening"),
  },
  {
    icon: TrendingUp,
    name: t("scheduled.tpl_weekly_wins_name"),
    description: t("scheduled.tpl_weekly_wins_desc"),
    prompt:
      "Summarize the week into wins, blockers, and clear next steps I can share with the team.",
    scheduleMode: "daily",
    scheduleTime: "16:00",
    scheduleDays: ["fr"],
    badge: t("scheduled.badge_friday_wrapup"),
  },
  {
    icon: Trophy,
    name: t("scheduled.tpl_learning_digest_name"),
    description: t("scheduled.tpl_learning_digest_desc"),
    prompt:
      "Collect my saved links and notes, then draft a weekly learning digest with key ideas and follow-up actions.",
    scheduleMode: "daily",
    scheduleTime: "10:00",
    scheduleDays: ["su"],
    badge: t("scheduled.badge_weekend_review"),
  },
  {
    icon: Brain,
    name: t("scheduled.tpl_habit_checkin_name"),
    description: t("scheduled.tpl_habit_checkin_desc"),
    prompt:
      "Ask me for a quick progress check-in, capture blockers, and suggest one concrete next action.",
    scheduleMode: "interval",
    intervalHours: 6,
    badge: t("scheduled.badge_every_few_hours"),
  },
];

const dayOptions = [
  { id: "mo", label: () => t("scheduled.day_mon"), cron: "1" },
  { id: "tu", label: () => t("scheduled.day_tue"), cron: "2" },
  { id: "we", label: () => t("scheduled.day_wed"), cron: "3" },
  { id: "th", label: () => t("scheduled.day_thu"), cron: "4" },
  { id: "fr", label: () => t("scheduled.day_fri"), cron: "5" },
  { id: "sa", label: () => t("scheduled.day_sat"), cron: "6" },
  { id: "su", label: () => t("scheduled.day_sun"), cron: "0" },
];

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
  if (parts.length < 5) return t("scheduled.custom_schedule");
  const [minuteRaw, hourRaw, dom, mon, dowRaw] = parts;
  if (!minuteRaw || !hourRaw || !dom || !mon || !dowRaw) return t("scheduled.custom_schedule");

  if (
    minuteRaw === "0" &&
    hourRaw.startsWith("*/") &&
    dom === "*" &&
    mon === "*" &&
    dowRaw === "*"
  ) {
    const interval = Number.parseInt(hourRaw.slice(2), 10);
    if (Number.isFinite(interval) && interval > 0) {
      return interval === 1 ? t("scheduled.every_hour") : t("scheduled.every_n_hours", undefined, { interval });
    }
  }

  const hour = Number.parseInt(hourRaw, 10);
  const minute = Number.parseInt(minuteRaw, 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return t("scheduled.custom_schedule");
  if (dom !== "*" || mon !== "*") return t("scheduled.custom_schedule");

  const timeLabel = `${pad2(hour)}:${pad2(minute)}`;

  if (dowRaw === "*") {
    return t("scheduled.every_day_at", undefined, { time: timeLabel });
  }

  const days = parseCronNumbers(dowRaw);
  const normalized = new Set(days.map((d) => (d === 7 ? 0 : d)));
  const allDays = [0, 1, 2, 3, 4, 5, 6];
  const weekdayDays = [1, 2, 3, 4, 5];
  const weekendDays = [0, 6];

  if (allDays.every((d) => normalized.has(d))) return t("scheduled.every_day_at", undefined, { time: timeLabel });
  if (
    weekdayDays.every((d) => normalized.has(d)) &&
    !weekendDays.some((d) => normalized.has(d))
  ) {
    return t("scheduled.weekdays_at", undefined, { time: timeLabel });
  }
  if (
    weekendDays.every((d) => normalized.has(d)) &&
    !weekdayDays.some((d) => normalized.has(d))
  ) {
    return t("scheduled.weekends_at", undefined, { time: timeLabel });
  }

  const labels: Record<number, string> = {
    0: t("scheduled.day_sun"),
    1: t("scheduled.day_mon"),
    2: t("scheduled.day_tue"),
    3: t("scheduled.day_wed"),
    4: t("scheduled.day_thu"),
    5: t("scheduled.day_fri"),
    6: t("scheduled.day_sat"),
  };

  const list = Array.from(normalized)
    .filter((d) => d >= 0 && d <= 6)
    .sort((a, b) => a - b)
    .map((d) => labels[d] ?? String(d))
    .join(", ");

  return list ? t("scheduled.days_at", undefined, { days: list, time: timeLabel }) : t("scheduled.at_time", undefined, { time: timeLabel });
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
  return prompt?.trim() || t("scheduled.task_summary_no_prompt");
};

const toRelative = (value?: string | null) => {
  if (!value) return t("scheduled.never");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return t("scheduled.never");
  return formatRelativeTime(parsed);
};

const templateScheduleLabel = (template: AutomationTemplate) => {
  if (template.scheduleMode === "interval") {
    const interval = template.intervalHours ?? DEFAULT_INTERVAL_HOURS;
    return interval === 1 ? t("scheduled.every_hour") : t("scheduled.every_n_hours", undefined, { interval });
  }
  return humanizeCron(
    buildCronFromDaily(
      template.scheduleTime ?? DEFAULT_SCHEDULE_TIME,
      template.scheduleDays ?? DEFAULT_SCHEDULE_DAYS,
    ),
  );
};

const statusLabel = (status?: string | null) => {
  if (!status) return t("scheduled.not_run_yet");
  if (status === "running") return t("scheduled.running_status");
  if (status === "success") return t("scheduled.success_status");
  if (status === "failed") return t("scheduled.failed_status");
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

type TemplateCardProps = {
  template: AutomationTemplate;
  disabled: boolean;
  onUse: () => void;
};

function TemplateCard(props: TemplateCardProps) {
  const Icon = props.template.icon;
  return (
    <div className={`${panelCardClass} flex flex-col gap-4 text-left`}>
      <div className="flex min-w-0 gap-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-hover">
          <Icon className="text-dls-secondary" width={20} height={20} />
        </div>
        <div className="min-w-0 flex-1">
          <h4 className="truncate text-[14px] font-semibold text-dls-text">{props.template.name}</h4>
          <p className="mt-2 line-clamp-2 text-[13px] leading-relaxed text-dls-secondary">
            {props.template.description}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-dls-secondary">
            <span className={tagClass}>{props.template.badge}</span>
            <span className={tagClass}>{templateScheduleLabel(props.template)}</span>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-dls-border pt-4">
        <span className={tagClass}>{t("scheduled.template_badge")}</span>
        <button type="button" className={pillPrimaryClass} onClick={props.onUse} disabled={props.disabled}>
          <Sparkles size={14} />
          {t("scheduled.explore_more")}
        </button>
      </div>
    </div>
  );
}

type JobCardProps = {
  job: ScheduledJob;
  busy: boolean;
  sourceLabel: string;
  onRun: () => void;
  onDelete: () => void;
};

function JobCard(props: JobCardProps) {
  const summary = taskSummary(props.job);
  const scheduleLabel = humanizeCron(props.job.schedule);
  const status = props.job.lastRunStatus ?? null;

  return (
    <div className={`${panelCardClass} flex flex-col gap-4 text-left`}>
      <div className="flex min-w-0 gap-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-hover">
          <Calendar size={20} className="text-dls-secondary" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="truncate text-[14px] font-semibold text-dls-text">{props.job.name}</h4>
            <span className={statusTagClass(status)}>{statusLabel(status)}</span>
          </div>
          <p className="mt-2 line-clamp-2 text-[13px] leading-relaxed text-dls-secondary">{summary}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-dls-secondary">
            <span className={tagClass}>{scheduleLabel}</span>
            <span className={tagClass}>{props.sourceLabel}</span>
            {props.job.source ? <span className={tagClass}>{props.job.source}</span> : null}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-4 text-[12px] text-dls-secondary">
            <div>{t("scheduled.last_run_prefix")} {toRelative(props.job.lastRunAt)}</div>
            <div>{t("scheduled.created_prefix")} {toRelative(props.job.createdAt)}</div>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-dls-border pt-4">
        <span className={tagClass}>{t("scheduled.filter_scheduled")}</span>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={pillSecondaryClass} onClick={props.onRun} disabled={props.busy}>
            <Play size={14} />
            {t("scheduled.run_label")}
          </button>
          <button type="button" className={pillGhostClass} onClick={props.onDelete} disabled={props.busy}>
            <Trash2 size={14} />
            {t("scheduled.delete_label")}
          </button>
        </div>
      </div>
    </div>
  );
}

export function AutomationsView(props: AutomationsViewProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<AutomationsFilter>("all");
  const [installingScheduler, setInstallingScheduler] = useState(false);
  const [schedulerInstallRequested, setSchedulerInstallRequested] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ScheduledJob | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [automationName, setAutomationName] = useState(DEFAULT_AUTOMATION_NAME);
  const [automationPrompt, setAutomationPrompt] = useState(DEFAULT_AUTOMATION_PROMPT);
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>("daily");
  const [scheduleTime, setScheduleTime] = useState(DEFAULT_SCHEDULE_TIME);
  const [scheduleDays, setScheduleDays] = useState<string[]>([...DEFAULT_SCHEDULE_DAYS]);
  const [intervalHours, setIntervalHours] = useState(DEFAULT_INTERVAL_HOURS);
  const [lastUpdatedNow, setLastUpdatedNow] = useState(() => Date.now());

  const jobs = props.automations.jobs();
  const jobsStatus = props.automations.jobsStatus();
  const jobsUpdatedAt = props.automations.jobsUpdatedAt();
  const jobsSource = props.automations.jobsSource();

  useEffect(() => {
    const interval = window.setInterval(() => setLastUpdatedNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (props.schedulerInstalled) {
      setSchedulerInstallRequested(false);
    }
  }, [props.schedulerInstalled]);

  const showToast = (title: string, tone: "success" | "info" | "warning" | "error" = "info") => {
    props.showToast?.({ title, tone });
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

  const supported = jobsSource === "remote" || (isTauriRuntime() && props.schedulerInstalled && !schedulerInstallRequested);
  const schedulerGateActive = jobsSource === "local" && isTauriRuntime() && (!props.schedulerInstalled || schedulerInstallRequested);
  const automationDisabled = props.newTaskDisabled || schedulerGateActive || createBusy;
  const sourceLabel = jobsSource === "remote" ? t("scheduled.source_remote") : t("scheduled.source_local");
  const sourceDescription = jobsSource === "remote" ? t("scheduled.subtitle_remote") : t("scheduled.subtitle_local");
  const supportNote = jobsSource === "remote" ? null : !isTauriRuntime() ? t("scheduled.desktop_required") : null;

  const lastUpdatedLabel = useMemo(() => {
    lastUpdatedNow;
    if (!jobsUpdatedAt) return t("scheduled.not_synced_yet");
    return formatRelativeTime(jobsUpdatedAt);
  }, [jobsUpdatedAt, lastUpdatedNow]);

  const filteredJobs = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return jobs;
    return jobs.filter((job) => {
      const summary = taskSummary(job).toLowerCase();
      const schedule = humanizeCron(job.schedule).toLowerCase();
      return (
        job.name.toLowerCase().includes(query) ||
        summary.includes(query) ||
        schedule.includes(query)
      );
    });
  }, [jobs, searchQuery]);

  const filteredTemplates = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return automationTemplates;
    return automationTemplates.filter((template) => {
      return (
        template.name.toLowerCase().includes(query) ||
        template.description.toLowerCase().includes(query) ||
        template.badge.toLowerCase().includes(query)
      );
    });
  }, [searchQuery]);

  const showJobsSection = activeFilter !== "templates";
  const showTemplatesSection = activeFilter !== "scheduled";

  const cronExpression = useMemo(() => {
    if (scheduleMode === "interval") {
      return buildCronFromInterval(intervalHours);
    }
    return buildCronFromDaily(scheduleTime, scheduleDays);
  }, [intervalHours, scheduleDays, scheduleMode, scheduleTime]);

  const cronPreviewLabel = useMemo(() => {
    return cronExpression ? humanizeCron(cronExpression) : null;
  }, [cronExpression]);

  const refreshJobs = () => {
    if (props.busy) return;
    void props.automations.refresh({ force: true });
  };

  const handleInstallScheduler = async () => {
    if (installingScheduler || !props.canEditPlugins) return;
    setInstallingScheduler(true);
    setSchedulerInstallRequested(true);
    try {
      await Promise.resolve(props.addPlugin("opencode-scheduler"));
      showToast(t("scheduled.scheduler_install_requested"), "success");
    } catch (error) {
      setSchedulerInstallRequested(false);
      showToast(
        error instanceof Error ? error.message : t("scheduled.prepare_error_fallback"),
        "error",
      );
    } finally {
      setInstallingScheduler(false);
    }
  };

  const openCreateModal = () => {
    if (automationDisabled) return;
    resetDraft();
    setCreateModalOpen(true);
  };

  const openCreateModalFromTemplate = (template: AutomationTemplate) => {
    if (automationDisabled) return;
    resetDraft(template);
    setCreateModalOpen(true);
  };

  const closeCreateModal = () => {
    setCreateModalOpen(false);
    setCreateError(null);
    setCreateBusy(false);
  };

  const handleCreateAutomation = async () => {
    if (automationDisabled) return;
    const plan = props.automations.prepareCreateAutomation({
      name: automationName,
      prompt: automationPrompt,
      schedule: cronExpression,
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
      showToast(t("scheduled.prepared_automation_in_chat"), "success");
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : t("scheduled.prepare_error_fallback"));
    } finally {
      setCreateBusy(false);
    }
  };

  const handleRunAutomation = async (job: ScheduledJob) => {
    if (!supported || props.busy) return;
    const plan = props.automations.prepareRunAutomation(job, props.selectedWorkspaceRoot);
    if (!plan.ok) {
      showToast(plan.error, "warning");
      return;
    }
    await Promise.resolve(props.createSessionAndOpen(plan.prompt));
    showToast(t("scheduled.prepared_job_in_chat", undefined, { name: job.name }), "success");
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await Promise.resolve(props.automations.remove(deleteTarget.slug));
      showToast(t("scheduled.removed_job", undefined, { name: deleteTarget.name }), "success");
      setDeleteTarget(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDeleteError(message || t("scheduled.delete_error_fallback"));
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

  const jobsEmptyMessage = useMemo(() => {
    const query = searchQuery.trim();
    if (query) return t("scheduled.no_automations_match", undefined, { query });
    if (schedulerGateActive) return t("scheduled.install_scheduler_hint");
    return t("scheduled.empty_hint");
  }, [schedulerGateActive, searchQuery]);

  return (
    <section className="space-y-8">
      <div className="space-y-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            {props.showHeader !== false ? <h2 className={pageTitleClass}>{t("scheduled.title")}</h2> : null}
            <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-dls-secondary">
              {t("scheduled.page_description")}
            </p>
          </div>

          <div className="flex flex-wrap gap-3 lg:justify-end">
            <button type="button" onClick={() => props.openLink("https://github.com/different-ai/opencode-scheduler")} className={pillSecondaryClass}>
              <PlugZap size={14} />
              {t("scheduled.view_scheduler_docs")}
            </button>
            <button type="button" onClick={refreshJobs} disabled={props.busy} className={pillSecondaryClass}>
              <RefreshCw size={14} />
              {props.busy ? t("scheduled.refreshing") : t("common.refresh")}
            </button>
            <button type="button" onClick={openCreateModal} disabled={automationDisabled} className={pillPrimaryClass}>
              <Plus size={14} />
              {t("scheduled.new_automation")}
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-3 rounded-[20px] border border-dls-border bg-dls-surface p-4 md:flex-row md:items-center md:justify-between">
          <div className="relative min-w-0 flex-1">
            <Search size={16} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-dls-secondary" />
            <input
              type="text"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.currentTarget.value)}
              placeholder={t("scheduled.search_placeholder")}
              className="w-full rounded-xl border border-dls-border bg-dls-surface py-3 pl-11 pr-4 text-[14px] text-dls-text focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.12)]"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {(["all", "scheduled", "templates"] as AutomationsFilter[]).map((filter) => (
              <button
                key={filter}
                type="button"
                onClick={() => setActiveFilter(filter)}
                className={activeFilter === filter ? pillPrimaryClass : pillGhostClass}
              >
                {filter === "all"
                  ? t("scheduled.filter_all")
                  : filter === "scheduled"
                    ? t("scheduled.filter_scheduled")
                    : t("scheduled.filter_templates")}
              </button>
            ))}
          </div>
        </div>
      </div>

      {schedulerGateActive ? (
        <div className="rounded-[20px] border border-dls-border bg-dls-hover px-5 py-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-surface">
                <PlugZap size={18} className="text-dls-secondary" />
              </div>
              <div>
                <div className="text-[15px] font-medium tracking-[-0.2px] text-dls-text">
                  {props.schedulerInstalled
                    ? t("scheduled.reload_activate_title")
                    : t("scheduled.install_scheduler_title")}
                </div>
                <p className="mt-1 text-[13px] leading-relaxed text-dls-secondary">
                  {props.schedulerInstalled
                    ? t("scheduled.reload_activate_hint")
                    : t("scheduled.install_scheduler_hint")}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void handleInstallScheduler()}
                disabled={!props.canEditPlugins || installingScheduler}
                className={pillSecondaryClass}
              >
                <Plus size={14} />
                {installingScheduler ? t("scheduled.installing") : t("scheduled.install_scheduler")}
              </button>
              <button
                type="button"
                onClick={() => void props.reloadWorkspaceEngine()}
                disabled={!props.canReloadWorkspace || props.reloadBusy || !props.schedulerInstalled}
                className={pillSecondaryClass}
              >
                <RefreshCw size={14} />
                {props.reloadBusy ? t("scheduled.reloading") : t("scheduled.reload_openwork")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {supportNote ? (
        <div className="rounded-[20px] border border-dls-border bg-dls-hover px-5 py-4 text-[13px] text-dls-secondary">
          {supportNote}
        </div>
      ) : null}

      {jobsStatus ? (
        <div className="rounded-[20px] border border-red-7/20 bg-red-1/40 px-5 py-4 text-[13px] text-red-11">
          {jobsStatus}
        </div>
      ) : null}

      {deleteError ? (
        <div className="rounded-[20px] border border-red-7/20 bg-red-1/40 px-5 py-4 text-[13px] text-red-11">
          {deleteError}
        </div>
      ) : null}

      {showJobsSection ? (
        <div className="space-y-4">
          <div className="flex items-end justify-between gap-3">
            <div>
              <h3 className={sectionTitleClass}>{t("scheduled.your_automations")}</h3>
              <p className="mt-1 text-[13px] text-dls-secondary">{sourceDescription}</p>
            </div>
            <div className="text-[12px] text-dls-secondary">
              {sourceLabel} · {t("scheduled.last_updated_prefix")} {lastUpdatedLabel}
            </div>
          </div>

          {filteredJobs.length ? (
            <div className="rounded-[24px] bg-dls-hover p-4">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {filteredJobs.map((job) => (
                  <JobCard
                    key={job.slug}
                    job={job}
                    sourceLabel={sourceLabel}
                    busy={props.busy || deleteBusy || !supported}
                    onRun={() => void handleRunAutomation(job)}
                    onDelete={() => setDeleteTarget(job)}
                  />
                ))}
              </div>
            </div>
          ) : (
            <div className="rounded-[20px] border border-dashed border-dls-border bg-dls-surface px-5 py-8 text-[14px] text-dls-secondary">
              {jobsEmptyMessage}
            </div>
          )}
        </div>
      ) : null}

      {showTemplatesSection ? (
        <div className="space-y-4">
          <div className="flex items-end justify-between gap-3">
            <div>
              <h3 className={sectionTitleClass}>{t("scheduled.quick_start_templates")}</h3>
              <p className="mt-1 text-[13px] text-dls-secondary">{t("scheduled.quick_start_templates_desc")}</p>
            </div>
            <div className="text-[12px] text-dls-secondary">
              {t("scheduled.template_count", undefined, { count: filteredTemplates.length })}
            </div>
          </div>

          {filteredTemplates.length ? (
            <div className="rounded-[24px] bg-dls-hover p-4">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {filteredTemplates.map((template) => (
                  <TemplateCard
                    key={template.name}
                    template={template}
                    disabled={automationDisabled}
                    onUse={() => openCreateModalFromTemplate(template)}
                  />
                ))}
              </div>
            </div>
          ) : (
            <div className="rounded-[20px] border border-dashed border-dls-border bg-dls-surface px-5 py-8 text-[14px] text-dls-secondary">
              {t("scheduled.no_templates_match")}
            </div>
          )}
        </div>
      ) : null}

      {deleteTarget ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md overflow-hidden rounded-2xl border border-dls-border bg-dls-surface shadow-2xl">
            <div className="space-y-4 p-6">
              <div>
                <h3 className="text-lg font-semibold text-dls-text">{t("scheduled.delete_confirm_title")}</h3>
                <p className="mt-1 text-sm text-dls-secondary">
                  {t("scheduled.delete_confirm_desc", undefined, { source: sourceLabel.toLowerCase() })}
                </p>
              </div>

              <div className="rounded-xl border border-dls-border bg-dls-hover p-3 text-xs text-dls-secondary">
                {deleteTarget.name}
              </div>

              <div className="flex justify-end gap-2">
                <button type="button" className={pillGhostClass} onClick={() => setDeleteTarget(null)} disabled={deleteBusy}>
                  {t("common.cancel")}
                </button>
                <button type="button" className={pillPrimaryClass} onClick={() => void confirmDelete()} disabled={deleteBusy}>
                  {deleteBusy ? t("scheduled.deleting") : t("scheduled.delete_label")}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {createModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
          <div className="w-full max-w-2xl overflow-hidden rounded-2xl border border-dls-border bg-dls-surface shadow-2xl">
            <div className="flex items-center justify-between gap-3 border-b border-dls-border px-5 py-4">
              <div>
                <div className="text-sm font-semibold text-dls-text">{t("scheduled.create_title")}</div>
                <p className="mt-1 text-xs text-dls-secondary">{t("scheduled.create_desc")}</p>
              </div>
              <button
                type="button"
                onClick={closeCreateModal}
                className="rounded-full p-1 text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
              >
                <X size={18} />
              </button>
            </div>

            <div className="space-y-5 p-5">
              <div className="space-y-1.5">
                <label className="text-[13px] font-medium text-dls-text">{t("scheduled.name_label")}</label>
                <input
                  type="text"
                  value={automationName}
                  onChange={(event) => setAutomationName(event.currentTarget.value)}
                  className="w-full rounded-xl border border-dls-border bg-dls-surface px-4 py-3 text-[14px] text-dls-text focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.12)]"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-[13px] font-medium text-dls-text">{t("scheduled.task_summary_prompt")}</label>
                <textarea
                  rows={4}
                  value={automationPrompt}
                  onChange={(event) => setAutomationPrompt(event.currentTarget.value)}
                  className="w-full resize-none rounded-xl border border-dls-border bg-dls-surface px-4 py-3 text-[14px] text-dls-text focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.12)]"
                />
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <label className="text-[13px] font-medium text-dls-text">{t("scheduled.schedule_label")}</label>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setScheduleMode("daily")}
                      className={scheduleMode === "daily" ? pillPrimaryClass : pillGhostClass}
                    >
                      {t("scheduled.daily_mode")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setScheduleMode("interval")}
                      className={scheduleMode === "interval" ? pillPrimaryClass : pillGhostClass}
                    >
                      {t("scheduled.interval_mode")}
                    </button>
                  </div>
                </div>

                {scheduleMode === "daily" ? (
                  <div className="space-y-3 rounded-[20px] border border-dls-border bg-dls-hover p-4">
                    <div className="flex flex-wrap items-center gap-3">
                      <div className="flex items-center gap-2 rounded-xl border border-dls-border bg-dls-surface px-3 py-2 text-[14px] text-dls-text">
                        <Clock size={16} className="text-dls-secondary" />
                        <input
                          type="time"
                          value={scheduleTime}
                          onChange={(event) => setScheduleTime(event.currentTarget.value)}
                          className="bg-transparent focus:outline-none"
                        />
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {dayOptions.map((day) => (
                        <button
                          key={day.id}
                          type="button"
                          onClick={() => toggleDay(day.id)}
                          className={scheduleDays.includes(day.id) ? pillPrimaryClass : pillGhostClass}
                        >
                          {day.label()}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-3 rounded-[20px] border border-dls-border bg-dls-hover p-4">
                    <div className="text-[13px] text-dls-secondary">{t("scheduled.every_prefix")}</div>
                    <input
                      type="number"
                      min={1}
                      max={24}
                      value={intervalHours}
                      onChange={(event) => updateIntervalHours(event.currentTarget.value)}
                      className="w-20 rounded-xl border border-dls-border bg-dls-surface px-3 py-2 text-[14px] text-dls-text focus:outline-none"
                    />
                    <div className="text-[13px] text-dls-secondary">{t("scheduled.hours_suffix")}</div>
                  </div>
                )}

                {cronExpression ? (
                  <div className="rounded-[20px] border border-dls-border bg-dls-hover px-4 py-3 text-[13px] text-dls-secondary">
                    <div>{cronPreviewLabel}</div>
                    <div className="mt-1 font-mono text-[12px] text-dls-text">{cronExpression}</div>
                  </div>
                ) : null}
              </div>

              {createError ? (
                <div className="rounded-xl border border-red-7/20 bg-red-1/40 px-4 py-3 text-xs text-red-12">
                  {createError}
                </div>
              ) : null}
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-dls-border px-5 py-4">
              <div className="text-[12px] text-dls-secondary">{t("scheduled.worker_root_hint")}</div>
              <div className="flex items-center gap-2">
                <button type="button" className={pillGhostClass} onClick={closeCreateModal} disabled={createBusy}>
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  className={pillPrimaryClass}
                  onClick={() => void handleCreateAutomation()}
                  disabled={createBusy || automationDisabled}
                >
                  {t("scheduled.create_button")}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export default AutomationsView;
