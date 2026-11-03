"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { EnterprisePlanNotice } from "../../_components/enterprise-plan-notice";
import { ModelUsageList } from "./model-usage-list";
import { ProjectFilter } from "./project-filter";
import { StatCard } from "./stat-card";
import { TrendChart } from "./trend-chart";
import { useAnalytics, useProjectOptions } from "./use-analytics";
import { AnalyticsEmptyState, AnalyticsErrorState, AnalyticsLoading, AnalyticsPageHeader, analyticsPageClass, analyticsSurfaceClass } from "./analytics-layout";
import { getMembersRoute } from "../../../_lib/den-org";
import { DenButton } from "../../../_components/ui/button";
import { DenNotice } from "../../../_components/ui/notice";
import { DenSegmented } from "../../../_components/ui/segmented";

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

type Granularity = "day" | "week";

const granularityOptions = [
  { value: "day", label: "Daily" },
  { value: "week", label: "Weekly" },
] as const;

const trendCopy = {
  day: {
    range: "Last 30 days · UTC",
    period: "last 30 days",
    interval: "",
    activeTitle: "Daily active users",
    sessionsTitle: "Sessions per day",
    tasksTitle: "Tasks per day",
  },
  week: {
    range: "Trends over 12 weeks",
    period: "last 12 weeks",
    interval: "Week of",
    activeTitle: "Weekly active users",
    sessionsTitle: "Sessions per week",
    tasksTitle: "Tasks per week",
  },
} as const;

/* ── Main screen ── */

export function AnalyticsScreen() {
  const { activeOrg, orgContext } = useOrgDashboard();
  const [projectValue, setProjectValue] = useState("");
  const [granularity, setGranularity] = useState<Granularity>("day");

  // Server enforces the same gate with a 402 on /v1/telemetry/analytics
  // (entitlements.ts); this mirrors the SSO / desktop policies screens.
  const locked = Boolean(orgContext) && !orgContext?.entitlements.analytics;

  const projectOptions = useProjectOptions(!locked);
  const { data, isLoading, isFetching, isError, refetch } = useAnalytics(!locked, projectValue);

  const projectScoped = projectValue.length > 0;
  // A workspace nobody has used yet gets one clear empty state, not a page of zeros.
  const noActivity = Boolean(data) && !projectScoped && !isError
    && (data?.activeMembers30d ?? 0) === 0 && (data?.sessions30d ?? 0) === 0
    && (data?.tasksCompleted30d ?? 0) + (data?.tasksFailed30d ?? 0) === 0
    && (data?.weekly ?? []).every((week) => week.activeMembers === 0 && week.sessions === 0);
  const weekly = data?.weekly ?? [];
  // Older servers may not return daily trends; keep their weekly data usable.
  const dailyAvailable = Array.isArray(data?.daily);
  const activeGranularity: Granularity = dailyAvailable ? granularity : "week";
  const trend = activeGranularity === "day"
    ? (data?.daily ?? []).map((d) => ({ ...d, weekStart: d.day }))
    : weekly;
  const copy = trendCopy[activeGranularity];
  const tasks7d = (data?.tasksCompleted7d ?? 0) + (data?.tasksFailed7d ?? 0);
  const modelUsage = data?.models.usage30d ?? [];
  const defaultModelSessions = data?.models.selection30d.default ?? 0;
  const manualModelSessions = data?.models.selection30d.manual ?? 0;

  return (
    <div className={analyticsPageClass}>
      <AnalyticsPageHeader orgSlug={activeOrg?.slug} active="adoption"
        title="Usage & adoption"
        action={!locked && !isError ? <DenButton variant="secondary" disabled={isFetching} onClick={() => void refetch()}><RefreshCw className={`mr-2 h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} aria-hidden="true" />Refresh analytics</DenButton> : null} />

      {locked ? (
        <EnterprisePlanNotice feature="Usage analytics" detail="Team usage is unavailable on this plan." />
      ) : isError && !data ? <AnalyticsErrorState title="Couldn't load analytics" onRetry={() => void refetch()} retrying={isFetching} />
      : isLoading ? <AnalyticsLoading label="Loading analytics" /> : noActivity ? (
        <div className={analyticsSurfaceClass} data-testid="analytics-no-activity">
          <AnalyticsEmptyState title="No activity yet"
            action={<DenButton variant="secondary" href={getMembersRoute(activeOrg?.slug)}>Invite your team</DenButton>}>
            Usage appears here once members sign in to the OpenWork app and run their first task. It never includes prompts, code, or file contents.
          </AnalyticsEmptyState>
        </div>
      ) : (
      <>
      {isError ? <DenNotice tone="neutral" presentation="inline" message="Could not refresh analytics. Showing the last available data." action={<DenButton variant="secondary" size="sm" disabled={isFetching} onClick={() => void refetch()}>Retry</DenButton>} /> : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
      <ProjectFilter options={projectOptions} value={projectValue} onValueChange={setProjectValue} />
      <div className="flex items-center gap-3">
        <span className="text-xs text-[#637291]">{copy.range}</span>
        {dailyAvailable ? (
          <DenSegmented aria-label="Trend interval" value={granularity} onChange={setGranularity} options={granularityOptions} optionTestId={(value) => `analytics-granularity-${value}`} />
        ) : null}
      </div>
      </div>

      {/* Summary cards */}
      <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="OpenWork users"
          value={isLoading ? "…" : `${data?.members ?? 0}`}
          sub={projectScoped ? "Org total, not project-scoped" : `${data?.pendingInvites ?? 0} pending invites`}
        />
        <StatCard
          title="Active this week"
          value={isLoading ? "…" : `${data?.activeMembers7d ?? 0}`}
          sub={`${data?.activeMembers30d ?? 0} active in last 30 days`}
        />
        <StatCard
          title="Sessions this week"
          value={isLoading ? "…" : `${data?.sessions7d ?? 0}`}
          sub={`${data?.sessions30d ?? 0} in last 30 days`}
        />
        <StatCard
          title="Tasks this week"
          value={isLoading ? "…" : `${tasks7d}`}
          sub={`${successRate(data?.tasksCompleted7d ?? 0, data?.tasksFailed7d ?? 0)} success rate`}
        />
      </div>

      {/* Trend charts */}
      <div className="grid gap-3.5 lg:grid-cols-2">
        <TrendChart isLoading={isLoading}
          title={copy.activeTitle}
          subtitle={projectScoped ? `Members with project-matched events, ${copy.period}` : `Members with at least one event, ${copy.period}`}
          intervalLabel={copy.interval}
          weeks={trend}
          series={[{ label: "Active users", values: trend.map((w) => w.activeMembers) }]}
        />
        <TrendChart isLoading={isLoading}
          title={copy.sessionsTitle}
          subtitle={`Distinct sessions, ${copy.period}`}
          intervalLabel={copy.interval}
          weeks={trend}
          series={[{ label: "Sessions", values: trend.map((w) => w.sessions) }]}
        />
      </div>

      <div>
        <TrendChart isLoading={isLoading}
          title={copy.tasksTitle}
          subtitle={`Completed and failed task runs, ${copy.period}`}
          intervalLabel={copy.interval}
          weeks={trend}
          series={[
            { label: "Completed", values: trend.map((w) => w.tasksCompleted) },
            { label: "Failed", values: trend.map((w) => w.tasksFailed) },
          ]}
        />
      </div>

      {/* Model usage */}
      <div>
        <h2 className="text-[16px] font-semibold tracking-[-0.02em] text-[#07192C]">Models</h2>
        <div className="mt-3 grid gap-3.5 lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
          <ModelUsageList models={modelUsage} isLoading={isLoading} />
          <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-1">
            <StatCard
              title="Default model"
              value={isLoading ? "…" : `${defaultModelSessions}`}
              sub={selectionShare(defaultModelSessions, defaultModelSessions, manualModelSessions)}
            />
            <StatCard
              title="Manually selected"
              value={isLoading ? "…" : `${manualModelSessions}`}
              sub={selectionShare(manualModelSessions, defaultModelSessions, manualModelSessions)}
            />
          </div>
        </div>
      </div>

      {/* 30-day detail */}
      <div className="grid gap-3.5 sm:grid-cols-3">
        <StatCard
          title="Avg task duration"
          value={isLoading ? "…" : formatDuration(data?.avgTaskDurationMs30d ?? null)}
          sub="Completed tasks, last 30 days"
        />
        <StatCard
          title="Tasks completed"
          value={isLoading ? "…" : `${data?.tasksCompleted30d ?? 0}`}
          sub="Last 30 days"
        />
        <StatCard
          title="Tasks failed"
          attention={(data?.tasksFailed30d ?? 0) > 0}
          value={isLoading ? "…" : `${data?.tasksFailed30d ?? 0}`}
          sub={`${successRate(data?.tasksCompleted30d ?? 0, data?.tasksFailed30d ?? 0)} success rate over 30 days`}
        />
      </div>

      {/* Privacy note */}
      <p className="border-t border-[#e3e7ee] pt-4 text-xs leading-5 text-[#637291]">
        Telemetry never includes prompt contents, code, file contents, diffs, secrets, or terminal output.
        Usage data appears here once members sign in to the OpenWork app and start running tasks.
      </p>
      </>
      )}
    </div>
  );
}
