/** @jsxImportSource react */
import { useEffect, type ReactNode } from "react";

import { Toaster } from "@/components/ui/sonner";

import { isWebDeployment } from "@/app/lib/micx-deployment";
import { hydrateMicxServerSettingsFromEnv } from "@/app/lib/micx-server";
import { isDesktopRuntime } from "@/app/utils";
import { ConnectLinkProvider } from "@/react-app/domains/cloud/connect-link-provider";
import { DenAuthProvider } from "@/react-app/domains/cloud/den-auth-provider";
import { AutomationRunnerBridge } from "@/react-app/domains/automations/automation-runner-bridge";
import { BrandThemeProvider } from "@/react-app/domains/cloud/brand-theme";
import { DesktopConfigProvider } from "@/react-app/domains/cloud/desktop-config-provider";
import { RestrictionNoticeProvider } from "@/react-app/domains/cloud/restriction-notice-provider";
import { LocalProvider, useLocal } from "@/react-app/kernel/local-provider";
import { ServerProvider } from "@/react-app/kernel/server-provider";
import { ArchitectureMismatchGate } from "./architecture-mismatch-gate";
import { BootStateProvider } from "./boot-state";
import { DesktopRuntimeBoot } from "./desktop-runtime-boot";
import { useEnterpriseActivationRequired } from "@/react-app/domains/cloud/enterprise-activation-gate";
import { startDebugLogger, stopDebugLogger } from "./debug-logger";
import { resolveMicxConnection } from "./micx-connection";
import { ReloadCoordinatorProvider } from "./reload-coordinator";

function resolveDefaultServerUrl(): string {
  if (isDesktopRuntime()) return "http://127.0.0.1:4096";

  const micxUrl =
    typeof import.meta.env?.VITE_MICX_URL === "string"
      ? import.meta.env.VITE_MICX_URL.trim()
      : "";
  if (micxUrl) {
    return `${micxUrl.replace(/\/+$/, "")}/opencode`;
  }

  if (isWebDeployment() && import.meta.env.PROD && typeof window !== "undefined") {
    return `${window.location.origin}/opencode`;
  }

  const envUrl =
    typeof import.meta.env?.VITE_OPENCODE_URL === "string"
      ? import.meta.env.VITE_OPENCODE_URL.trim()
      : "";
  return envUrl || "http://127.0.0.1:4096";
}

type AppProvidersProps = {
  children: ReactNode;
};

function AutomationRunnerBridgeGate() {
  const { prefs } = useLocal();
  return <AutomationRunnerBridge enabled={prefs.featureFlags?.automations === true} />;
}

function EnterpriseAwareAppProviders({ children }: AppProvidersProps) {
  const activationRequired = useEnterpriseActivationRequired();
  if (activationRequired) {
    return <ConnectLinkProvider>{children}</ConnectLinkProvider>;
  }
  return (
    <>
      <DesktopRuntimeBoot />
      <ConnectLinkProvider>
        <DesktopConfigProvider>
          <BrandThemeProvider>
            <RestrictionNoticeProvider>
              <LocalProvider>
                <AutomationRunnerBridgeGate />
                <ReloadCoordinatorProvider>{children}</ReloadCoordinatorProvider>
                <Toaster />
              </LocalProvider>
            </RestrictionNoticeProvider>
          </BrandThemeProvider>
        </DesktopConfigProvider>
      </ConnectLinkProvider>
    </>
  );
}

export function AppProviders({ children }: AppProvidersProps) {
  hydrateMicxServerSettingsFromEnv();

  useEffect(() => {
    // Start the dev observability forwarder. Reads the current micx-server
    // URL on every flush so reconnects after port changes still work. In prod
    // builds `startDebugLogger` is a no-op.
    startDebugLogger({
      serverUrl: async () => (await resolveMicxConnection()).normalizedBaseUrl,
    });
    return () => {
      stopDebugLogger();
    };
  }, []);

  const defaultUrl = resolveDefaultServerUrl();
  return (
    <BootStateProvider>
      <ServerProvider defaultUrl={defaultUrl}>
        <ArchitectureMismatchGate>
          <DenAuthProvider>
            <EnterpriseAwareAppProviders>{children}</EnterpriseAwareAppProviders>
          </DenAuthProvider>
        </ArchitectureMismatchGate>
      </ServerProvider>
    </BootStateProvider>
  );
}
