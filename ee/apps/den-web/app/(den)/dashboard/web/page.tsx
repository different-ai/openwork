"use client";

import { ExternalLink, Globe, Loader2 } from "lucide-react";
import { notFound } from "next/navigation";

import { useDenFlow } from "../../_providers/den-flow-provider";
import { DenButton } from "../../_components/ui/button";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

export type WebPageAccessState = "checking" | "not-found" | "ready";

export function getWebPageAccessState({
  orgBusy,
  hasOrgContext,
  cloudEnabled,
  runtimeConfigLoaded,
}: {
  orgBusy: boolean;
  hasOrgContext: boolean;
  cloudEnabled: boolean;
  runtimeConfigLoaded: boolean;
}): WebPageAccessState {
  if (orgBusy || !hasOrgContext || !runtimeConfigLoaded) {
    return "checking";
  }

  return cloudEnabled ? "ready" : "not-found";
}

function CheckingWorkspaceAccess() {
  return (
    <div className="flex min-h-[420px] items-center justify-center px-6" data-testid="web-access-state" data-access-state="checking">
      <div className="w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-6 shadow-[0_12px_40px_-28px_rgba(15,23,42,0.35)]">
        <div className="flex items-start gap-4">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-gray-100 text-gray-600">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          </div>
          <div>
            <p className="text-[15px] font-medium text-gray-950">Checking workspace access</p>
            <p className="mt-1 text-[13px] leading-5 text-gray-500">We’re confirming which settings are available to your account.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

export function WebOpenButton({ openworkWebUrl }: { openworkWebUrl: string }) {
  return (
    <DenButton href={openworkWebUrl} target="_blank" rel="noopener noreferrer" icon={ExternalLink}>
      Open OpenWork Web
    </DenButton>
  );
}

export default function WebPage() {
  const { orgContext, orgBusy } = useOrgDashboard();
  const { runtimeConfig, runtimeConfigLoaded } = useDenFlow();
  const accessState = getWebPageAccessState({
    orgBusy,
    hasOrgContext: Boolean(orgContext),
    cloudEnabled: orgContext?.capabilities.cloud === true,
    runtimeConfigLoaded,
  });

  if (accessState === "checking") {
    return <CheckingWorkspaceAccess />;
  }

  if (accessState === "not-found") {
    notFound();
  }

  return (
    <DashboardPageTemplate
      icon={Globe}
      badgeLabel="Alpha"
      title="Web"
      description="Open OpenWork in your browser."
      colors={["#EFF6FF", "#0F172A", "#2563EB", "#BAE6FD"]}
    >
      <section className="rounded-3xl border border-gray-100 bg-white p-6 shadow-[0_18px_45px_-35px_rgba(15,23,42,0.35)]">
        <p className="mb-5 text-[14px] leading-6 text-gray-500">This opens OpenWork in a new browser tab.</p>
        <WebOpenButton openworkWebUrl={runtimeConfig.openworkWebUrl} />
      </section>
    </DashboardPageTemplate>
  );
}
