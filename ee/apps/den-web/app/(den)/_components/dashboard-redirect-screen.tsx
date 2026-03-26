"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useDenFlow } from "../_providers/den-flow-provider";

export function DashboardRedirectScreen() {
  const router = useRouter();
  const { resolveUserLandingRoute, sessionHydrated } = useDenFlow();

  useEffect(() => {
    if (!sessionHydrated) {
      return;
    }

    void resolveUserLandingRoute().then((target) => {
      router.replace(target ?? "/");
    });
  }, [resolveUserLandingRoute, router, sessionHydrated]);

  return (
    <section className="mx-auto grid w-full max-w-[52rem] gap-4 rounded-[32px] border border-[var(--dls-border)] bg-[var(--dls-surface)] p-6">
      <p className="text-sm text-[var(--dls-text-secondary)]">Loading your workspace...</p>
    </section>
  );
}
