/** @jsxImportSource react */
import { DitheredOnboardingShell } from "@openwork/ui/react";
import { ExternalLink, KeyRound, ShieldCheck } from "lucide-react";
import { useSyncExternalStore, type ReactNode } from "react";

import { readDenBootstrapConfig } from "@/app/lib/den";
import { denSettingsChangedEvent } from "@/app/lib/den-session-events";
import { enterpriseActivationRequired } from "@/app/lib/enterprise-activation";
import {
  openDesktopUrl,
  readDesktopDistributionInfo,
} from "@/app/lib/desktop";
import { Button } from "@/components/ui/button";

function subscribeToBootstrap(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(denSettingsChangedEvent, onStoreChange);
  return () => window.removeEventListener(denSettingsChangedEvent, onStoreChange);
}

export function useEnterpriseActivationRequired() {
  const bootstrap = useSyncExternalStore(
    subscribeToBootstrap,
    readDenBootstrapConfig,
    readDenBootstrapConfig,
  );
  return enterpriseActivationRequired(readDesktopDistributionInfo(), bootstrap);
}

function EnterpriseActivationPage() {
  const bootstrap = readDenBootstrapConfig();
  const portalUrl = bootstrap.baseUrl;

  return (
    <DitheredOnboardingShell
      state="enterprise-activation"
      width="wide"
      rootTestId="enterprise-activation-root"
      backgroundTestId="enterprise-activation-background"
      foregroundTestId="enterprise-activation-foreground"
    >
      <div className="absolute inset-x-0 top-0 h-10 mac:titlebar-drag" />
      <section
        className="grid gap-7 rounded-[1.75rem] border border-[#dce5f2] bg-white/95 p-6 shadow-[0_24px_80px_rgba(50,72,110,0.10)] sm:p-10"
        data-testid="enterprise-activation-card"
      >
        <div className="grid gap-4">
          <div className="grid size-12 place-items-center rounded-2xl border border-[#d6e2f3] bg-[#edf4ff] text-[#345f9d]">
            <KeyRound className="size-5" aria-hidden="true" />
          </div>
          <div className="grid gap-2">
            <p className="m-0 text-xs font-semibold uppercase tracking-[0.14em] text-[#5b76a0]">
              OpenWork Enterprise
            </p>
            <h1 className="m-0 max-w-[18ch] text-3xl font-semibold tracking-[-0.04em] text-[#101828] sm:text-4xl">
              Activate this app from your Den portal.
            </h1>
            <p className="m-0 max-w-2xl text-[15px] leading-6 text-[#586579]">
              Return to the download page where you got OpenWork Enterprise and choose
              <strong className="font-semibold text-[#26354d]"> Activate OpenWork Enterprise</strong>.
              The portal will send a one-time link that activates this installation and signs you in.
            </p>
          </div>
        </div>

        <div className="grid gap-3 rounded-2xl border border-[#dce5f2] bg-[#f8fbff] p-4 sm:grid-cols-[auto_1fr] sm:items-center">
          <span className="grid size-9 place-items-center rounded-xl bg-white text-[#4c6f9f] shadow-sm">
            <ShieldCheck className="size-4" aria-hidden="true" />
          </span>
          <div className="grid gap-0.5">
            <p className="m-0 text-sm font-semibold text-[#26354d]">Sign-in stays required</p>
            <p className="m-0 text-xs leading-5 text-[#66758b]">
              This enterprise build has no local or “use without cloud” mode. Activation links expire and can be used once.
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <Button
            type="button"
            size="lg"
            className="h-11 rounded-xl px-5"
            onClick={() => void openDesktopUrl(portalUrl)}
            data-testid="enterprise-activation-open-den"
          >
            Open Den portal
            <ExternalLink className="ml-2 size-4" aria-hidden="true" />
          </Button>
          <p className="m-0 text-xs leading-5 text-[#66758b]" aria-live="polite">
            Waiting for an activation link from Den…
          </p>
        </div>
      </section>
    </DitheredOnboardingShell>
  );
}

export function EnterpriseActivationGate({ children }: { children: ReactNode }) {
  return useEnterpriseActivationRequired()
    ? <EnterpriseActivationPage />
    : children;
}
