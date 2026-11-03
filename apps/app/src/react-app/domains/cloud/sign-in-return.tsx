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
  /** A message the person sent is waiting to be resent after sign-in. */
  pendingTurn?: boolean;
  /** The browser link to open; defaults to Den's sign-up/sign-in page. */
  url?: string;
  /** The entry point's behavior when its route cannot support a return. */
  fallback?: () => void;
  /** The conversation on screen when the route does not name it. */
  workspaceId?: string | null;
  sessionId?: string | null;
};

function defaultAuthUrl() {
  // Label stays "Sign in"; opens the sign-up tab so new users aren't defaulted into sign-in.
  return buildDenAuthUrl(readDenBootstrapConfig().baseUrl, "sign-up");
}

/** Starts sign-in in the browser, keeping the current task on screen. */
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

/**
 * A code pasted from the account menu completes in place and returns to this
 * route too. It completes a browser sign-in already
 * waiting rather than replacing it, and a failed paste leaves nothing behind.
 */
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

/**
 * Opens the route sign-in started from, once, with "Signed in to {org}".
 * Returns false when there is nothing to return to (the caller then uses
 * its default landing).
 */
export function completeSignInReturn(navigate: NavigateFunction): boolean {
  const target = claimSignInReturnRoute();
  if (!target) return false;
  navigate(target.path, { replace: true });
  const organization = readDenSettings().activeOrgName?.trim();
  toast.success(organization ? `Signed in to ${organization}` : "Signed in", { id: "sign-in-return" });
  return true;
}
