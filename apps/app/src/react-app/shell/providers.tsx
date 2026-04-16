/** @jsxImportSource react */
import { type ReactNode } from "react";

import { isWebDeployment } from "../../app/lib/openwork-deployment";
import { isTauriRuntime } from "../../app/utils";
import { GlobalSDKProvider } from "../kernel/global-sdk-provider";
import { GlobalSyncProvider } from "../kernel/global-sync-provider";
import { LocalProvider } from "../kernel/local-provider";
import { ServerProvider } from "../kernel/server-provider";

function resolveDefaultServerUrl(): string {
  if (isTauriRuntime()) return "http://127.0.0.1:4096";

  const openworkUrl =
    typeof import.meta.env?.VITE_OPENWORK_URL === "string"
      ? import.meta.env.VITE_OPENWORK_URL.trim()
      : "";
  if (openworkUrl) {
    return `${openworkUrl.replace(/\/+$/, "")}/opencode`;
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

export function AppProviders({ children }: AppProvidersProps) {
  const defaultUrl = resolveDefaultServerUrl();
  return (
    <ServerProvider defaultUrl={defaultUrl}>
      <GlobalSDKProvider>
        <GlobalSyncProvider>
          <LocalProvider>{children}</LocalProvider>
        </GlobalSyncProvider>
      </GlobalSDKProvider>
    </ServerProvider>
  );
}
