"use client";

import { Activity, CheckCircle2, ChevronRight, Clock, Users, Zap } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { requestJson } from "../../_lib/den-flow";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { EnterprisePlanNotice } from "./enterprise-plan-notice";

/* ── Types ── */

type AnalyticsWeek = {
  weekStart: string;
  activeMembers: number;
  sessions: number;
  tasksCompleted: number;
  tasksFailed: number;
};

type AnalyticsData = {
  members: number;
  pendingInvites: number;
  activeMembers7d: number;
  activeMembers30d: number;
  sessions7d: number;
  sessions30d: number;
  tasksCompleted7d: number;
  tasksFailed7d: number;
  tasksCompleted30d: number;
  tasksFailed30d: number;
  avgTaskDurationMs30d: number | null;
  weekly: AnalyticsWeek[];
};

/* ── Data ── */

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readWeek(value: unknown): AnalyticsWeek {
  const w = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    weekStart: typeof w.weekStart === "string" ? w.weekStart : "",
    activeMembers: readNumber(w.activeMembers),
    sessions: readNumber(w.sessions),
    tasksCompleted: readNumber(w.tasksCompleted),
    tasksFailed: readNumber(w.tasksFailed),
  };
}

async function fetchAnalytics(): Promise<AnalyticsData | null> {
  try {
    const { response, payload } = await requestJson("/v1/telemetry/analytics", { method: "GET" }, 12000);
    if (!response.ok || !payload || typeof payload !== "object") return null;
    const p = payload as Record<string, unknown>;
    return {
      members: readNumber(p.members),
      pendingInvites: readNumber(p.pendingInvites),
      activeMembers7d: readNumber(p.activeMembers7d),
      activeMembers30d: readNumber(p.activeMembers30d),
      sessions7d: readNumber(p.sessions7d),
      sessions30d: readNumber(p.sessions30d),
      tasksCompleted7d: readNumber(p.tasksCompleted7d),
      tasksFailed7d: readNumber(p.tasksFailed7d),
      tasksCompleted30d: readNumber(p.tasksCompleted30d),
      tasksFailed30d: readNumber(p.tasksFailed30d),
      avgTaskDurationMs30d: typeof p.avgTaskDurationMs30d === "number" ? p.avgTaskDurationMs30d : null,
      weekly: Array.isArray(p.weekly) ? p.weekly.map(readWeek) : [],
    };
  } catch {
    return null;
  }
}

/* ── Helpers ── */

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return "<1s";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatWeekLabel(weekStart: string): string {
  const date = new Date(`${weekStart}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return weekStart;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

function successRate(completed: number, failed: number): string {
  const total = completed + failed;
  if (total === 0) return "—";
  return `${Math.round((completed / total) * 100)}%`;
}

function toneBg(tone: "violet" | "green" | "blue" | "amber") {
  switch (tone) {
    case "violet": return "bg-[#EDE4FF]";
    case "green": return "bg-[#E3F3E3]";
    case "blue": return "bg-[#E4ECFB]";
    case "amber": return "bg-[#FBF0DC]";
  }
}

/* ── Small components ── */

function StatCard({ icon, title, value, sub, tone }: {
  icon: React.ReactNode; title: string; value: string; sub?: string; tone: "violet" | "green" | "blue" | "amber";
}) {
  return (
    <div className="rounded-[16px] border border-[#e3e7ee] bg-white/90 px-4 py-3.5">
      <div className="flex items-center gap-3">
        <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] ${toneBg(tone)}`}>{icon}</div>
        <div className="min-w-0">
          <div className="text-[13px] font-medium tracking-[-0.01em] text-[#30405F]">{title}</div>
          <div className="mt-0.5 text-[20px] font-semibold tracking-[-0.03em] text-[#07192C]">{value}</div>
          {sub ? <div className="mt-0.5 truncate text-[12px] text-[#637291]">{sub}</div> : null}
        </div>
      </div>
    </div>
  );
}

type BarSeries = {
  label: string;
  color: string;
  values: number[];
};

function TrendChart({ title, subtitle, weeks, series }: {
  title: string;
  subtitle: string;
  weeks: AnalyticsWeek[];
  series: BarSeries[];
}) {
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const hasData = series.some((s) => s.values.some((v) => v > 0));

  return (
    <div className="rounded-[16px] border border-[#e3e7ee] bg-white/90 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="text-[14px] font-semibold tracking-[-0.01em] text-[#07192C]">{title}</h3>
          <p className="mt-0.5 text-[12px] text-[#637291]">{subtitle}</p>
        </div>
        {series.length > 1 ? (
          <div className="flex items-center gap-3">
            {series.map((s) => (
              <span key={s.label} className="flex items-center gap-1.5 text-[11px] text-[#637291]">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: s.color }} />
                {s.label}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <div className="relative mt-4">
        <div className="flex h-[120px] items-end gap-1.5">
          {weeks.map((week, i) => (
            <div key={week.weekStart || i} className="flex h-full flex-1 items-end justify-center gap-px">
              {series.map((s) => {
                const value = s.values[i] ?? 0;
                const height = value > 0 ? Math.max(4, (value / max) * 100) : 2;
                return (
                  <div
                    key={s.label}
                    title={`Week of ${formatWeekLabel(week.weekStart)} — ${s.label}: ${value}`}
                    className="w-full max-w-[18px] rounded-t-[3px] transition-[height]"
                    style={{
                      height: `${height}%`,
                      backgroundColor: value > 0 ? s.color : "#EBEEF4",
                    }}
                  />
                );
              })}
            </div>
          ))}
        </div>
        {!hasData ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="rounded-full bg-white/90 px-3 py-1 text-[12px] text-[#637291]">No usage events yet</span>
          </div>
        ) : null}
      </div>

      <div className="mt-2 flex justify-between text-[11px] text-[#9AA5BA]">
        <span>{weeks.length > 0 ? formatWeekLabel(weeks[0].weekStart) : ""}</span>
        <span>{weeks.length > 0 ? formatWeekLabel(weeks[weeks.length - 1].weekStart) : ""}</span>
      </div>
    </div>
  );
}

/* ── Main screen ── */

export function AnalyticsScreen() {
  const { activeOrg, orgContext } = useOrgDashboard();

  // Server enforces the same gate with a 402 on /v1/telemetry/analytics
  // (entitlements.ts); this mirrors the SSO / desktop policies screens.
  const locked = Boolean(orgContext) && !orgContext?.entitlements.analytics;

  const { data, isLoading } = useQuery({
    queryKey: ["telemetry", "analytics"],
    queryFn: fetchAnalytics,
    enabled: !locked,
  });

  const weekly = data?.weekly ?? [];
  const tasks7d = (data?.tasksCompleted7d ?? 0) + (data?.tasksFailed7d ?? 0);

  return (
    <div className="mx-auto max-w-[1100px] px-4 pb-8 pt-4 sm:px-6 md:px-8">

      {/* Breadcrumb */}
      <div className="flex flex-wrap items-center gap-2.5 border-b border-[#e7e9f0] pb-3">
        <span className="text-[14px] font-semibold tracking-[-0.01em] text-[#07192C]">{activeOrg?.name ?? "OpenWork Cloud"}</span>
        <ChevronRight className="h-3.5 w-3.5 text-[#9AA5BA]" />
        <span className="text-[14px] font-medium tracking-[-0.01em] text-[#5A6886]">Analytics</span>
      </div>

      {/* Header */}
      <div className="mt-4 flex flex-wrap items-center gap-2.5">
        <h1 className="text-[22px] font-semibold tracking-[-0.03em] text-[#07192C]">Usage &amp; adoption</h1>
        <span className="rounded-full border border-[#d8e0ec] bg-white px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#6F3DFF]">
          Enterprise
        </span>
      </div>
      <p className="mt-1 text-[14px] leading-6 text-[#5A6886]">
        See how your team is adopting OpenWork — active members, sessions, and task activity over time.
        Only event metadata is collected — never prompts, code, or file contents.
      </p>

      {locked ? (
        <div className="mt-5">
          <EnterprisePlanNotice feature="Usage analytics" />
        </div>
      ) : (
      <>
      {/* Summary cards */}
      <div className="mt-5 grid gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={<Users className="h-5 w-5 text-[#6F3DFF]" />}
          title="OpenWork users"
          value={isLoading ? "…" : `${data?.members ?? 0}`}
          sub={`${data?.pendingInvites ?? 0} pending invites`}
          tone="violet"
        />
        <StatCard
          icon={<Activity className="h-5 w-5 text-[#1D63FF]" />}
          title="Active this week"
          value={isLoading ? "…" : `${data?.activeMembers7d ?? 0}`}
          sub={`${data?.activeMembers30d ?? 0} active in last 30 days`}
          tone="blue"
        />
        <StatCard
          icon={<Zap className="h-5 w-5 text-[#B7791F]" />}
          title="Sessions this week"
          value={isLoading ? "…" : `${data?.sessions7d ?? 0}`}
          sub={`${data?.sessions30d ?? 0} in last 30 days`}
          tone="amber"
        />
        <StatCard
          icon={<CheckCircle2 className="h-5 w-5 text-[#18A34A]" />}
          title="Tasks this week"
          value={isLoading ? "…" : `${tasks7d}`}
          sub={`${successRate(data?.tasksCompleted7d ?? 0, data?.tasksFailed7d ?? 0)} success rate`}
          tone="green"
        />
      </div>

      {/* Trend charts */}
      <div className="mt-4 grid gap-3.5 lg:grid-cols-2">
        <TrendChart
          title="Weekly active users"
          subtitle="Members with at least one event, last 12 weeks"
          weeks={weekly}
          series={[{ label: "Active users", color: "#6F3DFF", values: weekly.map((w) => w.activeMembers) }]}
        />
        <TrendChart
          title="Sessions per week"
          subtitle="Distinct sessions, last 12 weeks"
          weeks={weekly}
          series={[{ label: "Sessions", color: "#1D63FF", values: weekly.map((w) => w.sessions) }]}
        />
      </div>

      <div className="mt-3.5">
        <TrendChart
          title="Tasks per week"
          subtitle="Completed and failed task runs, last 12 weeks"
          weeks={weekly}
          series={[
            { label: "Completed", color: "#18A34A", values: weekly.map((w) => w.tasksCompleted) },
            { label: "Failed", color: "#E5484D", values: weekly.map((w) => w.tasksFailed) },
          ]}
        />
      </div>

      {/* 30-day detail */}
      <div className="mt-4 grid gap-3.5 sm:grid-cols-3">
        <StatCard
          icon={<Clock className="h-5 w-5 text-[#1D63FF]" />}
          title="Avg task duration"
          value={isLoading ? "…" : formatDuration(data?.avgTaskDurationMs30d ?? null)}
          sub="Completed tasks, last 30 days"
          tone="blue"
        />
        <StatCard
          icon={<CheckCircle2 className="h-5 w-5 text-[#18A34A]" />}
          title="Tasks completed"
          value={isLoading ? "…" : `${data?.tasksCompleted30d ?? 0}`}
          sub="Last 30 days"
          tone="green"
        />
        <StatCard
          icon={<Activity className="h-5 w-5 text-[#E5484D]" />}
          title="Tasks failed"
          value={isLoading ? "…" : `${data?.tasksFailed30d ?? 0}`}
          sub={`${successRate(data?.tasksCompleted30d ?? 0, data?.tasksFailed30d ?? 0)} success rate over 30 days`}
          tone="amber"
        />
      </div>

      {/* Privacy note */}
      <p className="mt-5 text-[12px] leading-5 text-[#9AA5BA]">
        Telemetry never includes prompt contents, code, file contents, diffs, secrets, or terminal output.
        Usage data appears here once members sign in to the OpenWork app and start running tasks.
      </p>
      </>
      )}
    </div>
  );
}
