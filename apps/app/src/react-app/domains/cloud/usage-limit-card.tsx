import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Clock, FileCheck, LockKeyhole } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { createDenClient, isDenOrgAdminRole, readDenSettings } from "@/app/lib/den";
import { denDashboardUrl } from "@/app/lib/den-dashboard-links";
import { denSettingsChangedEvent } from "@/app/lib/den-session-events";
import { openAlternativeModelPicker } from "@/app/lib/inference-access";
import { usePlatform } from "@/react-app/kernel/platform";
import { useDenAuth } from "./den-auth-provider";
import { getOpenWorkModelsActionUrl, useOpenWorkModelsPromoEligibility } from "./openwork-models-promo";
import { openWorkModelsLimitCopy, usageLimitActions, type OpenWorkModelsLimit, type UsageLimitAction, type UsageLimitActionId, type UsageLimitViewer } from "./usage-limit-state";

/**
 * Who is looking at the limit: signed in or not, whether they can buy for the active organization (owners and
 * admins), and whether OpenWork Models is sold here. The role is read from Den; until it is known, nobody can buy.
 */
export function useUsageLimitViewer(): UsageLimitViewer & { workspaceName: string | null; denBaseUrl: string } {
  const auth = useDenAuth();
  const modelsOffered = useOpenWorkModelsPromoEligibility();
  const [settings, setSettings] = useState(readDenSettings);
  useEffect(() => {
    const sync = () => setSettings(readDenSettings());
    window.addEventListener(denSettingsChangedEvent, sync);
    return () => window.removeEventListener(denSettingsChangedEvent, sync);
  }, []);
  const token = settings.authToken;
  const client = useMemo(() => token ? createDenClient({ baseUrl: settings.baseUrl, apiBaseUrl: settings.apiBaseUrl, token }) : null,
    [settings.baseUrl, settings.apiBaseUrl, token]);
  const identity = auth.verifiedIdentity;
  const verified = auth.isSignedIn && Boolean(client && identity) && identity?.organizationId === settings.activeOrgId;
  const role = useQuery({
    queryKey: ["usage-limit-role", settings.baseUrl, identity?.principalId, settings.activeOrgId, settings.apiBaseUrl],
    enabled: verified,
    staleTime: 60_000,
    queryFn: async () => {
      if (!client) return null;
      const result = await client.listOrgs();
      return result.orgs.find((org) => org.id === identity?.organizationId)?.role ?? null;
    },
  });
  return {
    signedIn: auth.isSignedIn,
    canBuy: verified && !role.isError && isDenOrgAdminRole(role.data),
    modelsOffered,
    planUpgrade: false,
    workspaceName: auth.isSignedIn ? settings.activeOrgName?.trim() || null : null,
    denBaseUrl: settings.baseUrl,
  };
}

/**
 * One card for every usage limit (Desktop and Web share the anatomy): what ran out, when it resets, that the
 * message is saved, then one primary action for the person's role and a way to keep working. Blocked, not failed:
 * neutral ink, no red (DESIGN C5).
 */
export function UsageLimitCard({ testId, kind, title, reset, saved = true, actions, children }: {
  testId: string;
  kind: string;
  title: ReactNode;
  reset: ReactNode | null;
  /** A message was refused and kept. False when the limit is shown before anything was sent. */
  saved?: boolean;
  actions: ReactNode;
  /** Extra state between the facts and the actions, such as a meter or a request form. */
  children?: ReactNode;
}) {
  return (
    <section role="status" data-testid={testId} data-kind={kind} className="not-prose mx-auto mb-2 flex w-full max-w-3xl flex-col gap-2.5 rounded-[14px] border border-border bg-background px-4 py-3">
      <div className="flex min-w-0 flex-col gap-1">
        <h2 className="text-[13px] font-medium leading-5 text-foreground">{title}</h2>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs leading-4 text-muted-foreground">
          {reset ? <span className="inline-flex items-center gap-1"><Clock aria-hidden="true" className="size-3.5" />{reset}</span> : null}
          {saved ? <span className="inline-flex items-center gap-1"><FileCheck aria-hidden="true" className="size-3.5" />Your message is saved</span> : null}
        </p>
      </div>
      {children}
      <div className="flex flex-wrap items-center gap-1.5">{actions}</div>
    </section>
  );
}

/** A role-gated action stays visible with a lock and says who can do it (DESIGN P4). */
export function UsageLimitLocked({ label, reason }: { label: string; reason: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={
        <Button size="sm" variant="outline" disabled focusableWhenDisabled data-testid="usage-limit-locked" className="text-muted-foreground">
          <LockKeyhole aria-hidden="true" className="size-3.5" />{label}<span className="sr-only">. {reason}</span>
        </Button>
      } />
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}

export function UsageLimitActions({ actions, onAction }: { actions: UsageLimitAction[]; onAction: (id: UsageLimitActionId) => void }) {
  return <>{actions.map((action) => action.lockedReason
    ? <UsageLimitLocked key={action.id} label={action.label} reason={action.lockedReason} />
    : <Button key={action.id} size="sm" data-action={action.id}
      variant={action.emphasis === "primary" ? "default" : action.emphasis === "secondary" ? "outline" : "ghost"}
      onClick={() => onAction(action.id)}>{action.label}</Button>)}</>;
}

/** Opens the destinations every usage-limit card shares; sign-in belongs to the caller (it keeps the draft). */
export function useUsageLimitNavigation(sessionId: string, viewer: { signedIn: boolean; denBaseUrl: string }) {
  const platform = usePlatform();
  return (id: UsageLimitActionId, signIn?: () => void) => {
    if (id === "sign_in") signIn?.();
    else if (id === "get_models") platform.openLink(getOpenWorkModelsActionUrl(viewer.signedIn));
    else if (id === "add_team_provider") platform.openLink(denDashboardUrl(viewer.denBaseUrl, "gatewayProviders"));
    else if (id === "upgrade_plan") platform.openLink(denDashboardUrl(viewer.denBaseUrl, "billing"));
    else if (id === "use_another_model") openAlternativeModelPicker(sessionId);
  };
}

/** The organization used its OpenWork Models allowance. Classified, never retried, never "too many requests". */
export function OpenWorkModelsLimitCard({ limit, sessionId }: { limit: OpenWorkModelsLimit; sessionId: string }) {
  const viewer = useUsageLimitViewer();
  const navigate = useUsageLimitNavigation(sessionId, viewer);
  const copy = openWorkModelsLimitCopy(limit, viewer.workspaceName);
  return (
    <UsageLimitCard testId="usage-limit-card" kind="models_allowance" title={copy.title}
      reset={copy.reset ? <time dateTime={limit.resetAt ?? undefined} title={limit.resetAt ? new Date(limit.resetAt).toLocaleString() : undefined}>{copy.reset}</time> : null}
      actions={<UsageLimitActions actions={usageLimitActions("models_allowance", viewer)} onAction={(id) => navigate(id)} />} />
  );
}
