import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";

import type { ScheduledJob } from "../types";
import { useAutomations } from "../automations/provider";
import { usePlatform } from "../context/platform";
import { formatRelativeTime, isTauriRuntime } from "../utils";

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

const DEFAULT_AUTOMATION_NAME = "Daily bug scan";
const DEFAULT_AUTOMATION_PROMPT =
  "Scan recent commits and flag riskier diffs with the most important follow-ups.";
const DEFAULT_SCHEDULE_TIME = "09:00";
const DEFAULT_SCHEDULE_DAYS = ["mo", "tu", "we", "th", "fr"];
const DEFAULT_INTERVAL_HOURS = 6;

const automationTemplates: AutomationTemplate[] = [
  {
    icon: Calendar,
    name: "Daily planning brief",
    description: "Build a focused plan from your tasks and calendar before the day starts.",
    prompt:
      "Review my pending tasks and calendar, then draft a practical plan for today with top priorities and one follow-up reminder.",
    scheduleMode: "daily",
    scheduleTime: "08:30",
    scheduleDays: ["mo", "tu", "we", "th", "fr"],
    badge: "Weekday morning",
  },
  {
    icon: BookOpen,
    name: "Inbox zero helper",
    description: "Summarize unread messages and suggest concise replies for the top threads.",
    prompt:
      "Summarize unread inbox messages, suggest priority order, and draft concise reply options for the top conversations.",
    scheduleMode: "daily",
    scheduleTime: "17:30",
    scheduleDays: ["mo", "tu", "we", "th", "fr"],
    badge: "End-of-day",
  },
  {
    icon: MessageSquare,
    name: "Meeting prep notes",
    description: "Generate prep bullets, context, and unblockers for tomorrow's meetings.",
    prompt:
      "Prepare meeting briefs for tomorrow with context, talking points, and questions to unblock decisions.",
    scheduleMode: "daily",
    scheduleTime: "18:00",
    scheduleDays: ["mo", "tu", "we", "th", "fr"],
    badge: "Weekday evening",
  },
  {
    icon: TrendingUp,
    name: "Weekly wins recap",
    description: "Turn the week into wins, blockers, and clear next steps to share.",
    prompt:
      "Summarize the week into wins, blockers, and clear next steps I can share with the team.",
    scheduleMode: "daily",
    scheduleTime: "16:00",
    scheduleDays: ["fr"],
    badge: "Friday wrap-up",
  },
  {
    icon: Trophy,
    name: "Learning digest",
    description: "Collect saved links and notes into a weekly digest with actions.",
    prompt:
      "Collect my saved links and notes, then draft a weekly learning digest with key ideas and follow-up actions.",
    scheduleMode: "daily",
    scheduleTime: "10:00",
    scheduleDays: ["su"],
    badge: "Weekend review",
  },
  {
    icon: Brain,
    name: "Habit check-in",
    description: "Run a quick accountability check-in and suggest one concrete next action.",
    prompt:
      "Ask me for a quick progress check-in, capture blockers, and suggest one concrete next action.",
    scheduleMode: "interval",
    intervalHours: 6,
    badge: "Every few hours",
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
  if (parts.length < 5) return "Custom schedule";
  const [minuteRaw, hourRaw, dom, mon, dowRaw] = parts;
  if (!minuteRaw || !hourRaw || !dom || !mon || !dowRaw) return "Custom schedule";

  if (
    minuteRaw === "0" &&
    hourRaw.startsWith("*/") &&
    dom === "*" &&
    mon === "*" &&
    dowRaw === "*"
  ) {
    const interval = Number.parseInt(hourRaw.slice(2), 10);
    if (Number.isFinite(interval) && interval > 0) {
      return interval === 1 ? "Every hour" : `Every ${interval} hours`;
    }
  }

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

  if (allDays.every((d) => normalized.has(d))) return `Every day at ${timeLabel}`;
  if (
    weekdayDays.every((d) => normalized.has(d)) &&
    !weekendDays.some((d) => normalized.has(d))
  ) {
    return `Weekdays at ${timeLabel}`;
  }
  if (
    weekendDays.every((d) => normalized.has(d)) &&
    !weekdayDays.some((d) => normalized.has(d))
  ) {
    return `Weekends at ${timeLabel}`;
  }

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

  return list ? `${list} at ${timeLabel}` : `At ${timeLabel}`;
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
  return prompt?.trim() || "No prompt or command configured yet.";
};

const toRelative = (value?: string | null) => {
  if (!value) return "Never";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "Never";
  return formatRelativeTime(parsed);
};

const templateScheduleLabel = (template: AutomationTemplate) => {
  if (template.scheduleMode === "interval") {
    return `Every ${template.intervalHours ?? DEFAULT_INTERVAL_HOURS} hours`;
  }
  return humanizeCron(
    buildCronFromDaily(
      template.scheduleTime ?? DEFAULT_SCHEDULE_TIME,
      template.scheduleDays ?? DEFAULT_SCHEDULE_DAYS,
    ),
  );
};

const statusLabel = (status?: string | null) => {
  if (!status) return "Not run yet";
  if (status === "running") return "Running";
  if (status === "success") return "Healthy";
  if (status === "failed") return "Needs attention";
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
        <span class={tagClass}>Template</span>
        <button type="button" class={pillPrimaryClass} onClick={props.onUse} disabled={props.disabled}>
          <Sparkles size={14} />
          Use template
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
            <div>Last run {toRelative(props.job.lastRunAt)}</div>
            <div>Created {toRelative(props.job.createdAt)}</div>
          </div>
        </div>
      </div>

      <div class="flex flex-wrap items-center justify-between gap-3 border-t border-dls-border pt-4">
        <span class={tagClass}>Scheduled</span>
        <div class="flex flex-wrap gap-2">
          <button type="button" class={pillSecondaryClass} onClick={props.onRun} disabled={props.busy}>
            <Play size={14} />
            Run in chat
          </button>
          <button type="button" class={pillGhostClass} onClick={props.onDelete} disabled={props.busy}>
            <Trash2 size={14} />
            Remove
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
  const [automationName, setAutomationName] = createSignal(DEFAULT_AUTOMATION_NAME);
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
    setAutomationName(template?.name ?? DEFAULT_AUTOMATION_NAME);
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
    automations.jobsSource() === "remote" ? "OpenWork server" : "Local scheduler",
  );

  const sourceDescription = createMemo(() =>
    automations.jobsSource() === "remote"
      ? "Scheduled tasks that are currently synced from the connected OpenWork server."
      : "Scheduled tasks that are currently registered on this device through the local scheduler.",
  );

  const supportNote = createMemo(() => {
    if (automations.jobsSource() === "remote") return null;
    if (!isTauriRuntime()) return "Automations require the desktop app or a connected OpenWork server.";
    if (!props.schedulerInstalled || schedulerInstallRequested()) return null;
    return null;
  });

  const lastUpdatedLabel = createMemo(() => {
    lastUpdatedNow();
    if (!automations.jobsUpdatedAt()) return "Not synced yet";
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
      showToast("Scheduler install requested.", "success");
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
      showToast("Prepared automation in chat.", "success");
    } catch (error) {
      setCreateError(
        error instanceof Error ? error.message : "Failed to prepare automation in chat.",
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
    showToast(`Prepared ${job.name} in chat.`, "success");
  };

  const confirmDelete = async () => {
    const target = deleteTarget();
    if (!target) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await automations.remove(target.slug);
      setDeleteTarget(null);
      showToast(`Removed ${target.name}.`, "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDeleteError(message || "Failed to delete automation.");
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
    if (query) return `No automations match \"${query}\".`;
    if (schedulerGateActive()) return "Install the scheduler or connect to an OpenWork server to start creating automations.";
    return "No automations yet. Start with a template or prepare one in chat.";
  });

  return (
    <section class="space-y-8">
      <div class="space-y-6">
        <div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div class="min-w-0">
            <Show when={props.showHeader !== false}>
              <h2 class={pageTitleClass}>Automations</h2>
            </Show>
            <p class="mt-2 max-w-2xl text-[14px] leading-relaxed text-dls-secondary">
              Schedule recurring tasks for this worker, monitor what is already registered, and start from a reusable template.
            </p>
          </div>

          <div class="flex flex-wrap gap-3 lg:justify-end">
            <button type="button" onClick={openSchedulerDocs} class={pillSecondaryClass}>
              <PlugZap size={14} />
              Scheduler docs
            </button>
            <button type="button" onClick={refreshJobs} disabled={props.busy} class={pillSecondaryClass}>
              <RefreshCw size={14} />
              Refresh
            </button>
            <button
              type="button"
              onClick={openCreateModal}
              disabled={automationDisabled()}
              class={pillPrimaryClass}
            >
              <Plus size={14} />
              New automation
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
              placeholder="Search automations or templates"
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
                    ? "All"
                    : filter === "scheduled"
                      ? "Scheduled"
                      : "Templates"}
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
                    ? "Reload OpenWork to activate automations"
                    : "Install the scheduler to unlock automations"}
                </div>
                <p class="mt-1 text-[13px] leading-relaxed text-dls-secondary">
                  {props.schedulerInstalled
                    ? "OpenCode loads plugins at startup. Reload OpenWork to activate opencode-scheduler for this workspace."
                    : "Automations run through the opencode-scheduler plugin today. Add it to this workspace to unlock local scheduling."}
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
                {installingScheduler() ? "Installing…" : "Install scheduler"}
              </button>
              <button
                type="button"
                onClick={() => void props.reloadWorkspaceEngine()}
                disabled={!props.canReloadWorkspace || props.reloadBusy || !props.schedulerInstalled}
                class={pillSecondaryClass}
              >
                <RefreshCw size={14} />
                {props.reloadBusy ? "Reloading…" : "Reload OpenWork"}
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
              <h3 class={sectionTitleClass}>Your automations</h3>
              <p class="mt-1 text-[13px] text-dls-secondary">{sourceDescription()}</p>
            </div>
            <div class="text-[12px] text-dls-secondary">
              {sourceLabel()} · synced {lastUpdatedLabel()}
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
              <h3 class={sectionTitleClass}>Quick start templates</h3>
              <p class="mt-1 text-[13px] text-dls-secondary">
                Start from a proven recurring workflow, then tailor the prompt before you prepare it in chat.
              </p>
            </div>
            <div class="text-[12px] text-dls-secondary">{filteredTemplates().length} templates</div>
          </div>

          <Show
            when={filteredTemplates().length}
            fallback={
              <div class="rounded-[20px] border border-dashed border-dls-border bg-dls-surface px-5 py-8 text-[14px] text-dls-secondary">
                No templates match this search.
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
                <h3 class="text-lg font-semibold text-dls-text">Remove automation?</h3>
                <p class="mt-1 text-sm text-dls-secondary">
                  This removes the schedule and deletes the job definition from {sourceLabel().toLowerCase()}.
                </p>
              </div>

              <div class="rounded-xl bg-dls-hover border border-dls-border p-3 text-xs text-dls-secondary">
                {deleteTarget()?.name}
              </div>

              <div class="flex justify-end gap-2">
                <button type="button" class={pillGhostClass} onClick={() => setDeleteTarget(null)} disabled={deleteBusy()}>
                  Cancel
                </button>
                <button type="button" class={pillPrimaryClass} onClick={() => void confirmDelete()} disabled={deleteBusy()}>
                  {deleteBusy() ? "Removing…" : "Remove"}
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
                <div class="text-sm font-semibold text-dls-text">Create automation</div>
                <p class="mt-1 text-xs text-dls-secondary">
                  The form is ready for direct writes. For now, OpenWork prepares the scheduler command in chat for you.
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
                <label class="text-[13px] font-medium text-dls-text">Name</label>
                <input
                  type="text"
                  value={automationName()}
                  onInput={(event) => setAutomationName(event.currentTarget.value)}
                  class="w-full rounded-xl border border-dls-border bg-dls-surface px-4 py-3 text-[14px] text-dls-text focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.12)]"
                />
              </div>

              <div class="space-y-1.5">
                <label class="text-[13px] font-medium text-dls-text">Prompt</label>
                <textarea
                  rows={4}
                  value={automationPrompt()}
                  onInput={(event) => setAutomationPrompt(event.currentTarget.value)}
                  class="w-full resize-none rounded-xl border border-dls-border bg-dls-surface px-4 py-3 text-[14px] text-dls-text focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.12)]"
                />
              </div>

              <div class="space-y-3">
                <div class="flex items-center justify-between gap-3">
                  <label class="text-[13px] font-medium text-dls-text">Schedule</label>
                  <div class="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setScheduleMode("daily")}
                      class={scheduleMode() === "daily" ? pillPrimaryClass : pillGhostClass}
                    >
                      Daily
                    </button>
                    <button
                      type="button"
                      onClick={() => setScheduleMode("interval")}
                      class={scheduleMode() === "interval" ? pillPrimaryClass : pillGhostClass}
                    >
                      Interval
                    </button>
                  </div>
                </div>

                <Show
                  when={scheduleMode() === "daily"}
                  fallback={
                    <div class="flex flex-wrap items-center gap-3 rounded-[20px] border border-dls-border bg-dls-hover p-4">
                      <div class="text-[13px] text-dls-secondary">Every</div>
                      <input
                        type="number"
                        min={1}
                        max={24}
                        value={intervalHours()}
                        onInput={(event) => updateIntervalHours(event.currentTarget.value)}
                        class="w-20 rounded-xl border border-dls-border bg-dls-surface px-3 py-2 text-[14px] text-dls-text focus:outline-none"
                      />
                      <div class="text-[13px] text-dls-secondary">hours</div>
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
                            {day.label}
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
              <div class="text-[12px] text-dls-secondary">Worker root is inferred from the selected workspace.</div>
              <div class="flex items-center gap-2">
                <button type="button" class={pillGhostClass} onClick={closeCreateModal} disabled={createBusy()}>
                  Cancel
                </button>
                <button
                  type="button"
                  class={pillPrimaryClass}
                  onClick={() => void handleCreateAutomation()}
                  disabled={createBusy() || automationDisabled()}
                >
                  {createBusy() ? "Preparing…" : "Prepare in chat"}
                </button>
              </div>
            </div>
          </div>
        </div>
      </Show>
    </section>
  );
}
