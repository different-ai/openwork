"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowUpRight, BarChart3, Blocks, Bot, ScrollText } from "lucide-react";
import { DenButton } from "../../../_components/ui/button";
import { UnseenDot, underlineTabClassName } from "../../../_components/ui/tabs";
import { DenPageHeader } from "../../../_components/ui/page-header";
import { AUTOMATION_CARD_CLASS, CARD_TITLE_CLASS, DASHBOARD_PAGE_CLASS } from "../../../_components/ui/dashboard-styles";
import { DenSkeleton } from "../../../_components/ui/skeleton";
import { RowListSkeleton } from "../computers/computer-rows";
import { getAnalyticsRoute, getLibraryUsageRoute, getWorkbotUsageRoute, getWorkflowRunsRoute, orgFeatureEnabled } from "../../../_lib/den-org";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { useLibraryUsageAvailable } from "../library-usage/use-library-usage";
import { useFeatureIntroUnseen, type FeatureIntroKey } from "../feature-intros";

type AnalyticsView = "adoption" | "library" | "workbot" | "workflows";
type AnalyticsViewLink = { id: AnalyticsView; label: string; href: string; icon: typeof BarChart3 };

/** Each view's feature intro, for its quiet "not viewed yet" dot (DESIGN.md I9). Workbot has none. */
const ANALYTICS_VIEW_INTROS: Record<AnalyticsView, FeatureIntroKey | null> = {
  adoption: "analytics",
  library: "analytics.library",
  workbot: null,
  workflows: "analytics.workflow-runs",
};

export const analyticsSurfaceClass = `analytics-surface ${AUTOMATION_CARD_CLASS}`;
/** Same content inset as Computers; header ownership stays separate. */
export const analyticsPageClass = `${DASHBOARD_PAGE_CLASS} grid gap-6`;

/**
 * The header every Analytics view shares: the title (the tab already says what
 * the page is, so no description, DESIGN.md P2), one short line for state only
 * (for example when counting started), and the
 * tab strip. The state line always takes its height so the tabs never move
 * between views.
 */
export function AnalyticsPageHeader({ orgSlug, active, title, action, caption }: {
  orgSlug?: string | null; active: AnalyticsView;
  title: string; action?: ReactNode; caption?: ReactNode;
}) {
  const { orgContext } = useOrgDashboard();
  const libraryUsage = useLibraryUsageAvailable();
  const introUnseen = useFeatureIntroUnseen();
  const adoption: AnalyticsViewLink = { id: "adoption", label: "Usage & adoption", href: getAnalyticsRoute(orgSlug), icon: BarChart3 };
  const library: AnalyticsViewLink = { id: "library", label: "Plugins & connectors", href: getLibraryUsageRoute(orgSlug), icon: Blocks };
  // What Workbot spends on models, for the people who can see usage, where Workbot is available.
  const workbot: AnalyticsViewLink = { id: "workbot", label: "Workbot", href: getWorkbotUsageRoute(orgSlug), icon: Bot };
  const workflows: AnalyticsViewLink = { id: "workflows", label: "Workflow Runs", href: getWorkflowRunsRoute(orgSlug), icon: ScrollText };
  const pages = [
    adoption,
    ...(libraryUsage ? [library] : []),
    ...(libraryUsage && orgContext?.capabilities.workbot && orgFeatureEnabled(orgContext, "workbotUsageAnalytics") ? [workbot] : []),
    // Prototype: Workflow runs is no longer offered as a tab. It lists only the viewer's own runs, and each
    // workflow's page already has its runs. The address still works, and shows its tab only while you are on it.
    ...(active === "workflows" && orgContext?.capabilities.workflows && orgContext.entitlements.analytics ? [workflows] : []),
  ];
  return <header className="grid gap-6">
    <div data-dashboard-flat-header>
      {/* One page, one name: the heading is the section, and the tabs name its views. */}
      <DenPageHeader title="Analytics" size="compact" state={caption} action={action} className="break-words" />
      <span className="sr-only" data-analytics-view-title>{title}</span>
    </div>
    <nav aria-label="Analytics views" className="flex flex-wrap gap-x-6 border-b border-[var(--den-list-line)]">
      {pages.map(({ id, label, href, icon: Icon }) => <Link key={id} href={href} aria-current={active === id ? "page" : undefined}
        className={`-mb-px focus-visible:outline-offset-4 ${underlineTabClassName(active === id)}`}>
        <Icon className="h-4 w-4" aria-hidden="true" />{label}
        {active !== id && introUnseen(ANALYTICS_VIEW_INTROS[id]) ? <UnseenDot /> : null}
      </Link>)}
    </nav>
  </header>;
}

export function AnalyticsEmptyState({ title, children, action, testId }: {
  title: string; children?: ReactNode; action?: ReactNode; testId?: string;
}) {
  return <div className="flex min-h-56 flex-col items-center justify-center px-6 py-10 text-center" data-testid={testId}>
    <h3 className={CARD_TITLE_CLASS}>{title}</h3>
    {children ? <div className="mt-2 max-w-md text-sm leading-6 text-[var(--dls-text-secondary)]">{children}</div> : null}
    {action ? <div className="mt-4">{action}</div> : null}
  </div>;
}

export function AnalyticsLoading({ label }: { label: string }) {
  return <div role="status" aria-label={label} className="grid gap-6">
    <div aria-hidden className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
      {[0, 1, 2, 3].map((index) => <div key={index} className={`${AUTOMATION_CARD_CLASS} p-4`}>
        <DenSkeleton className="h-4 w-24" /><DenSkeleton className="mt-3 h-8 w-16" /><DenSkeleton className="mt-2 h-4 w-32" />
      </div>)}
    </div>
    <RowListSkeleton rows={4} />
  </div>;
}

/** The one way an Analytics view says it could not load: what happened, and one way to try again. */
export function AnalyticsErrorState({ title, onRetry, retrying = false }: { title: string; onRetry: () => void; retrying?: boolean }) {
  return <div className={analyticsSurfaceClass} role="alert">
    <AnalyticsEmptyState title={title}
      action={<DenButton variant="secondary" onClick={onRetry} disabled={retrying}>{retrying ? "Trying again…" : "Try again"}</DenButton>} />
  </div>;
}

export function AnalyticsAdoptionLink({ orgSlug }: { orgSlug?: string | null }) {
  return <Link href={getAnalyticsRoute(orgSlug)} className="inline-flex items-center gap-1 text-sm font-medium text-[var(--dls-text-primary)] hover:underline">
    View usage &amp; adoption<ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
  </Link>;
}
