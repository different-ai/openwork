// "OpenWork Models" startup promo: one-shot dialog latch shown shortly after
// a workspace is ready when the user has no OpenWork Models provider yet.
// Extracted verbatim from session-route.tsx.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider";
import { usePlatform } from "@/react-app/kernel/platform";
import { useShellConfig } from "@/react-app/shell/shell-config";
import { workspaceSettingsRoute } from "@/react-app/shell/workspace-routes";
import {
  getOpenWorkModelsActionUrl,
  hasOpenWorkModelsProvider,
  hideOpenWorkModelsPromo,
  isOpenWorkModelsPromoHidden,
  markOpenWorkModelsStartupPromoShown,
  openWorkModelsPromoChangedEvent,
  wasOpenWorkModelsStartupPromoShown,
} from "./openwork-models-promo";

export type UseOpenWorkModelsStartupPromoInput = {
  /** True once the workspace's opencode client exists. */
  clientReady: boolean;
  workspaceId: string;
  providerConnectedIds: string[];
};

export function useOpenWorkModelsStartupPromo(input: UseOpenWorkModelsStartupPromoInput) {
  const { clientReady, workspaceId, providerConnectedIds } = input;
  const navigate = useNavigate();
  const platform = usePlatform();
  const denAuth = useDenAuth();
  const { config: shellConfig } = useShellConfig();

  const [open, setOpen] = useState(false);
  const [promoHidden, setPromoHidden] = useState(isOpenWorkModelsPromoHidden);
  const scheduledRef = useRef(false);

  useEffect(() => {
    const handlePromoChanged = () => setPromoHidden(isOpenWorkModelsPromoHidden());
    window.addEventListener(openWorkModelsPromoChangedEvent, handlePromoChanged);
    return () => window.removeEventListener(openWorkModelsPromoChangedEvent, handlePromoChanged);
  }, []);

  const hasOpenWorkModels = useMemo(
    () => hasOpenWorkModelsProvider(providerConnectedIds),
    [providerConnectedIds],
  );

  useEffect(() => {
    if (!shellConfig.cloudSignin || promoHidden || hasOpenWorkModels) return;
    if (denAuth.status === "checking" || !clientReady || !workspaceId) return;
    if (wasOpenWorkModelsStartupPromoShown() || scheduledRef.current) return;

    scheduledRef.current = true;
    const timeout = window.setTimeout(() => {
      markOpenWorkModelsStartupPromoShown();
      setOpen(true);
    }, 900);
    return () => window.clearTimeout(timeout);
  }, [clientReady, denAuth.status, hasOpenWorkModels, promoHidden, shellConfig.cloudSignin, workspaceId]);

  const subscribe = useCallback(() => {
    setOpen(false);
    markOpenWorkModelsStartupPromoShown();
    if (!denAuth.isSignedIn) {
      navigate(workspaceId ? workspaceSettingsRoute(workspaceId, "cloud-account") : "/settings/cloud-account");
    }
    window.setTimeout(() => {
      platform.openLink(getOpenWorkModelsActionUrl(denAuth.isSignedIn));
    }, 0);
  }, [denAuth.isSignedIn, navigate, platform, workspaceId]);

  const continueWithout = useCallback(() => {
    setOpen(false);
    markOpenWorkModelsStartupPromoShown();
    hideOpenWorkModelsPromo();
    setPromoHidden(true);
  }, []);

  return { open, subscribe, continueWithout };
}
