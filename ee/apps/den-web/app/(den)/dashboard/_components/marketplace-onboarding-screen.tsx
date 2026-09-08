"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Check, ArrowUpRight, ArrowRight } from "lucide-react";
import { DenBadge } from "../../_components/ui/badge";
import { DesktopHandoffAction } from "../../_components/auth-panel";
import { SetupFrame } from "../../_components/setup-frame";
import { getCustomLlmProvidersRoute, getInferenceRoute, getOrgDashboardRoute } from "../../_lib/den-org";
import { normalizeAuthIntentParam, PENDING_AUTH_INTENT_STORAGE_KEY } from "../../_lib/den-flow";
import { freeAllowanceDescription } from "../../_lib/inference-status";
import { useInferenceAccess } from "../../_lib/use-inference-access";
import { getDesktopGrant } from "../../_lib/desktop-handoff";
import { useDenFlow } from "../../_providers/den-flow-provider";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

export function MarketplaceOnboardingScreen() {
  const router = useRouter();
  const { orgId, orgSlug, activeOrg } = useOrgDashboard();
  const { desktopAuthRequested, desktopRedirectUrl, authError, completeSetup } = useDenFlow();
  const [completing, setCompleting] = useState(false);
  const modelsHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (desktopAuthRequested && normalizeAuthIntentParam(window.sessionStorage.getItem(PENDING_AUTH_INTENT_STORAGE_KEY)) === "models") {
      modelsHeading.current?.focus();
    }
  }, [desktopAuthRequested]);
  const { data: modelAccess = null, isPending: modelsLoading, error: modelsError } = useInferenceAccess(orgId);
  const modelsEnabled = modelAccess?.kind === "paid";
  const allowance = freeAllowanceDescription(modelAccess);

  async function finish() {
    if (!orgId || completing) return;
    setCompleting(true);
    try {
      if (await completeSetup(orgId) && !desktopAuthRequested) router.push(getOrgDashboardRoute(orgSlug));
    } finally {
      setCompleting(false);
    }
  }

  return (
    <SetupFrame step="ready" title="You're ready to get to work." description="Explore models hosted by OpenWork, without managing API keys.">
      <div className="grid gap-6" data-testid="marketplace-onboarding">
        <section aria-labelledby="setup-models-heading" className="grid gap-4">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-neutral-400">Hosted by OpenWork</p>
            <h2 id="setup-models-heading" ref={modelsHeading} tabIndex={-1} className="mt-2 text-xl font-semibold tracking-[-0.03em]">{modelAccess?.kind === "free" ? "Start with Luna." : "OpenWork Models"}</h2>
            <p className="mt-2 text-sm leading-6 text-[var(--dls-text-secondary)]" role="status">
              {modelsLoading ? "Checking OpenWork Models..." : modelsError || !modelAccess ? "Model status is unavailable. You can still complete setup." : allowance ?? (modelsEnabled ? "OpenWork Models are on for this workspace." : "Keep your existing provider, or choose one when you are ready.")}
            </p>
            {modelsEnabled ? <DenBadge icon={Check}>Models on</DenBadge> : null}
            {modelAccess?.kind === "free" ? <DenBadge icon={Check}>Free Luna included</DenBadge> : null}
          </div>
          <div className="overflow-hidden rounded-2xl border border-[var(--dls-border)]">
            <div className="flex items-start gap-3 p-4 sm:p-5" data-testid="onboarding-choice-openwork-models">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-[var(--dls-hover)]">
                <img src="/openwork-mark.svg" alt="" aria-hidden className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold">OpenWork Models</h3>
                <p className="mt-1 text-[13px] leading-5 text-[var(--dls-text-secondary)]">{allowance ? "Standard Luna with a free weekly allowance. Upgrade for other managed models." : "Managed models, billed per member. No API keys to look after."}</p>
                <Link href={getInferenceRoute(orgSlug)} className="mt-3 inline-flex items-center gap-1.5 rounded-sm text-sm font-medium underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-neutral-950">
                  {modelsEnabled ? "Manage models" : "Explore models"}<ArrowUpRight className="size-3.5" aria-hidden />
                </Link>
              </div>
            </div>
          </div>
        </section>
        <section aria-labelledby="setup-finish-heading" className="grid gap-4 border-t border-[var(--dls-border)] pt-6" data-testid="onboarding-finish">
          <div>
            <h2 id="setup-finish-heading" className="text-base font-semibold tracking-tight">Your workspace is ready</h2>
            <p className="mt-2 text-sm leading-6 text-[var(--dls-text-secondary)]">No model selection is required to complete setup.</p>
          </div>
          {authError ? <p role="alert" className="text-sm text-rose-600">{authError}</p> : null}
          {desktopRedirectUrl ? <DesktopHandoffAction openworkUrl={desktopRedirectUrl} grant={getDesktopGrant(desktopRedirectUrl)} organizationName={activeOrg?.name ?? null} showCopyLinkByDefault /> : (
            <button type="button" onClick={() => void finish()} disabled={!orgId || completing} className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-neutral-950 px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-neutral-800 disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-neutral-950 focus-visible:ring-offset-2">
              {completing ? "Completing..." : desktopAuthRequested ? "Complete and open the app" : "Complete setup"}<ArrowRight className="size-4" aria-hidden />
            </button>
          )}
          <Link data-testid="onboarding-choice-byok" href={getCustomLlmProvidersRoute(orgSlug)} className="w-fit rounded-sm text-xs text-[var(--dls-text-secondary)] underline-offset-4 hover:text-[var(--dls-text-primary)] hover:underline focus-visible:ring-2 focus-visible:ring-neutral-950">
            Use my own provider…
          </Link>
        </section>
      </div>
    </SetupFrame>
  );
}
