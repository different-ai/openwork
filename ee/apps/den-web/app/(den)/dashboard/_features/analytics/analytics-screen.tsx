"use client";

import { useState } from "react";
import { Activity, CheckCircle2, ChevronRight, Clock, MousePointerClick, Users, Zap } from "lucide-react";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { EnterprisePlanNotice } from "../../_components/enterprise-plan-notice";
import { ModelUsageList } from "./model-usage-list";
import { ProjectFilter } from "./project-filter";
import { StatCard } from "./stat-card";
import { TrendChart } from "./trend-chart";
import { useAnalytics, useProjectOptions } from "./use-analytics";

/* ── Formatting ── */

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

function successRate(completed: number, failed: number): string {
  const total = completed + failed;
  if (total === 0) return "—";
  return `${Math.round((completed / total) * 100)}%`;
}

function selectionShare(value: number, defaultCount: number, manualCount: number): string {
  const total = defaultCount + manualCount;
  return total === 0 ? "No model sessions yet" : `${Math.round((value / total) * 100)}% of model sessions`;
}

/* ── Main screen ── */

export function AnalyticsScreen() {
  const { activeOrg, orgContext } = useOrgDashboard();
  const [projectValue, setProjectValue] = useState("");

  // Server enforces the same gate with a 402 on /v1/telemetry/analytics
  // (entitlements.ts); this mirrors the SSO / desktop policies screens.
  const locked = Boolean(orgContext) && !orgContext?.entitlements.analytics;

  const projectOptions = useProjectOptions(!locked);
  const { data, isLoading } = useAnalytics(!locked, projectValue);

  const projectScoped = projectValue.length > 0;
  const weekly = data?.weekly ?? [];
  const tasks7d = (data?.tasksCompleted7d ?? 0) + (data?.tasksFailed7d ?? 0);
  const modelUsage = data?.models.usage30d ?? [];
  const defaultModelSessions = data?.models.selection30d.default ?? 0;
  const manualModelSessions = data?.models.selection30d.manual ?? 0;

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
      <ProjectFilter options={projectOptions} value={projectValue} onValueChange={setProjectValue} />

      {/* Summary cards */}
      <div className="mt-5 grid gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={<Users className="h-5 w-5 text-[#6F3DFF]" />}
          title="OpenWork users"
          value={isLoading ? "…" : `${data?.members ?? 0}`}
          sub={projectScoped ? "Org total, not project-scoped" : `${data?.pendingInvites ?? 0} pending invites`}
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
          subtitle={projectScoped ? "Members with project-matched events, last 12 weeks" : "Members with at least one event, last 12 weeks"}
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

      {/* Model usage */}
      <div className="mt-5">
        <h2 className="text-[16px] font-semibold tracking-[-0.02em] text-[#07192C]">Models</h2>
        <p className="mt-0.5 text-[12px] text-[#637291]">See which models your team uses and how they are selected.</p>
        <div className="mt-3 grid gap-3.5 lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
          <ModelUsageList models={modelUsage} isLoading={isLoading} />
          <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-1">
            <StatCard
              icon={<Zap className="h-5 w-5 text-[#B7791F]" />}
              title="Default model"
              value={isLoading ? "…" : `${defaultModelSessions}`}
              sub={selectionShare(defaultModelSessions, defaultModelSessions, manualModelSessions)}
              tone="amber"
            />
            <StatCard
              icon={<MousePointerClick className="h-5 w-5 text-[#6F3DFF]" />}
              title="Manually selected"
              value={isLoading ? "…" : `${manualModelSessions}`}
              sub={selectionShare(manualModelSessions, defaultModelSessions, manualModelSessions)}
              tone="violet"
            />
          </div>
        </div>
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
