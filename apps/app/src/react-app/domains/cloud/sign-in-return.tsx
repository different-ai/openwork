/** @jsxImportSource react */
import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { NavigateFunction } from "react-router";

import { buildDenAuthUrl, readDenBootstrapConfig, readDenSettings } from "@/app/lib/den";
import { markDesktopSignInInitiated } from "@/app/lib/den-sign-in-intent";
import {
  beginSignInReturn,
  claimSignInReturnRoute,
  clearSignInReturnTarget,
  currentAppRoutePath,
  parseSignInReturnTarget,
  readSignInReturnRaw,
  readSignInReturnTarget,
  recordSignInReturnTarget,
  subscribeSignInReturn,
  type BeginSignInResult,
  type SignInReturnTarget,
} from "@/app/lib/den-sign-in-return";
import { toast } from "@/components/ui/sonner";
import { usePlatform } from "@/react-app/kernel/platform";

export type CloudSignInRequest = {
  pendingTurn?: boolean;
  url?: string;
  fallback?: () => void;
  workspaceId?: string | null;
  sessionId?: string | null;
};

function defaultAuthUrl() {
  return buildDenAuthUrl(readDenBootstrapConfig().baseUrl, "sign-up");
}

export function useCloudSignIn() {
  const platform = usePlatform();
  return useCallback((request: CloudSignInRequest = {}): BeginSignInResult => {
    const url = request.url ?? defaultAuthUrl();
    return beginSignInReturn(
      { path: currentAppRoutePath(), workspaceId: request.workspaceId, sessionId: request.sessionId, pendingTurn: request.pendingTurn, authUrl: url },
      {
        openLink: (link) => platform.openLink(link),
        markDesktopSignInInitiated: () => markDesktopSignInInitiated(),
        fallback: request.fallback ?? (() => {
          markDesktopSignInInitiated();
          platform.openLink(url);
        }),
      },
    );
  }, [platform]);
}

export function useRecordSignInReturnForPaste() {
  return useCallback((): (() => void) | undefined => {
    const waiting = readSignInReturnTarget();
    if (waiting && waiting.signedInAt === null) return undefined;
    const recorded = recordSignInReturnTarget({ path: currentAppRoutePath() });
    if (!recorded) return undefined;
    return () => {
      const current = readSignInReturnTarget();
      if (current?.startedAt === recorded.startedAt && current.signedInAt === null) clearSignInReturnTarget();
    };
  }, []);
}

export function useSignInReturnTarget(): SignInReturnTarget | null {
  const raw = useSyncExternalStore(subscribeSignInReturn, () => readSignInReturnRaw(), () => null);
  return useMemo(() => parseSignInReturnTarget(raw, Date.now()), [raw]);
}

export function completeSignInReturn(navigate: NavigateFunction): boolean {
  const target = claimSignInReturnRoute();
  if (!target) return false;
  navigate(target.path, { replace: true });
  const organization = readDenSettings().activeOrgName?.trim();
  toast.success(organization ? `Signed in to ${organization}` : "Signed in", { id: "sign-in-return" });
  return true;
}
