"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowUpRight, BarChart3, Blocks, CloudOff, Sparkles, ScrollText, type LucideIcon } from "lucide-react";
import { DenButton } from "../../../_components/ui/button";
import { underlineTabClassName } from "../../../_components/ui/tabs";
import { DenPageHeader } from "../../../_components/ui/page-header";
import { DenSkeleton } from "../../../_components/ui/skeleton";
import { ItemPanel, ItemRowsSkeleton } from "../../_components/item-list";
import { getAnalyticsRoute, getModelsAnalyticsRoute, getLibraryUsageRoute, getWorkflowRunsRoute, orgFeatureEnabled } from "../../../_lib/den-org";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { useDenFlow } from "../../../_providers/den-flow-provider";
import { useLibraryUsageAvailable } from "../library-usage/use-library-usage";

export const analyticsSurfaceClass = "analytics-surface rounded-2xl border border-[#e3e7ee] bg-white";

/** Presentation only: killing this rollout restores the original views and data. */
export function useAnalyticsIntegrated() {
  const { orgContext } = useOrgDashboard();
  return orgFeatureEnabled(orgContext, "analyticsIntegrated");
}
export const analyticsPageClass = "mx-auto grid w-full max-w-[1160px] gap-6 px-4 pb-12 pt-5 sm:px-6 lg:px-8";
/** Same content inset as DashboardPageTemplate; header ownership stays separate. */
export const analyticsIntegratedPageClass = "mx-auto grid w-full max-w-[860px] gap-6 p-4 sm:p-6 md:p-8 [&_.analytics-surface]:border-[var(--dls-border)] [&_.analytics-surface]:bg-[var(--dls-surface)]";

/**
 * The header every Analytics view shares: the title (the tab already says what
 * the page is, so no description, DESIGN.md P2), one short line for state only
 * (for example when counting started), and the
 * tab strip. The state line always takes its height so the tabs never move
 * between views.
 */
export function AnalyticsPageHeader({ orgSlug, active, title, action, caption }: {
  orgSlug?: string | null; active: "adoption" | "models" | "library" | "workflows";
  title: string; action?: ReactNode; caption?: ReactNode;
}) {
  const { runtimeConfig } = useDenFlow();
  const { orgContext } = useOrgDashboard();
  const flatHeader = orgFeatureEnabled(orgContext, "denFlatPageHeaders");
  const integrated = useAnalyticsIntegrated();
  const libraryUsage = useLibraryUsageAvailable();
  const pages = [
    { id: "adoption", label: "Usage & adoption", href: getAnalyticsRoute(orgSlug), icon: BarChart3 },
    ...(runtimeConfig.orgMode === "single_org" ? [] : [{ id: "models", label: "Models & usage", href: getModelsAnalyticsRoute(orgSlug), icon: Sparkles }]),
    ...(libraryUsage ? [{ id: "library", label: "Plugins & connectors", href: getLibraryUsageRoute(orgSlug), icon: Blocks }] : []),
    ...(orgContext?.capabilities.workflows && orgContext.entitlements.analytics ? [{ id: "workflows", label: "Workflow Runs", href: getWorkflowRunsRoute(orgSlug), icon: ScrollText }] : []),
  ];
  return <header className="grid gap-5" data-analytics-integrated={integrated}>
    <p className="text-xs font-medium text-[#637291]">Analytics</p>
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="max-w-2xl">
        {flatHeader ? (
          <div data-dashboard-flat-header>
            <DenPageHeader title={title} size="compact" className="break-words" />
          </div>
        ) : (
          <h1 className="text-[22px] font-semibold tracking-[-0.03em] text-[#07192C]">{title}</h1>
        )}
        <div className="mt-2 min-h-4 text-xs leading-4 text-[#637291]">{caption}</div>
      </div>
      {action}
    </div>
    <nav aria-label="Analytics views" className="flex flex-wrap gap-x-6 border-b border-[#e3e7ee]">
      {pages.map(({ id, label, href, icon: Icon }) => <Link key={id} href={href} aria-current={active === id ? "page" : undefined}
        className={integrated ? `-mb-px focus-visible:outline-offset-4 ${underlineTabClassName(active === id)}` : `-mb-px inline-flex items-center gap-2 border-b-2 pb-3 text-sm font-medium transition-colors focus-visible:outline-offset-4 ${active === id ? "border-[#6F3DFF] text-[#6F3DFF]" : "border-transparent text-[#637291] hover:text-[#07192C]"}`}>
        {integrated && id === "models" ? <img src="/openwork-mark.svg" alt="" aria-hidden className="size-4" /> : <Icon className="h-4 w-4" aria-hidden="true" />}{label}
      </Link>)}
    </nav>
  </header>;
}

export function AnalyticsEmptyState({ title, children, action, icon: Icon = BarChart3, testId }: {
  title: string; children: ReactNode; action?: ReactNode; icon?: LucideIcon; testId?: string;
}) {
  const integrated = useAnalyticsIntegrated();
  return <div className="flex min-h-56 flex-col items-center justify-center px-6 py-10 text-center" data-testid={testId}>
    {integrated ? null : <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-2xl border border-[#e7dfff] bg-[#f6f2ff] text-[#6F3DFF]"><Icon className="h-5 w-5" aria-hidden="true" /></div>}
    <h3 className="text-sm font-semibold text-[#07192C]">{title}</h3>
    <div className="mt-2 max-w-md text-sm leading-6 text-[#637291]">{children}</div>
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
    <AnalyticsEmptyState title={title} icon={CloudOff}
      action={<DenButton variant="secondary" onClick={onRetry} disabled={retrying}>{retrying ? "Trying again…" : "Try again"}</DenButton>}>
      Your data is safe. This is usually a short connection problem.
    </AnalyticsEmptyState>
  </div>;
}

export function AnalyticsAdoptionLink({ orgSlug }: { orgSlug?: string | null }) {
  const integrated = useAnalyticsIntegrated();
  return <Link href={getAnalyticsRoute(orgSlug)} className={`inline-flex items-center gap-1 text-sm font-medium hover:underline ${integrated ? "text-[var(--dls-text-primary)]" : "text-[#6F3DFF]"}`}>
    View usage &amp; adoption<ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
  </Link>;
}
