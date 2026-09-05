"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { SetupFrame } from "../../_components/setup-frame";
import { applyRestrictedSetup } from "../../_lib/restricted-setup";
import { getOnboardingPeopleRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

/** Resume previously issued setup links without exposing the settings editor. */
export function RestrictedOnboardingScreen({ desktopPolicyId }: { desktopPolicyId: string }) {
  const { orgId, orgSlug } = useOrgDashboard();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!orgId) return;
    let active = true;
    setError(null);
    void applyRestrictedSetup(orgId, desktopPolicyId).then(() => {
      if (active) router.replace(getOnboardingPeopleRoute(orgSlug));
    }).catch((failure) => {
      if (active) setError(failure instanceof Error ? failure.message : "We couldn’t finish setup. Try again.");
    });
    return () => { active = false; };
  }, [orgId, orgSlug, desktopPolicyId, router, attempt]);
  return <SetupFrame step="space" title="Getting your team ready." description="We’re applying your team’s settings. Next, invite your people and get the app." embedded>
    {error ? <div className="space-y-5"><p role="alert" className="text-sm leading-6 text-neutral-600">{error}</p><button type="button" onClick={() => setAttempt((value) => value + 1)} className="rounded-xl bg-neutral-950 px-5 py-3 text-sm font-medium text-white">Try again</button></div>
      : <p role="status" className="text-sm text-neutral-500">Setting up Restricted…</p>}
  </SetupFrame>;
}
