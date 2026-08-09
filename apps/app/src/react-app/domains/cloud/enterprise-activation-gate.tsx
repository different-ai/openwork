/** @jsxImportSource react */
import { Dithering } from "@paper-design/shaders-react";
import { useSyncExternalStore, type ReactNode } from "react";

import { readDenBootstrapConfig } from "@/app/lib/den";
import { denSettingsChangedEvent } from "@/app/lib/den-session-events";
import { enterpriseActivationRequired } from "@/app/lib/enterprise-activation";
import { readDesktopDistributionInfo } from "@/app/lib/desktop";
import { resolveExtensionIconSrc } from "@/react-app/design-system/extension-icon-src";

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
  return (
    <div
      className="relative min-h-dvh bg-background text-foreground"
      data-state="enterprise-activation"
      data-testid="enterprise-activation-root"
    >
      <div
        className="pointer-events-none absolute inset-0 z-0 overflow-hidden opacity-[0.1] dark:invert"
        data-testid="enterprise-activation-background"
      >
        <Dithering
          className="size-full"
          speed={0.01}
          shape="warp"
          type="2x2"
          size={20.3}
          scale={1.19}
          frame={264559.21}
          colorBack="#00000000"
          colorFront="#000000"
        />
      </div>

      <div className="absolute inset-x-0 top-0 z-20 h-10 mac:titlebar-drag" />

      <div
        className="relative z-10 flex min-h-dvh items-center justify-center px-6 py-16"
        data-testid="enterprise-activation-foreground"
      >
        <section
          className="w-full max-w-[720px] rounded-3xl border border-border bg-background px-8 pb-12 pt-10 sm:px-16 sm:pb-16 sm:pt-14"
          data-testid="enterprise-activation-card"
        >
          <div className="flex items-center gap-2.5">
            <img
              src={resolveExtensionIconSrc("/openwork-mark.svg")}
              alt=""
              width={26}
              height={26}
              className="max-h-[26px] shrink-0 object-contain object-left dark:invert"
              aria-hidden="true"
            />
            <span className="text-[15px] font-semibold tracking-tight text-foreground">
              OpenWork Enterprise
            </span>
          </div>

          <div className="mt-10 flex flex-col gap-2.5 sm:mt-14">
            <h1 className="text-[30px] font-semibold leading-[38px] tracking-[-0.03em] text-foreground sm:text-[38px] sm:leading-[46px]">
              Activate OpenWork Enterprise
            </h1>
            <p className="text-[15px] leading-[23px] text-muted-foreground">
              OpenWork Enterprise access is managed by your organization. Return to your organization&apos;s
              OpenWork Enterprise download page and select <strong className="font-semibold text-foreground">Activate OpenWork Enterprise</strong>.
              This app will unlock when it receives the one-time activation link.
            </p>
          </div>

          <div className="mt-11 flex flex-col gap-3">
            <div
              className="rounded-xl border border-dls-border bg-dls-hover px-4 py-3 text-sm font-medium text-dls-text"
              aria-live="polite"
            >
              Waiting for your organization&apos;s activation link…
            </div>

            <p className="text-xs leading-5 text-muted-foreground">
              Access remains managed by your organization. Activation links expire and can be used once.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}

export function EnterpriseActivationGate({ children }: { children: ReactNode }) {
  return useEnterpriseActivationRequired()
    ? <EnterpriseActivationPage />
    : children;
}
