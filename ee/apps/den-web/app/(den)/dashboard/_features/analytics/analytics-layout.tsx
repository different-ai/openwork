"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowUpRight, BarChart3, ChevronRight, Sparkles } from "lucide-react";
import { getAnalyticsRoute, getInferenceRoute } from "../../../_lib/den-org";
import { useDenFlow } from "../../../_providers/den-flow-provider";

export const analyticsSurfaceClass = "rounded-2xl border border-[#e3e7ee] bg-white";
export const analyticsPageClass = "mx-auto grid w-full max-w-[1160px] gap-6 px-4 pb-12 pt-5 sm:px-6 lg:px-8";

export function AnalyticsPageHeader({ orgName, orgSlug, active, title, description, action, caption }: {
  orgName: string; orgSlug?: string | null; active: "adoption" | "models";
  title: string; description: string; action?: ReactNode; caption?: ReactNode;
}) {
  const { runtimeConfig } = useDenFlow();
  const pages = [
    { id: "adoption", label: "Usage & adoption", href: getAnalyticsRoute(orgSlug), icon: BarChart3 },
    ...(runtimeConfig.orgMode === "single_org" ? [] : [{ id: "models", label: "Models & usage", href: getInferenceRoute(orgSlug), icon: Sparkles }]),
  ];
  return <header className="grid gap-5">
    <div className="flex items-center gap-2 text-xs text-[#637291]">
      <span className="truncate font-medium text-[#30405F]">{orgName}</span>
      <ChevronRight className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span>Analytics</span>
    </div>
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="max-w-2xl">
        <h1 className="text-[28px] font-semibold tracking-[-0.04em] text-[#07192C]">{title}</h1>
        <p className="mt-1.5 text-sm leading-6 text-[#637291]">{description}</p>
        {caption ? <div className="mt-2 text-xs text-[#637291]">{caption}</div> : null}
      </div>
      {action}
    </div>
    <nav aria-label="Analytics views" className="flex gap-6 border-b border-[#e3e7ee]">
      {pages.map(({ id, label, href, icon: Icon }) => <Link key={id} href={href} aria-current={active === id ? "page" : undefined}
        className={`-mb-px inline-flex items-center gap-2 border-b-2 pb-3 text-sm font-medium transition-colors focus-visible:outline-offset-4 ${active === id ? "border-[#6F3DFF] text-[#6F3DFF]" : "border-transparent text-[#637291] hover:text-[#07192C]"}`}>
        <Icon className="h-4 w-4" aria-hidden="true" />{label}
      </Link>)}
    </nav>
  </header>;
}

export function AnalyticsEmptyState({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="flex min-h-56 flex-col items-center justify-center px-6 py-10 text-center">
    <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-2xl border border-[#e7dfff] bg-[#f6f2ff] text-[#6F3DFF]"><BarChart3 className="h-5 w-5" aria-hidden="true" /></div>
    <h3 className="text-sm font-semibold text-[#07192C]">{title}</h3>
    <div className="mt-2 max-w-md text-sm leading-6 text-[#637291]">{children}</div>
    {action ? <div className="mt-4">{action}</div> : null}
  </div>;
}

export function AnalyticsAdoptionLink({ orgSlug }: { orgSlug?: string | null }) {
  return <Link href={getAnalyticsRoute(orgSlug)} className="inline-flex items-center gap-1 text-sm font-medium text-[#6F3DFF] hover:underline">
    View usage &amp; adoption<ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
  </Link>;
}
