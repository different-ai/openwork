/** @jsxImportSource react */
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { AlertTriangle, ArrowUpRight } from "lucide-react";

import {
  clearDenSession,
  createDenClient,
  readDenSettings,
} from "@/app/lib/den";
import { denSettingsChangedEvent } from "@/app/lib/den-session-events";
import { isOpenworkGatewayRuntime } from "@/app/lib/gateway-runtime";
import { Button } from "@/components/ui/button";
import { usePlatform } from "@/react-app/kernel/platform";
import { OwDotTicker } from "@/react-app/shell/dot-ticker";
import { useDenAuth } from "./den-auth-provider";
import {
  resolveOpenWorkWebAccessGateState,
  type OpenWorkWebAccessCheck,
  type OpenWorkWebAccessGateState,
} from "./openwork-web-access-state";

export {
  resolveOpenWorkWebAccessGateState,
  type OpenWorkWebAccessCheck,
  type OpenWorkWebAccessGateState,
} from "./openwork-web-access-state";

function readDenSettingsSnapshot() {
  const settings = readDenSettings();
  return JSON.stringify({
    baseUrl: settings.baseUrl,
    authToken: settings.authToken ?? "",
    activeOrgId: settings.activeOrgId ?? "",
    activeOrgName: settings.activeOrgName ?? "",
  });
}

function subscribeToDenSettings(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(denSettingsChangedEvent, onStoreChange);
  return () => window.removeEventListener(denSettingsChangedEvent, onStoreChange);
}

export function denWebBillingUrl(baseUrl: string) {
  try {
    return new URL("/dashboard/web", baseUrl).toString();
  } catch {
    return baseUrl;
  }
}

export function OpenWorkWebAccessGateScreen(props: {
  state: Exclude<OpenWorkWebAccessGateState, "inactive" | "granted">;
  organizationName: string;
  onManageAccess: () => void;
  onRetry: () => void;
  onSignOut: () => void;
}) {
  const checking = props.state === "checking";
  const denied = props.state === "denied";
  const organizationName = props.organizationName || "this organization";

  return (
    <main
      className="flex min-h-dvh items-center justify-center bg-background px-6 py-16 text-foreground"
      data-testid="openwork-web-access-gate"
      data-state={props.state}
    >
      <section className="w-full max-w-lg rounded-[24px] border border-border bg-background p-7 shadow-[var(--dls-card-shadow)] sm:p-9">
        <div className="flex items-start gap-4">
          <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl border border-border bg-muted/40">
            {checking
              ? <OwDotTicker size="lg" />
              : <AlertTriangle className="size-5 text-amber-11" aria-hidden="true" />}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              OpenWork Web
            </p>
            <h1 className="mt-2 text-[26px] font-semibold leading-tight tracking-[-0.03em]">
              {checking
                ? "Checking workspace access…"
                : denied
                  ? "OpenWork Web access is required"
                  : "OpenWork Web remains locked"}
            </h1>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              {checking
                ? `Waiting for Den to confirm access for ${organizationName}.`
                : denied
                  ? `${organizationName} does not have an active OpenWork Web subscription or complimentary admin grant.`
                  : `Den could not confirm OpenWork Web access for ${organizationName}. The workspace stays locked until it can.`}
            </p>
          </div>
        </div>

        {!checking ? (
          <div className="mt-7 flex flex-wrap items-center gap-2">
            {denied ? (
              <Button type="button" onClick={props.onManageAccess}>
                Manage access in Den
                <ArrowUpRight className="size-4" aria-hidden="true" />
              </Button>
            ) : (
              <Button type="button" onClick={props.onRetry}>Retry</Button>
            )}
            {denied ? (
              <Button type="button" variant="outline" onClick={props.onRetry}>Check again</Button>
            ) : null}
            <Button type="button" variant="ghost" onClick={props.onSignOut}>Sign out</Button>
          </div>
        ) : null}
      </section>
    </main>
  );
}

export function OpenWorkWebAccessGate({ children }: { children: ReactNode }) {
  const denAuth = useDenAuth();
  const platform = usePlatform();
  const gatewayMode = isOpenworkGatewayRuntime();
  const settingsSnapshot = useSyncExternalStore(
    subscribeToDenSettings,
    readDenSettingsSnapshot,
    readDenSettingsSnapshot,
  );
  const settings = useMemo(() => readDenSettings(), [settingsSnapshot]);
  const authToken = settings.authToken?.trim() ?? "";
  const organizationId = settings.activeOrgId?.trim() ?? "";
  const principalId = denAuth.verifiedIdentity?.principalId.trim() ?? "";
  const verifiedOrganizationId = denAuth.verifiedIdentity?.organizationId.trim() ?? "";
  const expectedScope =
    gatewayMode
    && authToken
    && organizationId
    && principalId
    && verifiedOrganizationId === organizationId
      ? `${principalId}\u0000${organizationId}\u0000${authToken}`
      : null;
  const [check, setCheck] = useState<OpenWorkWebAccessCheck | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!gatewayMode || typeof window === "undefined") return;
    const checkAgain = () => setRetry((value) => value + 1);
    window.addEventListener("focus", checkAgain);
    return () => window.removeEventListener("focus", checkAgain);
  }, [gatewayMode]);

  useEffect(() => {
    if (!expectedScope || denAuth.status !== "signed_in") return;

    let cancelled = false;
    const client = createDenClient({ baseUrl: settings.baseUrl, token: authToken });
    void client.getOpenWorkWebAccess(organizationId).then(
      (access) => {
        if (cancelled) return;
        setCheck({
          scope: expectedScope,
          state: access.hasAccess ? "granted" : "denied",
          accessSource: access.accessSource,
        });
      },
      () => {
        if (cancelled) return;
        setCheck({ scope: expectedScope, state: "error", accessSource: null });
      },
    );

    return () => {
      cancelled = true;
    };
  }, [authToken, denAuth.status, expectedScope, organizationId, retry, settings.baseUrl]);

  const state = resolveOpenWorkWebAccessGateState({
    gatewayMode,
    authStatus: denAuth.status,
    authToken,
    organizationId,
    verifiedIdentity: denAuth.verifiedIdentity,
    expectedScope,
    check,
  });

  if (state === "inactive" || state === "granted") return children;

  const signOut = () => {
    if (authToken) {
      void createDenClient({ baseUrl: settings.baseUrl, token: authToken }).signOut().catch(() => undefined);
    }
    clearDenSession();
    void denAuth.refresh();
  };

  return (
    <OpenWorkWebAccessGateScreen
      state={state}
      organizationName={settings.activeOrgName?.trim() ?? ""}
      onManageAccess={() => platform.openLink(denWebBillingUrl(settings.baseUrl))}
      onRetry={() => setRetry((value) => value + 1)}
      onSignOut={signOut}
    />
  );
}
