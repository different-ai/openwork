import { useEffect, useState } from "react";
import { createOpenworkServerClient, isLoopbackOpenworkServerUrl, readOpenworkServerSettings } from "@/app/lib/openwork-server";
import { isDesktopRuntime } from "@/app/utils";
import { useLocal } from "@/react-app/kernel/local-provider";

const RETRY_DELAYS_MS = [1_000, 5_000, 15_000];

function localServer() {
  const settings = readOpenworkServerSettings();
  const baseUrl = settings.urlOverride?.trim() ?? "";
  const hostToken = settings.hostToken?.trim() ?? "";
  return baseUrl && hostToken && isLoopbackOpenworkServerUrl(baseUrl) ? { baseUrl, hostToken } : null;
}

/**
 * Tells this device's OpenWork server whether analytics is on (Settings → Preferences). The server sends free Auto's
 * analytics journey identifier only after hearing "on", so an opted-out person is never correlated, including before
 * this first report. Reported again whenever the setting changes or the local server restarts on a new address.
 */
export function FreeAutoAnalyticsBridge() {
  const { prefs } = useLocal();
  const enabled = prefs.analyticsEnabled;
  const [server, setServer] = useState(localServer);

  useEffect(() => {
    const refresh = () => setServer((current) => {
      const next = localServer();
      return next?.baseUrl === current?.baseUrl && next?.hostToken === current?.hostToken ? current : next;
    });
    window.addEventListener("openwork-server-settings-changed", refresh);
    return () => window.removeEventListener("openwork-server-settings-changed", refresh);
  }, []);

  useEffect(() => {
    if (!isDesktopRuntime() || !server) return;
    const client = createOpenworkServerClient(server);
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const report = (attempt: number) => {
      void client.setDesktopFreeAnalytics(enabled).catch(() => {
        const delay = RETRY_DELAYS_MS[attempt];
        if (!cancelled && delay !== undefined) timer = setTimeout(() => report(attempt + 1), delay);
      });
    };
    report(0);
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [enabled, server]);

  return null;
}
