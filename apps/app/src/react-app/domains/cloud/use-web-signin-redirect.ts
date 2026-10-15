import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { buildDenAuthUrl, createDenClient, readDenSettings } from "../../../app/lib/den";
import { isDesktopRuntime } from "../../../app/utils";
import { isWebDeployment } from "../../../app/lib/openwork-deployment";
import { readOpenworkGatewayDenBaseUrl } from "../../../app/lib/gateway-runtime";
import { beginWebSigninRedirect, webSigninTarget } from "./web-signin-redirect";

export function useWebSigninRedirectEnabled(signedOut: boolean) {
  const baseUrl = readOpenworkGatewayDenBaseUrl();
  const eligible = Boolean(baseUrl) && isWebDeployment() && !isDesktopRuntime()
    && import.meta.env?.VITE_OPENWORK_FORCE_MANUAL_AUTH !== "1";
  const client = useMemo(() => createDenClient({ baseUrl: baseUrl ?? readDenSettings().baseUrl }), [baseUrl]);
  const feature = useQuery({
    queryKey: ["den", "deployment-features", baseUrl],
    queryFn: () => client.getDeploymentFeatures(),
    enabled: eligible && signedOut,
    retry: false,
    staleTime: 0,
    select: (features) => features.webSigninRedirect === true,
  });
  return eligible && feature.data === true && !feature.isError && !feature.isFetching;
}

/** Mounted above routing so a gateway deep link survives the /signin gate. */
export function useWebSigninRedirect(signedOut: boolean, requireSignin: boolean) {
  const enabled = useWebSigninRedirectEnabled(signedOut && requireSignin);
  const entry = useRef(window.location.href);
  const callback = useRef(new URL(entry.current).searchParams.has("grant") || new URL(entry.current).searchParams.has("error"));
  const captured = useRef(false);
  // Capture before the sign-in page's effects consume a grant and before the
  // gate replaces a bookmarked route with /signin. Refresh for a later logout.
  useLayoutEffect(() => {
    if (!signedOut) {
      captured.current = false;
      return;
    }
    if (captured.current) return;
    captured.current = true;
    entry.current = window.location.href;
    const params = new URL(entry.current).searchParams;
    callback.current = params.has("grant") || params.has("error");
  }, [signedOut]);
  useEffect(() => {
    if (!enabled || !signedOut || !requireSignin || callback.current) return;
    const current = new URL(window.location.href);
    if (current.searchParams.has("grant") || current.searchParams.has("error")) return;
    const baseUrl = readOpenworkGatewayDenBaseUrl();
    if (!baseUrl) return;
    const target = webSigninTarget(buildDenAuthUrl(baseUrl, "sign-in"), current.href);
    if (!target) return;
    const original = new URL(entry.current);
    try {
      if (!beginWebSigninRedirect(window.sessionStorage, target, `${original.pathname}${original.search}${original.hash}`, current.origin)) return;
      window.location.replace(target);
    } catch {
      // Navigation/storage restrictions leave the existing manual gate usable.
    }
  }, [enabled, signedOut, requireSignin]);
}
