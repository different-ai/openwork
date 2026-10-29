"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowUpRight, BarChart3, Blocks, ScrollText } from "lucide-react";
import { DenButton } from "../../../_components/ui/button";
import { underlineTabClassName } from "../../../_components/ui/tabs";
import { DenPageHeader } from "../../../_components/ui/page-header";
import { DenSkeleton } from "../../../_components/ui/skeleton";
import { ItemPanel, ItemRowsSkeleton } from "../../_components/item-list";
import { getAnalyticsRoute, getLibraryUsageRoute, getWorkflowRunsRoute } from "../../../_lib/den-org";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { useLibraryUsageAvailable } from "../library-usage/use-library-usage";

export const analyticsSurfaceClass = "analytics-surface rounded-2xl border border-[#e3e7ee] bg-white";
/** Same content inset as DashboardPageTemplate; header ownership stays separate. */
export const analyticsPageClass = "mx-auto grid w-full max-w-[860px] gap-6 p-4 sm:p-6 md:p-8 [&_.analytics-surface]:border-[var(--dls-border)] [&_.analytics-surface]:bg-[var(--dls-surface)]";

/**
 * The header every Analytics view shares: the title (the tab already says what
 * the page is, so no description, DESIGN.md P2), one short line for state only
 * (for example when counting started), and the
 * tab strip. The state line always takes its height so the tabs never move
 * between views.
 */
export function AnalyticsPageHeader({ orgSlug, active, title, action, caption }: {
  orgSlug?: string | null; active: "adoption" | "library" | "workflows";
  title: string; action?: ReactNode; caption?: ReactNode;
}) {
  const { orgContext } = useOrgDashboard();
  const libraryUsage = useLibraryUsageAvailable();
  const pages = [
    { id: "adoption", label: "Usage & adoption", href: getAnalyticsRoute(orgSlug), icon: BarChart3 },
    ...(libraryUsage ? [{ id: "library", label: "Plugins & connectors", href: getLibraryUsageRoute(orgSlug), icon: Blocks }] : []),
    ...(orgContext?.capabilities.workflows && orgContext.entitlements.analytics ? [{ id: "workflows", label: "Workflow Runs", href: getWorkflowRunsRoute(orgSlug), icon: ScrollText }] : []),
  ];
  return <header className="grid gap-5">
    <p className="text-xs font-medium text-[#637291]">Analytics</p>
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="max-w-2xl">
        <div data-dashboard-flat-header>
          <DenPageHeader title={title} size="compact" className="break-words" />
        </div>
        <div className="mt-2 min-h-4 text-xs leading-4 text-[#637291]">{caption}</div>
      </div>
      {action}
    </div>
    <nav aria-label="Analytics views" className="flex flex-wrap gap-x-6 border-b border-[#e3e7ee]">
      {pages.map(({ id, label, href, icon: Icon }) => <Link key={id} href={href} aria-current={active === id ? "page" : undefined}
        className={`-mb-px focus-visible:outline-offset-4 ${underlineTabClassName(active === id)}`}>
        <Icon className="h-4 w-4" aria-hidden="true" />{label}
      </Link>)}
    </nav>
  </header>;
}

export function AnalyticsEmptyState({ title, children, action, testId }: {
  title: string; children?: ReactNode; action?: ReactNode; testId?: string;
}) {
  return <div className="flex min-h-56 flex-col items-center justify-center px-6 py-10 text-center" data-testid={testId}>
    <h3 className="text-sm font-semibold text-[#07192C]">{title}</h3>
    {children ? <div className="mt-2 max-w-md text-sm leading-6 text-[#637291]">{children}</div> : null}
    {action ? <div className="mt-4">{action}</div> : null}
  </div>;
}

export function AnalyticsLoading({ label }: { label: string }) {
  return <div role="status" aria-label={label} className="grid gap-6">
    <div aria-hidden className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
      {[0, 1, 2, 3].map((index) => <div key={index} className="rounded-2xl border border-[var(--dls-border)] bg-[var(--dls-surface)] p-5">
        <DenSkeleton className="h-4 w-24" /><DenSkeleton className="mt-3 h-8 w-16" /><DenSkeleton className="mt-2 h-4 w-32" />
      </div>)}
    </div>
    <ItemPanel><ItemRowsSkeleton label={label} rows={4} /></ItemPanel>
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
