"use client";

import { useDenFlow } from "../_providers/den-flow-provider";
import { AuthPanel } from "./auth-panel";
import { CloudBrowserView } from "./cloud-browser-view";

/** The full live view that hand-off links from Slack and Automations open. */
export function CloudBrowserScreen({ site, assistantName }: { site: string | null; assistantName: string }) {
  const { user, sessionHydrated } = useDenFlow();

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-8 sm:px-6">
      <h1 className="text-[20px] font-semibold tracking-[-0.01em] text-[var(--dls-text-primary)]">
        {site ? `Sign in to ${site}` : "Your cloud browser"}
      </h1>
      {!sessionHydrated ? (
        <div className="aspect-[16/9] w-full rounded-[var(--dls-radius,16px)] border border-[var(--dls-border)] bg-[var(--dls-hover)]" aria-hidden />
      ) : !user ? (
        <div className="w-full max-w-md">
          <AuthPanel bare emailFirstFlow socialFirst socialProviders={["google"]} emailStepContent={{ title: "Sign in to OpenWork" }} />
        </div>
      ) : (
        <CloudBrowserView variant="page" assistantName={assistantName} siteLabel={site ?? undefined} />
      )}
    </div>
  );
}
