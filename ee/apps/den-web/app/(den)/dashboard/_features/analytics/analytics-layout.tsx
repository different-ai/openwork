"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowUpRight, BarChart3, Blocks, CloudOff, Sparkles, ScrollText, type LucideIcon } from "lucide-react";
import { DenButton } from "../../../_components/ui/button";
import { getAnalyticsRoute, getModelsAnalyticsRoute, getLibraryUsageRoute, getWorkflowRunsRoute } from "../../../_lib/den-org";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { useDenFlow } from "../../../_providers/den-flow-provider";
import { useLibraryUsageAvailable } from "../library-usage/use-library-usage";

export const analyticsSurfaceClass = "rounded-2xl border border-[#e3e7ee] bg-white";
export const analyticsPageClass = "mx-auto grid w-full max-w-[1160px] gap-6 px-4 pb-12 pt-5 sm:px-6 lg:px-8";

/**
 * The header every Analytics view shares: the title (the tab already says what
 * the page is, so no description, DESIGN.md P2), one short state line, and the
 * tab strip. The state line always takes its height so the tabs never move
 * between views.
 */
export function AnalyticsPageHeader({ orgSlug, active, title, action, caption }: {
  orgSlug?: string | null; active: "adoption" | "models" | "library" | "workflows";
  title: string; action?: ReactNode; caption?: ReactNode;
}) {
  const { runtimeConfig } = useDenFlow();
  const { orgContext } = useOrgDashboard();
  const libraryUsage = useLibraryUsageAvailable();
  const pages = [
    { id: "adoption", label: "Usage & adoption", href: getAnalyticsRoute(orgSlug), icon: BarChart3 },
    ...(runtimeConfig.orgMode === "single_org" ? [] : [{ id: "models", label: "Models & usage", href: getModelsAnalyticsRoute(orgSlug), icon: Sparkles }]),
    ...(libraryUsage ? [{ id: "library", label: "Plugins & connectors", href: getLibraryUsageRoute(orgSlug), icon: Blocks }] : []),
    ...(orgContext?.capabilities.workflows && orgContext.entitlements.analytics ? [{ id: "workflows", label: "Workflow Runs", href: getWorkflowRunsRoute(orgSlug), icon: ScrollText }] : []),
  ];
  return <header className="grid gap-5">
    <p className="text-xs font-medium text-[#637291]">Analytics</p>
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="max-w-2xl">
        <h1 className="text-[28px] font-semibold tracking-[-0.04em] text-[#07192C]">{title}</h1>
        <div className="mt-2 min-h-4 text-xs leading-4 text-[#637291]">{caption}</div>
      </div>
      {action}
    </div>
    <nav aria-label="Analytics views" className="flex flex-wrap gap-x-6 border-b border-[#e3e7ee]">
      {pages.map(({ id, label, href, icon: Icon }) => <Link key={id} href={href} aria-current={active === id ? "page" : undefined}
        className={`-mb-px inline-flex items-center gap-2 border-b-2 pb-3 text-sm font-medium transition-colors focus-visible:outline-offset-4 ${active === id ? "border-[#6F3DFF] text-[#6F3DFF]" : "border-transparent text-[#637291] hover:text-[#07192C]"}`}>
        <Icon className="h-4 w-4" aria-hidden="true" />{label}
      </Link>)}
    </nav>
  </header>;
}

export function AnalyticsEmptyState({ title, children, action, icon: Icon = BarChart3, testId }: {
  title: string; children: ReactNode; action?: ReactNode; icon?: LucideIcon; testId?: string;
}) {
  return <div className="flex min-h-56 flex-col items-center justify-center px-6 py-10 text-center" data-testid={testId}>
    <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-2xl border border-[#e7dfff] bg-[#f6f2ff] text-[#6F3DFF]"><Icon className="h-5 w-5" aria-hidden="true" /></div>
    <h3 className="text-sm font-semibold text-[#07192C]">{title}</h3>
    <div className="mt-2 max-w-md text-sm leading-6 text-[#637291]">{children}</div>
    {action ? <div className="mt-4">{action}</div> : null}
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
  return <Link href={getAnalyticsRoute(orgSlug)} className="inline-flex items-center gap-1 text-sm font-medium text-[#6F3DFF] hover:underline">
    View usage &amp; adoption<ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
  </Link>;
}
