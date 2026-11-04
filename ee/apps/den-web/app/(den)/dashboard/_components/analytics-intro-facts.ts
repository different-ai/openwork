import type { TelemetryAnalyticsResponse } from "@openwork-ee/telemetry-contracts";
import type { AnalyticsFacts, AnalyticsLibraryView } from "../_features/feature-intros/intros/analytics";
import type { LibraryUsageReport } from "../_features/library-usage/library-usage-data";

type AnalyticsActivity = Pick<TelemetryAnalyticsResponse,
  "activeMembers30d" | "sessions30d" | "tasksCompleted30d" | "tasksFailed30d" | "weekly">;

/** Anyone active, any session or any task in the last 30 days (the Usage & adoption "No activity yet" rule). */
export function analyticsHasActivity(data: AnalyticsActivity): boolean {
  return data.activeMembers30d > 0 || data.sessions30d > 0
    || data.tasksCompleted30d + data.tasksFailed30d > 0
    || data.weekly.some((week) => week.activeMembers > 0 || week.sessions > 0);
}

/**
 * Facts for Usage & adoption. Null until known: the plan is read from the org,
 * activity from the unfiltered analytics. A project filter only shows once
 * there is activity, so a filtered view counts as active.
 */
export function analyticsUsageIntroFacts(input: {
  included: boolean | null;
  data: (AnalyticsActivity & Pick<TelemetryAnalyticsResponse, "members" | "pendingInvites">) | undefined;
  projectScoped: boolean;
}): AnalyticsFacts | null {
  if (input.included === null) return null;
  if (!input.included) return { page: "usage", included: false };
  if (!input.data) return null;
  return {
    page: "usage",
    included: true,
    activity: input.projectScoped || analyticsHasActivity(input.data),
    members: input.data.members,
    pendingInvites: input.data.pendingInvites,
  };
}

/** Facts for Plugins & connectors, for the view on screen. Null until its report has loaded. */
export function libraryUsageIntroFacts(kind: AnalyticsLibraryView, report: Pick<LibraryUsageReport, "kind" | "trackingSince" | "items"> | undefined): AnalyticsFacts | null {
  if (!report || report.kind !== kind) return null;
  return {
    page: "library",
    libraryView: kind,
    libraryItems: report.items.length,
    // Same rule as the page's "No usage yet": nothing recorded since counting started.
    libraryUsageRecorded: Boolean(report.trackingSince) || report.items.some((row) => row.uses > 0),
  };
}

/** Facts for Workflow runs. Null until the list has loaded. */
export function workflowRunsIntroFacts(runs: readonly unknown[] | undefined): AnalyticsFacts | null {
  if (!runs) return null;
  return { page: "workflow-runs", workflowRuns: runs.length };
}
